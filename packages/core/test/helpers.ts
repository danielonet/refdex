import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { IndexDb, Indexer, TreeSitter, type IndexSummary, type SymbolRow } from '../src/index.ts';

export const FIXTURES = join(import.meta.dirname, 'fixtures');

let treeSitter: Promise<TreeSitter> | undefined;

export interface Indexed {
  root: string;
  db: IndexDb;
  indexer: Indexer;
  summary: IndexSummary;
  /** Absolute path of a fixture-relative path. */
  p(rel: string): string;
  symbol(qualifiedName: string): SymbolRow;
  /** Resolved path (relative to the root) of the import of `spec` in `file`, or the namespace, or null. */
  resolution(file: string, spec: string, name?: string): string | null;
}

/**
 * Indexes a fixture (a name under fixtures/, or an absolute folder) into an in-memory database.
 * With `copy`, works on a temp copy that tests may modify.
 */
export async function indexFixture(name: string, { copy = false } = {}): Promise<Indexed> {
  let root = isAbsolute(name) ? name : join(FIXTURES, name);
  if (copy) {
    const tmp = await mkdtemp(join(tmpdir(), `refdex-${name}-`));
    await cp(root, tmp, { recursive: true });
    root = tmp;
  }
  const db = new IndexDb(':memory:');
  const indexer = new Indexer(db, await (treeSitter ??= TreeSitter.create()), root);
  const summary = await indexer.syncAll();
  const p = (rel: string) => join(root, rel);
  return {
    root, db, indexer, summary, p,
    symbol(qualifiedName) {
      const rows = db.symbolsByQualifiedName(qualifiedName);
      if (!rows.length) throw new Error(`no symbol ${qualifiedName}; have: ${allNames(db).join(', ')}`);
      return rows[0];
    },
    resolution(file, spec, name) {
      const row = db.fileImports(p(file)).find((i) => i.spec === spec && (!name || i.names.some((n) => n.name === name)));
      if (!row) throw new Error(`no import ${spec} in ${file}`);
      if (row.resolved_path) return row.resolved_path.slice(root.length + 1);
      return row.resolved_namespace ? `namespace:${row.resolved_namespace}` : null;
    },
  };
}

/** Writes `files` (relative path -> content) to a temp folder and indexes it like `indexFixture`. */
export async function indexSources(files: Record<string, string>): Promise<Indexed & { edges(): string[]; cleanup(): Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'refdex-src-'));
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, rel)), { recursive: true });
    await writeFile(join(root, rel), content);
  }
  const ix = await indexFixture(root);
  return {
    ...ix,
    /** Linked edges as "from -type-> to". */
    edges() {
      const rows = ix.db.db.prepare(
        `SELECT coalesce(a.qualified_name, '<module>') AS "from", e.type, b.qualified_name AS "to" FROM edges e
         LEFT JOIN symbols a ON a.id = e.from_symbol_id JOIN symbols b ON b.id = e.to_symbol_id ORDER BY e.id`,
      ).all() as { from: string; type: string; to: string }[];
      return rows.map((r) => `${r.from} -${r.type}-> ${r.to}`);
    },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

function allNames(db: IndexDb): string[] {
  return (db.db.prepare('SELECT qualified_name FROM symbols').all() as { qualified_name: string }[]).map((r) => r.qualified_name);
}
