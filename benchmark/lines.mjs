import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const { iterateLines, spawnManaged } = await import(pathToFileURL(resolve(process.argv[2] ?? 'dist', 'index.mjs')).href);
const samples = 7;
const chunk   = Buffer.alloc(65_536, 120);
const short   = Buffer.from(`${'x'.repeat(63)}\n`.repeat(1024));

async function measure(name, operation) {
	await operation();
	const times = [];
	for (let sample = 0; sample < samples; sample += 1) {
		const start = performance.now();
		await operation();
		times.push(performance.now() - start);
	}

	times.sort((a, b) => a - b);
	console.log(JSON.stringify({
		name,
		medianMs: times[Math.floor(samples / 2)],
	}));
}

for (const mib of [1, 4, 16]) {
	await measure(`iterateLines long ${mib} MiB`, async () => {
		let length = 0;
		for await (const line of iterateLines(Readable.from(Array.from({ length: mib * 16 }, () => chunk)))) {
			length += line.length;
		}

		if (length !== mib * 1_048_576) {
			throw new Error('Incorrect long-line output');
		}
	});
}

await measure('iterateLines short 1 MiB', async () => {
	let count = 0;
	for await (const line of iterateLines(Readable.from(Array.from({ length: 16 }, () => short)))) {
		if (line.length !== 63) {
			throw new Error('Incorrect short-line output');
		}

		count += 1;
	}

	if (count !== 16_384) {
		throw new Error('Missing short lines');
	}
});

await measure('managed long 8 MiB', async () => {
	const managed = spawnManaged(process.execPath, ['-e', 'process.stdout.write("x".repeat(8 * 1048576))'], {
		maxOutputBytes: 16 * 1_048_576,
		windowsHide: true,
	});
	let length = 0;
	for await (const line of managed.stdoutLines()) {
		length += line.length;
	}

	const output = await managed.result;
	if (!output.ok || length !== 8 * 1_048_576 || output.stdout.length !== length) {
		throw new Error('Incorrect managed output');
	}
});
