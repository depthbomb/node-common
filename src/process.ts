import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { CancellationToken, OperationCancelledError, TimeoutError } from './cancellation.js';
import type { ChildProcess, SpawnOptions } from 'node:child_process';

export type ProcessSignal = NodeJS.Signals | number;

export type ProcessOutput = {
	readonly command: string;
	readonly args: readonly string[];
	readonly pid: number | undefined;
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number | null;
	readonly signal: NodeJS.Signals | null;
	readonly ok: boolean;
};

export type SpawnProcessOptions = Omit<SpawnOptions, 'signal'> & {
	token?: CancellationToken;
	signal?: AbortSignal;
	killSignal?: ProcessSignal;
};

export type CaptureProcessOptions = SpawnProcessOptions & {
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	encoding?: BufferEncoding;
	stdin?: string | Buffer | Uint8Array;
	maxBufferBytes?: number;
};

export type ManagedProcessOptions = Omit<SpawnProcessOptions, 'stdio' | 'timeout'> & {
	encoding?: BufferEncoding;
	stdin?: string | Buffer | Uint8Array | null;
	maxOutputBytes?: number;
	maxQueuedLines?: number;
	timeoutMs?: number;
	forceKillAfterMs?: number;
	killTree?: boolean;
};

export type ProcessCommand = {
	command: string;
	args?: readonly string[];
	options?: Omit<ManagedProcessOptions, 'token' | 'signal'>;
};

export type ProcessPipelineOptions = {
	token?: CancellationToken;
	signal?: AbortSignal;
	stdin?: string | Buffer | Uint8Array;
};

export type WhichOptions = {
	cwd?: string;
	envPath?: string;
	extensions?: string[];
};

export class ProcessExecutionError extends Error {
	public readonly output: ProcessOutput;

	constructor(message: string, output: ProcessOutput) {
		super(message);
		this.name = 'ProcessExecutionError';
		this.output = output;
	}
}

export class ProcessOutputLimitError extends Error {
	public readonly stream: 'stdout' | 'stderr';
	public readonly limit: number;
	public readonly received: number;

	constructor(stream: 'stdout' | 'stderr', limit: number, received: number) {
		super(`Process ${stream} exceeded the ${limit}-byte limit`);
		this.name = 'ProcessOutputLimitError';
		this.stream = stream;
		this.limit = limit;
		this.received = received;
	}
}

export class ProcessPipelineError extends Error {
	public readonly outputs: readonly ProcessOutput[];

	constructor(outputs: readonly ProcessOutput[]) {
		super('One or more pipeline processes failed');
		this.name = 'ProcessPipelineError';
		this.outputs = outputs;
	}
}

function createAbortBridge(token?: CancellationToken, signal?: AbortSignal) {
	const controller = new AbortController();
	const registration = token?.register(() => controller.abort(token.cancellationReason));
	const onAbort = () => controller.abort(signal?.reason);
	if (signal) {
		if (signal.aborted) onAbort();
		else signal.addEventListener('abort', onAbort, { once: true });
	}
	return {
		signal: controller.signal,
		cleanup: () => {
			registration?.unregister();
			signal?.removeEventListener('abort', onAbort);
		},
	};
}

function toNodeError(error: unknown): NodeJS.ErrnoException | undefined {
	if (typeof error === 'object' && error !== null) {
		return error as NodeJS.ErrnoException;
	}

	return undefined;
}

function buildOutput(
	command: string,
	args: readonly string[],
	pid: number | undefined,
	stdout: string,
	stderr: string,
	exitCode: number | null,
	signal: NodeJS.Signals | null
): ProcessOutput {
	return {
		command,
		args,
		pid,
		stdout,
		stderr,
		exitCode,
		signal,
		ok: exitCode === 0,
	};
}

function quoteIfNeeded(segment: string): string {
	return /\s/.test(segment) ? `"${segment.replace(/"/g, '\\"')}"` : segment;
}

function isExecutable(filePath: string): boolean {
	try {
		if (!fs.statSync(filePath).isFile()) return false;
		fs.accessSync(filePath, fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

class BoundedLineQueue implements AsyncIterableIterator<string> {
	private readonly decoder: StringDecoder;
	private readonly values: string[] = [];
	private readonly waiters: Array<(result: IteratorResult<string>) => void> = [];
	private buffered = '';
	private ended = false;

	public constructor(encoding: BufferEncoding, private readonly maxQueuedLines: number) {
		this.decoder = new StringDecoder(encoding);
	}

	public [Symbol.asyncIterator](): AsyncIterableIterator<string> {
		return this;
	}

	public next(): Promise<IteratorResult<string>> {
		if (this.values.length > 0) {
			return Promise.resolve({ value: this.values.shift()!, done: false });
		}

		if (this.ended) {
			return Promise.resolve({ value: undefined, done: true });
		}

		return new Promise((resolve) => this.waiters.push(resolve));
	}

	public push(chunk: Buffer): void {
		this.buffered += this.decoder.write(chunk);

		let newlineIndex = this.buffered.indexOf('\n');
		while (newlineIndex !== -1) {
			const endIndex = newlineIndex > 0 && this.buffered[newlineIndex - 1] === '\r'
				? newlineIndex - 1
				: newlineIndex;
			this.enqueue(this.buffered.slice(0, endIndex));
			this.buffered = this.buffered.slice(newlineIndex + 1);
			newlineIndex = this.buffered.indexOf('\n');
		}
	}

	public end(): void {
		if (this.ended) {
			return;
		}

		this.buffered += this.decoder.end();
		if (this.buffered.length > 0) {
			this.enqueue(this.buffered);
		}

		this.ended = true;
		for (const waiter of this.waiters.splice(0)) {
			waiter({ value: undefined, done: true });
		}
	}

	private enqueue(line: string): void {
		const waiter = this.waiters.shift();
		if (waiter) {
			waiter({ value: line, done: false });

			return;
		}

		if (this.values.length >= this.maxQueuedLines) {
			this.values.shift();
		}

		this.values.push(line);
	}
}

function prepareManagedOptions(
	options: CaptureProcessOptions,
	timeoutOverride?: number
): ManagedProcessOptions {
	const managedOptions = { ...options };
	const maxOutputBytes = options.maxBufferBytes ?? Number.MAX_SAFE_INTEGER;
	const timeoutMs = timeoutOverride ?? options.timeout;

	Reflect.deleteProperty(managedOptions, 'maxBufferBytes');
	Reflect.deleteProperty(managedOptions, 'stdio');
	Reflect.deleteProperty(managedOptions, 'timeout');

	return {
		...managedOptions,
		maxOutputBytes,
		timeoutMs,
	};
}

export class ManagedProcess {
	public readonly child: ChildProcess;
	public readonly result: Promise<ProcessOutput>;

	private readonly stdoutChunks: Buffer[] = [];
	private readonly stderrChunks: Buffer[] = [];
	private readonly stdoutQueue: BoundedLineQueue;
	private readonly stderrQueue: BoundedLineQueue;
	private readonly encoding: BufferEncoding;
	private readonly maxOutputBytes: number;
	private readonly forceKillAfterMs: number;
	private readonly killTreeEnabled: boolean;
	private readonly tokenRegistration?: ReturnType<CancellationToken['register']>;
	private readonly externalSignal?: AbortSignal;
	private readonly externalAbortListener?: () => void;
	private timeoutId?: NodeJS.Timeout;
	private forceKillId?: NodeJS.Timeout;
	private failure?: Error;
	private stdoutBytes = 0;
	private stderrBytes = 0;

	public constructor(
		public readonly command: string,
		public readonly args: readonly string[],
		options: ManagedProcessOptions = {}
	) {
		const {
			encoding = 'utf-8',
			stdin,
			maxOutputBytes = 10 * 1024 * 1024,
			maxQueuedLines = 2_048,
			timeoutMs,
			forceKillAfterMs = 5_000,
			killTree = false,
			token,
			signal,
			killSignal,
			...spawnOptions
		} = options;

		if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 0) {
			throw new RangeError('maxOutputBytes must be a non-negative safe integer');
		}

		if (!Number.isSafeInteger(maxQueuedLines) || maxQueuedLines < 1) {
			throw new RangeError('maxQueuedLines must be a positive safe integer');
		}

		if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs < 0)) {
			throw new RangeError('timeoutMs must be a finite non-negative number');
		}

		if (!Number.isFinite(forceKillAfterMs) || forceKillAfterMs < 0) {
			throw new RangeError('forceKillAfterMs must be a finite non-negative number');
		}

		this.encoding = encoding;
		this.maxOutputBytes = maxOutputBytes;
		this.forceKillAfterMs = forceKillAfterMs;
		this.killTreeEnabled = killTree;
		this.stdoutQueue = new BoundedLineQueue(encoding, maxQueuedLines);
		this.stderrQueue = new BoundedLineQueue(encoding, maxQueuedLines);
		this.child = spawn(command, [...args], {
			...spawnOptions,
			detached: killTree && process.platform !== 'win32' ? true : spawnOptions.detached,
			killSignal: killSignal ?? 'SIGTERM',
			stdio: 'pipe',
		});

		this.child.stdout?.on('data', (chunk: Buffer) => this.captureChunk('stdout', chunk));
		this.child.stderr?.on('data', (chunk: Buffer) => this.captureChunk('stderr', chunk));
		this.child.stdout?.once('end', () => this.stdoutQueue.end());
		this.child.stderr?.once('end', () => this.stderrQueue.end());

		this.result = new Promise<ProcessOutput>((resolve, reject) => {
			this.child.once('error', (error) => {
				this.cleanup();
				reject(this.mapError(error, token, signal));
			});
			this.child.once('close', (exitCode, exitSignal) => {
				this.cleanup();
				if (this.failure) {
					reject(this.failure);

					return;
				}

				resolve(buildOutput(
					command,
					args,
					this.child.pid,
					Buffer.concat(this.stdoutChunks, this.stdoutBytes).toString(encoding),
					Buffer.concat(this.stderrChunks, this.stderrBytes).toString(encoding),
					exitCode,
					exitSignal
				));
			});
		});

		this.tokenRegistration = token?.register((cancelledToken) => {
			this.stopWithError(new OperationCancelledError(cancelledToken.cancellationReason, cancelledToken));
		});
		this.externalSignal = signal;
		this.externalAbortListener = () => {
			this.stopWithError(new OperationCancelledError(String(signal?.reason ?? 'AbortSignal was aborted')));
		};

		if (signal?.aborted) {
			this.externalAbortListener();
		} else {
			signal?.addEventListener('abort', this.externalAbortListener, { once: true });
		}

		if (timeoutMs !== undefined) {
			this.timeoutId = setTimeout(() => {
				this.stopWithError(new TimeoutError(timeoutMs));
			}, timeoutMs);
			this.timeoutId.unref();
		}

		this.child.stdin?.once('error', (error) => this.stopWithError(error));
		if (stdin !== null) {
			this.child.stdin?.end(stdin);
		}
	}

	public stdoutLines(): AsyncIterableIterator<string> {
		return this.stdoutQueue;
	}

	public stderrLines(): AsyncIterableIterator<string> {
		return this.stderrQueue;
	}

	public terminate(signal: ProcessSignal = 'SIGTERM'): boolean {
		return this.child.kill(signal);
	}

	public async terminateTree(signal: ProcessSignal = 'SIGTERM'): Promise<void> {
		if (!this.child.pid || this.child.exitCode !== null || this.child.signalCode !== null) {
			return;
		}

		if (process.platform !== 'win32') {
			if (this.child.spawnargs.length > 0 && this.killTreeEnabled) {
				try {
					process.kill(-this.child.pid, signal);
				} catch (error) {
					if (toNodeError(error)?.code !== 'ESRCH') {
						throw error;
					}
				}

				return;
			}

			this.child.kill(signal);

			return;
		}

		await new Promise<void>((resolve, reject) => {
			const killer = spawn('taskkill', ['/pid', String(this.child.pid), '/t', '/f'], {
				stdio: 'ignore',
				windowsHide: true,
			});
			killer.once('error', reject);
			killer.once('close', () => resolve());
		});
	}

	public async [Symbol.asyncDispose](): Promise<void> {
		if (this.child.exitCode === null && this.child.signalCode === null) {
			if (this.killTreeEnabled) {
				await this.terminateTree();
			} else {
				this.terminate();
			}
		}

		await this.result.catch(() => undefined);
	}

	private captureChunk(stream: 'stdout' | 'stderr', chunk: Buffer): void {
		const chunks = stream === 'stdout' ? this.stdoutChunks : this.stderrChunks;
		const queue = stream === 'stdout' ? this.stdoutQueue : this.stderrQueue;
		const received = stream === 'stdout'
			? this.stdoutBytes += chunk.length
			: this.stderrBytes += chunk.length;

		if (received > this.maxOutputBytes) {
			this.stopWithError(new ProcessOutputLimitError(stream, this.maxOutputBytes, received));

			return;
		}

		chunks.push(chunk);
		queue.push(chunk);
	}

	private stopWithError(error: Error): void {
		if (this.failure || this.child.exitCode !== null || this.child.signalCode !== null) {
			return;
		}

		this.failure = error;
		if (this.killTreeEnabled) {
			void this.terminateTree().catch(() => this.child.kill('SIGKILL'));
		} else {
			this.child.kill();
		}

		this.forceKillId = setTimeout(() => this.child.kill('SIGKILL'), this.forceKillAfterMs);
		this.forceKillId.unref();
	}

	private mapError(error: Error, token?: CancellationToken, signal?: AbortSignal): Error {
		if (this.failure) {
			return this.failure;
		}

		if (token?.isCancellationRequested) {
			return new OperationCancelledError(token.cancellationReason, token);
		}

		if (signal?.aborted) {
			return new OperationCancelledError(String(signal.reason ?? 'AbortSignal was aborted'));
		}

		return error;
	}

	private cleanup(): void {
		if (this.timeoutId) {
			clearTimeout(this.timeoutId);
		}

		if (this.forceKillId) {
			clearTimeout(this.forceKillId);
		}

		this.tokenRegistration?.unregister();
		this.externalSignal?.removeEventListener('abort', this.externalAbortListener!);
		this.stdoutQueue.end();
		this.stderrQueue.end();
	}
}

export function spawnManaged(
	command: string,
	args: readonly string[] = [],
	options: ManagedProcessOptions = {}
): ManagedProcess {
	return new ManagedProcess(command, args, options);
}

export function spawnPipeline(
	commands: readonly ProcessCommand[],
	options: ProcessPipelineOptions = {}
): ManagedProcess[] {
	if (commands.length < 2) {
		throw new RangeError('A process pipeline requires at least two commands');
	}

	const processes = new Array<ManagedProcess>(commands.length);
	for (let index = commands.length - 1; index >= 0; index -= 1) {
		const command = commands[index];
		const managedProcess = spawnManaged(command.command, command.args, {
			...command.options,
			token: options.token,
			signal: options.signal,
			stdin: index === 0 ? options.stdin : null,
		});
		processes[index] = managedProcess;

		if (index < commands.length - 1) {
			managedProcess.child.stdout?.pipe(processes[index + 1].child.stdin!);
		}
	}

	return processes;
}

export async function execPipeline(
	commands: readonly ProcessCommand[],
	options: ProcessPipelineOptions = {}
): Promise<ProcessOutput[]> {
	const processes = spawnPipeline(commands, options);
	const outputs = await Promise.all(processes.map((managedProcess) => managedProcess.result));
	if (outputs.some((output) => !output.ok)) {
		throw new ProcessPipelineError(outputs);
	}

	return outputs;
}

export async function execWithTimeout(
	command: string,
	args: readonly string[],
	timeoutMs: number,
	options: CaptureProcessOptions = {}
): Promise<ProcessOutput> {
	const output = await spawnManaged(command, args, prepareManagedOptions(options, timeoutMs)).result;

	if (output.ok) {
		return output;
	}

	const executable = [command, ...args.map((arg) => quoteIfNeeded(arg))].join(' ');

	throw new ProcessExecutionError(
		`Process exited with code ${output.exitCode ?? 'null'}: ${executable}`,
		output
	);
}

export function spawnProcess(
	command: string,
	args: readonly string[] = [],
	options: SpawnProcessOptions = {}
): ChildProcess {
	const { token, signal, killSignal, ...spawnOptions } = options;
	const bridge = createAbortBridge(token, signal);
	const child = spawn(command, [...args], {
		...spawnOptions,
		signal: bridge.signal,
		killSignal: killSignal ?? 'SIGTERM',
	});
	child.once('close', bridge.cleanup);
	child.once('error', bridge.cleanup);
	return child;
}

export async function captureProcess(
	command: string,
	args: readonly string[] = [],
	options: CaptureProcessOptions = {}
): Promise<ProcessOutput> {
	const managedProcess = spawnManaged(command, args, prepareManagedOptions(options));

	return await managedProcess.result;
}

export async function execProcess(
	command: string,
	args: readonly string[] = [],
	options: CaptureProcessOptions = {}
): Promise<ProcessOutput> {
	const output = await captureProcess(command, args, options);
	if (output.ok) {
		return output;
	}

	const executable = [command, ...args.map((arg) => quoteIfNeeded(arg))].join(' ');
	throw new ProcessExecutionError(
		`Process exited with code ${output.exitCode ?? 'null'}: ${executable}`,
		output
	);
}

export function whichSync(command: string, options: WhichOptions = {}): string | undefined {
	const cwd              = options.cwd || process.cwd();
	const envPath          = options.envPath || process.env.PATH || '';
	const pathEntries      = envPath.split(path.delimiter).filter(Boolean);
	const hasPathSeparator = command.includes(path.sep) || command.includes('/');

	const windows = os.platform() === 'win32';
	const defaultExtensions = windows
		? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';')
		: [''];
	const extensions = options.extensions || defaultExtensions;

	const hasKnownExtension = windows
		? extensions.some((ext) => command.toLowerCase().endsWith(ext.toLowerCase()))
		: true;
	const candidates = windows && !hasKnownExtension
		? extensions.map((ext) => `${command}${ext}`)
		: [command];

	const searchDirs = hasPathSeparator ? [''] : pathEntries;
	for (const dir of searchDirs) {
		for (const candidate of candidates) {
			const joined = dir ? path.join(dir, candidate) : candidate;
			const resolved = path.resolve(cwd, joined);
			if (!fs.existsSync(resolved)) {
				continue;
			}

			if (windows || isExecutable(resolved)) {
				return resolved;
			}
		}
	}

	return undefined;
}

export async function which(command: string, options: WhichOptions = {}): Promise<string | undefined> {
	const cwd = options.cwd ?? process.cwd();
	const envPath = options.envPath ?? process.env.PATH ?? '';
	const windows = os.platform() === 'win32';
	const extensions = options.extensions ?? (windows
		? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';')
		: ['']);
	const hasPathSeparator = command.includes(path.sep) || command.includes('/');
	const hasKnownExtension = !windows || extensions.some((ext) => command.toLowerCase().endsWith(ext.toLowerCase()));
	const candidates = windows && !hasKnownExtension ? extensions.map((ext) => `${command}${ext}`) : [command];
	const searchDirs = hasPathSeparator ? [''] : envPath.split(path.delimiter).filter(Boolean);

	for (const dir of searchDirs) {
		for (const candidate of candidates) {
			const resolved = path.resolve(cwd, dir ? path.join(dir, candidate) : candidate);
			try {
				const stats = await fs.promises.stat(resolved);
				if (!stats.isFile()) continue;
				if (!windows) await fs.promises.access(resolved, fs.constants.X_OK);
				return resolved;
			} catch { /* Try the next candidate. */ }
		}
	}
	return undefined;
}
