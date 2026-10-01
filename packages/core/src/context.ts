import { isTestPath } from './blast.ts';
import type { IndexDb, SymbolRow } from './db.ts';
import type { SymbolKind } from './model.ts';

/**
 * Bounded context: given a task and a token budget, the smallest slice of the codebase the AI needs.
 * Five steps (see docs/refdex-v2-plan.md): seeds from the task, breadth-first expansion over the
 * symbol graph, a score per candidate, a detail level per symbol, and greedy packing into the budget.
 * This module decides what goes in and at which level; reading bodies from disk is the caller's job.
 */

/** How much of a symbol is shown. */
export type Level = 0 | 1 | 2 | 3 | 4;
/** 0 nothing, 1 name and location, 2 signature, 3 signature and doc comment, 4 full body. */
export const LEVEL_VALUE = [0, 0.1, 0.4, 0.6, 1.0] as const;

/** Rough characters per token, as everywhere in RefDex. */
export const CHARS_PER_TOKEN = 4;
/** Part of the budget kept free, since token counts are estimates. */
const HEADROOM = 0.1;
/** Seeds get bodies first, but together never more than this share of the budget. */
const SEED_SHARE = 0.6;
/** Candidates considered for packing, the best scored first. */
const MAX_CANDIDATES = 400;
/** Test code counts this much, unless the task is about tests. */
const TEST_WEIGHT = 0.5;
/** Doc comments are clipped to this many characters at level 3. */
export const MAX_DOC_CHARS = 400;

const KIND_WEIGHT: Partial<Record<SymbolKind, number>> = {
  class: 1, interface: 1, enum: 1, type_alias: 1,
  method: 0.9, function: 0.9,
  property: 0.5, field: 0.5,
};
const TYPE_KINDS = new Set<SymbolKind>(['class', 'interface', 'enum', 'type_alias']);

export interface ContextOptions {
  /** Token budget for the packed symbols; the caller keeps room for its own header and footer. */
  budget: number;
  /** Graph hops from the seeds. Default 2. */
  depth?: number;
  /** PageRank scores over the whole index; normalized here. */
  ranks: Map<number, number>;
  /** The task is about tests: test code counts as much as main code. */
  tests?: boolean;
}

export interface ContextEntry {
  symbol: SymbolRow;
  level: Level;
  /** Hops from the nearest seed; 0 for seeds, 1 for related seeds. */
  hops: number;
  seed: boolean;
}

export interface PackedContext {
  /** Entries at level 1 or more, grouped by file (path order) and in line order within a file. */
  entries: ContextEntry[];
  /** Estimated tokens of the entries as rendered by `entryText`. */
  tokens: number;
  /** Candidates found by the expansion, before packing. */
  candidates: number;
}

/** Words that look like identifiers but say nothing about the code. */
const STOP_WORDS = new Set(`the and for with that this from into when then than what which where while have has had
are was were will would should could can not but all any each every some more most other such only own same
too very just also about after before over under again further once here there why how both few
add adds added change changes changed make makes made use uses used using fix fixes fixed update updates
rename renames move moves remove removes delete deletes create creates new old code file files method methods
function functions class classes field fields test tests call calls called return returns value values
find show explain refactor implement support need needs want like don does done way work works
which decide decides decided built build full empty give gives given get gets set sets let lets keep keeps
directly method's class's code's main source tree repository instead without within based other`.split(/\s+/));

export interface TaskSeeds {
  /** Symbols the task names: dotted names and identifiers that look like code, matched exactly. */
  named: number[];
  /**
   * Symbols matching the task's other words by name prefix (full-text search): "evict" finds
   * `evictEntries`. Weaker evidence, so they start one hop out.
   */
  related: number[];
}

/**
 * Seed symbols for a task: dotted names (`Cache.put`, `pkg.mod.func`) and identifiers that look
 * like code (`getCacheSize`, `max_size`, `LocalCache`) by exact name, and the best full-text match
 * for each remaining word. Most specific first.
 */
export function seedsFromTask(db: IndexDb, task: string, ranks: Map<number, number>, limit = 8): TaskSeeds {
  const seeds: number[] = [];
  const add = (rows: SymbolRow[], max: number) => {
    // Several symbols can share a name (overloads, copies): prefer types, then the most used.
    const best = [...rows].sort((a, b) =>
      Number(TYPE_KINDS.has(b.kind)) - Number(TYPE_KINDS.has(a.kind))
      || (ranks.get(b.id) ?? 0) - (ranks.get(a.id) ?? 0)
      || a.id - b.id);
    for (const r of best.slice(0, max)) if (!seeds.includes(r.id)) seeds.push(r.id);
  };

  const tokens = [...new Set(task.match(/[A-Za-z_$][\w$]*(?:(?:\.|::?)[A-Za-z_$][\w$]*)*/g) ?? [])];
  const words: string[] = [];
  for (const token of tokens) {
    if (seeds.length >= limit) break;
    if (/[.:]/.test(token)) {
      const exact = db.symbolsByQualifiedName(token);
      if (exact.length) {
        add(exact, 3);
        continue;
      }
      // A qualified-name suffix: `Cache.put` for `com.google.common.cache.Cache.put`.
      const last = token.split(/[.:]+/).at(-1)!;
      const suffix = db.symbolsByName(last, 50).filter((s) => s.qualified_name === token || s.qualified_name.endsWith(`.${token}`) || s.qualified_name.endsWith(`:${token}`));
      add(suffix, 3);
    } else if (looksLikeCode(token, task)) {
      const exact = db.symbolsByName(token, 50).filter((s) => s.name === token);
      if (exact.length) add(exact, 3);
      else words.push(token);
    } else if (token.length >= 4 && !STOP_WORDS.has(token.toLowerCase())) {
      words.push(token);
    }
  }
  const named = seeds.splice(0, limit);

  // The other words, by name prefix: the best hit per word, skipping words that match too much.
  for (const word of words) {
    if (seeds.length >= limit) break;
    const hits = db.search(word, 5).filter((s) => !named.includes(s.id) && s.kind !== 'namespace' && s.kind !== 'module');
    if (hits.length && hits[0].name.toLowerCase().startsWith(word.toLowerCase())) add(hits, 1);
  }
  return { named, related: seeds.slice(0, limit) };
}

/** camelCase, PascalCase, snake_case, digits, or followed by `(` in the text. */
function looksLikeCode(token: string, text: string): boolean {
  if (token.length < 2) return false;
  if (/[a-z][A-Z]|_|\$|\d/.test(token)) return true;
  if (/^[A-Z][a-z]+$/.test(token)) return !STOP_WORDS.has(token.toLowerCase()) && token.length >= 4;
  if (/^[A-Z]{2,}$/.test(token)) return false;
  return new RegExp(`(?<![\\w$])${token.replace(/\$/g, '\\$')}\\(`).test(text);
}

/**
 * Packs the context for the given seeds: expands over the graph, scores every candidate, and
 * upgrades detail levels greedily by value per token until the budget (less headroom) is spent.
 * Deterministic: the same index, seeds and budget always give the same entries.
 */
export function packContext(db: IndexDb, seedIds: number[], opts: ContextOptions & { related?: number[] }): PackedContext {
  const depth = opts.depth ?? 2;
  const maxRank = Math.max(0, ...opts.ranks.values()) || 1;

  // 1-2. Seeds, then breadth-first over linked edges; members of types count as one hop too.
  const hops = new Map<number, number>();
  const seedRows = db.symbolsById(seedIds);
  const byId = new Map(seedRows.map((s) => [s.id, s]));
  for (const id of seedIds) if (byId.has(id)) hops.set(id, 0);
  let frontier = [...hops.keys()];
  for (let hop = 1; hop <= depth && frontier.length; hop++) {
    const next = new Set<number>();
    for (const e of db.neighbours(frontier)) {
      for (const id of [e.from, e.to]) if (!hops.has(id)) next.add(id);
    }
    for (const id of frontier) {
      const s = byId.get(id);
      if (s && TYPE_KINDS.has(s.kind)) for (const m of db.members(id)) if (!hops.has(m.id)) next.add(m.id);
    }
    if (hop === 1) for (const id of opts.related ?? []) if (!hops.has(id)) next.add(id);
    const rows = db.symbolsById([...next]);
    for (const r of rows) {
      byId.set(r.id, r);
      hops.set(r.id, hop);
    }
    frontier = rows.map((r) => r.id);
  }

  // 3. Score; code nested in a function is left out (its parent's body shows it).
  const testWeight = (s: SymbolRow) => (!opts.tests && isTestPath(s.path) ? TEST_WEIGHT : 1);
  const score = (s: SymbolRow) => 0.5 ** (hops.get(s.id) ?? depth + 1) * (0.7 + 0.3 * ((opts.ranks.get(s.id) ?? 0) / maxRank))
    * (KIND_WEIGHT[s.kind] ?? 0.3) * testWeight(s);
  const parentOf = new Map<number, SymbolRow>();
  const ensureParents = (s: SymbolRow) => {
    for (let c = s; c.parent_id !== null && !parentOf.has(c.id);) {
      const p = byId.get(c.parent_id) ?? db.symbolsById([c.parent_id])[0];
      if (!p) break;
      byId.set(p.id, p);
      parentOf.set(c.id, p);
      c = p;
    }
  };
  for (const s of [...byId.values()]) ensureParents(s);
  const nested = (s: SymbolRow) => {
    for (let p = parentOf.get(s.id); p; p = parentOf.get(p.id)) if (p.kind === 'method' || p.kind === 'function') return true;
    return false;
  };
  const ranked = [...hops.keys()].map((id) => byId.get(id)!)
    .filter((s) => s.kind !== 'namespace' && s.kind !== 'module' && !nested(s))
    .sort((a, b) => score(b) - score(a) || (hops.get(a.id)! - hops.get(b.id)!) || a.id - b.id)
    .slice(0, MAX_CANDIDATES);

  // 4. Levels and their costs. Every shown member brings its enclosing types at level 1 at least,
  //    so it can be shown under them.
  const level = new Map<number, Level>();
  const lvl = (id: number) => level.get(id) ?? 0;
  const candidates = new Set(ranked.map((s) => s.id));
  const ancestors = (s: SymbolRow) => {
    // Enclosing types (and functions); a package or namespace declaration says nothing the path doesn't.
    const out: SymbolRow[] = [];
    for (let p = parentOf.get(s.id); p && p.kind !== 'namespace' && p.kind !== 'module'; p = parentOf.get(p.id)) out.push(p);
    return out;
  };
  // A type with members shows at most its doc comment: its members are entries of their own. Bodies
  // only for the seeds and what they touch directly; further out, a signature is enough, and small
  // bodies there would otherwise win on value per token.
  const capped = new Set(ranked.filter((s) => TYPE_KINDS.has(s.kind) && db.members(s.id).length).map((s) => s.id));
  const maxLevel = (s: SymbolRow): Level => (capped.has(s.id) ? 3 : (hops.get(s.id) ?? depth + 1) >= 2 ? 3 : 4);
  const cost = (s: SymbolRow, l: Level) => tokens(levelChars(s, l));
  const value = (s: SymbolRow, l: Level) => (candidates.has(s.id) ? score(s) : 0) * LEVEL_VALUE[l];

  /** Entries shown per file, for the path line each file needs. */
  const perFile = new Map<string, number>();
  /** Extra tokens and value of raising `s` to `to`, with any enclosing types still hidden. */
  const upgrade = (s: SymbolRow, to: Level) => {
    let dc = cost(s, to) - cost(s, lvl(s.id));
    let dv = value(s, to) - value(s, lvl(s.id));
    if (lvl(s.id) === 0) {
      if (!perFile.get(s.path)) dc += tokens(s.path.length + 1);
      for (const a of ancestors(s)) {
        if (lvl(a.id) > 0) break;
        dc += cost(a, 1);
        dv += value(a, 1);
      }
    }
    return { dc, dv };
  };
  const apply = (s: SymbolRow, to: Level) => {
    if (lvl(s.id) === 0) {
      perFile.set(s.path, (perFile.get(s.path) ?? 0) + 1);
      for (const a of ancestors(s)) if (lvl(a.id) === 0) level.set(a.id, 1);
    }
    level.set(s.id, to);
  };
  const levelsAbove = (s: SymbolRow): Level[] => {
    const out: Level[] = [];
    for (let l = lvl(s.id) + 1; l <= maxLevel(s); l++) if (l !== 3 || s.doc) out.push(l as Level);
    return out;
  };

  // 5. Pack: seeds first at the highest level within their share, then the best value per token.
  const limit = Math.floor(opts.budget * (1 - HEADROOM));
  let used = 0;
  let seedUsed = 0;
  for (const s of ranked.filter((r) => hops.get(r.id) === 0)) {
    for (const to of levelsAbove(s).reverse()) {
      const { dc } = upgrade(s, to);
      if (used + dc <= limit && seedUsed + dc <= opts.budget * SEED_SHARE) {
        apply(s, to);
        used += dc;
        seedUsed += dc;
        break;
      }
    }
  }
  for (;;) {
    let best: { s: SymbolRow; to: Level; dc: number; ratio: number } | undefined;
    for (const s of ranked) {
      for (const to of levelsAbove(s)) {
        const { dc, dv } = upgrade(s, to);
        if (dv <= 0 || used + dc > limit) continue;
        const ratio = dv / Math.max(dc, 1);
        if (!best || ratio > best.ratio) best = { s, to, dc, ratio };
      }
    }
    if (!best) break;
    apply(best.s, best.to);
    used += best.dc;
  }

  const entries = [...level].filter(([, l]) => l > 0).map(([id, l]) => {
    const symbol = byId.get(id)!;
    return { symbol, level: l, hops: hops.get(id) ?? depth + 1, seed: hops.get(id) === 0 };
  }).sort((a, b) => a.symbol.path.localeCompare(b.symbol.path) || a.symbol.start_line - b.symbol.start_line || a.symbol.id - b.symbol.id);
  return { entries, tokens: used, candidates: ranked.length };
}

export function tokens(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/** Indentation and line break per rendered line, on average. */
const LINE_OVERHEAD = 8;

/** Characters an entry takes when rendered: see `entryHeader` and `entryDoc`; bodies at level 4. */
export function levelChars(s: SymbolRow, l: Level): number {
  const line = (text: string) => text.length + LINE_OVERHEAD;
  switch (l) {
    case 0: return 0;
    case 1: return line(entryHeader(s, 1));
    case 2: return line(entryHeader(s, 2));
    case 3: return line(entryHeader(s, 2)) + line(entryDoc(s));
    // The body is re-indented under its header: about the same size.
    case 4: return line(entryHeader(s, 1)) + s.chars + LINE_OVERHEAD;
  }
}

/**
 * The line shown for an entry, without indentation: lines, then the kind and name (level 1 and the
 * header above a level 4 body) or the signature (levels 2 and 3).
 */
export function entryHeader(s: SymbolRow, l: Level): string {
  const range = s.start_line === s.end_line ? `${s.start_line}` : `${s.start_line}-${s.end_line}`;
  return l === 2 || l === 3 ? `${range} ${withKind(s)}` : `${range} ${s.kind} ${s.name}`;
}

/** The doc comment line of a level 3 entry, on one line and clipped. */
export function entryDoc(s: SymbolRow): string {
  const doc = (s.doc ?? '').replace(/\s+/g, ' ').trim();
  return `// ${doc.length > MAX_DOC_CHARS ? `${doc.slice(0, MAX_DOC_CHARS)}…` : doc}`;
}

/** The signature, prefixed with the kind unless the signature already says it ("class Foo"). */
export function withKind(s: SymbolRow): string {
  const keyword = { class: /\b(class|record|struct)\b/, interface: /\binterface\b/, enum: /\benum\b/, type_alias: /\b(type|delegate)\b/, namespace: /\b(namespace|package)\b/, function: /\b(function|def)\b/, method: /\bdef\b/ }[s.kind as string];
  return keyword?.test(s.signature) ? s.signature : `${s.kind} ${s.signature}`;
}
