import * as os from 'node:os';
import { Path } from './pathlib.js';
import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { CancellationToken } from './cancellation.js';
import type { PathLike } from './pathlib.js';

export type LockfileOptions = {
	retries?: number;
	retryDelayMs?: number;
	staleMs?: number;
	token?: CancellationToken;
	metadata?: Record<string, unknown>;
	verifyOwnershipOnRelease?: boolean;
};

type LockfilePayload = {
	lockId: string;
	pid: number;
	hostname: string;
	acquiredAt: string;
	metadata?: Record<string, unknown>;
};

export class LockfileAlreadyLockedError extends Error {
	public readonly lockPath: Path;

	constructor(lockPath: PathLike, message?: string) {
		super(message || `Lock already acquired: ${Path.from(lockPath).toString()}`);
		this.name = 'LockfileAlreadyLockedError';
		this.lockPath = Path.from(lockPath);
	}
}

export class LockfileOwnershipError extends Error {
	public readonly lockPath: Path;

	constructor(lockPath: PathLike) {
		super(`Cannot release lock not owned by current lock instance: ${Path.from(lockPath).toString()}`);
		this.name = 'LockfileOwnershipError';
		this.lockPath = Path.from(lockPath);
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function createPayload(lockId: string, metadata?: Record<string, unknown>): LockfilePayload {
	return {
		lockId,
		pid: process.pid,
		hostname: os.hostname(),
		acquiredAt: new Date().toISOString(),
		metadata,
	};
}

async function readPayload(pathValue: Path): Promise<LockfilePayload | undefined> {
	try {
		const content = await pathValue.readText();
		const payload: unknown = JSON.parse(content);
		if (typeof payload !== 'object' || payload === null) return undefined;
		const value = payload as Partial<LockfilePayload>;
		if (typeof value.lockId !== 'string' || typeof value.pid !== 'number'
			|| typeof value.hostname !== 'string' || typeof value.acquiredAt !== 'string') return undefined;
		return value as LockfilePayload;
	} catch {
		return undefined;
	}
}

function isAlreadyLockedError(error: unknown): boolean {
	const nodeError = error as NodeJS.ErrnoException;
	return nodeError?.code === 'EEXIST';
}

/**
 * Serialize acquisition, stale eviction, and ownership-checked release.
 * The guard is never evicted automatically: after a process dies inside this
 * short critical section, remove it only after stopping all cooperating clients.
 * All clients must use this protocol; older versions do not honor the guard.
 */
async function withGuard<T>(lockPath: Path, operation: () => Promise<T>): Promise<T> {
	const guardPath = `${lockPath}.guard`;
	try {
		await fs.mkdir(guardPath);
	} catch (error) {
		// Windows can report a directory pending deletion as EPERM.
		const pendingDeletion = process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM';
		if (pendingDeletion) {
			throw Object.assign(new Error(`Lock guard is unavailable: ${guardPath}`, {
				cause: error,
			}), {
				code: 'EEXIST',
			});
		}

		throw error;
	}

	try {
		return await operation();
	} finally {
		await fs.rmdir(guardPath);
	}
}

export class Lockfile {
	public readonly path: Path;
	public readonly lockId: string;
	private released = false;
	private readonly verifyOwnershipOnRelease: boolean;

	constructor(lockPath: PathLike, lockId: string, verifyOwnershipOnRelease: boolean = true) {
		this.path = Path.from(lockPath);
		this.lockId = lockId;
		this.verifyOwnershipOnRelease = verifyOwnershipOnRelease;
	}

	public static async acquire(lockPath: PathLike, options: LockfileOptions = {}): Promise<Lockfile> {
		const pathValue = Path.from(lockPath).absolute();
		await pathValue.ensureParentDir();

		const lockId = randomUUID();
		let attempts = 0;
		while (true) {
			options.token?.throwIfCancellationRequested();

			try {
				return await withGuard(pathValue, async () => {
					const staleMs = options.staleMs;
					if (staleMs !== undefined && staleMs > 0) {
						try {
							const stats = await pathValue.stat();
							const stale = Date.now() - stats.mtimeMs >= staleMs;
							if (stale) {
								await fs.rm(pathValue.toString());
							}
						} catch (error) {
							const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
							if (!missing) {
								throw error;
							}
						}
					}

					options.token?.throwIfCancellationRequested();

					const payload = JSON.stringify(createPayload(lockId, options.metadata));
					const handle = await fs.open(pathValue.toString(), 'wx');
					try {
						await handle.writeFile(payload);
					} catch (error) {
						await handle.close().catch(() => undefined);
						await fs.rm(pathValue.toString(), {
							force: true,
						});
						throw error;
					} finally {
						await handle.close().catch(() => undefined);
					}

					return new Lockfile(pathValue, lockId, options.verifyOwnershipOnRelease ?? true);
				});
			} catch (error) {
				if (!isAlreadyLockedError(error)) {
					throw error;
				}

				const exhausted = attempts >= (options.retries ?? 0);
				if (exhausted) {
					throw new LockfileAlreadyLockedError(pathValue);
				}

				attempts += 1;
				await (options.token?.delay(options.retryDelayMs ?? 50) ?? sleep(options.retryDelayMs ?? 50));
			}
		}
	}

	public static async isLocked(lockPath: PathLike): Promise<boolean> {
		return await Path.from(lockPath).exists();
	}

	public static async withLock<T>(
		lockPath: PathLike,
		fn: (lock: Lockfile) => Promise<T>,
		options: LockfileOptions = {}
	): Promise<T> {
		const lock = await Lockfile.acquire(lockPath, options);
		try {
			return await fn(lock);
		} finally {
			await lock.release();
		}
	}

	public async release(): Promise<void> {
		for (let attempt = 0; ; attempt += 1) {
			if (this.released) {
				return;
			}

			try {
				await withGuard(this.path.absolute(), async () => {
					if (this.released) {
						return;
					}

					if (this.verifyOwnershipOnRelease && await this.path.lexists()) {
						const payload = await readPayload(this.path);
						if (!payload || payload.lockId !== this.lockId) {
							throw new LockfileOwnershipError(this.path);
						}
					}

					await fs.rm(this.path.toString(), {
						force: true,
					});
					this.released = true;
				});

				return;
			} catch (error) {
				const retry = isAlreadyLockedError(error) && attempt < 500;
				if (!retry) {
					throw error;
				}

				await sleep(2);
			}
		}
	}
}
