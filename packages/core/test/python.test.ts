import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { indexFixture, type Indexed } from './helpers.ts';

describe('python adapter', () => {
  let ix: Indexed;
  before(async () => {
    ix = await indexFixture('python');
  });

  it('respects .gitignore', () => {
    const paths = [...ix.db.fileHashes().keys()].map((f) => f.slice(ix.root.length + 1));
    assert.ok(!paths.some((f) => f.startsWith('generated/')), 'ignored folder');
    assert.ok(!paths.includes('scratch.tmp.py'), 'ignored pattern');
    assert.ok(paths.includes('src/shop/orders.py'));
  });

  it('qualifies symbols with the module name from the src/ layout', () => {
    const order = ix.symbol('shop.orders.Order');
    assert.equal(order.kind, 'class');
    assert.equal(order.namespace, 'shop.orders');
    assert.equal(order.doc, 'An order with lines.');
    assert.equal(ix.symbol('shop.orders.Order.total').kind, 'method');
    assert.equal(ix.symbol('shop.sub.deep.deep_total').kind, 'function');
    assert.equal(ix.symbol('shop.orders.load').exported, 1);
    assert.equal(ix.symbol('shop.orders.Order._private').exported, 0);
  });

  it('includes decorators in the line range and reads docstrings', () => {
    const total = ix.symbol('shop.orders.Order.total');
    assert.equal(total.start_line, 15); // @property
    assert.equal(total.doc, 'Sum of all lines.');
  });

  it('resolves relative, package and absolute imports', () => {
    assert.equal(ix.resolution('src/shop/__init__.py', '.orders'), 'src/shop/orders.py');
    assert.equal(ix.resolution('src/shop/orders.py', '.pricing', 'total'), 'src/shop/pricing.py');
    assert.equal(ix.resolution('src/shop/orders.py', '.', 'utils'), 'src/shop/utils.py');
    assert.equal(ix.resolution('src/shop/orders.py', 'shop.pricing'), 'src/shop/pricing.py');
    assert.equal(ix.resolution('src/shop/sub/deep.py', '..pricing'), 'src/shop/pricing.py');
    assert.equal(ix.resolution('tests/test_orders.py', 'shop.orders'), 'src/shop/orders.py');
  });

  it('leaves stdlib, third-party and out-of-tree imports unresolved', () => {
    assert.equal(ix.resolution('src/shop/orders.py', 'os'), null);
    assert.equal(ix.resolution('src/shop/orders.py', 'typing'), null);
    assert.equal(ix.resolution('tests/test_orders.py', 'pytest'), null);
    assert.equal(ix.resolution('src/shop/sub/deep.py', '...outside'), null);
  });

  it('records one row per imported name, with aliases', () => {
    const imports = ix.db.fileImports(ix.p('src/shop/orders.py'));
    assert.deepEqual(imports.filter((i) => i.spec === '.pricing').map((i) => i.names[0].name), ['total', 'TAX_RATE']);
    assert.equal(imports.find((i) => i.spec === 'shop.pricing')?.alias, 'p');
    assert.deepEqual(imports.find((i) => i.spec === 'typing')?.names, [{ name: '*' }]);
  });
});
