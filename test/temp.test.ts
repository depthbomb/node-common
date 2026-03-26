import { Path } from '../dist/pathlib.mjs';
import { it, expect, describe } from 'vitest';
import { TempDir, TempFile, createTempDir, createTempFile } from '../dist/temp.mjs';

describe('temp', () => {
	it('creates and cleans up temp directories', async () => {
		const tempDir = await createTempDir({ prefix: 'node-common-test-' });
		expect(await tempDir.path.exists()).toBe(true);

		await tempDir.cleanup();
		expect(await tempDir.path.exists()).toBe(false);
	});

	it('creates and cleans up temp files', async () => {
		const tempFile = await createTempFile({ prefix: 'node-common-test-', suffix: '.txt' });
		expect(await tempFile.path.exists()).toBe(true);
		expect(tempFile.path.name.endsWith('.txt')).toBe(true);

		await tempFile.cleanup();
		expect(await tempFile.path.exists()).toBe(false);
	});

	it('supports scoped temp directory usage', async () => {
		let dirPath = '';
		const result = await TempDir.create().then((tempDir) => tempDir.use(async (dir) => {
			dirPath = dir.toString();
			const file = dir.joinpath('a.txt');
			await file.writeText('ok');
			return await file.readText();
		}));

		expect(result).toBe('ok');
		expect(await new Path(dirPath).exists()).toBe(false);
	});

	it('supports scoped temp file usage', async () => {
		let filePath = '';
		const result = await TempFile.create({ suffix: '.data' }).then((tempFile) => tempFile.use(async (file) => {
			filePath = file.toString();
			await file.writeText('hello');
			return await file.readText();
		}));

		expect(result).toBe('hello');
		expect(await new Path(filePath).exists()).toBe(false);
	});
});
