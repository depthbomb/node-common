import * as net from 'node:net';
import { describe, expect, it } from 'vitest';
import { CancellationTokenSource, OperationCancelledError, TimeoutError } from '../src/cancellation';
import { reserveSocketPath, reserveTcpPort, waitForPort, waitForPortClosed } from '../src/ports';

function connect(socketPath: string): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const socket = net.createConnection(socketPath);
		socket.once('connect', () => {
			socket.destroy();
			resolve();
		});
		socket.once('error', reject);
	});
}

describe('ports', () => {
	it('holds a TCP port until explicitly released', async () => {
		const reservation = await reserveTcpPort();

		await expect(waitForPort(reservation.port, { timeoutMs: 500 })).resolves.toBeUndefined();
		await expect(reserveTcpPort({ port: reservation.port })).rejects.toMatchObject({ code: 'EADDRINUSE' });

		const port = await reservation.releaseAndGetPort();

		expect(port).toBe(reservation.port);
		await expect(waitForPortClosed(port, { timeoutMs: 500 })).resolves.toBeUndefined();
	});

	it('reserves and cleans up a socket path', async () => {
		const reservation = await reserveSocketPath({ prefix: 'node-common-test' });

		await expect(connect(reservation.socketPath)).resolves.toBeUndefined();
		await reservation.release();
		await reservation.release();
	});

	it('supports cancellation while waiting', async () => {
		const reservation = await reserveTcpPort();
		const port = reservation.port;
		await reservation.release();

		const cancellation = new CancellationTokenSource();
		const pending = waitForPort(port, {
			intervalMs: 10,
			timeoutMs: 1_000,
			token: cancellation.token,
		});
		cancellation.cancel('stop waiting');

		await expect(pending).rejects.toBeInstanceOf(OperationCancelledError);
	});

	it('times out when the requested state is not reached', async () => {
		const reservation = await reserveTcpPort();

		try {
			await expect(waitForPortClosed(reservation.port, {
				intervalMs: 5,
				timeoutMs: 10,
			})).rejects.toBeInstanceOf(TimeoutError);
		} finally {
			await reservation.release();
		}
	});

	it('validates port and socket options', async () => {
		await expect(reserveTcpPort({ port: 70_000 })).rejects.toBeInstanceOf(RangeError);
		await expect(reserveSocketPath({ prefix: '../bad' })).rejects.toBeInstanceOf(TypeError);
	});
});
