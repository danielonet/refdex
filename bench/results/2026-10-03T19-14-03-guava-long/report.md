# RefDex token benchmark: 5 tasks, 5 runs per setup

Model claude-sonnet-5, Claude Code 2.1.283 (Claude Code), RefDex 2379014, suite bench/tasks/guava-long.json at 4d41665af1.
Tokens are summed over every API call of a run (context = uncached + cache-write + cache-read input). Cost is priced
with caching inside a run only (bench/cost.ts), so cache hits left by earlier runs don't count. Work tokens leave out
what every call re-sends anyway (Claude Code's prompt, tools and the question): the context the task itself added. Medians per task.

| Task | Kind | Setup | Passed | Recall | False positives | Turns | Context tokens | Work tokens | Output tokens | Cost | RefDex calls |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| refresh-flow | trace a flow | baseline | 5/5 | 100% | 0, 0, 0, 0, 0 | 7 | 271k | 34k | 1591 | $0.232 | - |
| refresh-flow | trace a flow | refdex | 5/5 | 100% | 0, 0, 0, 0, 0 | 7 | 259k | 25k | 2658 | $0.235 | 0 |
| refresh-flow | trace a flow | directed | 5/5 | 100% | 0, 0, 0, 0, 0 | 7 | 279k | 41k | 1824 | $0.244 | 7 |
| spec-new-option | plan a change | baseline | 5/5 | 100% | 0, 0, 0, 0, 0 | 3 | 110k | 9k | 1010 | $0.194 | - |
| spec-new-option | plan a change | refdex | 5/5 | 100% | 0, 0, 0, 0, 0 | 3 | 111k | 9k | 925 | $0.194 | 0 |
| spec-new-option | plan a change | directed | 5/5 | 100% | 0, 0, 0, 0, 0 | 4 | 153k | 16k | 1169 | $0.217 | 1 |
| transform-flow | trace a flow | baseline | 5/5 | 100% | 0, 0, 0, 0, 0 | 7 | 246k | 11k | 1371 | $0.216 | - |
| transform-flow | trace a flow | refdex | 5/5 | 100% | 0, 0, 0, 0, 0 | 5 | 190k | 20k | 1472 | $0.223 | 3 |
| transform-flow | trace a flow | directed | 5/5 | 100% | 0, 0, 0, 0, 0 | 7 | 259k | 21k | 1430 | $0.231 | 4 |
| cache-implementations | find implementations | baseline | 5/5 | 100% | 0, 0, 0, 0, 0 | 4 | 136k | 2k | 741 | $0.166 | - |
| cache-implementations | find implementations | refdex | 5/5 | 100% | 0, 0, 0, 0, 0 | 4 | 138k | 2k | 685 | $0.168 | 0 |
| cache-implementations | find implementations | directed | 5/5 | 100% | 0, 0, 0, 0, 0 | 3 | 106k | 2k | 789 | $0.169 | 0 |
| read-recency | understand a large class | baseline | 5/5 | 100% | 0, 0, 0, 0, 0 | 2 | 68k | 1k | 535 | $0.149 | - |
| read-recency | understand a large class | refdex | 5/5 | 100% | 0, 0, 0, 0, 0 | 2 | 69k | 1k | 624 | $0.159 | 0 |
| read-recency | understand a large class | directed | 5/5 | 100% | 0, 0, 0, 0, 0 | 3 | 106k | 4k | 777 | $0.168 | 3 |

## Summary

- **Cost, RefDex vs baseline:** +2% (geometric mean of the per-task median ratios; negative is a saving). Per task: refresh-flow +1%, spec-new-option +0%, transform-flow +3%, cache-implementations +1%, read-recency +7%.
- **Cost, RefDex, directed vs baseline:** +8% (geometric mean of the per-task median ratios; negative is a saving). Per task: refresh-flow +5%, spec-new-option +12%, transform-flow +7%, cache-implementations +2%, read-recency +13%.
- *directed* is RefDex with an instruction to use it (see `directedPrompt` in setup.json): what RefDex saves when used. The gap to *refdex* is what the agent misses by not choosing it.
- **Recall** (share of the expected answers found, mean over runs): baseline 100%, RefDex 100%, RefDex, directed 100%; false positives: baseline 0, RefDex 0, RefDex, directed 0.
- **Passed:** baseline 25/25, RefDex 25/25, RefDex, directed 25/25.
- **RefDex used:** in 6 of 25 runs (18 calls in total).
- **RefDex used (directed):** in 18 of 25 runs (66 calls in total).
- **Median wall time:** baseline 16 s, RefDex 18 s, RefDex, directed 19 s.
- **Runs that started with a warm cache from an earlier run:** 75 of 75 (their cost above is recomputed as if cold).
