// Summarizes a benchmark run folder: node bench/report.ts bench/results/<run>
// Prints a Markdown report and writes it to <run>/report.md.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface Run {
  task: string;
  kind: string;
  /** baseline, refdex, or directed (RefDex plus an instruction to use it; see run.ts). */
  arm: string;
  passed: boolean;
  /** Share of expected items found (completeness tasks); absent in older results. */
  recall?: number;
  falsePositives?: number;
  turns: number;
  contextTokens: number;
  workTokens?: number;
  outputTokens: number;
  cost: number;
  refdexCalls: number;
  refdexOffered: boolean;
  warmStart: boolean;
  ms: number;
  error: string | null;
}

const dir = process.argv[2];
if (!dir) throw new Error('usage: node bench/report.ts <results folder>');
const runs = readFileSync(join(dir, 'runs.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Run);
const setup = JSON.parse(readFileSync(join(dir, 'setup.json'), 'utf8'));

const median = (xs: number[]) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const k = (n: number) => (Number.isNaN(n) ? '-' : `${(n / 1000).toFixed(0)}k`);
const usd = (n: number) => `$${n.toFixed(3)}`;
const pct = (n: number) => `${n > 0 ? '+' : ''}${(n * 100).toFixed(0)}%`;

const tasks = [...new Set(runs.map((r) => r.task))];
/** Setups in a fixed order; old results have only baseline and refdex. */
const arms = ['baseline', 'refdex', 'directed'].filter((a) => runs.some((r) => r.arm === a));
const withRefdex = arms.filter((a) => a !== 'baseline');
/** Mean recall of runs, as a percentage; '-' for results without it. */
const recallOf = (rs: Run[]) => (rs.some((r) => r.recall === undefined) ? '-' : `${Math.round((100 * rs.reduce((s, r) => s + r.recall!, 0)) / rs.length)}%`);
const of = (task: string, arm: Run['arm']) => runs.filter((r) => r.task === task && r.arm === arm);

const out: string[] = [
  `# RefDex token benchmark: ${setup.tasks.length} tasks, ${setup.runs} runs per setup`,
  '',
  `Model ${setup.model}, Claude Code ${setup.claude}${setup.toolSearch === 'off' ? ' with tool search off (ENABLE_TOOL_SEARCH=false)' : ''}, RefDex ${setup.refdex}, suite ${setup.suite} at ${setup.commit}.`,
  'Tokens are summed over every API call of a run (context = uncached + cache-write + cache-read input). Cost is priced',
  'with caching inside a run only (bench/cost.ts), so cache hits left by earlier runs don\'t count. Work tokens leave out',
  'what every call re-sends anyway (Claude Code\'s prompt, tools and the question): the context the task itself added. Medians per task.',
  '',
  '| Task | Kind | Setup | Passed | Recall | False positives | Turns | Context tokens | Work tokens | Output tokens | Cost | RefDex calls |',
  '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
];
/** Per setup, per task: median cost relative to baseline. */
const ratios = new Map<string, (number | undefined)[]>(withRefdex.map((a) => [a, []]));
for (const task of tasks) {
  for (const arm of arms) {
    const rs = of(task, arm);
    if (!rs.length) continue;
    out.push(`| ${task} | ${rs[0].kind} | ${arm} | ${rs.filter((r) => r.passed).length}/${rs.length} | ` +
      `${recallOf(rs)} | ${rs.every((r) => r.falsePositives === undefined) ? '-' : rs.map((r) => r.falsePositives ?? 0).join(', ')} | ${median(rs.map((r) => r.turns))} | ` +
      `${k(median(rs.map((r) => r.contextTokens)))} | ${k(median(rs.map((r) => r.workTokens ?? NaN)))} | ${median(rs.map((r) => r.outputTokens)).toFixed(0)} | ${usd(median(rs.map((r) => r.cost)))} | ` +
      `${arm !== 'baseline' ? median(rs.map((r) => r.refdexCalls)) : '-'} |`);
  }
  const b = median(of(task, 'baseline').map((r) => r.cost));
  for (const arm of withRefdex) {
    const x = median(of(task, arm).map((r) => r.cost));
    ratios.get(arm)!.push(b > 0 && x > 0 ? x / b : undefined);
  }
}

const all = (arm: string) => runs.filter((r) => r.arm === arm);
const geo = (rs: (number | undefined)[]) => {
  const xs = rs.filter((x): x is number => x !== undefined);
  return xs.length ? Math.exp(xs.reduce((s, x) => s + Math.log(x), 0) / xs.length) : NaN;
};
const label = (arm: string) => (arm === 'refdex' ? 'RefDex' : arm === 'directed' ? 'RefDex, directed' : arm);
const total = (arm: string, f: (r: Run) => number) => all(arm).reduce((s, r) => s + f(r), 0);
out.push('', '## Summary', '');
// Cost ratios need baseline runs in the same folder (e.g. not for `--arms directed` alone).
for (const arm of arms.includes('baseline') ? withRefdex : []) {
  const rs = ratios.get(arm)!;
  out.push(`- **Cost, ${label(arm)} vs baseline:** ${pct(geo(rs) - 1)} (geometric mean of the per-task median ratios; negative is a saving). ` +
    `Per task: ${tasks.map((t, i) => `${t} ${rs[i] !== undefined ? pct(rs[i]! - 1) : 'n/a'}`).join(', ')}.`);
}
if (arms.includes('directed')) {
  out.push('- *directed* is RefDex with an instruction to use it (see `directedPrompt` in setup.json): what RefDex saves when used. ' +
    'The gap to *refdex* is what the agent misses by not choosing it.');
}
out.push(
  `- **Recall** (share of the expected answers found, mean over runs): ${arms.map((a) => `${label(a)} ${recallOf(all(a))}`).join(', ')}; ` +
    `false positives: ${arms.map((a) => `${label(a)} ${total(a, (r) => r.falsePositives ?? 0)}`).join(', ')}.`,
  `- **Passed:** ${arms.map((a) => `${label(a)} ${all(a).filter((r) => r.passed).length}/${all(a).length}`).join(', ')}.`,
  ...withRefdex.map((a) => `- **RefDex used${a === 'refdex' ? '' : ` (${a})`}:** in ${all(a).filter((r) => r.refdexCalls > 0).length} of ${all(a).length} runs ` +
    `(${total(a, (r) => r.refdexCalls)} calls in total)${all(a).some((r) => !r.refdexOffered) ? '; WARNING: some runs were not offered the tools' : ''}.`),
  `- **Median wall time:** ${arms.map((a) => `${label(a)} ${(median(all(a).map((r) => r.ms)) / 1000).toFixed(0)} s`).join(', ')}.`,
  `- **Runs that started with a warm cache from an earlier run:** ${runs.filter((r) => r.warmStart).length} of ${runs.length} (their cost above is recomputed as if cold).`,
);
const errors = runs.filter((r) => r.error);
if (errors.length) out.push(`- **Errors:** ${errors.map((r) => `${r.task} ${r.arm}: ${r.error}`).join('; ')}.`);

const report = out.join('\n');
writeFileSync(join(dir, 'report.md'), `${report}\n`);
console.log(report);
