# RefDex token benchmark: 4 tasks, 3 runs per setup

Model claude-haiku-4-5, Claude Code 2.1.283 (Claude Code), RefDex f63e6d0, suite bench/tasks/guava-accuracy.json at 4d41665af1.
Tokens are summed over every API call of a run (context = uncached + cache-write + cache-read input). Cost is priced
with caching inside a run only (bench/cost.ts), so cache hits left by earlier runs don't count. Work tokens leave out
what every call re-sends anyway (Claude Code's prompt, tools and the question): the context the task itself added. Medians per task.

| Task | Kind | Setup | Passed | Recall | False positives | Turns | Context tokens | Work tokens | Output tokens | Cost | RefDex calls |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| bytesink-openstream-callers | callers through a base type | baseline | 2/3 | 73% | 0, 0, 0 | 41 | 1210k | 538k | 9666 | $0.255 | - |
| bytesink-openstream-callers | callers through a base type | refdex | 2/3 | 73% | 0, 0, 0 | 40 | 1206k | 539k | 12244 | $0.242 | 0 |
| copyto-bytesink-tests | overloads by argument type | baseline | 3/3 | 100% | 0, 0, 0 | 19 | 556k | 245k | 4838 | $0.147 | - |
| copyto-bytesink-tests | overloads by argument type | refdex | 2/3 | 71% | 0, 0, 0 | 25 | 764k | 348k | 5905 | $0.179 | 0 |
| segment-put-callers | chained calls | baseline | 3/3 | 100% | 0, 0, 0 | 21 | 543k | 200k | 3913 | $0.137 | - |
| segment-put-callers | chained calls | refdex | 3/3 | 100% | 0, 0, 0 | 23 | 516k | 134k | 4721 | $0.131 | 0 |
| expand-tests | tests through helpers | baseline | 2/3 | 100% | 0, 0, 1 | 27 | 816k | 375k | 5743 | $0.192 | - |
| expand-tests | tests through helpers | refdex | 2/3 | 100% | 0, 1, 0 | 37 | 1072k | 457k | 8833 | $0.228 | 0 |

## Summary

- **Cost with RefDex vs without:** +7% (geometric mean of the per-task median ratios; negative is a saving). Per task: bytesink-openstream-callers -5%, copyto-bytesink-tests +21%, segment-put-callers -5%, expand-tests +19%.
- **Recall** (share of the expected answers found, mean over runs): baseline 93%, RefDex 86%; false positives: baseline 1, RefDex 1.
- **Passed:** baseline 10/12, RefDex 9/12.
- **RefDex used:** in 3 of 12 RefDex runs (7 calls in total).
- **Median wall time:** baseline 64 s, RefDex 85 s.
- **Runs that started with a warm cache from an earlier run:** 23 of 24 (their cost above is recomputed as if cold).
