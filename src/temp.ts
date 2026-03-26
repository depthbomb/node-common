import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Path, type PathLike } from './pathlib';

export type TempFileOptions = {
	prefix?: string;
	suffix?: string;
	dir?: PathLike;
};

export type TempDirOptions = {
	prefix?: string;
	dir?: PathLike;
};

export class TempDir {
	public readonly path: Path;
	private cleaned = false;

	constructor(pathValue: PathLike) {
		this.path = Path.from(pathValue);
	}

	public static async create(options: TempDirOptions = {}): Promise<TempDir> {
		const parent = Path.from(options.dir || os.tmpdir());
		await parent.ensureDir();
		const prefix = options.prefix || 'node-common-';
		const dir = await fs.mkdtemp(path.join(parent.toString(), prefix));
		return new TempDir(dir);
	}

	public joinpath(...segments: PathLike[]): Path {
		return this.path.joinpath(...segments);
	}

	public async cleanup(): Promise<void> {
		if (this.cleaned) return;
		this.cleaned = true;
		await this.path.remove();
	}

	public async use<T>(fn: (dir: Path) => Promise<T>): Promise<T> {
		try {
			return await fn(this.path);
		} finally {
			await this.cleanup();
		}
	}
}

export class TempFile {
	public readonly path: Path;
	private cleaned = false;

	constructor(pathValue: PathLike) {
		this.path = Path.from(pathValue);
	}

	public static async create(options: TempFileOptions = {}): Promise<TempFile> {
		const parent = Path.from(options.dir || os.tmpdir());
		await parent.ensureDir();

		const prefix = options.prefix || 'node-common-';
		const suffix = options.suffix || '.tmp';
		const filePath = parent.joinpath(`${prefix}${randomUUID()}${suffix}`);
		await filePath.ensureFile();
		return new TempFile(filePath);
	}

	public async cleanup(): Promise<void> {
		if (this.cleaned) return;
		this.cleaned = true;
		await this.path.remove();
	}

	public async use<T>(fn: (file: Path) => Promise<T>): Promise<T> {
		try {
			return await fn(this.path);
		} finally {
			await this.cleanup();
		}
	}
}

export async function createTempDir(options: TempDirOptions = {}): Promise<TempDir> {
	return await TempDir.create(options);
}

export async function createTempFile(options: TempFileOptions = {}): Promise<TempFile> {
	return await TempFile.create(options);
}
