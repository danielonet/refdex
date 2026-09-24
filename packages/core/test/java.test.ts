import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { indexFixture, type Indexed } from './helpers.ts';

describe('java adapter', () => {
  let ix: Indexed;
  before(async () => {
    ix = await indexFixture('java');
  });

  it('qualifies symbols with the package, including inner classes and overloads', () => {
    const invoice = ix.symbol('com.acme.model.Invoice');
    assert.equal(invoice.namespace, 'com.acme.model');
    assert.equal(invoice.doc, 'An invoice.');
    assert.equal(ix.symbol('com.acme.model.Invoice.Line').kind, 'class');
    assert.equal(ix.db.symbolsByQualifiedName('com.acme.service.InvoiceService.find').length, 2);
    assert.equal(ix.symbol('com.acme.service.InvoiceService.lines').exported, 0);
  });

  it('resolves type, nested type, wildcard and static imports through the namespace index', () => {
    const f = 'src/main/java/com/acme/service/InvoiceService.java';
    assert.equal(ix.resolution(f, 'com.acme.model.Invoice'), 'src/main/java/com/acme/model/Invoice.java');
    assert.equal(ix.resolution(f, 'com.acme.model.Invoice.Line'), 'src/main/java/com/acme/model/Invoice.java');
    assert.equal(ix.resolution(f, 'com.acme.model'), 'namespace:com.acme.model');
    assert.equal(ix.resolution(f, 'com.acme.util.Strings.join'), 'src/main/java/com/acme/util/Strings.java');
    assert.equal(ix.resolution(f, 'java.util.List'), null);
  });
});
