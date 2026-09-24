import type { Query, Tree } from 'web-tree-sitter';
import type { LanguageId } from '../languages.ts';
import type { ImportDecl, ParsedFile } from '../model.ts';
import type { Workspace } from '../workspace.ts';

export interface ParseInput {
  path: string;
  tree: Tree;
  /** The adapter's compiled `definitions` query for this file's grammar. */
  query: Query;
  language: LanguageId;
  /** Module name for path-based languages (see `LanguageAdapter.moduleName`). */
  module?: string;
}

/** Where an import points. Everything unset means unresolved (external, stdlib or dynamic). */
export interface ImportResolution {
  file?: string;
  namespace?: string;
  /** Qualified name of the imported type, when the import names one. */
  symbol?: string;
}

/** Type and namespace lookups over the whole index, for namespace-based languages. */
export interface NamespaceLookup {
  /** Qualified type name -> defining file. */
  typeFile(qualifiedName: string): string | undefined;
  hasNamespace(namespace: string): boolean;
}

export interface ResolveContext {
  workspace: Workspace;
  namespaces: NamespaceLookup;
}

export interface LanguageAdapter {
  readonly languages: readonly LanguageId[];
  /**
   * Tree-sitter query. Each pattern captures the definition node as `@<kind>` (a normalized
   * symbol kind) and its identifier as `@name`.
   */
  readonly definitions: string;
  /** Module name used as the namespace of path-based languages (Python, TypeScript). */
  moduleName?(path: string, workspace: Workspace): string;
  parse(input: ParseInput): ParsedFile;
  resolveImport(imp: ImportDecl, file: string, ctx: ResolveContext): ImportResolution;
}
