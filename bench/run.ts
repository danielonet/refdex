// Token benchmark: runs the same tasks in Claude Code with and without RefDex and records what each
// run cost. See bench/README.md for the method.
//
// Usage (from the repository root):
//   node bench/run.ts --tasks bench/tasks/guava.json --source ~/git/guava [--runs 3]
//     [--model claude-sonnet-5] [--only task-id,task-id] [--arms baseline,refdex,directed]
//
// Writes bench/results/<timestamp>/runs.jsonl (one line per run) and the raw transcripts beside it;
// `node bench/report.ts <that folder>` summarizes them.
import { spawn, execFileSync } from 'node:child_process';
import { appendFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { costOf, pricesFor, type Call } from './cost.ts';
import { grade, type AnswerKey } from './grade.ts';

const REPO = resolve(import.meta.dirname, '..');
const WORK = join(REPO, 'bench', 'work');
const RUN_TIMEOUT_MS = 15 * 60_000;
/** Same for every setup; RefDex isn't mentioned in the task, as in real use. */
const PROMPT_SUFFIX = '\n\nThis is a read-only question: do not change any files. End your reply with one line: ANSWER: <your answer>, with only the answer on that line (no explanation)';
/** Read-only tools. Subagents are off, so every token is in the session's own usage. */
const ALLOWED = ['Read', 'Bash(rg:*)', 'Bash(grep:*)', 'Bash(find:*)', 'Bash(ls:*)', 'Bash(cat:*)', 'Bash(head:*)', 'Bash(tail:*)', 'Bash(sed -n:*)', 'Bash(wc:*)', 'mcp__refdex__*'];
const DISALLOWED = ['Agent', 'Task', 'Edit', 'Write', 'NotebookEdit'];
/**
 * The `directed` setup: RefDex as in `refdex`, plus this line appended to Claude Code's system prompt
 * (like a CLAUDE.md rule). It measures what RefDex saves when the agent uses it, apart from whether
 * the agent chooses to: the gap between `refdex` and `directed` is the discoverability problem.
 */
const DIRECTED_PROMPT =
  'This workspace has RefDex, a code index served over MCP (tools named mcp__refdex__*). Use it to find and read code ' +
  'instead of opening whole files: find_references for callers, the tests that reach a symbol and what a change ' +
  'affects; search_symbols to find names; get_symbol_source to read one symbol. ' +
  'Read files directly only for what RefDex\'s answers don\'t cover.';

const ARMS = ['baseline', 'refdex', 'directed'] as const;
type Arm = (typeof ARMS)[number];

interface Task extends AnswerKey {
  id: string;
  kind: string;
  prompt: string;
}

const { values: opts } = parseArgs({
  options: {
    tasks: { type: 'string' },
    source: { type: 'string' },
    runs: { type: 'string', default: '3' },
    model: { type: 'string', default: 'claude-sonnet-5' },
    only: { type: 'string' },
    arms: { type: 'string', default: 'baseline,refdex' },
  },
});
if (!opts.tasks || !opts.source) throw new Error('usage: node bench/run.ts --tasks <tasks.json> --source <repository> [--runs 3]');

const suite = JSON.parse(readFileSync(opts.tasks, 'utf8')) as { commit: string; tasks: Task[] };
const only = opts.only?.split(',');
const tasks = suite.tasks.filter((t) => !only || only.includes(t.id));
const arms = opts.arms!.split(',') as Arm[];
for (const arm of arms) if (!ARMS.includes(arm)) throw new Error(`unknown setup ${arm}; use ${ARMS.join(', ')}`);
const runs = Number(opts.runs);
pricesFor(opts.model!); // fail before any session for a model without prices
const name = basename(opts.tasks, '.json');
/** Worktree and index per repository, shared by its suites. */
const repoName = basename(resolve(opts.source));

// A worktree at the suite's commit: a path Claude Code has no memory or settings for, and the same
// code every time.
mkdirSync(WORK, { recursive: true });
const tree = join(WORK, repoName);
if (!existsSync(tree)) execFileSync('git', ['-C', resolve(opts.source), 'worktree', 'add', '--detach', tree, suite.commit], { stdio: 'inherit' });

// The index and the MCP configs for the two setups.
const daemon = join(REPO, 'packages', 'server', 'dist', 'refdex.cjs');
if (!existsSync(daemon)) throw new Error(`${daemon} is missing; run \`npm run build -w @refdex/server\``);
const db = join(WORK, `${repoName}.index.db`);
execFileSync(process.execPath, [daemon, 'index', '--root', tree, '--db', db], { stdio: 'inherit' });
const refdexConfig = join(WORK, `mcp-refdex-${repoName}.json`);
const configs: Record<Arm, string> = { baseline: join(WORK, 'mcp-baseline.json'), refdex: refdexConfig, directed: refdexConfig };
writeFileSync(configs.baseline, JSON.stringify({ mcpServers: {} }));
writeFileSync(refdexConfig, JSON.stringify({
  mcpServers: { refdex: { type: 'stdio', command: process.execPath, args: [daemon, 'mcp', '--root', tree, '--db', db, '--tools', 'always'] } },
}));

const out = join(REPO, 'bench', 'results', `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}-${name}`);
mkdirSync(join(out, 'transcripts'), { recursive: true });
writeFileSync(join(out, 'setup.json'), JSON.stringify({
  suite: opts.tasks, commit: suite.commit, model: opts.model, runs, arms, tasks: tasks.map((t) => t.id),
  ...(arms.includes('directed') ? { directedPrompt: DIRECTED_PROMPT } : {}),
  claude: execFileSync('claude', ['--version']).toString().trim(), refdex: execFileSync('git', ['-C', REPO, 'rev-parse', '--short', 'HEAD']).toString().trim(),
}, null, 2));

console.log(`${tasks.length} tasks x ${arms.length} setups x ${runs} runs = ${tasks.length * arms.length * runs} sessions -> ${out}`);
let n = 0;
for (let run = 1; run <= runs; run++) {
  for (const [i, task] of tasks.entries()) {
    // Rotate which setup goes first, so none always follows another (with two, this alternates).
    const shift = (run + i) % arms.length;
    const order = shift === 0 ? arms : [...arms.slice(arms.length - shift), ...arms.slice(0, arms.length - shift)];
    for (const arm of order) {
      n++;
      const result = await runOnce(task, arm, run);
      // A usage limit fails every later session at once; recording them would look like results.
      if (result.rateLimited) {
        console.error(`[${n}] ${task.id} ${arm} #${run}: stopped, usage limit reached (${result.answer}). ` +
          `${n - 1} sessions recorded in ${out}; that session and the rest were not run.`);
        process.exit(2);
      }
      appendFileSync(join(out, 'runs.jsonl'), `${JSON.stringify(result)}\n`);
      console.log(`[${n}] ${task.id} ${arm} #${run}: ${result.passed ? 'pass' : 'FAIL'}, ${result.turns} turns, ` +
        `${Math.round(result.contextTokens / 1000)}k context + ${result.outputTokens} out, $${result.cost.toFixed(3)}, ${result.refdexCalls} RefDex calls`);
    }
  }
}
console.log(`done: node bench/report.ts ${out}`);

async function runOnce(task: Task, arm: Arm, run: number) {
  const transcript = join(out, 'transcripts', `${task.id}-${arm}-${run}.jsonl`);
  const args = [
    '-p', task.prompt + PROMPT_SUFFIX, '--model', opts.model!, '--output-format', 'stream-json', '--verbose',
    '--strict-mcp-config', '--mcp-config', configs[arm], '--setting-sources', '', '--no-session-persistence',
    '--allowedTools', ...ALLOWED, '--disallowedTools', ...DISALLOWED,
    ...(arm === 'directed' ? ['--append-system-prompt', DIRECTED_PROMPT] : []),
  ];
  const started = Date.now();
  const lines: string[] = [];
  await new Promise<void>((done) => {
    const child = spawn('claude', args, { cwd: tree, stdio: ['ignore', 'pipe', 'pipe'] });
    const file = createWriteStream(transcript);
    let buffer = '';
    child.stdout.on('data', (chunk: Buffer) => {
      file.write(chunk);
      buffer += chunk.toString();
      const parts = buffer.split('\n');
      buffer = parts.pop()!;
      lines.push(...parts.filter(Boolean));
    });
    child.stderr.on('data', (chunk: Buffer) => file.write(`${JSON.stringify({ stderr: chunk.toString() })}\n`));
    const timer = setTimeout(() => child.kill('SIGTERM'), RUN_TIMEOUT_MS);
    child.on('close', () => {
      clearTimeout(timer);
      if (buffer.trim()) lines.push(buffer);
      file.end(done);
    });
  });
  return summarize(task, arm, run, lines, Date.now() - started);
}

/** Token usage per API call, the tools used, and the answer, from Claude Code's stream-json output. */
function summarize(task: Task, arm: Arm, run: number, lines: string[], ms: number) {
  const calls = new Map<string, Call>();
  const tools: Record<string, number> = {};
  let toolsOffered: string[] = [];
  let final: any;
  for (const line of lines) {
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === 'system' && event.subtype === 'init') toolsOffered = event.tools ?? [];
    if (event.type === 'assistant' && event.message?.id) {
      // Claude Code emits one event per content block; they share the message id and its usage.
      const u = event.message.usage ?? {};
      calls.set(event.message.id, { input: u.input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0 });
      for (const block of event.message.content ?? []) if (block.type === 'tool_use') tools[block.name] = (tools[block.name] ?? 0) + 1;
    }
    if (event.type === 'result') final = event;
  }
  const list = [...calls.values()];
  // The session total, which also includes thinking; per-message output counts are stale.
  const outputTokens: number = final?.modelUsage?.[opts.model!]?.outputTokens ?? 0;
  const { passed, answer, recall, falsePositives } = grade(task, final?.result ?? '', !!final && !final.is_error);
  return {
    task: task.id, kind: task.kind, arm, run, model: opts.model,
    passed, answer, recall, falsePositives,
    turns: list.length,
    contextTokens: list.reduce((s, c) => s + c.input + c.cacheWrite + c.cacheRead, 0),
    /**
     * Context the task itself added: each call's context minus the first call's (Claude Code's
     * prompt, the tool list and the question, re-sent every turn), summed over calls.
     */
    workTokens: list.reduce((s, c) => s + c.input + c.cacheWrite + c.cacheRead - (list[0].input + list[0].cacheWrite + list[0].cacheRead), 0),
    outputTokens,
    /** Priced as if nothing was cached before this run (see bench/cost.ts). */
    cost: costOf(list, outputTokens, opts.model!),
    /** What Claude Code reports, including cache hits left by earlier runs. */
    reportedCostUsd: final?.total_cost_usd ?? null,
    warmStart: (list[0]?.cacheRead ?? 0) > 0,
    refdexCalls: Object.entries(tools).filter(([k]) => k.startsWith('mcp__refdex__')).reduce((s, [, v]) => s + v, 0),
    refdexOffered: toolsOffered.some((t) => t.startsWith('mcp__refdex__')),
    tools,
    ms,
    backgroundModels: Object.keys(final?.modelUsage ?? {}).filter((m) => m !== opts.model),
    error: final ? (final.is_error ? final.api_error_status ? `api error ${final.api_error_status}` : final.subtype ?? 'error' : null) : 'no result (timeout or crash)',
    /** The API refused for a usage or rate limit (HTTP 429): the session never ran. */
    rateLimited: final?.api_error_status === 429,
  };
}
