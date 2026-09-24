import type { Node } from 'web-tree-sitter';
import type { ImportDecl } from '../model.ts';
import { blockDocComment, extractSymbols } from './common.ts';
import type { LanguageAdapter } from './types.ts';

const definitions = `
(package_declaration (_) @name) @namespace
(class_declaration name: (identifier) @name) @class
(record_declaration name: (identifier) @name) @class
(interface_declaration name: (identifier) @name) @interface
(annotation_type_declaration name: (identifier) @name) @interface
(enum_declaration name: (identifier) @name) @enum
(method_declaration name: (identifier) @name) @method
(constructor_declaration name: (identifier) @name) @method
(field_declaration declarator: (variable_declarator name: (identifier) @name)) @field
(constant_declaration declarator: (variable_declarator name: (identifier) @name)) @field
`;

export const javaAdapter: LanguageAdapter = {
  languages: ['java'],
  definitions,

  parse({ tree, query, language }) {
    const symbols = extractSymbols(tree.rootNode, query, {
      doc: (node) => blockDocComment(node),
      exported: (node) => hasModifier(node, 'public'),
    });
    return { language, symbols, imports: parseImports(tree.rootNode), hasErrors: tree.rootNode.hasError };
  },

  /** Imports name types or packages, so they resolve through the namespace index, not the file system. */
  resolveImport(imp, _file, { namespaces }) {
    if (imp.kind === 'wildcard') {
      // `import a.b.*` names a package; `import a.b.Outer.*` names a type's members.
      if (namespaces.hasNamespace(imp.spec)) return { namespace: imp.spec };
      const file = namespaces.typeFile(imp.spec);
      return file ? { file, symbol: imp.spec } : {};
    }
    // `import static a.b.Util.method` -> type a.b.Util (the last part may also be a nested type).
    const type = imp.kind === 'static' && !namespaces.typeFile(imp.spec) ? imp.spec.replace(/\.[^.]+$/, '') : imp.spec;
    const file = namespaces.typeFile(type);
    return file ? { file, symbol: type, namespace: type.replace(/\.[^.]+$/, '') } : {};
  },
};

export function hasModifier(node: Node, modifier: string): boolean {
  const modifiers = node.namedChildren.find((c) => c.type === 'modifiers');
  return !!modifiers && modifiers.children.some((c) => c.text === modifier);
}

function parseImports(root: Node): ImportDecl[] {
  const out: ImportDecl[] = [];
  for (const node of root.namedChildren) {
    if (node.type !== 'import_declaration') continue;
    const m = /^import\s+(static\s+)?([\w$.]+?)(\.\*)?\s*;/.exec(node.text.replace(/\s+/g, ' '));
    if (!m) continue;
    const [, isStatic, spec, wildcard] = m;
    out.push({
      kind: wildcard ? 'wildcard' : isStatic ? 'static' : 'import',
      spec,
      names: wildcard ? [{ name: '*' }] : [{ name: spec.slice(spec.lastIndexOf('.') + 1) }],
      global: false,
      line: node.startPosition.row + 1,
    });
  }
  return out;
}
