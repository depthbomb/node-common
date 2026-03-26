# node-common

A set of common utilities for Node.js that I use in my projects.

> [!IMPORTANT]
> As of version 2.0.0, a majority of the utilities in this package have been extracted out into the new [@depthbomb/common](https://npmjs.com/package/@depthbomb/common) package. This package will continue to receive Node.js-only utilities.

---

## Modules

### `cancellation`

Cancellation primitives for long-running async work, with AbortSignal interop.

Exports:
- `CancellationToken`
- `CancellationTokenSource`
- `CancellationTokenUtils`
- `CancellableOperation`
- `OperationCancelledError`
- `TimeoutError`

Key APIs:
- `CancellationToken.fromAbortSignal(signal)`
- `token.onCancellationRequested(callback)`
- `token.wrap(() => promise)` / `token.raceMany(promises)` / `token.toPromise()`
- `token.isCancellationError(error)`
- `source.toAbortController()`
- `CancellationTokenUtils.any(...tokens)` / `CancellationTokenUtils.all(...tokens)`
- `CancellationTokenUtils.throwIfCancelled(token)`
- `CancellationTokenUtils.withTimeout(promise, ms, token?, { timeoutError: true })`

Example:

```ts
import {
	CancellationToken,
	CancellationTokenSource,
	CancellationTokenUtils,
	TimeoutError,
} from '@depthbomb/node-common/cancellation';

const source = new CancellationTokenSource();
const controller = source.toAbortController();

const token = CancellationTokenUtils.any(
	source.token,
	CancellationToken.fromAbortSignal(controller.signal)
);

try {
	const result = await CancellationTokenUtils.withTimeout(
		token.wrap(() => fetch('https://example.com').then(r => r.text())),
		500,
		token,
		{ timeoutError: true }
	);
	console.log(result);
} catch (error) {
	if (error instanceof TimeoutError) {
		console.error('Timed out');
	}
}
```
