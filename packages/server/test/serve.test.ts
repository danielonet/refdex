import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { after, before, describe, it } from 'node:test';

const MAIN = join(import.meta.dirname, '..', 'src', 'main.ts');
const FIXTURE = join(import.meta.dirname, '..', '..', 'core', 'test', 'fixtures', 'typescript');

/** Drives `refdex serve` over its JSON-lines protocol. */
class Client {
  private nextId = 1;
  private readonly pending = new Map<number, (msg: any) => void>();
  private readonly eventWaiters: { match: (e: any) => boolean; resolve: (e: any) => void }[] = [];
  readonly child: ChildProcessWithoutNullStreams;

  constructor(root: string, db: string) {
    this.child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', MAIN, 'serve', '--root', root, '--db', db]);
    this.child.stderr.on('data', (d) => process.stderr.write(d));
    this.child.on('exit', (code) => {
      for (const resolve of this.pending.values()) resolve({ error: `daemon exited with code ${code}` });
    });
    createInterface({ input: this.child.stdout }).on('line', (line) => {
      const msg = JSON.parse(line);
      if (msg.id !== undefined) this.pending.get(msg.id)?.(msg);
      else {
        const i = this.eventWaiters.findIndex((w) => w.match(msg));
        if (i >= 0) this.eventWaiters.splice(i, 1)[0].resolve(msg);
      }
    });
  }

  async request(method: string, params?: object): Promise<any> {
    const id = this.nextId++;
    const reply = new Promise<any>((resolve) => this.pending.set(id, resolve));
    this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    const msg = await reply;
    if (msg.error) throw new Error(msg.error);
    return msg.result;
  }

  nextEvent(match: (e: any) => boolean, timeoutMs = 10_000): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for event')), timeoutMs);
      this.eventWaiters.push({ match, resolve: (e) => { clearTimeout(timer); resolve(e); } });
    });
  }

  close(): void {
    this.child.stdin.end();
  }
}

describe('refdex serve', () => {
  let root: string;
  let client: Client;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'refdex-serve-'));
    await cp(FIXTURE, root, { recursive: true });
    client = new Client(root, join(root, '.refdex', 'index.db'));
  });
  after(async () => {
    client.close();
    await rm(root, { recursive: true, force: true });
  });

  it('indexes on request in the worker thread and answers queries', async () => {
    assert.equal((await client.request('stats')).files, 0);
    const summary = await client.request('reindex', { full: true });
    assert.ok(summary.indexed >= 7, JSON.stringify(summary));
    const hits = await client.request('search', { query: 'OrderMod' });
    assert.equal(hits[0].qualified_name, 'src/models/order:OrderModel');
    const outline = await client.request('outline', { path: join(root, 'src/services/orderService.ts') });
    assert.ok(outline.symbols.some((s: any) => s.name === 'OrderService'));
  });

  it('picks up saved, new and deleted files through the watcher', async () => {
    let indexed = client.nextEvent((e) => e.event === 'indexed');
    await writeFile(join(root, 'src/util.ts'), 'export const helper = (n: number) => n;\nexport function tripled(n: number) { return n * 3; }\n');
    await writeFile(join(root, 'src/fresh.ts'), 'export class Fresh {}\n');
    let event = await indexed;
    assert.ok(event.summary.indexed >= 1, JSON.stringify(event.summary));
    // Events may be split across two debounced runs; wait until both files are in.
    for (let i = 0; i < 3 && !(await client.request('search', { query: 'Fresh' })).length; i++) {
      await client.nextEvent((e) => e.event === 'indexed');
    }
    assert.equal((await client.request('search', { query: 'tripled' }))[0]?.qualified_name, 'src/util:tripled');
    assert.equal((await client.request('search', { query: 'Fresh' }))[0]?.qualified_name, 'src/fresh:Fresh');

    indexed = client.nextEvent((e) => e.event === 'indexed');
    await rm(join(root, 'src/fresh.ts'));
    event = await indexed;
    assert.equal(event.summary.removed, 1);
    assert.equal((await client.request('search', { query: 'Fresh' })).length, 0);
  });
});
