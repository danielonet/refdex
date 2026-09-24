import type { Dirent } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, join, relative, sep } from 'node:path';
import ignore, { type Ignore } from 'ignore';
import { languageForPath, type LanguageId } from './languages.ts';
import { loadTsConfig, type TsConfig } from './resolve/tsconfig.ts';

/** Always skipped, with or without a .gitignore: dependencies, build output, VCS and tool folders. */
export const IGNORED_DIRS = new Set([
  '.git', '.hg', '.svn', '.refdex', '.idea', '.vscode-test',
  'node_modules', 'bower_components', 'dist', 'out', 'build', 'coverage',
  'bin', 'obj', 'target', '.gradle',
  '__pycache__', '.venv', 'venv', '.tox', '.mypy_cache', '.pytest_cache',
]);

/** Larger files are usually generated or minified and not worth indexing. */
export const MAX_FILE_BYTES = 1_000_000;

/** Files that mark a project root. A change to one of these can change import resolution. */
const PROJECT_MARKERS: Record<LanguageId, (name: string) => boolean> = {
  python: (n) => n === 'pyproject.toml' || n === 'setup.py' || n === 'setup.cfg',
  typescript: (n) => n === 'tsconfig.json' || n === 'package.json',
  tsx: (n) => n === 'tsconfig.json' || n === 'package.json',
  java: (n) => n === 'pom.xml' || n === 'build.gradle' || n === 'build.gradle.kts',
  csharp: (n) => n.endsWith('.csproj'),
};

export function isConfigFile(path: string): boolean {
  const name = basename(path);
  return name === '.gitignore' || Object.values(PROJECT_MARKERS).some((m) => m(name));
}

interface WorkspacePackage {
  dir: string;
  manifest: { exports?: unknown; types?: string; typings?: string; main?: string; module?: string };
}

/**
 * The set of indexable source files under a root, plus the project layout that import resolution
 * needs: .gitignore rules, project marker files, tsconfig files and workspace npm packages.
 */
export class Workspace {
  readonly root: string;
  readonly files = new Set<string>();
  /** Folders containing each marker file name. */
  private readonly markers = new Map<string, Set<string>>();
  private readonly ignores = new Map<string, Ignore>();
  private readonly tsconfigs = new Map<string, TsConfig | undefined>();
  private packages?: Map<string, WorkspacePackage>;
  private pythonRootsCache?: string[];

  private constructor(root: string) {
    this.root = root;
  }

  /** `exclude`: extra gitignore-style patterns relative to the root (the `refdex.exclude` setting). */
  static async scan(root: string, exclude: readonly string[] = []): Promise<Workspace> {
    const ws = new Workspace(root);
    await ws.loadIgnore(root, join(root, '.git', 'info', 'exclude'));
    if (exclude.length) ws.ignores.set(root, (ws.ignores.get(root) ?? ignore()).add([...exclude]));
    await ws.walk(root);
    for (const pkg of ws.markers.get('package.json') ?? []) {
      await ws.loadPackage(pkg);
    }
    return ws;
  }

  /** Adds the source files under a folder that appeared (created, or renamed into place). Returns them. */
  async addTree(dir: string): Promise<string[]> {
    if (this.isIgnored(dir, true)) return [];
    return this.walk(dir);
  }

  /** Forgets every file under a folder that disappeared. Returns them. */
  removeTree(dir: string): string[] {
    const prefix = dir + sep;
    const removed = [...this.files].filter((f) => f.startsWith(prefix));
    for (const f of removed) this.files.delete(f);
    return removed;
  }

  private async walk(start: string): Promise<string[]> {
    const found: string[] = [];
    const pending = [start];
    while (pending.length) {
      const dir = pending.pop()!;
      let entries: Dirent[];
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        continue; // unreadable folder
      }
      if (entries.some((e) => e.name === '.gitignore' && e.isFile())) await this.loadIgnore(dir);
      for (const entry of entries) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!this.isIgnored(path, true)) pending.push(path);
        } else if (entry.isFile() && !this.isIgnored(path, false)) {
          this.noteMarker(path);
          if (languageForPath(path) && (await stat(path)).size <= MAX_FILE_BYTES) {
            this.files.add(path);
            found.push(path);
          }
        }
      }
    }
    return found;
  }

  /** True for paths excluded by the built-in folder list or a .gitignore on the way from the root. */
  isIgnored(path: string, isDir: boolean): boolean {
    const rel = relative(this.root, path);
    if (!rel || rel.startsWith('..')) return !!rel;
    const parts = rel.split(sep);
    const dirParts = isDir ? parts : parts.slice(0, -1);
    if (dirParts.some((p) => IGNORED_DIRS.has(p))) return true;
    let dir = this.root;
    for (let i = 0; i < parts.length; i++) {
      const ig = this.ignores.get(dir);
      if (ig) {
        const sub = parts.slice(i).join('/');
        if (ig.ignores(isDir ? `${sub}/` : sub)) return true;
      }
      dir = join(dir, parts[i]);
    }
    return false;
  }

  /**
   * Updates the file set after a change on disk. Returns true when the path is a source file to
   * (re)index, false when it is gone or not indexable.
   */
  async refresh(path: string): Promise<boolean> {
    const info = await stat(path).catch(() => undefined);
    const indexable = !!info?.isFile() && !!languageForPath(path) && info.size <= MAX_FILE_BYTES && !this.isIgnored(path, false);
    if (indexable) this.files.add(path);
    else this.files.delete(path);
    return indexable;
  }

  hasFile(path: string): boolean {
    return this.files.has(path);
  }

  /** Nearest folder at or above `path` that holds a project marker for `language`, else the root. */
  projectRoot(path: string, language: LanguageId): string {
    const isMarker = PROJECT_MARKERS[language];
    const dirs = new Set<string>();
    for (const [name, found] of this.markers) if (isMarker(name)) for (const d of found) dirs.add(d);
    for (let dir = dirname(path); ; dir = dirname(dir)) {
      if (dirs.has(dir)) return dir;
      if (dir === this.root || dirname(dir) === dir) return this.root;
    }
  }

  /** Nearest tsconfig.json at or above `path`, with `extends` applied. */
  tsconfigFor(path: string): TsConfig | undefined {
    const dirs = this.markers.get('tsconfig.json');
    if (!dirs) return undefined;
    for (let dir = dirname(path); ; dir = dirname(dir)) {
      if (dirs.has(dir)) {
        if (!this.tsconfigs.has(dir)) this.tsconfigs.set(dir, loadTsConfig(join(dir, 'tsconfig.json'), this.root));
        return this.tsconfigs.get(dir);
      }
      if (dir === this.root || dirname(dir) === dir) return undefined;
    }
  }

  /** npm packages whose package.json lives in the workspace (monorepo packages), by name. */
  workspacePackage(name: string): WorkspacePackage | undefined {
    return this.packages?.get(name);
  }

  /**
   * Folders Python absolute imports are resolved against, deepest first: project roots (and their
   * `src/`), parents of top-level packages, and the workspace root.
   */
  pythonRoots(): string[] {
    if (this.pythonRootsCache) return this.pythonRootsCache;
    const roots = new Set<string>([this.root]);
    for (const name of ['pyproject.toml', 'setup.py', 'setup.cfg']) {
      for (const dir of this.markers.get(name) ?? []) {
        roots.add(dir);
        roots.add(join(dir, 'src'));
      }
    }
    for (const file of this.files) {
      if (basename(file) !== '__init__.py') continue;
      const pkg = dirname(file);
      if (!this.files.has(join(dirname(pkg), '__init__.py'))) roots.add(dirname(pkg));
    }
    this.pythonRootsCache = [...roots].sort((a, b) => b.length - a.length);
    return this.pythonRootsCache;
  }

  /** Drops cached layout after a config file or package structure changed. */
  invalidateLayout(): void {
    this.tsconfigs.clear();
    this.pythonRootsCache = undefined;
  }

  private noteMarker(path: string): void {
    const name = basename(path);
    if (!isConfigFile(path) || name === '.gitignore') return;
    const key = name.endsWith('.csproj') ? '*.csproj' : name;
    let dirs = this.markers.get(key);
    if (!dirs) this.markers.set(key, (dirs = new Set()));
    dirs.add(dirname(path));
    if (key === '*.csproj') this.markers.set(name, dirs);
  }

  private async loadIgnore(dir: string, ...extra: string[]): Promise<void> {
    const texts: string[] = [];
    for (const file of [join(dir, '.gitignore'), ...extra]) {
      const text = await readFile(file, 'utf8').catch(() => undefined);
      if (text) texts.push(text);
    }
    if (!texts.length) return;
    const ig = this.ignores.get(dir) ?? ignore();
    for (const t of texts) ig.add(t);
    this.ignores.set(dir, ig);
  }

  private async loadPackage(dir: string): Promise<void> {
    try {
      const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
      if (typeof manifest.name === 'string') (this.packages ??= new Map()).set(manifest.name, { dir, manifest });
    } catch {
      // unreadable or invalid package.json
    }
  }
}
