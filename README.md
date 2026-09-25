# RefDex

**A code index for AI assistants. Claude Code and GitHub Copilot can look code up instead of reading whole files, so each task uses fewer tokens and they find their way around a large codebase.**

RefDex parses TypeScript, Python, Java and C# into a local SQLite index of every class, method, function and property: signatures, doc comments, resolved imports and a call graph. An MCP server lets AI assistants query it. Instead of reading a 900-line file to find one method, the assistant asks for the file's outline, or for just that method, or for everything that calls it.

- **Prompt optimization:** the context window holds the code the task needs, not whole files around it. For example, RefDex's own 915-line database module costs about 11,000 tokens to read whole, about 2,600 as an outline, and about 280 for one method.
- **Large codebases:** incremental, hash-based updates (a saved file in 40–60 ms on a generated 3,000-file project), background indexing, monorepo and namespace-aware import resolution, and a PageRank repo map that shows an assistant the core of an unfamiliar codebase first.
- **No setup:** inside VS Code, RefDex registers with Copilot automatically and connects to Claude Code with one command. The index stays on your machine.

The Marketplace page, with features, tools, commands and settings, is [packages/vscode/README.md](packages/vscode/README.md). The design and roadmap are in [docs/refdex-project-plan.md](docs/refdex-project-plan.md).

## Layout

| Path | Contents |
| --- | --- |
| `packages/core` | Language adapters, workspace scan, SQLite index and incremental indexer |
| `packages/server` | The `refdex` CLI, the daemon (`refdex serve`: worker-thread indexing, file watcher) and the MCP server (`refdex mcp`); builds to a single executable |
| `packages/vscode` | VS Code extension: daemon lifecycle, Copilot and Claude Code setup, status bar report, database browser. Its `README.md` is the Marketplace page |
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
