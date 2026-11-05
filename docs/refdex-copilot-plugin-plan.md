# RefDex Plugin for the GitHub Copilot App Plan

2026-10-08

> **Dropped (2026-10-09).** The plugin for the GitHub Copilot app turned out not to be the right solution. The work continues in [refdex-host-plan.md](refdex-host-plan.md). This document is kept as research notes (Agent Plugins format, awesome-copilot submission).

## Overview and goals

The GitHub Copilot app is a standalone desktop workspace (macOS, Linux, Windows) for agent-driven work. It has a Customize section for MCP servers, plugins and skills, and a default marketplace, awesome-copilot (https://awesome-copilot.github.com). This plan adds a RefDex plugin for it. There is no IDE, so the plugin has no interface of its own: it starts `refdex mcp`, which builds and updates the index itself.

- Installable from the awesome-copilot marketplace.
- No separate setup: opening a repo in the app is enough for the tools to work.
- The VS Code extension and IntelliJ plugin are not affected.

This replaces the standalone host as the next piece of work. The host plan ([refdex-host-plan.md](refdex-host-plan.md)) is on hold.

## Decisions

| Question | Decision |
| --- | --- |
| Distribution | Submit to awesome-copilot as an external plugin. No own marketplace |
| Indexing | `refdex mcp` indexes and watches by itself, behind an opt-in flag |
| Testing | Build locally and install into the app directly (to verify, see below) |
| IDE behavior | `refdex mcp` without the new flag behaves exactly as today |

## What is known and what is not

Known (awesome-copilot CONTRIBUTING.md):
- A plugin is a folder with `plugin.json` and a README. Required fields: `name`, `description`, `version`, `author`, `repository`, and `extensions.com.github.awesome-copilot` (the content it bundles); `license` is recommended.
- External plugins in a public GitHub repo are accepted through an issue form. They need a pinned `sha` or `ref`, `source.source: "github"`, and pass automated lint and install tests before maintainers approve. Entries follow the Claude Code plugin marketplace spec.

Known (Agent Plugins 1.0, an open standard announced 2026-08-12 that packages agent skills and MCP servers into one installable plugin; it works in VS Code, Copilot CLI and the Copilot app; sources: the [GitHub changelog](https://github.blog/changelog/2026-08-12-agent-plugins-1-0-in-vs-code-copilot-cli-and-the-copilot-app/), [agent-plugins.org](https://agent-plugins.org/plugin-authors), [josh-ops.com](https://josh-ops.com/posts/github-copilot-plugins/)):
- Layout: `plugin.json` at the root; `skills/<name>/SKILL.md` (markdown with `name` and `description` frontmatter); `mcp.json` at the root for MCP servers; an optional `com.github.copilot/` folder for Copilot-only content (agents, commands, rules, hooks) that other clients ignore. Plugin-relative paths start with `./` and symlinks may not leave the package.
- `plugin.json` starts with `"$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json"`, then `name`, `version`, `description`.
- Local test in Copilot CLI: `copilot plugin install ./your-plugin`, then `copilot plugin list`.
- Because the standard is shared, one RefDex plugin should also work in VS Code and Copilot CLI, not only the app.

Corrections to a pasted summary of this standard (a Google result), which I checked against the sources above: skills are folders with a `SKILL.md`, not `.json` files; the `$schema` is the agent-plugins.org URL, not schemastore.org; the `supportedContexts` field and the `agents.json` format were not confirmed anywhere, so the plan does not use them.

Found in the Phase 1 reading (the [specification](https://agent-plugins.org/specification), awesome-copilot's `plugins/` and `plugins/external.json`, and the Netlify and Datadog plugin repositories):
- **`mcp.json` format.** Top-level keys are `$schema` (`https://agent-plugins.org/schemas/1.0.0/mcp.schema.json`) and `mcpServers`, nothing else. A stdio server has `type: "stdio"`, `command` (one executable token, not a shell string), and optional `args`, `env` and `cwd`. Remote servers use `type: "streamable-http"` and `url`.
- **Variables.** `${PLUGIN_ROOT}` (the installed plugin folder) and `${PLUGIN_DATA}` (a writable per-plugin folder) expand in `args`, `env` values and `cwd`. They do not expand in `command`.
- **`command` rule.** It must be a bare name found on the PATH (clients decide whether the PATH is used, so a plugin must not rely on it) or a plugin-relative path starting with `./`. `cwd` may only point inside the plugin folders.
- **How external plugins are listed.** `plugins/external.json` has 117 entries, each with name, description, version, author, repository, license, keywords and `source: {source: "github", repo, ref?, sha}`. Some bundle an MCP server: Netlify (`agent-plugin/mcp.json`, a hosted `streamable-http` server) and Datadog (`plugin.json` with `"mcpServers": "./.dd_copilot_mcp.json"` and `"skills": "./skills/"`). The in-repo plugins I looked at (for example flowstudio-power-automate) declare only skills.
- **No stdio example.** Every bundled server I found is a hosted HTTP server. I found no plugin that starts a local executable, so how the app handles one, and where it runs it, is untested.

Still unknown (needs the app, or the plugin author docs):
- **Which repo is open.** `cwd` cannot point at the user's repo, so the server's working directory is whatever the client chooses. Two ways RefDex can learn the repo: default `--root` to the working directory, or ask the client for its workspace folders with the MCP `roots/list` request. Neither is confirmed for the app.
- Whether the app installs a local plugin the way the CLI does (`copilot plugin install ./dir` is confirmed only for the CLI).
- Whether the external-plugin issue form wants the Agent Plugins manifest or the Claude Code marketplace entry shown above (it looks like the entry above plus a normal `plugin.json` in the repository).

## Work

### Phase 1: Spike (no repo changes)

- Read one existing awesome-copilot plugin that bundles an MCP server, and the validator (`npm run plugin:validate`) to learn the manifest fields.
- By hand, add `refdex mcp --root <repo>` as a custom MCP server in the app's Customize section, using the Linux executable. Confirm the tools appear and work against an index built by `refdex index`.
- Find out how the app starts a server and which folder it runs in.
- Done when: the four unknowns above are answered and written into this plan.

### Phase 2: `refdex mcp` indexes by itself

- New opt-in flag `--index` (and `REFDEX_INDEX=1`), off by default so IDE use is unchanged. When set, `refdex mcp` starts the index worker and the file watcher in the same process, runs a first index in the background, and keeps the index up to date.
- Reuse the existing pieces: `startIndexWorker`, `TreeWatcher` and the queue from `serve.ts`. Extract the queue into a shared function that `serve.ts` and `mcp.ts` both call; the stdio protocol of `serve` stays identical.
- While the first index is running, tools answer with a clear "indexing, N of M files" message instead of empty results. The existing `auto` tools mode (off below about 100,000 tokens of code) stays as is.
- **Do not index twice.** If an IDE daemon is already writing the same database, `--index` must detect that and stay read-only. Use a lock file beside the database, held by whichever process indexes.
- Done when: new tests cover the first index, an edit being picked up, and the lock case; the baseline in Risks is identical afterwards.

### Phase 3: Getting the executable to users

Only a Linux x64 executable exists today (`build:sea`). Because `command` must be a bare name or a `./` path, and cannot use variables, the plugin cannot say "run the executable that matches this OS" directly. Options, to choose after the Phase 1 spike:
- **A launcher.** `command: "node"`, `args: ["${PLUGIN_ROOT}/bin/launch.mjs", "mcp", "--index"]`. The small script downloads the right executable from the GitHub release into `${PLUGIN_DATA}` on first run, checks its hash, and runs it. Needs Node on the PATH, which the app may not guarantee.
- **`npx`.** `command: "npx"`, `args: ["-y", "@refdex/cli", "mcp", "--index"]`. Simplest to publish; needs Node 22.18+ because of `node:sqlite`.
- **Ship the executables inside the plugin** as `./bin/refdex-<os>-<arch>`, with a launcher or one entry per platform. Large package; plugin size limits are unknown.

Earlier options, for reference:
- **Executables per OS** from CI (macOS arm64 and x64, Windows x64, Linux x64 and arm64), attached to a GitHub release, with the plugin downloading the right one on first use. The IntelliJ plugin needs the same builds.
- **npm package** run with `npx`; needs Node 22.18+ on the user's machine because of `node:sqlite`.

The executables are the better fit for a plugin that should need no setup. The npm package is a fallback and a smaller first step.

### Phase 4: The plugin

- A plugin folder: `plugin.json` (with the Agent Plugins `$schema`), a README, `skills/refdex/SKILL.md` that tells the agent when to use RefDex (who calls a method and which tests reach it, outlines instead of whole files, symbol source for specific methods; it reuses the wording of the MCP server's instructions), and `mcp.json` with the entry that starts `refdex mcp --index`, with the repo folder passed the way Phase 1 found.
- Test locally with `copilot plugin install ./refdex-plugin` in Copilot CLI first (confirmed command), then in the Copilot app and VS Code, which should read the same package.

### Phase 5: Submission

- Tag a release and pin the `sha`.
- Run `npm run plugin:validate` in a fork of awesome-copilot.
- Open the external-plugin issue with the repository URL and pinned `sha`; respond to the automated checks and maintainers.
- Add a README section and a changelog entry in this repository.

## Risks

- **IDE regression.** Phase 2 touches `packages/server`, which both IDE products bundle. Before changing it, run `npm test`, `npm run check-types` and `refdex selftest` on a built executable and record the results; they must be identical afterwards. Keep the IntelliJ files with uncommitted changes off the branch.
- **Two indexers on one database.** Covered by the lock file in Phase 2. Without it, an IDE and the app would do the same work twice.
- **Unverified plugin format.** The manifest is only partly documented. Phase 1 exists to remove this before any build.
- **Review.** External plugins go through maintainer approval, so timing is outside our control. Local installation covers testing in the meantime.
- **Third-party warning.** The marketplace tells users to inspect third-party plugins. The README should say plainly that the plugin runs a local executable and that the index stays on the machine.
