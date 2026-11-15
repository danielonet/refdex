import { closeSync, openSync, writeSync } from 'node:fs';
import { basename, relative, sep } from 'node:path';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { IndexDb } from './db.ts';
import { cypherLiteral } from './cypher-literal.ts';
import type { EdgeType, SymbolKind } from './model.ts';
import { NEO4J_STARTER_QUERIES, neo4jStarterQueries, type StarterExamples } from './neo4j-queries.ts';
import { pageRank } from './rank.ts';

/**
 * The index as a Neo4j property graph, for `refdex export-neo4j` (a Cypher script) and
 * `refdex neo4j load` (through the driver, server/src/neo4j-load.ts). Several repositories share
 * one database: each is a section of an app, such as the folders of a VS Code workspace.
 *
 *   (:App {name})-[:HAS_REPOSITORY]->(:Repository {app, name})-[:HAS_FILE]->(:File)
 *   (:File)-[:DECLARES]->(:Symbol)            top-level declarations of the file
 *   (:Symbol)-[:CONTAINS]->(:Symbol)          class -> method, namespace -> class, ...
 *   (:Symbol|:File)-[:CALLS|EXTENDS|IMPLEMENTS|REFERENCES {count, lines}]->(:Symbol)
 *   (:File)-[:IMPORTS {lines}]->(:File)
 *
 * Every node is labelled :RefDex. Files, symbols and external names carry `app` and `repo`, and
 * their `id` is the index's row id, unique within the repository; loading a repository again
 * replaces only its own nodes. File nodes are the sources of module-level uses. Symbols carry their
 * kind as a second label (:Class, :Method, ...) and their PageRank within the repository. The parts
 * of a C# partial type become one node, which each file with a part DECLARES. Uses of names outside
 * the index are left out unless `external` is set; they then point at (:External {name}) nodes.
 *
 * Statements take their values as parameters: `$app`, `$repo` and, per batch, `$rows` (bound to
 * `r`). The script writer inlines them.
 */

export interface Neo4jTarget {
  /** The app: a group of repositories, such as a workspace. */
  app: string;
  /** The repository within the app. */
  repo: string;
}

export interface Neo4jExportOptions extends Neo4jTarget {
  /** Also export uses of names outside the index (library calls, dynamic or ambiguous ones). */
  external?: boolean;
  /** Paths under this folder are written relative to it, with `/` separators. */
  root?: string;
  /** Rows per statement. */
  batchSize?: number;
}

export interface Neo4jExportSummary {
  /** Nodes per label: File, Symbol, External. */
  nodes: Record<string, number>;
  /** Relationships per type. */
  relationships: Record<string, number>;
}

/** Rows that share one statement: Cypher can't take labels or relationship types as parameters. */
export interface CypherGroup {
  /** Labels after :RefDex (`Symbol:Method`) for nodes, the type (`CALLS`) for relationships. */
  name: string;
  /** Relationship groups: the labels of the start and end nodes. */
  from?: 'File' | 'Symbol';
  to?: 'File' | 'Symbol' | 'External';
  /** Runs once per row, which is bound to `r` (`UNWIND $rows AS r`). */
  cypher: string;
  rows(): Iterable<Record<string, unknown>>;
}

/**
 * Constraints and indexes, each idempotent. Composite uniqueness constraints need Neo4j 5 and work
 * in Community Edition.
 */
export const NEO4J_SCHEMA = [
  'CREATE CONSTRAINT refdex_app IF NOT EXISTS FOR (n:App) REQUIRE n.name IS UNIQUE',
  'CREATE CONSTRAINT refdex_repository IF NOT EXISTS FOR (n:Repository) REQUIRE (n.app, n.name) IS UNIQUE',
  'CREATE CONSTRAINT refdex_file IF NOT EXISTS FOR (n:File) REQUIRE (n.app, n.repo, n.id) IS UNIQUE',
  'CREATE CONSTRAINT refdex_symbol IF NOT EXISTS FOR (n:Symbol) REQUIRE (n.app, n.repo, n.id) IS UNIQUE',
  'CREATE CONSTRAINT refdex_external IF NOT EXISTS FOR (n:External) REQUIRE (n.app, n.repo, n.name) IS UNIQUE',
  'CREATE INDEX refdex_section IF NOT EXISTS FOR (n:RefDex) ON (n.app, n.repo)',
  'CREATE INDEX refdex_symbol_name IF NOT EXISTS FOR (n:Symbol) ON (n.name)',
  'CREATE INDEX refdex_symbol_qualified_name IF NOT EXISTS FOR (n:Symbol) ON (n.qualifiedName)',
  'CREATE CONSTRAINT refdex_starter_query IF NOT EXISTS FOR (n:StarterQuery) REQUIRE (n.app, n.name) IS UNIQUE',
];

/** Creates the app and the repository's node if they are new. */
export const NEO4J_SECTION = `MERGE (a:RefDex:App {name: $app})
MERGE (p:RefDex:Repository {app: $app, name: $repo})
MERGE (a)-[:HAS_REPOSITORY]->(p)`;

/**
 * Removes up to `$limit` of the repository's files, symbols and external names with their
 * relationships, and returns how many as `deleted`; run it until that is less than the limit.
 */
export const NEO4J_CLEAR = 'MATCH (n:RefDex {app: $app, repo: $repo}) WITH n LIMIT $limit DETACH DELETE n RETURN count(*) AS deleted';

/** Records what was loaded on the repository's node; `$stats` is a map. */
export const NEO4J_STATS = 'MATCH (p:Repository {app: $app, name: $repo}) SET p += $stats, p.loadedAt = datetime()';

const KIND_LABELS: Record<SymbolKind, string> = {
  namespace: 'Namespace', module: 'Module', class: 'Class', interface: 'Interface', enum: 'Enum',
  type_alias: 'TypeAlias', function: 'Function', method: 'Method', property: 'Property', field: 'Field',
};

const EDGE_LABELS: Record<EdgeType, string> = { calls: 'CALLS', extends: 'EXTENDS', implements: 'IMPLEMENTS', references: 'REFERENCES' };

/** What an unlinked use names, as get_symbol_source's with_callees shows it: `qualifier.name`. */
const EXTERNAL_NAME = `coalesce(e.qualifier || '.', '') || e.name`;

const DEFAULT_BATCH_SIZE = 500;

/**
 * The repository's graph as statement groups, in load order: nodes before the relationships
 * between them. Rows are read lazily; read them in one transaction (see `inSnapshot`) so they
 * match even while the daemon updates the index.
 */
export function neo4jGroups(index: IndexDb, opts: Neo4jExportOptions): CypherGroup[] {
  const db = index.db;
  const path = relativeTo(opts.root);
  const ids = (db.prepare('SELECT id FROM symbols WHERE merged_into IS NULL').all() as { id: number }[]).map((r) => r.id);
  const ranks = pageRank(ids, index.graph());
  const node = (labels: string) => `CREATE (n:RefDex:${labels} {app: $app, repo: $repo})\nSET n += r`;

  const groups: CypherGroup[] = [{
    name: 'File',
    cypher: `MATCH (p:Repository {app: $app, name: $repo})\nCREATE (p)-[:HAS_FILE]->(n:RefDex:File {app: $app, repo: $repo})\nSET n += r`,
    rows: () => map(query(db, 'SELECT id, path, language, project, chars FROM files ORDER BY id'), (f) => ({
      id: f.id, name: basename(String(f.path)), path: path(f.path), language: f.language, project: path(f.project), chars: f.chars,
    })),
  }];

  for (const [kind, label] of Object.entries(KIND_LABELS)) {
    groups.push({
      name: `Symbol:${label}`,
      cypher: node(`Symbol:${label}`),
      rows: () => map(query(db,
        `SELECT s.id, s.kind, s.native_kind, s.name, s.qualified_name, s.namespace, s.signature, s.doc, s.value_type,
           s.exported, s.is_partial, s.start_line, s.end_line, s.chars, f.path, f.language
         FROM symbols s JOIN files f ON f.id = s.file_id
         WHERE s.merged_into IS NULL AND s.kind = ? ORDER BY s.id`, kind), (s) => ({
        id: s.id, kind: s.kind, nativeKind: s.native_kind, name: s.name, qualifiedName: s.qualified_name,
        namespace: s.namespace, signature: s.signature, doc: s.doc, valueType: s.value_type,
        exported: s.exported === 1, partial: s.is_partial === 1 || undefined,
        path: path(s.path), language: s.language, startLine: s.start_line, endLine: s.end_line, chars: s.chars,
        pagerank: ranks.get(Number(s.id)),
      })),
    });
  }

  if (opts.external) {
    groups.push({
      name: 'External',
      cypher: node('External'),
      rows: () => query(db, `SELECT DISTINCT ${EXTERNAL_NAME} AS name FROM edges e WHERE e.to_symbol_id IS NULL ORDER BY 1`),
    });
  }

  // A part of a partial type counts as its canonical symbol, on either end of a relationship.
  groups.push(
    relationship('DECLARES', 'File', 'Symbol', [], () => query(db,
      `SELECT DISTINCT s.file_id AS "from", coalesce(s.merged_into, s.id) AS "to" FROM symbols s
       WHERE s.parent_id IS NULL ORDER BY 1, 2`)),
    relationship('CONTAINS', 'Symbol', 'Symbol', [], () => query(db,
      `SELECT DISTINCT coalesce(p.merged_into, p.id) AS "from", coalesce(s.merged_into, s.id) AS "to"
       FROM symbols s JOIN symbols p ON p.id = s.parent_id
       WHERE coalesce(p.merged_into, p.id) != coalesce(s.merged_into, s.id) ORDER BY 1, 2`)),
    relationship('IMPORTS', 'File', 'File', ['lines'], () => withLines(query(db,
      `SELECT i.file_id AS "from", i.resolved_file_id AS "to", json_group_array(i.line) AS lines FROM imports i
       WHERE i.resolved_file_id IS NOT NULL AND i.resolved_file_id != i.file_id GROUP BY 1, 2 ORDER BY 1, 2`))),
  );

  for (const [type, label] of Object.entries(EDGE_LABELS)) {
    const uses = (from: string, to: string, where: string) => () => withLines(query(db,
      `SELECT ${from} AS "from", ${to} AS "to", count(*) AS count, json_group_array(e.line) AS lines
       FROM edges e LEFT JOIN symbols a ON a.id = e.from_symbol_id LEFT JOIN symbols b ON b.id = e.to_symbol_id
       WHERE e.type = ? AND ${where} GROUP BY 1, 2 ORDER BY 1, 2`, type));
    const symbol = 'coalesce(a.merged_into, a.id)';
    const target = 'coalesce(b.merged_into, b.id)';
    groups.push(
      relationship(label, 'Symbol', 'Symbol', ['count', 'lines'], uses(symbol, target, 'e.from_symbol_id IS NOT NULL AND e.to_symbol_id IS NOT NULL')),
      relationship(label, 'File', 'Symbol', ['count', 'lines'], uses('e.file_id', target, 'e.from_symbol_id IS NULL AND e.to_symbol_id IS NOT NULL')),
    );
    if (opts.external) {
      groups.push(
        relationship(label, 'Symbol', 'External', ['count', 'lines'], uses(symbol, EXTERNAL_NAME, 'e.from_symbol_id IS NOT NULL AND e.to_symbol_id IS NULL')),
        relationship(label, 'File', 'External', ['count', 'lines'], uses('e.file_id', EXTERNAL_NAME, 'e.from_symbol_id IS NULL AND e.to_symbol_id IS NULL')),
      );
    }
  }
  return groups;
}

/** Real names from the repository for the starter queries (neo4j-queries.ts). */
export function starterExamples(index: IndexDb, root?: string): StarterExamples {
  const one = (sql: string) => (index.db.prepare(sql).get() as { v: string } | undefined)?.v;
  const mostUsed = (where: string) => one(
    `SELECT s.name AS v FROM edges e JOIN symbols s ON s.id = e.to_symbol_id WHERE ${where} GROUP BY s.id ORDER BY count(*) DESC, s.id LIMIT 1`);
  return {
    // Uses of a class's members count as uses of the class: code mostly uses classes that way.
    type: one(`SELECT c.name AS v FROM edges e JOIN symbols t ON t.id = e.to_symbol_id
      JOIN symbols c ON c.id = CASE WHEN t.kind IN ('class', 'interface') THEN t.id ELSE t.parent_id END
      WHERE c.kind IN ('class', 'interface') GROUP BY c.id ORDER BY count(*) DESC, c.id LIMIT 1`),
    method: mostUsed(`e.type = 'calls' AND s.kind IN ('method', 'function')`),
    caller: one(`SELECT s.name AS v FROM edges e JOIN symbols s ON s.id = e.from_symbol_id
      WHERE e.type = 'calls' AND e.to_symbol_id IS NOT NULL AND s.kind IN ('method', 'function')
      GROUP BY s.id ORDER BY count(DISTINCT e.to_symbol_id) DESC, s.id LIMIT 1`),
    file: relativeTo(root)(one('SELECT path AS v FROM files ORDER BY chars DESC, id LIMIT 1')),
  };
}

/**
 * Runs `fn` in one read transaction, so every query in it sees the same index even while the
 * daemon writes to it (SQLite WAL). For `neo4jGroups` and reading its rows.
 */
export async function inSnapshot<T>(index: IndexDb, fn: () => T | Promise<T>): Promise<T> {
  index.db.exec('BEGIN');
  try {
    return await fn();
  } finally {
    index.db.exec('COMMIT');
  }
}

/** Splits rows into arrays of at most `size`. */
export function* inBatches<T>(rows: Iterable<T>, size: number): Generator<T[]> {
  let batch: T[] = [];
  for (const row of rows) {
    batch.push(row);
    if (batch.length >= size) {
      yield batch;
      batch = [];
    }
  }
  if (batch.length) yield batch;
}

/** Adds a group's row count to the summary: per label for nodes, per type for relationships. */
export function addToSummary(summary: Neo4jExportSummary, group: CypherGroup, count: number): void {
  if (group.from) summary.relationships[group.name] = (summary.relationships[group.name] ?? 0) + count;
  else {
    const label = group.name.split(':')[0];
    summary.nodes[label] = (summary.nodes[label] ?? 0) + count;
  }
}

/** What the repository's node records about a load (see NEO4J_STATS). */
export function loadStats(summary: Neo4jExportSummary): Record<string, number> {
  const total = (counts: Record<string, number>) => Object.values(counts).reduce((a, b) => a + b, 0);
  return { files: summary.nodes.File ?? 0, symbols: summary.nodes.Symbol ?? 0, relationships: total(summary.relationships) };
}

/**
 * Writes the repository's graph as a Cypher script for Neo4j 5 or later, to run with
 * `cypher-shell -f`. The script first removes what an earlier load of the same repository left.
 */
export async function exportNeo4j(index: IndexDb, outPath: string, opts: Neo4jExportOptions): Promise<Neo4jExportSummary> {
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const summary: Neo4jExportSummary = { nodes: {}, relationships: {} };
  const target = { app: opts.app, repo: opts.repo };
  const statement = (cypher: string, params: Record<string, unknown> = {}) => `${inline(cypher, { ...target, ...params })};\n`;
  const fd = openSync(outPath, 'w');
  let chunk = '';
  const write = (text: string) => {
    chunk += text;
    if (chunk.length > 1 << 16) {
      writeSync(fd, chunk);
      chunk = '';
    }
  };
  try {
    write(`// RefDex code graph for Neo4j 5 or later: repository ${JSON.stringify(opts.repo)} of app ${JSON.stringify(opts.app)}.
// Load it with:  cypher-shell -u neo4j -p <password> -f <this file>
// It replaces what an earlier load of this repository left and leaves other data alone.

${NEO4J_SCHEMA.map((s) => statement(s)).join('')}
${statement(NEO4J_SECTION)}
${statement('MATCH (n:RefDex {app: $app, repo: $repo}) DETACH DELETE n')}
`);
    const examples = await inSnapshot(index, () => {
      for (const group of neo4jGroups(index, opts)) {
        let count = 0;
        const cypher = inline(group.cypher, target);
        for (const batch of inBatches(group.rows(), batchSize)) {
          if (!count) write(`// ${group.from ? `(:${group.from})-[:${group.name}]->(:${group.to})` : `(:${group.name})`}\n`);
          write(`UNWIND [\n${batch.map((row) => `  ${cypherLiteral(row)}`).join(',\n')}\n] AS r\n${cypher};\n\n`);
          count += batch.length;
        }
        addToSummary(summary, group, count);
      }
      return { ...starterExamples(index, opts.root), repo: opts.repo };
    });
    write(statement(NEO4J_STATS, { stats: loadStats(summary) }));
    write(`\n// Starter queries: MATCH (q:StarterQuery) RETURN q.title, q.description, q.cypher ORDER BY q.order\n`);
    write(statement(NEO4J_STARTER_QUERIES, { queries: neo4jStarterQueries(opts.app, examples) }));
    writeSync(fd, chunk);
  } finally {
    closeSync(fd);
  }
  return summary;
}

/** Replaces `$name` parameters in one of the statements above with literals, for the script. */
function inline(cypher: string, params: Record<string, unknown>): string {
  return cypher.replace(/\$(\w+)/g, (match, name: string) => (name in params ? cypherLiteral(params[name]) : match));
}

function relationship(type: string, from: 'File' | 'Symbol', to: 'File' | 'Symbol' | 'External', props: string[], rows: () => Iterable<Record<string, unknown>>): CypherGroup {
  const key = to === 'External' ? 'name' : 'id';
  const set = props.length ? ` {${props.map((p) => `${p}: r.${p}`).join(', ')}}` : '';
  return {
    name: type, from, to, rows,
    cypher: `MATCH (a:${from} {app: $app, repo: $repo, id: r.from})\nMATCH (b:${to} {app: $app, repo: $repo, ${key}: r.to})\nCREATE (a)-[:${type}${set}]->(b)`,
  };
}

function query(db: DatabaseSync, sql: string, ...params: SQLInputValue[]): Iterable<Record<string, unknown>> {
  return db.prepare(sql).iterate(...params) as Iterable<Record<string, unknown>>;
}

function* map<T, U>(rows: Iterable<T>, fn: (row: T) => U): Iterable<U> {
  for (const row of rows) yield fn(row);
}

/** Turns json_group_array's `lines` into sorted, distinct line numbers (a line can hold several uses). */
function withLines(rows: Iterable<Record<string, unknown>>): Iterable<Record<string, unknown>> {
  return map(rows, (row) => ({ ...row, lines: [...new Set(JSON.parse(String(row.lines)) as number[])].sort((a, b) => a - b) }));
}

/** Makes paths under `root` relative to it, with `/` separators; others stay as they are. */
function relativeTo(root: string | undefined): (path: unknown) => string | undefined {
  return (path) => {
    if (typeof path !== 'string') return undefined;
    if (!root || (path !== root && !path.startsWith(root.endsWith(sep) ? root : root + sep))) return path;
    return relative(root, path).split(sep).join('/') || '.';
  };
}
