import type { Node, Query } from 'web-tree-sitter';
import type { EdgeType, ExtractedReference, ExtractedSymbol, SymbolKind } from '../model.ts';

const MAX_SIGNATURE = 240;
const MAX_DOC = 400;
const MAX_QUALIFIER = 120;

/** Where each symbol was declared, for `extractReferences`: its range-owning node and its name node. */
const declarations = new WeakMap<ExtractedSymbol, { start: number; end: number; nameStart: number }>();

export interface ExtractOptions {
  /** Qualified-name prefix for every top-level symbol (Python/TS module), joined with `moduleSeparator`. */
  module?: string;
  moduleSeparator?: string;
  /** Range-owning node, e.g. Python's `decorated_definition` or TS's `export_statement`. */
  outer?(node: Node): Node;
  doc?(node: Node, outer: Node): string | null;
  exported?(node: Node, outer: Node, topLevel: boolean, name: string): boolean;
  partial?(node: Node): boolean;
  /** Final kind once the parent is known, e.g. Python function inside a class -> method. */
  kind?(kind: SymbolKind, parent: ExtractedSymbol | undefined): SymbolKind;
}

/**
 * Runs a definitions query and turns the matches into symbols with parents, qualified names and
 * namespaces. Parents come from range containment. A namespace with no body (Java package,
 * C# file-scoped namespace) contains every later top-level symbol in the file.
 */
export function extractSymbols(root: Node, query: Query, opts: ExtractOptions = {}): ExtractedSymbol[] {
  // Syntax nodes are kept beside the symbols, not on them, so the returned objects (which
  // `parent` links point at) need no copying.
  const nodes = new Map<ExtractedSymbol, Node>();
  const symbols: ExtractedSymbol[] = [];
  for (const match of query.matches(root)) {
    const def = match.captures.find((c) => c.name !== 'name');
    const nameNode = match.captures.find((c) => c.name === 'name')?.node;
    if (!def || !nameNode) continue;
    const node = def.node;
    const outer = opts.outer?.(node) ?? node;
    const sym: ExtractedSymbol = {
      kind: def.name as SymbolKind,
      nativeKind: nativeKind(node),
      name: nameNode.text,
      qualifiedName: nameNode.text,
      namespace: null,
      signature: signatureOf(node),
      doc: opts.doc?.(node, outer) ?? null,
      startLine: outer.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      exported: false,
      partial: opts.partial?.(node) ?? false,
    };
    nodes.set(sym, node);
    declarations.set(sym, { start: outer.startIndex, end: outer.endIndex, nameStart: nameNode.startIndex });
    symbols.push(sym);
  }
  const nodeOf = (sym: ExtractedSymbol) => nodes.get(sym)!;

  symbols.sort((a, b) => nodeOf(a).startIndex - nodeOf(b).startIndex || nodeOf(b).endIndex - nodeOf(a).endIndex);
  const stack: ExtractedSymbol[] = [];
  let fileNamespace: ExtractedSymbol | undefined;
  const sep = opts.moduleSeparator ?? '.';
  for (const sym of symbols) {
    const node = nodeOf(sym);
    while (stack.length && nodeOf(stack[stack.length - 1]).endIndex < node.endIndex) stack.pop();
    const parent = stack[stack.length - 1] ?? fileNamespace;
    sym.parent = parent;
    sym.kind = opts.kind?.(sym.kind, parent) ?? sym.kind;
    if (parent) {
      sym.qualifiedName = `${parent.qualifiedName}.${sym.name}`;
    } else if (opts.module && sym.kind !== 'namespace') {
      sym.qualifiedName = `${opts.module}${sep}${sym.name}`;
    }
    sym.namespace = sym.kind === 'namespace'
      ? (parent?.namespace ?? null)
      : (nearestNamespace(parent) ?? opts.module ?? null);
    const outer = opts.outer?.(node) ?? node;
    sym.exported = opts.exported?.(node, outer, !parent || parent.kind === 'namespace', sym.name) ?? false;
    if (sym.kind === 'namespace' && !node.childForFieldName('body')) fileNamespace = sym;
    else stack.push(sym);
  }
  return symbols;
}

/** Capture names of a `references` query, strongest first. */
const USE_KINDS = ['call', 'new', 'extends', 'implements', 'reference'] as const;
type UseKind = (typeof USE_KINDS)[number];
const EDGE_TYPE: Record<UseKind, EdgeType> = { call: 'calls', new: 'calls', extends: 'extends', implements: 'implements', reference: 'references' };

/** Nodes whose text up to a member's name is the member's qualifier: `a.b` in `a.b.c`, `this` in `this.m()`. */
const MEMBER_ACCESS = new Set([
  'member_expression', 'attribute', 'member_access_expression', 'method_invocation', 'scoped_type_identifier',
  'qualified_name', 'nested_type_identifier', 'scoped_identifier', 'field_access',
]);
const GENERIC = new Set(['generic_type', 'generic_name']);
/** Qualified type names whose leading parts are packages, not type uses: only the last part is a reference. */
const QUALIFIED_TYPE = new Set(['scoped_type_identifier', 'qualified_name', 'nested_type_identifier']);

/**
 * Runs a references query (see `LanguageAdapter.references`) and attaches each use to the innermost
 * symbol whose declaration contains it. Names of the declarations themselves are skipped.
 */
export function extractReferences(root: Node, query: Query, symbols: ExtractedSymbol[]): ExtractedReference[] {
  const declared = new Set<number>();
  for (const s of symbols) {
    const d = declarations.get(s);
    if (d) declared.add(d.nameStart);
  }
  const uses = new Map<number, { kind: UseKind; name: Node }>();
  for (const match of query.matches(root)) {
    const name = match.captures.find((c) => c.name === 'name')?.node;
    const use = match.captures.find((c) => c.name !== 'name');
    if (!name || !use || declared.has(name.startIndex)) continue;
    const kind = use.name as UseKind;
    const prev = uses.get(name.startIndex);
    if (prev && USE_KINDS.indexOf(prev.kind) <= USE_KINDS.indexOf(kind)) continue;
    const parent = name.parent;
    if (parent?.type === 'type_parameter') continue;
    if (parent && QUALIFIED_TYPE.has(parent.type)
      && (parent.lastNamedChild?.startIndex !== name.startIndex || QUALIFIED_TYPE.has(parent.parent?.type ?? ''))) continue;
    uses.set(name.startIndex, { kind, name });
  }

  // Sweep uses and declarations in source order, keeping a stack of the declarations still open.
  const scopes = symbols
    .filter((s) => declarations.has(s))
    .sort((a, b) => declarations.get(a)!.start - declarations.get(b)!.start || declarations.get(b)!.end - declarations.get(a)!.end);
  const stack: ExtractedSymbol[] = [];
  let next = 0;
  const out: ExtractedReference[] = [];
  for (const [pos, { kind, name }] of [...uses].sort((a, b) => a[0] - b[0])) {
    while (next < scopes.length && declarations.get(scopes[next])!.start <= pos) {
      const start = declarations.get(scopes[next])!.start;
      while (stack.length && declarations.get(stack[stack.length - 1])!.end <= start) stack.pop();
      stack.push(scopes[next++]);
    }
    while (stack.length && declarations.get(stack[stack.length - 1])!.end <= pos) stack.pop();
    out.push({
      type: EDGE_TYPE[kind],
      name: name.text,
      qualifier: qualifierOf(name),
      instantiates: kind === 'new',
      line: name.startPosition.row + 1,
      from: stack[stack.length - 1],
    });
  }
  return out;
}

function qualifierOf(name: Node): string | undefined {
  const node = name.parent && GENERIC.has(name.parent.type) ? name.parent : name;
  const access = node.parent;
  if (!access || !MEMBER_ACCESS.has(access.type)) return undefined;
  const text = access.text.slice(0, node.startIndex - access.startIndex).replace(/\s+/g, '').replace(/(\?\.|\.|::|->)$/, '');
  return text ? truncate(text, MAX_QUALIFIER) : undefined;
}

function nearestNamespace(sym: ExtractedSymbol | undefined): string | null {
  for (let s = sym; s; s = s.parent) if (s.kind === 'namespace') return s.qualifiedName;
  return null;
}

function nativeKind(node: Node): string {
  if (node.type === 'lexical_declaration') {
    return node.descendantsOfType(['arrow_function', 'function_expression'])[0]?.type ?? node.type;
  }
  return node.type;
}

/** Declaration text up to the body, e.g. `def area(self) -> float` or `public int Add(int a, int b)`. */
export function signatureOf(node: Node): string {
  let body = node.childForFieldName('body');
  if (!body && node.type === 'lexical_declaration') {
    body = node.descendantsOfType(['arrow_function', 'function_expression'])[0]?.childForFieldName('body') ?? null;
  }
  const text = body ? node.text.slice(0, body.startIndex - node.startIndex) : node.text.split('\n', 1)[0];
  return truncate(collapse(text).replace(/\s*(=>|[:{;])$/, ''), MAX_SIGNATURE);
}

/** A `/** ... *\/` comment directly above `outer` (JSDoc, Javadoc). */
export function blockDocComment(outer: Node): string | null {
  const prev = outer.previousNamedSibling;
  if (!prev || !prev.type.includes('comment') || !prev.text.startsWith('/**')) return null;
  if (prev.endPosition.row < outer.startPosition.row - 1) return null;
  return cleanDoc(prev.text.replace(/^\/\*\*/, '').replace(/\*\/$/, '').replace(/^\s*\* ?/gm, ''));
}

export function cleanDoc(text: string): string | null {
  const doc = truncate(collapse(text), MAX_DOC);
  return doc || null;
}

/** Text of a string literal node without its quotes. */
export function stringValue(node: Node): string {
  return node.text.replace(/^(['"`])([\s\S]*)\1$/, '$2');
}

export function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
