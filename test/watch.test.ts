import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CancellationTokenSource, OperationCancelledError } from '../src/cancellation';
import { watchPath } from '../src/watch';
import { TempDir } from '../src/temp';

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('watch', () => {
	it('reports the watched file itself when it changes', async () => {
		await (await TempDir.create()).use(async (root) => {
			const file = root.joinpath('watched.txt');
			await file.writeText('before');
			const cancellation = new CancellationTokenSource();
			const iterator = watchPath(file, {
				token: cancellation.token,
			});
			try {
				const pending = iterator.next();
				await file.appendText('after');
				const change = await pending;
				expect(change.value?.path.equals(file)).toBe(true);
				expect(change.value?.type).toBe('modify');
			} finally {
				cancellation.dispose();
				await iterator.return();
			}
		});
	});

	it('reports file creation with normalized paths', async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), 'node-common-watch-'));
		const cancellation = new CancellationTokenSource();

		try {
			const iterator = watchPath(root, { token: cancellation.token });
			const next = iterator.next();
			await delay(20);
			await writeFile(path.join(root, 'created.txt'), 'content');
			const result = await next;

			expect(result.done).toBe(false);
			expect(result.value?.path.name).toBe('created.txt');
			expect(['create', 'modify']).toContain(result.value?.type);

			await iterator.return?.();
		} finally {
			cancellation.dispose();
			await rm(root, { recursive: true, force: true });
		}
	});

	it('coalesces rapid events when debouncing', async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), 'node-common-watch-'));
		const cancellation = new CancellationTokenSource();

		try {
			const iterator = watchPath(root, { debounceMs: 30, token: cancellation.token });
			const next = iterator.next();
			await delay(20);
			const file = path.join(root, 'changed.txt');
			await writeFile(file, 'first');
			await writeFile(file, 'second');
			const result = await next;

			expect(result.value?.path.name).toBe('changed.txt');

			await iterator.return?.();
		} finally {
			cancellation.dispose();
			await rm(root, { recursive: true, force: true });
		}
	});

	it('cancels a pending watcher', async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), 'node-common-watch-'));
		const cancellation = new CancellationTokenSource();

		try {
			const iterator = watchPath(root, { token: cancellation.token });
			const next = iterator.next();
			await delay(10);
			cancellation.cancel('stop watching');

			await expect(next).rejects.toBeInstanceOf(OperationCancelledError);
		} finally {
			cancellation.dispose();
			await rm(root, { recursive: true, force: true });
		}
	});

	it('validates queue and debounce options', async () => {
		const iterator = watchPath('.', { maxQueue: 0 });

		await expect(iterator.next()).rejects.toBeInstanceOf(RangeError);
		await expect(watchPath('.', { debounceMs: -1 }).next()).rejects.toBeInstanceOf(RangeError);
	});
});
