import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { indexFixture, type Indexed } from './helpers.ts';

describe('csharp adapter', () => {
  let ix: Indexed;
  before(async () => {
    ix = await indexFixture('csharp');
  });

  it('handles file-scoped and block namespaces', () => {
    assert.equal(ix.symbol('Acme.Domain.Guard').namespace, 'Acme.Domain');
    assert.equal(ix.symbol('Acme.Domain.Customer.AddOrder').namespace, 'Acme.Domain');
    assert.equal(ix.symbol('Acme.Services.CustomerService.Create').doc, 'Creates a customer.');
  });

  it('merges partial classes across files', () => {
    const parts = ix.db.symbolsByQualifiedName('Acme.Domain.Customer');
    assert.equal(parts.length, 2);
    const canonical = parts[0];
    assert.deepEqual(ix.db.symbolParts(canonical.id).map((p) => p.path.slice(ix.root.length + 1)), [
      'App/Domain/Customer.Orders.cs',
      'App/Domain/Customer.cs',
    ].sort());
    assert.deepEqual(ix.db.members(canonical.id).map((m) => m.name).sort(), ['AddOrder', 'Name']);
    // Search shows the type once.
    assert.equal(ix.db.search('Customer', 20, { kind: 'class' }).filter((s) => s.qualified_name === 'Acme.Domain.Customer').length, 1);
  });

  it('resolves using, using static and using alias', () => {
    const f = 'App/Services/CustomerService.cs';
    assert.equal(ix.resolution(f, 'Acme.Domain.Guard'), 'App/Domain/Guard.cs');
    assert.equal(ix.resolution(f, 'Acme.Domain.ICustomerRepository'), 'App/Domain/Guard.cs');
    assert.equal(ix.resolution('App/GlobalUsings.cs', 'Acme.Domain'), 'namespace:Acme.Domain');
    assert.equal(ix.resolution(f, 'System'), null);
  });

  it('applies global usings to every file of the same project only', () => {
    const app = ix.db.effectiveImports(ix.p('App/Services/CustomerService.cs')).map((i) => i.spec);
    assert.ok(app.includes('Acme.Domain') && app.includes('System.Text'), app.join());
    const lib = ix.db.effectiveImports(ix.p('Lib/Other.cs')).map((i) => i.spec);
    assert.deepEqual(lib, []);
  });
});
