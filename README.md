# node-common

A set of common utilities for Node.js that I use in my projects.

> [!IMPORTANT]
> As of version 2.0.0, a majority of the utilities in this package have been extracted out into the new [@depthbomb/common](https://npmjs.com/package/@depthbomb/common) package. This package will continue to receive Node.js-only utilities.

---

## Modules

### `appdirs`

Cross-platform config, cache, data, state, log, runtime, and temporary directories for Node applications.

```ts
import { ensureApplicationDirectories } from '@depthbomb/node-common/appdirs';

const directories = await ensureApplicationDirectories('my-tool');
await directories.config.joinpath('settings.json').writeJson({ enabled: true });
```

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

### `lockfile`

Advisory file locking for coordinating exclusive access to shared resources.

```ts
import { Lockfile } from '@depthbomb/node-common/lockfile';

const lock = await Lockfile.acquire('/tmp/my-resource.lock', {
	retries: 10,
	retryDelayMs: 50,
	staleMs: 60_000,
});

try {
	// exclusive work
} finally {
	await lock.release();
}
```

### `lifecycle`

Application shutdown coordination with OS signal handling, cancellation, LIFO cleanup, and bounded shutdown time.

```ts
import { ApplicationLifecycle } from '@depthbomb/node-common/lifecycle';

const lifecycle = new ApplicationLifecycle();
lifecycle.onShutdown(async () => {
	await server.close();
});

await lifecycle.run(async (token) => {
	await runService(token);
});
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

### `platform`

Runtime/platform detection helpers for Node/Bun environments.

```ts
import { getRuntimeInfo, assertRuntime } from '@depthbomb/node-common/platform';

assertRuntime(['node', 'bun']);

const info = getRuntimeInfo();

console.log(info.runtime);  // node | bun | unknown
console.log(info.version);  // runtime version when available
console.log(info.platform); // win32 | linux | darwin | ...
console.log(info.arch);     // x64 | arm64 | ...
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

Long-running and piped processes can use bounded capture, live line iteration, timeouts, and explicit tree termination:

```ts
import { spawnManaged } from '@depthbomb/node-common/process';

const managed = spawnManaged(process.execPath, ['worker.js'], {
	maxOutputBytes: 10 * 1024 * 1024,
	timeoutMs: 30_000,
});

for await (const line of managed.stdoutLines()) {
	console.log(line);
}

const result = await managed.result;
```

### `streams`

Bounded, cancellation-aware helpers for collecting streams, iterating lines, and running pipelines.

```ts
import { createReadStream } from 'node:fs';
import { collectStream, iterateLines } from '@depthbomb/node-common/streams';

const content = await collectStream(createReadStream('notes.txt'), {
	maxBytes: 10 * 1024 * 1024,
});

for await (const line of iterateLines(createReadStream('notes.txt'))) {
	console.log(line);
}
```

### `temp`

Helpers for creating temporary directories/files with explicit cleanup or scoped automatic cleanup.

```ts
import { createTempDir, createTempFile } from '@depthbomb/node-common/temp';

const tempDir = await createTempDir({ prefix: 'my-app-' });
await tempDir.path.joinpath('data.txt').writeText('value');
await tempDir.cleanup();

const tempFile = await createTempFile({ suffix: '.json' });
await tempFile.use(async (file) => {
	await file.writeText('{"ok":true}');
	// file is removed automatically when this callback finishes
});
```

### `watch`

Normalized, bounded filesystem change events exposed as a cancellation-aware async iterator.

```ts
import { watchPath } from '@depthbomb/node-common/watch';

for await (const change of watchPath('.', { recursive: true, debounceMs: 50 })) {
	console.log(change.type, change.path.toString());
}
```
