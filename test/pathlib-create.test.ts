import * as fs from 'node:fs/promises';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { TempDir } from '../src/temp';

vi.mock('node:fs/promises', async (importOriginal) => ({
	...await importOriginal<typeof fs>(),
}));

afterEach(() => {
	vi.restoreAllMocks();
});

describe.each(['ensureFile', 'touch'] as const)('%s', (method) => {
	it('preserves data created immediately before opening the file', async () => {
		await (await TempDir.create()).use(async (root) => {
			const file = root.joinpath('shared');
			const original = fs.open;
			vi.spyOn(fs, 'open').mockImplementation(async (target, flags, mode) => {
				if (String(target) === file.toString()) {
					await fs.writeFile(target, 'concurrent data');
				}

				return await original(target, flags, mode);
			});

			await file[method]();
			expect(await file.readText()).toBe('concurrent data');
		});
	});

	it('creates missing files and preserves existing contents in sync calls', async () => {
		await (await TempDir.create()).use(async (root) => {
			const file = root.joinpath('shared');
			file[`${method}Sync`]();
			expect(await file.readText()).toBe('');
			await file.writeText('keep');
			file[`${method}Sync`]();
			expect(await file.readText()).toBe('keep');
		});
	});
});
