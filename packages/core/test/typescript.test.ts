import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { indexFixture, type Indexed } from './helpers.ts';

describe('typescript adapter', () => {
  let ix: Indexed;
  before(async () => {
    ix = await indexFixture('typescript');
  });

  it('qualifies symbols with the module path', () => {
    const model = ix.symbol('src/models/order:OrderModel');
    assert.equal(model.kind, 'class');
    assert.equal(model.exported, 1);
    assert.equal(ix.symbol('src/models/order:Hidden').exported, 0);
    assert.equal(ix.symbol('src/models/order:OrderModel.total').kind, 'method');
    assert.equal(ix.symbol('src/models/order:OrderModel.#secret').kind, 'method');
    assert.equal(ix.symbol('src/util:helper').kind, 'function');
    assert.equal(ix.symbol('src/view:OrderView').kind, 'function');
  });

  it('reads JSDoc and keeps interface members but not type-literal properties', () => {
    const order = ix.symbol('src/models/order:Order');
    assert.equal(order.doc, 'A customer order.');
    assert.equal(order.start_line, 2);
    const members = ix.db.members(order.id).map((m) => m.name);
    assert.deepEqual(members, ['id', 'lines', 'total']);
    assert.equal(ix.db.symbolsByQualifiedName('src/models/order:Order.lines.sku').length, 0);
  });

  it('resolves relative imports, .js extensions and index files', () => {
    assert.equal(ix.resolution('src/services/orderService.ts', '../util.js'), 'src/util.ts');
    assert.equal(ix.resolution('src/view.tsx', './services/orderService'), 'src/services/orderService.ts');
    assert.equal(ix.resolution('src/models/index.ts', './order'), 'src/models/order.ts');
  });

  it('resolves tsconfig path aliases (with extends, comments and trailing commas)', () => {
    assert.equal(ix.resolution('src/services/orderService.ts', '@app/models/order'), 'src/models/order.ts');
    assert.equal(ix.resolution('src/services/orderService.ts', '@models'), 'src/models/index.ts');
  });

  it('resolves workspace packages through package.json exports to their source', () => {
    assert.equal(ix.resolution('src/services/orderService.ts', '@fx/lib'), 'packages/lib/src/index.ts');
  });

  it('leaves node_modules and missing files unresolved', () => {
    assert.equal(ix.resolution('src/services/orderService.ts', 'node:fs'), null);
    assert.equal(ix.resolution('src/services/orderService.ts', 'react'), null);
    assert.equal(ix.resolution('src/services/orderService.ts', './side-effect-missing'), null);
  });

  it('follows barrel re-exports to the defining symbol', () => {
    const barrel = ix.p('src/models/index.ts');
    assert.equal(ix.db.resolveExport(barrel, 'OrderModel')?.qualified_name, 'src/models/order:OrderModel');
    assert.equal(ix.db.resolveExport(barrel, 'Client')?.qualified_name, 'src/models/customer:Customer');
    assert.equal(ix.db.resolveExport(barrel, 'Customer'), undefined);
    assert.equal(ix.db.resolveExport(barrel, 'Hidden'), undefined);
  });

  it('records imported names and aliases', () => {
    const imports = ix.db.fileImports(ix.p('src/services/orderService.ts'));
    assert.deepEqual(imports.find((i) => i.spec === '@models')?.names, [{ name: 'Client' }, { name: 'OrderModel', alias: 'Model' }]);
    assert.deepEqual(imports.find((i) => i.spec === 'node:fs')?.names, [{ name: '*', alias: 'fs' }]);
    assert.deepEqual(imports.find((i) => i.spec === 'react')?.names, [{ name: 'default', alias: 'React' }]);
  });
});
