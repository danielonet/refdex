import type { LanguageId } from './languages.ts';

export type SymbolKind =
  | 'namespace' | 'module' | 'class' | 'interface' | 'enum' | 'type_alias'
  | 'function' | 'method' | 'property' | 'field';

export interface ExtractedSymbol {
  kind: SymbolKind;
  /** The grammar's own node type, e.g. `record_declaration`, `struct_declaration`. */
  nativeKind: string;
  name: string;
  /** Fully qualified: `pkg.mod.Class.method` (Python), `src/orders:Class.method` (TypeScript), `Ns.Class.Method` (Java, C#). */
  qualifiedName: string;
  /** Java package, C# namespace, Python module or TypeScript module path. */
  namespace: string | null;
  signature: string;
  doc: string | null;
  /** 1-based, inclusive. */
  startLine: number;
  endLine: number;
  /** Visible outside its file/module: TS `export`, Java/C# `public`, Python names without a leading underscore. */
  exported: boolean;
  /** C# `partial` type; parts in several files are merged after indexing. */
  partial: boolean;
  parent?: ExtractedSymbol;
}

/** One name brought in by an import. `name` is `*` for wildcard/namespace imports and `default` for default imports. */
export interface ImportedName {
  name: string;
  alias?: string;
}

export type ImportKind =
  | 'import'     // Python `import a.b`, TS `import ... from`, Java `import a.b.C`
  | 'from'       // Python `from a import b`
  | 're-export'  // TS `export ... from`
  | 'static'     // Java `import static`, C# `using static`
  | 'wildcard'   // Java `import a.b.*`
  | 'using'      // C# `using A.B`
  | 'alias';     // C# `using X = A.B`

export interface ImportDecl {
  kind: ImportKind;
  /** The module / namespace / type as written, e.g. `./orders`, `..base`, `com.example.Util`. */
  spec: string;
  names: ImportedName[];
  /** Python `import a as b`, C# `using B = A`. */
  alias?: string;
  /** C# `global using`: applies to every file in the project. */
  global: boolean;
  line: number;
}

export interface ParsedFile {
  language: LanguageId;
  /** Parent-first order. */
  symbols: ExtractedSymbol[];
  imports: ImportDecl[];
  hasErrors: boolean;
}
