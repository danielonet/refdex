import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { IndexDb, Indexer, TreeSitter } from '@refdex/core';
import { RefdexTools } from '../src/tools.ts';

const FIXTURES = join(import.meta.dirname, '..', '..', 'core', 'test', 'fixtures');
let treeSitter: Promise<TreeSitter> | undefined;

/** Copies a fixture, indexes it into a real database file and opens the tools read-only on it. */
async function toolsFor(fixture: string): Promise<{ tools: RefdexTools; root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), `refdex-tools-${fixture}-`));
  await cp(join(FIXTURES, fixture), root, { recursive: true });
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

  it('answers helpfully when there is no index yet', async () => {
    const tools = new RefdexTools('/tmp/nowhere', '/tmp/nowhere/.refdex/index.db');
    assert.match(await tools.searchSymbols({ query: 'x' }), /index has not been built yet.*refdex index --root \/tmp\/nowhere/s);
  });
});
