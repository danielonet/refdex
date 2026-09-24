import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { IndexDb, IndexNotReadyError, type ImportRow, type SymbolRow } from '@refdex/core';

const MAX_SEARCH_RESULTS = 50;
const DEFAULT_MAX_LINES = 250;
const MAX_REFERENCES = 80;
const MAX_LINE_LENGTH = 160;

/**
 * The logic behind RefDex's MCP tools, over a read-only connection to the index. Every answer is
 * compact plain text: the point of RefDex is to spend fewer tokens than reading files. Paths are
 * shown relative to the workspace root, with line ranges, and every answer says how fresh the
 * index is. Source code is always read from disk, never from the index.
 */
export class RefdexTools {
  private db: IndexDb | undefined;
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

  async getSymbolSource(args: { qualified_name: string; max_lines?: number }): Promise<string> {
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
      return `${this.freshness(db)}\n${blocks.join('\n\n')}`;
    });
  }

  async findReferences(args: { qualified_name: string }): Promise<string> {
    return this.guard(async (db) => {
      const found = this.findSymbols(db, args.qualified_name);
      if (typeof found === 'string') return found;
      const target = found[0];
      // Constructors are referenced by their class name.
      const name = target.kind === 'method' && /constructor/.test(target.native_kind) ? (target.qualified_name.split(/[.:]/).at(-2) ?? target.name) : target.name;

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

      const pattern = new RegExp(`(?<![\\w$])${escapeRegExp(name)}(?![\\w$])`);
      const matches: string[] = [];
      let total = 0;
      let files = 0;
      for (const path of [...candidates].sort()) {
        const source = await readFile(path, 'utf8').catch(() => undefined);
        if (source === undefined) continue;
        // Skip the declaration line itself (the first mention inside each definition range),
        // but not later uses inside it, such as recursion.
        const own = (definitionFiles.get(path) ?? []).map((r) => ({ ...r, skipped: false }));
        let inFile = 0;
        source.split(/\r?\n/).forEach((line, i) => {
          const n = i + 1;
          if (!pattern.test(line)) return;
          const range = own.find((r) => !r.skipped && n >= r.start && n <= r.end);
          if (range) {
            range.skipped = true;
            return;
          }
          total++;
          inFile++;
          if (matches.length < MAX_REFERENCES) matches.push(`${this.rel(path)}:${n}: ${clip(line.trim())}`);
        });
        if (inFile) files++;
      }
      const header =
        `${this.freshness(db)}\nReferences to ${target.kind} ${target.qualified_name} (defined at ${this.rel(target.path)}:${target.start_line}): ` +
        `${total} line${total === 1 ? '' : 's'} using "${name}" in ${files} of ${candidates.size} file${candidates.size === 1 ? '' : 's'} that import or share its module/namespace.` +
        (found.length > 1 ? ` (${found.length} declarations share this name, e.g. overloads.)` : '') +
        '\nMatches are by name, so an unrelated symbol with the same name can appear.';
      const more = total > matches.length ? `\n… ${total - matches.length} more` : '';
      return matches.length ? `${header}\n${matches.join('\n')}${more}` : `${header}\nNo uses found outside the definition.`;
    });
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
