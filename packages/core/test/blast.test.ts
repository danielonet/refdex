import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { blastRadius, isTestPath, type BlastCaller } from '../src/index.ts';
import { indexSources, type Indexed } from './helpers.ts';

const JAVA = {
  'src/main/java/app/Store.java': 'package app;\npublic interface Store { void save(String key); }\n',
  'src/main/java/app/DiskStore.java': `package app;
public class DiskStore implements Store {
  public void save(String key) { write(key); }
  private void write(String key) {}
}
`,
  'src/main/java/app/Service.java': `package app;
public class Service {
  private final Store store;
  public Service(Store store) { this.store = store; }
  public void put(String key) { store.save(key); }
}
`,
  'src/main/java/app/Api.java': `package app;
public class Api {
  private Service service;
  public void handle() { service.put("x"); }
  public void batch() { handle(); }
}
`,
  'src/test/java/app/ServiceTest.java': `package app;
public class ServiceTest {
  void testPut() {
    Service service = new Service(new DiskStore());
    service.put("k");
  }
}
`,
};

const TS = {
  'tsconfig.json': '{}',
  'src/util.ts': 'export function square(n: number): number { return n * n; }\n',
  'src/area.ts': "import { square } from './util';\nexport function area(r: number): number { return square(r) * 3; }\n",
  'src/area.test.ts': "import { area } from './area';\ntest('area', () => { area(2); });\n",
};

/** "level name [test]" per caller, e.g. "2 app.Api.handle". */
function describeCallers(callers: BlastCaller[]): string[] {
  return callers.map((c) => `${c.level} ${c.caller?.qualified_name ?? '(module)'}${c.test ? ' [test]' : ''}`).sort();
}

function ids(ix: Indexed, qualifiedName: string): number[] {
  return [ix.symbol(qualifiedName).id];
}

describe('blast radius', () => {
  it('java: follows calls through the interface an implementation implements, and marks tests', async () => {
    const ix = await indexSources(JAVA);
    try {
      const radius = blastRadius(ix.db, ids(ix, 'app.DiskStore.save'));
      assert.deepEqual(describeCallers(radius.callers), [
        '1 app.Service.put',
        '2 app.Api.handle',
        '2 app.ServiceTest.testPut [test]',
        '3 app.Api.batch',
      ]);
      assert.equal(radius.truncated, false);
    } finally {
      ix.db.close();
      await ix.cleanup();
    }
  });

  it('java: goes through an override at a deeper level too', async () => {
    const ix = await indexSources(JAVA);
    try {
      // write <- DiskStore.save, which is called only as Store.save.
      const radius = blastRadius(ix.db, ids(ix, 'app.DiskStore.write'), { depth: 3 });
      assert.deepEqual(describeCallers(radius.callers), [
        '1 app.DiskStore.save',
        '2 app.Service.put',
        '3 app.Api.handle',
        '3 app.ServiceTest.testPut [test]',
      ]);
    } finally {
      ix.db.close();
      await ix.cleanup();
    }
  });

  it('stops at the depth and at maxCallers', async () => {
    const ix = await indexSources(JAVA);
    try {
      assert.deepEqual(describeCallers(blastRadius(ix.db, ids(ix, 'app.DiskStore.save'), { depth: 1 }).callers), ['1 app.Service.put']);
      const capped = blastRadius(ix.db, ids(ix, 'app.DiskStore.save'), { maxCallers: 2 });
      assert.equal(capped.callers.length, 2);
      assert.equal(capped.truncated, true);
    } finally {
      ix.db.close();
      await ix.cleanup();
    }
  });

  it('typescript: keeps module-level callers, such as test() blocks', async () => {
    const ix = await indexSources(TS);
    try {
      const radius = blastRadius(ix.db, ids(ix, 'src/util:square'));
      assert.deepEqual(describeCallers(radius.callers), ['1 src/area:area', '2 (module) [test]']);
      const moduleCaller = radius.callers.find((c) => !c.caller)!;
      assert.equal(moduleCaller.path, ix.p('src/area.test.ts'));
      assert.equal(moduleCaller.line, 2);
    } finally {
      ix.db.close();
      await ix.cleanup();
    }
  });
});

describe('blast radius: unlinked calls', () => {
  it('reports calls it could not follow: every one for the target, calls on call results for callers', async () => {
    const ix = await indexSources({
      'src/app/Builder.java': `package app;
public class Builder {
  // Returns a type parameter: calls on its result can't be followed (a declared Builder could).
  public static <T> T newBuilder() { return null; }
  public Builder recordStats() { return this; }
  public Builder configure() { return recordStats(); }
}
`,
      'src/app/Use.java': `package app;
public class Use {
  void chained() { Builder.newBuilder().recordStats(); }
  <B> void viaCaller(B b) { Builder.newBuilder().configure(); b.configure(); }
}
`,
      // Another configure(), so `b.configure()` on an object of unknown type (B) stays unlinked.
      'src/app/Other.java': 'package app;\npublic class Other { public void configure() {} }\n',
    });
    try {
      const radius = blastRadius(ix.db, ids(ix, 'app.Builder.recordStats'));
      assert.deepEqual(describeCallers(radius.callers), ['1 app.Builder.configure']);
      assert.deepEqual(radius.unlinked.map((u) => `${u.symbol.qualified_name} ${u.target ? 'target' : 'caller'} ${u.count} ${u.example.qualifier}`), [
        'app.Builder.recordStats target 1 Builder.newBuilder()',
        // b.configure() is not counted for a caller: only calls on call results are.
        'app.Builder.configure caller 1 Builder.newBuilder()',
      ]);
      assert.deepEqual(blastRadius(ix.db, ids(ix, 'app.Other.configure')).unlinked.map((u) => u.count), [2]);
    } finally {
      ix.db.close();
      await ix.cleanup();
    }
  });
});

describe('isTestPath', () => {
  it('recognizes each language\'s conventions', () => {
    for (const path of [
      '/r/src/test/java/app/ServiceTest.java',
      '/r/guava-tests/test/com/google/common/cache/CacheBuilderTest.java',
      '/r/src/main/java/app/FooTest.java',
      '/r/src/main/java/app/FooIT.java',
      '/r/App.Tests/OrderServiceTests.cs',
      '/r/src/App.UnitTests/Orders.cs',
      '/r/guava-tests/benchmark/com/google/common/cache/SegmentBenchmark.java',
      '/r/src/App/OrderTests.cs',
      '/r/pkg/test_orders.py',
      '/r/pkg/orders_test.py',
      '/r/tests/conftest.py',
      '/r/src/orders.test.ts',
      '/r/src/orders.spec.tsx',
      '/r/src/__tests__/orders.ts',
      'C:\\r\\App.Tests\\Orders.cs',
    ]) {
      assert.equal(isTestPath(path), true, path);
    }
    for (const path of [
      '/r/src/main/java/app/Service.java',
      '/r/src/main/java/app/Testing.java',
      '/r/guava-testlib/src/com/google/common/testing/EqualsTester.java',
      '/r/src/App/Orders.cs',
      '/r/pkg/orders.py',
      '/r/pkg/contest.py',
      '/r/src/orders.ts',
      '/r/src/latest.ts',
      '/r/contests/src/Main.java',
    ]) {
      assert.equal(isTestPath(path), false, path);
    }
  });
});
