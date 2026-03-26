# node-common

A set of common utilities for Node.js that I use in my projects.

> [!IMPORTANT]
> As of version 2.0.0, a majority of the utilities in this package have been extracted out into the new [@depthbomb/common](https://npmjs.com/package/@depthbomb/common) package. This package will continue to receive Node.js-only utilities.

---

## Modules

### `cancellation`

Cancellation primitives for long-running async work, with AbortSignal interop.

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

### `pathlib`

`Path` is a Node-first path and filesystem helper with async/sync methods for common file and directory workflows.

```ts
import { Path } from '@depthbomb/node-common/pathlib';

const root = Path.cwd().joinpath('tmp-demo');
await root.mkdir();

const file = root.joinpath('notes.txt');
await file.writeText('hello');
await file.appendText('\nworld');

for await (const line of file.readLines()) {
	console.log(line);
}

const txtFiles = await root.globList('*.txt');
console.log(txtFiles.map((entry) => entry.name));

for await (const [current, dirs, files] of root.walk()) {
	console.log(current.toString(), dirs.length, files.length);
}

const uri = file.toUri();
const fromUri = Path.fromUri(uri);
console.log(fromUri.equals(file)); // true
```

### `process`

Process helpers for spawning commands, capturing output, executable lookup, and cancellation-aware execution.

```ts
import {
	captureProcess,
	execProcess,
	whichSync,
} from '@depthbomb/node-common/process';
import { CancellationTokenSource } from '@depthbomb/node-common/cancellation';

const nodePath = whichSync('node');
console.log(nodePath);

const output = await captureProcess(process.execPath, ['-e', 'console.log("hello")']);
console.log(output.stdout.trim()); // hello

const source = new CancellationTokenSource();
const pending = execProcess(
	process.execPath,
	['-e', 'setTimeout(() => console.log("done"), 5000)'],
	{ token: source.token }
);
source.cancel('stop');
await pending;
```
