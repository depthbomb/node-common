import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { CancellationToken, OperationCancelledError } from './cancellation.js';
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
	const { encoding = 'utf-8', stdin, ...spawnOptions } = options;
	const child = spawnProcess(command, args, {
		...spawnOptions,
		stdio: 'pipe',
	});

	const stdoutChunks: string[] = [];
	const stderrChunks: string[] = [];

	if (child.stdout) {
		child.stdout.setEncoding(encoding);
		child.stdout.on('data', (chunk) => {
			stdoutChunks.push(chunk);
		});
	}

	if (child.stderr) {
		child.stderr.setEncoding(encoding);
		child.stderr.on('data', (chunk) => {
			stderrChunks.push(chunk);
		});
	}

	return await new Promise<ProcessOutput>((resolve, reject) => {
		let settled = false;
		const fail = (error: unknown) => {
			if (settled) return;
			settled = true;
			const nodeError = toNodeError(error);
			if (options.token?.isCancellationRequested || options.signal?.aborted || nodeError?.name === 'AbortError') {
				reject(new OperationCancelledError(options.token?.cancellationReason, options.token));
				return;
			}
			reject(error);
		};
		child.once('error', fail);
		child.stdin?.once('error', fail);
		if (child.stdin) child.stdin.end(stdin);

		child.once('close', (exitCode, exitSignal) => {
			if (settled) return;
			settled = true;
			resolve(buildOutput(command, args, child.pid, stdoutChunks.join(''), stderrChunks.join(''), exitCode, exitSignal));
		});
	});
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
