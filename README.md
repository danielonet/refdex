# refdex

VS Code extension that indexes the code base so that prompts to the LLM consume fewer tokens.
See [docs/refdex-project-plan.md](docs/refdex-project-plan.md) for the plan.

## Layout

| Path | Contents |
| --- | --- |
| `packages/core` | Language adapters, workspace scan, SQLite index and incremental indexer |
| `packages/server` | The `refdex` CLI and daemon (`refdex serve`: worker-thread indexing, file watcher, (later) MCP); builds to a single executable |
| `packages/vscode` | VS Code extension (scaffolded with `yo code`) |
| `plugins/intellij` | IntelliJ plugin (Phase 6) |

## Development

Requires Node 22.18+ (TypeScript runs directly through Node's type stripping).

```sh
npm install
npm run spike              # print symbols from one sample file per language
npm run check-types        # typecheck all workspaces
npm test                   # adapter, indexer and daemon tests
npm run build              # bundle the daemon and the VS Code extension
npm run build:sea          # build the single executable packages/server/dist/refdex
packages/server/dist/refdex selftest
```

### Using the MCP server

Index a project, then point an MCP client at `refdex mcp`, for example in Claude Code's `.mcp.json`:

```json
{
  "mcpServers": {
    "refdex": {
      "command": "node",
      "args": ["/path/to/refdex/packages/server/dist/refdex.cjs", "mcp", "--root", "/path/to/project"]
    }
  }
}
```

```sh
node packages/server/dist/refdex.cjs index --root /path/to/project   # writes /path/to/project/.refdex/index.db
```

Tools: `get_repo_map`, `search_symbols`, `get_file_outline`, `get_symbol_source` (optionally `with_callees`), `find_references`. In VS Code you don't need this by hand: the extension registers RefDex with Copilot automatically, and "RefDex: Connect Claude Code…" adds it to Claude Code for the open project.

To run the extension, open `packages/vscode` in VS Code and press F5.

## Scripts

| Script | Purpose |
| --- | --- |
| `scripts/build-and-install.sh [all\|vscode\|intellij]` | Build and install the VS Code extension (`refdex.vsix`) and the IntelliJ plugin (into every JetBrains IDE found); with `all`, a target that can't be built here is skipped |
| `scripts/uninstall.sh` | Uninstall `danielonnet.refdex` from VS Code |
| `scripts/publish-marketplace.sh [patch\|minor\|major\|<version>]` | Test, package and publish to the Marketplace (`--dry-run`, `--help`); credentials live in `~/.config/refdex/marketplace.env` |
| `npm run build:icon-font` | Build `packages/vscode/media/refdex-icons.woff` from `packages/vscode/media/icon.svg` |
