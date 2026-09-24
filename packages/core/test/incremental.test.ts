import assert from 'node:assert/strict';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { indexFixture } from './helpers.ts';

describe('incremental updates', () => {
  it('skips unchanged files on a second full scan', async () => {
    const ix = await indexFixture('python');
    const again = await ix.indexer.syncAll();
    assert.equal(again.indexed, 0);
    assert.equal(again.unchanged, ix.summary.indexed);
  });

  it('re-indexes changed files, adds new ones and drops deleted ones', async () => {
    const ix = await indexFixture('python', { copy: true });
    try {
      await writeFile(ix.p('src/shop/utils.py'), 'def slugify(text: str) -> str:\n    return text\n');
      await writeFile(ix.p('src/shop/extra.py'), 'from .utils import slugify\n\nclass Extra:\n    pass\n');
      await rm(ix.p('src/shop/pricing.py'));
      const s = await ix.indexer.syncPaths([ix.p('src/shop/utils.py'), ix.p('src/shop/extra.py'), ix.p('src/shop/pricing.py')]);
      assert.equal(s.indexed, 2);
      assert.equal(s.removed, 1);
      assert.equal(ix.db.symbolsByQualifiedName('shop.utils.slug').length, 0);
      assert.equal(ix.symbol('shop.utils.slugify').kind, 'function');
      assert.equal(ix.symbol('shop.extra.Extra').kind, 'class');
      assert.equal(ix.resolution('src/shop/extra.py', '.utils'), 'src/shop/utils.py');
      // The import of the deleted module is now unresolved.
      assert.equal(ix.resolution('src/shop/orders.py', '.pricing', 'total'), null);

      // Re-creating it resolves the import again (unresolved imports are retried).
      await writeFile(ix.p('src/shop/pricing.py'), 'def total(lines):\n    return 0\n');
      await ix.indexer.syncPaths([ix.p('src/shop/pricing.py')]);
      assert.equal(ix.resolution('src/shop/orders.py', '.pricing', 'total'), 'src/shop/pricing.py');
    } finally {
      await rm(ix.root, { recursive: true, force: true });
    }
  });

  it('handles folders that are renamed, created and deleted', async () => {
    const ix = await indexFixture('python', { copy: true });
    try {
      await rename(ix.p('src/shop/sub'), ix.p('src/shop/moved'));
      await ix.indexer.syncPaths([ix.p('src/shop/sub'), ix.p('src/shop/moved')]);
      assert.equal(ix.db.symbolsByQualifiedName('shop.sub.deep.deep_total').length, 0);
      assert.equal(ix.symbol('shop.moved.deep.deep_total').kind, 'function');

      await mkdir(ix.p('src/shop/fresh'));
      await writeFile(ix.p('src/shop/fresh/__init__.py'), 'def fresh(): pass\n');
      await ix.indexer.syncPaths([ix.p('src/shop/fresh')]);
      assert.equal(ix.symbol('shop.fresh.fresh').kind, 'function');

      await rm(ix.p('src/shop/moved'), { recursive: true });
      const s = await ix.indexer.syncPaths([ix.p('src/shop/moved')]);
      assert.equal(s.removed, 2);
      assert.equal(ix.db.symbolsByQualifiedName('shop.moved.deep.deep_total').length, 0);
    } finally {
      await rm(ix.root, { recursive: true, force: true });
    }
  });

  it('rescans everything when a config file changes', async () => {
    const ix = await indexFixture('python', { copy: true });
    try {
      await writeFile(ix.p('.gitignore'), 'generated/\n*.tmp.py\ntests/\n');
      await ix.indexer.syncPaths([ix.p('.gitignore')]);
      assert.equal(ix.db.fileSymbols(ix.p('tests/test_orders.py')).length, 0);
      assert.ok(!ix.db.fileHashes().has(ix.p('tests/test_orders.py')));
    } finally {
      await rm(ix.root, { recursive: true, force: true });
    }
  });
});
