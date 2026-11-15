import { auth, driver as neo4jDriver, int, isInt, Neo4jError, session as accessMode, type Driver } from 'neo4j-driver-lite';
import {
  addToSummary, inBatches, inSnapshot, loadStats, NEO4J_CLEAR, NEO4J_SCHEMA, NEO4J_SECTION, NEO4J_STARTER_QUERIES, NEO4J_STARTER_SOURCE, NEO4J_STATS, neo4jGroups,
  neo4jStarterQueries, starterExamples, type IndexDb, type Neo4jExportOptions, type Neo4jExportSummary,
} from '@refdex/core';

/**
 * `refdex neo4j check|load`: loads a repository's graph (core/src/neo4j.ts) into Neo4j through the
 * official driver, as one section of an app. Statements take their rows as parameters, so Neo4j
 * plans each statement once. A script of literal rows (`refdex export-neo4j`) makes it parse and
 * cache every batch, which ran a 1 GB heap out of memory at 80,000 symbols.
 */

export interface Neo4jConnection {
  /** neo4j://, neo4j+s://, bolt:// or bolt+s:// */
  uri: string;
  user: string;
  password: string;
  /** Empty or undefined: the server's default database. */
  database?: string;
  userAgent?: string;
}

/** Runs one statement in its own transaction and returns its records as plain objects. */
export type CypherRunner = (cypher: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>[]>;

export interface LoadProgress {
  /** What is being written: `removing the previous graph`, `Symbol:Method`, `CALLS`, ... */
  stage: string;
  /** Rows written so far in this stage's phase (removed nodes, or created nodes and relationships). */
  rows: number;
}

export interface LoadSummary extends Neo4jExportSummary {
  app: string;
  repo: string;
  /** Nodes removed from the repository's previous load. */
  deleted: number;
  ms: number;
}

export interface Neo4jServerInfo {
  address: string;
  version: string;
  edition: string;
  database: string;
  /** Apps already loaded, with their repositories. */
  apps: { name: string; repositories: string[] }[];
}

/**
 * The local server of the README's Docker Compose file (neo4j/compose.yaml). Without a password,
 * RefDex uses this one for a server on this machine, so that setup works with no configuration.
 * Neo4j refuses "neo4j" itself as a password, and any password shorter than 8 characters.
 */
export const LOCAL_NEO4J = { uri: 'neo4j://localhost:7687', user: 'neo4j', password: 'refdex-local' };

/** Whether a Neo4j URI points at this machine. */
export function isLocalNeo4j(uri: string): boolean {
  try {
    const host = new URL(uri.replace(/^[a-z0-9+]+:/i, 'http:')).hostname;
    return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(host);
  } catch {
    return false;
  }
}

const BATCH_SIZE = 2000;
const CLEAR_BATCH = 10_000;

/** Number properties that stay floats; every other whole number is sent as a Neo4j integer. */
const FLOAT_PROPERTIES = new Set(['pagerank']);

/**
 * Loads the repository: schema, its app and repository nodes, removal of what its previous load
 * left (in batches, so a large graph never needs one huge transaction), then its nodes and
 * relationships in batches, the counts on its repository node, and the app's starter queries.
 */
export async function loadGraph(index: IndexDb, run: CypherRunner, opts: Neo4jExportOptions, onProgress?: (p: LoadProgress) => void): Promise<LoadSummary> {
  const started = performance.now();
  const section = { app: opts.app, repo: opts.repo };
  for (const statement of NEO4J_SCHEMA) await run(statement);
  await run(NEO4J_SECTION, section);

  let deleted = 0;
  for (;;) {
    const [row] = await run(NEO4J_CLEAR, { ...section, limit: CLEAR_BATCH });
    const n = Number(row?.deleted ?? 0);
    deleted += n;
    if (n) onProgress?.({ stage: 'removing the previous graph', rows: deleted });
    if (n < CLEAR_BATCH) break;
  }

  const summary: LoadSummary = { ...section, nodes: {}, relationships: {}, deleted, ms: 0 };
  const examples = await inSnapshot(index, async () => {
    let rows = 0;
    for (const group of neo4jGroups(index, opts)) {
      let count = 0;
      for (const batch of inBatches(group.rows(), opts.batchSize ?? BATCH_SIZE)) {
        await run(`UNWIND $rows AS r\n${group.cypher}`, { ...section, rows: batch });
        count += batch.length;
        rows += batch.length;
        onProgress?.({ stage: group.name, rows });
      }
      addToSummary(summary, group, count);
    }
    return { ...starterExamples(index, opts.root), repo: opts.repo };
  });
  await run(NEO4J_STATS, { ...section, stats: loadStats(summary) });
  const [source] = await run(NEO4J_STARTER_SOURCE, section);
  if (source?.largest === opts.repo || !Number(source?.queries ?? 0)) {
    await run(NEO4J_STARTER_QUERIES, { ...section, queries: neo4jStarterQueries(opts.app, examples) });
  }
  summary.ms = Math.round(performance.now() - started);
  return summary;
}

/** Connects, then loads the repository with `loadGraph`. */
export function loadNeo4j(index: IndexDb, conn: Neo4jConnection, opts: Neo4jExportOptions, onProgress?: (p: LoadProgress) => void): Promise<LoadSummary> {
  return withNeo4j(conn, ({ write }) => loadGraph(index, write, opts, onProgress));
}

/** Checks the connection and credentials, and lists the apps already loaded. */
export function checkNeo4j(conn: Neo4jConnection): Promise<Neo4jServerInfo> {
  return withNeo4j(conn, async ({ read, driver }) => {
    const server = await driver.getServerInfo({ database: conn.database || undefined });
    const [component] = await read('CALL dbms.components() YIELD versions, edition RETURN versions[0] AS version, edition');
    const [db] = await read('CALL db.info() YIELD name RETURN name');
    const apps = await read('MATCH (a:App:RefDex)-[:HAS_REPOSITORY]->(p:Repository) WITH a, p ORDER BY p.name RETURN a.name AS name, collect(p.name) AS repositories ORDER BY name');
    return {
      address: server.address ?? conn.uri,
      version: String(component?.version ?? server.agent ?? ''),
      edition: String(component?.edition ?? ''),
      database: String(db?.name ?? conn.database ?? ''),
      apps: apps as Neo4jServerInfo['apps'],
    };
  });
}

/**
 * Why a check or load failed, for people and for the IDE plugins: `auth` (wrong or missing login:
 * ask for it), `unreachable` (no server at the address: start one or fix the address), `other`.
 */
export interface Neo4jFailure {
  kind: 'auth' | 'unreachable' | 'other';
  message: string;
}

export function describeNeo4jError(e: unknown, uri: string): Neo4jFailure {
  if (e instanceof Neo4jError) {
    switch (e.code) {
      case 'Neo.ClientError.Security.Unauthorized':
        return { kind: 'auth', message: `Neo4j at ${uri} rejected the username or password` };
      case 'Neo.ClientError.Security.CredentialsExpired':
        return { kind: 'auth', message: `Neo4j at ${uri} wants its password changed before first use: set a new one in Neo4j Browser, then use it here` };
      case 'Neo.ClientError.Security.AuthenticationRateLimit':
        return { kind: 'auth', message: `Neo4j at ${uri} is refusing logins after too many failed attempts; wait a moment and try again` };
      case 'ServiceUnavailable':
      case 'SessionExpired':
        return { kind: 'unreachable', message: `could not reach Neo4j at ${uri}: ${e.message}` };
    }
    return { kind: 'other', message: `Neo4j: ${e.message}` };
  }
  return { kind: 'other', message: e instanceof Error ? e.message : String(e) };
}

async function withNeo4j<T>(conn: Neo4jConnection, fn: (n: { read: CypherRunner; write: CypherRunner; driver: Driver }) => Promise<T>): Promise<T> {
  const driver = neo4jDriver(conn.uri, auth.basic(conn.user, conn.password), {
    userAgent: conn.userAgent,
    connectionTimeout: 15_000,
    maxTransactionRetryTime: 15_000,
  });
  const database = conn.database || undefined;
  const session = driver.session({ database, defaultAccessMode: accessMode.WRITE });
  const records = (result: { records: { toObject(): Record<string, unknown> }[] }) =>
    result.records.map((r) => Object.fromEntries(Object.entries(r.toObject()).map(([k, v]) => [k, fromNeo4j(v)])));
  try {
    await driver.verifyConnectivity({ database });
    return await fn({
      driver,
      read: async (cypher, params = {}) => records(await session.executeRead((tx) => tx.run(cypher, toNeo4j(params) as Record<string, unknown>))),
      write: async (cypher, params = {}) => records(await session.executeWrite((tx) => tx.run(cypher, toNeo4j(params) as Record<string, unknown>))),
    });
  } finally {
    await session.close();
    await driver.close();
  }
}

/** JavaScript numbers would arrive as floats; send whole numbers as integers, as the script does. */
function toNeo4j(value: unknown, key = ''): unknown {
  if (typeof value === 'number') return Number.isInteger(value) && !FLOAT_PROPERTIES.has(key) ? int(value) : value;
  if (Array.isArray(value)) return value.map((v) => toNeo4j(v, key));
  if (value && typeof value === 'object' && !isInt(value)) {
    return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).map(([k, v]) => [k, toNeo4j(v, k)]));
  }
  return value;
}

function fromNeo4j(value: unknown): unknown {
  if (isInt(value)) return (value as { toNumber(): number }).toNumber();
  if (Array.isArray(value)) return value.map(fromNeo4j);
  return value;
}
