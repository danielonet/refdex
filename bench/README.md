# Token benchmark

Does RefDex make an AI agent use fewer tokens for the same task? `bench/run.ts` runs the same tasks in
Claude Code with and without RefDex and records what each run used; `bench/report.ts` compares them.

```sh
npm run build -w @refdex/server
node bench/run.ts --tasks bench/tasks/guava.json --source ~/git/guava --runs 3   # needs the `claude` CLI, logged in
node bench/report.ts bench/results/<run folder>
```

## Method

**Two setups, identical except for RefDex.** Every run is a fresh `claude -p` session:

- `--strict-mcp-config` with an MCP config that is empty (baseline) or holds only RefDex (`--tools always`);
- `--setting-sources ""`: no user, project or local settings;
- `--no-session-persistence`, and a git worktree of the target repository at the suite's commit under
  `bench/work/`, a path Claude Code has no memory or CLAUDE.md for;
- the same model (`--model`, default Claude Sonnet 5) and the same prompt. The prompt doesn't mention
  RefDex: the agent decides whether to use it, as in real use;
- read-only tools only (`Read` and read-only shell commands such as `rg`), and no subagents, so every
  token is in the session's own usage.

A third setup, **directed** (`--arms baseline,refdex,directed`), is `refdex` plus one instruction appended to
Claude Code's system prompt (`--append-system-prompt`, like a CLAUDE.md rule) telling the agent to use RefDex
(find_references for callers and tests, search_symbols, get_symbol_source); the task prompt stays the same. It answers a different question: what RefDex
saves when the agent uses it. In `refdex` the agent often doesn't, so the gap between the two is what better
tool descriptions and instructions could win. `setup.json` records the instruction.

Runs rotate which setup goes first, so none always runs after another.

**Tokens, not the bill.** For every API call Claude Code reports uncached input, cache-write input,
cache-read input and output. Their sum is the context the model processed, which prompt caching doesn't
change, so that is the main measure. Caching only changes the price, and a run can start with a warm
cache left by an earlier run of the same setup (Claude Code caches for an hour). So cost is computed,
not taken from the bill (`bench/cost.ts`): caching inside a run counts, as for any user, and nothing
before the run does. Claude Code's reported cost is kept in `runs.jsonl` for reference.

**Correct answers only.** Each task has an answer checked against the source (`check` in the task file:
regular expressions that must all match the `ANSWER:` line). A cheaper wrong answer is a failure, not a
saving; the report shows pass rates next to costs.

**Medians of several runs.** Agents take different paths on the same prompt, so each task runs several
times per setup and the report uses medians. The overall figure is the geometric mean of the per-task
cost ratios, so one expensive task doesn't dominate.

## What to keep in mind

- Claude Code defers MCP tool definitions: it lists their names and loads a definition with `ToolSearch`
  when the agent first uses a tool. RefDex's standing cost there is small (about 370 tokens per request),
  but using it costs an extra turn. Clients that load definitions up front (Copilot) pay about 1,200
  tokens per request instead.
- The tasks are small, single questions. Savings, if any, should grow with longer sessions that read
  more code; a longer-task suite is the next step.
- Results depend on the model, the Claude Code version and the repository; `setup.json` in each results
  folder records them.
