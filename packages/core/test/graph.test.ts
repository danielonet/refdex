import assert from 'node:assert/strict';
import { rename, writeFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { pageRank } from '../src/index.ts';
import { indexSources } from './helpers.ts';

const TS = {
  'tsconfig.json': '{}',
  'src/base.ts': `export abstract class Shape {
  abstract area(): number;
  describe(): string { return String(this.area()); }
}
export interface Named { name: string }
`,
  'src/circle.ts': `import { Shape, type Named } from './base';
import * as util from './util';
export class Circle extends Shape implements Named {
  name = 'c';
  constructor(private r: number) { super(); }
  area(): number { return util.square(this.r) * Math.PI; }
  label(): string { return this.describe(); }
}
`,
  'src/util.ts': `export function square(n: number): number { return n * n; }
export const cube = (n: number) => square(n) * n;
`,
  'src/index.ts': `export * from './circle';\n`,
  'src/app.ts': `import { Circle } from './index';
function local() { return 1; }
export function main(): Circle {
  local();
  const c = new Circle(2);
  c.label();
  return c;
}
`,
  'src/save.ts': `import { A } from './a';
import { B } from './b';
export function saveAll(x: A | B) { x.save(); }
`,
  'src/a.ts': 'export class A { save() {} }\n',
  'src/b.ts': 'export class B { save() {} }\n',
};

describe('edges', () => {
  it('typescript: inheritance, this/super, module aliases, barrels, lexical scope', async () => {
    const ix = await indexSources(TS);
    try {
      const edges = ix.edges();
      for (const e of [
        'src/circle:Circle -extends-> src/base:Shape',
        'src/circle:Circle -implements-> src/base:Named',
        'src/circle:Circle.area -calls-> src/util:square',
        // Inherited through the resolved base type.
        'src/circle:Circle.label -calls-> src/base:Shape.describe',
        'src/base:Shape.describe -calls-> src/base:Shape.area',
        'src/util:cube -calls-> src/util:square',
        // Through the src/index barrel.
        'src/app:main -references-> src/circle:Circle',
        'src/app:main -calls-> src/circle:Circle',
        'src/app:main -calls-> src/app:local',
        // Unknown receiver, but only one visible type declares label().
        'src/app:main -calls-> src/circle:Circle.label',
      ]) assert.ok(edges.includes(e), `missing ${e} in\n${edges.join('\n')}`);
      // Two visible types declare save(): ambiguous, so not linked.
      assert.ok(!edges.some((e) => e.includes('.save')), edges.join('\n'));
      // Library calls stay unlinked.
      assert.ok(!edges.some((e) => /String|PI/.test(e)));
      assert.ok(ix.summary.edgesUnresolved > 0);
    } finally {
      await ix.cleanup();
    }
  });

  it('typescript: edges follow changed, renamed and restored declarations', async () => {
    const ix = await indexSources(TS);
    try {
      const util = ix.p('src/util.ts');
      await writeFile(util, 'export function square(n: number): number {\n  return n ** 2;\n}\n');
      await ix.indexer.syncPaths([util]);
      assert.ok(ix.edges().includes('src/circle:Circle.area -calls-> src/util:square'));

      await writeFile(util, 'export function sq(n: number): number { return n ** 2; }\n');
      await ix.indexer.syncPaths([util]);
      assert.ok(!ix.edges().some((e) => e.endsWith('src/util:square')));

      await writeFile(util, 'export function square(n: number): number { return n * n; }\n');
      await ix.indexer.syncPaths([util]);
      assert.ok(ix.edges().includes('src/circle:Circle.area -calls-> src/util:square'));

      // A file whose import starts to resolve re-links its uses.
      await rename(ix.p('src/b.ts'), ix.p('src/b2.ts'));
      await ix.indexer.syncPaths([ix.p('src/b.ts'), ix.p('src/b2.ts')]);
      assert.ok(ix.edges().includes('src/save:saveAll -calls-> src/a:A.save'), 'save() is unique once B is unresolved');
      await rename(ix.p('src/b2.ts'), ix.p('src/b.ts'));
      await ix.indexer.syncPaths([ix.p('src/b.ts'), ix.p('src/b2.ts')]);
      assert.ok(ix.edges().includes('src/save:saveAll -references-> src/b:B'));
      assert.ok(!ix.edges().some((e) => e.includes('.save')), 'ambiguous again');
    } finally {
      await ix.cleanup();
    }
  });

  it('python: self, super(), inherited methods, module aliases', async () => {
    const ix = await indexSources({
      'pyproject.toml': '',
      'src/pkg/__init__.py': '',
      'src/pkg/base.py': 'class Base:\n    def run(self):\n        return self.step()\n\n    def step(self):\n        return 1\n',
      'src/pkg/helpers.py': 'def twice(x):\n    return x * 2\n',
      'src/pkg/impl.py': `from .base import Base
from . import helpers
import pkg.helpers as h


class Impl(Base):
    def step(self) -> int:
        return helpers.twice(super().step())

    def go(self):
        return h.twice(self.run())


def make() -> Impl:
    return Impl()
`,
    });
    try {
      const edges = ix.edges();
      for (const e of [
        'pkg.impl.Impl -extends-> pkg.base.Base',
        'pkg.impl.Impl.step -calls-> pkg.helpers.twice',
        'pkg.impl.Impl.step -calls-> pkg.base.Base.step',
        'pkg.impl.Impl.go -calls-> pkg.helpers.twice',
        'pkg.impl.Impl.go -calls-> pkg.base.Base.run',
        'pkg.base.Base.run -calls-> pkg.base.Base.step',
        'pkg.impl.make -references-> pkg.impl.Impl',
        'pkg.impl.make -calls-> pkg.impl.Impl',
      ]) assert.ok(edges.includes(e), `missing ${e} in\n${edges.join('\n')}`);
    } finally {
      await ix.cleanup();
    }
  });

  it('java: packages, static imports, implicit this through base classes', async () => {
    const ix = await indexSources({
      'pom.xml': '<project/>',
      'src/com/a/Base.java': 'package com.a;\npublic abstract class Base {\n  protected int helper() { return 1; }\n  public abstract int run();\n}\n',
      'src/com/a/Api.java': 'package com.a;\npublic interface Api { int run(); }\n',
      'src/com/b/Util.java': 'package com.b;\npublic class Util {\n  public static int twice(int x) { return x * 2; }\n}\n',
      'src/com/b/Impl.java': `package com.b;
import com.a.*;
import static com.b.Util.twice;
public class Impl extends Base implements Api {
  public int run() { return twice(helper()) + Util.twice(1) + String.valueOf(1).length(); }
}
`,
    });
    try {
      const edges = ix.edges();
      for (const e of [
        'com.b.Impl -extends-> com.a.Base',
        'com.b.Impl -implements-> com.a.Api',
        'com.b.Impl.run -calls-> com.b.Util.twice',
        'com.b.Impl.run -calls-> com.a.Base.helper',
      ]) assert.ok(edges.includes(e), `missing ${e} in\n${edges.join('\n')}`);
      assert.equal(edges.filter((e) => e === 'com.b.Impl.run -calls-> com.b.Util.twice').length, 2);
      assert.ok(!edges.some((e) => /valueOf|length/.test(e)));
    } finally {
      await ix.cleanup();
    }
  });

  it('csharp: base lists split into extends and implements, usings, object creation', async () => {
    const ix = await indexSources({
      'App.csproj': '<Project/>',
      'Domain/Entity.cs': 'namespace App.Domain;\npublic abstract class Entity {\n  public int Id { get; set; }\n  protected void Touch() {}\n}\n',
      'Domain/IRepo.cs': 'namespace App.Domain;\npublic interface IRepo<T> { T Find(int id); }\n',
      'Services/Repo.cs': `using App.Domain;
namespace App.Services;
public class Customer : Entity { public void Save() { Touch(); } }
public class Repo : IRepo<Customer> {
  public Customer Find(int id) { var c = new Customer(); c.Save(); Console.WriteLine(c.Id); return c; }
}
`,
    });
    try {
      const edges = ix.edges();
      for (const e of [
        'App.Services.Customer -extends-> App.Domain.Entity',
        'App.Services.Repo -implements-> App.Domain.IRepo',
        'App.Services.Repo -references-> App.Services.Customer',
        'App.Services.Customer.Save -calls-> App.Domain.Entity.Touch',
        'App.Services.Repo.Find -calls-> App.Services.Customer',
        'App.Services.Repo.Find -calls-> App.Services.Customer.Save',
        'App.Services.Repo.Find -references-> App.Services.Customer',
      ]) assert.ok(edges.includes(e), `missing ${e} in\n${edges.join('\n')}`);
      assert.ok(!edges.some((e) => e.includes('WriteLine')));
    } finally {
      await ix.cleanup();
    }
  });
});

describe('pageRank', () => {
  it('ranks the most used node first and sums to 1', () => {
    // 1..4 all use 5; 5 uses 6.
    const scores = pageRank([1, 2, 3, 4, 5, 6], [1, 2, 3, 4].map((from) => ({ from, to: 5, count: 1 })).concat({ from: 5, to: 6, count: 3 }));
    const order = [...scores].sort((a, b) => b[1] - a[1]).map(([id]) => id);
    assert.deepEqual(order.slice(0, 2).sort(), [5, 6]);
    assert.ok(scores.get(5)! > scores.get(1)!);
    assert.ok(Math.abs([...scores.values()].reduce((a, b) => a + b, 0) - 1) < 1e-6);
    assert.equal(pageRank([], []).size, 0);
  });
});
