import * as os from 'node:os';
import * as net from 'node:net';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { TimeoutError, OperationCancelledError } from './cancellation.js';
import type { PathLike } from './pathlib.js';
import type { CancellationToken } from './cancellation.js';

export type TcpPortReservationOptions = {
	host?: string;
	port?: number;
	ipv6Only?: boolean;
	backlog?: number;
	token?: CancellationToken;
	signal?: AbortSignal;
};

export type SocketPathReservationOptions = {
	dir?: PathLike;
	prefix?: string;
	token?: CancellationToken;
	signal?: AbortSignal;
};

export type WaitForPortOptions = {
	host?: string;
	timeoutMs?: number;
	intervalMs?: number;
	connectTimeoutMs?: number;
	token?: CancellationToken;
	signal?: AbortSignal;
};

type ReservationCancellation = {
	token?: CancellationToken;
	signal?: AbortSignal;
};

function validatePort(port: number): void {
	if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
		throw new RangeError('port must be an integer between 0 and 65535');
	}
}

function validateWaitOptions(options: WaitForPortOptions): void {
	for (const [label, value] of [
		['timeoutMs', options.timeoutMs],
		['intervalMs', options.intervalMs],
		['connectTimeoutMs', options.connectTimeoutMs],
	] as const) {
		if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
			throw new RangeError(`${label} must be a finite non-negative number`);
		}
	}
}

function throwIfCancelled(options: ReservationCancellation): void {
	options.token?.throwIfCancellationRequested();
	if (options.signal?.aborted) {
		throw new OperationCancelledError(String(options.signal.reason ?? 'AbortSignal was aborted'));
	}
}

function listen(server: net.Server, options: net.ListenOptions): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const onError = (error: Error) => {
			server.removeListener('listening', onListening);
			reject(error);
		};
		const onListening = () => {
			server.removeListener('error', onError);
			resolve();
		};

		server.once('error', onError);
		server.once('listening', onListening);
		server.listen(options);
	});
}

function close(server: net.Server): Promise<void> {
	if (!server.listening) {
		return Promise.resolve();
	}

	return new Promise<void>((resolve, reject) => {
		server.close((error) => error ? reject(error) : resolve());
	});
}

function delay(ms: number, options: ReservationCancellation): Promise<void> {
	throwIfCancelled(options);

	return new Promise<void>((resolve, reject) => {
		const finish = () => {
			clearTimeout(timeoutId);
			registration?.unregister();
			options.signal?.removeEventListener('abort', finish);
			try {
				throwIfCancelled(options);
				resolve();
			} catch (error) {
				reject(error);
			}
		};
		const timeoutId = setTimeout(finish, ms);
		const registration = options.token?.register(finish);
		options.signal?.addEventListener('abort', finish, {
			once: true,
		});
	});
}

function canConnect(
	host: string,
	port: number,
	timeoutMs: number,
	options: ReservationCancellation
): Promise<boolean> {
	throwIfCancelled(options);

	return new Promise<boolean>((resolve, reject) => {
		const socket = net.createConnection({
			host,
			port,
		});
		let settled = false;
		const finish = (connected: boolean) => {
			if (settled) {
				return;
			}

			settled = true;
			clearTimeout(timeoutId);
			registration?.unregister();
			options.signal?.removeEventListener('abort', onAbort);
			socket.destroy();
			try {
				throwIfCancelled(options);
				resolve(connected);
			} catch (error) {
				reject(error);
			}
		};
		const onAbort = () => finish(false);
		const timeoutId = setTimeout(onAbort, timeoutMs);
		const registration = options.token?.register(onAbort);
		options.signal?.addEventListener('abort', onAbort, {
			once: true,
		});
		socket.once('connect', () => finish(true));
		socket.once('error', () => finish(false));
	});
}

export class TcpPortReservation {
	public readonly server: net.Server;
	public readonly host: string;
	public readonly port: number;

	private readonly tokenRegistration?: ReturnType<CancellationToken['register']>;
	private readonly signal?: AbortSignal;
	private readonly abortListener?: () => void;
	private releasePromise?: Promise<void>;

	public constructor(server: net.Server, host: string, port: number, cancellation: ReservationCancellation) {
		this.server = server;
		this.host = host;
		this.port = port;
		this.tokenRegistration = cancellation.token?.register(() => { void this.release().catch(() => undefined); });
		this.signal = cancellation.signal;
		this.abortListener = () => { void this.release().catch(() => undefined); };

		if (cancellation.signal?.aborted) {
			this.abortListener();
		} else {
			cancellation.signal?.addEventListener('abort', this.abortListener, { once: true });
		}
	}

	public release(): Promise<void> {
		this.releasePromise ??= close(this.server).finally(() => this.cleanup());

		return this.releasePromise;
	}

	public async releaseAndGetPort(): Promise<number> {
		await this.release();

		return this.port;
	}

	public async [Symbol.asyncDispose](): Promise<void> {
		await this.release();
	}

	private cleanup(): void {
		this.tokenRegistration?.unregister();
		this.signal?.removeEventListener('abort', this.abortListener!);
	}
}

export class SocketPathReservation {
	public readonly server: net.Server;
	public readonly socketPath: string;

	private readonly tokenRegistration?: ReturnType<CancellationToken['register']>;
	private readonly signal?: AbortSignal;
	private readonly abortListener?: () => void;
	private releasePromise?: Promise<void>;

	public constructor(server: net.Server, socketPath: string, cancellation: ReservationCancellation) {
		this.server = server;
		this.socketPath = socketPath;
		this.tokenRegistration = cancellation.token?.register(() => { void this.release().catch(() => undefined); });
		this.signal = cancellation.signal;
		this.abortListener = () => { void this.release().catch(() => undefined); };

		if (cancellation.signal?.aborted) {
			this.abortListener();
		} else {
			cancellation.signal?.addEventListener('abort', this.abortListener, { once: true });
		}
	}

	public release(): Promise<void> {
		this.releasePromise ??= close(this.server)
			.then(async () => {
				if (process.platform !== 'win32') {
					await fs.rm(this.socketPath, { force: true });
				}
			})
			.finally(() => this.cleanup());

		return this.releasePromise;
	}

	public async [Symbol.asyncDispose](): Promise<void> {
		await this.release();
	}

	private cleanup(): void {
		this.tokenRegistration?.unregister();
		this.signal?.removeEventListener('abort', this.abortListener!);
	}
}

export async function reserveTcpPort(options: TcpPortReservationOptions = {}): Promise<TcpPortReservation> {
	const host = options.host ?? '127.0.0.1';
	const requestedPort = options.port ?? 0;
	validatePort(requestedPort);
	throwIfCancelled(options);

	const server = net.createServer((socket) => socket.destroy());

	try {
		await listen(server, {
			host,
			port: requestedPort,
			ipv6Only: options.ipv6Only,
			backlog: options.backlog,
			exclusive: true,
		});
	} catch (error) {
		await close(server).catch(() => undefined);
		throw error;
	}

	try {
		throwIfCancelled(options);
	} catch (error) {
		await close(server);
		throw error;
	}

	const address = server.address();
	if (!address || typeof address === 'string') {
		await close(server);
		throw new Error('TCP reservation did not produce an address');
	}

	return new TcpPortReservation(server, host, address.port, options);
}

export async function reserveSocketPath(
	options: SocketPathReservationOptions = {}
): Promise<SocketPathReservation> {
	throwIfCancelled(options);

	const prefix = options.prefix ?? 'node-common';
	if (!prefix || prefix.includes('/') || prefix.includes('\\') || prefix.includes('\0')) {
		throw new TypeError('prefix must be a non-empty path segment');
	}

	const socketPath = process.platform === 'win32'
		? `\\\\.\\pipe\\${prefix}-${randomUUID()}`
		: path.join(options.dir?.toString() ?? os.tmpdir(), `${prefix}-${randomUUID()}.sock`);
	const server = net.createServer((socket) => socket.destroy());

	try {
		await listen(server, { path: socketPath, exclusive: true });
	} catch (error) {
		await close(server).catch(() => undefined);
		throw error;
	}

	try {
		throwIfCancelled(options);
	} catch (error) {
		await close(server);
		if (process.platform !== 'win32') {
			await fs.rm(socketPath, { force: true });
		}
		throw error;
	}

	return new SocketPathReservation(server, socketPath, options);
}

export async function waitForPort(
	port: number,
	options: WaitForPortOptions = {}
): Promise<void> {
	await waitForPortState(port, true, options);
}

export async function waitForPortClosed(
	port: number,
	options: WaitForPortOptions = {}
): Promise<void> {
	await waitForPortState(port, false, options);
}

async function waitForPortState(
	port: number,
	expectedOpen: boolean,
	options: WaitForPortOptions
): Promise<void> {
	validatePort(port);
	validateWaitOptions(options);

	const host = options.host ?? '127.0.0.1';
	const timeoutMs = options.timeoutMs ?? 5_000;
	const intervalMs = options.intervalMs ?? 50;
	const connectTimeoutMs = options.connectTimeoutMs ?? Math.max(intervalMs, 50);
	const deadline = Date.now() + timeoutMs;

	while (true) {
		throwIfCancelled(options);

		const probeBudget = deadline - Date.now();
		if (probeBudget <= 0) {
			throw new TimeoutError(timeoutMs);
		}

		const open = await canConnect(host, port, Math.min(connectTimeoutMs, probeBudget), options);
		throwIfCancelled(options);

		if (Date.now() >= deadline) {
			throw new TimeoutError(timeoutMs);
		}

		if (open === expectedOpen) {
			return;
		}

		const remaining = deadline - Date.now();
		if (remaining <= 0) {
			throw new TimeoutError(timeoutMs);
		}

		await delay(Math.min(intervalMs, remaining), options);
	}
}
