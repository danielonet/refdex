import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { request } from 'node:http';

const MAIN = join(import.meta.dirname, '..', 'src', 'main.ts');

/**
 * The usage log once its last line satisfies `done`. The server writes the line after answering, so
 * a test reading right after a call can see the previous line.
 */
async function usageLog(root: string, done: (last: any) => boolean): Promise<any[]> {
  let lines: any[] = [];
  for (let i = 0; i < 100; i++) {
    const text = await readFile(join(root, '.refdex', 'mcp-usage.jsonl'), 'utf8').catch(() => '');
    lines = text.trim() ? text.trim().split('\n').map((l) => JSON.parse(l)) : [];
    if (lines.length && done(lines.at(-1))) return lines;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return lines;
}
const FIXTURE = join(import.meta.dirname, '..', '..', 'core', 'test', 'fixtures', 'java');

describe('refdex mcp over stdio', () => {
  let root: string;
  let client: Client;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'refdex-mcp-'));
    await cp(FIXTURE, root, { recursive: true });
    execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', MAIN, 'index', '--root', root]);
    client = new Client({ name: 'refdex-test', version: '0.0.0' });
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      // The fixture is far below the size threshold; these tests are about the tools themselves.
      args: ['--disable-warning=ExperimentalWarning', MAIN, 'mcp', '--root', root, '--tools', 'always'],
      stderr: 'ignore',
    }));
  });
  after(async () => {
    await client.close();
    await rm(root, { recursive: true, force: true });
  });

  it('announces instructions and six read-only tools', async () => {
    // Callers and tests first: find_references is where RefDex saves the most (bench/, guava-accuracy).
    assert.match(client.getInstructions() ?? '', /1\. find_references for "who calls this/);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ['find_references', 'get_context', 'get_file_outline', 'get_repo_map', 'get_symbol_source', 'search_symbols']);
    assert.deepEqual(tools.find((t) => t.name === 'get_context')?.inputSchema.required, ['task']);
    assert.ok(tools.every((t) => t.annotations?.readOnlyHint));
    assert.deepEqual(tools.find((t) => t.name === 'search_symbols')?.inputSchema.required, ['query']);
  });

  it('answers tool calls', async () => {
    const res = await client.callTool({ name: 'search_symbols', arguments: { query: 'Invoice', kind: 'class' } });
    const text = (res.content as { type: string; text: string }[])[0].text;
    assert.match(text, /class com\.acme\.model\.Invoice {2}src\/main\/java\/com\/acme\/model\/Invoice\.java:4-10\n {2}public class Invoice {2}\/\/ An invoice\./);
  });

  it('logs each tool call with the client name', async () => {
    await client.callTool({ name: 'get_file_outline', arguments: { path: 'pom.xml' } });
    const lines = await usageLog(root, (last) => last.tool === 'get_file_outline');
    assert.ok(lines.length >= 2);
    assert.equal(lines.at(-1).client, 'refdex-test');
    assert.equal(lines.at(-1).tool, 'get_file_outline');
    assert.deepEqual(lines.at(-1).args, { path: 'pom.xml' });
    assert.ok(lines.at(-1).chars > 0);
    // The session start comes first, without a tool.
    assert.equal(lines[0].event, 'connect');
    assert.equal(lines[0].tool, undefined);
    assert.equal(lines[0].tools, true);
  });

  it('rejects invalid arguments', async () => {
    const res = await client.callTool({ name: 'search_symbols', arguments: { query: '' } });
    assert.equal(res.isError, true);
  });
});

describe('refdex mcp: tools only where they pay off', () => {
  let root: string;
  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'refdex-mcp-size-'));
    await cp(FIXTURE, root, { recursive: true });
    execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', MAIN, 'index', '--root', root]);
  });
  after(() => rm(root, { recursive: true, force: true }));

  const connect = async (...flags: string[]) => {
    const client = new Client({ name: 'refdex-test', version: '0.0.0' });
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: ['--disable-warning=ExperimentalWarning', MAIN, 'mcp', '--root', root, ...flags],
      stderr: 'ignore',
    }));
    return client;
  };

  it('offers no tools for a small codebase, and says why', async () => {
    const client = await connect();
    try {
      assert.deepEqual((await client.listTools()).tools, []);
      assert.match(client.getInstructions() ?? '', /tools are off for this workspace \(small codebase: ~\d+ tokens of code \(threshold 100,000\)\); read files directly\. If they appear later/);
    } finally {
      await client.close();
    }
  });

  it('offers them above the threshold, or when forced; never turns them off', async () => {
    for (const [flags, count] of [[['--min-tokens', '10'], 6], [['--tools', 'always'], 6], [['--tools', 'never', '--min-tokens', '0'], 0]] as const) {
      const client = await connect(...flags);
      try {
        assert.equal((await client.listTools()).tools.length, count, flags.join(' '));
      } finally {
        await client.close();
      }
    }
  });

  it('rejects an empty or invalid threshold instead of reading it as 0', () => {
    const run = (env: Record<string, string>, ...flags: string[]) =>
      spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', MAIN, 'mcp', '--root', root, ...flags], {
        env: { ...process.env, ...env }, input: '', encoding: 'utf8',
      });
    const empty = run({ REFDEX_MIN_TOKENS: '' });
    assert.equal(empty.status, 1);
    assert.match(empty.stderr, /REFDEX_MIN_TOKENS must be a non-negative number, not ""/);
    const bad = run({}, '--min-tokens', 'lots');
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /--min-tokens must be a non-negative number, not "lots"/);
  });

  it('logs the decision on connect', async () => {
    const client = await connect();
    await client.close();
    const lines = await usageLog(root, (last) => last.event === 'connect');
    assert.equal(lines.at(-1).event, 'connect');
    assert.equal(lines.at(-1).tools, false);
    assert.match(lines.at(-1).reason, /^small codebase/);
  });
});

// Debug builds only (refdex.build.json); from source, as here, it is always available.
describe('refdex mcp --http (debug builds)', () => {
  let root: string;
  let server: ReturnType<typeof spawn>;
  const port = 17000 + Math.floor(Math.random() * 2000);
  const url = `http://127.0.0.1:${port}/mcp`;
  const post = (body: object, headers: Record<string, string> = {}) => fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(body),
  });

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'refdex-mcp-http-'));
    await cp(FIXTURE, root, { recursive: true });
    execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', MAIN, 'index', '--root', root]);
    server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', MAIN, 'mcp', '--root', root, '--http', String(port), '--tools', 'always']);
    // Ready once it says where it listens.
    await new Promise<void>((resolve, reject) => {
      server.stderr!.on('data', (d: Buffer) => d.toString().includes('debug HTTP server on') && resolve());
      server.on('exit', (code) => reject(new Error(`server exited with ${code}`)));
    });
  });
  after(async () => {
    server.kill();
    await rm(root, { recursive: true, force: true });
  });

  it('answers stateless JSON-RPC requests with plain JSON, without a session', async () => {
    const list: any = await (await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).json();
    assert.ok(list.result.tools.some((t: { name: string }) => t.name === 'search_symbols'));
    const res = await post(
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'search_symbols', arguments: { query: 'Invoice', kind: 'class' } } },
      { 'User-Agent': 'curl/8.0' },
    );
    assert.match(res.headers.get('content-type') ?? '', /application\/json/);
    const call: any = await res.json();
    assert.match(call.result.content[0].text, /class com\.acme\.model\.Invoice/);
    const lines = await usageLog(root, (last) => last.client === 'curl/8.0');
    assert.equal(lines.at(-1).client, 'curl/8.0');
  });

  it('rejects other hosts, other methods and other paths', async () => {
    // fetch drops a custom Host header (it's a forbidden header), so send this one with node:http.
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(url, { method: 'POST', headers: { Host: 'evil.example', 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' }));
    });
    assert.equal(status, 403);
    assert.equal((await fetch(url)).status, 405);
    assert.equal((await fetch(url.replace('/mcp', '/other'), { method: 'POST' })).status, 404);
  });
});
