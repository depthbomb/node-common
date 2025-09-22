import { stat, mkdir, access } from 'node:fs/promises';

/**
 * Returns `true` if the path exists, `false` otherwise.
 *
 * @param path Path to the file or directory
 */
export async function fileExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

/**
 * Returns `true` if the path exists and is a directory, `false` otherwise
 *
 * @param path Path to the directory
 */
export async function dirExists(path: string): Promise<boolean> {
	try {
		const stats = await stat(path);
		return stats.isDirectory();
	} catch {
		return false;
	}
}

/**
 * Creates a directory from a string.
 *
 * @param directory Directory to create
 */
export async function createDir(directory: string) : Promise<void>;
/**
 * Creates a directory from an array.
 *
 * @param directories Array of directories to create
 */
export async function createDir(directories: string[]) : Promise<void>;
/**
 * Creates a directory from a string or multiple directories from an array.
 *
 * @param directory Directory to create as a string or an array of directories to create
 */
export async function createDir(directory: string | string[]) : Promise<void> {
	if (Array.isArray(directory)) {
		for (const dir of directory) {
			if (!await fileExists(dir)) {
				await mkdir(dir, { recursive: true });
			}
		}
	} else {
		if (!await fileExists(directory)) {
			await mkdir(directory, { recursive: true });
		}
	}
}
