import { StringDecoder } from 'node:string_decoder';
import { addAbortSignal } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { CancellationToken, OperationCancelledError } from './cancellation.js';
import type { Readable, Stream } from 'node:stream';

export type StreamCancellationOptions = {
	token?: CancellationToken;
	signal?: AbortSignal;
};

export type CollectStreamOptions = StreamCancellationOptions & {
	encoding?: BufferEncoding | null;
	maxBytes?: number;
};

export type IterateLinesOptions = StreamCancellationOptions & {
	encoding?: BufferEncoding;
	maxLineLength?: number;
};

export type PipelineOptions = StreamCancellationOptions & {
	end?: boolean;
};

export class StreamLimitExceededError extends Error {
	public readonly limit: number;
	public readonly received: number;
	public readonly partial: Buffer;

	constructor(limit: number, received: number, partial: Buffer) {
		super(`Stream exceeded the ${limit}-byte limit after receiving ${received} bytes`);
		this.name = 'StreamLimitExceededError';
		this.limit = limit;
		this.received = received;
		this.partial = partial;
	}
}

export class LineLimitExceededError extends Error {
	public readonly limit: number;
	public readonly lineLength: number;

	constructor(limit: number, lineLength: number) {
		super(`Stream line exceeded the ${limit}-character limit`);
		this.name = 'LineLimitExceededError';
		this.limit = limit;
		this.lineLength = lineLength;
	}
}

function validateLimit(limit: number | undefined, label: string): void {
	if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0)) {
		throw new RangeError(`${label} must be a non-negative safe integer`);
	}
}

function createAbortBridge(options: StreamCancellationOptions): {
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

function mapCancellationError(error: unknown, options: StreamCancellationOptions): never {
	if (options.token?.isCancellationRequested) {
		throw new OperationCancelledError(options.token.cancellationReason, options.token);
	}

	if (options.signal?.aborted) {
		throw new OperationCancelledError(String(options.signal.reason ?? 'AbortSignal was aborted'));
	}

	throw error;
}

function toBuffer(chunk: string | Buffer | Uint8Array, encoding: BufferEncoding): Buffer {
	if (typeof chunk === 'string') {
		return Buffer.from(chunk, encoding);
	}

	return Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
}

export function collectStream(stream: Readable, options: CollectStreamOptions & { encoding: null }): Promise<Buffer>;
export function collectStream(stream: Readable, options?: CollectStreamOptions): Promise<string>;
export async function collectStream(
	stream: Readable,
	options: CollectStreamOptions = {}
): Promise<string | Buffer> {
	validateLimit(options.maxBytes, 'maxBytes');
	options.token?.throwIfCancellationRequested();

	const encoding = options.encoding === undefined ? 'utf-8' : options.encoding;
	const chunks: Buffer[] = [];
	const bridge = createAbortBridge(options);
	let received = 0;

	addAbortSignal(bridge.signal, stream);

	try {
		for await (const chunk of stream as AsyncIterable<string | Buffer | Uint8Array>) {
			const bytes = toBuffer(chunk, encoding ?? 'utf-8');
			received += bytes.length;

			if (options.maxBytes !== undefined && received > options.maxBytes) {
				throw new StreamLimitExceededError(options.maxBytes, received, Buffer.concat(chunks));
			}

			chunks.push(bytes);
		}
	} catch (error) {
		mapCancellationError(error, options);
	} finally {
		bridge.cleanup();
	}

	const output = Buffer.concat(chunks, received);

	return encoding === null ? output : output.toString(encoding);
}

export async function* iterateLines(
	stream: Readable,
	options: IterateLinesOptions = {}
): AsyncIterableIterator<string> {
	validateLimit(options.maxLineLength, 'maxLineLength');
	options.token?.throwIfCancellationRequested();

	const decoder = new StringDecoder(options.encoding ?? 'utf-8');
	const bridge = createAbortBridge(options);
	let buffered = '';

	addAbortSignal(bridge.signal, stream);

	try {
		for await (const chunk of stream as AsyncIterable<string | Buffer | Uint8Array>) {
			buffered += typeof chunk === 'string' ? chunk : decoder.write(toBuffer(chunk, options.encoding ?? 'utf-8'));

			let newlineIndex = buffered.indexOf('\n');
			while (newlineIndex !== -1) {
				const endIndex = newlineIndex > 0 && buffered[newlineIndex - 1] === '\r'
					? newlineIndex - 1
					: newlineIndex;
				const line = buffered.slice(0, endIndex);
				if (options.maxLineLength !== undefined && line.length > options.maxLineLength) {
					throw new LineLimitExceededError(options.maxLineLength, line.length);
				}

				yield line;
				buffered = buffered.slice(newlineIndex + 1);
				newlineIndex = buffered.indexOf('\n');
			}

			if (options.maxLineLength !== undefined && buffered.length > options.maxLineLength) {
				throw new LineLimitExceededError(options.maxLineLength, buffered.length);
			}
		}

		buffered += decoder.end();
		if (buffered.length > 0) {
			if (options.maxLineLength !== undefined && buffered.length > options.maxLineLength) {
				throw new LineLimitExceededError(options.maxLineLength, buffered.length);
			}

			yield buffered;
		}
	} catch (error) {
		mapCancellationError(error, options);
	} finally {
		bridge.cleanup();
	}
}

export async function pipelineWithCancellation(
	streams: readonly Stream[],
	options: PipelineOptions = {}
): Promise<void> {
	if (streams.length < 2) {
		throw new RangeError('A pipeline requires at least two streams');
	}

	const bridge = createAbortBridge(options);

	try {
		const runPipeline = pipeline as unknown as (
			pipelineStreams: Stream[],
			pipelineOptions: { end: boolean; signal: AbortSignal }
		) => Promise<void>;

		await runPipeline([...streams], {
			end: options.end ?? true,
			signal: bridge.signal,
		});
	} catch (error) {
		mapCancellationError(error, options);
	} finally {
		bridge.cleanup();
	}
}
