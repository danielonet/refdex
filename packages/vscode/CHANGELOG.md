# Changelog

All notable changes to RefDex are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **`get_context`: everything a task needs in one call** (RefDex v2, first step). Given the task in words, the AI gets the code of the methods it names, the signatures of what they call and what calls them, and the tests that reach them, packed into a token budget (default 4,000). Code close to the task gets more detail; code further out gets a signature or just its name. It can also start from names the AI passes, or from the symbols changed in git. Each answer ends with the tokens it returned and what reading those files whole would have cost. The plan is in `docs/refdex-v2-plan.md`.
- **Blast radius for AI assistants.** `find_references` takes a `depth` (2–5): callers of the callers up to that many levels, including calls through the interfaces and base methods a method implements, and the tests that reach it. When calls the index couldn't link may lead to the method (for example `CacheBuilder.newBuilder().recordStats()`), the answer says the blast radius may be incomplete and shows one.

### Changed

- **Smaller answers.** File outlines of very large files show names only, or only their types, instead of every signature, and `find_references` lists at most 15 lines that only match by name, then counts the rest per file.
- **Smaller tool definitions** for the existing tools. With `get_context` added, the definitions take about 1,500 tokens per AI request (about 300 of them for `get_context`).

### Fixed

- Calls through an interface (`store.save()` where both `Store` and `DiskStore` declare `save`) are now linked to the interface method, so `find_references` finds them.
- In Java, `import static a.Util.x` no longer makes every member of `Util` visible, which could link calls to the wrong method.
- The index is rebuilt once after this update, automatically (it now records each symbol's size, for `get_context`'s budget). The "no index" message also explains what to do in JetBrains IDEs.

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
