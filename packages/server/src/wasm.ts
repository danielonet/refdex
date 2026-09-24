import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import * as sea from 'node:sea';
import { nodeModulesWasmLoader, type WasmLoader } from '@refdex/core';

/**
 * Where the .wasm files come from: embedded assets in the single executable, a `wasm/` folder
 * next to the bundle (as shipped inside the VS Code extension), or node_modules in development.
 */
export function wasmLoader(): WasmLoader {
  if (sea.isSea()) return async (file) => new Uint8Array(sea.getAsset(file));
  const bundled = join(dirname(process.argv[1] ?? ''), 'wasm');
  if (existsSync(bundled)) return async (file) => new Uint8Array(await readFile(join(bundled, file)));
  return nodeModulesWasmLoader;
}
