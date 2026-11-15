![RefDex: understand your codebase](docs/images/refdex-banner.png)

# RefDex

[![VS Code Marketplace](https://vsmarketplacebadges.dev/version/danielonnet.refdex.svg?label=VS%20Code%20Marketplace)](https://marketplace.visualstudio.com/items?itemName=danielonnet.refdex)
[![Installs](https://vsmarketplacebadges.dev/installs-short/danielonnet.refdex.svg)](https://marketplace.visualstudio.com/items?itemName=danielonnet.refdex)
[![JetBrains Marketplace](https://img.shields.io/jetbrains/plugin/v/34561?label=JetBrains%20Marketplace)](https://plugins.jetbrains.com/plugin/34561-refdex)
[![Downloads](https://img.shields.io/jetbrains/plugin/d/34561)](https://plugins.jetbrains.com/plugin/34561-refdex)

**A code index for AI assistants. Claude Code, GitHub Copilot and Junie can look code up instead of reading whole files, so each task uses fewer tokens and they find their way around a large codebase.**

RefDex parses TypeScript, Python, Java and C# into a local SQLite index of every class, method, function and property: signatures, doc comments, resolved imports and a call graph. An MCP server lets AI assistants query it. Instead of reading a 900-line file to find one method, the assistant asks for the file's outline, or for just that method, or for everything that calls it.

- **Prompt optimization:** the context window holds the code the task needs, not whole files around it. For example, Guava's 1,148-line `CacheBuilder.java` costs about 13,200 tokens to read whole, about 1,100 as an outline, and about 140 for one method.
- **Large codebases:** incremental, hash-based updates (a saved file in 40–60 ms on a generated 3,000-file project), background indexing, monorepo and namespace-aware import resolution, and a PageRank repo map that shows an assistant the core of an unfamiliar codebase first.
- **No setup:** inside VS Code, RefDex registers with Copilot automatically and connects to Claude Code with one command. In IntelliJ-based IDEs, one action connects Claude Code, Junie or Copilot. The index stays on your machine.

The VS Code Marketplace page, with features, tools, commands and settings, is [packages/vscode/README.md](packages/vscode/README.md). The IntelliJ plugin is described in [plugins/intellij/README.md](plugins/intellij/README.md). The design and roadmap are in [docs/refdex-project-plan.md](docs/refdex-project-plan.md).

## Status

| Part | State |
| --- | --- |
| VS Code extension | Published on the VS Code Marketplace (0.1.3) |
| IntelliJ plugin | 0.1.2 uploaded to the JetBrains Marketplace and waiting for JetBrains' review. Works in IntelliJ-based IDEs 2025.3 and later. Its zip bundles the daemon executable for Linux x64 only; on macOS and Windows it needs Node.js 22.13+ on PATH until CI builds those executables |
| Token benchmark | First results on Guava below. Next: other languages' repositories and Copilot |
| Open work | From Phase 5 of the plan: per-language fixture repos and a performance test on a large repo |

## Benchmark results

Does RefDex make an AI agent spend fewer tokens on the same task? [bench/](bench/README.md) runs the same questions in Claude Code with and without RefDex and checks every answer against the known one. Latest runs, 2026-10-03 and 2026-10-04: RefDex `2379014` (the 2026-10-04 run records `3299659`, which changed only documentation), Claude Sonnet 5, Claude Code 2.1.283, Guava at `4d41665af1` (3,275 Java files, 79,884 symbols).

Three setups, identical except for RefDex: **baseline** (no RefDex), **RefDex** (offered; the agent decides whether to use it, as in real use) and **directed** (RefDex plus one instruction to use it, which shows what it saves when used). Cost counts every token the model processed, priced as if nothing was cached before the run; the overall figure is the geometric mean of the per-task median ratios.

| Suite | Runs | Cost, RefDex | Cost, directed | Correct (baseline / RefDex / directed) | RefDex used (RefDex / directed) |
| --- | --- | --- | --- | --- | --- |
| [Callers and tests](bench/results/2026-10-03T18-54-44-guava-accuracy/report.md): 4 tasks | 3 per setup | **−12%** | **−12%** | 11/12, 10/12, 11/12 | 4 of 12 runs, 10 of 12 |
| [Flows and plans](bench/results/2026-10-03T19-14-03-guava-long/report.md): 5 tasks | 5 per setup | +2% | +8% | 25/25 in all three | 6 of 25 runs, 18 of 25 |
| [Flows and plans, tool search off](bench/results/2026-10-04T19-24-01-guava-long/report.md): 5 tasks | 5 per setup | +6% | +12% | 25/25 in all three | 20 of 25 runs, 22 of 25 |

What the runs show:

- **Turns, not answer size, decide the cost.** Each tool call re-sends the whole conversation (about 35,000 tokens per turn here). RefDex saves where one call replaces several rounds of searching: finding the tests that reach a method through helpers took 5–7 turns instead of 12 (−20% offered, −31% directed), and callers through a base type cost 19% less.
- **On flow questions the gain is used up.** The agent looks names up one at a time, much as it reads files, and every session that uses RefDex spends one extra turn on Claude Code's `ToolSearch`, which loads deferred MCP tool definitions on first use. Searching several names per call would not help: the agent already makes most of its searches in parallel within a turn.
- **Turning Claude Code's tool search off doesn't pay.** With `ENABLE_TOOL_SEARCH=false` (the third row, which applies it to every setup) the `ToolSearch` turn is gone, but Claude Code also sends the full definitions of its own deferred built-in tools, about 24,000 more tokens with every request. Against the default baseline, every setup got more expensive: baseline +53%, RefDex +62%, directed +71%. Keep tool search on. One side effect is telling, though: with every definition visible, the agent chose RefDex in 20 of 25 runs instead of 6.
- **What changed to get here:** calls linked through declared types (Java, C#: 24% more calls linked on Guava, and `find_references` finds callers it missed before), `find_references` with two levels of callers and the callers' code by default and recommended first, `get_symbol_source` for several names, code with a single exact search match, and a smaller `get_context` (whose large answers had made flow questions 17–25% more expensive).

Reproduce with `node bench/run.ts --tasks bench/tasks/guava-accuracy.json --source <guava checkout> --runs 3 --arms baseline,refdex,directed`, then `node bench/report.ts <results folder>`.

## Layout

| Path | Contents |
| --- | --- |
| `packages/core` | Language adapters, workspace scan, SQLite index and incremental indexer |
| `packages/server` | The `refdex` CLI, the daemon (`refdex serve`: worker-thread indexing, file watcher) and the MCP server (`refdex mcp`); builds to a single executable |
| `packages/vscode` | VS Code extension: daemon lifecycle, Copilot and Claude Code setup, status bar report, database browser. Its `README.md` is the Marketplace page |
| `neo4j/compose.yaml` | A local Neo4j with RefDex's default address and login, for `refdex neo4j load` and Load into Neo4j |
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

Tools: `get_context` (the code a task needs, within a token budget), `get_repo_map`, `search_symbols`, `get_file_outline`, `get_symbol_source` (optionally `with_callees`), `find_references` (optionally `depth` for the blast radius: indirect callers and the tests that reach a symbol). In the IDEs you don't need this by hand: the VS Code extension registers RefDex with Copilot automatically, and "RefDex: Connect Claude Code…" adds it to Claude Code for the open project. In IntelliJ, **Tools | RefDex | Connect AI Client…** does the same for Claude Code, Junie and Copilot.

### The code graph in Neo4j

RefDex can load the index into [Neo4j](https://neo4j.com) as a graph to query and explore. Files and symbols become nodes, and declarations, calls, base types, type references and imports become relationships. Each repository is a section of an app: one Neo4j database holds several repositories side by side, such as the folders of a VS Code workspace, and loading a repository again replaces only its own part. In VS Code it's **RefDex: Load into Neo4j…** (see [packages/vscode/README.md](packages/vscode/README.md)). From the command line it's `refdex neo4j load`.

**A local Neo4j with RefDex's defaults.** [neo4j/compose.yaml](neo4j/compose.yaml) starts `neo4j:latest` with the address and login RefDex uses when nothing is configured, so no settings are needed:

```sh
docker compose -f neo4j/compose.yaml up -d
```

| | Default |
| --- | --- |
| Address (Bolt, what RefDex connects to) | `neo4j://localhost:7687` |
| Neo4j Browser | http://localhost:7474 |
| User / password | `neo4j` / `refdex-local` |

Neo4j doesn't accept `neo4j` as a password, or passwords shorter than 8 characters, so the default is `refdex-local`. The ports listen on this computer only, because this password is public. RefDex uses the default only for a server on this computer, and only when no password is set. A Neo4j Desktop database on the default port works the same way, with its own password.

```sh
node packages/server/dist/refdex.cjs index --root /path/to/backend
node packages/server/dist/refdex.cjs neo4j load --root /path/to/backend --app shop    # repository "backend" of app "shop"
node packages/server/dist/refdex.cjs neo4j check                                      # the server, and the apps loaded so far
```

**Your own or an online server.** The defaults are for local development only. For Neo4j Aura, a shared server or a production database, pass its address and user, and put the password in `REFDEX_NEO4J_PASSWORD`. RefDex reads the password only from the environment, never from the command line, which other users of the computer can see. In VS Code, **RefDex: Connect to Neo4j…** stores it in VS Code's secret storage, which is backed by the operating system's keychain.

```sh
REFDEX_NEO4J_PASSWORD="$(cat ~/.config/refdex/neo4j-password)" \
  node packages/server/dist/refdex.cjs neo4j load --root . --app shop \
  --uri neo4j+s://<id>.databases.neo4j.io --user neo4j --database neo4j
```

`--repo` names the repository (by default, the folder's name). `--external` adds uses of names outside the index, such as library calls, as `(:External {name})` nodes. The loader needs Neo4j 5 or later; it was tested with 5.26 and 2026.10. On a shared server, RefDex labels every node it creates `:RefDex`, and adds constraints and indexes on the labels `App`, `Repository`, `File`, `Symbol` and `External`.

| Node or relationship | Properties and meaning |
| --- | --- |
| `(:App)-[:HAS_REPOSITORY]->(:Repository)-[:HAS_FILE]->(:File)` | `App.name`; `Repository.name`, `files`, `symbols`, `relationships`, `loadedAt` |
| `(:App)-[:HAS_QUERY]->(:StarterQuery)` | `title`, `description`, `cypher`, `order`: queries to start exploring with (below) |
| `(:File)` | `app`, `repo`, `name`, `path` (relative to `--root`), `language`, `project` |
| `(:Symbol)`, with its kind as a second label: `:Class`, `:Method`, … | `app`, `repo`, `name`, `qualifiedName`, `signature`, `doc`, `path`, `startLine`, `endLine`, `pagerank` |
| `(:File)-[:DECLARES]->(:Symbol)` | The file's top-level declarations |
| `(:Symbol)-[:CONTAINS]->(:Symbol)` | Class to method, namespace to class |
| `(:File)-[:IMPORTS {lines}]->(:File)` | Resolved imports |
| `-[:CALLS\|EXTENDS\|IMPLEMENTS\|REFERENCES {count, lines}]->(:Symbol)` | Linked uses, from a symbol, or from a file for module-level code |

The parts of a C# partial type become one node. Each repository's graph is separate: calls from one repository into another aren't linked.

**Starter queries for people new to Cypher.** Each load stores ready-to-run queries with the app, as `(:App)-[:HAS_QUERY]->(:StarterQuery {title, description, cypher})`. They use real names from the code, such as the most called method and the largest file, so each one finds something on its first run, and its description says what to change to ask something else. The names come from the app's largest repository. To list them, run this in Neo4j Browser, then copy a `cypher` value into the editor and run it:

```cypher
MATCH (q:StarterQuery) RETURN q.app AS app, q.title AS title, q.description AS description, q.cypher AS cypher ORDER BY app, q.order
```

In VS Code, **RefDex: Neo4j Starter Queries…** copies one for you or opens them all in an editor. `refdex neo4j queries --root <dir> --app <name>` prints them as a Cypher file without connecting to Neo4j.

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

**Without a connection.** `refdex export-neo4j <out.cypher> --root <dir> [--app <name>]` writes the same graph as a Cypher script, to run with `cypher-shell -f`. This suits small codebases only. A script inlines every row, so Neo4j parses and caches each batch as a separate query: at 80,000 symbols, a server with a 1 GB heap ran out of memory, while `refdex neo4j load` loaded the same graph in about 90 seconds.

### Debug builds: the MCP server over HTTP

For testing the tools with curl instead of typing JSON-RPC into stdio, set `"debug": true` in [refdex.build.json](refdex.build.json) and rebuild (`npm run build`). The daemon bundles then include `refdex mcp --http <port>`: the same tools over MCP's Streamable HTTP transport, on `127.0.0.1` only, one stateless POST per request:

```sh
node packages/server/dist/refdex.cjs mcp --root /path/to/project --http 7337 --tools always

curl -s http://127.0.0.1:7337/mcp -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search_symbols","arguments":{"query":"OrderService"}}}' \
  | jq -r '.result.content[0].text'
```

`tools/list` lists the tools; any other tool works like `search_symbols` above. Keep `"debug": false` for releases: the HTTP code is then left out of both bundles (about 190 KB), and `--http` says it needs a debug build. Running from source (`npm run dev`, the tests) always includes it.

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
