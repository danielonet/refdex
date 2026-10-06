# Changelog

All notable changes to the RefDex plugin for IntelliJ-based IDEs are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/). The VS Code extension shares the index and the AI tools; its changelog is [packages/vscode/CHANGELOG.md](../../packages/vscode/CHANGELOG.md).

## [Unreleased]

### Added

- **See when AI assistants use RefDex.** For a few seconds after Claude Code, Junie, Copilot or another client calls a RefDex tool, the status bar shows the call (`find_references · Claude Code`) with a spinning icon. The widget also counts today's calls (`80 files · 14 calls today`), and a click shows today's calls and the tokens RefDex returned per client, plus the latest calls. Each call is also written to the IDE log.
- **See whether RefDex is connected.** A dot beside the RefDex icon in the status bar is green with a check when RefDex is connected to an AI client and red when it isn't, and the menu shows "Connected: Claude Code, Junie…" instead of "Connect AI Client…". The state follows changes made outside the IDE (such as `claude mcp remove`) within half a minute.

- **`get_context`: a small overview of the code a task touches.** Given the task in words, the AI gets the code of the methods it names and the signatures of what they call and what calls them, packed into a token budget (default 1,500, at most 3,000; larger requests are reduced, not refused). It can also start from names the AI passes, or from the symbols changed in git. Mirrored source trees (such as Guava's `android/` copy) are shown once.

### Changed

- **The blast radius comes by default.** `find_references` now shows two levels of callers and the tests that reach the method without being asked (`depth` 1–5; it was opt-in). Two levels found every answer the index can reach on Guava; deeper only made answers bigger. In the Guava benchmark, questions about callers and tests cost 12% less with RefDex, and finding the tests that reach a method through helpers 20–31% less.
- **How RefDex guides AI assistants.** The instructions now point to `find_references` first, for "who calls", "which tests" and "what breaks" questions; `get_context` is described as a small overview for unfamiliar code rather than the first call. Large `get_context` answers had made flow questions 17–25% more expensive in the benchmark, since they stay in every later request.
- **Fewer round trips for AI assistants.** Each tool call makes the assistant re-send the whole conversation, so answers now include what it would ask for next: `get_symbol_source` reads several symbols in one call (`qualified_names`), `search_symbols` includes the code of a single exact match, and `find_references` includes the code of the first callers (whole when short, otherwise around the call).
- **Calls through declared types are linked** in Java and C#: `source.copyTo(sink)` on a typed parameter or local variable (also `var x = new Foo()`), `this.store.save()` on a field, `segmentFor(h).put(…)` on a method's return value, and chains of them. On Guava this links 24% more calls, and `find_references` finds callers it used to miss. C# null-conditional calls (`x?.Save()`) are now found at all.
- **Tool definitions** take about 1,300 tokens per AI request, instructions included. In Claude Code, which loads MCP tool definitions only when first used, that costs one extra step per session instead.
- The index is rebuilt once after updating, automatically.

## [0.1.3] - 2026-09-27

### Added

- **Blast radius for AI assistants.** `find_references` takes a `depth` (2–5): callers of the callers up to that many levels, including calls through the interfaces and base methods a method implements, and the tests that reach it. When calls the index couldn't link may lead to the method, the answer says the blast radius may be incomplete and shows one.

### Changed

- **Smaller answers.** File outlines of very large files show names only, or only their types, instead of every signature, and `find_references` lists at most 15 lines that only match by name, then counts the rest per file.
- The "no index yet" answer explains how to build it in a JetBrains IDE (**Tools | RefDex | Reindex Project**).

### Fixed

- Calls through an interface (`store.save()` where both `Store` and `DiskStore` declare `save`) are now linked to the interface method, so `find_references` finds them.
- In Java, `import static a.Util.x` no longer makes every member of `Util` visible, which could link calls to the wrong method.

## [0.1.2] - 2026-09-26

### Fixed

- The plugin no longer reports an error when the daemon can't start while a project opens; the problem shows in the status bar instead.
- The bundled daemon is found from the plugin's own folder, and the plugin passes JetBrains' Plugin Verifier without warnings about deprecated methods.

## [0.1.1] - 2026-09-26

### Changed

- The status bar widget shows the RefDex icon (light and dark themes) and clearer status messages.

### Fixed

- The bundled daemon executable is made executable after installation, so it starts without Node.js.

## [0.1.0] - 2026-09-26

First release, for IntelliJ-based IDEs 2025.3 and later.

### Added

- **Code index for AI assistants.** A bundled daemon indexes the project's TypeScript, Python, Java and C# code into a local database in the IDE's system directory when the project opens, then keeps it up to date as files change.
- **MCP tools** for AI assistants: `search_symbols`, `get_file_outline`, `get_symbol_source`, `find_references` and `get_repo_map`, offered once the codebase is large enough for them to pay off.
- **Connect AI Client…** writes the MCP entry for Claude Code (your own settings or the project's `.mcp.json`), Junie and GitHub Copilot, and copies a snippet for JetBrains AI Assistant. Existing entries follow the plugin when it updates; none is created unless you ask.
- **Status bar widget** with files, symbols, imports, the last index time and the AI tools decision; a click opens the RefDex menu.
- **Tools | RefDex:** Reindex Project, Rebuild Index, Connect AI Client… and Settings….
- **Settings | Tools | RefDex:** include and exclude patterns, languages, file watching, when to offer the AI tools, and a daemon override.

[Unreleased]: #unreleased
[0.1.3]: #013---2026-09-27
[0.1.2]: #012---2026-09-26
[0.1.1]: #011---2026-09-26
[0.1.0]: #010---2026-09-26
