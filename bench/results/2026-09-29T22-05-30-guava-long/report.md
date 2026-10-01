# RefDex token benchmark: 5 tasks, 3 runs per setup

Model claude-sonnet-5, Claude Code 2.1.283 (Claude Code), RefDex f63e6d0, suite bench/tasks/guava-long.json at 4d41665af1.
Tokens are summed over every API call of a run (context = uncached + cache-write + cache-read input). Cost is priced
with caching inside a run only (bench/cost.ts), so cache hits left by earlier runs don't count. Work tokens leave out
what every call re-sends anyway (Claude Code's prompt, tools and the question): the context the task itself added. Medians per task.

| Task | Kind | Setup | Passed | Recall | False positives | Turns | Context tokens | Work tokens | Output tokens | Cost | RefDex calls |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| refresh-flow | trace a flow | baseline | 3/3 | - | - | 8 | 300k | 33k | 3364 | $0.255 | - |
| refresh-flow | trace a flow | refdex | 3/3 | - | - | 8 | 303k | 33k | 3287 | $0.258 | 0 |
| spec-new-option | plan a change | baseline | 3/3 | - | - | 3 | 109k | 9k | 1311 | $0.196 | - |
| spec-new-option | plan a change | refdex | 3/3 | - | - | 3 | 110k | 9k | 1226 | $0.197 | 0 |
| transform-flow | trace a flow | baseline | 3/3 | - | - | 6 | 211k | 12k | 1452 | $0.209 | - |
| transform-flow | trace a flow | refdex | 3/3 | - | - | 7 | 249k | 20k | 1846 | $0.223 | 0 |
| cache-implementations | find implementations | baseline | 3/3 | - | - | 4 | 136k | 3k | 1265 | $0.174 | - |
| cache-implementations | find implementations | refdex | 3/3 | - | - | 5 | 179k | 10k | 1405 | $0.193 | 0 |
| read-recency | understand a large class | baseline | 3/3 | - | - | 3 | 102k | 2k | 762 | $0.162 | - |
| read-recency | understand a large class | refdex | 3/3 | - | - | 4 | 140k | 5k | 1007 | $0.175 | 4 |

## Summary

- **Cost with RefDex vs without:** +5% (geometric mean of the per-task median ratios; negative is a saving). Per task: refresh-flow +1%, spec-new-option +0%, transform-flow +7%, cache-implementations +11%, read-recency +8%.
- **Recall** (share of the expected answers found, mean over runs): baseline -, RefDex -; false positives: baseline 0, RefDex 0.
- **Passed:** baseline 15/15, RefDex 15/15.
- **RefDex used:** in 3 of 15 RefDex runs (13 calls in total).
- **Median wall time:** baseline 17 s, RefDex 18 s.
- **Runs that started with a warm cache from an earlier run:** 30 of 30 (their cost above is recomputed as if cold).
