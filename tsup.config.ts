import { defineConfig } from 'tsup';

export default defineConfig(() => ({
	clean: true,
	entry: [
		'src/**/*.ts'
	],
	format: ['cjs', 'esm'],
	dts: true,
	minify: 'terser',
	skipNodeModulesBundle: true,
	target: 'node19',
	tsconfig: './tsconfig.json',
	splitting: false,
}));
