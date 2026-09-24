import * as sea from 'node:sea';
import { parentPort, Worker, workerData } from 'node:worker_threads';
import { IndexDb, Indexer, TreeSitter, type IndexSummary } from '@refdex/core';
import { wasmLoader } from './wasm.ts';

export interface IndexWorkerData {
  root: string;
  dbPath: string;
  exclude: string[];
}

export type WorkerRequest = { type: 'sync'; full: boolean; rebuild: boolean; paths: string[] };
export type WorkerReply = { type: 'done'; summary: IndexSummary } | { type: 'error'; message: string };

/**
 * Starts the indexing worker thread: the same script (or single executable) re-entered with
 * `isMainThread === false`, which then calls `runIndexWorker`.
 */
export function startIndexWorker(data: IndexWorkerData): Worker {
  if (sea.isSea()) {
    // A single executable has no script file on disk; the bundle is embedded as an asset.
    return new Worker(sea.getAsset('refdex.cjs', 'utf8'), { eval: true, workerData: data });
  }
  return new Worker(process.argv[1], { workerData: data });
}

/** Worker thread body: owns the write connection, the parser and the indexer. */
export async function runIndexWorker(): Promise<void> {
  const { root, dbPath, exclude } = workerData as IndexWorkerData;
  const db = new IndexDb(dbPath);
  const indexer = new Indexer(db, await TreeSitter.create(wasmLoader()), root, exclude);
  parentPort!.on('message', async (req: WorkerRequest) => {
    try {
      const summary = req.rebuild ? await indexer.rebuild() : req.full ? await indexer.syncAll() : await indexer.syncPaths(req.paths);
      parentPort!.postMessage({ type: 'done', summary } satisfies WorkerReply);
    } catch (e) {
      parentPort!.postMessage({ type: 'error', message: e instanceof Error ? (e.stack ?? e.message) : String(e) } satisfies WorkerReply);
    }
  });
}
