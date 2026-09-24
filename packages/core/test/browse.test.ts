import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { IndexDb, Indexer, TreeSitter } from '../src/index.ts';
import { FIXTURES, indexFixture } from './helpers.ts';

describe('database browser', () => {
  it('lists tables and pages through rows with a filter', async () => {
    const ix = await indexFixture('csharp');
    const tables = ix.db.tables();
    assert.deepEqual(tables.map((t) => t.name), ['files', 'symbols', 'imports', 'symbol_parts', 'edges']);
    assert.equal(tables.find((t) => t.name === 'symbol_parts')?.rows, 2);

    const page = ix.db.browse('symbols', { filter: 'customer', limit: 3 });
    assert.equal(page.rows.length, 3);
    assert.ok(page.total > 3);
    assert.equal(page.columns[3], 'qualified_name');
    assert.ok(page.rows.every((r) => JSON.stringify(r).toLowerCase().includes('customer')));
    // LIKE wildcards in the filter are taken literally.
    assert.equal(ix.db.browse('symbols', { filter: '%' }).total, 0);
  });

  it('exports a table as CSV with quoting', async () => {
    const ix = await indexFixture('typescript');
    const dir = await mkdtemp(join(tmpdir(), 'refdex-csv-'));
    try {
      const n = ix.db.exportCsv('imports', join(dir, 'imports.csv'));
      const csv = await readFile(join(dir, 'imports.csv'), 'utf8');
      const lines = csv.trimEnd().split('\r\n');
      assert.equal(lines.length, n + 1);
      assert.ok(lines[0].startsWith('id,path,line,kind,spec,names'));
      assert.ok(csv.includes('"[{""name"":""Client""}'), 'JSON names are quoted');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rebuilds from scratch and honours exclude patterns', async () => {
    const db = new IndexDb(':memory:');
    const indexer = new Indexer(db, await TreeSitter.create(), join(FIXTURES, 'python'), ['tests/', 'utils.py']);
    const first = await indexer.syncAll();
    const paths = [...db.fileHashes().keys()];
    assert.ok(!paths.some((p) => p.includes('/tests/') || p.endsWith('utils.py')), paths.join());
    const rebuilt = await indexer.rebuild();
    assert.equal(rebuilt.indexed, first.indexed);
    assert.equal(rebuilt.unchanged, 0);
  });
});
