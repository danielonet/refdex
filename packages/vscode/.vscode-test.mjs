import { defineConfig } from '@vscode/test-cli';

// Set VSCODE_PATH to an installed VS Code binary to skip downloading one.
const installation = process.env.VSCODE_PATH ? { useInstallation: { fromPath: process.env.VSCODE_PATH } } : {};

export default defineConfig([
	{
		label: 'single-folder',
		files: 'out/test/*.test.js',
		// A small TypeScript project from the core fixtures; the index goes to extension storage, not into it.
		workspaceFolder: '../core/test/fixtures/typescript',
		...installation,
		mocha: { timeout: 60_000 },
	},
	{
		label: 'multi-root',
		files: 'out/test/multi-root/*.test.js',
		// The TypeScript and Python fixtures as one multi-root workspace.
		workspaceFolder: 'src/test/multi-root/fixture.code-workspace',
		...installation,
		mocha: { timeout: 60_000 },
	},
]);
