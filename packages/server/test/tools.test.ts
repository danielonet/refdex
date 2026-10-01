import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { IndexDb, Indexer, TreeSitter } from '@refdex/core';
import { RefdexTools } from '../src/tools.ts';

const FIXTURES = join(import.meta.dirname, '..', '..', 'core', 'test', 'fixtures');
let treeSitter: Promise<TreeSitter> | undefined;

/**
 * Copies a fixture (or writes `files`, relative path -> content), indexes it into a real database
 * file and opens the tools read-only on it.
 */
async function toolsFor(fixture: string | Record<string, string>): Promise<{ tools: RefdexTools; root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'refdex-tools-'));
  if (typeof fixture === 'string') {
    await cp(join(FIXTURES, fixture), root, { recursive: true });
  } else {
    for (const [rel, content] of Object.entries(fixture)) {
      await mkdir(dirname(join(root, rel)), { recursive: true });
      await writeFile(join(root, rel), content);
    }
  }
  const dbPath = join(root, '.refdex.db');
  const db = new IndexDb(dbPath);
  await new Indexer(db, await (treeSitter ??= TreeSitter.create()), root).syncAll();
  db.close();
  const tools = new RefdexTools(root, dbPath);
  return { tools, root, cleanup: async () => { tools.close(); await rm(root, { recursive: true, force: true }); } };
}

describe('MCP tools: typescript', () => {
  let t: Awaited<ReturnType<typeof toolsFor>>;
  before(async () => { t = await toolsFor('typescript'); });
  after(() => t.cleanup());

  it('search_symbols returns qualified names, locations, signatures and freshness', async () => {
    const out = await t.tools.searchSymbols({ query: 'OrderMod' });
    assert.match(out, /^\[RefDex index: \d+ files, updated just now\]/);
    assert.match(out, /class src\/models\/order:OrderModel {2}src\/models\/order\.ts:8-15\n {2}class OrderModel implements Order/);
    assert.match(await t.tools.searchSymbols({ query: 'total', kind: 'method' }), /OrderModel\.total/);
    assert.match(await t.tools.searchSymbols({ query: 'zzzz' }), /No symbols match/);
  });

  it('get_file_outline lists imports with their targets and nested signatures', async () => {
    const out = await t.tools.getFileOutline({ path: 'src/services/orderService.ts' });
    assert.match(out, /@app\/models\/order \[Order, OrderModel\] -> src\/models\/order\.ts/);
    assert.match(out, /node:fs \[\* as fs\] -> external/);
    assert.match(out, /qualified names start with "src\/services\/orderService:"/);
    assert.match(out, /\n {2}9-15 class OrderService\n {4}10 method constructor\(private readonly client: Client\)/);
    assert.match(await t.tools.getFileOutline({ path: '../../etc/passwd' }), /outside the workspace/);
    assert.match(await t.tools.getFileOutline({ path: 'package.json' }), /not in the index/);
  });

  it('get_symbol_source reads the current source and resolves plain names', async () => {
    const out = await t.tools.getSymbolSource({ qualified_name: 'src/models/order:OrderModel.total' });
    assert.match(out, /\/\/ src\/models\/order\.ts:11-13 {2}method src\/models\/order:OrderModel\.total\n {2}total\(\): number \{\n {4}return 0;\n {2}\}/);
    assert.match(await t.tools.getSymbolSource({ qualified_name: 'OrderService' }), /export class OrderService/);
    assert.match(await t.tools.getSymbolSource({ qualified_name: 'total' }), /ambiguous/);
    assert.match(await t.tools.getSymbolSource({ qualified_name: 'Nope' }), /No symbol "Nope"/);
  });

  it('get_symbol_source flags files changed since indexing', async () => {
    await writeFile(join(t.root, 'src/util.ts'), '// edited\nexport const helper = (n: number): number => n * 2;\n');
    assert.match(await t.tools.getSymbolSource({ qualified_name: 'src/util:helper' }), /changed since it was indexed/);
  });

  it('get_symbol_source summarizes types longer than max_lines', async () => {
    const summary = await t.tools.getSymbolSource({ qualified_name: 'src/models/order:OrderModel', max_lines: 10 });
    assert.doesNotMatch(summary, /over max_lines/); // 8 lines: fits
    const members = await t.tools.getSymbolSource({ qualified_name: 'src/services/orderService:OrderService', max_lines: 10 });
    assert.doesNotMatch(members, /over max_lines/); // 7 lines: fits
    const big = await t.tools.getSymbolSource({ qualified_name: 'src/models/order:Order', max_lines: 10 });
    assert.match(big, /export interface Order/);
  });

  it('find_references follows imports and barrel re-exports', async () => {
    const out = await t.tools.findReferences({ qualified_name: 'src/models/order:OrderModel' });
    assert.match(out, /References to class src\/models\/order:OrderModel/);
    // Imported directly (via a tsconfig alias) and through the src/models barrel.
    assert.match(out, /src\/services\/orderService\.ts:3: import \{ type Order, OrderModel \} from '@app\/models\/order';/);
    assert.match(out, /src\/services\/orderService\.ts:4: import \{ Client, OrderModel as Model \} from '@models';/);
    assert.match(out, /src\/services\/orderService\.ts:13: return new OrderModel\(\);/);
    // Not the declaration itself.
    assert.doesNotMatch(out, /order\.ts:8:/);
  });

  it('find_references lists linked uses with their caller before name matches', async () => {
    const out = await t.tools.findReferences({ qualified_name: 'src/models/order:OrderModel' });
    assert.match(out, /1 use linked by the index.*:\nsrc\/services\/orderService\.ts:13: return new OrderModel\(\); {2}\[calls in src\/services\/orderService:OrderService\.find\]\n2 other lines naming "OrderModel"/s);
    const iface = await t.tools.findReferences({ qualified_name: 'src/models/order:Order' });
    assert.match(iface, /src\/models\/order\.ts:8: export class OrderModel implements Order \{ {2}\[implements in src\/models\/order:OrderModel\]/);
  });

  it('get_symbol_source with_callees lists what the symbol calls', async () => {
    const out = await t.tools.getSymbolSource({ qualified_name: 'src/services/orderService:OrderService.find', with_callees: true });
    assert.match(out, /\/\/ calls 1 indexed symbol:\nclass src\/models\/order:OrderModel {2}src\/models\/order\.ts:8-15\n {2}class OrderModel implements Order/);
    assert.doesNotMatch(await t.tools.getSymbolSource({ qualified_name: 'src/services/orderService:OrderService.find' }), /\/\/ calls/);
  });

  it('get_repo_map ranks the most used symbols first within the budget', async () => {
    const out = await t.tools.getRepoMap({});
    assert.match(out, /^\[RefDex index: .*\]\nRepo map: \d+ of \d+ symbols in \d+ files, the most used first \(PageRank over \d+ linked/);
    // Order is used by OrderModel and OrderService: its file comes first, with the interface on top.
    assert.match(out, /files in rank order.*\nsrc\/models\/order\.ts\n {2}2-6 interface Order\n/is);
    // Unused properties are left out; used types are kept.
    assert.doesNotMatch(out, /property lines/);
    assert.match(out, /8-15 class OrderModel implements Order/);

    const small = await t.tools.getRepoMap({ token_budget: 100, path: 'src/services' });
    assert.match(small, /Repo map of src\/services: /);
    assert.doesNotMatch(small, /src\/models/);
    assert.ok(small.split('\n').slice(2).join('\n').length <= 100 * 4);
  });
});

describe('MCP tools: python, java, csharp', () => {
  it('python: module-qualified names and references through relative imports', async () => {
    const t = await toolsFor('python');
    try {
      const refs = await t.tools.findReferences({ qualified_name: 'shop.pricing.total' });
      assert.match(refs, /src\/shop\/orders\.py:5: from \.pricing import total, TAX_RATE/);
      assert.match(refs, /src\/shop\/sub\/deep\.py:6: return total\(lines\)/);
      const src = await t.tools.getSymbolSource({ qualified_name: 'shop.orders.Order.total' });
      assert.match(src, /@property\n {4}def total\(self\) -> float:/);
    } finally {
      await t.cleanup();
    }
  });

  it('java: overloads and same-package references', async () => {
    const t = await toolsFor('java');
    try {
      const src = await t.tools.getSymbolSource({ qualified_name: 'com.acme.service.InvoiceService.find' });
      assert.equal(src.match(/\/\/ src\/main\/java\/com\/acme\/service\/InvoiceService\.java:/g)?.length, 2);
      const refs = await t.tools.findReferences({ qualified_name: 'com.acme.model.Invoice' });
      assert.match(refs, /InvoiceService\.java:3: import com\.acme\.model\.Invoice;/);
      assert.match(refs, /InvoiceService\.java:10: public Invoice find\(String id\)/);
      // Exact name matches rank first.
      assert.match(await t.tools.searchSymbols({ query: 'Invoice', kind: 'class' }), /matches for "Invoice":\nclass com\.acme\.model\.Invoice /);
    } finally {
      await t.cleanup();
    }
  });

  it('csharp: partial classes show every part; global usings count as references', async () => {
    const t = await toolsFor('csharp');
    try {
      const src = await t.tools.getSymbolSource({ qualified_name: 'Acme.Domain.Customer' });
      assert.match(src, /App\/Domain\/Customer\.cs:4-7/);
      assert.match(src, /App\/Domain\/Customer\.Orders\.cs:3-6/);
      const refs = await t.tools.findReferences({ qualified_name: 'Acme.Domain.Customer' });
      assert.match(refs, /App\/Services\/CustomerService\.cs:\d+: .*new Customer/);
      assert.doesNotMatch(refs, /Lib\/Other\.cs/);
    } finally {
      await t.cleanup();
    }
  });

  it('find_references with depth adds the blast radius: callers through the interface, then tests', async () => {
    const t = await toolsFor({
      'src/main/java/app/Store.java': 'package app;\npublic interface Store { void save(String key); }\n',
      'src/main/java/app/DiskStore.java': 'package app;\npublic class DiskStore implements Store {\n  public void save(String key) {}\n}\n',
      'src/main/java/app/Service.java':
        'package app;\npublic class Service {\n  private final Store store;\n  public Service(Store store) { this.store = store; }\n  public void put(String key) { store.save(key); }\n}\n',
      'src/main/java/app/Api.java':
        'package app;\npublic class Api {\n  private Service service;\n  public void handle() { service.put("x"); }\n  public void fresh() { make().put("y"); }\n  private Service make() { return service; }\n}\n',
      'src/test/java/app/ServiceTest.java':
        'package app;\npublic class ServiceTest {\n  void testPut() {\n    Service service = new Service(new DiskStore());\n    service.put("k");\n  }\n}\n',
    });
    try {
      const plain = await t.tools.findReferences({ qualified_name: 'app.DiskStore.save' });
      assert.doesNotMatch(plain, /Blast radius/);
      const out = await t.tools.findReferences({ qualified_name: 'app.DiskStore.save', depth: 3 });
      assert.match(out, /Blast radius: 3 callers up to 3 levels, 1 of them in tests\./);
      assert.match(out, /Level 1 \(direct callers\):\n {2}app\.Service\.put {2}src\/main\/java\/app\/Service\.java:5/);
      assert.match(out, /Level 2:\n {2}app\.Api\.handle {2}src\/main\/java\/app\/Api\.java:4/);
      assert.match(out, /Tests that reach it[^\n]*\n {2}src\/test\/java\/app\/ServiceTest\.java: testPut \(L2\)/);
      // Api.fresh calls Service.put on a call result: the walk can't follow it and says so.
      assert.match(out, /May be incomplete[^\n]*\n {2}app\.Service\.put: 1 call on a call result, e\.g\. src\/main\/java\/app\/Api\.java:5 make\(\)\.put\(…\)\nLevel 1/);
      const chained = await t.tools.findReferences({ qualified_name: 'app.Service.put', depth: 2 });
      assert.match(chained, /May be incomplete: calls the index couldn't link are not followed[^\n]*\n {2}app\.Service\.put: 1 unlinked call, e\.g\. src\/main\/java\/app\/Api\.java:5 make\(\)\.put\(…\)/);
    } finally {
      await t.cleanup();
    }
  });

  it('get_file_outline gives less detail for large files, and find_references counts extra name matches per file', async () => {
    // One class with many long signatures: too long in full, fine as names.
    const params = Array.from({ length: 12 }, (_, i) => `argument${i}: string`).join(', ');
    const methods = Array.from({ length: 60 }, (_, i) => `  method${i}(${params}): void {}`).join('\n');
    // Many classes with many members: too long even as names.
    const classes = Array.from({ length: 40 }, (_, c) =>
      `export class Type${c} {\n${Array.from({ length: 40 }, (_, m) => `  member${m}(): void {}`).join('\n')}\n}`).join('\n');
    const uses = Array.from({ length: 30 }, (_, i) => `export const use${i} = 'target';`).join('\n');
    const t = await toolsFor({
      'tsconfig.json': '{}',
      'src/wide.ts': `export class Wide {\n${methods}\n}\n`,
      'src/many.ts': `${classes}\n`,
      'src/target.ts': 'export function target(): void {}\n',
      'src/a.ts': `import { target } from './target';\n${uses}\n`,
      'src/b.ts': `import { target } from './target';\n${uses}\n`,
    });
    try {
      const wide = await t.tools.getFileOutline({ path: 'src/wide.ts' });
      assert.match(wide, /names only, the file is too large for every signature:/);
      assert.match(wide, /\n {4}2 method method0\n/);
      assert.doesNotMatch(wide, /argument0/);
      const many = await t.tools.getFileOutline({ path: 'src/many.ts' });
      assert.match(many, /types only, the file is too large for every member/);
      assert.match(many, /\n {2}1-42 class Type0 \(40 members\)\n/);
      assert.doesNotMatch(many, /member0/);
      const refs = await t.tools.findReferences({ qualified_name: 'src/target:target' });
      assert.equal(refs.split('\n').filter((l) => /^src\/[ab]\.ts:\d+: /.test(l)).length, 15);
      assert.match(refs, /… 47 more in 2 files: src\/[ab]\.ts \(\d+\), src\/[ab]\.ts \(\d+\)/);
    } finally {
      await t.cleanup();
    }
  });

  it('answers helpfully when there is no index yet', async () => {
    const tools = new RefdexTools('/tmp/nowhere', '/tmp/nowhere/.refdex/index.db');
    assert.match(await tools.searchSymbols({ query: 'x' }), /index has not been built yet.*refdex index --root \/tmp\/nowhere/s);
  });
});

describe('MCP tools: get_context', () => {
  /** A small service with callers, callees and a test, so the graph has every kind of neighbour. */
  const files = {
    'tsconfig.json': '{}',
    'src/pricing.ts': [
      '/** Rounds an amount to whole cents. */',
      'export function roundCents(amount: number): number {',
      '  return Math.round(amount * 100) / 100;',
      '}',
      '',
      'export function taxFor(amount: number): number {',
      '  return roundCents(amount * 0.2);',
      '}',
      '',
    ].join('\n'),
    'src/cart.ts': [
      "import { roundCents, taxFor } from './pricing';",
      '',
      '/** A shopping cart. */',
      'export class Cart {',
      '  private items: number[] = [];',
      '',
      '  add(price: number): void {',
      '    this.items.push(price);',
      '  }',
      '',
      '  total(): number {',
      '    const net = this.items.reduce((a, b) => a + b, 0);',
      '    return roundCents(net + taxFor(net));',
      '  }',
      '}',
      '',
    ].join('\n'),
    'src/checkout.ts': [
      "import { Cart } from './cart';",
      '',
      'export function checkout(cart: Cart): string {',
      '  return `Total: ${cart.total()}`;',
      '}',
      '',
    ].join('\n'),
    'test/cart.test.ts': [
      "import { Cart } from '../src/cart';",
      '',
      'export function testTotal(): void {',
      '  const cart = new Cart();',
      '  cart.add(10);',
      '  if (cart.total() !== 12) throw new Error();',
      '}',
      '',
    ].join('\n'),
  };
  let t: Awaited<ReturnType<typeof toolsFor>>;
  before(async () => { t = await toolsFor(files); });
  after(() => t.cleanup());
  const body = (out: string) => out.split('\n').slice(1).join('\n');

  it('returns the named method with its code, and what it calls and what calls it', async () => {
    const out = await t.tools.getContext({ task: 'Change how Cart.total() adds tax' });
    assert.match(out, /^\[RefDex index: 4 files, updated just now\]\nContext for the task within 4,000 tokens: \d+ symbols in 4 files/);
    assert.match(out, /Starting from src\/cart:Cart\.total\./);
    // The seed's body, re-indented under its header inside its class.
    assert.match(out, /\nsrc\/cart\.ts\n {2}4-15 class Cart\n(.*\n)* {4}11-14 method total\n {6}total\(\): number \{\n {8}const net/);
    // Callees and callers, each in its file.
    assert.match(out, /\nsrc\/pricing\.ts\n(.*\n)* {2}.*roundCents/);
    assert.match(out, /\nsrc\/checkout\.ts\n {2}3-5 /);
    assert.match(out, /\ntest\/cart\.test\.ts\n/);
    assert.match(out, /\n\[~\d+ tokens; reading these 4 files whole: ~\d+ tokens.*\]$/);
  });

  it('is deterministic and stays within the budget', async () => {
    const args = { task: 'Change how Cart.total() adds tax', budget: 500 };
    const a = await t.tools.getContext(args);
    assert.equal(body(a), body(await t.tools.getContext(args)));
    assert.ok(a.length / 4 <= 500, `${a.length / 4} tokens`);
    // A tighter budget shows less detail, not more than it can hold.
    const full = await t.tools.getContext({ ...args, budget: 4000 });
    assert.ok(a.length < full.length);
  });

  it('starts from explicit seeds, from plain words and from the git working tree', async () => {
    assert.match(await t.tools.getContext({ task: 'what does this do', seeds: ['src/pricing:taxFor'] }), /Starting from src\/pricing:taxFor\./);
    assert.match(await t.tools.getContext({ task: 'how is a checkout summary built', seeds: ['nope.Missing'] }), /Not in the index: nope\.Missing\.[\s\S]*src\/checkout\.ts/);
    assert.match(await t.tools.getContext({ task: 'something unrelated entirely' }), /No code matches the task's names\./);

    execFileSync('git', ['init', '-q'], { cwd: t.root });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qam', 'init', '--allow-empty'], { cwd: t.root });
    execFileSync('git', ['add', '.'], { cwd: t.root });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'files'], { cwd: t.root });
    await writeFile(join(t.root, 'src/pricing.ts'), files['src/pricing.ts'].replace('0.2', '0.25'));
    assert.match(await t.tools.getContext({ task: 'review my change', changes: true }), /Starting from src\/pricing:taxFor\./);
  });
});
