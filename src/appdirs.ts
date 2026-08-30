import * as os from 'node:os';
import * as path from 'node:path';
import { Path } from './pathlib.js';

export type ApplicationDirectories = {
	config: Path;
	cache: Path;
	data: Path;
	state: Path;
	logs: Path;
	runtime: Path;
	temp: Path;
};

export type ApplicationDirectoryOptions = {
	platform?: NodeJS.Platform;
	env?: NodeJS.ProcessEnv;
	homeDir?: string;
	tempDir?: string;
	roaming?: boolean;
};

function validateApplicationName(applicationName: string): void {
	if (!applicationName || applicationName === '.' || applicationName === '..'
		|| applicationName.includes('/') || applicationName.includes('\\') || applicationName.includes('\0')) {
		throw new TypeError('applicationName must be a non-empty path segment');
	}
}

function absoluteEnvironmentPath(value: string | undefined, fallback: string): string {
	return value && path.isAbsolute(value) ? value : fallback;
}

function getWindowsDirectories(
	applicationName: string,
	options: Required<Pick<ApplicationDirectoryOptions, 'env' | 'homeDir' | 'tempDir' | 'roaming'>>
): ApplicationDirectories {
	const roamingBase = absoluteEnvironmentPath(
		options.env.APPDATA,
		path.join(options.homeDir, 'AppData', 'Roaming')
	);
	const localBase = absoluteEnvironmentPath(
		options.env.LOCALAPPDATA,
		path.join(options.homeDir, 'AppData', 'Local')
	);
	const localApplication = path.join(localBase, applicationName);

	return {
		config: new Path(options.roaming ? roamingBase : localBase, applicationName),
		cache: new Path(localApplication, 'Cache'),
		data: new Path(localApplication, 'Data'),
		state: new Path(localApplication, 'State'),
		logs: new Path(localApplication, 'Logs'),
		runtime: new Path(options.tempDir, applicationName, 'Runtime'),
		temp: new Path(options.tempDir, applicationName),
	};
}

function getMacDirectories(
	applicationName: string,
	options: Required<Pick<ApplicationDirectoryOptions, 'homeDir' | 'tempDir'>>
): ApplicationDirectories {
	const library = path.join(options.homeDir, 'Library');
	const data = new Path(library, 'Application Support', applicationName);

	return {
		config: new Path(library, 'Preferences', applicationName),
		cache: new Path(library, 'Caches', applicationName),
		data,
		state: data.joinpath('State'),
		logs: new Path(library, 'Logs', applicationName),
		runtime: new Path(options.tempDir, applicationName, 'Runtime'),
		temp: new Path(options.tempDir, applicationName),
	};
}

function getXdgDirectories(
	applicationName: string,
	options: Required<Pick<ApplicationDirectoryOptions, 'env' | 'homeDir' | 'tempDir'>>
): ApplicationDirectories {
	const configBase = absoluteEnvironmentPath(options.env.XDG_CONFIG_HOME, path.join(options.homeDir, '.config'));
	const cacheBase = absoluteEnvironmentPath(options.env.XDG_CACHE_HOME, path.join(options.homeDir, '.cache'));
	const dataBase = absoluteEnvironmentPath(options.env.XDG_DATA_HOME, path.join(options.homeDir, '.local', 'share'));
	const stateBase = absoluteEnvironmentPath(options.env.XDG_STATE_HOME, path.join(options.homeDir, '.local', 'state'));
	const runtimeBase = absoluteEnvironmentPath(options.env.XDG_RUNTIME_DIR, path.join(options.tempDir, 'runtime'));
	const state = new Path(stateBase, applicationName);

	return {
		config: new Path(configBase, applicationName),
		cache: new Path(cacheBase, applicationName),
		data: new Path(dataBase, applicationName),
		state,
		logs: state.joinpath('log'),
		runtime: new Path(runtimeBase, applicationName),
		temp: new Path(options.tempDir, applicationName),
	};
}

export function getApplicationDirectories(
	applicationName: string,
	options: ApplicationDirectoryOptions = {}
): ApplicationDirectories {
	validateApplicationName(applicationName);

	const resolvedOptions = {
		platform: options.platform ?? process.platform,
		env: options.env ?? process.env,
		homeDir: options.homeDir ?? os.homedir(),
		tempDir: options.tempDir ?? os.tmpdir(),
		roaming: options.roaming ?? true,
	};

	if (resolvedOptions.platform === 'win32') {
		return getWindowsDirectories(applicationName, resolvedOptions);
	}

	if (resolvedOptions.platform === 'darwin') {
		return getMacDirectories(applicationName, resolvedOptions);
	}

	return getXdgDirectories(applicationName, resolvedOptions);
}

export async function ensureApplicationDirectories(
	applicationName: string,
	options: ApplicationDirectoryOptions = {}
): Promise<ApplicationDirectories> {
	const directories = getApplicationDirectories(applicationName, options);
	const uniqueDirectories = new Map<string, Path>();

	for (const directory of Object.values(directories)) {
		uniqueDirectories.set(directory.normalizeCaseAware(), directory);
	}

	await Promise.all([...uniqueDirectories.values()].map(async (directory) => {
		await directory.ensureDir(process.platform === 'win32' ? undefined : 0o700);
	}));

	return directories;
}
