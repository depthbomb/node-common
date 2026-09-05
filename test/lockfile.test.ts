import * as fs from 'node:fs/promises';
import { Path } from '../src/pathlib';
import { TempDir } from '../src/temp';
import { afterEach, it, expect, describe, vi } from 'vitest';
import { Lockfile, LockfileOwnershipError, LockfileAlreadyLockedError } from '../src/lockfile';

vi.mock('node:fs/promises', async (importOriginal) => ({
	...await importOriginal<typeof fs>(),
}));

afterEach(() => {
	vi.restoreAllMocks();
});

describe('lockfile', () => {
	it('serializes stale eviction with competing acquisition', async () => {
		await (await TempDir.create()).use(async (root) => {
			const path = root.joinpath('stale.lock');
			await path.writeText('old');
			const old = new Date(Date.now() - 60_000);
			await fs.utimes(path.toString(), old, old);
			let entered!: () => void;
			let resume!: () => void;
			const deleting = new Promise<void>((resolve) => { entered = resolve; });
			const resumed = new Promise<void>((resolve) => { resume = resolve; });
			const original = fs.rm;
			vi.spyOn(fs, 'rm').mockImplementation(async (target, options) => {
				if (String(target) === path.toString()) {
					entered();
					await resumed;
				}

				await original(target, options);
			});
			const pending = Lockfile.acquire(path, {
				staleMs: 30_000,
			});
			try {
				await deleting;
				await expect(Lockfile.acquire(path, {
					staleMs: 30_000,
				})).rejects.toBeInstanceOf(LockfileAlreadyLockedError);
			} finally {
				resume();
			}

			const first = await pending;
			await expect(Lockfile.acquire(path, {
				staleMs: 30_000,
			})).rejects.toBeInstanceOf(LockfileAlreadyLockedError);
			await Promise.all([first.release(), first.release()]);
			const next = await Lockfile.acquire(path);
			await next.release();
		});
	});

	it('never evicts an occupied mutation guard', async () => {
		await (await TempDir.create()).use(async (root) => {
			const path = root.joinpath('resource.lock');
			await root.joinpath('resource.lock.guard').mkdir();
			await expect(Lockfile.acquire(path, {
				staleMs: 1,
			})).rejects.toBeInstanceOf(LockfileAlreadyLockedError);
			expect(await path.exists()).toBe(false);
		});
	});

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

	it('fails closed on malformed ownership payloads', async () => {
		const tempDir = await TempDir.create();
		try {
			const lockPath = tempDir.path.joinpath('resource.lock');
			const lock = await Lockfile.acquire(lockPath);
			await lockPath.writeText('{broken');
			await expect(lock.release()).rejects.toBeInstanceOf(LockfileOwnershipError);
			expect(await lockPath.exists()).toBe(true);
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
