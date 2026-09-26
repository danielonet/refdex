// Collects what an IDE plugin ships to run the daemon into one folder (the IntelliJ plugin's build
// calls this):
//   <out>/refdex.cjs               the bundle, run with a Node.js 22.13+ found on PATH
//   <out>/wasm/*.wasm              tree-sitter runtime and grammars beside it (see src/wasm.ts)
//   <out>/<platform>-<arch>/refdex the single executable, when `npm run build:sea` built one
// Usage: node scripts/stage-daemon.mjs <out>
import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WASM_MODULE_PATHS } from '@refdex/core';

const require = createRequire(import.meta.url);
const server = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(process.argv[2] ?? 'daemon');
const bundle = join(server, 'dist', 'refdex.cjs');
if (!existsSync(bundle)) throw new Error(`${bundle} is missing; run \`npm run build:sea -w @refdex/server\` first`);

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'wasm'), { recursive: true });
copyFileSync(bundle, join(out, 'refdex.cjs'));
for (const [file, modulePath] of Object.entries(WASM_MODULE_PATHS)) {
  copyFileSync(require.resolve(modulePath), join(out, 'wasm', file));
}

const exeName = process.platform === 'win32' ? 'refdex.exe' : 'refdex';
const exe = join(server, 'dist', exeName);
if (existsSync(exe) && statSync(exe).mtimeMs >= statSync(bundle).mtimeMs) {
  const dir = join(out, `${process.platform}-${process.arch}`);
  mkdirSync(dir);
  copyFileSync(exe, join(dir, exeName));
  chmodSync(join(dir, exeName), 0o755);
  console.log(`staged ${out} with the ${process.platform}-${process.arch} executable`);
} else {
  // An executable older than the bundle would be a stale daemon; Node on PATH runs the bundle instead.
  console.log(`staged ${out} without an executable (${existsSync(exe) ? 'older than refdex.cjs' : 'not built'})`);
}
