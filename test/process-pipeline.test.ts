import * as childProcess from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { execPipeline, ProcessPipelineError, spawnPipeline, spawnManaged } from '../src/process';
import { CancellationToken, OperationCancelledError } from '../src/cancellation';

vi.mock('node:child_process', async (importOriginal) => ({
	...await importOriginal<typeof childProcess>(),
}));

afterEach(() => {
	vi.restoreAllMocks();
});

describe('pipeline failure cleanup', () => {
	it('does not spawn managed work with an already-cancelled token', () => {
		const spawn = vi.spyOn(childProcess, 'spawn');
		expect(() => spawnManaged(process.execPath, [], {
			token: CancellationToken.Cancelled,
		})).toThrow(OperationCancelledError);
		expect(spawn).not.toHaveBeenCalled();
	});

	it.each(['missing', 'invalid', 'nonzero'])('reaps siblings after %s failure', async (failure) => {
		const children: childProcess.ChildProcess[] = [];
		const original = childProcess.spawn;
		vi.spyOn(childProcess, 'spawn').mockImplementation(((...args: Parameters<typeof original>) => {
			const child = original(...args);
			children.push(child);

			return child;
		}) as typeof original);
		const pending = execPipeline([
			{
				command: failure === 'missing' ? 'node-common-missing-command' : process.execPath,
				args: ['-e', 'process.exit(7)'],
				options: {
					maxQueuedLines: failure === 'invalid' ? 0 : 10,
				},
			},
			{
				command: process.execPath,
				args: ['-e', 'setInterval(() => {}, 1000)'],
				options: {
					forceKillAfterMs: 20,
				},
			},
		]);

		await expect(pending).rejects.toBeInstanceOf(failure === 'nonzero' ? ProcessPipelineError : Error);
		expect(children[0].exitCode !== null || children[0].signalCode !== null).toBe(true);
		expect(children[0].stdout?.destroyed).toBe(true);
	});

	it('cleans up synchronous spawnPipeline construction failures', async () => {
		const original = childProcess.spawn;
		let closed!: Promise<void>;
		vi.spyOn(childProcess, 'spawn').mockImplementation(((...args: Parameters<typeof original>) => {
			const child = original(...args);
			closed = new Promise<void>((resolve) => child.once('close', () => resolve()));

			return child;
		}) as typeof original);

		expect(() => spawnPipeline([
			{
				command: '',
			},
			{
				command: process.execPath,
				args: ['-e', 'setInterval(() => {}, 1000)'],
			},
		])).toThrow();
		await closed;
	});
});
