import './quiet-sqlite-warning.ts';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import * as sea from 'node:sea';
import { extractSymbols, languageForPath, nodeModulesWasmLoader, TreeSitter, type LanguageId, type WasmLoader } from '@refdex/core';
import { IndexDb } from './db.ts';

const VERSION = '0.0.1';

// In the single executable, grammars are embedded as SEA assets keyed by file name.
const wasmLoader: WasmLoader = sea.isSea()
  ? async (file) => new Uint8Array(sea.getAsset(file))
  : nodeModulesWasmLoader;

const SELFTEST_SOURCES: Record<LanguageId, string> = {
  python: 'class Greeter:\n    def greet(self, name: str) -> str:\n        return name\n',
  typescript: 'export class Greeter {\n  greet(name: string): string { return name; }\n}\n',
  tsx: 'export function Greeting({ name }: { name: string }) {\n  return <p>{name}</p>;\n}\n',
  java: 'package demo;\npublic class Greeter {\n  public String greet(String name) { return name; }\n}\n',
  csharp: 'namespace Demo;\npublic class Greeter {\n  public string Greet(string name) => name;\n}\n',
};

const USAGE = `refdex ${VERSION}
Usage:
  refdex selftest                        parse one snippet per language into an in-memory index
  refdex index [--db <file>] <files...>  index files (default db: refdex.db)
  refdex search [--db <file>] <query>    full-text search over indexed symbol names
  refdex --version`;

async function main(argv: string[]): Promise<number> {
  const dbIndex = argv.indexOf('--db');
  const dbPath = dbIndex >= 0 ? argv.splice(dbIndex, 2)[1] : 'refdex.db';
  const [command, ...args] = argv;

  switch (command) {
    case '--version':
      console.log(VERSION);
      return 0;
    case 'selftest':
      return selftest();
    case 'index':
      return index(new IndexDb(dbPath), args);
    case 'search': {
      const hits = new IndexDb(dbPath).search(args.join(' '));
      for (const h of hits) console.log(`${h.kind.padEnd(10)} ${h.qualified_name}  ${h.path}:${h.start_line}-${h.end_line}\n           ${h.signature}`);
      return 0;
    }
    default:
      console.log(USAGE);
      return command ? 1 : 0;
  }
}

async function selftest(): Promise<number> {
  const started = performance.now();
  const ts = await TreeSitter.create(wasmLoader);
  const db = new IndexDb(':memory:');
  for (const [lang, source] of Object.entries(SELFTEST_SOURCES) as [LanguageId, string][]) {
    const { tree, lang: loaded } = await ts.parse(lang, source);
    const { symbols, hasErrors } = extractSymbols(tree, loaded);
    tree.delete();
    if (hasErrors) throw new Error(`${lang}: parse errors in selftest snippet`);
    db.replaceFile(`selftest/${lang}`, lang, sha1(source), symbols);
  }
  const hits = db.search('gree');
  const ok = new Set(hits.map((h) => h.path)).size === Object.keys(SELFTEST_SOURCES).length;
  console.log(JSON.stringify({
    ok,
    sea: sea.isSea(),
    node: process.version,
    sqlite: (db.db.prepare('SELECT sqlite_version() AS v').get() as { v: string }).v,
    ...db.counts(),
    ftsHits: hits.map((h) => h.qualified_name),
    ms: Math.round(performance.now() - started),
  }, null, 2));
  return ok ? 0 : 1;
}

async function index(db: IndexDb, files: string[]): Promise<number> {
  const ts = await TreeSitter.create(wasmLoader);
  for (const file of files) {
    const lang = languageForPath(file);
    if (!lang) continue;
    const source = await readFile(file, 'utf8');
    const { tree, lang: loaded } = await ts.parse(lang, source);
    const { symbols } = extractSymbols(tree, loaded);
    tree.delete();
    db.replaceFile(resolve(file), lang, sha1(source), symbols);
  }
  const { files: f, symbols: s } = db.counts();
  console.log(`indexed ${files.length} files; database now holds ${f} files, ${s} symbols`);
  return 0;
}

function sha1(text: string): string {
  return createHash('sha1').update(text).digest('hex');
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
