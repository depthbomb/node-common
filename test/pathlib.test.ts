import * as os from 'node:os';
import * as path from 'node:path';
import { Path } from '../src/pathlib';
import * as fs from 'node:fs/promises';
import { it, expect, describe } from 'vitest';

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'node-common-vitest-'));
	try {
		await run(dir);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

describe('pathlib', () => {
	it('supports core path properties and transforms', async () => {
		await withTempDir(async (dir) => {
			const file = new Path(dir, 'folder', 'example.test.txt');

			expect(file.name).toBe('example.test.txt');
			expect(file.suffix).toBe('.txt');
			expect(file.suffixes).toEqual(['.test', '.txt']);
			expect(file.stem).toBe('example.test');
			expect(file.parent.name).toBe('folder');
			expect(file.isAbsolute).toBe(true);

			expect(file.withName('renamed.md').name).toBe('renamed.md');
			expect(file.withSuffix('log').name).toBe('example.test.log');
			expect(file.withStem('changed').name).toBe('changed.txt');

			expect(file.joinpath('x').toString()).toBe(path.join(file.toString(), 'x'));
			expect(file.div('y').toString()).toBe(path.join(file.toString(), 'y'));
			expect(file.equals(new Path(file.toString()))).toBe(true);
			expect(file.match('*.txt')).toBe(true);
		});
	});

	it('supports text and bytes read/write in async and sync forms', async () => {
		await withTempDir(async (dir) => {
			const textPath = new Path(dir, 'file.txt');
			await textPath.writeText('hello');
			await textPath.appendText('-world');
			expect(await textPath.readText()).toBe('hello-world');

			textPath.writeTextSync('sync');
			textPath.appendTextSync('-text');
			expect(textPath.readTextSync()).toBe('sync-text');

			const bytesPath = new Path(dir, 'bytes.bin');
			await bytesPath.writeBytes(Buffer.from([1, 2, 3]));
			expect(Array.from(await bytesPath.readBytes())).toEqual([1, 2, 3]);

			bytesPath.writeBytesSync(Buffer.from([4, 5]));
			expect(Array.from(bytesPath.readBytesSync())).toEqual([4, 5]);
		});
	});

	it('supports directory creation/listing and existence checks', async () => {
		await withTempDir(async (dir) => {
			const root = new Path(dir);
			const nested = root.joinpath('nested');
			const file = nested.joinpath('a.txt');

			await nested.mkdir();
			await file.writeText('a');

			expect(await root.exists()).toBe(true);
			expect(root.existsSync()).toBe(true);
			expect(await nested.isDir()).toBe(true);
			expect(nested.isDirSync()).toBe(true);
			expect(await file.isFile()).toBe(true);
			expect(file.isFileSync()).toBe(true);

			const asyncEntries = (await nested.listdir()).map((p) => p.name).sort();
			const syncEntries = nested.listdirSync().map((p) => p.name).sort();
			expect(asyncEntries).toEqual(['a.txt']);
			expect(syncEntries).toEqual(['a.txt']);
		});
	});

	it('supports glob and rglob', async () => {
		await withTempDir(async (dir) => {
			const root = new Path(dir);
			await root.joinpath('a.txt').writeText('a');
			await root.joinpath('b.log').writeText('b');
			await root.joinpath('deep').mkdir();
			await root.joinpath('deep', 'c.txt').writeText('c');

			const direct = (await root.globList('*.txt')).map((p) => p.name).sort();
			expect(direct).toEqual(['a.txt']);

			const recursive: string[] = [];
			for await (const entry of root.rglob('*.txt')) {
				recursive.push(entry.name);
			}
			expect(recursive.sort()).toEqual(['a.txt', 'c.txt']);
		});
	});

	it('supports rename, copy, unlink, remove, and touch', async () => {
		await withTempDir(async (dir) => {
			const root = new Path(dir);
			const original = root.joinpath('original.txt');
			await original.writeText('content');

			const renamed = await original.rename(root.joinpath('renamed.txt'));
			expect(await renamed.exists()).toBe(true);
			expect(await original.exists()).toBe(false);

			const copied = root.joinpath('copied.txt');
			await renamed.copyFile(copied);
			expect(await copied.readText()).toBe('content');

			await copied.unlink();
			expect(await copied.exists()).toBe(false);

			const touched = root.joinpath('touched.txt');
			await touched.touch();
			expect(await touched.exists()).toBe(true);

			const removeDir = root.joinpath('remove-me');
			await removeDir.mkdir();
			await removeDir.joinpath('x.txt').writeText('x');
			await removeDir.remove();
			expect(await removeDir.exists()).toBe(false);
		});
	});

	it('supports write streams and path conversion helpers', async () => {
		await withTempDir(async (dir) => {
			const file = new Path(dir, 'stream.txt');
			await new Promise<void>((resolve, reject) => {
				const stream = file.toWriteStream();
				stream.on('error', reject);
				stream.on('finish', () => resolve());
				stream.end('stream-data');
			});

			expect(await file.readText()).toBe('stream-data');

			const absolute = file.absolute();
			const relative = absolute.relativeTo(new Path(dir));
			expect(relative.toString()).toBe('stream.txt');

			expect(Path.from(dir, 'stream.txt').toString()).toBe(file.toString());
		});
	});

	it('reads file lines via readLines()', async () => {
		await withTempDir(async (dir) => {
			const filePath = path.join(dir, 'lines.txt');
			await fs.writeFile(filePath, 'one\ntwo\r\nthree');

			const result: string[] = [];
			for await (const line of new Path(filePath).readLines()) {
				result.push(line);
			}

			expect(result).toEqual(['one', 'two', 'three']);
		});
	});

	it('round-trips file URIs', () => {
		const samplePath = path.join(os.tmpdir(), 'node common', 'file name.txt');
		const uri = new Path(samplePath).toUri();

		expect(uri.startsWith('file://')).toBe(true);
		expect(uri).toContain('%20');

		const roundTrip = Path.fromUri(uri).toString();
		expect(path.resolve(roundTrip)).toBe(path.resolve(samplePath));
	});

	it('rejects non-file URIs', () => {
		expect(() => Path.fromUri('https://example.com/test.txt')).toThrow('URI must start with file://');
	});

	it('walk does not recurse into symlinked directories', async () => {
		await withTempDir(async (dir) => {
			const nestedDir = path.join(dir, 'nested');
			await fs.mkdir(nestedDir, { recursive: true });
			await fs.writeFile(path.join(nestedDir, 'file.txt'), 'content');

			const linkPath = path.join(dir, 'nested-link');
			let createdSymlink = true;

			try {
				const linkType = process.platform === 'win32' ? 'junction' : 'dir';
				await fs.symlink(nestedDir, linkPath, linkType);
			} catch {
				createdSymlink = false;
			}

			if (!createdSymlink) {
				return;
			}

			const visitedDirs: string[] = [];
			let rootFiles: string[] = [];
			const root = new Path(dir);

			for await (const [current, _dirs, files] of root.walk()) {
				const currentPath = path.resolve(current.toString());
				visitedDirs.push(currentPath);

				if (currentPath === path.resolve(dir)) {
					rootFiles = files.map((entry) => path.resolve(entry.toString()));
				}
			}

			expect(visitedDirs.sort()).toEqual([path.resolve(dir), path.resolve(nestedDir)].sort());
			expect(rootFiles).toContain(path.resolve(linkPath));
		});
	});
});
