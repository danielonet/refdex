import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { WASM_MODULE_PATHS, type WasmFile } from './languages.ts';

/**
 * Supplies .wasm bytes. The default reads from node_modules; the single-executable
 * daemon supplies its own loader backed by embedded assets.
 */
export type WasmLoader = (file: WasmFile) => Promise<Uint8Array>;

export const nodeModulesWasmLoader: WasmLoader = async (file) => {
  const require = createRequire(import.meta.url);
  return new Uint8Array(await readFile(require.resolve(WASM_MODULE_PATHS[file])));
};
