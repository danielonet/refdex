# RefDex: a code index for AI assistants

**Claude Code and GitHub Copilot can look code up instead of reading whole files, so each task uses fewer tokens and they find their way around a large codebase.**

RefDex indexes every class, method, function and property in your workspace into a local database. It serves that index to your AI assistant through the Model Context Protocol (MCP). The assistant can then ask precise questions, such as "where is `OrderService`?", "what's in this file?", "show me just this method" or "who calls this?", and get short, exact answers.

Supports **TypeScript, Python, Java and C#**. Setup happens inside VS Code, and your code never leaves your machine.

If you use IntelliJ IDEA or another JetBrains IDE, you can get the RefDex plugin from the [JetBrains Marketplace](https://plugins.jetbrains.com/plugin/34561-refdex).

[![Get RefDex from the JetBrains Marketplace](https://img.shields.io/jetbrains/plugin/v/34561?label=JetBrains%20Marketplace)](https://plugins.jetbrains.com/plugin/34561-refdex)

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
| A few methods | Read the files they're in | `get_symbol_source`: just those methods, several in one call, read from disk |
| Its callers, before a change | Text search and reading the matches | `find_references`: each use with the method it's in, and the code of the first callers |
| The blast radius of a change | Following callers of callers by hand | `find_references`: callers and their callers, and the tests that reach it, in one answer |
| To get oriented in a new codebase | Browse folders and read files | `get_repo_map`: the most-used code, trimmed to a token budget |
| A first overview of a task | Many searches and file reads, one by one | `get_context`: the code the task names and the signatures around it, in at most 3,000 tokens |

For example, Guava's `CacheBuilder.java` is 1,148 lines, about **13,200 tokens** to read whole. Its outline costs about **1,100 tokens**, and one method about **140**. Outlines of very large files stay small: Guava's 5,000-line `LocalCache.java` (about 38,000 tokens) outlines in about 1,300. (Token counts are estimated at 4 characters per token.)

Smaller answers mean:

- **Lower cost and more headroom.** Long sessions stay under the context limit longer.
- **More focused answers.** The context holds the code that matters, not everything near it.
- **Fewer wrong guesses.** Signatures, callers and base classes come from the parsed code, not from skimming.

**Fewer round trips matter most.** Every tool call makes the assistant send the whole conversation again, so a question answered in fewer calls saves far more than a smaller answer. That's why RefDex's answers include what the assistant would ask for next: the callers' code with the list of callers, the code of a single exact search match, several symbols in one read.

### Measured on a real codebase

Claude Code (Claude Sonnet 5) answered questions about Google's Guava (3,275 Java files) with and without RefDex, three or five times each, and every answer was checked against the known one. The method and the full results are in the `bench/` folder of the RefDex repository.

| Questions | Cost with RefDex | Correct answers |
| --- | --- | --- |
| Who calls a method, which tests reach it (4 tasks) | **12% less**; finding the tests that reach a method through helpers, 20–31% less | As many as without RefDex |
| Tracing a flow, planning a change, understanding a large class (5 tasks) | About the same (2% more) | All correct, with and without |

On the flow questions the assistant looks up one name after another, much as it would read files, and Claude Code spends one extra step loading RefDex's tool definitions the first time it uses them; together that cancels the savings there. Turning that loading off (Claude Code's `ENABLE_TOOL_SEARCH=false`) doesn't help: Claude Code then sends all of its own tool definitions with every request too, and the same questions cost about 60% more.

**RefDex steps aside where it wouldn't pay off.** The tools have a fixed cost: their definitions, about 1,300 tokens, are sent with every request an assistant makes. On a small project, reading the files is cheaper. So RefDex offers its tools only once the indexed code reaches about 100,000 tokens (roughly 400 KB of source). Below that, Copilot doesn't start it and Claude Code sees no RefDex tools. The status bar shows which applies and why, and the `refdex.aiTools` settings change it.

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
| `get_context` | "Where do I start on this task?": a small overview of unfamiliar code, the bodies of the methods the task names and the signatures of what they call and what calls them, in a token budget (default 1,500, at most 3,000). Can also start from given names or from the symbols changed in git |
| `get_repo_map` | "What matters in this codebase?": the most-used symbols with signatures, grouped by file, within a token budget; optionally for one folder |
| `search_symbols` | "Where is X?": classes, functions, methods, properties and fields by name or prefix, filtered by kind or language. A single exact match comes with its code |
| `get_file_outline` | "What's in this file?": imports (and where they resolve), plus every signature and line range, nested by class |
| `get_symbol_source` | "Show me this code": the source of one or several symbols (up to 10 per call) from disk, every overload and partial-class part; `with_callees` adds what they call |
| `find_references` | "Who uses this, and what breaks if I change it?": calls, subclasses, implementations and type references, each with the calling method and the code of the first callers, plus imports; then the blast radius: callers of the callers (two levels by default, `depth` up to 5), including calls through the interfaces and base methods it implements, and the tests that reach it. In Java and C#, calls are followed through declared types (`source.copyTo()` on a typed variable, `segmentFor(h).put()` on a method's return value) |

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

## Loading the code graph into Neo4j

RefDex can load its index into [Neo4j](https://neo4j.com), as a graph to query and explore. Files and symbols become nodes. Declarations, calls, base types, type references and imports become relationships. Each workspace folder becomes a repository of an app named after the workspace, so the folders of a multi-root workspace sit side by side and can be queried together.

### A local Neo4j

By default, RefDex connects to Neo4j on your own computer with these settings:

| | Default |
| --- | --- |
| Address (Bolt) | `neo4j://localhost:7687` |
| Neo4j Browser | http://localhost:7474 |
| User | `neo4j` |
| Password | `refdex-local` |

With Docker, save this as `compose.yaml` and run `docker compose up -d`. It starts a Neo4j with exactly these settings:

```yaml
services:
  neo4j:
    image: neo4j:latest
    container_name: refdex-neo4j
    restart: unless-stopped
    ports:
      - "127.0.0.1:7474:7474"
      - "127.0.0.1:7687:7687"
    environment:
      NEO4J_AUTH: neo4j/${NEO4J_PASSWORD:-refdex-local}
    volumes:
      - refdex-neo4j-data:/data
volumes:
  refdex-neo4j-data:
```

Neo4j doesn't accept `neo4j` as a password, or passwords shorter than 8 characters, so the local default is `refdex-local`. The ports listen on your computer only, because this password is public. To choose your own, start the container with `NEO4J_PASSWORD` set, and enter that password when RefDex asks for it.

With Neo4j Desktop, create a local database: it listens on the default address. Either give it the password `refdex-local`, or enter the password you chose when RefDex asks.

### Loading

Run **RefDex: Load into Neo4j…**, or use the button in the RefDex panel. In a multi-root workspace, pick the folders to load. RefDex loads them in the background and shows progress in a notification, where you can cancel. Loading a folder again replaces only that folder's part of the graph. Then open Neo4j Browser (http://localhost:7474 for a local Neo4j).

### Starter queries

New to Cypher, Neo4j's query language? Each load stores ready-to-run queries with the app. They use real names from your code, such as your most called method and your largest file, so each one finds something on its first run, and its description says what to change to ask something else. Run **RefDex: Neo4j Starter Queries…**, or use the button in the RefDex panel, and pick one. RefDex copies it; paste it into Neo4j Browser's editor and press Ctrl+Enter (Cmd+Enter on a Mac). Queries marked as a graph draw nodes you can drag and click; the others show a table. **Open all in an editor** shows every query with its description.

| Starter query | What it shows |
| --- | --- |
| Map of the app | The app and its repositories, as a graph |
| What each repository contains | Classes, methods, functions and so on, counted per repository |
| The most important code | The 25 symbols the rest of the code relies on most (PageRank) |
| Everything in a file | The largest file, with what it declares and their members |
| Where a class is used | Everything that calls or refers to the most used class |
| Who calls a method | The callers of the most called method, and their callers |
| What a method calls | What the method calling the most other code depends on, two steps deep |
| Class hierarchy | Classes and the types they extend or implement |
| Which files depend on which | Files and the files they import |
| Files that import each other | Pairs of files that import each other |
| The largest classes | Classes and interfaces with the most members |
| Code nothing seems to use | Methods and functions nothing in the index calls (check before deleting) |
| Find code by name | Symbols whose name contains a given text |

They are also in Neo4j itself, for any client: `MATCH (q:StarterQuery) RETURN q.title, q.description, q.cypher ORDER BY q.order` lists them.

### Your own server, or Neo4j online

The defaults are for a local setup only. To use Neo4j Aura, a shared server or a production database, run **RefDex: Connect to Neo4j…** and enter its address, user and password. RefDex checks them before saving them. Aura and other servers with TLS use `neo4j+s://` addresses. The address, user and database are also settings: `refdex.neo4j.uri`, `refdex.neo4j.username` and `refdex.neo4j.database`. `refdex.neo4j.app` sets the app's name.

On a shared server, RefDex labels every node it creates `:RefDex`, and adds constraints and indexes on the labels `App`, `Repository`, `File`, `Symbol` and `External`. The user needs permission to create nodes, constraints and indexes. A database of its own keeps the graph apart from other data.

### Where the password is kept

RefDex keeps the password in VS Code's secret storage, which encrypts it with your operating system's credential store: Keychain on macOS, DPAPI on Windows, and the Secret Service (GNOME Keyring or KWallet) on Linux. RefDex never writes the password to settings or files. It passes it to the background loader in that process's environment, not on its command line, which other users of the computer can see. **RefDex: Forget Neo4j Password** removes it. When no password is saved, RefDex uses the local default for a server on this computer only.

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
| RefDex: Load into Neo4j… | Load workspace folders into Neo4j as repositories of an app |
| RefDex: Neo4j Starter Queries… | Ready-to-run queries for exploring the graph, to copy into Neo4j Browser |
| RefDex: Connect to Neo4j… / Forget Neo4j Password | Set the Neo4j server and login, or remove the saved password |
| RefDex: Toggle Watching for Changes | Turn automatic updates on or off |
| RefDex: Show Log | Every MCP call and index query |

## Settings

| Setting | Default | |
| --- | --- | --- |
| `refdex.include` | `[]` | Only index paths matching these patterns (`.gitignore` syntax), such as `src/` or `services/**/*.cs`. Empty means everything |
| `refdex.exclude` | `[]` | Extra paths to leave out, such as `generated/` or `**/*.test.ts` |
| `refdex.languages` | `[]` | Languages to index. Empty means all |
| `refdex.watch` | `true` | Keep the index up to date as files change |
| `refdex.aiTools` | `auto` | When AI clients get RefDex's tools: `auto` (once the codebase is large enough), `always` or `never` |
| `refdex.aiToolsMinTokens` | `100000` | Size of the indexed code, in estimated tokens, from which `auto` offers the tools |
| `refdex.neo4j.uri` | `neo4j://localhost:7687` | Neo4j server for Load into Neo4j. The default is one on this computer |
| `refdex.neo4j.username` | `neo4j` | Neo4j user. The password is kept in secret storage, not in settings |
| `refdex.neo4j.database` | `""` | Database to load into. Empty means the server's default |
| `refdex.neo4j.app` | `""` | The app the folders are loaded into. Empty means the workspace's name |
| `refdex.neo4j.includeExternal` | `false` | Also load uses of names outside the index, such as library calls |

## Privacy

RefDex runs entirely on your machine. The index is a SQLite database in VS Code's storage for the workspace, not in your repository. Nothing is uploaded. Your assistant sees only the answers to the tool calls it makes, and those calls appear in the log.

The one exception is **Load into Neo4j**, and only when you run it. It sends the code graph to the Neo4j server you set: names, signatures, doc comments, file paths and line numbers, not the code itself. By default, that server is on your own computer.

## Requirements

- VS Code 1.101 or later. RefDex runs on VS Code's own runtime, so no Node.js install is needed.
- For Copilot: GitHub Copilot Chat with agent mode.
- For Claude Code: the Claude Code extension or CLI.

## Known limitations

- RefDex links calls by scope and imports, without full type inference. A call on a variable whose type RefDex can't see is linked only when exactly one visible type declares that method, or when all of them are one type hierarchy (an interface and its implementations). `find_references` then also lists other lines that mention the name, so you can review them.
- The blast radius follows linked calls only. Calls on the result of another call (`Joiner.on(",").join(…)`), reflection and dependency injection aren't followed; when there are unlinked calls that could lead to the method, the answer says so and shows an example, so an empty blast radius isn't mistaken for a safe change. "Tests that reach it" means tests that call it through that call graph, not runtime coverage.
- Dynamic code (Python `getattr`, reflection, code generated at build time) isn't indexed.
- In a multi-root workspace, one folder is indexed and kept current at a time. **Load into Neo4j** loads each folder's index as it was last updated, so a folder you haven't selected recently may be out of date in Neo4j.
- Each repository's graph in Neo4j is separate: calls from one workspace folder into another aren't linked.
