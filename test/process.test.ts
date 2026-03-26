import { it, expect, describe } from 'vitest';
import { CancellationTokenSource, OperationCancelledError } from '../dist/cancellation.mjs';
import { which, whichSync, execProcess, captureProcess, ProcessExecutionError } from '../dist/process.mjs';

describe('process', () => {
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
});
