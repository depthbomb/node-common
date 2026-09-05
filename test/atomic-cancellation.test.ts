import { describe, expect, it, vi } from 'vitest';
import { getEventListeners } from 'node:events';
import { updateJsonAtomic, compareAndSwapFile, writeFileAtomic } from '../src/atomic';
import { CancellationToken, OperationCancelledError } from '../src/cancellation';
import { Lockfile } from '../src/lockfile';
import { TempDir } from '../src/temp';

describe('atomic cancellation', () => {
	it('detaches token and signal listeners after directory setup fails', async () => {
		await (await TempDir.create()).use(async (root) => {
			const parent = root.joinpath('file');
			await parent.writeText('not a directory');
			const token = new CancellationToken();
			const controller = new AbortController();
			await expect(writeFileAtomic(parent.joinpath('child'), 'data', {
				token,
				signal: controller.signal,
				preserveMode: false,
			})).rejects.toThrow();
			expect(token.registrationCount).toBe(0);
			expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
		});
	});

	it('never invokes an updater for an already-aborted signal', async () => {
		await (await TempDir.create()).use(async (root) => {
			const controller = new AbortController();
			controller.abort('stop');
			const updater = vi.fn(() => 1);
			await expect(updateJsonAtomic(root.joinpath('value'), updater, {
				signal: controller.signal,
			})).rejects.toBeInstanceOf(OperationCancelledError);
			expect(updater).not.toHaveBeenCalled();
			expect(await root.listdir()).toEqual([]);
		});
	});

	it.each(['update', 'swap'])('aborts %s during a lock retry with both cancellation inputs', async (operation) => {
		await (await TempDir.create()).use(async (root) => {
			const target = root.joinpath('value');
			const lock = await Lockfile.acquire(`${target}.lock`);
			const controller = new AbortController();
			const updater = vi.fn(() => 1);
			const options = {
				token: CancellationToken.None,
				signal: controller.signal,
				lock: {
					retries: 10,
					retryDelayMs: 10_000,
					token: CancellationToken.None,
				},
			};
			const pending = operation === 'update'
				? updateJsonAtomic(target, updater, options)
				: compareAndSwapFile(target, undefined, 'data', options);
			const assertion = expect(pending).rejects.toBeInstanceOf(OperationCancelledError);
			try {
				await new Promise((resolve) => setTimeout(resolve, 20));
				controller.abort('stop waiting');
				await assertion;
				expect(updater).not.toHaveBeenCalled();
				expect(await target.exists()).toBe(false);
			} finally {
				await lock.release();
			}
		});
	});
});
