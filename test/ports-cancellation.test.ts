import * as net from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { waitForPort } from '../src/ports';
import { CancellationToken, OperationCancelledError, TimeoutError } from '../src/cancellation';

vi.mock('node:net', async (importOriginal) => ({
	...await importOriginal<typeof net>(),
}));

afterEach(() => {
	vi.restoreAllMocks();
});

describe('port wait cancellation', () => {
	it('rejects cancellation during a successful connection', async () => {
		const controller = new AbortController();
		const server = net.createServer((socket) => {
			controller.abort('stop');
			socket.destroy();
		});
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		try {
			await expect(waitForPort((server.address() as net.AddressInfo).port, {
				signal: controller.signal,
			})).rejects.toBeInstanceOf(OperationCancelledError);
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});

	it('bounds hanging probes by the overall deadline', async () => {
		const socket = new net.Socket();
		vi.spyOn(net, 'createConnection').mockReturnValue(socket);
		await expect(waitForPort(1234, {
			timeoutMs: 10,
			connectTimeoutMs: 10_000,
		})).rejects.toBeInstanceOf(TimeoutError);
		expect(socket.destroyed).toBe(true);
	});

	it('honors the signal during delays even when a token is supplied', async () => {
		const controller = new AbortController();
		const socket = new net.Socket();
		vi.spyOn(net, 'createConnection').mockReturnValue(socket);
		const pending = waitForPort(1234, {
			token: CancellationToken.None,
			signal: controller.signal,
			timeoutMs: 20_000,
			intervalMs: 10_000,
		});
		const assertion = expect(pending).rejects.toBeInstanceOf(OperationCancelledError);
		socket.emit('error', new Error('refused'));
		await Promise.resolve();
		controller.abort();
		await assertion;
	});
});
