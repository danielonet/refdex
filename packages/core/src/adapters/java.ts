import type { Node } from 'web-tree-sitter';
import type { ImportDecl } from '../model.ts';
import { blockDocComment, extractReferences, extractSymbols, type LocalTypes } from './common.ts';
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

const type = '[(type_identifier) @name (generic_type (type_identifier) @name) (scoped_type_identifier (type_identifier) @name) (generic_type (scoped_type_identifier (type_identifier) @name))]';
const references = `
(method_invocation name: (identifier) @name) @call
(object_creation_expression type: ${type}) @new
(superclass ${type}) @extends
(super_interfaces (type_list ${type})) @implements
(extends_interfaces (type_list ${type})) @extends
(type_identifier) @name @reference
`;

/** Fields' types and methods' return types (`Segment<K, V> segmentFor(int h)`). */
function valueType(node: Node): string | undefined {
  if (node.type === 'method_declaration' || node.type === 'field_declaration' || node.type === 'constant_declaration') {
    const type = node.childForFieldName('type');
    return type && type.type !== 'void_type' ? type.text : undefined;
  }
  return undefined;
}

/** Parameters and local variables; `var x = new Foo()` counts as `Foo`. */
const locals: LocalTypes = {
  scopes: new Set(['method_declaration', 'constructor_declaration', 'compact_constructor_declaration', 'lambda_expression', 'static_initializer']),
  declared(scope) {
    const out = new Map<string, string>();
    const add = (name: string | undefined, type: string | undefined) => {
      if (name && type && !out.has(name)) out.set(name, type);
    };
    for (const d of scope.descendantsOfType(['formal_parameter', 'local_variable_declaration', 'enhanced_for_statement', 'resource'])) {
      const type = d.childForFieldName('type');
      if (d.type === 'local_variable_declaration') {
        for (const v of d.childrenForFieldName('declarator')) {
          const value = v.childForFieldName('value');
          const inferred = type?.text === 'var' ? (value?.type === 'object_creation_expression' ? value.childForFieldName('type')?.text : undefined) : type?.text;
          add(v.childForFieldName('name')?.text, inferred);
        }
      } else {
        add(d.childForFieldName('name')?.text, type?.text === 'var' ? undefined : type?.text);
      }
    }
    return out;
  },
};

export const javaAdapter: LanguageAdapter = {
  languages: ['java'],
  definitions,
  references,

  parse({ tree, query, references: refs, language }) {
    const symbols = extractSymbols(tree.rootNode, query, {
      doc: (node) => blockDocComment(node),
      exported: (node) => hasModifier(node, 'public'),
      valueType,
    });
    return {
      language, symbols, imports: parseImports(tree.rootNode),
      references: extractReferences(tree.rootNode, refs, symbols, locals), hasErrors: tree.rootNode.hasError,
    };
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
