import type { Node, Tree } from 'web-tree-sitter';
import type { LoadedLanguage } from './parser.ts';

export type SymbolKind =
  | 'namespace' | 'module' | 'class' | 'interface' | 'enum' | 'type_alias'
  | 'function' | 'method' | 'property' | 'field';

export interface ExtractedSymbol {
  kind: SymbolKind;
  /** The grammar's own node type, e.g. `record_declaration`, `struct_declaration`. */
  nativeKind: string;
  name: string;
  qualifiedName: string;
  signature: string;
  /** 1-based, inclusive. */
  startLine: number;
  endLine: number;
  parent?: ExtractedSymbol;
}

export interface ExtractedFile {
  symbols: ExtractedSymbol[];
  imports: { text: string; line: number }[];
  hasErrors: boolean;
}

const MAX_SIGNATURE = 240;

export function extractSymbols(tree: Tree, lang: LoadedLanguage): ExtractedFile {
  const symbols: (ExtractedSymbol & { node: Node })[] = [];
  const imports: ExtractedFile['imports'] = [];

  for (const match of lang.definitions.matches(tree.rootNode)) {
    const def = match.captures.find((c) => c.name !== 'name');
    if (!def) continue;
    if (def.name === 'import') {
      imports.push({ text: collapse(def.node.text), line: def.node.startPosition.row + 1 });
      continue;
    }
    const name = match.captures.find((c) => c.name === 'name')?.node.text ?? '?';
    // Python decorators sit on a wrapping decorated_definition; include them in the range.
    const outer = def.node.parent?.type === 'decorated_definition' ? def.node.parent : def.node;
    symbols.push({
      node: def.node,
      kind: def.name as SymbolKind,
      nativeKind: nativeKind(def.node),
      name,
      qualifiedName: name,
      signature: signatureOf(def.node),
      startLine: outer.startPosition.row + 1,
      endLine: def.node.endPosition.row + 1,
    });
  }

  // Parents by range containment. A namespace with no body (Java package, C# file-scoped
  // namespace) contains every later top-level symbol in the file.
  symbols.sort((a, b) => a.node.startIndex - b.node.startIndex || b.node.endIndex - a.node.endIndex);
  const stack: (ExtractedSymbol & { node: Node })[] = [];
  let fileNamespace: ExtractedSymbol | undefined;
  for (const sym of symbols) {
    while (stack.length && stack[stack.length - 1].node.endIndex < sym.node.endIndex) stack.pop();
    sym.parent = stack[stack.length - 1] ?? fileNamespace;
    if (sym.kind === 'function' && sym.parent && sym.parent.kind === 'class') sym.kind = 'method';
    if (sym.parent) sym.qualifiedName = `${sym.parent.qualifiedName}.${sym.name}`;
    if (sym.kind === 'namespace' && !sym.node.childForFieldName('body')) fileNamespace = sym;
    else stack.push(sym);
  }

  return {
    symbols: symbols.map(({ node: _node, ...sym }) => sym),
    imports,
    hasErrors: tree.rootNode.hasError,
  };
}

function nativeKind(node: Node): string {
  if (node.type === 'lexical_declaration') {
    return node.descendantsOfType(['arrow_function', 'function_expression'])[0]?.type ?? node.type;
  }
  return node.type;
}

/** Declaration text up to the body, e.g. `def area(self) -> float` or `public int Add(int a, int b)`. */
function signatureOf(node: Node): string {
  let body = node.childForFieldName('body');
  if (!body && node.type === 'lexical_declaration') {
    body = node.descendantsOfType(['arrow_function', 'function_expression'])[0]?.childForFieldName('body') ?? null;
  }
  const text = body
    ? node.text.slice(0, body.startIndex - node.startIndex)
    : node.text.split('\n', 1)[0];
  const sig = collapse(text).replace(/\s*(=>|[:{;])$/, '');
  return sig.length > MAX_SIGNATURE ? `${sig.slice(0, MAX_SIGNATURE)}…` : sig;
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
