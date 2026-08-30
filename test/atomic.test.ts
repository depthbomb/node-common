import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { compareAndSwapFile, fingerprintFile, updateJsonAtomic, writeFileAtomic } from '../src/atomic';
import { CancellationToken, OperationCancelledError } from '../src/cancellation';

async function removeFixture(root: string): Promise<void> {
	await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
}

describe('atomic files', () => {
	it('atomically writes text and binary data without temporary residue', async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), 'node-common-atomic-'));
		const target = path.join(root, 'data.bin');

		try {
			await writeFileAtomic(target, 'first');
			await writeFileAtomic(target, Buffer.from([1, 2, 3]));

			expect(await readFile(target)).toEqual(Buffer.from([1, 2, 3]));
			expect(await readdir(root)).toEqual(['data.bin']);
		} finally {
			await removeFixture(root);
		}
	});

	it.runIf(process.platform !== 'win32')('preserves the existing file mode', async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), 'node-common-atomic-'));
		const target = path.join(root, 'mode.txt');

		try {
			await writeFile(target, 'before');
			await chmod(target, 0o640);
			await writeFileAtomic(target, 'after');

			expect((await stat(target)).mode & 0o777).toBe(0o640);
		} finally {
			await removeFixture(root);
		}
	});

	it('serializes concurrent JSON updates with an advisory lock', async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), 'node-common-atomic-'));
		const target = path.join(root, 'counter.json');

		try {
			await Promise.all(Array.from({ length: 10 }, () => updateJsonAtomic<number>(
				target,
				(current) => (current ?? 0) + 1,
				{ defaultValue: 0 }
			)));

			expect(JSON.parse(await readFile(target, 'utf-8'))).toBe(10);
		} finally {
			await removeFixture(root);
		}
	});

	it('performs guarded compare-and-swap updates', async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), 'node-common-atomic-'));
		const target = path.join(root, 'value.txt');

		try {
			await writeFileAtomic(target, 'one');
			const expected = await fingerprintFile(target);
			const swapped = await compareAndSwapFile(target, expected, 'two');
			const stale = await compareAndSwapFile(target, expected, 'three');

			expect(swapped.swapped).toBe(true);
			expect(stale.swapped).toBe(false);
			expect(await readFile(target, 'utf-8')).toBe('two');
		} finally {
			await removeFixture(root);
		}
	});

	it('honors pre-cancelled writes', async () => {
		await expect(writeFileAtomic('unused.txt', 'data', {
			token: CancellationToken.Cancelled,
		})).rejects.toBeInstanceOf(OperationCancelledError);
	});
});
