import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ensureApplicationDirectories, getApplicationDirectories } from '../src/appdirs';

describe('appdirs', () => {
	it('maps Windows roaming and local directories', () => {
		const directories = getApplicationDirectories('example', {
			platform: 'win32',
			env: {
				APPDATA: 'C:\\Users\\test\\Roaming',
				LOCALAPPDATA: 'C:\\Users\\test\\Local',
			},
			homeDir: 'C:\\Users\\test',
			tempDir: 'C:\\Temp',
		});

		expect(directories.config.toString()).toBe(path.join('C:\\Users\\test\\Roaming', 'example'));
		expect(directories.cache.toString()).toBe(path.join('C:\\Users\\test\\Local', 'example', 'Cache'));
		expect(directories.logs.toString()).toBe(path.join('C:\\Users\\test\\Local', 'example', 'Logs'));
	});

	it('maps macOS library directories', () => {
		const directories = getApplicationDirectories('com.example.app', {
			platform: 'darwin',
			homeDir: '/Users/test',
			tempDir: '/tmp',
		});

		expect(directories.data.toString()).toBe(path.join('/Users/test', 'Library', 'Application Support', 'com.example.app'));
		expect(directories.cache.toString()).toBe(path.join('/Users/test', 'Library', 'Caches', 'com.example.app'));
	});

	it('honors absolute XDG paths and ignores relative ones', () => {
		const directories = getApplicationDirectories('example', {
			platform: 'linux',
			env: {
				XDG_CONFIG_HOME: '/custom/config',
				XDG_CACHE_HOME: 'relative-cache',
				XDG_RUNTIME_DIR: '/run/user/1000',
			},
			homeDir: '/home/test',
			tempDir: '/tmp',
		});

		expect(directories.config.toString()).toBe(path.join('/custom/config', 'example'));
		expect(directories.cache.toString()).toBe(path.join('/home/test', '.cache', 'example'));
		expect(directories.runtime.toString()).toBe(path.join('/run/user/1000', 'example'));
	});

	it('creates every application directory', async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), 'node-common-appdirs-'));

		try {
			const directories = await ensureApplicationDirectories('example', {
				platform: 'linux',
				env: {},
				homeDir: path.join(root, 'home'),
				tempDir: path.join(root, 'temp'),
			});

			for (const directory of Object.values(directories)) {
				await expect(directory.isDir()).resolves.toBe(true);
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it('rejects application names that can escape their directory', () => {
		expect(() => getApplicationDirectories('../escape')).toThrow(TypeError);
		expect(() => getApplicationDirectories('')).toThrow(TypeError);
	});
});
