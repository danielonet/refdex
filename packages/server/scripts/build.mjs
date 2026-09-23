// Bundles the daemon into one CommonJS file (Node single-executable apps require CJS).
import { build } from 'esbuild';

await build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/refdex.cjs',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: 'linked',
  // web-tree-sitter and @refdex/core use import.meta.url; shim it for CJS.
  define: { 'import.meta.url': '__import_meta_url' },
  banner: { js: "const __import_meta_url = require('node:url').pathToFileURL(__filename).href;" },
  logLevel: 'info',
});
