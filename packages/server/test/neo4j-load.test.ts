import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { auth, driver as neo4jDriver } from 'neo4j-driver-lite';
import { IndexDb, Indexer, NEO4J_CLEAR, NEO4J_SCHEMA, NEO4J_SECTION, NEO4J_STARTER_QUERIES, NEO4J_STARTER_SOURCE, NEO4J_STATS, TreeSitter } from '@refdex/core';
import { checkNeo4j, describeNeo4jError, isLocalNeo4j, loadGraph, loadNeo4j, type CypherRunner, type LoadProgress } from '../src/neo4j-load.ts';

const FIXTURES = join(import.meta.dirname, '..', '..', 'core', 'test', 'fixtures');
let treeSitter: Promise<TreeSitter> | undefined;

async function indexed(fixture: string): Promise<{ db: IndexDb; root: string }> {
  const root = join(FIXTURES, fixture);
  const db = new IndexDb(':memory:');
  await new Indexer(db, await (treeSitter ??= TreeSitter.create()), root).syncAll();
  return { db, root };
}

describe('neo4j load', () => {
  it('sets up the section, clears its previous load in batches, then writes batches of rows', async () => {
    const { db, root } = await indexed('typescript');
    const calls: { cypher: string; params: Record<string, unknown> }[] = [];
    let clears = 0;
    const run: CypherRunner = async (cypher, params = {}) => {
      calls.push({ cypher, params });
      // A previous load of 10,003 nodes: one full batch, then the rest.
      if (cypher === NEO4J_CLEAR) return [{ deleted: clears++ === 0 ? params.limit : 3 }];
      return [];
    };
    const progress: LoadProgress[] = [];
    const s = await loadGraph(db, run, { app: 'shop', repo: 'web', root, batchSize: 3 }, (p) => progress.push(p));

    assert.deepEqual(calls.slice(0, NEO4J_SCHEMA.length).map((c) => c.cypher), NEO4J_SCHEMA);
    assert.deepEqual(calls[NEO4J_SCHEMA.length], { cypher: NEO4J_SECTION, params: { app: 'shop', repo: 'web' } });
    assert.equal(calls.filter((c) => c.cypher === NEO4J_CLEAR).length, 2);
    assert.equal(s.deleted, 10_003);

    const batches = calls.filter((c) => c.cypher.startsWith('UNWIND $rows AS r\n'));
    assert.ok(batches.length > 1);
    for (const b of batches) {
      assert.equal(b.params.app, 'shop');
      assert.equal(b.params.repo, 'web');
      const rows = b.params.rows as unknown[];
      assert.ok(rows.length >= 1 && rows.length <= 3);
    }
    const written = batches.reduce((n, b) => n + (b.params.rows as unknown[]).length, 0);
    const total = (counts: Record<string, number>) => Object.values(counts).reduce((a, b) => a + b, 0);
    assert.equal(written, total(s.nodes) + total(s.relationships));
    assert.equal(s.nodes.File, (db.db.prepare('SELECT count(*) AS n FROM files').get() as { n: number }).n);

    // Then the counts on the repository's node, and the app's starter queries last: written
    // because the fake server has none yet.
    assert.equal(calls.at(-1)?.cypher, NEO4J_STARTER_QUERIES);
    assert.equal(calls.at(-1)?.params.app, 'shop');
    assert.ok((calls.at(-1)?.params.queries as unknown[]).length >= 10);
    assert.equal(calls.at(-2)?.cypher, NEO4J_STARTER_SOURCE);
    assert.deepEqual(calls.at(-3), {
      cypher: NEO4J_STATS,
      params: { app: 'shop', repo: 'web', stats: { files: s.nodes.File, symbols: s.nodes.Symbol, relationships: total(s.relationships) } },
    });
    assert.deepEqual(progress[0], { stage: 'removing the previous graph', rows: 10_000 });
    assert.equal(progress.at(-1)?.rows, written);
    db.close();
  });

  it('knows which servers are on this machine', () => {
    for (const uri of ['neo4j://localhost:7687', 'bolt://127.0.0.1:7687', 'neo4j+s://localhost', 'bolt://[::1]:7687']) assert.ok(isLocalNeo4j(uri), uri);
    for (const uri of ['neo4j+s://abc.databases.neo4j.io', 'bolt://db.internal:7687', 'not a uri']) assert.ok(!isLocalNeo4j(uri), uri);
  });

  it('explains connection failures', async () => {
    const conn = { uri: 'neo4j://127.0.0.1:1', user: 'neo4j', password: 'x' };
    await assert.rejects(checkNeo4j(conn), (e) => {
      const failure = describeNeo4jError(e, conn.uri);
      assert.equal(failure.kind, 'unreachable');
      assert.match(failure.message, /^could not reach Neo4j at neo4j:\/\/127\.0\.0\.1:1/);
      return true;
    });
  });
});

// Against a real server: REFDEX_TEST_NEO4J_URI=neo4j://localhost:7687 REFDEX_TEST_NEO4J_PASSWORD=...
const uri = process.env.REFDEX_TEST_NEO4J_URI;
describe('neo4j load into a server', { skip: !uri && 'set REFDEX_TEST_NEO4J_URI and REFDEX_TEST_NEO4J_PASSWORD' }, () => {
  const conn = { uri: uri!, user: process.env.REFDEX_TEST_NEO4J_USER ?? 'neo4j', password: process.env.REFDEX_TEST_NEO4J_PASSWORD ?? '' };
  const app = `refdex-test-${process.pid}`;

  async function query(cypher: string, params: Record<string, unknown> = {}) {
    const driver = neo4jDriver(conn.uri, auth.basic(conn.user, conn.password));
    try {
      const { records } = await driver.executeQuery(cypher, params);
      return records.map((r) => r.toObject());
    } finally {
      await driver.close();
    }
  }
  const counts = async () => Object.fromEntries((await query(
    'MATCH (n:RefDex {app: $app}) WHERE n.repo IS NOT NULL RETURN n.repo AS repo, count(*) AS n', { app },
  )).map((r) => [r.repo, Number(r.n)]));

  it('keeps several repositories of an app apart and reloads one in place', async () => {
    const ts = await indexed('typescript');
    const py = await indexed('python');
    try {
      const a = await loadNeo4j(ts.db, conn, { app, repo: 'web', root: ts.root });
      const b = await loadNeo4j(py.db, conn, { app, repo: 'api', root: py.root });
      const nodes = (s: typeof a) => Object.values(s.nodes).reduce((x, y) => x + y, 0);
      assert.deepEqual(await counts(), { web: nodes(a), api: nodes(b) });

      // The same ids in both repositories don't collide, and relationships stay within one.
      const [cross] = await query('MATCH (x:RefDex {app: $app})-[r]->(y:RefDex {app: $app}) WHERE x.repo <> y.repo RETURN count(r) AS n', { app });
      assert.equal(Number(cross.n), 0);
      const [rels] = await query('MATCH (:RefDex {app: $app, repo: "web"})-[r]->() WHERE type(r) <> "HAS_FILE" RETURN count(r) AS n', { app });
      assert.equal(Number(rels.n), Object.values(a.relationships).reduce((x, y) => x + y, 0));

      // Reloading replaces only that repository.
      const again = await loadNeo4j(ts.db, conn, { app, repo: 'web', root: ts.root });
      assert.equal(again.deleted, nodes(a));
      assert.deepEqual(await counts(), { web: nodes(a), api: nodes(b) });

      const info = await checkNeo4j(conn);
      assert.deepEqual(info.apps.find((x) => x.name === app)?.repositories, ['api', 'web']);
      const [repo] = await query('MATCH (:App {name: $app})-[:HAS_REPOSITORY]->(p:Repository {name: "web"}) RETURN p.files AS files, p.loadedAt IS NOT NULL AS loaded', { app });
      assert.deepEqual({ files: Number(repo.files), loaded: repo.loaded }, { files: a.nodes.File, loaded: true });
      // Every starter query runs, and most find something in these small fixtures.
      const starters = await query('MATCH (:App {name: $app})-[:HAS_QUERY]->(q:StarterQuery) RETURN q.name AS name, q.cypher AS cypher ORDER BY q.order', { app });
      assert.ok(starters.length >= 10);
      const found: string[] = [];
      for (const q of starters) {
        const rows = await query(String(q.cypher));
        if (rows.length) found.push(String(q.name));
      }
      for (const name of ['overview', 'contents', 'core', 'imports', 'largest-types', 'search']) assert.ok(found.includes(name), `${name} found nothing`);
      // Loading again keeps one set, with examples from the largest repository.
      await loadNeo4j(py.db, conn, { app, repo: 'api', root: py.root });
      const [stored] = await query('MATCH (q:StarterQuery {app: $app}) RETURN count(q) AS n', { app });
      assert.equal(Number(stored.n), starters.length);
      const largest = a.nodes.Symbol >= b.nodes.Symbol ? 'web' : 'api';
      const [callers] = await query('MATCH (q:StarterQuery {app: $app, name: "callers"}) RETURN q.cypher AS cypher', { app });
      assert.ok(String(callers.cypher).includes(`repo: "${largest}"`), String(callers.cypher));

      const [ints] = await query('MATCH (s:Symbol {app: $app, repo: "web"}) RETURN valueType(s.id) AS id, valueType(s.pagerank) AS pagerank LIMIT 1', { app });
      assert.deepEqual(ints, { id: 'INTEGER NOT NULL', pagerank: 'FLOAT NOT NULL' });
    } finally {
      ts.db.close();
      py.db.close();
      await query('MATCH (n:RefDex) WHERE n.app = $app OR (n:App AND n.name = $app) DETACH DELETE n', { app });
    }
  });
});
