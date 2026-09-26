# RefDex IntelliJ plugin

The Kotlin plugin for IntelliJ-based IDEs (2025.3 and later). Like the VS Code extension, it is a thin
shell: it starts the bundled `refdex serve` daemon for the project, shows the index state, and registers
`refdex mcp` with AI clients. All indexing lives in the daemon; the plugin does not use PSI.

| Piece | What it does |
| --- | --- |
| Daemon | Started when a project opens, with the index in the IDE's system directory (`<system>/refdex/<project>-<hash>/index.db`). It indexes the project on first use, then watches files. |
| Status bar widget | `RefDex: 80 files`, with symbols, imports, last index time and the AI tools decision in its tooltip. A click opens the RefDex menu. |
| Tools \| RefDex | Reindex Project, Rebuild Index, Connect AI Client…, Settings… |
| Settings \| Tools \| RefDex | Include/exclude globs, languages, file watching, when to offer the AI tools, and a daemon override |
| Connect AI Client | Claude Code (local scope via its CLI, or the project's `.mcp.json`), Junie (`.junie/mcp/mcp.json`), GitHub Copilot (its global `mcp.json`, one entry per project; needs an IDE restart). For JetBrains AI Assistant, which has no config file other plugins can write, it copies a snippet to paste into its settings. |

Existing entries are rewritten when the plugin moves the daemon (an update) or the AI tools settings
change. The plugin never creates an entry you did not ask for.

## Which daemon runs

1. The daemon set in Settings | Tools | RefDex, if any: an executable or a `refdex.cjs` bundle.
2. The single executable for this platform, `daemon/<platform>-<arch>/refdex` in the plugin.
3. Node.js 22.13+ on PATH, running the bundled `daemon/refdex.cjs` (grammars in `daemon/wasm/`).

The build ships the executable for the platform it runs on; other platforms use step 3 until CI
builds their executables.

## Development

Requires JDK 21 and Node 22.18+ (for the daemon build). The Gradle wrapper downloads Gradle and the
IntelliJ Platform SDK.

```sh
./gradlew test          # builds and stages the daemon, then runs the unit and daemon tests
./gradlew buildPlugin   # build/distributions/refdex-intellij-<version>.zip
./gradlew runIde        # a sandbox IDE with the plugin installed
./gradlew verifyPlugin  # checks compatibility with the IDEs the plugin supports
```

`-PskipDaemonBuild` skips `npm run build:sea` and stages whatever `packages/server/dist` holds.
