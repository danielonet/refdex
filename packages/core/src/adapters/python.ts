import type { Node } from 'web-tree-sitter';
import { dirname, join, relative, sep } from 'node:path';
import type { ImportDecl } from '../model.ts';
import type { Workspace } from '../workspace.ts';
import { cleanDoc, extractReferences, extractSymbols } from './common.ts';
import type { LanguageAdapter } from './types.ts';

const definitions = `
(class_definition name: (identifier) @name) @class
(function_definition name: (identifier) @name) @function
`;

const references = `
(call function: [(identifier) @name (attribute attribute: (identifier) @name)]) @call
(decorator [(identifier) @name (attribute attribute: (identifier) @name)]) @call
(class_definition superclasses: (argument_list [(identifier) @name (attribute attribute: (identifier) @name)])) @extends
(type [(identifier) @name (attribute attribute: (identifier) @name) (generic_type (identifier) @name)]) @reference
`;

export const pythonAdapter: LanguageAdapter = {
  languages: ['python'],
  definitions,
  references,

  /** Dotted module name relative to the deepest Python root, e.g. `shop/orders/__init__.py` -> `shop.orders`. */
  moduleName(path: string, ws: Workspace): string {
    const root = ws.pythonRoots().find((r) => path.startsWith(r + sep)) ?? ws.root;
    return relative(root, path).replace(/\.pyi?$/, '').split(sep).filter((p) => p !== '__init__').join('.');
  },

  parse({ tree, query, references: refs, language, module }) {
    const symbols = extractSymbols(tree.rootNode, query, {
      module,
      outer: (node) => (node.parent?.type === 'decorated_definition' ? node.parent : node),
      doc: docstring,
      exported: (_node, _outer, topLevel, name) => topLevel && !name.startsWith('_'),
      kind: (kind, parent) => (kind === 'function' && parent?.kind === 'class' ? 'method' : kind),
    });
    return {
      language, symbols, imports: parseImports(tree.rootNode),
      references: extractReferences(tree.rootNode, refs, symbols), hasErrors: tree.rootNode.hasError,
    };
  },

  resolveImport(imp, file, { workspace: ws }) {
    const from = imp.kind === 'from';
    const level = from ? /^\.*/.exec(imp.spec)![0].length : 0;
    const dotted = imp.spec.slice(level);
    const bases = level
      ? [relativeBase(file, level)]
      : ws.pythonRoots();
    for (const base of bases) {
      const modulePath = dotted ? join(base, ...dotted.split('.')) : base;
      // `from pkg import sub` where `sub` is a submodule rather than a name in pkg/__init__.py.
      const name = from ? imp.names[0]?.name : undefined;
      if (name && name !== '*') {
        const sub = moduleFile(join(modulePath, name), ws);
        if (sub) return { file: sub };
      }
      const found = moduleFile(modulePath, ws);
      if (found) return { file: found };
    }
    return {};
  },
};

function relativeBase(file: string, level: number): string {
  let dir = dirname(file);
  for (let i = 1; i < level; i++) dir = dirname(dir);
  return dir;
}

function moduleFile(path: string, ws: Workspace): string | undefined {
  for (const candidate of [`${path}.py`, join(path, '__init__.py'), `${path}.pyi`, join(path, '__init__.pyi')]) {
    if (ws.hasFile(candidate)) return candidate;
  }
  return undefined;
}

/** First statement of the body, if it is a string literal. */
function docstring(node: Node): string | null {
  const first = node.childForFieldName('body')?.namedChildren[0];
  const str = first?.type === 'expression_statement' ? first.namedChildren[0] : undefined;
  if (str?.type !== 'string') return null;
  return cleanDoc(str.text.replace(/^[rRuUbB]*("""|'''|"|')([\s\S]*)\1$/, '$2'));
}

/** `import a.b as c` -> one row per module; `from m import x, y` -> one row per name. */
function parseImports(root: Node): ImportDecl[] {
  const out: ImportDecl[] = [];
  for (const node of root.descendantsOfType(['import_statement', 'import_from_statement'])) {
    const line = node.startPosition.row + 1;
    if (node.type === 'import_statement') {
      for (const n of node.childrenForFieldName('name')) {
        const aliased = n.type === 'aliased_import';
        out.push({
          kind: 'import',
          spec: (aliased ? n.childForFieldName('name')! : n).text,
          names: [],
          alias: aliased ? n.childForFieldName('alias')?.text : undefined,
          global: false,
          line,
        });
      }
      continue;
    }
    const spec = node.childForFieldName('module_name')?.text ?? '';
    const names = node.childrenForFieldName('name').map((n) =>
      n.type === 'aliased_import'
        ? { name: n.childForFieldName('name')!.text, alias: n.childForFieldName('alias')?.text }
        : { name: n.text },
    );
    if (node.namedChildren.some((c) => c.type === 'wildcard_import')) names.push({ name: '*' });
    for (const name of names) out.push({ kind: 'from', spec, names: [name], global: false, line });
  }
  return out;
}
