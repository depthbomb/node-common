export type RuntimeName = 'node' | 'bun' | 'unknown';

export type RuntimeInfo = {
	runtime: RuntimeName;
	version: string | undefined;
	platform: NodeJS.Platform | undefined;
	arch: NodeJS.Architecture | undefined;
	isNode: boolean;
	isBun: boolean;
	isWindows: boolean;
	isLinux: boolean;
	isMac: boolean;
};

function hasProcessObject(): boolean {
	return typeof process !== 'undefined';
}

export function isNodeRuntime(): boolean {
	return hasProcessObject() && !!process.versions?.node && !isBunRuntime();
}

export function isBunRuntime(): boolean {
	return hasProcessObject() && !!(process.versions as NodeJS.ProcessVersions & { bun?: string }).bun;
}

export function getRuntimeName(): RuntimeName {
	if (isBunRuntime()) return 'bun';
	if (isNodeRuntime()) return 'node';
	return 'unknown';
}

export function getRuntimeVersion(): string | undefined {
	if (isBunRuntime()) {
		return (process.versions as NodeJS.ProcessVersions & { bun?: string }).bun;
	}

	if (isNodeRuntime()) {
		return process.versions.node;
	}

	return undefined;
}

export function getRuntimeInfo(): RuntimeInfo {
	const runtime = getRuntimeName();
	const platform = hasProcessObject() ? process.platform : undefined;
	const arch = hasProcessObject() ? process.arch : undefined;

	return {
		runtime,
		version: getRuntimeVersion(),
		platform,
		arch,
		isNode: runtime === 'node',
		isBun: runtime === 'bun',
		isWindows: platform === 'win32',
		isLinux: platform === 'linux',
		isMac: platform === 'darwin',
	};
}

export function assertRuntime(expected: RuntimeName | readonly RuntimeName[]): void {
	const actual = getRuntimeName();
	const allowed = Array.isArray(expected) ? expected : [expected];
	if (allowed.includes(actual)) {
		return;
	}

	throw new Error(`Unsupported runtime: ${actual}. Expected one of: ${allowed.join(', ')}`);
}

export const platform = hasProcessObject() ? process.platform : undefined;
export const arch     = hasProcessObject() ? process.arch : undefined;
