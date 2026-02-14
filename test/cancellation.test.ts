import { it, vi, expect, describe, afterEach } from 'vitest';
import {
	CancellationToken,
	CancellableOperation,
	CancellationTokenUtils,
	OperationCancelledError,
	CancellationTokenSource,
} from '../src/cancellation';

afterEach(() => {
	vi.useRealTimers();
});

describe('cancellation', () => {
	it('cancels token with reason and throws on request check', () => {
		const token = new CancellationToken();

		token.cancel('stop-now');

		expect(token.isCancellationRequested).toBe(true);
		expect(token.cancellationReason).toBe('stop-now');
		expect(token.cancellationTime).toBeInstanceOf(Date);
		expect(() => token.throwIfCancellationRequested()).toThrow(OperationCancelledError);
	});

	it('supports register and unregister behavior', () => {
		const token = new CancellationToken();
		const called = vi.fn();

		const registration = token.register(called);
		registration.unregister();
		token.cancel('done');

		expect(called).not.toHaveBeenCalled();
		expect(token.registrationCount).toBe(0);
	});

	it('invokes async registration when cancelled', async () => {
		const token = new CancellationToken();
		const done = vi.fn();

		const called = new Promise<void>((resolve) => {
			token.registerAsync(async () => {
				done();
				resolve();
			});
		});

		token.cancel('async');
		await called;
		expect(done).toHaveBeenCalledTimes(1);
	});

	it('resolves waitForCancellation when token is cancelled', async () => {
		const token = new CancellationToken();
		const waiting = token.waitForCancellation();

		token.cancel('waited');
		await expect(waiting).resolves.toBeUndefined();
	});

	it('supports race success and cancellation failure', async () => {
		const token = new CancellationToken();
		await expect(token.race(Promise.resolve('ok'))).resolves.toBe('ok');

		const cancelToken = new CancellationToken();
		const pending = cancelToken.race(
			new Promise<string>((resolve) => setTimeout(() => resolve('late'), 10_000))
		);
		cancelToken.cancel('stop');
		await expect(pending).rejects.toBeInstanceOf(OperationCancelledError);
	});

	it('aborts AbortSignal when token is cancelled', () => {
		const token = new CancellationToken();
		const signal = token.toAbortSignal();

		expect(signal.aborted).toBe(false);
		token.cancel('abort-signal');
		expect(signal.aborted).toBe(true);
	});

	it('cancels linked token when parent is cancelled', () => {
		const parent = new CancellationToken();
		const child = parent.createLinkedToken();

		parent.cancel('parent');
		expect(child.isCancellationRequested).toBe(true);
		expect(child.cancellationReason).toBe('Parent token cancelled');
	});

	it('supports cancelAfter and createWithTimeout', () => {
		vi.useFakeTimers();

		const source = new CancellationTokenSource();
		source.cancelAfter(100, 'later');
		vi.advanceTimersByTime(100);
		expect(source.isCancellationRequested).toBe(true);
		expect(source.token.cancellationReason).toBe('later');

		const timeoutSource = CancellationTokenSource.createWithTimeout(50);
		vi.advanceTimersByTime(50);
		expect(timeoutSource.isCancellationRequested).toBe(true);
	});

	it('supports createWithAbortSignal and combineTokens', () => {
		const controller = new AbortController();
		const source = CancellationTokenSource.createWithAbortSignal(controller.signal);
		controller.abort();
		expect(source.isCancellationRequested).toBe(true);

		const a = new CancellationToken();
		const b = new CancellationToken();
		const combined = CancellationTokenUtils.combineTokens(a, b);
		a.cancel('a');
		expect(combined.isCancellationRequested).toBe(true);
	});

	it('supports withTimeout and promisifyWithCancellation', async () => {
		vi.useFakeTimers();

		const slow = new Promise<string>((resolve) => setTimeout(() => resolve('late'), 10_000));
		const timed = CancellationTokenUtils.withTimeout(slow, 100);
		vi.advanceTimersByTime(100);
		await expect(timed).rejects.toBeInstanceOf(OperationCancelledError);

		const success = CancellationTokenUtils.promisifyWithCancellation<[number], number>((value, callback) => {
			callback(null, value + 1);
		});
		await expect(success(1)).resolves.toBe(2);
	});

	it('supports CancellableOperation completion and cancellation', async () => {
		vi.useFakeTimers();

		const complete = new CancellableOperation<number>(async (token) => {
			await token.delay(100);
			return 42;
		});
		const completePromise = complete.waitForCompletion();
		vi.advanceTimersByTime(100);
		await expect(completePromise).resolves.toBe(42);
		expect(complete.isCompletedOperation).toBe(true);

		const cancelled = new CancellableOperation<number>(async (token) => {
			await token.delay(1_000);
			return 99;
		});
		const cancelledPromise = cancelled.waitForCompletion();
		cancelled.cancel('stop-op');
		await expect(cancelledPromise).rejects.toBeInstanceOf(OperationCancelledError);
	});

	it('keeps CancellationToken.None immutable', () => {
		const none = CancellationToken.None;

		expect(none.canBeCancelled).toBe(false);
		expect(none.isCancellationRequested).toBe(false);

		none.cancel('should-not-apply');

		expect(none.isCancellationRequested).toBe(false);
		expect(none.cancellationReason).toBeUndefined();
	});

	it('passes a real token in cancellable wrapper', async () => {
		const wrapped = CancellationTokenUtils.cancellable(async (value: string, token: CancellationToken) => {
			return {
				value,
				isToken: token instanceof CancellationToken,
				isCancelled: token.isCancellationRequested,
			};
		});

		const result = await wrapped('abc');
		expect(result).toEqual({
			value: 'abc',
			isToken: true,
			isCancelled: false,
		});
	});

	it('does not retain registrations on pre-cancelled tokens', () => {
		const token = CancellationToken.Cancelled;
		const before = token.registrationCount;
		const registration = token.register(() => {});

		expect(before).toBe(0);
		expect(token.registrationCount).toBe(0);

		registration.unregister();
		expect(token.registrationCount).toBe(0);
	});

	it('detaches linked source callbacks after dispose', () => {
		const parent = new CancellationToken();
		const linked = CancellationTokenSource.createLinkedTokenSource(parent);

		linked.dispose();
		expect(() => parent.cancel('parent-cancelled')).not.toThrow();
	});

	it('clears delay timers on cancellation', async () => {
		vi.useFakeTimers();
		const token = new CancellationToken();

		const delayed = token.delay(10_000);
		expect(vi.getTimerCount()).toBe(1);

		token.cancel('stop');
		await expect(delayed).rejects.toBeInstanceOf(OperationCancelledError);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('removes child tracking after child cancellation', () => {
		const parent = new CancellationToken();
		const child = new CancellationToken({ parent });

		expect(parent.childrenCount).toBe(1);
		child.cancel('done');
		expect(parent.childrenCount).toBe(0);
	});
});
