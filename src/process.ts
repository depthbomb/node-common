import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { CancellationToken, CancellationTokenUtils, OperationCancelledError } from './cancellation';
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

function combineToken(token?: CancellationToken, signal?: AbortSignal): CancellationToken | undefined {
	if (token && signal) {
		return CancellationTokenUtils.any(token, CancellationToken.fromAbortSignal(signal));
	}

	if (token) return token;
	if (signal) return CancellationToken.fromAbortSignal(signal);
	return undefined;
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
	const combinedToken = combineToken(token, signal);

	return spawn(command, [...args], {
		...spawnOptions,
		signal: combinedToken?.toAbortSignal(),
		killSignal: killSignal ?? 'SIGTERM',
	});
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

	let stdout = '';
	let stderr = '';

	if (child.stdout) {
		child.stdout.setEncoding(encoding);
		child.stdout.on('data', (chunk) => {
			stdout += chunk;
		});
	}

	if (child.stderr) {
		child.stderr.setEncoding(encoding);
		child.stderr.on('data', (chunk) => {
			stderr += chunk;
		});
	}

	if (stdin !== undefined && child.stdin) {
		child.stdin.write(stdin);
		child.stdin.end();
	}

	const combinedToken = combineToken(options.token, options.signal);

	return await new Promise<ProcessOutput>((resolve, reject) => {
		child.on('error', (error) => {
			const nodeError = toNodeError(error);
			if (combinedToken?.isCancellationRequested || nodeError?.name === 'AbortError') {
				reject(new OperationCancelledError(combinedToken?.cancellationReason, combinedToken));
				return;
			}

			reject(error);
		});

		child.on('close', (exitCode, exitSignal) => {
			resolve(buildOutput(command, args, child.pid, stdout, stderr, exitCode, exitSignal));
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
	return whichSync(command, options);
}
