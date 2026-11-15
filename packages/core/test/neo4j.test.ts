import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  cypherLiteral, exportNeo4j, inBatches, NEO4J_SCHEMA, neo4jGroups, neo4jStarterQueries, starterExamples, starterQueriesScript,
  type CypherGroup, type Neo4jExportOptions,
} from '../src/index.ts';
import { indexFixture, indexSources, type Indexed } from './helpers.ts';

const TS = {
  'tsconfig.json': '{}',
  'src/base.ts': `/** A "shape" with an area. */
export abstract class Shape {
  abstract area(): number;
  describe(): string { return String(this.area()); }
}
export interface Named { name: string }
`,
  'src/util.ts': 'export function square(n: number): number { return n * n; }\n',
  'src/circle.ts': `import { Shape, type Named } from './base';
import { square } from './util';
export class Circle extends Shape implements Named {
  name = 'c';
  constructor(private r: number) { super(); }
  area(): number { return square(this.r) * square(1); }
}
`,
  'src/run.ts': `import { Circle } from './circle';
new Circle(2).describe();
`,
};

type Row = Record<string, unknown>;

/** The rows of the groups named `name` (and, for relationships, from and to those labels). */
function rows(groups: CypherGroup[], name: string, from?: string, to?: string): Row[] {
  return groups.filter((g) => g.name === name && g.from === from && g.to === to).flatMap((g) => [...g.rows()]);
}

const SECTION = { app: 'shop', repo: 'backend' };

function graph(ix: Indexed, opts: Partial<Neo4jExportOptions> = {}) {
  const groups = neo4jGroups(ix.db, { ...SECTION, root: ix.root, ...opts });
  const symbols = groups.filter((g) => g.name.startsWith('Symbol:')).flatMap((g) => [...g.rows()]);
  const files = rows(groups, 'File');
  const fileId = (path: string) => files.find((f) => f.path === path)?.id;
  return { groups, symbols, fileId, id: (qualifiedName: string) => ix.symbol(qualifiedName).id };
}

describe('neo4j export', () => {
  it('writes files, symbols and the linked uses between them', async () => {
    const ix = await indexSources(TS);
    try {
      const { groups, symbols, fileId, id } = graph(ix);

      // Every symbol once, labelled by kind, with its PageRank.
      const count = (ix.db.db.prepare('SELECT count(*) AS n FROM symbols').get() as { n: number }).n;
      assert.equal(symbols.length, count);
      assert.equal(new Set(symbols.map((s) => s.id)).size, count);
      const shape = symbols.find((s) => s.qualifiedName === 'src/base:Shape')!;
      assert.deepEqual(
        { kind: shape.kind, path: shape.path, exported: shape.exported, doc: shape.doc },
        { kind: 'class', path: 'src/base.ts', exported: true, doc: 'A "shape" with an area.' },
      );
      assert.ok(groups.find((g) => g.name === 'Symbol:Class')!.cypher.includes('CREATE (n:RefDex:Symbol:Class {app: $app, repo: $repo})'));
      const total = symbols.reduce((sum, s) => sum + Number(s.pagerank), 0);
      assert.ok(Math.abs(total - 1) < 1e-6, `pagerank sums to ${total}`);

      // Files, with paths relative to the root.
      assert.deepEqual(rows(groups, 'File').find((f) => f.path === 'src/circle.ts')?.name, 'circle.ts');

      // Structure.
      assert.ok(rows(groups, 'DECLARES', 'File', 'Symbol').some((r) => r.from === fileId('src/circle.ts') && r.to === id('src/circle:Circle')));
      assert.ok(rows(groups, 'CONTAINS', 'Symbol', 'Symbol').some((r) => r.from === id('src/circle:Circle') && r.to === id('src/circle:Circle.area')));
      const imports = rows(groups, 'IMPORTS', 'File', 'File').filter((r) => r.from === fileId('src/circle.ts'));
      assert.deepEqual(imports.map((r) => r.to).sort(), [fileId('src/base.ts'), fileId('src/util.ts')].sort());

      // Uses: one relationship per pair and type, with the number of uses and their distinct lines.
      assert.deepEqual(
        rows(groups, 'CALLS', 'Symbol', 'Symbol').find((r) => r.from === id('src/circle:Circle.area') && r.to === id('src/util:square')),
        { from: id('src/circle:Circle.area'), to: id('src/util:square'), count: 2, lines: [6] },
      );
      assert.ok(rows(groups, 'EXTENDS', 'Symbol', 'Symbol').some((r) => r.from === id('src/circle:Circle') && r.to === id('src/base:Shape')));
      assert.ok(rows(groups, 'IMPLEMENTS', 'Symbol', 'Symbol').some((r) => r.from === id('src/circle:Circle') && r.to === id('src/base:Named')));
      // Module-level code is the file.
      assert.ok(rows(groups, 'CALLS', 'File', 'Symbol').some((r) => r.from === fileId('src/run.ts') && r.to === id('src/circle:Circle')));

      // Unlinked uses only on request.
      assert.ok(!groups.some((g) => g.name === 'External' || g.to === 'External'));
      const external = graph(ix, { external: true }).groups;
      assert.ok(rows(external, 'External').some((r) => r.name === 'String'));
      assert.ok(rows(external, 'CALLS', 'Symbol', 'External').some((r) => r.from === id('src/base:Shape.describe') && r.to === 'String'));
    } finally {
      await ix.cleanup();
    }
  });

  it('merges the parts of a C# partial type into one node', async () => {
    const ix = await indexFixture('csharp');
    const { groups, symbols, fileId, id } = graph(ix);
    const customer = id('Acme.Domain.Customer');
    assert.equal(symbols.filter((s) => s.qualifiedName === 'Acme.Domain.Customer').length, 1);
    assert.equal(symbols.find((s) => s.id === customer)?.partial, true);

    // Both members hang off the canonical node, and both files lead to it.
    const contains = rows(groups, 'CONTAINS', 'Symbol', 'Symbol');
    for (const member of ['Acme.Domain.Customer.Name', 'Acme.Domain.Customer.AddOrder']) {
      assert.ok(contains.some((r) => r.from === customer && r.to === id(member)), member);
    }
    const parents = new Set(contains.filter((r) => r.to === customer).map((r) => r.from));
    const declaredBy = new Set(rows(groups, 'DECLARES', 'File', 'Symbol').filter((r) => r.to === customer || parents.has(r.to)).map((r) => r.from));
    for (const file of ['App/Domain/Customer.cs', 'App/Domain/Customer.Orders.cs']) assert.ok(declaredBy.has(fileId(file)), file);

    // No relationship points at a part that isn't a node.
    const nodeIds = new Set(symbols.map((s) => s.id));
    for (const g of groups.filter((g) => g.from === 'Symbol' || g.to === 'Symbol')) {
      for (const r of g.rows()) {
        if (g.from === 'Symbol') assert.ok(nodeIds.has(r.from), `${g.name} from ${r.from}`);
        if (g.to === 'Symbol') assert.ok(nodeIds.has(r.to), `${g.name} to ${r.to}`);
      }
    }
  });

  it('writes a script of batched statements', async () => {
    const ix = await indexSources(TS);
    const dir = await mkdtemp(join(tmpdir(), 'refdex-neo4j-'));
    try {
      const out = join(dir, 'graph.cypher');
      const summary = await exportNeo4j(ix.db, out, { ...SECTION, root: ix.root, batchSize: 2 });
      const text = await readFile(out, 'utf8');
      const statements = text.split('\n').filter((l) => !l.startsWith('//')).join('\n').split(';\n').map((s) => s.trim()).filter(Boolean);

      // Schema, then the repository's section, then removing only its previous load.
      const firstRows = statements.findIndex((s) => s.startsWith('UNWIND'));
      const prelude = statements.slice(0, firstRows);
      assert.deepEqual(prelude.slice(0, NEO4J_SCHEMA.length), NEO4J_SCHEMA);
      assert.deepEqual(prelude.slice(NEO4J_SCHEMA.length), [
        'MERGE (a:RefDex:App {name: "shop"})\nMERGE (p:RefDex:Repository {app: "shop", name: "backend"})\nMERGE (a)-[:HAS_REPOSITORY]->(p)',
        'MATCH (n:RefDex {app: "shop", repo: "backend"}) DETACH DELETE n',
      ]);
      // Every parameter is inlined.
      assert.ok(!/\$\w/.test(statements.join('\n')));

      // Batches of two rows, each statement scoped to the section, one comment per group.
      const rows = statements.slice(firstRows, -2);
      for (const s of rows) assert.match(s, /^UNWIND \[\n[^]*\n\] AS r\n/);
      const methods = rows.filter((s) => s.endsWith('CREATE (n:RefDex:Symbol:Method {app: "shop", repo: "backend"})\nSET n += r'));
      assert.ok(methods.length > 1);
      assert.equal(text.split('\n').filter((l) => l === '// (:Symbol:Method)').length, 1);
      assert.ok(rows.some((s) => s.endsWith('MATCH (a:Symbol {app: "shop", repo: "backend", id: r.from})\nMATCH (b:Symbol {app: "shop", repo: "backend", id: r.to})\nCREATE (a)-[:CALLS {count: r.count, lines: r.lines}]->(b)')));
      assert.ok(rows.some((s) => s.includes('CREATE (p)-[:HAS_FILE]->(n:RefDex:File {app: "shop", repo: "backend"})')));

      // Then the counts on the repository's node, and finally the app's starter queries.
      assert.match(statements.at(-1)!, /^MATCH \(a:App \{name: "shop"\}\)\nUNWIND \[\{name: "overview", /);
      assert.equal(statements.at(-2), `MATCH (p:Repository {app: "shop", name: "backend"}) SET p += {files: 4, symbols: ${summary.nodes.Symbol}, relationships: ${Object.values(summary.relationships).reduce((a, b) => a + b)}}, p.loadedAt = datetime()`);

      const symbols = (ix.db.db.prepare('SELECT count(*) AS n FROM symbols').get() as { n: number }).n;
      assert.equal(summary.nodes.Symbol, symbols);
      assert.equal(summary.nodes.File, 4); // tsconfig.json is not a source file
      assert.ok(summary.relationships.CALLS >= 3);
      assert.match(text, /\{from: \d+, to: \d+, count: 2, lines: \[6\]\}/);
    } finally {
      await ix.cleanup();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('writes Cypher literals', () => {
    assert.equal(cypherLiteral('say "hi"\\\nnext\tline'), '"say \\"hi\\"\\\\\\nnext\\tline"');
    assert.equal(cypherLiteral({ id: 1, doc: null, kind: undefined, ok: true, lines: [1, 2], 'odd key': 'x' }), '{id: 1, ok: true, lines: [1, 2], `odd key`: "x"}');
    assert.equal(cypherLiteral(1.5e-7), '1.5e-7');
    assert.equal(cypherLiteral(Number.NaN), 'null');
  });

  it('writes starter queries with real names from the code', async () => {
    const ix = await indexSources(TS);
    try {
      const examples = starterExamples(ix.db, ix.root);
      assert.deepEqual(examples, { type: 'Shape', method: 'square', caller: 'describe', file: 'src/circle.ts' });
      const app = 'my "shop"';
      const queries = neo4jStarterQueries(app, { ...examples, repo: 'web' });
      assert.equal(new Set(queries.map((q) => q.name)).size, queries.length);
      assert.deepEqual(queries.map((q) => q.order), queries.map((_, i) => i + 1));
      for (const q of queries) {
        // Every query is scoped to the app, ready to run: no parameters to set first.
        assert.ok(q.cypher.includes('{app: "my \\"shop\\""') || q.cypher.includes('{name: "my \\"shop\\""}'), q.name);
        assert.ok(!/\$\w/.test(q.cypher), q.name);
        assert.ok(q.title && q.description, q.name);
      }
      // Queries about the examples are scoped to their repository.
      assert.ok(queries.find((q) => q.name === 'callers')!.cypher.includes('repo: "web", name: "square"'));
      assert.ok(queries.find((q) => q.name === 'file')!.description.includes('src/circle.ts'));
      // Placeholders when the index has nothing to suggest.
      assert.ok(neo4jStarterQueries('a').find((q) => q.name === 'used-by')!.cypher.includes('name: "Service"'));

      const script = starterQueriesScript(app, queries);
      for (const q of queries) assert.ok(script.includes(`${q.cypher};`) && script.includes(`// ${q.order}. ${q.title}`));
    } finally {
      await ix.cleanup();
    }
  });

  it('splits rows into batches', () => {
    assert.deepEqual([...inBatches([1, 2, 3, 4, 5], 2)], [[1, 2], [3, 4], [5]]);
    assert.deepEqual([...inBatches([], 2)], []);
  });
});
