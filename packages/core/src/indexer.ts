import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { sep } from 'node:path';
import { adapterFor } from './adapters/index.ts';
import type { NamespaceLookup, ResolveContext } from './adapters/types.ts';
import type { IndexDb, ImportRow } from './db.ts';
import { languageForPath, type LanguageId } from './languages.ts';
import type { ImportDecl } from './model.ts';
import type { TreeSitter } from './parser.ts';
import { isConfigFile, Workspace, type WorkspaceOptions } from './workspace.ts';

export interface IndexSummary {
  /** Files parsed and written in this run. */
  indexed: number;
  /** Files skipped because their content hash was unchanged. */
  unchanged: number;
  removed: number;
  failed: { path: string; error: string }[];
  importsResolved: number;
  importsUnresolved: number;
  files: number;
  symbols: number;
  ms: number;
}

const NAMESPACE_LANGUAGES: LanguageId[] = ['java', 'csharp'];

/**
 * Keeps an IndexDb in step with a workspace folder. Two passes: parse changed files and store
 * their symbols and raw imports, then resolve imports against the whole index (namespace-based
 * languages need every file's types before any import can be resolved).
 */
export class Indexer {
  readonly root: string;
  private readonly db: IndexDb;
  private readonly treeSitter: TreeSitter;
  private readonly options: WorkspaceOptions;
  private workspace?: Workspace;

  /** `options`: what to index on top of .gitignore and the built-in folder list. */
  constructor(db: IndexDb, treeSitter: TreeSitter, root: string, options: WorkspaceOptions = {}) {
    this.db = db;
    this.treeSitter = treeSitter;
    this.root = root;
    this.options = options;
  }

  /** Drops the whole index and builds it again from scratch. */
  async rebuild(): Promise<IndexSummary> {
    this.db.clear();
    this.workspace = undefined;
    return this.syncAll();
  }

  /** Full scan: indexes new and changed files, drops files that are gone or now ignored. */
  async syncAll(): Promise<IndexSummary> {
    const started = performance.now();
    this.workspace = await Workspace.scan(this.root, this.options);
    const known = this.db.fileHashes();
    const paths = [...this.workspace.files].sort();
    const result = await this.indexFiles(paths, known);
    for (const path of known.keys()) {
      if (path.startsWith(this.root + sep) && !this.workspace.files.has(path)) {
        this.db.removeFile(path);
        result.removed++;
      }
    }
    return this.finish(result, started);
  }

  /**
   * Incremental update for paths reported by a file watcher. A change to .gitignore or a project
   * file (tsconfig.json, pyproject.toml, *.csproj, ...) triggers a full scan instead.
   */
  async syncPaths(paths: string[]): Promise<IndexSummary> {
    if (!this.workspace || paths.some(isConfigFile)) return this.syncAll();
    const started = performance.now();
    const ws = this.workspace;
    const toIndex: string[] = [];
    let removed = 0;
    let layoutChanged = false;
    const known = this.db.fileHashes();
    for (const path of new Set(paths)) {
      if (!path.startsWith(this.root + sep)) continue;
      const info = await stat(path).catch(() => undefined);
      if (info?.isDirectory()) {
        // A folder appeared (created or renamed into place): index everything in it.
        const added = await ws.addTree(path);
        toIndex.push(...added);
        layoutChanged ||= added.length > 0;
        continue;
      }
      const had = ws.hasFile(path);
      if (info && (await ws.refresh(path))) {
        toIndex.push(path);
        layoutChanged ||= !had;
        continue;
      }
      // Gone or no longer indexable. If it was a folder, everything under it is gone too.
      const prefix = path + sep;
      const gone = new Set([path, ...ws.removeTree(path), ...[...known.keys()].filter((k) => k.startsWith(prefix))]);
      for (const f of gone) {
        if (this.db.removeFile(f)) removed++;
      }
      layoutChanged ||= gone.size > 1 || had;
    }
    // New or deleted files can change Python roots (a new __init__.py) and module names.
    if (layoutChanged) ws.invalidateLayout();
    const result = await this.indexFiles(toIndex, known);
    result.removed += removed;
    return this.finish(result, started);
  }

  private async indexFiles(paths: string[], known: Map<string, string>) {
    const ws = this.workspace!;
    const result = { indexed: 0, unchanged: 0, removed: 0, failed: [] as IndexSummary['failed'], changedIds: [] as number[] };
    // Parse outside the transaction, write in batches so readers are never blocked for long.
    const BATCH = 200;
    for (let i = 0; i < paths.length; i += BATCH) {
      const batch: { path: string; hash: string; parsed: Awaited<ReturnType<TreeSitter['parseFile']>>; language: LanguageId }[] = [];
      for (const path of paths.slice(i, i + BATCH)) {
        const language = languageForPath(path);
        if (!language) continue;
        try {
          const source = await readFile(path, 'utf8');
          const hash = createHash('sha1').update(source).digest('hex');
          if (known.get(path) === hash) {
            result.unchanged++;
            continue;
          }
          batch.push({ path, hash, language, parsed: await this.treeSitter.parseFile(path, language, source, ws) });
        } catch (e) {
          result.failed.push({ path, error: e instanceof Error ? e.message : String(e) });
        }
      }
      this.db.transaction(() => {
        for (const f of batch) {
          result.changedIds.push(this.db.replaceFile(f.path, f.hash, ws.projectRoot(f.path, f.language), f.parsed));
          result.indexed++;
        }
      });
    }
    return result;
  }

  private finish(result: Awaited<ReturnType<Indexer['indexFiles']>>, started: number): IndexSummary {
    const { resolved, unresolved } = this.db.transaction(() => {
      const counts = this.resolveImports(result.changedIds);
      this.db.mergePartials();
      return counts;
    });
    const { changedIds: _ids, ...rest } = result;
    return {
      ...rest,
      importsResolved: resolved,
      importsUnresolved: unresolved,
      ...this.db.counts(),
      ms: Math.round(performance.now() - started),
    };
  }

  /** Resolves imports of changed files and retries every unresolved import (a new file may satisfy it). */
  private resolveImports(changedIds: number[]): { resolved: number; unresolved: number } {
    const rows = this.db.importsToResolve(changedIds);
    if (!rows.length) return { resolved: 0, unresolved: 0 };
    const ctx = this.resolveContext();
    const fileIds = this.db.fileIds();
    const typeIds = new Map<string, number>();
    for (const [name, t] of this.db.types(NAMESPACE_LANGUAGES)) typeIds.set(name, t.id);
    let resolved = 0;
    for (const row of rows) {
      const res = adapterFor(row.language).resolveImport(toDecl(row), row.path, ctx);
      const fileId = res.file ? (fileIds.get(res.file) ?? null) : null;
      const symbolId = res.symbol ? (typeIds.get(res.symbol) ?? null) : null;
      this.db.setImportResolution(row.id, fileId, res.namespace ?? null, symbolId);
      if (fileId !== null || res.namespace) resolved++;
    }
    return { resolved, unresolved: rows.length - resolved };
  }

  private resolveContext(): ResolveContext {
    let types: Map<string, { path: string }> | undefined;
    let namespaces: Set<string> | undefined;
    const lookup: NamespaceLookup = {
      typeFile: (name) => (types ??= this.db.types(NAMESPACE_LANGUAGES)).get(name)?.path,
      hasNamespace: (ns) => (namespaces ??= this.db.namespaces(NAMESPACE_LANGUAGES)).has(ns),
    };
    return { workspace: this.workspace!, namespaces: lookup };
  }
}

function toDecl(row: ImportRow): ImportDecl {
  return { kind: row.kind, spec: row.spec, names: row.names, alias: row.alias ?? undefined, global: !!row.is_global, line: row.line };
}
