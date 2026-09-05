import { PassThrough, Readable, Transform, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { CancellationToken, CancellationTokenSource, OperationCancelledError } from '../src/cancellation';
import {
	LineLimitExceededError,
	StreamLimitExceededError,
	collectStream,
	iterateLines,
	pipelineWithCancellation,
} from '../src/streams';

describe('streams', () => {
	it('preserves multibyte text and delimiters at every byte boundary', async () => {
		const text = 'first 😀\r\n\nsecond\ntrailing\r';
		for (const encoding of ['utf8', 'utf16le'] as const) {
			const bytes = Buffer.from(text, encoding);
			for (let split = 0; split <= bytes.length; split += 1) {
				const lines: string[] = [];
				for await (const line of iterateLines(Readable.from([bytes.subarray(0, split), bytes.subarray(split)]), {
					encoding,
				})) {
					lines.push(line);
				}

				expect(lines).toEqual(['first 😀', '', 'second', 'trailing\r']);
			}
		}
	});

	it('collects long fragmented records without losing adjacent short lines', async () => {
		const chunks = Array.from({ length: 128 }, () => Buffer.alloc(8192, 120));
		chunks.push(Buffer.from('\r\nshort\nlast'));
		const lines: string[] = [];
		for await (const line of iterateLines(Readable.from(chunks))) {
			lines.push(line);
		}

		expect(lines).toEqual(['x'.repeat(1_048_576), 'short', 'last']);
	});

	it('applies line limits consistently across every CRLF split', async () => {
		for (const text of ['abc\r\n', '\r\n']) {
			const limit = text.length - 2;
			for (let split = 0; split <= text.length; split += 1) {
				const lines: string[] = [];
				for await (const line of iterateLines(Readable.from([text.slice(0, split), text.slice(split)]), {
					maxLineLength: limit,
				})) {
					lines.push(line);
				}

				expect(lines).toEqual([text.slice(0, -2)]);
			}
		}

		const unterminated = iterateLines(Readable.from(['abc\r']), {
			maxLineLength: 3,
		});
		await expect(unterminated.next()).rejects.toBeInstanceOf(LineLimitExceededError);
	});

	it('rejects pre-cancelled ready streams without consuming their data', async () => {
		const source = Readable.from(['ready']);
		await expect(collectStream(source, {
			token: CancellationToken.Cancelled,
		})).rejects.toBeInstanceOf(OperationCancelledError);
		expect(source.readableDidRead).toBe(false);
		const lines = iterateLines(source, {
			token: CancellationToken.Cancelled,
		});
		await expect(lines.next()).rejects.toBeInstanceOf(OperationCancelledError);
		await expect(pipelineWithCancellation([Readable.from(['ready']), new PassThrough()], {
			token: CancellationToken.Cancelled,
		})).rejects.toBeInstanceOf(OperationCancelledError);
		source.destroy();
	});

	it('collects text and binary streams', async () => {
		await expect(collectStream(Readable.from(['hello', ' ', 'world']))).resolves.toBe('hello world');
		await expect(collectStream(Readable.from([Buffer.from([1, 2]), Buffer.from([3])]), {
			encoding: null,
		})).resolves.toEqual(Buffer.from([1, 2, 3]));
	});

	it('enforces collection byte limits and preserves completed chunks', async () => {
		await expect(collectStream(Readable.from(['abcd', 'efgh']), { maxBytes: 6 })).rejects.toMatchObject({
			limit: 6,
			received: 8,
			partial: Buffer.from('abcd'),
		});
		await expect(collectStream(Readable.from(['too much']), { maxBytes: 2 })).rejects.toBeInstanceOf(
			StreamLimitExceededError
		);
	});

	it('iterates lines across chunk and multibyte boundaries', async () => {
		const bytes = Buffer.from('first\r\nsecond 😀\nthird');
		const chunks = [bytes.subarray(0, 8), bytes.subarray(8, 17), bytes.subarray(17)];
		const lines: string[] = [];

		for await (const line of iterateLines(Readable.from(chunks))) {
			lines.push(line);
		}

		expect(lines).toEqual(['first', 'second 😀', 'third']);
	});

	it('enforces line length limits', async () => {
		const consume = async () => {
			for await (const _line of iterateLines(Readable.from(['oversized']), { maxLineLength: 4 })) {
				// Consume the iterator.
			}
		};

		await expect(consume()).rejects.toBeInstanceOf(LineLimitExceededError);
	});

	it('cancels blocked stream collection', async () => {
		const source = new PassThrough();
		const cancellation = new CancellationTokenSource();
		const result = collectStream(source, { token: cancellation.token });

		cancellation.cancel('stop collecting');

		await expect(result).rejects.toMatchObject({
			name: OperationCancelledError.name,
			message: 'stop collecting',
		});
	});

	it('runs pipelines and supports cancellation', async () => {
		let output = '';
		const uppercase = new Transform({
			transform(chunk, _encoding, callback) {
				callback(null, String(chunk).toUpperCase());
			},
		});
		const destination = new Writable({
			write(chunk, _encoding, callback) {
				output += String(chunk);
				callback();
			},
		});

		await pipelineWithCancellation([Readable.from(['hello']), uppercase, destination]);

		expect(output).toBe('HELLO');

		const source = new PassThrough();
		const sink = new PassThrough();
		const cancellation = new CancellationTokenSource();
		const pending = pipelineWithCancellation([source, sink], { token: cancellation.token });

		cancellation.cancel('stop pipeline');

		await expect(pending).rejects.toBeInstanceOf(OperationCancelledError);
	});

	it('validates limits and pipeline length', async () => {
		await expect(collectStream(Readable.from([]), { maxBytes: -1 })).rejects.toBeInstanceOf(RangeError);
		await expect(pipelineWithCancellation([new PassThrough()])).rejects.toBeInstanceOf(RangeError);
	});
});
