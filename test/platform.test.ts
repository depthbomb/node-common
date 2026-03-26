import { it, expect, describe } from 'vitest';
import {
	arch,
	platform,
	isBunRuntime,
	assertRuntime,
	isNodeRuntime,
	getRuntimeInfo,
	getRuntimeName,
	getRuntimeVersion
} from '../dist/platform.mjs';

describe('platform', () => {
	it('reports runtime name and version', () => {
		const runtime = getRuntimeName();
		expect(['node', 'bun', 'unknown']).toContain(runtime);

		const version = getRuntimeVersion();
		if (runtime === 'node' || runtime === 'bun') {
			expect(typeof version).toBe('string');
			expect(version && version.length > 0).toBe(true);
		}
	});

	it('provides consolidated runtime info', () => {
		const info = getRuntimeInfo();
		expect(info.runtime).toBe(getRuntimeName());
		expect(info.platform).toBe(process.platform);
		expect(info.arch).toBe(process.arch);
		expect(info.isWindows || info.isLinux || info.isMac).toBe(true);
	});

	it('exposes platform/arch constants', () => {
		expect(platform).toBe(process.platform);
		expect(arch).toBe(process.arch);
	});

	it('assertRuntime passes and fails correctly', () => {
		expect(() => assertRuntime(getRuntimeName())).not.toThrow();
		expect(() => assertRuntime(['node', 'bun'])).not.toThrow();
		expect(() => assertRuntime('unknown')).toThrow();
	});

	it('isNodeRuntime and isBunRuntime are mutually exclusive in node tests', () => {
		expect(isNodeRuntime()).toBe(true);
		expect(isBunRuntime()).toBe(false);
	});
});
