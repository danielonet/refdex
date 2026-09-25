# Changelog

All notable changes to RefDex are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.3] - 2026-09-25

### Added

- **Tools only where they pay off.** RefDex's tool definitions are sent with every AI request, about 1,200 tokens. On a small codebase, reading files costs less than that. RefDex now offers its tools only once the indexed code reaches about 100,000 tokens (roughly 400 KB of source).
  - Below that, Copilot doesn't start RefDex, Claude Code sees no RefDex tools, and RefDex doesn't offer to connect Claude Code.
  - Tools switch on by themselves once the codebase grows past the threshold, even while an assistant is running.
- New settings to control this: `refdex.aiTools` (`auto`, `always` or `never`) and `refdex.aiToolsMinTokens`.
- The status bar report and the RefDex panel show whether AI tools are on, and why.
- The log shows, for each AI client that connects, whether it got the tools.

### Fixed

- After a settings change, the status bar no longer shows "not indexed" for a moment while RefDex restarts.

### Changed

- The index records each file's size, so an existing index is rebuilt once after updating.

## [0.1.2] - 2026-09-25

### Changed

- New icons for the activity bar and status bar: a database with `</>` and a lightning bolt, matching the extension icon.
- The Marketplace page now explains what RefDex is, how it saves tokens, and how it handles large codebases. It also lists every tool, command and setting.

## [0.1.1] - 2026-09-25

The first full release.

### Added

- **Code index.** Every class, interface, enum, function, method, property and field in TypeScript, Python, Java and C# goes into a local SQLite database, with signatures, doc comments and line ranges.
  - Imports are resolved: TypeScript path aliases, barrel re-exports and monorepo packages; Python packages and `src/` layouts; Java packages; C# namespaces and `global using`.
  - C# partial classes spread over several files count as one type.
- **Call graph.** Calls, subclasses, interface implementations and type references are linked to the declarations they mean.
- **Stays up to date by itself.** Files are re-indexed as you save, create or delete them. Only what changed is parsed again, and indexing runs in the background.
- **Tools for AI assistants, over MCP:**
  - `search_symbols`: find code by name.
  - `get_file_outline`: a file's imports and signatures, without the bodies.
  - `get_symbol_source`: one symbol's code, read from disk. With `with_callees`, it also lists the signatures of what it calls.
  - `find_references`: every use of a symbol, with the method it's used in.
  - `get_repo_map`: the most-used code, ranked by PageRank and trimmed to a token budget.
- **AI client setup.** RefDex registers itself with GitHub Copilot agent mode when Copilot Chat is installed. **RefDex: Connect Claude Code…** adds it to Claude Code, either for you alone or in `.mcp.json`.
- **Multi-root workspaces.** **RefDex: Select Workspace Folder…** picks the folder RefDex indexes and serves. Each folder keeps its own index.
- **Status bar report.** Symbols per language, resolved imports, linked uses, connected AI clients, and their tool calls with an estimate of the tokens returned.
- **RefDex panel** with the current configuration and the common actions.
- **Log.** **RefDex: Show Log** lists every AI tool call with its arguments, timing and size, and every query to the index.
- **Database access.** **Search Symbols**, **Open Database…**, **Browse Database** and **Export Table to CSV…**.
- **Settings:** `refdex.include`, `refdex.exclude`, `refdex.languages` and `refdex.watch`.

[Unreleased]: #unreleased
[0.1.3]: #013---2026-09-25
[0.1.2]: #012---2026-09-25
[0.1.1]: #011---2026-09-25
