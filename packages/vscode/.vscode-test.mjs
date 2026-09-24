import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
	files: 'out/test/**/*.test.js',
	// A small TypeScript project from the core fixtures; the index goes to extension storage, not into it.
	workspaceFolder: '../core/test/fixtures/typescript',
	// Set VSCODE_PATH to an installed VS Code binary to skip downloading one.
	...(process.env.VSCODE_PATH ? { useInstallation: { fromPath: process.env.VSCODE_PATH } } : {}),
	mocha: { timeout: 60_000 },
});
