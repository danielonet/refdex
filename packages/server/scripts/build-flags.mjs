// Build-time switches from refdex.build.json at the repo root, as esbuild `define`s.
// Code checks them inline, e.g. `if (typeof __REFDEX_DEBUG__ === 'undefined' || __REFDEX_DEBUG__)`,
// so esbuild drops a disabled branch, and the modules only it imports, from the bundle.
// Running from source (tests, `npm run dev`) has no define, which counts as a debug build.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BUILD_CONFIG = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'refdex.build.json');

export function buildFlags() {
  const config = JSON.parse(readFileSync(BUILD_CONFIG, 'utf8'));
  if (typeof config.debug !== 'boolean') throw new Error(`${BUILD_CONFIG}: "debug" must be true or false`);
  return { debug: config.debug, define: { __REFDEX_DEBUG__: String(config.debug) } };
}
