import * as os from 'node:os';
import * as path from 'node:path';
import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';

export type PathLike = string | Path;

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

	public get name(): string {
		return path.basename(this.#path);
	}

	public get suffix(): string {
		return path.extname(this.#path);
	}

	public get suffixes(): string[] {
		const name  = this.name;
		const parts = name.split('.');
		if (parts.length <= 1) {
			return [];
		}

		return parts.slice(1).map(s => '.' + s);
	}

	public get stem(): string {
		const name = this.name;
		const ext  = this.suffix;
		return ext ? name.slice(0, -ext.length) : name;
	}

	public get parent(): Path {
		return new Path(path.dirname(this.#path));
	}

	public get parents(): Path[] {
		const result = [] as Path[];
		let current  = this.parent;
		const root   = path.parse(this.#path).root;

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
		const parsed     = path.parse(normalized);
		const parts      = [] as string[];

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

	// eslint-disable-next-line no-undef
	public async readText(encoding: BufferEncoding = 'utf-8'): Promise<string> {
		return await fs.readFile(this.#path, encoding);
	}

	// eslint-disable-next-line no-undef
	public readTextSync(encoding: BufferEncoding = 'utf-8'): string {
		return fsSync.readFileSync(this.#path, encoding);
	}

	public async readBytes(): Promise<Buffer> {
		return await fs.readFile(this.#path);
	}

	public readBytesSync(): Buffer {
		return fsSync.readFileSync(this.#path);
	}

	// eslint-disable-next-line no-undef
	public async *readLines(encoding: BufferEncoding = 'utf-8'): AsyncIterableIterator<string> {
		const content = await this.readText(encoding);
		const lines   = content.split(/\r?\n/);
		for (const line of lines) {
			yield line;
		}
	}

	// eslint-disable-next-line no-undef
	public *readLinesSync(encoding: BufferEncoding = 'utf-8'): IterableIterator<string> {
		const content = this.readTextSync(encoding);
		const lines   = content.split(/\r?\n/);
		for (const line of lines) {
			yield line;
		}
	}

	// eslint-disable-next-line no-undef
	public async writeText(data: string, encoding: BufferEncoding = 'utf-8'): Promise<void> {
		await fs.writeFile(this.#path, data, encoding);
	}

	// eslint-disable-next-line no-undef
	public writeTextSync(data: string, encoding: BufferEncoding = 'utf-8'): void {
		fsSync.writeFileSync(this.#path, data, encoding);
	}

	public async writeBytes(data: Buffer | Uint8Array): Promise<void> {
		await fs.writeFile(this.#path, data);
	}

	public writeBytesSync(data: Buffer | Uint8Array): void {
		fsSync.writeFileSync(this.#path, data);
	}

	// eslint-disable-next-line no-undef
	public async appendText(data: string, encoding: BufferEncoding = 'utf-8'): Promise<void> {
		await fs.appendFile(this.#path, data, encoding);
	}

	// eslint-disable-next-line no-undef
	public appendTextSync(data: string, encoding: BufferEncoding = 'utf-8'): void {
		fsSync.appendFileSync(this.#path, data, encoding);
	}

	public async mkdir(options: { recursive?: boolean; mode?: number } = { recursive: true }): Promise<void> {
		await fs.mkdir(this.#path, options);
	}

	public mkdirSync(options: { recursive?: boolean; mode?: number } = { recursive: true }): void {
		fsSync.mkdirSync(this.#path, options);
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

	public async *glob(pattern: string): AsyncIterableIterator<Path> {
		const fullPattern = this.joinpath(pattern).toString();
		for await (const match of fs.glob(fullPattern)) {
			yield new Path(match);
		}
	}

	public async globList(pattern: string): Promise<Path[]> {
		const result = [] as Path[];
		for await (const entry of this.glob(pattern)) {
			result.push(entry);
		}

		return result;
	}

	public async *rglob(pattern: string): AsyncIterableIterator<Path> {
		yield* this.glob(`**/${pattern}`);
	}

	public async *walk(): AsyncIterableIterator<[Path, Path[], Path[]]> {
		const dirs  = [] as Path[];
		const files = [] as Path[];

		for await (const entry of this.iterdir()) {
			if (await entry.isDir()) {
				dirs.push(entry);
			} else {
				files.push(entry);
			}
		}

		yield [this, dirs, files];

		for (const dir of dirs) {
			yield* dir.walk();
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

	public async symlink(target: PathLike): Promise<void> {
		await fs.symlink(target.toString(), this.#path);
	}

	public symlinkSync(target: PathLike): void {
		fsSync.symlinkSync(target.toString(), this.#path);
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
		return this.toString();
	}

	public equals(other: PathLike): boolean {
		return path.normalize(this.#path) === path.normalize(other.toString());
	}

	public match(pattern: string): boolean {
		const minimatch = (pattern: string, str: string): boolean => {
			const regexPattern = pattern
				.replace(/\./g, '\\.')
				.replace(/\*/g, '.*')
				.replace(/\?/g, '.');
			const regex = new RegExp(`^${regexPattern}$`);
			return regex.test(str);
		};

		return minimatch(pattern, this.name);
	}

	public toUri(): string {
		const absolute = this.absolute();
		return 'file://' + absolute.toString();
	}

	public static from(...pathSegments: PathLike[]): Path {
		return new Path(...pathSegments);
	}

	public static fromUri(uri: string): Path {
		if (!uri.startsWith('file://')) {
			throw new Error('URI must start with file://');
		}
		return new Path(decodeURIComponent(uri.slice(7)));
	}
}
