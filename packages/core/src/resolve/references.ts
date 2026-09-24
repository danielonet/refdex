import type { EdgeRow, IndexDb, SymbolRef } from '../db.ts';
import type { LanguageId } from '../languages.ts';
import type { EdgeType, SymbolKind } from '../model.ts';

const TYPES = new Set<SymbolKind>(['class', 'interface', 'enum', 'type_alias']);
/** What a call can land on: functions and methods, classes (Python `Order()`), properties holding functions. */
const CALLABLE = new Set<SymbolKind>(['function', 'method', 'class', 'property', 'field']);
const FIELDS = new Set<SymbolKind>(['property', 'field']);
const SELF = new Set(['this', 'self', 'cls']);
const BASE = new Set(['super', 'base']);
const NAMESPACE_LANGUAGES = new Set<LanguageId>(['java', 'csharp']);
const MAX_BASE_DEPTH = 6;
/** Names declared more often than this are looked up per parent/file/namespace instead of loaded whole. */
const MAX_LOADED_NAME = 200;
/** With this many edges to resolve (a first index), every symbol is loaded up front. */
const PRELOAD_EDGES = 20_000;
/**
 * Standard collection, string and promise methods. `obj.clear()` on an object of unknown type is
 * far more likely a Map than the one indexed class that happens to declare `clear`.
 */
const BUILTIN_MEMBERS = new Set([
  'get', 'set', 'has', 'add', 'delete', 'clear', 'push', 'pop', 'shift', 'unshift', 'map', 'filter', 'reduce',
  'find', 'findIndex', 'forEach', 'some', 'every', 'includes', 'indexOf', 'join', 'split', 'slice', 'splice',
  'concat', 'sort', 'reverse', 'keys', 'values', 'entries', 'items', 'append', 'extend', 'remove', 'insert', 'copy',
  'toString', 'valueOf', 'equals', 'hashCode', 'then', 'catch', 'finally', 'replace', 'trim', 'format',
  'startsWith', 'endsWith', 'apply', 'call', 'bind', 'lower', 'upper', 'strip', 'size', 'length', 'stream',
  'Add', 'Remove', 'Clear', 'Contains', 'ContainsKey', 'ToString', 'Equals', 'GetHashCode', 'ToList', 'ToArray',
  'Select', 'Where', 'Any', 'All', 'First', 'FirstOrDefault', 'Count',
]);

/** The symbols sharing one name, grouped the ways lookups need them. */
interface Named {
  all: SymbolRef[];
  byParent: Map<number, SymbolRef[]>;
  byFile: Map<number, SymbolRef[]>;
  byNamespace: Map<string, SymbolRef[]>;
}

const EMPTY: Named = { all: [], byParent: new Map(), byFile: new Map(), byNamespace: new Map() };

/** What one file can see without a qualifier, built from its imports. */
interface FileScope {
  fileId: number;
  language: LanguageId;
  /** Local name -> the symbol it imports (TS and Python named imports, Java single-type imports, C# aliases). */
  names: Map<string, SymbolRef>;
  /** Local name or dotted path -> the module file it stands for (TS `* as ns`, Python module imports). */
  modules: Map<string, { id: number; path: string }>;
  /** Types whose members are in scope unqualified (Java `import static`, C# `using static`). */
  staticTypes: number[];
  /** Python `from m import *`. */
  wildcardFiles: Set<number>;
  /** Files whose members count as visible for `obj.member` with an unknown receiver. */
  files: Set<number>;
  /** Java packages and C# namespaces whose types are visible. */
  namespaces: Set<string>;
}

/**
 * Links edges (uses of names) to the symbols they refer to. Resolution is by scope, not by type
 * inference: enclosing declarations, then imports, then the package/namespace. `obj.m()` with an
 * unknown receiver resolves only when exactly one visible type declares `m`. Anything ambiguous
 * or outside the index stays unresolved; precision matters more than recall here, since
 * find_references and the repo map are built on these edges.
 */
export class ReferenceResolver {
  private readonly db: IndexDb;
  private readonly refs = new Map<number, SymbolRef | undefined>();
  /** Loaded names; undefined for a name too common to load (see MAX_LOADED_NAME). */
  private readonly named = new Map<string, Named | undefined>();
  private readonly lookups = new Map<string, SymbolRef[]>();
  private preloaded = false;
  private files: Map<number, { path: string; language: LanguageId }> | undefined;
  private readonly exports = new Map<string, SymbolRef | undefined>();
  private readonly scopes = new Map<number, FileScope>();
  private readonly parts = new Map<number, number[]>();
  private bases = new Map<number, number[]>();

  constructor(db: IndexDb) {
    this.db = db;
  }

  /** Resolves and stores the edges from `IndexDb.edgesToResolve`. */
  resolveAll(rows: EdgeRow[]): { resolved: number; unresolved: number } {
    if (rows.length >= PRELOAD_EDGES) this.preload();
    this.files = this.db.fileLanguages();
    let resolved = 0;
    // Base types first: member lookups (`this.m()` defined in a base class) follow them.
    const inheritance = (r: EdgeRow) => r.type === 'extends' || r.type === 'implements';
    const bases = rows.filter(inheritance);
    let i = 0;
    for (const row of [...bases, ...rows.filter((r) => !inheritance(r))]) {
      // Base types are now linked: forget lookups made while they weren't.
      if (i++ === bases.length) this.bases = new Map();
      const target = this.resolve(row);
      const type = this.edgeType(row, target);
      if (target !== (row.to_symbol_id ?? undefined) || type !== row.type) this.db.setEdgeTarget(row.id, target ?? null, type);
      if (target !== undefined) resolved++;
    }
    return { resolved, unresolved: rows.length - resolved };
  }

  private resolve(row: EdgeRow): number | undefined {
    const file = this.files!.get(row.file_id)!;
    const scope = this.scope(row.file_id, file.path, file.language);
    const kinds = row.type !== 'calls' || row.instantiates ? TYPES : CALLABLE;
    const from = row.from_symbol_id !== null ? this.ref(row.from_symbol_id) : undefined;
    // Python's `super().m()`.
    const q = row.qualifier === 'super()' ? 'super' : row.qualifier;
    if (!q) return this.resolveName(row.name, kinds, scope, from);

    if (SELF.has(q) || BASE.has(q)) {
      const type = this.enclosingType(from);
      if (type === undefined) return undefined;
      if (SELF.has(q)) return this.member(type, row.name, kinds);
      for (const base of this.baseTypes(type)) {
        const found = this.member(base, row.name, kinds);
        if (found !== undefined) return found;
      }
      return undefined;
    }
    const module = scope.modules.get(q);
    if (module) return this.moduleMember(module, row.name, kinds, scope.language);
    const type = this.resolveTypePath(q, scope, from);
    if (type !== undefined) return this.member(type, row.name, kinds);
    // Call results and other expressions (`f().m()`, `a[0].m()`): nothing to go on.
    if (!/^[\w$]+(\.[\w$]+)*$/.test(q)) return undefined;
    // A capitalized name that isn't an indexed type is an external one (`String.join`, `Math.max`,
    // `vscode.Uri.file`), unless it is a field or property of the enclosing type (C# `Items.Add()`).
    const last = q.slice(q.lastIndexOf('.') + 1);
    if (/^[A-Z]/.test(last) && !this.isField(last, from)) return undefined;
    if (BUILTIN_MEMBERS.has(row.name)) return undefined;
    // An object of unknown type (`obj.m()`, `this.repo.m()`, `ctx.tools.m()`): a member with this
    // name in exactly one visible type.
    const visible = new Set<SymbolRef>();
    for (const f of scope.files) for (const c of this.inFile(row.name, f)) visible.add(c);
    if (NAMESPACE_LANGUAGES.has(scope.language)) {
      for (const ns of scope.namespaces) for (const c of this.inNamespace(row.name, ns)) if (c.language === scope.language) visible.add(c);
    }
    return pick([...visible].filter((c) => kinds.has(c.kind) && c.parent_id !== null && TYPES.has(this.ref(c.parent_id)?.kind as SymbolKind)));
  }

  /** An unqualified name: enclosing declarations, imports, then the package/namespace. */
  private resolveName(name: string, kinds: Set<SymbolKind>, scope: FileScope, from: SymbolRef | undefined): number | undefined {
    const namespaced = NAMESPACE_LANGUAGES.has(scope.language);
    const inFile = (fileId: number) => this.inFile(name, fileId).filter((c) => kinds.has(c.kind));
    if (namespaced) {
      // Members of the enclosing types (implicit `this`), innermost first, then their nested types.
      for (let t = this.enclosingType(from); t !== undefined; t = this.enclosingType(this.ref(this.ref(t)?.parent_id ?? -1))) {
        const found = this.member(t, name, kinds);
        if (found !== undefined) return found;
      }
    } else {
      // Lexical scope: declarations at the top of the file or inside an enclosing function.
      const enclosing = new Set<number | null>([null]);
      for (let s = from; s; s = s.parent_id !== null ? this.ref(s.parent_id) : undefined) {
        if (!TYPES.has(s.kind)) enclosing.add(s.id);
      }
      const local = pick(inFile(scope.fileId).filter((c) => enclosing.has(c.parent_id)));
      if (local !== undefined) return local;
    }
    const imported = scope.names.get(name);
    if (imported && kinds.has(imported.kind)) return imported.id;
    for (const t of scope.staticTypes) {
      const found = this.member(t, name, kinds);
      if (found !== undefined) return found;
    }
    if (scope.wildcardFiles.size) {
      const found = pick([...scope.wildcardFiles].flatMap(inFile).filter((c) => c.parent_id === null));
      if (found !== undefined) return found;
    }
    if (namespaced) {
      return pick([...scope.namespaces].flatMap((ns) => this.inNamespace(name, ns))
        .filter((c) => c.language === scope.language && kinds.has(c.kind) && TYPES.has(c.kind) && this.isTopLevel(c)));
    }
    return undefined;
  }

  /** A qualifier that names a type: `Util`, `Outer.Inner`, `com.acme.Util`. */
  private resolveTypePath(path: string, scope: FileScope, from: SymbolRef | undefined): number | undefined {
    if (!/^[\w$]+(\.[\w$]+)*$/.test(path)) return undefined;
    const parts = path.split('.');
    let type = this.resolveName(parts[0], TYPES, scope, from);
    if (type === undefined && parts.length > 1 && NAMESPACE_LANGUAGES.has(scope.language)) {
      // A fully qualified name: the longest prefix that is a type.
      for (let i = parts.length; i > 1 && type === undefined; i--) {
        const qname = parts.slice(0, i).join('.');
        type = this.everywhere(parts[i - 1]).find((c) => c.language === scope.language && TYPES.has(c.kind) && c.qualified_name === qname)?.id;
        if (type !== undefined) parts.splice(0, i, parts[i - 1]);
      }
    }
    for (const part of parts.slice(1)) {
      if (type === undefined) return undefined;
      type = this.member(type, part, TYPES);
    }
    return type;
  }

  /** A member of a type or of its base types. */
  private member(typeId: number, name: string, kinds: Set<SymbolKind>, depth = 0): number | undefined {
    const parts = this.typeParts(typeId);
    const own = pick(this.inParents(name, parts).filter((c) => kinds.has(c.kind)));
    if (own !== undefined || depth >= MAX_BASE_DEPTH) return own;
    for (const base of this.baseTypes(typeId)) {
      const found = this.member(base, name, kinds, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  /** A top-level declaration of a module, following TypeScript barrel re-exports. */
  private moduleMember(module: { id: number; path: string }, name: string, kinds: Set<SymbolKind>, language: LanguageId): number | undefined {
    if (language === 'typescript' || language === 'tsx') {
      const ref = this.resolveExport(module.path, name);
      return ref && kinds.has(ref.kind) ? ref.id : undefined;
    }
    return pick(this.inFile(name, module.id).filter((c) => c.parent_id === null && kinds.has(c.kind)));
  }

  private edgeType(row: EdgeRow, target: number | undefined): EdgeType {
    if (row.type !== 'extends' && row.type !== 'implements') return row.type;
    if (target === undefined) return row.type;
    const from = row.from_symbol_id !== null ? this.ref(row.from_symbol_id) : undefined;
    return this.ref(target)?.kind === 'interface' && from?.kind !== 'interface' ? 'implements' : 'extends';
  }

  private scope(fileId: number, path: string, language: LanguageId): FileScope {
    let scope = this.scopes.get(fileId);
    if (scope) return scope;
    scope = {
      fileId, language, names: new Map(), modules: new Map(), staticTypes: [], wildcardFiles: new Set(),
      files: new Set([fileId]), namespaces: new Set(),
    };
    const pathBased = !NAMESPACE_LANGUAGES.has(language);
    for (const imp of this.db.effectiveImports(path)) {
      const file = imp.resolved_file_id !== null && imp.resolved_path ? { id: imp.resolved_file_id, path: imp.resolved_path } : undefined;
      const type = imp.resolved_symbol_id !== null ? this.ref(imp.resolved_symbol_id) : undefined;
      if (pathBased && imp.kind === 're-export') continue;
      if (file) scope.files.add(file.id);
      if (type) scope.files.add(type.file_id);
      if (imp.resolved_namespace && !pathBased && (imp.kind === 'using' || imp.kind === 'wildcard')) scope.namespaces.add(imp.resolved_namespace);
      switch (imp.kind) {
        case 'import':
          if (!pathBased) {
            if (type) scope.names.set(type.name, type);
          } else if (language === 'python') {
            if (file) scope.modules.set(imp.alias ?? imp.spec, file);
          } else if (file) {
            for (const n of imp.names) {
              const local = n.alias ?? n.name;
              if (n.name === '*') {
                if (n.alias) scope.modules.set(n.alias, file);
                continue;
              }
              const ref = this.resolveExport(file.path, n.name === 'default' ? local : n.name);
              if (ref) {
                scope.names.set(local, ref);
                scope.files.add(ref.file_id);
              }
            }
          }
          break;
        case 'from': {
          if (!file) break;
          const n = imp.names[0];
          if (!n) break;
          if (n.name === '*') {
            scope.wildcardFiles.add(file.id);
            break;
          }
          const local = n.alias ?? n.name;
          const declared = this.inFile(n.name, file.id).find((c) => c.parent_id === null);
          // `from pkg import sub` imports a submodule when pkg/__init__.py doesn't declare `sub`.
          if (declared) scope.names.set(local, declared);
          else scope.modules.set(local, file);
          break;
        }
        case 'static':
        case 'wildcard':
          // Java `import static a.Util.x` / `import a.Outer.*`, C# `using static A.Util`: members of a type.
          if (type) scope.staticTypes.push(type.id);
          break;
        case 'alias':
          if (type && imp.alias) scope.names.set(imp.alias, type);
          break;
      }
    }
    if (!pathBased) {
      for (const s of this.db.fileSymbolRefs(fileId)) {
        if (!s.namespace) continue;
        // C# code in A.B.C also sees A.B and A; a Java package sees only itself.
        const parts = s.namespace.split('.');
        for (let i = language === 'csharp' ? 1 : parts.length; i <= parts.length; i++) scope.namespaces.add(parts.slice(0, i).join('.'));
      }
    }
    this.scopes.set(fileId, scope);
    return scope;
  }

  /** The innermost class, interface or enum containing `sym` (or `sym` itself). */
  private enclosingType(sym: SymbolRef | undefined): number | undefined {
    for (let s = sym; s; s = s.parent_id !== null ? this.ref(s.parent_id) : undefined) {
      if (TYPES.has(s.kind)) return s.id;
    }
    return undefined;
  }

  private isField(name: string, from: SymbolRef | undefined): boolean {
    const type = this.enclosingType(from);
    return type !== undefined && this.member(type, name, FIELDS) !== undefined;
  }

  private isTopLevel(c: SymbolRef): boolean {
    return c.parent_id === null || this.ref(c.parent_id)?.kind === 'namespace';
  }

  private ref(id: number): SymbolRef | undefined {
    if (!this.refs.has(id)) this.refs.set(id, this.db.symbolRef(id));
    return this.refs.get(id);
  }

  private inParents(name: string, parentIds: number[]): SymbolRef[] {
    const named = this.load(name);
    if (named) return parentIds.flatMap((p) => named.byParent.get(p) ?? []);
    return this.lookup(`p\0${name}\0${parentIds.join(',')}`, () => this.db.symbolRefsIn(name, parentIds));
  }

  private inFile(name: string, fileId: number): SymbolRef[] {
    const named = this.load(name);
    if (named) return named.byFile.get(fileId) ?? [];
    return this.lookup(`f\0${name}\0${fileId}`, () => this.db.symbolRefsInFile(name, fileId));
  }

  private inNamespace(name: string, namespace: string): SymbolRef[] {
    const named = this.load(name);
    if (named) return named.byNamespace.get(namespace) ?? [];
    return this.lookup(`n\0${name}\0${namespace}`, () => this.db.symbolRefsInNamespace(name, namespace));
  }

  private everywhere(name: string): SymbolRef[] {
    return this.load(name)?.all ?? this.lookup(`a\0${name}`, () => this.db.symbolRefsNamed(name));
  }

  private lookup(key: string, query: () => SymbolRef[]): SymbolRef[] {
    let rows = this.lookups.get(key);
    if (!rows) {
      rows = query();
      for (const r of rows) this.refs.set(r.id, r);
      this.lookups.set(key, rows);
    }
    return rows;
  }

  /** Every symbol named `name`, grouped; undefined when the name is too common to load whole. */
  private load(name: string): Named | undefined {
    if (this.named.has(name)) return this.named.get(name);
    if (this.preloaded) return EMPTY;
    const named = this.db.countNamed(name) <= MAX_LOADED_NAME ? this.group(this.db.symbolRefsNamed(name)) : undefined;
    this.named.set(name, named);
    return named;
  }

  private preload(): void {
    const byName = new Map<string, SymbolRef[]>();
    for (const r of this.db.allSymbolRefs()) push(byName, r.name, r);
    for (const [name, rows] of byName) this.named.set(name, this.group(rows));
    this.preloaded = true;
  }

  private group(rows: SymbolRef[]): Named {
    const named: Named = { all: rows, byParent: new Map(), byFile: new Map(), byNamespace: new Map() };
    for (const r of rows) {
      this.refs.set(r.id, r);
      if (r.parent_id !== null) push(named.byParent, r.parent_id, r);
      push(named.byFile, r.file_id, r);
      if (r.namespace !== null) push(named.byNamespace, r.namespace, r);
    }
    return named;
  }

  /** `IndexDb.resolveExport`, cached: TypeScript barrels are looked up once per name. */
  private resolveExport(path: string, name: string): SymbolRef | undefined {
    const key = `${path}\0${name}`;
    if (!this.exports.has(key)) {
      const row = this.db.resolveExport(path, name);
      this.exports.set(key, row ? this.ref(row.id) : undefined);
    }
    return this.exports.get(key);
  }

  private typeParts(id: number): number[] {
    let parts = this.parts.get(id);
    if (!parts) this.parts.set(id, (parts = this.db.typeParts(id)));
    return parts;
  }

  private baseTypes(id: number): number[] {
    let bases = this.bases.get(id);
    if (!bases) this.bases.set(id, (bases = this.db.baseTypes(this.typeParts(id))));
    return bases;
  }
}

/** The one symbol a list stands for: overloads share a qualified name, anything else is ambiguous. */
function pick(candidates: SymbolRef[]): number | undefined {
  if (!candidates.length) return undefined;
  const first = candidates[0];
  return candidates.every((c) => c.qualified_name === first.qualified_name) ? first.id : undefined;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}
