import type { CallerRow, IndexDb, SymbolRow } from './db.ts';
import { languageForPath } from './languages.ts';

/** A method (or module-level code) that calls the target, directly or through other callers. */
export interface BlastCaller {
  /** The calling symbol; null for module-level code (scripts, top-level statements). */
  caller: SymbolRow | null;
  /** Where the call is. */
  path: string;
  line: number;
  /** 1 for direct callers, 2 for their callers, and so on. */
  level: number;
  /** In a test file (see isTestPath). */
  test: boolean;
}

/**
 * Calls named like a symbol in the walk that the index could not link, so the walk didn't follow
 * them. For the target, every such call; for callers, only calls on the result of another call
 * (`segmentFor(hash).put()`): common names like `put` have many unlinked calls on objects of unknown
 * type, mostly to library methods, which would bury the warnings that matter.
 */
export interface UnlinkedCalls {
  /** The target, or a caller the walk went through. */
  symbol: { id: number; qualified_name: string; name: string };
  /** Counted for the target (every unlinked call) rather than a caller (calls on call results only). */
  target: boolean;
  count: number;
  /** The first one, e.g. `CacheBuilder.newBuilder()` + `.recordStats` at CacheTest.java:40. */
  example: { path: string; line: number; qualifier: string | null };
}

export interface BlastRadius {
  callers: BlastCaller[];
  /**
   * Unlinked calls named like the target (first) or like the callers the walk went through: calls on
   * the result of another call, on objects of unknown type, or to library methods of the same name.
   * Where there are any, the blast radius may be incomplete.
   */
  unlinked: UnlinkedCalls[];
  /** Levels followed. */
  depth: number;
  /** The walk stopped at maxCallers before reaching `depth`. */
  truncated: boolean;
}

/**
 * Everything that calls the given symbols, directly or indirectly, up to `depth` levels: the
 * blast radius of changing them. Follows resolved calls backwards. At each level it also starts
 * from the methods the current ones override or implement, since a call through an interface or
 * base class is linked to that declaration (`list.add()` is linked to `List.add`, not to an
 * implementation). Calls the index could not link (reflection, dependency injection, receivers of
 * unknown type) are not followed.
 */
export function blastRadius(db: IndexDb, symbolIds: number[], opts: { depth?: number; maxCallers?: number } = {}): BlastRadius {
  const depth = opts.depth ?? 3;
  const maxCallers = opts.maxCallers ?? 500;
  const seen = new Set<number>(symbolIds);
  const moduleSites = new Set<string>();
  const callers: BlastCaller[] = [];
  const unlinked = new UnlinkedCounter(db);
  let frontier = symbolIds;
  for (let level = 1; level <= depth && frontier.length; level++) {
    // Callers of these are looked up now, so calls to them the index couldn't link are missing.
    for (const id of frontier) unlinked.check(id, level === 1);
    const next: number[] = [];
    for (const row of db.callers(withOverridden(db, frontier))) {
      if (!add(row, level)) continue;
      if (row.caller) next.push(row.caller.id);
      if (callers.length >= maxCallers) return { callers, depth, truncated: true, unlinked: unlinked.found };
    }
    frontier = next;
  }
  return { callers, depth, truncated: false, unlinked: unlinked.found };

  function add(row: CallerRow, level: number): boolean {
    if (row.caller) {
      if (seen.has(row.caller.id)) return false;
      seen.add(row.caller.id);
    } else {
      // Module-level code has no symbol to follow further; keep one entry per call site.
      const key = `${row.path}:${row.line}`;
      if (moduleSites.has(key)) return false;
      moduleSites.add(key);
    }
    callers.push({ caller: row.caller, path: row.path, line: row.line, level, test: isTestPath(row.path) });
    return true;
  }
}

/** Unlinked calls per symbol, for a bounded number of symbols (one query per file that can see them). */
class UnlinkedCounter {
  readonly found: UnlinkedCalls[] = [];
  private readonly db: IndexDb;
  private readonly limit: number;
  private readonly seeing = new Map<number, number[]>();
  private readonly pathOf = new Map<number, string>();
  /** Qualified names already counted: copies of a type (e.g. Guava's android and main trees) see the same files. */
  private readonly names = new Set<string>();
  private checked = 0;

  constructor(db: IndexDb, limit = 200) {
    this.db = db;
    this.limit = limit;
    for (const [path, id] of db.fileIds()) this.pathOf.set(id, path);
  }

  /** Counts the unlinked calls named like a symbol. Test code is skipped: tests are rarely called. */
  check(id: number, target: boolean): void {
    if (this.checked >= this.limit) return;
    const ref = this.db.symbolRef(id);
    if (!ref || this.names.has(ref.qualified_name) || isTestPath(this.pathOf.get(ref.file_id) ?? '')) return;
    this.names.add(ref.qualified_name);
    this.checked++;
    let files = this.seeing.get(ref.file_id);
    if (!files) this.seeing.set(ref.file_id, (files = this.db.filesSeeing([ref.file_id])));
    const { count, first } = this.db.unlinkedCalls(ref.name, files, !target);
    if (count && first) this.found.push({ symbol: { id, qualified_name: ref.qualified_name, name: ref.name }, target, count, example: first });
  }
}

/** The symbols plus the methods they override or implement, in their base types at any distance. */
function withOverridden(db: IndexDb, ids: number[]): number[] {
  const out = new Set(ids);
  for (const id of ids) {
    const method = db.symbolRef(id);
    if (!method || method.kind !== 'method' || method.parent_id === null) continue;
    const visited = new Set<number>();
    let types = db.typeParts(method.parent_id);
    while (types.length) {
      const bases = db.baseTypes(types).filter((b) => !visited.has(b));
      for (const b of bases) {
        visited.add(b);
        for (const m of db.members(b)) {
          if (m.kind === 'method' && m.name === method.name) out.add(m.id);
        }
      }
      types = bases.flatMap((b) => db.typeParts(b));
    }
  }
  return [...out];
}

/**
 * Whether a file holds tests, by the usual conventions: a `test`, `tests`, `__tests__`, `spec` or
 * `specs` folder, a test project folder (`App.Tests`, `App.UnitTests`, `guava-tests`), or a test file name
 * (`FooTest.java`, `FooTests.cs`, `test_foo.py`, `foo_test.py`, `foo.test.ts`, `foo.spec.tsx`).
 */
export function isTestPath(path: string): boolean {
  const parts = path.replaceAll('\\', '/').split('/');
  const file = parts.at(-1) ?? '';
  const dirs = parts.slice(0, -1);
  if (dirs.some((d) => /^(tests?|__tests__|specs?)$/i.test(d) || /[._-](Unit|Integration|Functional)?Tests?$/i.test(d))) return true;
  switch (languageForPath(file)) {
    case 'java':
      return /^Test[A-Z]\w*\.java$|\w(Test|Tests|TestCase|IT)\.java$/.test(file);
    case 'csharp':
      return /\wTests?\.cs$/.test(file);
    case 'python':
      return /^test_\w*\.py$|_test\.py$|^conftest\.py$/.test(file);
    default:
      return /\.(test|spec)\.[cm]?[jt]sx?$/.test(file);
  }
}
