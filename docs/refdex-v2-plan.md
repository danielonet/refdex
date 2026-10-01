# RefDex v2 — Bounded Context Plan

Oct 2, 2026 · @Daniel

## Overview and goals

RefDex v2 turns the v1 symbol index into a context engine: given a task and a token budget, it returns the smallest bounded slice of the codebase the AI needs. It follows the v1 release and takes about 6–8 weeks part-time.

- **Bounded context:** one `get_context(task, budget)` call returns ranked signatures, docs and only the method bodies that matter, never over budget.
- **Cache-friendly map:** a deterministic repo map that AI clients can prompt-cache across turns.
- **Provable savings:** every response reports tokens returned versus tokens a whole-file read would have cost.
- **Refactoring focus:** impact analysis at method level, so the AI sees what breaks before it edits.

Inspired by Simplicio's bounded AST projection and budget packing, SymDex's savings reporting, and Aider's ranked repo map. RefDex stays an index; editing remains the AI client's job.

## What changes from v1

v1 answers lookups the AI asks for one at a time; v2 assembles the whole context for a task in one call, under a budget.

| Area | v1 | v2 |
| --- | --- | --- |
| Retrieval | Separate lookups: search, outline, source, references | One `get_context` call per task, plus the v1 tools |
| Output size | Unbounded; depends on the query | Hard token budget, packed by relevance |
| Detail level | Signature or full source | Four levels per symbol: name, signature, signature + doc, full body |
| Ranking | PageRank over the whole repo | Task-specific: seed proximity × PageRank × kind weight |
| Repo map | Regenerated on request | Deterministic, versioned, cache-stable prefix |
| Savings | Measured offline in Phase 5 | Reported in every response and aggregated per client |
| Impact | `find_references` on one symbol | `get_impact` with transitive callers, depth-limited |

## Bounded context algorithm

`get_context` runs five steps: find seed symbols, expand over the graph, score, choose a detail level per symbol, and pack greedily until the budget is spent.

1. **Seeds.** Identifiers in the task text matched through FTS (exact, then CamelCase and snake\_case splits), the symbol under the cursor, symbols changed in the current git diff, and any symbols passed explicitly.
2. **Expansion.** Breadth-first over `edges` from each seed, to depth 2 by default: callers and callees, extends and implements, and imports. Each hop halves proximity.
3. **Scoring.** Each candidate gets a score from proximity, repo-wide PageRank and symbol kind; formula below.
4. **Projection levels.** Each symbol can appear at one of four levels, each with a token cost stored at index time.
5. **Packing.** Start every candidate at level 0 (excluded). Repeatedly apply the upgrade with the best extra value per extra token, until the next upgrade would exceed the budget minus 10% headroom.

```latex
\text{score}(s) = 0.5^{\text{hops}(s)} \cdot \left(0.7 + 0.3 \cdot \text{pr}(s)\right) \cdot k(s)
```

Here pr(s) is PageRank normalized to 0–1, and k(s) weights kinds (classes and interfaces 1.0, methods 0.9, fields 0.5). All weights are starting points to tune against the benchmark.

| Level | Shows | Value weight |
| --- | --- | --- |
| 0 | Nothing | 0 |
| 1 | Qualified name and location | 0.1 |
| 2 | Full signature | 0.4 |
| 3 | Signature and doc comment | 0.6 |
| 4 | Full body, read from disk | 1.0 |

This greedy upgrade loop approximates a multiple-choice knapsack: seeds usually reach level 4, their neighbours level 2 or 3, and distant symbols level 1 or nothing. Output is grouped by file and sorted by path and line, so the same input always yields the same text.

## Cache-friendly repo map

The repo map stays byte-identical between calls unless the code's structure changes, so AI clients can serve it from prompt cache instead of paying for it each turn.

- **Two parts:** a stable *anchor* (top-ranked modules, classes and public signatures) and a small *delta* listing structural changes since the anchor was built.
- **Deterministic output:** fixed sort order, no timestamps or scores in the text, stable formatting.
- **Versioned:** the anchor carries a structural hash; it is rebuilt only when that hash changes, not on every save.
- **Body edits don't count:** changing a method body leaves signatures unchanged, so the anchor stays cached.
- **Budgeted:** the anchor is packed with the same algorithm, seeded from the whole repo, to a configurable size (default 2,000 tokens).

Open question: how often clients actually reuse the cached prefix depends on how each one orders tool results; measure per client in the benchmark.

## New and changed MCP tools

v2 adds three tools and upgrades one; all v1 tools keep working unchanged.

| Tool | Status | Input | Returns |
| --- | --- | --- | --- |
| `get_context` | New | task, budget (default 4,000), seeds? | Packed context at mixed detail levels, plus a savings line |
| `get_impact` | New | qualified\_name, depth (default 3) | Transitive callers and implementers, grouped by file, budgeted |
| `get_savings` | New | since? | Tokens returned vs. whole-file baseline, per client and total |
| `get_repo_map` | Changed | token\_budget | Cache-stable anchor + delta |
| `search_symbols`, `get_file_outline`, `get_symbol_source`, `find_references` | Unchanged | — | — |

The `get_context` description tells the model to call it first for any multi-file task, and to fall back to the v1 tools only for follow-up detail.

## Token savings receipts and benchmarks

RefDex reports savings honestly per call and proves them on a fixed benchmark, rather than quoting a best-case "up to" figure.

**Per-call receipt.** Each response ends with one line: tokens returned, the baseline (the full files those symbols live in), and the percentage saved. Calls are logged in a `savings` table keyed by client, so `get_savings` and the status bar can show totals.

**Benchmark.** Ten fixed refactoring tasks per language on open-source repos, each run three ways:

| Run | Setup | Measures |
| --- | --- | --- |
| Baseline | AI client with no index | Input tokens, output tokens, turns, task success |
| RefDex v1 | v1 lookup tools | Same |
| RefDex v2 | `get_context` + cached repo map | Same, plus cache hit rate |

Also run SigMap, SymDex and Simplicio on the same tasks where licences allow. Publish the median savings and the success rate together; savings with lower task success don't count.

## Phased plan

Five phases over 6–8 weeks part-time, starting after the v1 release; the benchmark comes first so every later change is measured.

| Phase | Focus | Duration |
| --- | --- | --- |
| A | Benchmark harness | 1 week |
| B | Bounded context engine | 2–3 weeks |
| C | Cache-stable repo map | 1 week |
| D | Impact and savings tools | 1 week |
| E | Tuning and release | 1–2 weeks |

### Phase A: Benchmark harness

- [ ] Pick open-source repos per language and write 10 refactoring tasks each
- [ ] Script runs through Claude Code and Copilot, logging tokens, turns and success
- [ ] Record baseline and v1 results

### Phase B: Bounded context engine

- [ ] Store a token cost per projection level for every symbol at index time
- [ ] Seed extraction: FTS on task text, cursor symbol, git diff
- [ ] Depth-limited graph expansion with proximity decay
- [ ] Scoring and greedy multiple-choice packing
- [ ] `get_context` tool with deterministic output

### Phase C: Cache-stable repo map

- [ ] Structural hash that ignores body-only changes
- [ ] Anchor + delta output for `get_repo_map`
- [ ] Measure cache hit rate per client

### Phase D: Impact and savings tools

- [ ] `get_impact` with transitive callers and implementers
- [ ] Per-call savings line and `savings` table
- [ ] `get_savings` tool and status bar total in VS Code and IntelliJ

### Phase E: Tuning and release

- [ ] Tune weights, depth and default budget against the benchmark
- [ ] Run competitor comparison
- [ ] Publish benchmark results with the release
- [ ] Release v2 on both marketplaces

## Risks and open questions

The main risk is packing the wrong context: a tight budget that leaves out the one method the AI needed costs more turns than it saves.

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Packing omits a needed symbol | Extra turns or wrong edits | Always include seeds at level 4; benchmark task success, not just tokens |
| Weak seeds from vague task text | Irrelevant context | Fall back to cursor and git diff seeds; let the AI pass seeds explicitly |
| Token estimates differ by model tokenizer | Budget overruns | Keep 10% headroom; calibrate per client |
| Clients reorder tool results, breaking cache | Lower savings than expected | Measure cache hits per client; keep the anchor in its own tool call |
| Overlap with Simplicio's proprietary approach | Positioning confusion | Stay an open index, not an agent; publish benchmark method and results |

- [ ] Should `get_context` accept a token budget from the client, or pick one from the model's context size?
- [ ] Is depth 2 the right default for C# and Java, where interfaces add an extra hop?
- [ ] Should v2 offer a precise edit tool, or keep editing entirely with the AI client?
