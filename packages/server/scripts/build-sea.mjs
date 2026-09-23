// Packages dist/refdex.cjs as a Node single executable (dist/refdex or dist/refdex.exe) with the
// tree-sitter runtime and grammar .wasm files embedded as SEA assets.
// https://nodejs.org/api/single-executable-applications.html
import { execFileSync } from 'node:child_process';
import { copyFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { WASM_MODULE_PATHS } from '@refdex/core';

const require = createRequire(import.meta.url);
const platform = process.platform;
const exe = platform === 'win32' ? 'dist/refdex.exe' : 'dist/refdex';
const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit' });

const assets = Object.fromEntries(
  Object.entries(WASM_MODULE_PATHS).map(([file, modulePath]) => [file, require.resolve(modulePath)]),
);
writeFileSync('dist/sea-config.json', JSON.stringify({
  main: 'dist/refdex.cjs',
  output: 'dist/refdex.blob',
  disableExperimentalSEAWarning: true,
  useCodeCache: false,
  assets,
}, null, 2));

run(process.execPath, ['--experimental-sea-config', 'dist/sea-config.json']);
copyFileSync(process.execPath, exe);
if (platform === 'darwin') run('codesign', ['--remove-signature', exe]);
run(process.execPath, [
  require.resolve('postject/dist/cli.js'), exe, 'NODE_SEA_BLOB', 'dist/refdex.blob',
  '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  ...(platform === 'darwin' ? ['--macho-segment-name', 'NODE_SEA'] : []),
]);
if (platform === 'darwin') run('codesign', ['--sign', '-', exe]);
console.log(`built ${exe}`);
