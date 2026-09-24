import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import * as vscode from 'vscode';

export interface IndexSummary {
  indexed: number;
  unchanged: number;
  removed: number;
  failed: { path: string; error: string }[];
  importsResolved: number;
  importsUnresolved: number;
  edgesResolved: number;
  edgesUnresolved: number;
  files: number;
  symbols: number;
  ms: number;
}

export interface IndexStats {
  files: number;
  symbols: number;
  imports: number;
  resolvedImports: number;
  edges: number;
  resolvedEdges: number;
  byLanguage: { language: string; files: number; symbols: number }[];
  indexedAt: string | null;
}

export interface SymbolHit {
  kind: string;
  qualified_name: string;
  signature: string;
  doc: string | null;
  path: string;
  start_line: number;
  end_line: number;
}

export interface DaemonInfo {
  pid: number;
  root: string;
  dbPath: string;
  dbBytes: number;
  watching: boolean;
  exclude: string[];
  include: string[];
  languages: string[];
  node: string;
}

export interface TableInfo {
  name: string;
  description: string;
  rows: number;
  columns: string[];
}

export interface TablePage {
  columns: string[];
  rows: unknown[][];
  total: number;
}

export interface DaemonOptions {
  exclude: string[];
  include: string[];
  languages: string[];
  watch: boolean;
}

export type DaemonEvent =
  | { event: 'indexing'; full: boolean; rebuild: boolean; paths: number }
  | { event: 'indexed'; summary: IndexSummary; stats: IndexStats }
  | { event: 'error'; message: string };

/**
 * Talks to the bundled RefDex daemon (`refdex serve`, dist/daemon/refdex.cjs) over JSON lines on
 * stdio. The daemon runs on VS Code's own runtime in Node mode, so users need no Node install.
 * It keeps the index up to date with a file watcher once the workspace has been indexed.
 */
export class Daemon implements vscode.Disposable {
  private child?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private readonly events = new vscode.EventEmitter<DaemonEvent>();
  readonly onEvent = this.events.event;
  private readonly script: string;
  private options: DaemonOptions;

  constructor(
    extensionUri: vscode.Uri,
    readonly root: string,
    readonly dbPath: string,
    options: DaemonOptions,
    private readonly log: vscode.OutputChannel,
  ) {
    this.script = vscode.Uri.joinPath(extensionUri, 'dist', 'daemon', 'refdex.cjs').fsPath;
    this.options = options;
  }

  get running(): boolean {
    return !!this.child;
  }

  /** Restarts with new options (settings changed). The daemon then catches up on its own. */
  restart(options: DaemonOptions): void {
    this.options = options;
    this.stop();
    this.start();
  }

  start(): void {
    if (this.child) {
      return;
    }
    const args = [
      'serve', '--root', this.root, '--db', this.dbPath,
      ...this.options.exclude.flatMap((p) => ['--exclude', p]),
      ...this.options.include.flatMap((p) => ['--include', p]),
      ...this.options.languages.flatMap((l) => ['--language', l]),
    ];
    if (!this.options.watch) {
      args.push('--no-watch');
    }
    this.log.appendLine(`starting daemon: refdex ${args.join(' ')}`);
    const child = spawn(process.execPath, [this.script, ...args], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    this.child = child;
    child.stderr.on('data', (chunk: Buffer) => this.log.append(chunk.toString()));
    createInterface({ input: child.stdout }).on('line', (line) => this.onLine(line));
    child.on('exit', (code, signal) => {
      this.log.appendLine(`daemon exited (${signal ?? code})`);
      if (this.child === child) {
        this.child = undefined;
      }
      for (const p of this.pending.values()) {
        p.reject(new Error('RefDex daemon exited'));
      }
      this.pending.clear();
    });
  }

  reindex(full = true): Promise<IndexSummary> {
    return this.request('reindex', { full });
  }

  /** Drops the index and builds it again from scratch. */
  rebuild(): Promise<IndexSummary> {
    return this.request('rebuild');
  }

  stats(): Promise<IndexStats> {
    return this.request('stats');
  }

  info(): Promise<DaemonInfo> {
    return this.request('info');
  }

  tables(): Promise<TableInfo[]> {
    return this.request('tables');
  }

  browse(table: string, filter: string, offset: number, limit: number): Promise<TablePage> {
    return this.request('browse', { table, filter, offset, limit });
  }

  exportCsv(table: string, path: string, filter?: string): Promise<{ rows: number }> {
    return this.request('exportCsv', { table, path, filter });
  }

  /** Flushes the write-ahead log into index.db so other tools see the whole index. */
  checkpoint(): Promise<void> {
    return this.request('checkpoint');
  }

  search(query: string, limit = 50): Promise<SymbolHit[]> {
    return this.request('search', { query, limit });
  }

  private request<T>(method: string, params?: object): Promise<T> {
    this.start();
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.child!.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  private onLine(line: string): void {
    let msg: { id?: number; result?: unknown; error?: string } & Partial<DaemonEvent>;
    try {
      msg = JSON.parse(line);
    } catch {
      this.log.appendLine(line);
      return;
    }
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) {
        p?.reject(new Error(msg.error));
      } else {
        p?.resolve(msg.result);
      }
    } else if (msg.event) {
      if (msg.event === 'error') {
        this.log.appendLine(`error: ${msg.message}`);
      }
      this.events.fire(msg as DaemonEvent);
    }
  }

  private stop(): void {
    const child = this.child;
    this.child = undefined;
    child?.stdin.end();
    child?.kill();
    for (const p of this.pending.values()) {
      p.reject(new Error('RefDex daemon restarted'));
    }
    this.pending.clear();
  }

  dispose(): void {
    this.stop();
    this.events.dispose();
  }
}
