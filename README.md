# refdex

VS Code extension that indexes the code base so that prompts to the LLM consume fewer tokens.
See [docs/refdex-project-plan.md](docs/refdex-project-plan.md) for the plan.

## Layout

| Path | Contents |
| --- | --- |
| `packages/core` | Tree-sitter parsing, symbol extraction, (later) language adapters and database |
| `packages/server` | The `refdex` daemon: SQLite index, (later) file watcher and MCP server; builds to a single executable |
| `packages/vscode` | VS Code extension (scaffolded with `yo code`) |
| `plugins/intellij` | IntelliJ plugin (Phase 6) |

## Development

Requires Node 22.18+ (TypeScript runs directly through Node's type stripping).

```sh
npm install
npm run spike              # print symbols from one sample file per language
npm run check-types        # typecheck all workspaces
npm run build              # bundle the daemon and the VS Code extension
npm run build:sea          # build the single executable packages/server/dist/refdex
packages/server/dist/refdex selftest
```

To run the extension, open `packages/vscode` in VS Code and press F5.

## Scripts

| Script | Purpose |
| --- | --- |
| `scripts/build-and-install.sh` | Build `refdex.vsix` and install it into your local VS Code |
| `scripts/uninstall.sh` | Uninstall `danielonnet.refdex` from VS Code |
| `scripts/publish-marketplace.sh [patch\|minor\|major\|<version>]` | Test, package and publish to the Marketplace (`--dry-run`, `--help`); credentials live in `~/.config/refdex/marketplace.env` |
| `npm run build:icon-font` | Build `packages/vscode/media/refdex-icons.woff` from `packages/vscode/media/icon.svg` |
