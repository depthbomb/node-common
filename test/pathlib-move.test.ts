import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Path } from '../src/pathlib';
import { TempDir } from '../src/temp';

vi.mock('node:fs', async (importOriginal) => ({ ...await importOriginal<typeof fs>() }));
vi.mock('node:fs/promises', async (importOriginal) => ({ ...await importOriginal<typeof fsp>() }));

afterEach(() => {
	vi.restoreAllMocks();
});

describe.each([false, true])('safe replacement (sync: %s)', (sync) => {
	it.each([false, true])('preserves data during cross-device staging (copy fails: %s)', async (copyFails) => {
		await (await TempDir.create()).use(async (root) => {
			const source = root.joinpath('source');
			const target = root.joinpath('target');
			await source.writeText('new');
			await target.writeText('old');
			const crossDevice = Object.assign(new Error('cross device'), {
				code: 'EXDEV',
			});
			const noSpace = Object.assign(new Error('no space'), {
				code: 'ENOSPC',
			});
			if (sync) {
				const rename = fs.renameSync;
				vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
					if (String(from) === source.toString()) {
						throw crossDevice;
					}

					rename(from, to);
				});

				if (copyFails) {
					vi.spyOn(fs, 'cpSync').mockImplementation(() => {
						throw noSpace;
					});
				}
			} else {
				const rename = fsp.rename;
				vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
					if (String(from) === source.toString()) {
						throw crossDevice;
					}

					await rename(from, to);
				});

				if (copyFails) {
					vi.spyOn(fsp, 'cp').mockRejectedValue(noSpace);
				}
			}

			const move = async () => {
				return sync ? source.replaceSync(target) : await source.replace(target);
			};
			if (copyFails) {
				await expect(move()).rejects.toThrow(noSpace);
				expect(await source.readText()).toBe('new');
				expect(await target.readText()).toBe('old');
			} else {
				await move();
				expect(await source.exists()).toBe(false);
				expect(await target.readText()).toBe('new');
			}

			expect((await root.listdir()).some((entry) => entry.name.startsWith('.move-'))).toBe(false);
		});
	});

	it('preserves identical paths and destinations when the source is missing', async () => {
		await (await TempDir.create()).use(async (root) => {
			const file = root.joinpath('file');
			await file.writeText('valuable');
			const replace = async (source: Path, target: Path) => {
				return sync ? source.replaceSync(target) : await source.replace(target);
			};

			await replace(file, file);
			expect(await file.readText()).toBe('valuable');
			await expect(replace(root.joinpath('missing'), file)).rejects.toMatchObject({
				code: 'ENOENT',
			});
			expect(await file.readText()).toBe('valuable');
		});
	});

	it('replaces populated directories and refuses overlapping trees', async () => {
		await (await TempDir.create()).use(async (root) => {
			const source = await root.joinpath('source').ensureDir();
			const target = await root.joinpath('target').ensureDir();
			await source.joinpath('new').writeText('new');
			await target.joinpath('old').writeText('old');
			const replace = async (from: Path, to: Path) => {
				return sync ? from.replaceSync(to) : await from.replace(to);
			};

			await expect(replace(source, root)).rejects.toMatchObject({
				code: 'EINVAL',
			});
			await replace(source, target);
			expect(await target.joinpath('new').readText()).toBe('new');
			expect(await target.joinpath('old').exists()).toBe(false);
		});
	});

	it('restores a directory destination when the replacement rename fails', async () => {
		await (await TempDir.create()).use(async (root) => {
			const source = await root.joinpath('source').ensureDir();
			const target = await root.joinpath('target').ensureDir();
			await target.joinpath('old').writeText('old');
			const failure = Object.assign(new Error('injected rename failure'), {
				code: 'EPERM',
			});
			if (sync) {
				const original = fs.renameSync;
				vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
					if (String(from) === source.toString()) {
						throw failure;
					}

					original(from, to);
				});
				expect(() => source.replaceSync(target)).toThrow(failure);
			} else {
				const original = fsp.rename;
				vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
					if (String(from) === source.toString()) {
						throw failure;
					}

					await original(from, to);
				});
				await expect(source.replace(target)).rejects.toThrow(failure);
			}

			expect(await target.joinpath('old').readText()).toBe('old');
			expect(await source.exists()).toBe(true);
		});
	});
});
