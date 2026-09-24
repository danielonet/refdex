import type { Node } from 'web-tree-sitter';
import type { ImportDecl } from '../model.ts';
import { cleanDoc, extractReferences, extractSymbols } from './common.ts';
import type { LanguageAdapter } from './types.ts';

const definitions = `
(namespace_declaration name: (_) @name) @namespace
(file_scoped_namespace_declaration name: (_) @name) @namespace
(class_declaration name: (identifier) @name) @class
(struct_declaration name: (identifier) @name) @class
(record_declaration name: (identifier) @name) @class
(interface_declaration name: (identifier) @name) @interface
(enum_declaration name: (identifier) @name) @enum
(delegate_declaration name: (identifier) @name) @type_alias
(method_declaration name: (identifier) @name) @method
(constructor_declaration name: (identifier) @name) @method
(property_declaration name: (identifier) @name) @property
(event_field_declaration (variable_declaration (variable_declarator name: (identifier) @name))) @field
(field_declaration (variable_declaration (variable_declarator name: (identifier) @name))) @field
`;

// C# types are plain identifiers, so type uses are found by position: `type:` and `returns:` fields,
// type arguments, base lists and nullable types.
const name = '[(identifier) @name (generic_name (identifier) @name)]';
const type = `[${name.slice(1, -1)} (qualified_name name: ${name})]`;
const references = `
(invocation_expression function: [${name.slice(1, -1)} (member_access_expression name: ${name})]) @call
(object_creation_expression type: ${type}) @new
(base_list ${type}) @extends
(_ type: ${type}) @reference
(_ returns: ${type}) @reference
(type_argument_list ${type}) @reference
(nullable_type ${type}) @reference
`;

const TYPE_KINDS = new Set(['class_declaration', 'struct_declaration', 'record_declaration', 'interface_declaration']);

export const csharpAdapter: LanguageAdapter = {
  languages: ['csharp'],
  definitions,
  references,

  parse({ tree, query, references: refs, language }) {
    const symbols = extractSymbols(tree.rootNode, query, {
      doc: xmlDocComment,
      exported: (node) => modifiers(node).includes('public'),
      partial: (node) => TYPE_KINDS.has(node.type) && modifiers(node).includes('partial'),
    });
    return {
      language, symbols, imports: parseImports(tree.rootNode),
      references: extractReferences(tree.rootNode, refs, symbols), hasErrors: tree.rootNode.hasError,
    };
  },

  resolveImport(imp, _file, { namespaces }) {
    // `using static A.B.Type`, `using X = A.B.Type` name types; `using A.B` / `using X = A.B` name namespaces.
    if (imp.kind !== 'using') {
      const file = namespaces.typeFile(imp.spec);
      if (file) return { file, symbol: imp.spec, namespace: imp.spec.replace(/\.[^.]+$/, '') };
    }
    return imp.kind !== 'static' && namespaces.hasNamespace(imp.spec) ? { namespace: imp.spec } : {};
  },
};

function modifiers(node: Node): string[] {
  return node.namedChildren.filter((c) => c.type === 'modifier').map((c) => c.text);
}

/** Consecutive `///` comments directly above the declaration, with the XML tags removed. */
function xmlDocComment(node: Node): string | null {
  const lines: string[] = [];
  let expectedRow = node.startPosition.row - 1;
  for (let prev = node.previousNamedSibling; prev?.type === 'comment' && prev.text.startsWith('///'); prev = prev.previousNamedSibling) {
    if (prev.endPosition.row !== expectedRow) break;
    lines.unshift(prev.text.replace(/^\/\/\/\s?/, ''));
    expectedRow = prev.startPosition.row - 1;
  }
  return lines.length ? cleanDoc(lines.join(' ').replace(/<[^>]+>/g, ' ')) : null;
}

/** Usings at the top of the file and inside namespace blocks. */
function parseImports(root: Node): ImportDecl[] {
  const out: ImportDecl[] = [];
  for (const node of root.descendantsOfType('using_directive')) {
    const text = node.text.replace(/\s+/g, ' ').replace(/global::/g, '');
    const m = /^(global )?using (static )?(?:(\w+) ?= ?)?([\w.]+(?:<.*>)?) ?;/.exec(text);
    if (!m) continue;
    const [, isGlobal, isStatic, alias, spec] = m;
    out.push({
      kind: isStatic ? 'static' : alias ? 'alias' : 'using',
      spec: spec.replace(/<.*>$/, ''),
      names: [],
      alias,
      global: !!isGlobal,
      line: node.startPosition.row + 1,
    });
  }
  return out;
}
