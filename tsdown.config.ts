import { defineConfig } from 'tsdown';

export default defineConfig({
	clean: true,
	entry: [
		'src/**/*.ts'
	],
	format: ['cjs', 'esm'],
	dts: true,
	minify: true,
	skipNodeModulesBundle: true,
	target: 'node19',
	tsconfig: './tsconfig.json',
	unbundle: true
});
