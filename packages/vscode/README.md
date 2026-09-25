# RefDex: a code index for AI assistants

**Claude Code and GitHub Copilot can look code up instead of reading whole files, so each task uses fewer tokens and they find their way around a large codebase.**

RefDex indexes every class, method, function and property in your workspace into a local database. It serves that index to your AI assistant through the Model Context Protocol (MCP). The assistant can then ask precise questions, such as "where is `OrderService`?", "what's in this file?", "show me just this method" or "who calls this?", and get short, exact answers.

Supports **TypeScript, Python, Java and C#**. Setup happens inside VS Code, and your code never leaves your machine.

---

## What is RefDex?

AI coding assistants learn about your code by reading files. In a small project that's fine. In a large one they read big files to find one function, open the wrong files, and fill their context window with code that doesn't matter to the task.

RefDex gives them an index to look things up in, the way you'd use *Go to Symbol* or *Find All References*:

- **A symbol index.** It records every class, interface, method, function, property and field, with its signature, doc comment, file and line range.
- **Imports, resolved.** It records where each import points: TypeScript path aliases and barrel files, Python packages, Java packages and C# namespaces, including `global using`.
- **A call graph.** It links calls, subclasses, interface implementations and type references to the declarations they mean.
- **A ranking.** A PageRank over that graph finds the code the rest of the project depends on most.

The index stores line ranges, not code. Code is always read from disk when the assistant asks for it, so it's never out of date.

## Why it helps prompt optimization

Every token an assistant spends reading irrelevant code is a token it can't spend on your task. RefDex changes what goes into the context window:

| The assistant needs… | Without RefDex | With RefDex |
| --- | --- | --- |
| To find a class | Search, then open candidate files | `search_symbols`: name, signature, file and line |
| To understand a file | Read the whole file | `get_file_outline`: imports and signatures, no bodies |
| One method | Read the file it's in | `get_symbol_source`: just that method, read from disk |
| Its callers, before a change | Text search and reading the matches | `find_references`: each use, with the method it's in |
| To get oriented in a new codebase | Browse folders and read files | `get_repo_map`: the most-used code, trimmed to a token budget |

For example, RefDex's own database module is 915 lines, about **11,000 tokens** to read whole. Its outline costs about **2,600 tokens**, and one method about **280**. (Token counts are estimated at 4 characters per token.)

Smaller answers mean:

- **Lower cost and more headroom.** Long sessions stay under the context limit longer.
- **More focused answers.** The context holds the code that matters, not everything near it.
- **Fewer wrong guesses.** Signatures, callers and base classes come from the parsed code, not from skimming.

## Built for large codebases

RefDex is meant for the codebases where assistants struggle most: large monorepos, enterprise Java and C# solutions, and years-old Python and TypeScript projects.

- **Stays up to date by itself.** When you save, create or delete a file, only what changed is parsed again. In a benchmark on a generated 3,000-file TypeScript project (96,000 symbols), a saved file was re-indexed in 40–60 ms.
- **Indexes in the background.** Indexing runs in a separate process and never blocks the editor. The benchmark project's first index took under 30 seconds, and symbol search works while it runs.
- **Understands how big projects are built.** It handles monorepo packages and `tsconfig` path aliases, barrel re-exports, Python `src/` layouts, Java packages, and C# partial classes split across files, with global usings per `.csproj`.
- **A repo map for orientation.** `get_repo_map` ranks symbols by how much the rest of the code depends on them. It can be limited to one folder, so the assistant sees the core of the project first.
- **Controls what gets indexed.** It respects `.gitignore`, skips `node_modules`, `dist`, `bin`, `obj` and `.venv`, and lets you add include and exclude patterns.
- **Handles multi-root workspaces.** Pick which workspace folder RefDex indexes and serves. Each folder keeps its own index.

## Getting started

1. **Install RefDex** and open a folder with TypeScript, Python, Java or C# code.
2. **Generate the index:** click the RefDex item in the status bar, or run **RefDex: Generate / Regenerate Index**. After that it keeps itself up to date.
3. **Connect your assistant:**
   - **GitHub Copilot (agent mode):** nothing to do. RefDex registers itself as an MCP server when Copilot Chat is installed.
   - **Claude Code:** run **RefDex: Connect Claude Code…** (RefDex also offers this after the first index). Choose *This project, only for me* to add it to your own Claude Code settings, or *.mcp.json* to write it into the workspace. Then start a new Claude Code session.

That's it. The assistant is told what the tools are for and uses them without being asked.

## The tools your assistant gets

| Tool | What it answers |
| --- | --- |
| `get_repo_map` | "What matters in this codebase?": the most-used symbols with signatures, grouped by file, within a token budget; optionally for one folder |
| `search_symbols` | "Where is X?": classes, functions, methods, properties and fields by name or prefix, filtered by kind or language |
| `get_file_outline` | "What's in this file?": imports (and where they resolve), plus every signature and line range, nested by class |
| `get_symbol_source` | "Show me this code": one symbol's source from disk, every overload and partial-class part; `with_callees` adds what it calls |
| `find_references` | "Who uses this?": calls, subclasses, implementations and type references, each with the calling method, plus imports |

Every tool is read-only, and each answer says how fresh the index is.

Here is what the assistant sees for `search_symbols("OrderServ")`:

```
3 matches for "OrderServ":
class src/services/orderService:OrderService  src/services/orderService.ts:9-15
  class OrderService
method src/services/orderService:OrderService.find  src/services/orderService.ts:12-14
  find(id: string): Order | undefined
method src/services/orderService:OrderService.constructor  src/services/orderService.ts:10
  constructor(private readonly client: Client)
```

## Supported languages

| Language | What RefDex understands |
| --- | --- |
| **TypeScript / TSX** | Classes, interfaces, type aliases, enums, functions, arrow functions assigned to `const`, `tsconfig` paths and `extends`, barrel re-exports, monorepo packages |
| **Python** | Classes, functions, methods, decorators, docstrings, relative imports, packages and `src/` layouts |
| **Java** | Classes, records, interfaces, enums, annotations, overloads, nested types, static and wildcard imports |
| **C#** | Classes, structs, records, interfaces, enums, delegates, properties, partial classes across files, file-scoped namespaces, `global using` |

## Seeing what RefDex does

- **Status bar:** the RefDex item shows the index at a glance: symbols per language, resolved imports, linked uses, connected assistants, and how many tool calls they made with roughly how many tokens returned.
- **RefDex panel:** the activity bar view shows the current configuration and buttons for the common actions.
- **Log:** **RefDex: Show Log** lists every MCP tool call with its arguments, timing and size, and every query sent to the index.
- **Database:** **RefDex: Open Database…** lets you browse or export the index tables.

## Commands

| Command | |
| --- | --- |
| RefDex: Generate / Regenerate Index | Build the index, or rebuild it from scratch |
| RefDex: Update Index (changed files only) | Re-index what changed since the last run |
| RefDex: Select Workspace Folder… | Choose which folder of a multi-root workspace to index |
| RefDex: Search Symbols | Jump to any indexed symbol by name |
| RefDex: Connect Claude Code… | Add RefDex to Claude Code for this project, or remove it |
| RefDex: Open Database… / Browse Database / Export Table to CSV… | Look inside the index |
| RefDex: Toggle Watching for Changes | Turn automatic updates on or off |
| RefDex: Show Log | Every MCP call and index query |

## Settings

| Setting | Default | |
| --- | --- | --- |
| `refdex.include` | `[]` | Only index paths matching these patterns (`.gitignore` syntax), such as `src/` or `services/**/*.cs`. Empty means everything |
| `refdex.exclude` | `[]` | Extra paths to leave out, such as `generated/` or `**/*.test.ts` |
| `refdex.languages` | `[]` | Languages to index. Empty means all |
| `refdex.watch` | `true` | Keep the index up to date as files change |

## Privacy

RefDex runs entirely on your machine. The index is a SQLite database in VS Code's storage for the workspace, not in your repository. Nothing is uploaded. Your assistant sees only the answers to the tool calls it makes, and those calls appear in the log.

## Requirements

- VS Code 1.101 or later. RefDex runs on VS Code's own runtime, so no Node.js install is needed.
- For Copilot: GitHub Copilot Chat with agent mode.
- For Claude Code: the Claude Code extension or CLI.

## Known limitations

- RefDex links calls by scope and imports, without full type inference. A call on a variable whose type RefDex can't see is linked only when exactly one visible type declares that method. `find_references` then also lists other lines that mention the name, so you can review them.
- Dynamic code (Python `getattr`, reflection, code generated at build time) isn't indexed.
- In a multi-root workspace, one folder is indexed and kept current at a time.
