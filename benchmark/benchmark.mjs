import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import { Readable } from 'node:stream';
import {
	ApplicationLifecycle,
	CancellationToken,
	Path,
	collectStream,
	getRuntimeInfo,
	whichSync,
} from '../dist/index.mjs';

const SAMPLE_COUNT = 9;

let benchmarkSink = 0;

function median(values) {
	const sorted = [...values].sort((left, right) => left - right);

	return sorted[Math.floor(sorted.length / 2)];
}

function formatRate(operationsPerSecond) {
	return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(operationsPerSecond);
}

async function measure(name, iterations, run) {
	await run(Math.max(1, Math.ceil(iterations / 10)));

	const durations = [];
	for (let sample = 0; sample < SAMPLE_COUNT; sample += 1) {
		const startedAt = performance.now();

		await run(iterations);

		durations.push(performance.now() - startedAt);
	}

	const durationMs = median(durations);
	const operationsPerSecond = iterations / (durationMs / 1_000);

	return { name, iterations, durationMs, operationsPerSecond };
}

function createFixture() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'node-common-benchmark-'));
	const searchDirectories = [];

	for (let directory = 0; directory < 24; directory += 1) {
		const directoryPath = path.join(root, `bin-${directory}`);
		fs.mkdirSync(directoryPath);
		searchDirectories.push(directoryPath);
	}

	const executablePath = path.join(searchDirectories.at(-1), 'benchmark-tool.CMD');
	fs.writeFileSync(executablePath, '@exit /b 0\r\n');

	const tree = path.join(root, 'tree');
	fs.mkdirSync(tree);
	for (let directory = 0; directory < 40; directory += 1) {
		const directoryPath = path.join(tree, `dir-${directory}`);
		fs.mkdirSync(directoryPath);
		for (let file = 0; file < 10; file += 1) {
			fs.writeFileSync(path.join(directoryPath, `file-${file}.txt`), 'benchmark data');
		}
	}

	return {
		cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
		envPath: searchDirectories.join(path.delimiter),
		tree: new Path(tree),
	};
}

async function main() {
	const fixture = createFixture();
	const basePath = new Path('workspace', 'packages', 'node-common', 'src', 'pathlib.ts');
	const results = [];

	try {
		results.push(await measure('Path construction', 500_000, (iterations) => {
			for (let index = 0; index < iterations; index += 1) {
				benchmarkSink += new Path('workspace', 'packages', `package-${index & 15}`, 'index.ts').toString().length;
			}
		}));

		results.push(await measure('Path joinpath', 500_000, (iterations) => {
			for (let index = 0; index < iterations; index += 1) {
				benchmarkSink += basePath.joinpath('nested', `file-${index & 15}.ts`).toString().length;
			}
		}));

		results.push(await measure('Path properties', 500_000, (iterations) => {
			for (let index = 0; index < iterations; index += 1) {
				benchmarkSink += basePath.name.length + basePath.stem.length + basePath.suffix.length;
			}
		}));

		results.push(await measure('Path match', 250_000, (iterations) => {
			for (let index = 0; index < iterations; index += 1) {
				benchmarkSink += basePath.match('path*.ts') ? 1 : 0;
			}
		}));

		results.push(await measure('getRuntimeInfo', 500_000, (iterations) => {
			for (let index = 0; index < iterations; index += 1) {
				benchmarkSink += getRuntimeInfo().isNode ? 1 : 0;
			}
		}));

		results.push(await measure('Cancellation register/unregister', 100_000, (iterations) => {
			const token = new CancellationToken();
			for (let index = 0; index < iterations; index += 1) {
				const registration = token.register(() => {});
				registration.unregister();
			}
		}));

		results.push(await measure('Cancellation dispatch (5 callbacks)', 20_000, (iterations) => {
			for (let index = 0; index < iterations; index += 1) {
				const token = new CancellationToken();
				for (let callback = 0; callback < 5; callback += 1) {
					token.register(() => { benchmarkSink += 1; });
				}
				token.cancel();
			}
		}));

		results.push(await measure('whichSync hit (24 PATH entries)', 2_000, (iterations) => {
			for (let index = 0; index < iterations; index += 1) {
				benchmarkSink += whichSync('benchmark-tool', {
					envPath: fixture.envPath,
					extensions: ['.CMD'],
				})?.length ?? 0;
			}
		}));

		results.push(await measure('Path walk (40 dirs, 400 files)', 20, async (iterations) => {
			for (let index = 0; index < iterations; index += 1) {
				for await (const [, directories, files] of fixture.tree.walk()) {
					benchmarkSink += directories.length + files.length;
				}
			}
		}));

		const streamChunk = Buffer.alloc(64 * 1024, 1);
		results.push(await measure('collectStream (1 MiB)', 50, async (iterations) => {
			for (let index = 0; index < iterations; index += 1) {
				const chunks = Array.from({ length: 16 }, () => streamChunk);
				const output = await collectStream(Readable.from(chunks), { encoding: null });
				benchmarkSink += output.length;
			}
		}));

		results.push(await measure('Lifecycle shutdown (5 handlers)', 10_000, async (iterations) => {
			for (let index = 0; index < iterations; index += 1) {
				const lifecycle = new ApplicationLifecycle({ signals: [] });
				for (let handler = 0; handler < 5; handler += 1) {
					lifecycle.onShutdown(() => { benchmarkSink += 1; });
				}
				await lifecycle.requestShutdown();
			}
		}));
	} finally {
		fixture.cleanup();
	}

	console.log(`Node ${process.version} on ${process.platform}/${process.arch}`);
	console.log(`Median of ${SAMPLE_COUNT} samples; higher throughput is better.\n`);
	for (const result of results) {
		console.log(`${result.name.padEnd(42)} ${formatRate(result.operationsPerSecond).padStart(14)} ops/s`);
	}

	if (benchmarkSink === Number.MIN_SAFE_INTEGER) {
		console.log('unreachable');
	}
}

await main();
