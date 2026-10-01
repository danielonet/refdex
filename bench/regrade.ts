// Grades finished runs again with the task file's current checks, from their saved transcripts, for
// when an answer key was wrong. Rewrites <results>/runs.jsonl (the old one is kept as runs.orig.jsonl).
// Usage: node bench/regrade.ts <results folder> <tasks.json>
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { grade, type AnswerKey } from './grade.ts';

const [dir, tasksFile] = process.argv.slice(2);
if (!dir || !tasksFile) throw new Error('usage: node bench/regrade.ts <results folder> <tasks.json>');
const keys = new Map((JSON.parse(readFileSync(tasksFile, 'utf8')).tasks as (AnswerKey & { id: string })[]).map((t) => [t.id, t]));
const runsFile = join(dir, 'runs.jsonl');
if (!existsSync(join(dir, 'runs.orig.jsonl'))) copyFileSync(runsFile, join(dir, 'runs.orig.jsonl'));

let changed = 0;
const runs = readFileSync(join(dir, 'runs.orig.jsonl'), 'utf8').trim().split('\n').map((line) => {
  const run = JSON.parse(line);
  const result = readFileSync(join(dir, 'transcripts', `${run.task}-${run.arm}-${run.run}.jsonl`), 'utf8').split('\n')
    .map((l) => { try { return JSON.parse(l); } catch { return undefined; } })
    .find((e) => e?.type === 'result');
  const graded = grade(keys.get(run.task) ?? {}, result?.result ?? '', !!result && !result.is_error);
  if (graded.passed !== run.passed || graded.recall !== run.recall) changed++;
  return { ...run, ...graded };
});
writeFileSync(runsFile, `${runs.map((r) => JSON.stringify(r)).join('\n')}\n`);
console.log(`regraded ${runs.length} runs; ${changed} changed`);
