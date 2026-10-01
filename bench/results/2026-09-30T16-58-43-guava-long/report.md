# RefDex token benchmark: 5 tasks, 3 runs per setup

Model claude-haiku-4-5, Claude Code 2.1.283 (Claude Code), RefDex f63e6d0, suite bench/tasks/guava-long.json at 4d41665af1.
Tokens are summed over every API call of a run (context = uncached + cache-write + cache-read input). Cost is priced
with caching inside a run only (bench/cost.ts), so cache hits left by earlier runs don't count. Work tokens leave out
what every call re-sends anyway (Claude Code's prompt, tools and the question): the context the task itself added. Medians per task.

| Task | Kind | Setup | Passed | Recall | False positives | Turns | Context tokens | Work tokens | Output tokens | Cost | RefDex calls |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| refresh-flow | trace a flow | baseline | 2/3 | 67% | 0, 0, 0 | 27 | 752k | 336k | 11011 | $0.231 | - |
| refresh-flow | trace a flow | refdex | 3/3 | 100% | 0, 0, 0 | 19 | 480k | 164k | 13096 | $0.184 | 0 |
| spec-new-option | plan a change | baseline | 3/3 | 100% | 0, 0, 0 | 3 | 56k | 7k | 938 | $0.054 | - |
| spec-new-option | plan a change | refdex | 3/3 | 100% | 0, 0, 0 | 4 | 81k | 13k | 1294 | $0.066 | 0 |
| transform-flow | trace a flow | baseline | 2/3 | 67% | 0, 0, 0 | 10 | 191k | 41k | 2295 | $0.084 | - |
| transform-flow | trace a flow | refdex | 2/3 | 67% | 0, 0, 0 | 10 | 194k | 28k | 2410 | $0.079 | 0 |
| cache-implementations | find implementations | baseline | 3/3 | 100% | 0, 0, 0 | 12 | 232k | 36k | 2136 | $0.075 | - |
| cache-implementations | find implementations | refdex | 3/3 | 100% | 0, 0, 0 | 7 | 124k | 8k | 1351 | $0.056 | 0 |
| read-recency | understand a large class | baseline | 3/3 | 100% | 0, 0, 0 | 5 | 154k | 88k | 1197 | $0.109 | - |
| read-recency | understand a large class | refdex | 3/3 | 100% | 0, 0, 0 | 7 | 136k | 20k | 1347 | $0.061 | 5 |

## Summary

- **Cost with RefDex vs without:** -18% (geometric mean of the per-task median ratios; negative is a saving). Per task: refresh-flow -20%, spec-new-option +21%, transform-flow -7%, cache-implementations -26%, read-recency -44%.
- **Recall** (share of the expected answers found, mean over runs): baseline 87%, RefDex 93%; false positives: baseline 0, RefDex 0.
- **Passed:** baseline 13/15, RefDex 14/15.
- **RefDex used:** in 5 of 15 RefDex runs (31 calls in total).
- **Median wall time:** baseline 27 s, RefDex 23 s.
- **Runs that started with a warm cache from an earlier run:** 30 of 30 (their cost above is recomputed as if cold).
