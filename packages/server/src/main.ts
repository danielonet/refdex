import './quiet-sqlite-warning.ts';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import * as sea from 'node:sea';
import { parseArgs } from 'node:util';
import { isMainThread } from 'node:worker_threads';
import { BROWSE_TABLES, IndexDb, Indexer, TreeSitter, type BrowseTable, type LanguageId } from '@refdex/core';
import { serve } from './serve.ts';
import { wasmLoader } from './wasm.ts';
import { runIndexWorker } from './worker.ts';

const VERSION = '0.0.1';

const SELFTEST_SOURCES: Record<LanguageId, string> = {
  python: 'class Greeter:\n    def greet(self, name: str) -> str:\n        return name\n',
  typescript: 'export class Greeter {\n  greet(name: string): string { return name; }\n}\n',
  tsx: 'export function Greeting({ name }: { name: string }) {\n  return <p>{name}</p>;\n}\n',
  java: 'package demo;\npublic class Greeter {\n  public String greet(String name) { return name; }\n}\n',
  csharp: 'namespace Demo;\npublic class Greeter {\n  public string Greet(string name) => name;\n}\n',
};

const USAGE = `refdex ${VERSION}
Usage:
  refdex serve --root <dir> [--db <file>]    daemon for IDE plugins (JSON lines on stdio, see serve.ts)
  refdex index --root <dir> [--db <file>]    index a folder once; unchanged files are skipped
  refdex export <table> <out.csv> [--db <file>]  write files|symbols|imports|symbol_parts|edges as CSV
  refdex search <query> [--db <file>]        full-text search over symbol names
  refdex outline <file> [--db <file>]        symbols and imports of one file
  refdex stats [--db <file>]                 file and symbol counts per language
  refdex selftest                            parse one snippet per language
  refdex --version
Options:
  --db <file>   index database (default: refdex.db)
  --json        machine-readable output
  --limit <n>   maximum search results (default: 20)
  --exclude <pattern>  gitignore-style pattern to leave out (repeatable; serve and index)
  --no-watch    serve: do not watch files for changes`;

async function main(argv: string[]): Promise<number> {
  const { values: opts, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      db: { type: 'string', default: 'refdex.db' },
      root: { type: 'string' },
      json: { type: 'boolean', default: false },
      limit: { type: 'string', default: '20' },
      version: { type: 'boolean', default: false },
      exclude: { type: 'string', multiple: true, default: [] },
      watch: { type: 'boolean', default: true },
    },
    allowNegative: true,
  });
  if (opts.version) {
    console.log(VERSION);
    return 0;
  }
  const [command, ...args] = positionals;
  const print = (json: unknown, text: () => string) => console.log(opts.json ? JSON.stringify(json) : text());
  if (command === 'serve' || command === 'index') mkdirSync(dirname(resolve(opts.db)), { recursive: true });
  const root = () => {
    if (!opts.root) throw new Error(`${command} needs --root <dir>`);
    return resolve(opts.root);
  };

  switch (command) {
    case 'serve':
      await serve(root(), resolve(opts.db), { exclude: opts.exclude, watch: opts.watch });
      return -1; // keeps running until stdin closes
    case 'selftest':
      return selftest();
    case 'index': {
      const indexer = new Indexer(new IndexDb(opts.db), await TreeSitter.create(wasmLoader()), root(), opts.exclude);
      const s = await indexer.syncAll();
      print(s, () =>
        `indexed ${s.indexed} files (${s.unchanged} unchanged, ${s.removed} removed, ${s.failed.length} failed) in ${s.ms} ms; ` +
        `${s.files} files, ${s.symbols} symbols; imports: ${s.importsResolved} resolved, ${s.importsUnresolved} unresolved (external)`);
      return 0;
    }
    case 'search': {
      const hits = new IndexDb(opts.db).search(args.join(' '), Number(opts.limit));
      print(hits, () => hits.map((h) => `${h.kind.padEnd(10)} ${h.qualified_name}  ${h.path}:${h.start_line}-${h.end_line}\n           ${h.signature}`).join('\n'));
      return 0;
    }
    case 'outline': {
      const db = new IndexDb(opts.db);
      const path = resolve(args[0] ?? '');
      const outline = { symbols: db.fileSymbols(path), imports: db.effectiveImports(path) };
      print(outline, () => [
        ...outline.imports.map((i) => `${i.kind.padEnd(10)} ${i.spec} -> ${i.resolved_path ?? i.resolved_namespace ?? '(unresolved)'}`),
        ...outline.symbols.map((s) => `${s.kind.padEnd(10)} ${s.start_line}-${s.end_line} ${s.signature}`),
      ].join('\n'));
      return 0;
    }
    case 'export': {
      const [table, out] = args;
      if (!BROWSE_TABLES.includes(table as BrowseTable) || !out) throw new Error(`usage: refdex export <${BROWSE_TABLES.join('|')}> <out.csv>`);
      console.log(`wrote ${new IndexDb(opts.db).exportCsv(table as BrowseTable, resolve(out))} rows to ${out}`);
      return 0;
    }
    case 'stats': {
      const stats = new IndexDb(opts.db).stats();
      print(stats, () => [
        `${stats.files} files, ${stats.symbols} symbols, ${stats.resolvedImports}/${stats.imports} imports resolved, last indexed ${stats.indexedAt ?? 'never'}`,
        ...stats.byLanguage.map((l) => `  ${l.language.padEnd(11)} ${l.files} files, ${l.symbols} symbols`),
      ].join('\n'));
      return 0;
    }
    default:
      console.log(USAGE);
      return command ? 1 : 0;
  }
}

async function selftest(): Promise<number> {
  const started = performance.now();
  const ts = await TreeSitter.create(wasmLoader());
  const counts: Record<string, number> = {};
  for (const [lang, source] of Object.entries(SELFTEST_SOURCES) as [LanguageId, string][]) {
    const parsed = await ts.parseFile(`selftest.${lang}`, lang, source);
    if (parsed.hasErrors) throw new Error(`${lang}: parse errors in selftest snippet`);
    counts[lang] = parsed.symbols.length;
  }
  const db = new IndexDb(':memory:');
  const sqlite = (db.db.prepare('SELECT sqlite_version() AS v').get() as { v: string }).v;
  const ok = Object.values(counts).every((n) => n >= 1);
  console.log(JSON.stringify({ ok, sea: sea.isSea(), node: process.version, sqlite, symbols: counts, ms: Math.round(performance.now() - started) }, null, 2));
  return ok ? 0 : 1;
}

if (isMainThread) {
  main(process.argv.slice(2)).then(
    (code) => {
      if (code >= 0) process.exit(code);
    },
    (err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    },
  );
} else {
  runIndexWorker();
}
