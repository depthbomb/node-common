import * as fs from 'node:fs';
import { CancellationToken, OperationCancelledError } from './cancellation.js';
import { Path } from './pathlib.js';
import type { PathLike } from './pathlib.js';

export type PathChangeType = 'create' | 'modify' | 'delete' | 'unknown';

export type PathChange = {
	type: PathChangeType;
	path: Path;
	rawType: 'change' | 'rename';
	timestamp: Date;
};

export type WatchPathOptions = {
	recursive?: boolean;
	persistent?: boolean;
	debounceMs?: number;
	maxQueue?: number;
	overflow?: 'throw' | 'drop-oldest';
	token?: CancellationToken;
	signal?: AbortSignal;
};

type QueueWaiter<T> = {
	resolve(result: IteratorResult<T>): void;
	reject(error: unknown): void;
};

export class WatchQueueOverflowError extends Error {
	public readonly maxQueue: number;

	constructor(maxQueue: number) {
		super(`Filesystem watch queue exceeded ${maxQueue} events`);
		this.name = 'WatchQueueOverflowError';
		this.maxQueue = maxQueue;
	}
}

class AsyncEventQueue<T> implements AsyncIterableIterator<T> {
	private readonly values: T[] = [];
	private readonly waiters: QueueWaiter<T>[] = [];
	private ended = false;
	private error?: unknown;

	public constructor(
		private readonly maxQueue: number,
		private readonly overflow: 'throw' | 'drop-oldest'
	) {}

	public [Symbol.asyncIterator](): AsyncIterableIterator<T> {
		return this;
	}

	public next(): Promise<IteratorResult<T>> {
		if (this.values.length > 0) {
			return Promise.resolve({ value: this.values.shift()!, done: false });
		}

		if (this.error !== undefined) {
			return Promise.reject(this.error);
		}

		if (this.ended) {
			return Promise.resolve({ value: undefined, done: true });
		}

		return new Promise<IteratorResult<T>>((resolve, reject) => {
			this.waiters.push({ resolve, reject });
		});
	}

	public push(value: T): void {
		if (this.ended || this.error !== undefined) {
			return;
		}

		const waiter = this.waiters.shift();
		if (waiter) {
			waiter.resolve({ value, done: false });

			return;
		}

		if (this.values.length >= this.maxQueue) {
			if (this.overflow === 'throw') {
				this.fail(new WatchQueueOverflowError(this.maxQueue));

				return;
			}

			this.values.shift();
		}

		this.values.push(value);
	}

	public end(): void {
		if (this.ended) {
			return;
		}

		this.ended = true;
		for (const waiter of this.waiters.splice(0)) {
			waiter.resolve({ value: undefined, done: true });
		}
	}

	public fail(error: unknown): void {
		if (this.ended || this.error !== undefined) {
			return;
		}

		this.error = error;
		this.values.length = 0;
		for (const waiter of this.waiters.splice(0)) {
			waiter.reject(error);
		}
	}
}

function validateOptions(options: WatchPathOptions): void {
	if (options.debounceMs !== undefined && (!Number.isFinite(options.debounceMs) || options.debounceMs < 0)) {
		throw new RangeError('debounceMs must be a finite non-negative number');
	}

	if (options.maxQueue !== undefined && (!Number.isSafeInteger(options.maxQueue) || options.maxQueue < 1)) {
		throw new RangeError('maxQueue must be a positive safe integer');
	}
}

function createAbortBridge(options: WatchPathOptions): {
	signal: AbortSignal;
	cleanup(): void;
} {
	const controller = new AbortController();
	if (options.token?.isCancellationRequested) {
		controller.abort(options.token.cancellationReason);
	}

	const registration = options.token?.register((token) => controller.abort(token.cancellationReason));
	const onAbort = () => controller.abort(options.signal?.reason);

	if (options.signal?.aborted) {
		onAbort();
	} else {
		options.signal?.addEventListener('abort', onAbort, { once: true });
	}

	return {
		signal: controller.signal,
		cleanup(): void {
			registration?.unregister();
			options.signal?.removeEventListener('abort', onAbort);
		},
	};
}

function normalizeChange(basePath: Path, rawType: 'change' | 'rename', filename: string | null): PathChange {
	const changedPath = filename === null ? basePath : basePath.joinpath(filename);
	let type: PathChangeType = 'modify';

	if (filename === null) {
		type = 'unknown';
	} else if (rawType === 'rename') {
		type = changedPath.lexistsSync() ? 'create' : 'delete';
	}

	return {
		type,
		path: changedPath,
		rawType,
		timestamp: new Date(),
	};
}

export async function* watchPath(
	pathValue: PathLike,
	options: WatchPathOptions = {}
): AsyncIterableIterator<PathChange> {
	validateOptions(options);

	const basePath = Path.from(pathValue);
	const maxQueue = options.maxQueue ?? 2_048;
	const overflow = options.overflow ?? 'throw';
	const queue = new AsyncEventQueue<PathChange>(maxQueue, overflow);
	const bridge = createAbortBridge(options);
	const pending = new Map<string, PathChange>();
	const debounceMs = options.debounceMs ?? 0;
	let debounceTimer: NodeJS.Timeout | undefined;

	const flush = () => {
		if (debounceTimer) {
			clearTimeout(debounceTimer);
			debounceTimer = undefined;
		}

		for (const change of pending.values()) {
			queue.push(change);
		}

		pending.clear();
	};

	const enqueue = (change: PathChange) => {
		if (debounceMs === 0) {
			queue.push(change);

			return;
		}

		const key = change.path.toString();
		if (!pending.has(key) && pending.size >= maxQueue) {
			if (overflow === 'throw') {
				queue.fail(new WatchQueueOverflowError(maxQueue));

				return;
			}

			const oldestKey = pending.keys().next().value;
			if (oldestKey !== undefined) {
				pending.delete(oldestKey);
			}
		}

		pending.set(key, change);
		if (!debounceTimer) {
			debounceTimer = setTimeout(flush, debounceMs);
			debounceTimer.unref();
		}
	};

	let watcher: fs.FSWatcher;
	try {
		watcher = fs.watch(basePath.toString(), {
			persistent: options.persistent ?? true,
			recursive: options.recursive ?? false,
			signal: bridge.signal,
		}, (rawType, filename) => enqueue(normalizeChange(basePath, rawType, filename)));
	} catch (error) {
		bridge.cleanup();
		throw error;
	}

	watcher.on('error', (error) => queue.fail(error));
	watcher.on('close', () => {
		if (bridge.signal.aborted) {
			pending.clear();
		} else {
			flush();
		}

		queue.end();
	});

	try {
		for await (const change of queue) {
			yield change;
		}

		if (options.token?.isCancellationRequested) {
			throw new OperationCancelledError(options.token.cancellationReason, options.token);
		}

		if (options.signal?.aborted) {
			throw new OperationCancelledError(String(options.signal.reason ?? 'AbortSignal was aborted'));
		}
	} catch (error) {
		if (options.token?.isCancellationRequested) {
			throw new OperationCancelledError(options.token.cancellationReason, options.token);
		}

		if (options.signal?.aborted) {
			throw new OperationCancelledError(String(options.signal.reason ?? 'AbortSignal was aborted'));
		}

		throw error;
	} finally {
		if (debounceTimer) {
			clearTimeout(debounceTimer);
		}

		watcher.close();
		bridge.cleanup();
	}
}
