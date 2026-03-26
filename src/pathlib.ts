import * as os from 'node:os';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as readline from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

export type PathLike = string | Path;
export type JsonReviver = (this: any, key: string, value: any) => any;
export type JsonReplacer = ((this: any, key: string, value: any) => any) | (string | number)[];
export type ReadJsonOptions = {
	encoding?: BufferEncoding;
	reviver?: JsonReviver;
};
export type WriteJsonOptions = {
	encoding?: BufferEncoding;
	replacer?: JsonReplacer;
	space?: string | number;
};
export type WriteTextAtomicOptions = {
	encoding?: BufferEncoding;
	tmpPrefix?: string;
};
export type WalkOptions = {
	maxDepth?: number;
	followSymlinks?: boolean;
	includeDirs?: boolean;
	filter?: (entry: Path, dirent: fsSync.Dirent, depth: number) => boolean | Promise<boolean>;
};
type AsyncGlobOptions = Omit<NonNullable<Parameters<typeof fs.glob>[1]>, 'withFileTypes'> & {
	withFileTypes?: false;
};
type SyncGlobOptions = Omit<NonNullable<Parameters<typeof fsSync.globSync>[1]>, 'withFileTypes'> & {
	withFileTypes?: false;
};
type EnsureSymlinkOptions = {
	type?: fsSync.symlink.Type;
	replace?: boolean;
};
type MoveOptions = {
	overwrite?: boolean;
};

function stringifyJson(
	value: unknown,
	replacer: JsonReplacer | undefined,
	space: string | number | undefined
): string {
	if (typeof replacer === 'function') {
		return JSON.stringify(value, replacer, space);
	}

	return JSON.stringify(value, replacer ?? null, space);
}

export class Path {
	readonly #path: string;

	public constructor(...pathSegments: PathLike[]) {
		if (pathSegments.length === 0) {
			this.#path = '.';
		} else {
			this.#path = path.join(...pathSegments.map(p => p.toString()));
		}
	}

	public static cwd(): Path {
		return new Path(process.cwd());
	}

	public static home(): Path {
		return new Path(os.homedir());
	}

	public static tmp(): Path {
		return new Path(os.tmpdir());
	}

	public static from(...pathSegments: PathLike[]): Path {
		return new Path(...pathSegments);
	}

	public static fromUri(uri: string): Path {
		const url = new URL(uri);
		if (url.protocol !== 'file:') {
			throw new Error('URI must start with file://');
		}

		return new Path(fileURLToPath(url));
	}

	public static commonPath(...paths: PathLike[]): Path {
		if (paths.length === 0) {
			return new Path('.');
		}

		const [first, ...rest] = paths.map((entry) => Path.from(entry).absolute().toString());
		const firstParts = path.resolve(first).split(path.sep);
		let commonLength = firstParts.length;

		for (const entry of rest) {
			const parts = path.resolve(entry).split(path.sep);
			let index = 0;
			while (index < commonLength && index < parts.length && firstParts[index] === parts[index]) {
				index += 1;
			}
			commonLength = index;
		}

		if (commonLength === 0) {
			return new Path(path.parse(first).root || '.');
		}

		return new Path(firstParts.slice(0, commonLength).join(path.sep) || path.parse(first).root);
	}

	public get name(): string {
		return path.basename(this.#path);
	}

	public get suffix(): string {
		return path.extname(this.#path);
	}

	public get suffixes(): string[] {
		const name = this.name;
		const parts = name.split('.');
		if (parts.length <= 1) {
			return [];
		}

		return parts.slice(1).map(s => '.' + s);
	}

	public get stem(): string {
		const name = this.name;
		const ext = this.suffix;
		return ext ? name.slice(0, -ext.length) : name;
	}

	public get parent(): Path {
		return new Path(path.dirname(this.#path));
	}

	public get parents(): Path[] {
		const result = [] as Path[];
		let current = this.parent;
		const root = path.parse(this.#path).root;

		while (current.toString() !== root && current.toString() !== '.') {
			result.push(current);
			const next = current.parent;
			if (next.toString() === current.toString()) {
				break;
			}

			current = next;
		}

		if (root && current.toString() === root) {
			result.push(current);
		}

		return result;
	}

	public get parts(): string[] {
		const normalized = path.normalize(this.#path);
		const parsed = path.parse(normalized);
		const parts = [] as string[];

		if (parsed.root) {
			parts.push(parsed.root);
		}

		if (parsed.dir) {
			const dirParts = parsed.dir.replace(parsed.root, '').split(path.sep).filter(Boolean);
			parts.push(...dirParts);
		}

		if (parsed.base) {
			parts.push(parsed.base);
		}

		return parts.length ? parts : ['.'];
	}

	public get isAbsolute(): boolean {
		return path.isAbsolute(this.#path);
	}

	public joinpath(...other: PathLike[]): Path {
		return new Path(this.#path, ...other);
	}

	public div(...other: PathLike[]): Path {
		return this.joinpath(...other);
	}

	public withName(name: string): Path {
		return this.parent.joinpath(name);
	}

	public withSuffix(suffix: string): Path {
		if (suffix && !suffix.startsWith('.')) {
			suffix = '.' + suffix;
		}

		return this.parent.joinpath(this.stem + suffix);
	}

	public withStem(stem: string): Path {
		return this.parent.joinpath(stem + this.suffix);
	}

	public async resolve(): Promise<Path> {
		const resolved = await fs.realpath(this.#path);
		return new Path(resolved);
	}

	public resolveSync(): Path {
		const resolved = fsSync.realpathSync(this.#path);
		return new Path(resolved);
	}

	public absolute(): Path {
		return new Path(path.resolve(this.#path));
	}

	public relativeTo(other: PathLike): Path {
		const relative = path.relative(other.toString(), this.#path);
		return new Path(relative);
	}

	public expandUser(): Path {
		let expanded = this.#path;
		if (expanded.startsWith('~/') || expanded === '~') {
			expanded = expanded.replace(/^~/, os.homedir());
		}

		return new Path(expanded);
	}

	public normalizeCaseAware(): string {
		const normalized = path.normalize(path.resolve(this.#path));
		if (process.platform === 'win32') {
			return normalized.toLowerCase();
		}

		return normalized;
	}

	public equals(other: PathLike): boolean {
		return this.normalizeCaseAware() === Path.from(other).normalizeCaseAware();
	}

	public isSubPathOf(parent: PathLike): boolean {
		const parentPath = Path.from(parent).absolute();
		const selfPath = this.absolute();
		const relative = path.relative(parentPath.toString(), selfPath.toString());
		return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
	}

	public contains(other: PathLike): boolean {
		return Path.from(other).isSubPathOf(this);
	}

	public async exists(): Promise<boolean> {
		try {
			await fs.access(this.#path);
			return true;
		} catch {
			return false;
		}
	}

	public existsSync(): boolean {
		try {
			fsSync.accessSync(this.#path);
			return true;
		} catch {
			return false;
		}
	}

	public async isFile(): Promise<boolean> {
		try {
			const stats = await fs.stat(this.#path);
			return stats.isFile();
		} catch {
			return false;
		}
	}

	public isFileSync(): boolean {
		try {
			const stats = fsSync.statSync(this.#path);
			return stats.isFile();
		} catch {
			return false;
		}
	}

	public async isDir(): Promise<boolean> {
		try {
			const stats = await fs.stat(this.#path);
			return stats.isDirectory();
		} catch {
			return false;
		}
	}

	public isDirSync(): boolean {
		try {
			const stats = fsSync.statSync(this.#path);
			return stats.isDirectory();
		} catch {
			return false;
		}
	}

	public async isSymlink(): Promise<boolean> {
		try {
			const stats = await fs.lstat(this.#path);
			return stats.isSymbolicLink();
		} catch {
			return false;
		}
	}

	public isSymlinkSync(): boolean {
		try {
			const stats = fsSync.lstatSync(this.#path);
			return stats.isSymbolicLink();
		} catch {
			return false;
		}
	}

	public async stat(): Promise<fsSync.Stats> {
		return await fs.stat(this.#path);
	}

	public statSync(): fsSync.Stats {
		return fsSync.statSync(this.#path);
	}

	public async lstat(): Promise<fsSync.Stats> {
		return await fs.lstat(this.#path);
	}

	public lstatSync(): fsSync.Stats {
		return fsSync.lstatSync(this.#path);
	}

	public async readText(encoding: BufferEncoding = 'utf-8'): Promise<string> {
		return await fs.readFile(this.#path, encoding);
	}

	public readTextSync(encoding: BufferEncoding = 'utf-8'): string {
		return fsSync.readFileSync(this.#path, encoding);
	}

	public async readBytes(): Promise<Buffer> {
		return await fs.readFile(this.#path);
	}

	public readBytesSync(): Buffer {
		return fsSync.readFileSync(this.#path);
	}

	public async *readLines(encoding: BufferEncoding = 'utf-8'): AsyncIterableIterator<string> {
		const stream = fsSync.createReadStream(this.#path, { encoding });
		const lines = readline.createInterface({
			input: stream,
			crlfDelay: Infinity,
		});

		try {
			for await (const line of lines) {
				yield line;
			}
		} finally {
			lines.close();
		}
	}

	public *readLinesSync(encoding: BufferEncoding = 'utf-8'): IterableIterator<string> {
		const content = this.readTextSync(encoding);
		const lines = content.split(/\r?\n/);
		for (const line of lines) {
			yield line;
		}
	}

	public async writeText(data: string, encoding: BufferEncoding = 'utf-8'): Promise<void> {
		await fs.writeFile(this.#path, data, encoding);
	}

	public writeTextSync(data: string, encoding: BufferEncoding = 'utf-8'): void {
		fsSync.writeFileSync(this.#path, data, encoding);
	}

	public async writeBytes(data: Buffer | Uint8Array): Promise<void> {
		await fs.writeFile(this.#path, data);
	}

	public writeBytesSync(data: Buffer | Uint8Array): void {
		fsSync.writeFileSync(this.#path, data);
	}

	public async appendText(data: string, encoding: BufferEncoding = 'utf-8'): Promise<void> {
		await fs.appendFile(this.#path, data, encoding);
	}

	public appendTextSync(data: string, encoding: BufferEncoding = 'utf-8'): void {
		fsSync.appendFileSync(this.#path, data, encoding);
	}

	public async readJson<T = unknown>(options: ReadJsonOptions = {}): Promise<T> {
		const text = await this.readText(options.encoding || 'utf-8');
		return JSON.parse(text, options.reviver) as T;
	}

	public readJsonSync<T = unknown>(options: ReadJsonOptions = {}): T {
		const text = this.readTextSync(options.encoding || 'utf-8');
		return JSON.parse(text, options.reviver) as T;
	}

	public async writeJson(data: unknown, options: WriteJsonOptions = {}): Promise<void> {
		const serialized = stringifyJson(data, options.replacer, options.space ?? 2);
		await this.writeText(serialized, options.encoding || 'utf-8');
	}

	public writeJsonSync(data: unknown, options: WriteJsonOptions = {}): void {
		const serialized = stringifyJson(data, options.replacer, options.space ?? 2);
		this.writeTextSync(serialized, options.encoding || 'utf-8');
	}

	public async writeTextAtomic(data: string, options: WriteTextAtomicOptions = {}): Promise<void> {
		await this.ensureParentDir();
		const tempPath = this.parent.joinpath(
			`${options.tmpPrefix || '.tmp'}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
		);

		try {
			await tempPath.writeText(data, options.encoding || 'utf-8');
			await fs.rename(tempPath.toString(), this.#path);
		} finally {
			if (await tempPath.exists()) {
				await tempPath.remove();
			}
		}
	}

	public writeTextAtomicSync(data: string, options: WriteTextAtomicOptions = {}): void {
		this.ensureParentDirSync();
		const tempPath = this.parent.joinpath(
			`${options.tmpPrefix || '.tmp'}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
		);

		try {
			tempPath.writeTextSync(data, options.encoding || 'utf-8');
			fsSync.renameSync(tempPath.toString(), this.#path);
		} finally {
			if (tempPath.existsSync()) {
				tempPath.removeSync();
			}
		}
	}

	public async writeJsonAtomic(data: unknown, options: WriteJsonOptions & WriteTextAtomicOptions = {}): Promise<void> {
		const serialized = stringifyJson(data, options.replacer, options.space ?? 2);
		await this.writeTextAtomic(serialized, options);
	}

	public writeJsonAtomicSync(data: unknown, options: WriteJsonOptions & WriteTextAtomicOptions = {}): void {
		const serialized = stringifyJson(data, options.replacer, options.space ?? 2);
		this.writeTextAtomicSync(serialized, options);
	}

	public async mkdir(options: { recursive?: boolean; mode?: number } = { recursive: true }): Promise<void> {
		await fs.mkdir(this.#path, options);
	}

	public mkdirSync(options: { recursive?: boolean; mode?: number } = { recursive: true }): void {
		fsSync.mkdirSync(this.#path, options);
	}

	public async ensureDir(mode?: number): Promise<Path> {
		await this.mkdir({ recursive: true, mode });
		return this;
	}

	public ensureDirSync(mode?: number): Path {
		this.mkdirSync({ recursive: true, mode });
		return this;
	}

	public async ensureParentDir(mode?: number): Promise<Path> {
		return await this.parent.ensureDir(mode);
	}

	public ensureParentDirSync(mode?: number): Path {
		return this.parent.ensureDirSync(mode);
	}

	public async ensureFile(): Promise<Path> {
		await this.ensureParentDir();
		if (!await this.exists()) {
			await this.writeText('');
		}
		return this;
	}

	public ensureFileSync(): Path {
		this.ensureParentDirSync();
		if (!this.existsSync()) {
			this.writeTextSync('');
		}
		return this;
	}

	public async rmdir(): Promise<void> {
		await fs.rmdir(this.#path);
	}

	public rmdirSync(): void {
		fsSync.rmdirSync(this.#path);
	}

	public async unlink(): Promise<void> {
		await fs.unlink(this.#path);
	}

	public unlinkSync(): void {
		fsSync.unlinkSync(this.#path);
	}

	public async remove(): Promise<void> {
		await fs.rm(this.#path, { recursive: true, force: true });
	}

	public removeSync(): void {
		fsSync.rmSync(this.#path, { recursive: true, force: true });
	}

	public async *iterdir(): AsyncIterableIterator<Path> {
		const entries = await fs.readdir(this.#path);
		for (const entry of entries) {
			yield this.joinpath(entry);
		}
	}

	public *iterdirSync(): IterableIterator<Path> {
		const entries = fsSync.readdirSync(this.#path);
		for (const entry of entries) {
			yield this.joinpath(entry);
		}
	}

	public async listdir(): Promise<Path[]> {
		const result: Path[] = [];
		for await (const entry of this.iterdir()) {
			result.push(entry);
		}

		return result;
	}

	public listdirSync(): Path[] {
		return Array.from(this.iterdirSync());
	}

	public async *glob(pattern: string, options: AsyncGlobOptions = {} as AsyncGlobOptions): AsyncIterableIterator<Path> {
		const fullPattern = this.joinpath(pattern).toString();
		for await (const match of fs.glob(fullPattern, options)) {
			yield new Path(match);
		}
	}

	public async globList(pattern: string, options: AsyncGlobOptions = {} as AsyncGlobOptions): Promise<Path[]> {
		const result = [] as Path[];
		for await (const entry of this.glob(pattern, options)) {
			result.push(entry);
		}

		return result;
	}

	public *globSync(pattern: string, options: SyncGlobOptions = {} as SyncGlobOptions): IterableIterator<Path> {
		const fullPattern = this.joinpath(pattern).toString();
		for (const match of fsSync.globSync(fullPattern, options)) {
			yield new Path(match);
		}
	}

	public globListSync(pattern: string, options: SyncGlobOptions = {} as SyncGlobOptions): Path[] {
		return Array.from(this.globSync(pattern, options));
	}

	public async *rglob(pattern: string, options: AsyncGlobOptions = {} as AsyncGlobOptions): AsyncIterableIterator<Path> {
		yield* this.glob(`**/${pattern}`, options);
	}

	public *rglobSync(pattern: string, options: SyncGlobOptions = {} as SyncGlobOptions): IterableIterator<Path> {
		yield* this.globSync(`**/${pattern}`, options);
	}

	public async *walk(options: WalkOptions = {}): AsyncIterableIterator<[Path, Path[], Path[]]> {
		yield* this.walkInternal(options, 0, new Set<string>());
	}

	private async *walkInternal(
		options: WalkOptions,
		depth: number,
		visited: Set<string>
	): AsyncIterableIterator<[Path, Path[], Path[]]> {
		if (typeof options.maxDepth === 'number' && depth > options.maxDepth) {
			return;
		}

		const resolvedCurrent = this.absolute().normalizeCaseAware();
		if (visited.has(resolvedCurrent)) {
			return;
		}
		visited.add(resolvedCurrent);

		const includeDirs = options.includeDirs ?? true;
		const dirs: Path[] = [];
		const traversableDirs: Path[] = [];
		const files: Path[] = [];

		const entries = await fs.readdir(this.#path, { withFileTypes: true });
		for (const entry of entries) {
			const entryPath = this.joinpath(entry.name);
			if (options.filter && !await options.filter(entryPath, entry, depth)) {
				continue;
			}

			if (entry.isDirectory()) {
				traversableDirs.push(entryPath);
				if (includeDirs) {
					dirs.push(entryPath);
				}
				continue;
			}

			if (entry.isSymbolicLink()) {
				if (options.followSymlinks) {
					try {
						const stats = await fs.stat(entryPath.toString());
						if (stats.isDirectory()) {
							traversableDirs.push(entryPath);
							if (includeDirs) {
								dirs.push(entryPath);
							}
							continue;
						}
					} catch {
						// Fall through and treat as file.
					}
				}

				files.push(entryPath);
				continue;
			}

			if (entry.isFile()) {
				files.push(entryPath);
				continue;
			}

			try {
				const stats = await fs.lstat(entryPath.toString());
				if (stats.isDirectory()) {
					traversableDirs.push(entryPath);
					if (includeDirs) {
						dirs.push(entryPath);
					}
				} else {
					files.push(entryPath);
				}
			} catch {
				files.push(entryPath);
			}
		}

		yield [this, dirs, files];

		for (const dir of traversableDirs) {
			yield* dir.walkInternal(options, depth + 1, visited);
		}
	}

	public async rename(target: PathLike): Promise<Path> {
		const targetPath = new Path(target);
		await fs.rename(this.#path, targetPath.toString());
		return targetPath;
	}

	public renameSync(target: PathLike): Path {
		const targetPath = new Path(target);
		fsSync.renameSync(this.#path, targetPath.toString());
		return targetPath;
	}

	public async copyFile(target: PathLike, flags?: number): Promise<void> {
		await fs.copyFile(this.#path, target.toString(), flags);
	}

	public copyFileSync(target: PathLike, flags?: number): void {
		fsSync.copyFileSync(this.#path, target.toString(), flags);
	}

	public async copy(target: PathLike, options?: fsSync.CopyOptions): Promise<Path> {
		const targetPath = Path.from(target);
		await fs.cp(this.#path, targetPath.toString(), options);
		return targetPath;
	}

	public copySync(target: PathLike, options?: fsSync.CopySyncOptions): Path {
		const targetPath = Path.from(target);
		fsSync.cpSync(this.#path, targetPath.toString(), options);
		return targetPath;
	}

	public async move(target: PathLike, options: MoveOptions = {}): Promise<Path> {
		const targetPath = Path.from(target);
		const overwrite = options.overwrite ?? false;
		if (overwrite && await targetPath.exists()) {
			await targetPath.remove();
		}

		try {
			await fs.rename(this.#path, targetPath.toString());
		} catch (error) {
			const nodeError = error as NodeJS.ErrnoException;
			if (nodeError.code !== 'EXDEV') {
				throw error;
			}

			await this.copy(targetPath, { force: overwrite, recursive: true });
			await this.remove();
		}

		return targetPath;
	}

	public moveSync(target: PathLike, options: MoveOptions = {}): Path {
		const targetPath = Path.from(target);
		const overwrite = options.overwrite ?? false;
		if (overwrite && targetPath.existsSync()) {
			targetPath.removeSync();
		}

		try {
			fsSync.renameSync(this.#path, targetPath.toString());
		} catch (error) {
			const nodeError = error as NodeJS.ErrnoException;
			if (nodeError.code !== 'EXDEV') {
				throw error;
			}

			this.copySync(targetPath, { force: overwrite, recursive: true });
			this.removeSync();
		}

		return targetPath;
	}

	public async replace(target: PathLike): Promise<Path> {
		const targetPath = Path.from(target);
		if (await targetPath.exists()) {
			await targetPath.remove();
		}
		return await this.move(targetPath, { overwrite: true });
	}

	public replaceSync(target: PathLike): Path {
		const targetPath = Path.from(target);
		if (targetPath.existsSync()) {
			targetPath.removeSync();
		}
		return this.moveSync(targetPath, { overwrite: true });
	}

	public async symlink(target: PathLike): Promise<void> {
		await fs.symlink(target.toString(), this.#path);
	}

	public symlinkSync(target: PathLike): void {
		fsSync.symlinkSync(target.toString(), this.#path);
	}

	public async ensureSymlink(target: PathLike, options: EnsureSymlinkOptions = {}): Promise<Path> {
		const targetPath = Path.from(target);
		const replace = options.replace ?? true;
		if (await this.exists()) {
			if (!replace) {
				return this;
			}
			await this.remove();
		}

		await this.ensureParentDir();
		await fs.symlink(targetPath.toString(), this.#path, options.type);
		return this;
	}

	public ensureSymlinkSync(target: PathLike, options: EnsureSymlinkOptions = {}): Path {
		const targetPath = Path.from(target);
		const replace = options.replace ?? true;
		if (this.existsSync()) {
			if (!replace) {
				return this;
			}
			this.removeSync();
		}

		this.ensureParentDirSync();
		fsSync.symlinkSync(targetPath.toString(), this.#path, options.type);
		return this;
	}

	public async readlink(): Promise<Path> {
		const target = await fs.readlink(this.#path);
		return new Path(target);
	}

	public readlinkSync(): Path {
		const target = fsSync.readlinkSync(this.#path);
		return new Path(target);
	}

	public async chmod(mode: number): Promise<void> {
		await fs.chmod(this.#path, mode);
	}

	public chmodSync(mode: number): void {
		fsSync.chmodSync(this.#path, mode);
	}

	public async chown(uid: number, gid: number): Promise<void> {
		await fs.chown(this.#path, uid, gid);
	}

	public chownSync(uid: number, gid: number): void {
		fsSync.chownSync(this.#path, uid, gid);
	}

	public async touch(): Promise<void> {
		const exists = await this.exists();
		if (!exists) {
			await fs.writeFile(this.#path, '');
		} else {
			const now = new Date();
			await fs.utimes(this.#path, now, now);
		}
	}

	public touchSync(): void {
		const exists = this.existsSync();
		if (!exists) {
			fsSync.writeFileSync(this.#path, '');
		} else {
			const now = new Date();
			fsSync.utimesSync(this.#path, now, now);
		}
	}

	public toWriteStream(options?: Parameters<typeof fsSync.createWriteStream>[1]): fsSync.WriteStream {
		return fsSync.createWriteStream(this.#path, options);
	}

	public toString(): string {
		return this.#path;
	}

	public valueOf(): string {
		return this.#path;
	}

	public [Symbol.toPrimitive](_hint: string) {
		return this.#path;
	}

	public match(pattern: string): boolean {
		const minimatch = (inputPattern: string, str: string): boolean => {
			const regexPattern = inputPattern
				.replace(/\./g, '\\.')
				.replace(/\*/g, '.*')
				.replace(/\?/g, '.');
			const regex = new RegExp(`^${regexPattern}$`);
			return regex.test(str);
		};

		return minimatch(pattern, this.name);
	}

	public toUri(): string {
		return pathToFileURL(this.absolute().toString()).href;
	}
}
