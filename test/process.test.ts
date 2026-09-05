import { it, expect, describe } from 'vitest';
import { basename } from 'node:path';
import { TempDir } from '../src/temp';
import { CancellationTokenSource, OperationCancelledError, TimeoutError } from '../src/cancellation';
import {
	ProcessExecutionError,
	ProcessOutputLimitError,
	captureProcess,
	execPipeline,
	execProcess,
	execWithTimeout,
	spawnManaged,
	which,
	whichSync,
} from '../src/process';

describe('process', () => {
	it('agrees on directories and explicitly empty executable search paths', async () => {
		await (await TempDir.create()).use(async (root) => {
			const directory = await root.joinpath('fake.EXE').ensureDir();
			expect(whichSync(directory.toString())).toBeUndefined();
			expect(await which(directory.toString())).toBeUndefined();
			const options = {
				envPath: '',
			};
			expect(whichSync(basename(process.execPath), options)).toBeUndefined();
			expect(await which(basename(process.execPath), options)).toBeUndefined();
		});
	});

	it('captures stdout/stderr', async () => {
		const result = await captureProcess(
			process.execPath,
			['-e', 'console.log("out"); console.error("err");']
		);

		expect(result.ok).toBe(true);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain('out');
		expect(result.stderr).toContain('err');
	});

	it('sends EOF when stdin is omitted', async () => {
		const result = await captureProcess(process.execPath, [
			'-e',
			'process.stdin.resume(); process.stdin.on("end", () => console.log("eof"));',
		]);
		expect(result.stdout).toContain('eof');
	});

	it('throws ProcessExecutionError on non-zero exit', async () => {
		await expect(execProcess(process.execPath, ['-e', 'process.exit(5)']))
			.rejects.toBeInstanceOf(ProcessExecutionError);
	});

	it('finds executables with which and whichSync', async () => {
		const syncPath = whichSync(process.execPath);
		const asyncPath = await which(process.execPath);

		expect(syncPath).toBeDefined();
		expect(asyncPath).toBeDefined();
	});

	it('supports cancellation via token', async () => {
		const source = new CancellationTokenSource();
		const pending = captureProcess(
			process.execPath,
			['-e', 'setTimeout(() => console.log("done"), 5000)'],
			{ token: source.token }
		);

		setTimeout(() => source.cancel('stop-process'), 50);
		await expect(pending).rejects.toBeInstanceOf(OperationCancelledError);
	});

	it('manages bounded output and live line iteration', async () => {
		const managed = spawnManaged(process.execPath, ['-e', 'console.log("first"); console.log("second")']);
		const lines: string[] = [];

		for await (const line of managed.stdoutLines()) {
			lines.push(line);
		}

		const output = await managed.result;

		expect(lines).toEqual(['first', 'second']);
		expect(output.stdout).toBe('first\nsecond\n');

		await expect(spawnManaged(process.execPath, ['-e', 'process.stdout.write("12345")'], {
			maxOutputBytes: 4,
		}).result).rejects.toBeInstanceOf(ProcessOutputLimitError);
	});

	it('times out managed execution', async () => {
		await expect(execWithTimeout(
			process.execPath,
			['-e', 'setTimeout(() => {}, 1000)'],
			10
		)).rejects.toBeInstanceOf(TimeoutError);
	});

	it('runs shell-free process pipelines', async () => {
		const outputs = await execPipeline([
			{ command: process.execPath, args: ['-e', 'process.stdout.write("x".repeat(262144))'] },
			{
				command: process.execPath,
				args: ['-e', 'let size=0;process.stdin.on("data",c=>size+=c.length);process.stdin.on("end",()=>console.log(size))'],
			},
		]);

		expect(outputs).toHaveLength(2);
		expect(outputs[1].stdout.trim()).toBe('262144');
	});
});
