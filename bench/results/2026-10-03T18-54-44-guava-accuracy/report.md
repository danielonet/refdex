# RefDex token benchmark: 4 tasks, 3 runs per setup

Model claude-sonnet-5, Claude Code 2.1.283 (Claude Code), RefDex 2379014, suite bench/tasks/guava-accuracy.json at 4d41665af1.
Tokens are summed over every API call of a run (context = uncached + cache-write + cache-read input). Cost is priced
with caching inside a run only (bench/cost.ts), so cache hits left by earlier runs don't count. Work tokens leave out
what every call re-sends anyway (Claude Code's prompt, tools and the question): the context the task itself added. Medians per task.

| Task | Kind | Setup | Passed | Recall | False positives | Turns | Context tokens | Work tokens | Output tokens | Cost | RefDex calls |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| bytesink-openstream-callers | callers through a base type | baseline | 3/3 | 100% | 0, 0, 0 | 8 | 328k | 60k | 3270 | $0.281 | - |
| bytesink-openstream-callers | callers through a base type | refdex | 2/3 | 93% | 0, 0, 0 | 6 | 223k | 26k | 2490 | $0.227 | 0 |
| bytesink-openstream-callers | callers through a base type | directed | 2/3 | 93% | 0, 0, 0 | 8 | 335k | 52k | 2478 | $0.264 | 3 |
| copyto-bytesink-tests | overloads by argument type | baseline | 2/3 | 95% | 0, 0, 0 | 4 | 158k | 24k | 2563 | $0.232 | - |
| copyto-bytesink-tests | overloads by argument type | refdex | 2/3 | 95% | 0, 0, 0 | 4 | 151k | 15k | 2694 | $0.218 | 0 |
| copyto-bytesink-tests | overloads by argument type | directed | 3/3 | 100% | 0, 0, 0 | 5 | 188k | 17k | 2973 | $0.225 | 0 |
| segment-put-callers | chained calls | baseline | 3/3 | 100% | 0, 0, 0 | 5 | 177k | 5k | 929 | $0.185 | - |
| segment-put-callers | chained calls | refdex | 3/3 | 100% | 0, 0, 0 | 3 | 109k | 7k | 694 | $0.181 | 1 |
| segment-put-callers | chained calls | directed | 3/3 | 100% | 0, 0, 0 | 3 | 108k | 6k | 414 | $0.176 | 1 |
| expand-tests | tests through helpers | baseline | 3/3 | 100% | 0, 0, 0 | 12 | 485k | 86k | 3428 | $0.304 | - |
| expand-tests | tests through helpers | refdex | 3/3 | 100% | 0, 0, 0 | 7 | 273k | 35k | 2719 | $0.242 | 0 |
| expand-tests | tests through helpers | directed | 3/3 | 100% | 0, 0, 0 | 5 | 185k | 15k | 1580 | $0.211 | 3 |

## Summary

- **Cost, RefDex vs baseline:** -12% (geometric mean of the per-task median ratios; negative is a saving). Per task: bytesink-openstream-callers -19%, copyto-bytesink-tests -6%, segment-put-callers -2%, expand-tests -20%.
- **Cost, RefDex, directed vs baseline:** -12% (geometric mean of the per-task median ratios; negative is a saving). Per task: bytesink-openstream-callers -6%, copyto-bytesink-tests -3%, segment-put-callers -5%, expand-tests -31%.
- *directed* is RefDex with an instruction to use it (see `directedPrompt` in setup.json): what RefDex saves when used. The gap to *refdex* is what the agent misses by not choosing it.
- **Recall** (share of the expected answers found, mean over runs): baseline 99%, RefDex 97%, RefDex, directed 98%; false positives: baseline 0, RefDex 0, RefDex, directed 0.
- **Passed:** baseline 11/12, RefDex 10/12, RefDex, directed 11/12.
- **RefDex used:** in 4 of 12 runs (5 calls in total).
- **RefDex used (directed):** in 10 of 12 runs (22 calls in total).
- **Median wall time:** baseline 36 s, RefDex 26 s, RefDex, directed 28 s.
- **Runs that started with a warm cache from an earlier run:** 34 of 36 (their cost above is recomputed as if cold).
