import type { DatabaseSync as Database } from 'node:sqlite';
import type { ExtractedSymbol, LanguageId } from '@refdex/core';

// Loaded at evaluation time (not ESM link time) so quiet-sqlite-warning.ts runs first.
const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');

// Spike schema: enough to prove node:sqlite and FTS5 work in the packaged daemon.
// Phase 1 replaces it with the full schema (symbol_parts, imports, edges).
const SCHEMA = `
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  language TEXT NOT NULL,
  hash TEXT NOT NULL,
  indexed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS symbols (
  id INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  native_kind TEXT NOT NULL,
  name TEXT NOT NULL,
  qualified_name TEXT NOT NULL,
  signature TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  parent_id INTEGER REFERENCES symbols(id)
);
CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5(
  name, qualified_name, content='symbols', content_rowid='id'
);
CREATE TRIGGER IF NOT EXISTS symbols_ai AFTER INSERT ON symbols BEGIN
  INSERT INTO symbols_fts(rowid, name, qualified_name) VALUES (new.id, new.name, new.qualified_name);
END;
CREATE TRIGGER IF NOT EXISTS symbols_ad AFTER DELETE ON symbols BEGIN
  INSERT INTO symbols_fts(symbols_fts, rowid, name, qualified_name) VALUES ('delete', old.id, old.name, old.qualified_name);
END;
`;

export interface SearchHit {
  kind: string;
  qualified_name: string;
  signature: string;
  path: string;
  start_line: number;
  end_line: number;
}

export class IndexDb {
  readonly db: Database;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
  }

  replaceFile(path: string, language: LanguageId, hash: string, symbols: ExtractedSymbol[]): void {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM files WHERE path = ?').run(path);
      const { lastInsertRowid: fileId } = this.db
        .prepare('INSERT INTO files (path, language, hash, indexed_at) VALUES (?, ?, ?, ?)')
        .run(path, language, hash, new Date().toISOString());
      const insert = this.db.prepare(
        `INSERT INTO symbols (file_id, kind, native_kind, name, qualified_name, signature, start_line, end_line, parent_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      // Symbols arrive parent-first, so a parent's row id is known before its children.
      const ids = new Map<ExtractedSymbol, number | bigint>();
      for (const s of symbols) {
        const parentId = s.parent ? (ids.get(s.parent) ?? null) : null;
        const { lastInsertRowid } = insert.run(
          fileId, s.kind, s.nativeKind, s.name, s.qualifiedName, s.signature, s.startLine, s.endLine, parentId,
        );
        ids.set(s, lastInsertRowid);
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  search(query: string, limit = 20): SearchHit[] {
    // Prefix search on each whitespace-separated term.
    const match = query.split(/\s+/).filter(Boolean).map((t) => `"${t.replace(/"/g, '""')}"*`).join(' ');
    return this.db
      .prepare(
        `SELECT s.kind, s.qualified_name, s.signature, f.path, s.start_line, s.end_line
         FROM symbols_fts JOIN symbols s ON s.id = symbols_fts.rowid JOIN files f ON f.id = s.file_id
         WHERE symbols_fts MATCH ? ORDER BY rank LIMIT ?`,
      )
      .all(match, limit) as unknown as SearchHit[];
  }

  counts(): { files: number; symbols: number } {
    const row = this.db
      .prepare('SELECT (SELECT count(*) FROM files) AS files, (SELECT count(*) FROM symbols) AS symbols')
      .get() as { files: number; symbols: number };
    return { files: row.files, symbols: row.symbols };
  }
}
