import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { IndexDb, IndexNotReadyError, pageRank, type ImportRow, type SymbolRow } from '@refdex/core';

const MAX_SEARCH_RESULTS = 50;
const DEFAULT_MAX_LINES = 250;
const MAX_REFERENCES = 80;
const MAX_LINE_LENGTH = 160;
const MAX_CALLEES = 40;
const MAX_EXTERNAL_CALLEES = 15;
const DEFAULT_MAP_TOKENS = 1000;
/** Rough characters per token for the repo map's budget. */
const CHARS_PER_TOKEN = 4;
const TYPE_KINDS = new Set(['class', 'interface', 'enum', 'type_alias']);

/**
 * The logic behind RefDex's MCP tools, over a read-only connection to the index. Every answer is
 * compact plain text: the point of RefDex is to spend fewer tokens than reading files. Paths are
 * shown relative to the workspace root, with line ranges, and every answer says how fresh the
 * index is. Source code is always read from disk, never from the index.
 */
export class RefdexTools {
  private db: IndexDb | undefined;
  /** PageRank scores, recomputed when the index changes. */
  private ranks: { key: string; scores: Map<number, number>; used: Set<number> } | undefined;
  readonly root: string;
  private readonly dbPath: string;

  constructor(root: string, dbPath: string) {
    this.root = root;
    this.dbPath = dbPath;
  }

  /** Opens the index lazily, so the server can start before the first index is built. */
  private open(): IndexDb {
    if (this.db) return this.db;
    if (!existsSync(this.dbPath)) throw new IndexNotReadyError('the index has not been built yet');
    this.db = new IndexDb(this.dbPath, { readOnly: true });
    return this.db;
  }

  close(): void {
    this.db?.close();
    this.db = undefined;
  }

  async searchSymbols(args: { query: string; kind?: string; language?: string; limit?: number }): Promise<string> {
    return this.guard(async (db) => {
      const limit = Math.min(args.limit ?? 20, MAX_SEARCH_RESULTS);
      const hits = db.search(args.query, limit, { kind: args.kind, language: args.language });
      if (!hits.length) {
        return `${this.freshness(db)}\nNo symbols match "${args.query}". Try a shorter prefix or a different name.`;
      }
      const lines = [`${this.freshness(db)}\n${hits.length} match${hits.length === 1 ? '' : 'es'} for "${args.query}":`];
      for (const h of hits) lines.push(this.symbolLine(h));
      if (hits.length === limit) lines.push(`(first ${limit}; narrow the query or raise limit for more)`);
      return lines.join('\n');
    });
  }

  async getFileOutline(args: { path: string }): Promise<string> {
    return this.guard(async (db) => {
      const path = this.resolvePath(args.path);
      const info = db.fileInfo(path);
      if (!info) {
        return `${this.freshness(db)}\n${this.rel(path)} is not in the index (not a Python, TypeScript, Java or C# file, excluded, or new). Use search_symbols to find code by name.`;
      }
      const symbols = db.fileSymbols(path);
      const imports = db.fileImports(path);
      const out = [`${this.rel(path)} (${info.language}, indexed ${ago(info.indexed_at)})${await this.staleNote(path, info.hash)}`];
      if (imports.length) {
        out.push('imports:');
        for (const i of imports) out.push(`  ${i.line}: ${this.importText(i)}`);
      }
      if (!symbols.length) {
        out.push('no symbols');
        return out.join('\n');
      }
      const prefix = qualifiedPrefix(symbols);
      out.push(prefix ? `symbols (qualified names start with "${prefix}"):` : 'symbols:');
      const depth = new Map<number, number>();
      for (const s of symbols) {
        const d = s.parent_id !== null ? (depth.get(s.parent_id) ?? 0) + 1 : 0;
        depth.set(s.id, d);
        const range = s.start_line === s.end_line ? `${s.start_line}` : `${s.start_line}-${s.end_line}`;
        out.push(`${'  '.repeat(d + 1)}${range} ${withKind(s)}${docNote(s.doc)}`);
      }
      return out.join('\n');
    });
  }

  async getSymbolSource(args: { qualified_name: string; max_lines?: number; with_callees?: boolean }): Promise<string> {
    return this.guard(async (db) => {
      const found = this.findSymbols(db, args.qualified_name);
      if (typeof found === 'string') return found;
      const maxLines = args.max_lines ?? DEFAULT_MAX_LINES;
      const blocks: string[] = [];
      // Overloads and the parts of a partial type share a qualified name: show each.
      const rows = found.flatMap((s) => {
        const parts = db.symbolParts(s.id);
        return parts.length > 1 ? parts.map((p) => ({ ...s, path: p.path, start_line: p.start_line, end_line: p.end_line })) : [s];
      });
      for (const s of dedupe(rows)) {
        const info = db.fileInfo(s.path);
        const source = await readFile(s.path, 'utf8').catch(() => undefined);
        const header = `// ${this.rel(s.path)}:${s.start_line}-${s.end_line}  ${s.kind} ${s.qualified_name}`;
        if (source === undefined) {
          blocks.push(`${header}\n(file no longer exists; the index will drop it shortly)`);
          continue;
        }
        const stale = info && sha1(source) !== info.hash ? '\n// note: file changed since it was indexed; lines may have shifted' : '';
        const lines = source.split(/\r?\n/).slice(s.start_line - 1, s.end_line);
        if (lines.length <= maxLines) {
          blocks.push(`${header}${stale}\n${lines.join('\n')}`);
          continue;
        }
        // Too long: for a type, the declaration and its members' signatures; otherwise the start.
        const members = db.members(s.id);
        if (members.length) {
          const memberLines = members.map((m) => `  ${this.rel(m.path)}:${m.start_line}-${m.end_line} ${m.kind} ${m.name}: ${m.signature}`);
          blocks.push(
            `${header}${stale}\n// ${lines.length} lines, over max_lines=${maxLines}. Declaration and members instead; ` +
              `call get_symbol_source on a member (qualified name "${s.qualified_name}.<name>") or raise max_lines.\n` +
              `${s.signature}\n${memberLines.join('\n')}`,
          );
        } else {
          blocks.push(`${header}${stale}\n${lines.slice(0, maxLines).join('\n')}\n// … ${lines.length - maxLines} more lines (raise max_lines to see them)`);
        }
      }
      if (args.with_callees) blocks.push(this.calleesText(db, found));
      return `${this.freshness(db)}\n${blocks.join('\n\n')}`;
    });
  }

  /** Signatures of what the symbols call, so the model needn't fetch each callee. */
  private calleesText(db: IndexDb, symbols: SymbolRow[]): string {
    const { resolved, unresolved } = db.callees(symbols.map((s) => s.id));
    const lines = [resolved.length ? `// calls ${resolved.length} indexed symbol${resolved.length === 1 ? '' : 's'}:` : '// calls no indexed symbols'];
    for (const c of resolved.slice(0, MAX_CALLEES)) lines.push(`${c.kind} ${c.qualified_name}  ${this.rel(c.path)}:${c.start_line}-${c.end_line}\n  ${c.signature}`);
    if (resolved.length > MAX_CALLEES) lines.push(`… ${resolved.length - MAX_CALLEES} more`);
    if (unresolved.length) {
      const shown = unresolved.slice(0, MAX_EXTERNAL_CALLEES).join(', ');
      lines.push(`// also calls (library, dynamic or ambiguous): ${shown}${unresolved.length > MAX_EXTERNAL_CALLEES ? ', …' : ''}`);
    }
    return lines.join('\n');
  }

  async findReferences(args: { qualified_name: string }): Promise<string> {
    return this.guard(async (db) => {
      const found = this.findSymbols(db, args.qualified_name);
      if (typeof found === 'string') return found;
      const target = found[0];
      // Constructors are used through their class (`new C()`, `C()`).
      const constructor = target.kind === 'method' && /constructor/.test(target.native_kind);
      const owner = constructor && target.parent_id !== null ? target.parent_id : undefined;
      const name = constructor ? (target.qualified_name.split(/[.:]/).at(-2) ?? target.name) : target.name;
      const ids = owner !== undefined ? [owner] : found.map((s) => s.id);

      // Which files can see the symbol: its own files, files importing them (also through
      // barrel re-exports), and for Java/C# the files sharing or importing its namespace.
      const definitionFiles = new Map<string, { start: number; end: number }[]>();
      for (const s of found) {
        for (const p of db.symbolParts(s.id).length ? db.symbolParts(s.id) : [{ path: s.path, start_line: s.start_line, end_line: s.end_line }]) {
          definitionFiles.set(p.path, [...(definitionFiles.get(p.path) ?? []), { start: p.start_line, end: p.end_line }]);
        }
      }
      const fileIds = [...definitionFiles.keys()].map((p) => db.fileInfo(p)?.id).filter((id): id is number => id !== undefined);
      const candidates = new Set<string>([...definitionFiles.keys(), ...db.importingFiles(db.exportingFiles(fileIds))]);
      if ((target.language === 'java' || target.language === 'csharp') && target.namespace) {
        for (const f of db.namespaceFiles(target.namespace, target.language)) candidates.add(f);
      }

      const sources = new Map<string, string[] | undefined>();
      const linesOf = async (path: string) => {
        if (!sources.has(path)) sources.set(path, (await readFile(path, 'utf8').catch(() => undefined))?.split(/\r?\n/));
        return sources.get(path);
      };

      // 1. Uses the index linked to this declaration: exact.
      const uses = db.uses(ids);
      const linked = new Set<string>();
      const useLines: string[] = [];
      for (const u of uses) {
        const key = `${u.path}:${u.line}`;
        if (linked.has(key)) continue;
        linked.add(key);
        candidates.add(u.path);
        const code = (await linesOf(u.path))?.[u.line - 1]?.trim() ?? '';
        const via = u.from_qualified_name ? ` in ${u.from_qualified_name}` : '';
        if (useLines.length < MAX_REFERENCES) useLines.push(`${this.rel(u.path)}:${u.line}: ${clip(code)}  [${u.type}${via}]`);
      }

      // 2. Other lines naming it in files that can see it: imports, and uses the index couldn't
      //    link (values passed around, receivers of unknown type). The declaration line is skipped.
      const pattern = new RegExp(`(?<![\\w$])${escapeRegExp(name)}(?![\\w$])`);
      const other: string[] = [];
      let otherTotal = 0;
      for (const path of [...candidates].sort()) {
        const lines = await linesOf(path);
        if (!lines) continue;
        const own = (definitionFiles.get(path) ?? []).map((r) => ({ ...r, skipped: false }));
        lines.forEach((line, i) => {
          const n = i + 1;
          if (!pattern.test(line) || linked.has(`${path}:${n}`)) return;
          const range = own.find((r) => !r.skipped && n >= r.start && n <= r.end);
          if (range) {
            range.skipped = true;
            return;
          }
          otherTotal++;
          if (useLines.length + other.length < MAX_REFERENCES) other.push(`${this.rel(path)}:${n}: ${clip(line.trim())}`);
        });
      }

      const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
      const out = [
        `${this.freshness(db)}\nReferences to ${target.kind} ${target.qualified_name} (defined at ${this.rel(target.path)}:${target.start_line})` +
          (found.length > 1 ? `; ${found.length} declarations share this name, e.g. overloads` : '') + ':',
      ];
      out.push(linked.size
        ? `${plural(linked.size, 'use')} linked by the index (calls, inheritance, type references):`
        : 'No uses linked by the index.');
      out.push(...useLines);
      if (linked.size > useLines.length) out.push(`… ${linked.size - useLines.length} more`);
      if (otherTotal) {
        out.push(`${plural(otherTotal, 'other line')} naming "${name}" in files that import or share its module/namespace (imports, values passed around, calls on objects of unknown type; matched by name, so review):`);
        out.push(...other);
        if (otherTotal > other.length) out.push(`… ${otherTotal - other.length} more`);
      } else if (!linked.size) {
        out.push('No other lines name it in the files that can see it.');
      }
      return out.join('\n');
    });
  }

  async getRepoMap(args: { token_budget?: number; path?: string }): Promise<string> {
    return this.guard(async (db) => {
      const budget = (args.token_budget ?? DEFAULT_MAP_TOKENS) * CHARS_PER_TOKEN;
      const { scores, used } = this.rankScores(db);
      // Fields and properties only when something uses them; they'd crowd out the API otherwise.
      const all = db.allSymbols().filter((s) =>
        s.kind !== 'namespace' && s.kind !== 'module' && ((s.kind !== 'field' && s.kind !== 'property') || used.has(s.id)));
      const byId = new Map(all.map((s) => [s.id, s]));
      const under = args.path ? this.resolvePath(args.path) : undefined;
      const inScope = (s: SymbolRow) => !under || s.path === under || s.path.startsWith(under + sep);
      const ranked = all.filter(inScope).sort((a, b) =>
        (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0)
        || kindOrder(a) - kindOrder(b)
        || b.exported - a.exported
        || a.qualified_name.localeCompare(b.qualified_name));
      if (!ranked.length) {
        return `${this.freshness(db)}\nNo symbols${under ? ` under ${this.rel(under)}` : ''}.`;
      }

      // Take symbols in rank order, each with the types around it, until the budget is spent.
      const selected = new Set<number>();
      const files = new Map<string, number>(); // path -> best rank, for ordering
      let chars = 0;
      for (const s of ranked) {
        const chain: SymbolRow[] = [];
        for (let c: SymbolRow | undefined = s; c && !selected.has(c.id); c = c.parent_id !== null ? byId.get(c.parent_id) : undefined) chain.push(c);
        const cost = chain.reduce((n, c) => n + mapLine(c, 0).length + 8, 0) + (files.has(s.path) ? 0 : this.rel(s.path).length + 1);
        if (chars + cost > budget && selected.size) break;
        chars += cost;
        for (const c of chain) selected.add(c.id);
        if (!files.has(s.path)) files.set(s.path, scores.get(s.id) ?? 0);
      }

      const out: string[] = [];
      const depth = (s: SymbolRow): number => (s.parent_id !== null && selected.has(s.parent_id) ? depth(byId.get(s.parent_id)!) + 1 : 0);
      const perFile = new Map<string, SymbolRow[]>();
      for (const id of selected) {
        const s = byId.get(id)!;
        perFile.set(s.path, [...(perFile.get(s.path) ?? []), s]);
      }
      for (const [path] of [...files].sort((a, b) => b[1] - a[1])) {
        out.push(this.rel(path));
        for (const s of perFile.get(path)!.sort((a, b) => a.start_line - b.start_line || a.id - b.id)) out.push(mapLine(s, depth(s) + 1));
      }
      const { edges, resolvedEdges } = db.stats();
      const header =
        `${this.freshness(db)}\nRepo map${under ? ` of ${this.rel(under)}` : ''}: ${selected.size} of ${ranked.length} symbols in ${files.size} files, ` +
        `the most used first (PageRank over ${resolvedEdges.toLocaleString()} linked calls, base types and type references; ~${Math.ceil(chars / CHARS_PER_TOKEN)} tokens). ` +
        'Files in rank order; lines are "start-end signature". Use get_symbol_source for code.' +
        (edges && !resolvedEdges ? '\nNo uses could be linked yet, so this is not ranked.' : '');
      return `${header}\n${out.join('\n')}`;
    });
  }

  /** PageRank scores and the symbols anything uses, cached until the index changes. */
  private rankScores(db: IndexDb): { scores: Map<number, number>; used: Set<number> } {
    const { indexedAt, files, symbols, resolvedEdges } = db.stats();
    const key = `${indexedAt}|${files}|${symbols}|${resolvedEdges}`;
    if (this.ranks?.key !== key) {
      const graph = db.graph();
      this.ranks = { key, scores: pageRank(db.allSymbols().map((s) => s.id), graph), used: new Set(graph.map((e) => e.to)) };
    }
    return this.ranks;
  }

  // ---- helpers ----

  /** Exact qualified name first, then a unique match on the name or a qualified-name suffix. */
  private findSymbols(db: IndexDb, query: string): SymbolRow[] | string {
    const exact = db.symbolsByQualifiedName(query);
    if (exact.length) return exact;
    const byName = db.symbolsByName(query, 20);
    const qualifiedNames = new Set(byName.map((s) => s.qualified_name));
    if (qualifiedNames.size === 1) return byName;
    if (!byName.length) {
      return `${this.freshness(db)}\nNo symbol "${query}". Use search_symbols to find the qualified name.`;
    }
    return `${this.freshness(db)}\n"${query}" is ambiguous; pass one of these qualified names:\n${byName.map((s) => this.symbolLine(s)).join('\n')}`;
  }

  private symbolLine(s: SymbolRow): string {
    const range = s.start_line === s.end_line ? `${s.start_line}` : `${s.start_line}-${s.end_line}`;
    return `${s.kind} ${s.qualified_name}  ${this.rel(s.path)}:${range}\n  ${s.signature}${docNote(s.doc)}`;
  }

  private importText(i: ImportRow): string {
    const names = i.names.map((n) => (n.alias ? `${n.name} as ${n.alias}` : n.name)).join(', ');
    const target = i.resolved_path ? this.rel(i.resolved_path) : i.resolved_namespace ? `namespace ${i.resolved_namespace}` : 'external';
    return `${i.kind === 're-export' ? 're-export ' : ''}${i.is_global ? 'global ' : ''}${i.spec}${names ? ` [${names}]` : ''}${i.alias ? ` as ${i.alias}` : ''} -> ${target}`;
  }

  private freshness(db: IndexDb): string {
    const { indexedAt, files } = db.stats();
    return `[RefDex index: ${files.toLocaleString()} files, updated ${indexedAt ? ago(indexedAt) : 'never'}]`;
  }

  private async staleNote(path: string, hash: string): Promise<string> {
    const source = await readFile(path, 'utf8').catch(() => undefined);
    return source !== undefined && sha1(source) !== hash ? ' - changed since indexed, lines may have shifted' : '';
  }

  private resolvePath(path: string): string {
    const abs = isAbsolute(path) ? resolve(path) : resolve(this.root, path);
    if (abs !== this.root && !abs.startsWith(this.root + sep)) throw new UserError(`${path} is outside the workspace ${this.root}`);
    return abs;
  }

  private rel(path: string): string {
    return path.startsWith(this.root + sep) ? relative(this.root, path).split(sep).join('/') : path;
  }

  /** Turns "no index yet" and bad input into answers the model can act on. */
  private async guard(fn: (db: IndexDb) => Promise<string>): Promise<string> {
    try {
      return await fn(this.open());
    } catch (e) {
      if (e instanceof IndexNotReadyError) {
        this.close();
        return `RefDex: ${e.message}. Build it with "Generate Index" in the RefDex VS Code panel or \`refdex index --root ${this.root}\`, then retry. Until then, read files directly.`;
      }
      if (e instanceof UserError) return e.message;
      throw e;
    }
  }
}

class UserError extends Error {}

function ago(iso: string): string {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

/** The signature, prefixed with the kind unless the signature already says it ("class Foo"). */
function withKind(s: SymbolRow): string {
  const keyword = { class: /\b(class|record|struct)\b/, interface: /\binterface\b/, enum: /\benum\b/, type_alias: /\b(type|delegate)\b/, namespace: /\b(namespace|package)\b/, function: /\b(function|def)\b/, method: /\bdef\b/ }[s.kind as string];
  return keyword?.test(s.signature) ? s.signature : `${s.kind} ${s.signature}`;
}

/** Tie-break for equally ranked symbols: types, then functions and methods, then the rest. */
function kindOrder(s: SymbolRow): number {
  return TYPE_KINDS.has(s.kind) ? 0 : s.kind === 'function' || s.kind === 'method' ? 1 : 2;
}

function mapLine(s: SymbolRow, depth: number): string {
  const range = s.start_line === s.end_line ? `${s.start_line}` : `${s.start_line}-${s.end_line}`;
  return `${'  '.repeat(depth)}${range} ${withKind(s)}`;
}

/** First sentence of a doc comment, as a short trailing note. */
function docNote(doc: string | null): string {
  if (!doc) return '';
  const first = doc.split(/(?<=[.!?])\s/)[0];
  return `  // ${clip(first, 100)}`;
}

/** The shared qualified-name prefix of a file's top-level symbols, e.g. `src/orders:` or `com.acme.model.`. */
function qualifiedPrefix(symbols: SymbolRow[]): string {
  const top = symbols.find((s) => s.parent_id === null && s.kind !== 'namespace');
  if (!top || top.qualified_name === top.name) return '';
  return top.qualified_name.slice(0, top.qualified_name.length - top.name.length);
}

function dedupe(rows: SymbolRow[]): SymbolRow[] {
  const seen = new Set<string>();
  return rows.filter((r) => {
    const key = `${r.path}:${r.start_line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function clip(text: string, max = MAX_LINE_LENGTH): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function sha1(text: string): string {
  return createHash('sha1').update(text).digest('hex');
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
