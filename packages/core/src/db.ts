import { closeSync, openSync, writeSync } from 'node:fs';
import type { DatabaseSync as Database, StatementSync } from 'node:sqlite';
import type { LanguageId } from './languages.ts';
import type { ExtractedSymbol, ImportDecl, ImportedName, ParsedFile, SymbolKind } from './model.ts';

// Loaded at evaluation time (not ESM link time) so a caller can silence node:sqlite's
// ExperimentalWarning before this module loads it.
const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');

/** Bump when the schema changes. The index is a cache, so an old one is simply rebuilt. */
const SCHEMA_VERSION = 3;

const SCHEMA = `
CREATE TABLE files (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  language TEXT NOT NULL,
  hash TEXT NOT NULL,
  project TEXT NOT NULL,
  indexed_at TEXT NOT NULL
);
CREATE TABLE symbols (
  id INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  native_kind TEXT NOT NULL,
  name TEXT NOT NULL,
  qualified_name TEXT NOT NULL,
  namespace TEXT,
  signature TEXT NOT NULL,
  doc TEXT,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  parent_id INTEGER REFERENCES symbols(id) ON DELETE CASCADE,
  exported INTEGER NOT NULL DEFAULT 0,
  is_partial INTEGER NOT NULL DEFAULT 0,
  -- Non-canonical part of a partial type: points at the canonical symbol (see symbol_parts).
  merged_into INTEGER REFERENCES symbols(id) ON DELETE SET NULL
);
CREATE INDEX symbols_file ON symbols(file_id);
CREATE INDEX symbols_qname ON symbols(qualified_name);
CREATE INDEX symbols_namespace ON symbols(namespace);
CREATE INDEX symbols_parent ON symbols(parent_id);
-- Every foreign key needs an index, or deleting a file scans whole tables per deleted symbol.
CREATE INDEX symbols_merged ON symbols(merged_into) WHERE merged_into IS NOT NULL;
CREATE INDEX symbols_partial ON symbols(qualified_name) WHERE is_partial = 1;

-- Every file a partial type spans, keyed by its canonical symbol.
CREATE TABLE symbol_parts (
  symbol_id INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL
);
CREATE INDEX symbol_parts_symbol ON symbol_parts(symbol_id);
CREATE INDEX symbol_parts_file ON symbol_parts(file_id);

CREATE TABLE imports (
  id INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  spec TEXT NOT NULL,
  names TEXT NOT NULL,            -- JSON array of {name, alias?}
  alias TEXT,
  is_global INTEGER NOT NULL DEFAULT 0,
  line INTEGER NOT NULL,
  resolved_file_id INTEGER REFERENCES files(id) ON DELETE SET NULL,
  resolved_namespace TEXT,
  resolved_symbol_id INTEGER REFERENCES symbols(id) ON DELETE SET NULL
);
CREATE INDEX imports_file ON imports(file_id);
CREATE INDEX imports_resolved_file ON imports(resolved_file_id);
CREATE INDEX imports_resolved_symbol ON imports(resolved_symbol_id);
CREATE INDEX imports_unresolved ON imports(file_id) WHERE resolved_file_id IS NULL AND resolved_namespace IS NULL;

-- calls / extends / implements / references (filled in Phase 4).
CREATE TABLE edges (
  from_symbol_id INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
  to_symbol_id INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
  type TEXT NOT NULL
);
CREATE INDEX edges_from ON edges(from_symbol_id);
CREATE INDEX edges_to ON edges(to_symbol_id);

CREATE VIRTUAL TABLE symbols_fts USING fts5(name, qualified_name, doc, content='symbols', content_rowid='id');
CREATE TRIGGER symbols_ai AFTER INSERT ON symbols BEGIN
  INSERT INTO symbols_fts(rowid, name, qualified_name, doc) VALUES (new.id, new.name, new.qualified_name, new.doc);
END;
CREATE TRIGGER symbols_ad AFTER DELETE ON symbols BEGIN
  INSERT INTO symbols_fts(symbols_fts, rowid, name, qualified_name, doc) VALUES ('delete', old.id, old.name, old.qualified_name, old.doc);
END;
`;

export interface SymbolRow {
  id: number;
  kind: SymbolKind;
  native_kind: string;
  name: string;
  qualified_name: string;
  namespace: string | null;
  signature: string;
  doc: string | null;
  path: string;
  language: LanguageId;
  start_line: number;
  end_line: number;
  parent_id: number | null;
  exported: number;
}

export interface ImportRow {
  id: number;
  file_id: number;
  path: string;
  language: LanguageId;
  kind: ImportDecl['kind'];
  spec: string;
  names: ImportedName[];
  alias: string | null;
  is_global: number;
  line: number;
  resolved_file_id: number | null;
  resolved_path: string | null;
  resolved_namespace: string | null;
  resolved_symbol_id: number | null;
}

export interface IndexStats {
  files: number;
  symbols: number;
  imports: number;
  resolvedImports: number;
  byLanguage: { language: string; files: number; symbols: number }[];
  indexedAt: string | null;
}

const SYMBOL_COLUMNS = `s.id, s.kind, s.native_kind, s.name, s.qualified_name, s.namespace, s.signature, s.doc,
  f.path, f.language, s.start_line, s.end_line, s.parent_id, s.exported`;

const IMPORT_COLUMNS = `i.id, i.file_id, f.path, f.language, i.kind, i.spec, i.names, i.alias, i.is_global, i.line,
  i.resolved_file_id, rf.path AS resolved_path, i.resolved_namespace, i.resolved_symbol_id`;

export class IndexDb {
  readonly db: Database;
  private readonly statements = new Map<string, StatementSync>();

  /**
   * `readOnly`: for query-only processes such as the MCP server. The database must already exist
   * with the current schema; the daemon (the only writer) creates and updates it.
   */
  constructor(path: string, opts: { readOnly?: boolean } = {}) {
    this.db = new DatabaseSync(path, { readOnly: !!opts.readOnly });
    this.db.exec('PRAGMA busy_timeout = 5000;');
    const { user_version: version } = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
    if (opts.readOnly) {
      if (version !== SCHEMA_VERSION) {
        this.db.close();
        throw new IndexNotReadyError(version === 0 ? 'the index has not been built yet' : 'the index was built by a different RefDex version');
      }
      return;
    }
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL;');
    if (version !== SCHEMA_VERSION) this.reset();
  }

  /** Drops every row by recreating the schema (much faster than deleting through the FTS triggers). */
  clear(): void {
    this.reset(true);
    this.statements.clear();
  }

  private reset(force = false): void {
    // foreign_keys is a no-op inside a transaction, so switch it off first.
    this.db.exec('PRAGMA foreign_keys = OFF');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      // Re-check under the write lock: another connection may have just created the schema.
      const { user_version: version } = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
      if (force || version !== SCHEMA_VERSION) {
        const objects = this.db.prepare("SELECT type, name FROM sqlite_master WHERE type IN ('table', 'trigger') AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'symbols_fts_%'").all() as { type: string; name: string }[];
        for (const o of objects) this.db.exec(`DROP ${o.type.toUpperCase()} IF EXISTS "${o.name}"`);
        this.db.exec(SCHEMA);
        this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    } finally {
      this.db.exec('PRAGMA foreign_keys = ON');
    }
  }

  private stmt(sql: string): StatementSync {
    let s = this.statements.get(sql);
    if (!s) this.statements.set(sql, (s = this.db.prepare(sql)));
    return s;
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  // ---- writes (the indexer) ----

  /** Replaces a file's symbols and imports. Call inside `transaction`. Returns the file id. */
  replaceFile(path: string, hash: string, project: string, parsed: ParsedFile): number {
    this.stmt('DELETE FROM files WHERE path = ?').run(path);
    const { lastInsertRowid } = this.stmt('INSERT INTO files (path, language, hash, project, indexed_at) VALUES (?, ?, ?, ?, ?)')
      .run(path, parsed.language, hash, project, new Date().toISOString());
    const fileId = Number(lastInsertRowid);
    const insertSymbol = this.stmt(
      `INSERT INTO symbols (file_id, kind, native_kind, name, qualified_name, namespace, signature, doc, start_line, end_line, parent_id, exported, is_partial)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    // Symbols arrive parent-first, so a parent's row id is known before its children.
    const ids = new Map<ExtractedSymbol, number>();
    for (const s of parsed.symbols) {
      const parentId = s.parent ? (ids.get(s.parent) ?? null) : null;
      const { lastInsertRowid: id } = insertSymbol.run(
        fileId, s.kind, s.nativeKind, s.name, s.qualifiedName, s.namespace, s.signature, s.doc,
        s.startLine, s.endLine, parentId, s.exported ? 1 : 0, s.partial ? 1 : 0,
      );
      ids.set(s, Number(id));
    }
    const insertImport = this.stmt('INSERT INTO imports (file_id, kind, spec, names, alias, is_global, line) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const i of parsed.imports) {
      insertImport.run(fileId, i.kind, i.spec, JSON.stringify(i.names), i.alias ?? null, i.global ? 1 : 0, i.line);
    }
    return fileId;
  }

  removeFile(path: string): boolean {
    return this.stmt('DELETE FROM files WHERE path = ?').run(path).changes > 0;
  }

  /** Imports that need (re)resolving: those of the given files plus every unresolved one. */
  importsToResolve(fileIds: number[]): ImportRow[] {
    const rows = this.stmt(
      `SELECT ${IMPORT_COLUMNS} FROM imports i JOIN files f ON f.id = i.file_id LEFT JOIN files rf ON rf.id = i.resolved_file_id
       WHERE i.file_id IN (SELECT value FROM json_each(?))
          OR (i.resolved_file_id IS NULL AND i.resolved_namespace IS NULL)`,
    ).all(JSON.stringify(fileIds)) as unknown as (ImportRow & { names: string })[];
    return rows.map((r) => ({ ...r, names: JSON.parse(r.names) }));
  }

  setImportResolution(importId: number, fileId: number | null, namespace: string | null, symbolId: number | null): void {
    this.stmt('UPDATE imports SET resolved_file_id = ?, resolved_namespace = ?, resolved_symbol_id = ? WHERE id = ?')
      .run(fileId, namespace, symbolId, importId);
  }

  /**
   * Links the parts of each C# partial type: the part with the lowest id is canonical, every part
   * gets a symbol_parts row, and the other parts point at it through merged_into.
   */
  mergePartials(): void {
    this.db.exec(`
      UPDATE symbols SET merged_into = NULL WHERE merged_into IS NOT NULL;
      DELETE FROM symbol_parts;
      CREATE TEMP TABLE IF NOT EXISTS partial_canon (qualified_name TEXT PRIMARY KEY, id INTEGER);
      DELETE FROM partial_canon;
      INSERT INTO partial_canon
        SELECT qualified_name, min(id) FROM symbols WHERE is_partial = 1 GROUP BY qualified_name HAVING count(*) > 1;
      INSERT INTO symbol_parts (symbol_id, file_id, start_line, end_line)
        SELECT c.id, s.file_id, s.start_line, s.end_line
        FROM symbols s JOIN partial_canon c ON c.qualified_name = s.qualified_name WHERE s.is_partial = 1;
      UPDATE symbols SET merged_into = (SELECT c.id FROM partial_canon c WHERE c.qualified_name = symbols.qualified_name)
        WHERE is_partial = 1 AND id NOT IN (SELECT id FROM partial_canon)
          AND qualified_name IN (SELECT qualified_name FROM partial_canon);
    `);
  }

  // ---- reads ----

  fileHashes(): Map<string, string> {
    const rows = this.stmt('SELECT path, hash FROM files').all() as { path: string; hash: string }[];
    return new Map(rows.map((r) => [r.path, r.hash]));
  }

  fileIds(): Map<string, number> {
    const rows = this.stmt('SELECT path, id FROM files').all() as { path: string; id: number }[];
    return new Map(rows.map((r) => [r.path, r.id]));
  }

  /** Types (for namespace-based import resolution): qualified name -> file path and symbol id. */
  types(languages: LanguageId[]): Map<string, { path: string; id: number }> {
    const rows = this.stmt(
      `SELECT s.qualified_name, f.path, s.id FROM symbols s JOIN files f ON f.id = s.file_id
       WHERE s.kind IN ('class', 'interface', 'enum', 'type_alias') AND s.merged_into IS NULL
         AND f.language IN (SELECT value FROM json_each(?))`,
    ).all(JSON.stringify(languages)) as { qualified_name: string; path: string; id: number }[];
    return new Map(rows.map((r) => [r.qualified_name, { path: r.path, id: r.id }]));
  }

  namespaces(languages: LanguageId[]): Set<string> {
    const rows = this.stmt(
      `SELECT DISTINCT s.namespace FROM symbols s JOIN files f ON f.id = s.file_id
       WHERE s.namespace IS NOT NULL AND f.language IN (SELECT value FROM json_each(?))`,
    ).all(JSON.stringify(languages)) as { namespace: string }[];
    const out = new Set<string>();
    // `A.B.C` also makes `A.B` and `A` namespaces (C# nested namespaces, Java parent packages).
    for (const { namespace } of rows) {
      const parts = namespace.split('.');
      for (let i = 1; i <= parts.length; i++) out.add(parts.slice(0, i).join('.'));
    }
    return out;
  }

  search(query: string, limit = 20, opts: { kind?: string; language?: string } = {}): SymbolRow[] {
    // Prefix search on each whitespace-separated term.
    const match = query.split(/\s+/).filter(Boolean).map((t) => `"${t.replace(/"/g, '""')}"*`).join(' ');
    if (!match) return [];
    return this.stmt(
      `SELECT ${SYMBOL_COLUMNS}
       FROM symbols_fts JOIN symbols s ON s.id = symbols_fts.rowid JOIN files f ON f.id = s.file_id
       WHERE symbols_fts MATCH ? AND s.merged_into IS NULL
         AND (?2 IS NULL OR s.kind = ?2) AND (?3 IS NULL OR f.language = ?3)
       -- Exact name matches first, then name prefixes, then the full-text rank.
       ORDER BY s.name = ?5 COLLATE NOCASE DESC, substr(s.name, 1, length(?5)) = ?5 COLLATE NOCASE DESC,
         bm25(symbols_fts, 10.0, 2.0, 0.5), length(s.qualified_name)
       LIMIT ?4`,
    ).all(`{name qualified_name}: (${match})`, opts.kind ?? null, opts.language ?? null, limit, query.trim()) as unknown as SymbolRow[];
  }

  symbolsByQualifiedName(qualifiedName: string): SymbolRow[] {
    return this.stmt(
      `SELECT ${SYMBOL_COLUMNS} FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.qualified_name = ? ORDER BY s.id`,
    ).all(qualifiedName) as unknown as SymbolRow[];
  }

  fileSymbols(path: string): SymbolRow[] {
    return this.stmt(
      `SELECT ${SYMBOL_COLUMNS} FROM symbols s JOIN files f ON f.id = s.file_id WHERE f.path = ? ORDER BY s.start_line, s.id`,
    ).all(path) as unknown as SymbolRow[];
  }

  /** Members of a type, including those declared in the other parts of a partial type. */
  members(symbolId: number): SymbolRow[] {
    return this.stmt(
      `SELECT ${SYMBOL_COLUMNS} FROM symbols s JOIN files f ON f.id = s.file_id
       WHERE s.parent_id = ?1 OR s.parent_id IN (SELECT id FROM symbols WHERE merged_into = ?1)
       ORDER BY f.path, s.start_line`,
    ).all(symbolId) as unknown as SymbolRow[];
  }

  /** Every file a (partial) type is declared in. */
  symbolParts(symbolId: number): { path: string; start_line: number; end_line: number }[] {
    return this.stmt(
      `SELECT f.path, p.start_line, p.end_line FROM symbol_parts p JOIN files f ON f.id = p.file_id
       WHERE p.symbol_id = ? ORDER BY f.path`,
    ).all(symbolId) as { path: string; start_line: number; end_line: number }[];
  }

  fileImports(path: string): ImportRow[] {
    const rows = this.stmt(
      `SELECT ${IMPORT_COLUMNS} FROM imports i JOIN files f ON f.id = i.file_id LEFT JOIN files rf ON rf.id = i.resolved_file_id
       WHERE f.path = ? ORDER BY i.line, i.id`,
    ).all(path) as unknown as (ImportRow & { names: string })[];
    return rows.map((r) => ({ ...r, names: JSON.parse(r.names) }));
  }

  /**
   * Imports in effect for a file: its own plus C# `global using`s from other files of the same
   * project (the folder of the nearest .csproj).
   */
  effectiveImports(path: string): ImportRow[] {
    const rows = this.stmt(
      `SELECT ${IMPORT_COLUMNS} FROM imports i JOIN files f ON f.id = i.file_id LEFT JOIN files rf ON rf.id = i.resolved_file_id
       WHERE f.path = ?1
          OR (i.is_global = 1 AND f.language = (SELECT language FROM files WHERE path = ?1)
              AND f.project = (SELECT project FROM files WHERE path = ?1))
       ORDER BY f.path = ?1 DESC, i.line`,
    ).all(path) as unknown as (ImportRow & { names: string })[];
    return rows.map((r) => ({ ...r, names: JSON.parse(r.names) }));
  }

  /**
   * The symbol that `name` refers to when imported from `path`, following TypeScript barrel
   * re-exports (`export * from`, `export { a as b } from`).
   */
  resolveExport(path: string, name: string, seen = new Set<string>()): SymbolRow | undefined {
    if (seen.has(path)) return undefined;
    seen.add(path);
    const own = this.stmt(
      `SELECT ${SYMBOL_COLUMNS} FROM symbols s JOIN files f ON f.id = s.file_id
       WHERE f.path = ? AND s.name = ? AND s.parent_id IS NULL AND s.exported = 1 LIMIT 1`,
    ).get(path, name) as SymbolRow | undefined;
    if (own) return own;
    for (const re of this.fileImports(path)) {
      if (re.kind !== 're-export' || !re.resolved_path) continue;
      for (const n of re.names) {
        if (n.name === '*' && !n.alias) {
          const found = this.resolveExport(re.resolved_path, name, seen);
          if (found) return found;
        } else if ((n.alias ?? n.name) === name && n.name !== '*') {
          const found = this.resolveExport(re.resolved_path, n.name, seen);
          if (found) return found;
        }
      }
    }
    return undefined;
  }

  counts(): { files: number; symbols: number } {
    return this.stmt('SELECT (SELECT count(*) FROM files) AS files, (SELECT count(*) FROM symbols) AS symbols').get() as { files: number; symbols: number };
  }

  stats(): IndexStats {
    const byLanguage = this.stmt(
      `SELECT f.language, count(DISTINCT f.id) AS files, count(s.id) AS symbols
       FROM files f LEFT JOIN symbols s ON s.file_id = f.id GROUP BY f.language ORDER BY symbols DESC`,
    ).all() as unknown as IndexStats['byLanguage'];
    const row = this.stmt(
      `SELECT max(indexed_at) AS indexedAt, (SELECT count(*) FROM imports) AS imports,
         (SELECT count(*) FROM imports WHERE resolved_file_id IS NOT NULL OR resolved_namespace IS NOT NULL) AS resolvedImports
       FROM files`,
    ).get() as { indexedAt: string | null; imports: number; resolvedImports: number };
    return { ...this.counts(), ...row, byLanguage };
  }

  fileInfo(path: string): { id: number; language: LanguageId; hash: string; indexed_at: string } | undefined {
    return this.stmt('SELECT id, language, hash, indexed_at FROM files WHERE path = ?').get(path) as
      { id: number; language: LanguageId; hash: string; indexed_at: string } | undefined;
  }

  /** Symbols whose name is `name`, or whose qualified name ends with it after a `.` or `:`. */
  symbolsByName(name: string, limit = 50): SymbolRow[] {
    return this.stmt(
      `SELECT ${SYMBOL_COLUMNS} FROM symbols s JOIN files f ON f.id = s.file_id
       WHERE (s.name = ?1 OR s.qualified_name LIKE '%.' || ?2 ESCAPE '\\' OR s.qualified_name LIKE '%:' || ?2 ESCAPE '\\')
         AND s.merged_into IS NULL
       ORDER BY length(s.qualified_name), s.id LIMIT ?3`,
    ).all(name, name.replace(/[\\%_]/g, (c) => `\\${c}`), limit) as unknown as SymbolRow[];
  }

  /** The given files plus every file that re-exports them, directly or through other barrels. */
  exportingFiles(fileIds: number[]): number[] {
    const rows = this.stmt(
      `WITH RECURSIVE exporting(id) AS (
         SELECT value FROM json_each(?)
         UNION
         SELECT i.file_id FROM imports i JOIN exporting e ON i.resolved_file_id = e.id WHERE i.kind = 're-export'
       ) SELECT id FROM exporting`,
    ).all(JSON.stringify(fileIds)) as { id: number }[];
    return rows.map((r) => r.id);
  }

  /** Files with an import that resolves to one of `fileIds`. */
  importingFiles(fileIds: number[]): string[] {
    const rows = this.stmt(
      `SELECT DISTINCT f.path FROM imports i JOIN files f ON f.id = i.file_id
       WHERE i.resolved_file_id IN (SELECT value FROM json_each(?)) ORDER BY f.path`,
    ).all(JSON.stringify(fileIds)) as { path: string }[];
    return rows.map((r) => r.path);
  }

  /**
   * Files that see a Java package's or C# namespace's members without importing their file: files
   * declaring symbols in the same namespace, files importing the namespace (`import a.b.*`,
   * `using A.B`), and, for C# `global using`, every file of that project.
   */
  namespaceFiles(namespace: string, language: LanguageId): string[] {
    const rows = this.stmt(
      `SELECT DISTINCT f.path FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.namespace = ?1 AND f.language = ?2
       UNION
       SELECT f.path FROM imports i JOIN files f ON f.id = i.file_id WHERE i.resolved_namespace = ?1 AND f.language = ?2
       UNION
       SELECT f.path FROM files f WHERE f.language = ?2 AND f.project IN (
         SELECT gf.project FROM imports gi JOIN files gf ON gf.id = gi.file_id
         WHERE gi.is_global = 1 AND gi.resolved_namespace = ?1)
       ORDER BY 1`,
    ).all(namespace, language) as { path: string }[];
    return rows.map((r) => r.path);
  }

  /** Moves WAL contents into the main file, so tools that read only the .db file see everything. */
  checkpoint(): void {
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }

  /** The browsable tables with their row counts and columns. */
  tables(): { name: BrowseTable; description: string; rows: number; columns: string[] }[] {
    return (Object.keys(BROWSE) as BrowseTable[]).map((name) => ({
      name,
      description: BROWSE[name].description,
      rows: (this.stmt(`SELECT count(*) AS n FROM ${BROWSE[name].table}`).get() as { n: number }).n,
      columns: BROWSE[name].columns.map(([c]) => c),
    }));
  }

  /**
   * A page of a table for the database browser, with ids resolved to readable values (file paths,
   * qualified names). `filter` matches any text column (SQL LIKE, case-insensitive).
   */
  browse(table: BrowseTable, opts: { filter?: string; offset?: number; limit?: number } = {}): { columns: string[]; rows: unknown[][]; total: number } {
    const { select, where, params } = browseQuery(table, opts.filter);
    const total = (this.stmt(`SELECT count(*) AS n FROM ${BROWSE[table].from} ${where}`).get(...params) as { n: number }).n;
    const stmt = this.stmt(`${select} ${where} ORDER BY 1 LIMIT ? OFFSET ?`);
    stmt.setReturnArrays(true);
    const rows = stmt.all(...params, Math.min(opts.limit ?? 100, 1000), opts.offset ?? 0) as unknown as unknown[][];
    stmt.setReturnArrays(false);
    return { columns: BROWSE[table].columns.map(([c]) => c), rows, total };
  }

  /** Writes a (filtered) table as CSV. Returns the number of rows written. */
  exportCsv(table: BrowseTable, path: string, filter?: string): number {
    const { select, where, params } = browseQuery(table, filter);
    const stmt = this.db.prepare(`${select} ${where} ORDER BY 1`);
    stmt.setReturnArrays(true);
    const fd = openSync(path, 'w');
    let count = 0;
    try {
      let chunk = `${BROWSE[table].columns.map(([c]) => csvField(c)).join(',')}\r\n`;
      for (const row of stmt.iterate(...params) as Iterable<unknown[]>) {
        chunk += `${row.map(csvField).join(',')}\r\n`;
        count++;
        if (chunk.length > 1 << 16) {
          writeSync(fd, chunk);
          chunk = '';
        }
      }
      writeSync(fd, chunk);
    } finally {
      closeSync(fd);
    }
    return count;
  }

  close(): void {
    this.db.close();
  }
}

export type BrowseTable = 'files' | 'symbols' | 'imports' | 'symbol_parts' | 'edges';

/** How each table is shown in the database browser and exported to CSV: [column, SQL expression]. */
const BROWSE: Record<BrowseTable, { table: string; from: string; description: string; columns: [string, string][] }> = {
  files: {
    table: 'files',
    from: 'files f',
    description: 'One row per indexed file; the hash drives incremental updates',
    columns: [['id', 'f.id'], ['path', 'f.path'], ['language', 'f.language'], ['project', 'f.project'], ['hash', 'f.hash'], ['indexed_at', 'f.indexed_at']],
  },
  symbols: {
    table: 'symbols',
    from: 'symbols s JOIN files f ON f.id = s.file_id',
    description: 'Classes, methods, properties and other declarations',
    columns: [
      ['id', 's.id'], ['kind', 's.kind'], ['name', 's.name'], ['qualified_name', 's.qualified_name'], ['signature', 's.signature'],
      ['path', 'f.path'], ['start_line', 's.start_line'], ['end_line', 's.end_line'], ['namespace', 's.namespace'],
      ['native_kind', 's.native_kind'], ['exported', 's.exported'], ['partial', 's.is_partial'], ['parent_id', 's.parent_id'],
      ['merged_into', 's.merged_into'], ['doc', 's.doc'],
    ],
  },
  imports: {
    table: 'imports',
    from: 'imports i JOIN files f ON f.id = i.file_id LEFT JOIN files rf ON rf.id = i.resolved_file_id LEFT JOIN symbols rs ON rs.id = i.resolved_symbol_id',
    description: 'Raw imports and where they resolve',
    columns: [
      ['id', 'i.id'], ['path', 'f.path'], ['line', 'i.line'], ['kind', 'i.kind'], ['spec', 'i.spec'], ['names', 'i.names'],
      ['alias', 'i.alias'], ['global', 'i.is_global'], ['resolved_path', 'rf.path'], ['resolved_namespace', 'i.resolved_namespace'],
      ['resolved_symbol', 'rs.qualified_name'],
    ],
  },
  symbol_parts: {
    table: 'symbol_parts',
    from: 'symbol_parts p JOIN symbols s ON s.id = p.symbol_id JOIN files f ON f.id = p.file_id',
    description: 'Every file a C# partial type is declared in',
    columns: [['symbol_id', 'p.symbol_id'], ['qualified_name', 's.qualified_name'], ['path', 'f.path'], ['start_line', 'p.start_line'], ['end_line', 'p.end_line']],
  },
  edges: {
    table: 'edges',
    from: 'edges e JOIN symbols a ON a.id = e.from_symbol_id JOIN symbols b ON b.id = e.to_symbol_id',
    description: 'Calls, inheritance and references between symbols (filled in Phase 4)',
    columns: [['from', 'a.qualified_name'], ['type', 'e.type'], ['to', 'b.qualified_name']],
  },
};

export const BROWSE_TABLES = Object.keys(BROWSE) as BrowseTable[];

function browseQuery(table: BrowseTable, filter?: string) {
  const def = BROWSE[table];
  if (!def) throw new Error(`unknown table ${table}`);
  const select = `SELECT ${def.columns.map(([, sql]) => sql).join(', ')} FROM ${def.from}`;
  if (!filter?.trim()) return { select, where: '', params: [] as string[] };
  const like = `%${filter.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const where = `WHERE ${def.columns.map(([, sql]) => `CAST(${sql} AS TEXT) LIKE ?1 ESCAPE '\\'`).join(' OR ')}`;
  return { select, where, params: [like] };
}

function csvField(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Thrown by a read-only IndexDb when there is no usable index yet. */
export class IndexNotReadyError extends Error {}
