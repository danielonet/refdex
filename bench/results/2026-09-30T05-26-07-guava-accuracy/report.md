# RefDex token benchmark: 4 tasks, 3 runs per setup

Model claude-sonnet-5, Claude Code 2.1.283 (Claude Code), RefDex f63e6d0, suite bench/tasks/guava-accuracy.json at 4d41665af1.
Tokens are summed over every API call of a run (context = uncached + cache-write + cache-read input). Cost is priced
with caching inside a run only (bench/cost.ts), so cache hits left by earlier runs don't count. Work tokens leave out
what every call re-sends anyway (Claude Code's prompt, tools and the question): the context the task itself added. Medians per task.

| Task | Kind | Setup | Passed | Recall | False positives | Turns | Context tokens | Work tokens | Output tokens | Cost | RefDex calls |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| bytesink-openstream-callers | callers through a base type | baseline | 3/3 | 100% | 0, 0, 0 | 11 | 460k | 87k | 3678 | $0.311 | - |
| bytesink-openstream-callers | callers through a base type | refdex | 3/3 | 100% | 0, 0, 0 | 10 | 402k | 65k | 3721 | $0.285 | 0 |
| copyto-bytesink-tests | overloads by argument type | baseline | 1/3 | 86% | 0, 0, 0 | 3 | 112k | 12k | 1996 | $0.212 | - |
| copyto-bytesink-tests | overloads by argument type | refdex | 3/3 | 100% | 0, 0, 0 | 3 | 120k | 18k | 3116 | $0.229 | 0 |
| segment-put-callers | chained calls | baseline | 3/3 | 100% | 0, 0, 0 | 4 | 136k | 3k | 681 | $0.166 | - |
| segment-put-callers | chained calls | refdex | 3/3 | 100% | 0, 0, 0 | 4 | 137k | 2k | 668 | $0.167 | 0 |
| expand-tests | tests through helpers | baseline | 3/3 | 100% | 0, 0, 0 | 10 | 371k | 39k | 2713 | $0.261 | - |
| expand-tests | tests through helpers | refdex | 3/3 | 100% | 0, 0, 0 | 10 | 376k | 48k | 3013 | $0.265 | 0 |

## Summary

- **Cost with RefDex vs without:** +0% (geometric mean of the per-task median ratios; negative is a saving). Per task: bytesink-openstream-callers -8%, copyto-bytesink-tests +8%, segment-put-callers +0%, expand-tests +1%.
- **Recall** (share of the expected answers found, mean over runs): baseline 96%, RefDex 100%; false positives: baseline 0, RefDex 0.
- **Passed:** baseline 10/12, RefDex 12/12.
- **RefDex used:** in 0 of 12 RefDex runs (0 calls in total).
- **Median wall time:** baseline 30 s, RefDex 32 s.
- **Runs that started with a warm cache from an earlier run:** 23 of 24 (their cost above is recomputed as if cold).
