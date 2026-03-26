import * as fs from 'node:fs/promises';
import { Path } from '../dist/pathlib.mjs';
import { TempDir } from '../dist/temp.mjs';
import { it, expect, describe } from 'vitest';
import { Lockfile, LockfileOwnershipError, LockfileAlreadyLockedError } from '../dist/lockfile.mjs';

describe('lockfile', () => {
	it('acquires and releases a lockfile', async () => {
		const tempDir = await TempDir.create();
		try {
			const lockPath = tempDir.path.joinpath('resource.lock');
			const lock = await Lockfile.acquire(lockPath);
			expect(await lockPath.exists()).toBe(true);

			await lock.release();
			expect(await lockPath.exists()).toBe(false);
		} finally {
			await tempDir.cleanup();
		}
	});

	it('prevents concurrent lock acquisition', async () => {
		const tempDir = await TempDir.create();
		try {
			const lockPath = tempDir.path.joinpath('resource.lock');
			const first = await Lockfile.acquire(lockPath);
			await expect(Lockfile.acquire(lockPath, { retries: 0 }))
				.rejects.toBeInstanceOf(LockfileAlreadyLockedError);
			await first.release();
		} finally {
			await tempDir.cleanup();
		}
	});

	it('supports withLock and automatic release', async () => {
		const tempDir = await TempDir.create();
		try {
			const lockPath = tempDir.path.joinpath('resource.lock');
			const result = await Lockfile.withLock(lockPath, async (lock) => {
				expect(await lock.path.exists()).toBe(true);
				return 'ok';
			});

			expect(result).toBe('ok');
			expect(await lockPath.exists()).toBe(false);
		} finally {
			await tempDir.cleanup();
		}
	});

	it('evicts stale lockfiles when staleMs is reached', async () => {
		const tempDir = await TempDir.create();
		try {
			const lockPath = tempDir.path.joinpath('resource.lock');
			await lockPath.writeText('stale');

			const old = new Date(Date.now() - 60_000);
			await fs.utimes(lockPath.toString(), old, old);

			const lock = await Lockfile.acquire(lockPath, { staleMs: 1000 });
			expect(await lockPath.exists()).toBe(true);
			await lock.release();
		} finally {
			await tempDir.cleanup();
		}
	});

	it('checks ownership on release', async () => {
		const tempDir = await TempDir.create();
		try {
			const lockPath = tempDir.path.joinpath('resource.lock');
			const first = await Lockfile.acquire(lockPath);

			await lockPath.writeText(JSON.stringify({ lockId: 'different-owner' }));
			await expect(first.release()).rejects.toBeInstanceOf(LockfileOwnershipError);
		} finally {
			await tempDir.cleanup();
		}
	});

	it('reports lock status with isLocked', async () => {
		const tempDir = await TempDir.create();
		try {
			const lockPath = Path.from(tempDir.path, 'resource.lock');
			expect(await Lockfile.isLocked(lockPath)).toBe(false);

			const lock = await Lockfile.acquire(lockPath);
			expect(await Lockfile.isLocked(lockPath)).toBe(true);

			await lock.release();
			expect(await Lockfile.isLocked(lockPath)).toBe(false);
		} finally {
			await tempDir.cleanup();
		}
	});
});
