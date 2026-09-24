// Phase 0 spike: parse one sample file per language and print the symbols tree-sitter finds.
// Usage: node spike/print-symbols.ts [file ...]   (defaults to spike/samples/*)
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { performance } from 'node:perf_hooks';
import { languageForPath, TreeSitter, type ExtractedSymbol } from '../src/index.ts';

const samplesDir = join(import.meta.dirname, 'samples');
const files = process.argv.length > 2
  ? process.argv.slice(2)
  : (await readdir(samplesDir)).sort().map((f) => join(samplesDir, f));

const ts = await TreeSitter.create();

for (const file of files) {
  const lang = languageForPath(file);
  if (!lang) {
    console.log(`skip ${file}: unsupported extension`);
    continue;
  }
  const source = await readFile(file, 'utf8');
  const t0 = performance.now();
  const result = await ts.parseFile(file, lang, source);
  const ms = (performance.now() - t0).toFixed(1);

  console.log(`\n${relative(process.cwd(), file)} (${lang}) - ${result.symbols.length} symbols, ${result.imports.length} imports, ${ms} ms${result.hasErrors ? ', HAS PARSE ERRORS' : ''}`);
  for (const imp of result.imports) {
    const names = imp.names.map((n) => (n.alias ? `${n.name} as ${n.alias}` : n.name)).join(', ');
    console.log(`  ${imp.kind.padEnd(11)}L${imp.line}  ${imp.global ? 'global ' : ''}${imp.spec}${names ? ` [${names}]` : ''}${imp.alias ? ` as ${imp.alias}` : ''}`);
  }
  for (const sym of result.symbols) {
    const depth = ancestors(sym);
    const range = `[${sym.startLine}-${sym.endLine}]`;
    console.log(`  ${'  '.repeat(depth)}${sym.kind.padEnd(11)}${sym.qualifiedName} ${range}  (${sym.nativeKind})${sym.exported ? ' exported' : ''}${sym.partial ? ' partial' : ''}\n  ${'  '.repeat(depth)}           ${sym.signature}${sym.doc ? `\n  ${'  '.repeat(depth)}           doc: ${sym.doc}` : ''}`);
  }
}

function ancestors(sym: ExtractedSymbol): number {
  let n = 0;
  for (let p = sym.parent; p; p = p.parent) n++;
  return n;
}
