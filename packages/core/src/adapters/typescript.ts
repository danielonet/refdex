import type { Node } from 'web-tree-sitter';
import { dirname, join, relative, sep } from 'node:path';
import type { ImportDecl, ImportedName } from '../model.ts';
import { aliasCandidates } from '../resolve/tsconfig.ts';
import type { Workspace } from '../workspace.ts';
import { blockDocComment, extractSymbols, stringValue } from './common.ts';
import type { LanguageAdapter } from './types.ts';

const definitions = `
(class_declaration name: (type_identifier) @name) @class
(abstract_class_declaration name: (type_identifier) @name) @class
(interface_declaration name: (type_identifier) @name) @interface
(enum_declaration name: (identifier) @name) @enum
(type_alias_declaration name: (type_identifier) @name) @type_alias
(function_declaration name: (identifier) @name) @function
(generator_function_declaration name: (identifier) @name) @function
(method_definition name: [(property_identifier) (private_property_identifier) (computed_property_name)] @name) @method
(interface_declaration body: (interface_body (method_signature name: [(property_identifier) (computed_property_name)] @name) @method))
(abstract_method_signature name: [(property_identifier) (computed_property_name)] @name) @method
(public_field_definition name: [(property_identifier) (private_property_identifier)] @name) @property
(interface_declaration body: (interface_body (property_signature name: (property_identifier) @name) @property))
(program (lexical_declaration (variable_declarator name: (identifier) @name value: [(arrow_function) (function_expression)])) @function)
(program (export_statement (lexical_declaration (variable_declarator name: (identifier) @name value: [(arrow_function) (function_expression)])) @function))
`;

/** Extensions tried for an extensionless specifier, in TypeScript's order. */
const EXTENSIONS = ['.ts', '.tsx', '.d.ts', '.mts', '.cts'];

export const typescriptAdapter: LanguageAdapter = {
  languages: ['typescript', 'tsx'],
  definitions,

  /** Path relative to the workspace root without extension, e.g. `src/orders`. */
  moduleName(path: string, ws: Workspace): string {
    return relative(ws.root, path).split(sep).join('/').replace(/(\.d)?\.(ts|tsx|mts|cts)$/, '');
  },

  parse({ tree, query, language, module }) {
    const symbols = extractSymbols(tree.rootNode, query, {
      module,
      moduleSeparator: ':',
      outer: exportWrapper,
      doc: (_node, outer) => blockDocComment(outer),
      exported: (node, outer, topLevel) => topLevel && (outer !== node || node.parent?.type === 'export_statement'),
    });
    return { language, symbols, imports: parseImports(tree.rootNode), hasErrors: tree.rootNode.hasError };
  },

  resolveImport(imp, file, { workspace: ws }) {
    const spec = imp.spec;
    if (spec.startsWith('.')) {
      const found = resolveFileLike(join(dirname(file), spec), ws);
      return found ? { file: found } : {};
    }
    const config = ws.tsconfigFor(file);
    for (const candidate of config ? aliasCandidates(config, spec) : []) {
      const found = resolveFileLike(candidate, ws);
      if (found) return { file: found };
    }
    const found = resolveWorkspacePackage(spec, ws);
    return found ? { file: found } : {};
  },
};

/** `export class X` / `export const x = ...`: the export_statement owns the range and the doc comment. */
function exportWrapper(node: Node): Node {
  return node.parent?.type === 'export_statement' ? node.parent : node;
}

export function resolveFileLike(path: string, ws: Workspace): string | undefined {
  if (ws.hasFile(path)) return path;
  // ESM-style `./x.js` refers to `./x.ts`.
  const stripped = path.replace(/\.(m|c)?jsx?$/, '');
  for (const ext of EXTENSIONS) if (ws.hasFile(stripped + ext)) return stripped + ext;
  for (const ext of EXTENSIONS) if (ws.hasFile(join(path, `index${ext}`))) return join(path, `index${ext}`);
  return undefined;
}

/** `@scope/pkg` or `@scope/pkg/sub` where the package lives in this workspace (monorepo). */
function resolveWorkspacePackage(spec: string, ws: Workspace): string | undefined {
  const parts = spec.split('/');
  const nameLength = spec.startsWith('@') ? 2 : 1;
  const pkg = ws.workspacePackage(parts.slice(0, nameLength).join('/'));
  if (!pkg) return undefined;
  const subpath = parts.slice(nameLength).join('/');
  const entry = exportTarget(pkg.manifest.exports, subpath ? `./${subpath}` : '.');
  const candidates = [
    entry,
    ...(subpath ? [subpath, `src/${subpath}`] : [pkg.manifest.types, pkg.manifest.typings, pkg.manifest.module, pkg.manifest.main, 'src/index', 'index']),
  ].filter((c): c is string => !!c);
  for (const c of candidates) {
    const found = resolveFileLike(join(pkg.dir, c), ws);
    if (found) return found;
    // Built output such as dist/index.d.ts usually mirrors src/.
    const source = resolveFileLike(join(pkg.dir, c.replace(/^\.?\/?(dist|lib|build|out)\//, 'src/')), ws);
    if (source) return source;
  }
  return undefined;
}

/** Target of `exports[key]`, preferring types, then import, then default conditions. */
function exportTarget(exports: unknown, key: string): string | undefined {
  if (typeof exports === 'string') return key === '.' ? exports : undefined;
  if (!exports || typeof exports !== 'object') return undefined;
  const map = exports as Record<string, unknown>;
  const value = Object.keys(map).some((k) => k.startsWith('.')) ? map[key] : key === '.' ? map : undefined;
  return pickCondition(value);
}

function pickCondition(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return undefined;
  const map = value as Record<string, unknown>;
  for (const cond of ['types', 'import', 'node', 'default', 'require']) {
    const picked = pickCondition(map[cond]);
    if (picked) return picked;
  }
  return undefined;
}

/**
 * `import d, { a as b } from 'x'`, `import * as ns from 'x'`, `import 'x'`;
 * `export { a } from 'x'`, `export * from 'x'`, `export * as ns from 'x'`.
 */
function parseImports(root: Node): ImportDecl[] {
  const out: ImportDecl[] = [];
  for (const node of root.namedChildren) {
    const source = node.childForFieldName('source');
    if (!source) continue;
    const line = node.startPosition.row + 1;
    if (node.type === 'import_statement') {
      const names: ImportedName[] = [];
      const clause = node.namedChildren.find((c) => c.type === 'import_clause');
      for (const part of clause?.namedChildren ?? []) {
        if (part.type === 'identifier') names.push({ name: 'default', alias: part.text });
        else if (part.type === 'namespace_import') names.push({ name: '*', alias: part.namedChildren[0]?.text });
        else if (part.type === 'named_imports') names.push(...specifiers(part, 'import_specifier'));
      }
      out.push({ kind: 'import', spec: stringValue(source), names, global: false, line });
    } else if (node.type === 'export_statement') {
      const clause = node.namedChildren.find((c) => c.type === 'export_clause');
      const nsExport = node.namedChildren.find((c) => c.type === 'namespace_export');
      const names = clause
        ? specifiers(clause, 'export_specifier')
        : [{ name: '*', alias: nsExport?.namedChildren[0]?.text }];
      out.push({ kind: 're-export', spec: stringValue(source), names, global: false, line });
    }
  }
  return out;
}

function specifiers(list: Node, type: string): ImportedName[] {
  return list.namedChildren
    .filter((s) => s.type === type)
    .map((s) => ({ name: s.childForFieldName('name')!.text, alias: s.childForFieldName('alias')?.text }));
}
