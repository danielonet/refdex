// Bundles the daemon into one CommonJS file (Node single-executable apps require CJS).
import { build } from 'esbuild';
import { buildFlags } from './build-flags.mjs';

const flags = buildFlags();
if (flags.debug) console.log('refdex.build.json: debug build (includes refdex mcp --http)');

await build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/refdex.cjs',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: 'linked',
  // web-tree-sitter and @refdex/core use import.meta.url; shim it for CJS.
  define: { 'import.meta.url': '__import_meta_url', ...flags.define },
  banner: { js: "const __import_meta_url = require('node:url').pathToFileURL(__filename).href;" },
  logLevel: 'info',
});
