import * as os from 'node:os';
import { Path } from './pathlib';
import * as fs from 'node:fs/promises';
import { CancellationToken } from './cancellation';
import type { PathLike } from './pathlib';

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
		return JSON.parse(content) as LockfilePayload;
	} catch {
		return undefined;
	}
}

function isAlreadyLockedError(error: unknown): boolean {
	const nodeError = error as NodeJS.ErrnoException;
	return nodeError?.code === 'EEXIST';
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
		const pathValue = Path.from(lockPath);
		await pathValue.ensureParentDir();

		const retries = options.retries ?? 0;
		const retryDelayMs = options.retryDelayMs ?? 50;
		const staleMs = options.staleMs;
		const token = options.token;
		const lockId = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

		let attempts = 0;
		while (true) {
			token?.throwIfCancellationRequested();

			try {
				const handle = await fs.open(pathValue.toString(), 'wx');
				try {
					const payload = createPayload(lockId, options.metadata);
					await handle.writeFile(JSON.stringify(payload));
				} finally {
					await handle.close();
				}

				return new Lockfile(pathValue, lockId, options.verifyOwnershipOnRelease ?? true);
			} catch (error) {
				if (!isAlreadyLockedError(error)) {
					throw error;
				}

				if (typeof staleMs === 'number' && staleMs > 0) {
					try {
						const stats = await pathValue.stat();
						const age = Date.now() - stats.mtimeMs;
						if (age >= staleMs) {
							await fs.rm(pathValue.toString(), { force: true });
							continue;
						}
					} catch {
						// no-op; proceed with retry flow
					}
				}

				if (attempts >= retries) {
					throw new LockfileAlreadyLockedError(pathValue);
				}

				attempts += 1;
				if (token) {
					await token.delay(retryDelayMs);
				} else {
					await sleep(retryDelayMs);
				}
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
		if (this.released) return;

		if (this.verifyOwnershipOnRelease && await this.path.exists()) {
			const payload = await readPayload(this.path);
			if (payload && payload.lockId !== this.lockId) {
				throw new LockfileOwnershipError(this.path);
			}
		}

		await fs.rm(this.path.toString(), { force: true });
		this.released = true;
	}
}
