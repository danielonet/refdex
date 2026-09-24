import { statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { IndexDb, type BrowseTable, type IndexSummary } from '@refdex/core';
import { TreeWatcher } from './watcher.ts';
import { startIndexWorker, type WorkerReply } from './worker.ts';

/**
 * `refdex serve`: the long-running daemon behind the IDE plugins.
 *
 * Protocol: JSON lines. Requests on stdin `{"id": 1, "method": "search", "params": {...}}`,
 * responses on stdout `{"id": 1, "result": ...}` or `{"id": 1, "error": "..."}`, and events
 * `{"event": "indexing" | "indexed" | "error", ...}`. The daemon exits when stdin closes.
 *
 * Methods: reindex {full?}, rebuild, stats, info, search {query, limit?, kind?, language?},
 * outline {path}, members {qualifiedName}, tables, browse {table, filter?, offset?, limit?},
 * exportCsv {table, path, filter?}, checkpoint, shutdown.
 *
 * Indexing runs in a worker thread with its own write connection; this thread answers queries
 * from a second connection (SQLite WAL lets readers run during writes). Once the workspace has
 * been indexed, a file watcher keeps it up to date.
 */
export interface ServeOptions {
  /** Extra gitignore-style patterns to leave out of the index. */
  exclude: string[];
  /** Keep the index up to date with a file watcher (default on). */
  watch: boolean;
}

export async function serve(root: string, dbPath: string, opts: ServeOptions): Promise<void> {
  const db = new IndexDb(dbPath);
  const send = (msg: object) => process.stdout.write(`${JSON.stringify(msg)}\n`);
  const worker = startIndexWorker({ root, dbPath, exclude: opts.exclude });

  // ---- indexing queue: at most one run at a time; requests arriving meanwhile are merged ----
  let running = false;
  let pendingRebuild = false;
  let pendingFull = false;
  const pendingPaths = new Set<string>();
  let waiters: ((s: IndexSummary | Error) => void)[] = [];
  let runWaiters: typeof waiters = [];

  const schedule = () => {
    if (running || (!pendingRebuild && !pendingFull && !pendingPaths.size)) return;
    running = true;
    const rebuild = pendingRebuild;
    const full = pendingFull || rebuild;
    const paths = [...pendingPaths];
    pendingRebuild = false;
    pendingFull = false;
    pendingPaths.clear();
    runWaiters = waiters;
    waiters = [];
    send({ event: 'indexing', full, rebuild, paths: paths.length });
    worker.postMessage({ type: 'sync', full, rebuild, paths });
  };

  worker.on('message', (reply: WorkerReply) => {
    running = false;
    const done = runWaiters;
    runWaiters = [];
    if (reply.type === 'done') {
      send({ event: 'indexed', summary: reply.summary, stats: db.stats() });
      for (const w of done) w(reply.summary);
    } else {
      send({ event: 'error', message: reply.message });
      for (const w of done) w(new Error(reply.message));
    }
    schedule();
  });
  worker.on('error', (e) => {
    send({ event: 'error', message: `index worker crashed: ${e.message}` });
    process.exit(1);
  });

  const reindex = (full: boolean, rebuild = false) =>
    new Promise<IndexSummary>((resolve, reject) => {
      pendingFull ||= full;
      pendingRebuild ||= rebuild;
      waiters.push((r) => (r instanceof Error ? reject(r) : resolve(r)));
      schedule();
    });

  // ---- watching starts once the workspace has an index (after the first reindex otherwise) ----
  let watcher: TreeWatcher | undefined;
  const startWatching = async () => {
    if (watcher || !opts.watch) return;
    watcher = new TreeWatcher(
      root,
      (paths) => {
        for (const p of paths) pendingPaths.add(p);
        schedule();
      },
      (e) => send({ event: 'error', message: `file watcher: ${e.message}` }),
    );
    await watcher.start();
  };
  if (db.counts().files > 0) {
    await startWatching();
    // Catch up on changes made while the daemon was not running (unchanged files are skipped).
    reindex(true).catch(() => {});
  }

  // ---- requests ----
  const handlers: Record<string, (params: any) => unknown> = {
    reindex: async (p: { full?: boolean }) => {
      const summary = await reindex(p?.full ?? true);
      await startWatching();
      return summary;
    },
    rebuild: async () => {
      const summary = await reindex(true, true);
      await startWatching();
      return summary;
    },
    stats: () => db.stats(),
    info: () => ({
      pid: process.pid,
      root,
      dbPath,
      dbBytes: fileSize(dbPath) + fileSize(`${dbPath}-wal`),
      watching: !!watcher,
      exclude: opts.exclude,
      node: process.version,
    }),
    tables: () => db.tables(),
    browse: (p: { table: BrowseTable; filter?: string; offset?: number; limit?: number }) => db.browse(p.table, p),
    exportCsv: (p: { table: BrowseTable; path: string; filter?: string }) => ({ rows: db.exportCsv(p.table, p.path, p.filter) }),
    checkpoint: () => db.checkpoint(),
    search: (p: { query: string; limit?: number; kind?: string; language?: string }) =>
      db.search(p.query, p.limit ?? 50, { kind: p.kind, language: p.language }),
    outline: (p: { path: string }) => ({ symbols: db.fileSymbols(p.path), imports: db.effectiveImports(p.path) }),
    members: (p: { qualifiedName: string }) => {
      const [type] = db.symbolsByQualifiedName(p.qualifiedName);
      return type ? { type, members: db.members(type.id), parts: db.symbolParts(type.id) } : null;
    },
    shutdown: () => setImmediate(() => process.exit(0)),
  };

  const rl = createInterface({ input: process.stdin });
  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let id: unknown;
    try {
      const req = JSON.parse(line) as { id?: unknown; method: string; params?: unknown };
      id = req.id;
      const handler = handlers[req.method];
      if (!handler) throw new Error(`unknown method ${req.method}`);
      send({ id, result: (await handler(req.params)) ?? null });
    } catch (e) {
      send({ id, error: e instanceof Error ? e.message : String(e) });
    }
  });
  rl.on('close', () => {
    watcher?.close();
    process.exit(0);
  });
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}
