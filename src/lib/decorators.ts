function hashArgs(args: any[]): string {
	const seen = new WeakMap<object, number>();
	let counter = 0;

	function hash(value: any) {
		const type = typeof value;

		if (value === null || type === 'number' || type === 'string' || type === 'boolean') {
			return value;
		}

		if (type === 'undefined') {
			return 'undefined';
		}

		if (type === 'function') {
			return `function:${value.name || 'anon'}`;
		}

		if (value instanceof Date) {
			return `date:${value.toISOString()}`;
		}

		if (value instanceof RegExp) {
			return `regexp:${value.toString()}`;
		}

		if (Array.isArray(value)) {
			return value.map(hash);
		}

		if (value instanceof Map) {
			return {
				map: [...value.entries()].map(([k, v]) => [hash(k), hash(v)])
			};
		}

		if (value instanceof Set) {
			return {
				set: [...value.values()].map(hash).sort()
			};
		}

		if (typeof value === 'object') {
			if (seen.has(value)) {
				return { ref: seen.get(value) };
			}

			seen.set(value, counter++);

			const entries = Object.entries(value)
				.sort(([a], [b]) => (a < b ? -1 : 1))
				.map(([k, v]) => [k, hash(v)]);

			return { obj: entries };
		}

		return value;
	}

	return JSON.stringify(args.map(hash));
}

/**
 * Creates a method decorator that caches the return value of the method for the specified
 * {@link ttlMs|time to live} in milliseconds.
 *
 * @param ttlMs How long the cached value should be returned after its last call in milliseconds.
 */
export function cache(ttlMs: number) {
	return function <T extends object>(
		method: (this: T, ...args: any[]) => any,
		_ctx: ClassMethodDecoratorContext<T>
	) {
		const instanceCache = new WeakMap<object, Map<string, { value: any; expiry: number }>>();

		return async function (this: T, ...args: any[]) {
			const now = Date.now();

			let methodCache = instanceCache.get(this);
			if (!methodCache) {
				methodCache = new Map();
				instanceCache.set(this, methodCache);
			}

			const key   = hashArgs(args);
			const entry = methodCache.get(key);
			if (entry && entry.expiry > now) {
				return entry.value;
			}

			const result   = method.apply(this, args);
			const resolved = result instanceof Promise ? await result : result;

			methodCache.set(key, {
				value: resolved,
				expiry: now + ttlMs,
			});

			return resolved;
		};
	};
}
