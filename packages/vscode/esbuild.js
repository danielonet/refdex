const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
	name: 'esbuild-problem-matcher',

	setup(build) {
		build.onStart(() => {
			console.log('[watch] build started');
		});
		build.onEnd((result) => {
			result.errors.forEach(({ text, location }) => {
				console.error(`✘ [ERROR] ${text}`);
				console.error(`    ${location.file}:${location.line}:${location.column}:`);
			});
			console.log('[watch] build finished');
		});
	},
};

/**
 * The RefDex daemon (packages/server) bundled into dist/daemon/refdex.cjs, with the tree-sitter
 * .wasm files beside it in dist/daemon/wasm/. The extension runs it with VS Code's own runtime.
 */
async function daemonContext() {
	const { WASM_MODULE_PATHS } = await import('@refdex/core');
	const wasmDir = path.join(__dirname, 'dist', 'daemon', 'wasm');
	fs.mkdirSync(wasmDir, { recursive: true });
	for (const [file, modulePath] of Object.entries(WASM_MODULE_PATHS)) {
		fs.copyFileSync(require.resolve(modulePath), path.join(wasmDir, file));
	}
	return esbuild.context({
		entryPoints: [require.resolve('@refdex/server/src/main.ts')],
		bundle: true,
		format: 'cjs',
		minify: production,
		sourcemap: !production,
		sourcesContent: false,
		platform: 'node',
		target: 'node22',
		outfile: 'dist/daemon/refdex.cjs',
		// web-tree-sitter and @refdex/core use import.meta.url; shim it for CJS.
		define: { 'import.meta.url': '__import_meta_url' },
		banner: { js: "const __import_meta_url = require('node:url').pathToFileURL(__filename).href;" },
		logLevel: 'silent',
		plugins: [esbuildProblemMatcherPlugin],
	});
}

async function main() {
	const daemon = await daemonContext();
	const ctx = await esbuild.context({
		entryPoints: [
			'src/extension.ts'
		],
		bundle: true,
		format: 'cjs',
		minify: production,
		sourcemap: !production,
		sourcesContent: false,
		platform: 'node',
		outfile: 'dist/extension.js',
		external: ['vscode'],
		logLevel: 'silent',
		plugins: [
			/* add to the end of plugins array */
			esbuildProblemMatcherPlugin,
		],
	});
	if (watch) {
		await Promise.all([ctx.watch(), daemon.watch()]);
	} else {
		await Promise.all([ctx.rebuild(), daemon.rebuild()]);
		await Promise.all([ctx.dispose(), daemon.dispose()]);
	}
}

main().catch(e => {
	console.error(e);
	process.exit(1);
});
