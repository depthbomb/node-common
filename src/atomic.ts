import * as fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { CancellationToken, CancellationTokenUtils, OperationCancelledError } from './cancellation.js';
import { Lockfile } from './lockfile.js';
import { Path } from './pathlib.js';
import type { LockfileOptions } from './lockfile.js';
import type { JsonReplacer, JsonReviver, PathLike } from './pathlib.js';

export type AtomicFileData = string | Buffer | Uint8Array;

export type AtomicWriteOptions = {
	encoding?: BufferEncoding;
	mode?: number;
	preserveMode?: boolean;
	flush?: boolean;
	syncDirectory?: boolean;
	tmpPrefix?: string;
	token?: CancellationToken;
	signal?: AbortSignal;
};

export type FileFingerprint = {
	algorithm: string;
	hash: string;
	size: number;
	mtimeMs: number;
};

export type FingerprintOptions = {
	algorithm?: string;
	token?: CancellationToken;
	allowMissing?: boolean;
};

export type CompareAndSwapResult = {
	swapped: boolean;
	fingerprint?: FileFingerprint;
};

export type CompareAndSwapOptions = AtomicWriteOptions & {
	algorithm?: string;
	lock?: LockfileOptions;
};

export type UpdateJsonAtomicOptions<T> = AtomicWriteOptions & {
	defaultValue?: T;
	reviver?: JsonReviver;
	replacer?: JsonReplacer;
	space?: string | number;
	lock?: LockfileOptions;
};

function createAbortBridge(options: AtomicWriteOptions): {
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

function mapCancellationError(error: unknown, options: AtomicWriteOptions): never {
	if (options.token?.isCancellationRequested) {
		throw new OperationCancelledError(options.token.cancellationReason, options.token);
	}

	if (options.signal?.aborted) {
		throw new OperationCancelledError(String(options.signal.reason ?? 'AbortSignal was aborted'));
	}

	throw error;
}

function isMissingError(error: unknown): boolean {
	return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

function stringifyJson(value: unknown, replacer: JsonReplacer | undefined, space: string | number): string {
	if (typeof replacer === 'function') {
		return JSON.stringify(value, replacer, space);
	}

	return JSON.stringify(value, replacer ?? null, space);
}

async function getExistingMode(targetPath: string, options: AtomicWriteOptions): Promise<number | undefined> {
	if (options.mode !== undefined) {
		return options.mode;
	}

	if (options.preserveMode === false) {
		return undefined;
	}

	try {
		return (await fs.stat(targetPath)).mode;
	} catch (error) {
		if (isMissingError(error)) {
			return undefined;
		}

		throw error;
	}
}

async function syncParentDirectory(parentPath: string): Promise<void> {
	let handle: fs.FileHandle | undefined;

	try {
		handle = await fs.open(parentPath, 'r');
		await handle.sync();
	} catch (error) {
		const code = (error as NodeJS.ErrnoException)?.code;
		if (!['EACCES', 'EINVAL', 'EISDIR', 'ENOTSUP', 'EPERM'].includes(code ?? '')) {
			throw error;
		}
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

function fingerprintsEqual(left: FileFingerprint | undefined, right: FileFingerprint | undefined): boolean {
	if (!left || !right) {
		return left === right;
	}

	return left.algorithm === right.algorithm && left.hash === right.hash && left.size === right.size;
}

function lockOptions(options: LockfileOptions | undefined, token: CancellationToken | undefined): LockfileOptions {
	return {
		retries: 500,
		retryDelayMs: 2,
		...options,
		token: options?.token ?? token,
	};
}

function throwIfCancelled(options: AtomicWriteOptions): void {
	options.token?.throwIfCancellationRequested();
	if (options.signal?.aborted) {
		throw new OperationCancelledError(String(options.signal.reason ?? 'AbortSignal was aborted'));
	}
}

async function withAtomicLock<T>(
	target: Path,
	options: AtomicWriteOptions & { lock?: LockfileOptions },
	operation: (token: CancellationToken) => Promise<T>
): Promise<T> {
	throwIfCancelled(options);

	const bridge = createAbortBridge(options);
	const signalToken = CancellationToken.fromAbortSignal(bridge.signal);
	const token = options.lock?.token
		? CancellationTokenUtils.any(signalToken, options.lock.token)
		: signalToken;
	let lock: Lockfile | undefined;
	try {
		lock = await Lockfile.acquire(`${target}.lock`, {
			...lockOptions(options.lock, token),
			token,
		});
		token.throwIfCancellationRequested();

		return await operation(token);
	} catch (error) {
		return mapCancellationError(error, options);
	} finally {
		try {
			await lock?.release();
		} finally {
			token.dispose();
			signalToken.dispose();
			bridge.cleanup();
		}
	}
}

export async function writeFileAtomic(
	target: PathLike,
	data: AtomicFileData,
	options: AtomicWriteOptions = {}
): Promise<Path> {
	options.token?.throwIfCancellationRequested();
	if (options.signal?.aborted) {
		throw new OperationCancelledError(String(options.signal.reason ?? 'AbortSignal was aborted'));
	}

	const targetPath = Path.from(target).absolute();
	const parentPath = targetPath.parent;
	const mode = await getExistingMode(targetPath.toString(), options);
	const tempPath = parentPath.joinpath(
		`${options.tmpPrefix ?? '.atomic'}-${process.pid}-${randomUUID()}`
	);
	const bridge = createAbortBridge(options);

	try {
		await parentPath.ensureDir();
		await fs.writeFile(tempPath.toString(), data, {
			encoding: options.encoding ?? 'utf-8',
			flag: 'wx',
			flush: options.flush ?? true,
			mode,
			signal: bridge.signal,
		});
		if (mode !== undefined) {
			await fs.chmod(tempPath.toString(), mode);
		}

		options.token?.throwIfCancellationRequested();
		if (options.signal?.aborted) {
			throw new OperationCancelledError(String(options.signal.reason ?? 'AbortSignal was aborted'));
		}

		await fs.rename(tempPath.toString(), targetPath.toString());

		if (options.syncDirectory ?? true) {
			await syncParentDirectory(parentPath.toString());
		}
	} catch (error) {
		mapCancellationError(error, options);
	} finally {
		bridge.cleanup();
		await fs.rm(tempPath.toString(), { force: true }).catch(() => undefined);
	}

	return targetPath;
}

export async function fingerprintFile(
	target: PathLike,
	options: FingerprintOptions = {}
): Promise<FileFingerprint | undefined> {
	const targetPath = Path.from(target);
	const algorithm = options.algorithm ?? 'sha256';
	const hash = createHash(algorithm);
	let handle: fs.FileHandle | undefined;

	try {
		handle = await fs.open(targetPath.toString(), 'r');
		const stats = await handle.stat();
		const buffer = Buffer.allocUnsafe(64 * 1024);
		let position = 0;

		while (position < stats.size) {
			options.token?.throwIfCancellationRequested();

			const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
			if (bytesRead === 0) {
				break;
			}

			hash.update(buffer.subarray(0, bytesRead));
			position += bytesRead;
		}

		return {
			algorithm,
			hash: hash.digest('hex'),
			size: stats.size,
			mtimeMs: stats.mtimeMs,
		};
	} catch (error) {
		if (options.allowMissing && isMissingError(error)) {
			return undefined;
		}

		throw error;
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

export async function compareAndSwapFile(
	target: PathLike,
	expected: FileFingerprint | undefined,
	data: AtomicFileData,
	options: CompareAndSwapOptions = {}
): Promise<CompareAndSwapResult> {
	const targetPath = Path.from(target).absolute();
	return await withAtomicLock(targetPath, options, async (token) => {
		const current = await fingerprintFile(targetPath, {
			algorithm: options.algorithm ?? expected?.algorithm,
			allowMissing: true,
			token,
		});

		if (!fingerprintsEqual(current, expected)) {
			return { swapped: false, fingerprint: current };
		}

		await writeFileAtomic(targetPath, data, {
			...options,
			token,
		});
		const fingerprint = await fingerprintFile(targetPath, {
			algorithm: options.algorithm ?? expected?.algorithm,
			token,
		});

		return { swapped: true, fingerprint };
	});
}

export async function updateJsonAtomic<T>(
	target: PathLike,
	updater: (current: T | undefined) => T | Promise<T>,
	options: UpdateJsonAtomicOptions<T> = {}
): Promise<T> {
	const targetPath = Path.from(target).absolute();
	return await withAtomicLock(targetPath, options, async (token) => {
		let current = options.defaultValue;
		try {
			current = JSON.parse(
				await fs.readFile(targetPath.toString(), {
					encoding: options.encoding ?? 'utf-8',
					signal: token.toAbortSignal(),
				}),
				options.reviver
			) as T;
		} catch (error) {
			if (!isMissingError(error)) {
				throw error;
			}
		}

		token.throwIfCancellationRequested();

		const updated = await updater(current);
		const serialized = stringifyJson(updated, options.replacer, options.space ?? 2);

		await writeFileAtomic(targetPath, serialized, {
			...options,
			token,
		});

		return updated;
	});
}
