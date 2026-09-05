import { describe, expect, it } from 'vitest';
import { ApplicationLifecycle, ShutdownTimeoutError } from '../src/lifecycle';

describe('lifecycle', () => {
	it('shares the original shutdown promise during synchronous reentry', async () => {
		const lifecycle = new ApplicationLifecycle({
			signals: [],
		});
		const promises: Promise<void>[] = [];
		let calls = 0;
		lifecycle.token.register(() => {
			promises.push(lifecycle.requestShutdown('callback'));
		});
		lifecycle.onShutdown(() => {
			calls += 1;
			promises.push(lifecycle.requestShutdown('handler'));
		});

		const original = lifecycle.requestShutdown('original');
		await original;
		expect(calls).toBe(1);
		expect(promises).toEqual([original, original]);
		expect(lifecycle.shutdownReason).toBe('original');
	});

	it('runs shutdown handlers in reverse order and only once', async () => {
		const lifecycle = new ApplicationLifecycle({ signals: [] });
		const calls: number[] = [];

		lifecycle.onShutdown(() => { calls.push(1); });
		lifecycle.onShutdown(async () => { calls.push(2); });

		const first = lifecycle.requestShutdown('test');
		const second = lifecycle.requestShutdown('ignored');

		expect(first).toBe(second);
		await first;
		expect(calls).toEqual([2, 1]);
		expect(lifecycle.state).toBe('stopped');
		expect(lifecycle.shutdownReason).toBe('test');
		expect(lifecycle.token.isCancellationRequested).toBe(true);
	});

	it('supports unregistering handlers', async () => {
		const lifecycle = new ApplicationLifecycle({ signals: [] });
		let called = false;
		const registration = lifecycle.onShutdown(() => { called = true; });

		registration.unregister();
		registration.unregister();
		await lifecycle.requestShutdown();

		expect(called).toBe(false);
	});

	it('aggregates handler failures after running every handler', async () => {
		const lifecycle = new ApplicationLifecycle({ signals: [] });
		let completed = false;

		lifecycle.onShutdown(() => { throw new Error('first'); });
		lifecycle.onShutdown(() => { completed = true; });

		await expect(lifecycle.requestShutdown()).rejects.toBeInstanceOf(AggregateError);
		expect(completed).toBe(true);
	});

	it('still runs shutdown handlers when a cancellation callback fails', async () => {
		const lifecycle = new ApplicationLifecycle({ signals: [] });
		let cleanedUp = false;

		lifecycle.token.register(() => { throw new Error('cancellation failed'); });
		lifecycle.onShutdown(() => { cleanedUp = true; });

		await expect(lifecycle.requestShutdown()).rejects.toThrow('Cancellation callbacks failed');
		expect(cleanedUp).toBe(true);
		expect(lifecycle.state).toBe('stopped');
	});

	it('times out shutdown handlers', async () => {
		const lifecycle = new ApplicationLifecycle({ signals: [], shutdownTimeoutMs: 5 });

		lifecycle.onShutdown(() => new Promise<void>(() => {}));

		await expect(lifecycle.requestShutdown()).rejects.toBeInstanceOf(ShutdownTimeoutError);
		expect(lifecycle.state).toBe('stopped');
	});

	it('runs operations and cleans up on success and failure', async () => {
		const successful = new ApplicationLifecycle({ signals: [] });
		let successCleanup = false;
		successful.onShutdown(() => { successCleanup = true; });

		await expect(successful.run(async () => 42)).resolves.toBe(42);
		expect(successCleanup).toBe(true);

		const failed = new ApplicationLifecycle({ signals: [] });
		let failureCleanup = false;
		failed.onShutdown(() => { failureCleanup = true; });

		await expect(failed.run(async () => { throw new Error('operation failed'); })).rejects.toThrow('operation failed');
		expect(failureCleanup).toBe(true);
	});

	it('handles configured process signals and detaches listeners', async () => {
		const lifecycle = new ApplicationLifecycle({ signals: ['SIGUSR2'] });
		const listenerCount = process.listenerCount('SIGUSR2');
		lifecycle.start();

		expect(process.listenerCount('SIGUSR2')).toBe(listenerCount + 1);

		process.emit('SIGUSR2');
		await lifecycle.requestShutdown();

		expect(lifecycle.shutdownSignal).toBe('SIGUSR2');
		expect(process.listenerCount('SIGUSR2')).toBe(listenerCount);
	});

	it('validates timeout configuration', () => {
		expect(() => new ApplicationLifecycle({ shutdownTimeoutMs: -1 })).toThrow(RangeError);
	});
});
