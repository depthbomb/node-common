import { CancellationTokenSource } from './cancellation.js';
import type { CancellationToken } from './cancellation.js';

export type LifecycleState = 'idle' | 'running' | 'shutting-down' | 'stopped';

export type ShutdownContext = {
	reason: string;
	signal?: NodeJS.Signals;
	token: CancellationToken;
};

export type ShutdownHandler = (context: ShutdownContext) => void | Promise<void>;

export type ShutdownRegistration = {
	unregister(): void;
};

export type ApplicationLifecycleOptions = {
	signals?: readonly NodeJS.Signals[];
	shutdownTimeoutMs?: number;
	secondSignal?: 'ignore' | 'force-exit';
};

export class ShutdownTimeoutError extends Error {
	public readonly timeoutMs: number;

	constructor(timeoutMs: number) {
		super(`Application shutdown exceeded ${timeoutMs}ms`);
		this.name = 'ShutdownTimeoutError';
		this.timeoutMs = timeoutMs;
	}
}

const DEFAULT_SIGNALS = ['SIGINT', 'SIGTERM'] as const;

function validateTimeout(timeoutMs: number | undefined): void {
	if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs < 0)) {
		throw new RangeError('shutdownTimeoutMs must be a finite non-negative number');
	}
}

export class ApplicationLifecycle {
	public readonly token: CancellationToken;

	private stateValue: LifecycleState = 'idle';
	private readonly source = new CancellationTokenSource();
	private readonly handlers: ShutdownHandler[] = [];
	private readonly signalListeners = new Map<NodeJS.Signals, () => void>();
	private readonly options: Required<ApplicationLifecycleOptions>;
	private shutdownPromise?: Promise<void>;
	private shutdownReasonValue?: string;
	private shutdownSignalValue?: NodeJS.Signals;

	public constructor(options: ApplicationLifecycleOptions = {}) {
		validateTimeout(options.shutdownTimeoutMs);

		this.options = {
			signals: options.signals ?? DEFAULT_SIGNALS,
			shutdownTimeoutMs: options.shutdownTimeoutMs ?? 10_000,
			secondSignal: options.secondSignal ?? 'ignore',
		};
		this.token = this.source.token;
	}

	public get state(): LifecycleState {
		return this.stateValue;
	}

	public get shutdownReason(): string | undefined {
		return this.shutdownReasonValue;
	}

	public get shutdownSignal(): NodeJS.Signals | undefined {
		return this.shutdownSignalValue;
	}

	public start(): this {
		if (this.stateValue === 'stopped') {
			throw new Error('Application lifecycle has already stopped');
		}

		if (this.stateValue !== 'idle') {
			return this;
		}

		this.stateValue = 'running';
		for (const signal of new Set(this.options.signals)) {
			const listener = () => this.handleSignal(signal);
			this.signalListeners.set(signal, listener);
			process.on(signal, listener);
		}

		return this;
	}

	public onShutdown(handler: ShutdownHandler): ShutdownRegistration {
		if (this.stateValue === 'shutting-down' || this.stateValue === 'stopped') {
			throw new Error('Cannot register a shutdown handler after shutdown has started');
		}

		this.handlers.push(handler);
		let registered = true;

		return {
			unregister: () => {
				if (!registered) {
					return;
				}

				registered = false;
				const index = this.handlers.indexOf(handler);
				if (index !== -1) {
					this.handlers.splice(index, 1);
				}
			},
		};
	}

	public requestShutdown(reason: string = 'Shutdown requested', signal?: NodeJS.Signals): Promise<void> {
		if (this.shutdownPromise) {
			return this.shutdownPromise;
		}

		this.shutdownReasonValue = reason;
		this.shutdownSignalValue = signal;
		this.stateValue = 'shutting-down';
		let resolve!: () => void;
		let reject!: (error: unknown) => void;
		this.shutdownPromise = new Promise<void>((onResolve, onReject) => {
			resolve = onResolve;
			reject  = onReject;
		});
		void this.performShutdown({
			reason,
			signal,
			token: this.token,
		}).then(resolve, reject);

		return this.shutdownPromise;
	}

	public async run<T>(operation: (token: CancellationToken) => Promise<T>): Promise<T> {
		this.start();

		try {
			const result = await operation(this.token);

			await this.requestShutdown('Application completed');

			return result;
		} catch (error) {
			try {
				await this.requestShutdown('Application failed');
			} catch (shutdownError) {
				throw new AggregateError(
					[error, shutdownError],
					'Application and shutdown both failed',
					{ cause: shutdownError }
				);
			}

			throw error;
		}
	}

	public async [Symbol.asyncDispose](): Promise<void> {
		await this.requestShutdown('Application lifecycle disposed');
	}

	private handleSignal(signal: NodeJS.Signals): void {
		if (this.stateValue === 'shutting-down') {
			if (this.options.secondSignal === 'force-exit') {
				this.detachSignalListeners();
				process.kill(process.pid, signal);
			}

			return;
		}

		void this.requestShutdown(`Received ${signal}`, signal).catch((error) => {
			queueMicrotask(() => {
				throw error;
			});
		});
	}

	private async performShutdown(context: ShutdownContext): Promise<void> {
		let cancellationError: unknown;
		try {
			this.source.cancel(context.reason);
		} catch (error) {
			cancellationError = error;
		}

		try {
			await this.runShutdownHandlers(context);
		} catch (shutdownError) {
			if (cancellationError !== undefined) {
				throw new AggregateError(
					[cancellationError, shutdownError],
					'Cancellation callbacks and shutdown handlers failed',
					{ cause: shutdownError }
				);
			}

			throw shutdownError;
		}

		if (cancellationError !== undefined) {
			throw cancellationError;
		}
	}

	private async runShutdownHandlers(context: ShutdownContext): Promise<void> {
		const timeoutMs = this.options.shutdownTimeoutMs;
		const cleanupSource = CancellationTokenSource.createWithTimeout(timeoutMs);
		let timeoutId: NodeJS.Timeout | undefined;
		const timeout = new Promise<never>((_resolve, reject) => {
			timeoutId = setTimeout(() => reject(new ShutdownTimeoutError(timeoutMs)), timeoutMs);
			timeoutId.unref();
		});
		const cleanup = this.executeHandlers({ ...context, token: cleanupSource.token });

		try {
			await Promise.race([cleanup, timeout]);
		} finally {
			if (timeoutId) {
				clearTimeout(timeoutId);
			}

			cleanupSource.dispose();
			this.handlers.length = 0;
			this.detachSignalListeners();
			this.stateValue = 'stopped';
		}
	}

	private async executeHandlers(context: ShutdownContext): Promise<void> {
		const errors: unknown[] = [];
		for (let index = this.handlers.length - 1; index >= 0; index -= 1) {
			try {
				await this.handlers[index](context);
			} catch (error) {
				errors.push(error);
			}
		}

		if (errors.length > 0) {
			throw new AggregateError(errors, 'Application shutdown handlers failed');
		}
	}

	private detachSignalListeners(): void {
		for (const [signal, listener] of this.signalListeners) {
			process.removeListener(signal, listener);
		}

		this.signalListeners.clear();
	}
}
