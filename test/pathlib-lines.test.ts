import * as fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TempDir } from '../src/temp';

vi.mock('node:fs', async (importOriginal) => ({
	...await importOriginal<typeof fs>(),
}));

afterEach(() => {
	vi.restoreAllMocks();
});

describe('line reader ownership', () => {
	it.each([false, true])('closes its file after early exit (throw: %s)', async (throwError) => {
		await (await TempDir.create()).use(async (root) => {
			const file = root.joinpath('large.txt');
			await file.writeText('line\n'.repeat(100_000));
			const original = fs.createReadStream;
			let stream!: fs.ReadStream;
			let closed!: Promise<void>;
			vi.spyOn(fs, 'createReadStream').mockImplementation((...args) => {
				stream = original(...args);
				closed = new Promise<void>((resolve) => stream.once('close', () => resolve()));

				return stream;
			});
			const consume = async () => {
				for await (const _line of file.readLines()) {
					if (throwError) {
						throw new Error('consumer failure');
					}
					break;
				}
			};

			if (throwError) {
				await expect(consume()).rejects.toThrow('consumer failure');
			} else {
				await consume();
			}

			expect(stream.destroyed).toBe(true);
			await closed;
			expect(stream.closed).toBe(true);
		});
	});
});
