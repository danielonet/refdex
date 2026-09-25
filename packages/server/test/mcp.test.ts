import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { execFileSync } from 'node:child_process';

const MAIN = join(import.meta.dirname, '..', 'src', 'main.ts');
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
      args: ['--disable-warning=ExperimentalWarning', MAIN, 'mcp', '--root', root],
      stderr: 'inherit',
    }));
  });
  after(async () => {
    await client.close();
    await rm(root, { recursive: true, force: true });
  });

  it('announces instructions and five read-only tools', async () => {
    assert.match(client.getInstructions() ?? '', /search_symbols/);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ['find_references', 'get_file_outline', 'get_repo_map', 'get_symbol_source', 'search_symbols']);
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
    const lines = (await readFile(join(root, '.refdex', 'mcp-usage.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(lines.length >= 2);
    assert.equal(lines.at(-1).client, 'refdex-test');
    assert.equal(lines.at(-1).tool, 'get_file_outline');
    assert.deepEqual(lines.at(-1).args, { path: 'pom.xml' });
    assert.ok(lines.at(-1).chars > 0);
    // The session start comes first, without a tool.
    assert.equal(lines[0].event, 'connect');
    assert.equal(lines[0].tool, undefined);
  });

  it('rejects invalid arguments', async () => {
    const res = await client.callTool({ name: 'search_symbols', arguments: { query: '' } });
    assert.equal(res.isError, true);
  });
});
