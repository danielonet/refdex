# RefDex

[![VS Code Marketplace](https://vsmarketplacebadges.dev/version/danielonnet.refdex.svg?label=VS%20Code%20Marketplace)](https://marketplace.visualstudio.com/items?itemName=danielonnet.refdex)
[![Installs](https://vsmarketplacebadges.dev/installs-short/danielonnet.refdex.svg)](https://marketplace.visualstudio.com/items?itemName=danielonnet.refdex)
[![JetBrains Marketplace](https://img.shields.io/jetbrains/plugin/v/34561?label=JetBrains%20Marketplace)](https://plugins.jetbrains.com/plugin/34561-refdex)
[![Downloads](https://img.shields.io/jetbrains/plugin/d/34561)](https://plugins.jetbrains.com/plugin/34561-refdex)

**A code index for AI assistants. Claude Code, GitHub Copilot and Junie can look code up instead of reading whole files, so each task uses fewer tokens and they find their way around a large codebase.**

RefDex parses TypeScript, Python, Java and C# into a local SQLite index of every class, method, function and property: signatures, doc comments, resolved imports and a call graph. An MCP server lets AI assistants query it. Instead of reading a 900-line file to find one method, the assistant asks for the file's outline, or for just that method, or for everything that calls it.

- **Prompt optimization:** the context window holds the code the task needs, not whole files around it. For example, RefDex's own 915-line database module costs about 11,000 tokens to read whole, about 2,600 as an outline, and about 280 for one method.
- **Large codebases:** incremental, hash-based updates (a saved file in 40–60 ms on a generated 3,000-file project), background indexing, monorepo and namespace-aware import resolution, and a PageRank repo map that shows an assistant the core of an unfamiliar codebase first.
- **No setup:** inside VS Code, RefDex registers with Copilot automatically and connects to Claude Code with one command. In IntelliJ-based IDEs, one action connects Claude Code, Junie or Copilot. The index stays on your machine.

The VS Code Marketplace page, with features, tools, commands and settings, is [packages/vscode/README.md](packages/vscode/README.md). The IntelliJ plugin is described in [plugins/intellij/README.md](plugins/intellij/README.md). The design and roadmap are in [docs/refdex-project-plan.md](docs/refdex-project-plan.md).

## Status

| Part | State |
| --- | --- |
| VS Code extension | Published on the VS Code Marketplace (0.1.3) |
| IntelliJ plugin | 0.1.2 uploaded to the JetBrains Marketplace and waiting for JetBrains' review. Works in IntelliJ-based IDEs 2025.3 and later. Its zip bundles the daemon executable for Linux x64 only; on macOS and Windows it needs Node.js 22.13+ on PATH until CI builds those executables |
| Open work | From Phase 5 of the plan: per-language fixture repos, a performance test on a large repo, and the token-usage comparison with and without the index |

## Layout

| Path | Contents |
| --- | --- |
| `packages/core` | Language adapters, workspace scan, SQLite index and incremental indexer |
| `packages/server` | The `refdex` CLI, the daemon (`refdex serve`: worker-thread indexing, file watcher) and the MCP server (`refdex mcp`); builds to a single executable |
| `packages/vscode` | VS Code extension: daemon lifecycle, Copilot and Claude Code setup, status bar report, database browser. Its `README.md` is the Marketplace page |
| `plugins/intellij` | IntelliJ plugin (Kotlin, Gradle): starts the bundled daemon, status bar widget, Reindex and Rebuild actions, settings page, and one-step MCP setup for Claude Code, Junie and Copilot |

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

Tools: `get_repo_map`, `search_symbols`, `get_file_outline`, `get_symbol_source` (optionally `with_callees`), `find_references`. In the IDEs you don't need this by hand: the VS Code extension registers RefDex with Copilot automatically, and "RefDex: Connect Claude Code…" adds it to Claude Code for the open project. In IntelliJ, **Tools | RefDex | Connect AI Client…** does the same for Claude Code, Junie and Copilot.

To run the extension, open `packages/vscode` in VS Code and press F5. To run the IntelliJ plugin in a sandbox IDE, run `./gradlew runIde` in `plugins/intellij`; it needs JDK 21, and its first build downloads the IntelliJ Platform SDK (about 1.5 GB).

## Scripts

| Script | Purpose |
| --- | --- |
| `scripts/install-vscode.sh` | Build `refdex.vsix` and install it into VS Code |
| `scripts/build-intellij.sh [--test] [--verify] [--skip-daemon]` | Build the IntelliJ plugin zip (`plugins/intellij/build/distributions/`) |
| `scripts/install-intellij.sh [--test] [--skip-daemon]` | Build the IntelliJ plugin and install it into every JetBrains IDE 2025.3+ found |
| `scripts/uninstall.sh` | Uninstall `danielonnet.refdex` from VS Code |
| `scripts/publish-marketplace.sh [patch\|minor\|major\|<version>]` | Test, package and publish the VS Code extension to the VS Code Marketplace (`--dry-run`, `--help`); credentials live in `~/.config/refdex/marketplace.env` |
| `npm run build:icon-font` | Build `packages/vscode/media/refdex-icons.woff` from `packages/vscode/media/icon.svg` |
