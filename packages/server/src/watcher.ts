import { watch, type FSWatcher } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { IGNORED_DIRS } from '@refdex/core';

/**
 * Reports changed paths under a root, debounced. macOS and Windows have native recursive
 * watching. On Linux, Node's recursive mode adds an inotify watch for every folder, including
 * node_modules, so this watches each non-ignored folder itself and follows new folders.
 * .gitignore filtering happens later, in the indexer.
 */
export class TreeWatcher {
  private readonly watchers = new Map<string, FSWatcher>();
  private pending = new Set<string>();
  private timer?: NodeJS.Timeout;
  private readonly root: string;
  private readonly onChange: (paths: string[]) => void;
  private readonly onError: (error: Error) => void;
  private readonly debounceMs: number;

  constructor(root: string, onChange: (paths: string[]) => void, onError: (error: Error) => void, debounceMs = 250) {
    this.root = root;
    this.debounceMs = debounceMs;
    this.onChange = onChange;
    this.onError = onError;
  }

  async start(): Promise<void> {
    if (process.platform === 'linux') {
      await this.watchTree(this.root);
    } else {
      const w = watch(this.root, { recursive: true }, (_event, name) => {
        if (name && !isIgnored(name.toString())) this.report(join(this.root, name.toString()));
      });
      w.on('error', this.onError);
      this.watchers.set(this.root, w);
    }
  }

  close(): void {
    clearTimeout(this.timer);
    for (const w of this.watchers.values()) w.close();
    this.watchers.clear();
  }

  private async watchTree(dir: string): Promise<void> {
    const pending = [dir];
    while (pending.length) {
      const d = pending.pop()!;
      if (this.watchers.has(d)) continue;
      try {
        const w = watch(d, (event, name) => this.onLinuxEvent(d, event, name?.toString()));
        w.on('error', (e: NodeJS.ErrnoException) => {
          // The folder itself was deleted; its parent reports that.
          if (e.code !== 'EPERM' && e.code !== 'ENOENT') this.onError(e);
          this.unwatch(d);
        });
        this.watchers.set(d, w);
        for (const entry of await readdir(d, { withFileTypes: true })) {
          if (entry.isDirectory() && !IGNORED_DIRS.has(entry.name)) pending.push(join(d, entry.name));
        }
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code === 'ENOSPC') {
          this.onError(new Error('Out of inotify watches; raise fs.inotify.max_user_watches to watch this workspace.'));
          return;
        }
        // ENOENT/EACCES: folder vanished or is unreadable.
      }
    }
  }

  private onLinuxEvent(dir: string, event: string, name: string | undefined): void {
    if (!name) return;
    const path = join(dir, name);
    if (event === 'rename' && !IGNORED_DIRS.has(name)) {
      // A folder created or moved in needs its own watchers; one that went away drops them.
      stat(path).then(
        (info) => {
          if (info.isDirectory()) void this.watchTree(path);
        },
        () => this.unwatch(path),
      );
    }
    if (!IGNORED_DIRS.has(name)) this.report(path);
  }

  private unwatch(dir: string): void {
    for (const [d, w] of this.watchers) {
      if (d === dir || d.startsWith(dir + '/')) {
        w.close();
        this.watchers.delete(d);
      }
    }
  }

  private report(path: string): void {
    this.pending.add(path);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      const paths = [...this.pending];
      this.pending = new Set();
      this.onChange(paths);
    }, this.debounceMs);
  }
}

function isIgnored(relPath: string): boolean {
  return relPath.split(/[\\/]/).some((part) => IGNORED_DIRS.has(part));
}
