# RefDex token benchmark: 5 tasks, 3 runs per setup

Model claude-sonnet-5, Claude Code 2.1.283 (Claude Code), RefDex f63e6d0, suite bench/tasks/guava.json at 4d41665af1.
Tokens are summed over every API call of a run (context = uncached + cache-write + cache-read input). Cost is priced
with caching inside a run only (bench/cost.ts), so cache hits left by earlier runs don't count. Work tokens leave out
what every call re-sends anyway (Claude Code's prompt, tools and the question): the context the task itself added. Medians per task.

| Task | Kind | Setup | Passed | Turns | Context tokens | Work tokens | Output tokens | Cost | RefDex calls |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| find-eviction | find | baseline | 3/3 | 3 | 101k | - | 505 | $0.156 | - |
| find-eviction | find | refdex | 3/3 | 3 | 103k | - | 419 | $0.157 | 1 |
| joiner-appendable | understand a file | baseline | 3/3 | 2 | 67k | - | 185 | $0.143 | - |
| joiner-appendable | understand a file | refdex | 3/3 | 2 | 68k | - | 274 | $0.147 | 0 |
| callers-expand | callers before a change | baseline | 3/3 | 5 | 171k | - | 690 | $0.178 | - |
| callers-expand | callers before a change | refdex | 3/3 | 4 | 142k | - | 427 | $0.176 | 2 |
| tests-partition | tests before a change | baseline | 3/3 | 3 | 101k | - | 318 | $0.154 | - |
| tests-partition | tests before a change | refdex | 3/3 | 2 | 68k | - | 271 | $0.145 | 0 |
| orient-cache | orient | baseline | 3/3 | 2 | 67k | - | 356 | $0.144 | - |
| orient-cache | orient | refdex | 3/3 | 2 | 68k | - | 416 | $0.147 | 0 |

## Summary

- **Cost with RefDex vs without:** -0% (geometric mean of the per-task median ratios; negative is a saving). Per task: find-eviction +1%, joiner-appendable +3%, callers-expand -1%, tests-partition -6%, orient-cache +2%.
- **Passed:** baseline 15/15, RefDex 15/15.
- **RefDex used:** in 7 of 15 RefDex runs (10 calls in total).
- **Median wall time:** baseline 8 s, RefDex 8 s.
- **Runs that started with a warm cache from an earlier run:** 30 of 30 (their cost above is recomputed as if cold).
