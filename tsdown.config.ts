import { defineConfig } from 'tsdown';

export default defineConfig({
	clean: true,
	entry: [
		'src/**/*.ts'
	],
	format: ['cjs', 'esm'],
	dts: true,
	minify: true,
	deps: {
		neverBundle: true,
	},
	target: ['node22'],
	exports: false,
	tsconfig: './tsconfig.json'
});
