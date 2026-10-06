# RefDex token benchmark: 5 tasks, 5 runs per setup

Model claude-sonnet-5, Claude Code 2.1.283 (Claude Code) with tool search off (ENABLE_TOOL_SEARCH=false), RefDex 3299659, suite bench/tasks/guava-long.json at 4d41665af1.
Tokens are summed over every API call of a run (context = uncached + cache-write + cache-read input). Cost is priced
with caching inside a run only (bench/cost.ts), so cache hits left by earlier runs don't count. Work tokens leave out
what every call re-sends anyway (Claude Code's prompt, tools and the question): the context the task itself added. Medians per task.

| Task | Kind | Setup | Passed | Recall | False positives | Turns | Context tokens | Work tokens | Output tokens | Cost | RefDex calls |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| refresh-flow | trace a flow | baseline | 5/5 | 100% | 0, 0, 0, 0, 0 | 7 | 420k | 31k | 2151 | $0.353 | - |
| refresh-flow | trace a flow | refdex | 5/5 | 100% | 0, 0, 0, 0, 0 | 5 | 315k | 27k | 1941 | $0.341 | 9 |
| refresh-flow | trace a flow | directed | 5/5 | 100% | 0, 0, 0, 0, 0 | 7 | 473k | 44k | 2130 | $0.383 | 6 |
| spec-new-option | plan a change | baseline | 5/5 | 100% | 0, 0, 0, 0, 0 | 3 | 176k | 9k | 1020 | $0.291 | - |
| spec-new-option | plan a change | refdex | 5/5 | 100% | 0, 0, 0, 0, 0 | 4 | 242k | 12k | 1550 | $0.316 | 2 |
| spec-new-option | plan a change | directed | 5/5 | 100% | 0, 0, 0, 0, 0 | 4 | 242k | 11k | 1403 | $0.311 | 2 |
| transform-flow | trace a flow | baseline | 5/5 | 100% | 0, 0, 0, 0, 0 | 6 | 344k | 11k | 1270 | $0.319 | - |
| transform-flow | trace a flow | refdex | 5/5 | 100% | 0, 0, 0, 0, 0 | 5 | 313k | 16k | 1411 | $0.335 | 4 |
| transform-flow | trace a flow | directed | 5/5 | 100% | 0, 0, 0, 0, 0 | 5 | 311k | 17k | 1623 | $0.333 | 5 |
| cache-implementations | find implementations | baseline | 5/5 | 100% | 0, 0, 0, 0, 0 | 3 | 168k | 1k | 647 | $0.254 | - |
| cache-implementations | find implementations | refdex | 5/5 | 100% | 0, 0, 0, 0, 0 | 4 | 233k | 3k | 765 | $0.279 | 0 |
| cache-implementations | find implementations | directed | 5/5 | 100% | 0, 0, 0, 0, 0 | 4 | 262k | 16k | 944 | $0.313 | 0 |
| read-recency | understand a large class | baseline | 5/5 | 100% | 0, 0, 0, 0, 0 | 2 | 112k | 1k | 571 | $0.242 | - |
| read-recency | understand a large class | refdex | 5/5 | 100% | 0, 0, 0, 0, 0 | 3 | 176k | 3k | 645 | $0.266 | 3 |
| read-recency | understand a large class | directed | 5/5 | 100% | 0, 0, 0, 0, 0 | 3 | 179k | 5k | 649 | $0.281 | 3 |

## Summary

- **Cost, RefDex vs baseline:** +6% (geometric mean of the per-task median ratios; negative is a saving). Per task: refresh-flow -3%, spec-new-option +9%, transform-flow +5%, cache-implementations +10%, read-recency +10%.
- **Cost, RefDex, directed vs baseline:** +12% (geometric mean of the per-task median ratios; negative is a saving). Per task: refresh-flow +8%, spec-new-option +7%, transform-flow +4%, cache-implementations +23%, read-recency +16%.
- *directed* is RefDex with an instruction to use it (see `directedPrompt` in setup.json): what RefDex saves when used. The gap to *refdex* is what the agent misses by not choosing it.
- **Recall** (share of the expected answers found, mean over runs): baseline 100%, RefDex 100%, RefDex, directed 100%; false positives: baseline 0, RefDex 0, RefDex, directed 0.
- **Passed:** baseline 25/25, RefDex 25/25, RefDex, directed 25/25.
- **RefDex used:** in 20 of 25 runs (86 calls in total).
- **RefDex used (directed):** in 22 of 25 runs (83 calls in total).
- **Median wall time:** baseline 19 s, RefDex 24 s, RefDex, directed 20 s.
- **Runs that started with a warm cache from an earlier run:** 73 of 75 (their cost above is recomputed as if cold).
