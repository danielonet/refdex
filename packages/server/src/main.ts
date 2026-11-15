import './quiet-sqlite-warning.ts';
import { existsSync, mkdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import * as sea from 'node:sea';
import { parseArgs } from 'node:util';
import { isMainThread } from 'node:worker_threads';
import {
  BROWSE_TABLES, exportNeo4j, IndexDb, Indexer, neo4jStarterQueries, starterExamples, starterQueriesScript, TreeSitter,
  type BrowseTable, type LanguageId, type Neo4jExportSummary,
} from '@refdex/core';
import { DEFAULT_MIN_TOKENS, serveMcp, type ToolsMode } from './mcp.ts';
import { serve } from './serve.ts';
import { wasmLoader } from './wasm.ts';
import { runIndexWorker } from './worker.ts';

/**
 * Set by the bundler from refdex.build.json (scripts/build-flags.mjs). Undefined when running from
 * source, which counts as a debug build. Check it inline where code is gated, so esbuild can drop
 * the branch and what it imports from release bundles.
 */
declare const __REFDEX_DEBUG__: boolean | undefined;

const VERSION = '0.2.0';

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
  refdex mcp --root <dir> [--db <file>]      MCP server (stdio) for Claude Code, Copilot and other AI clients
       [--http <port>]                       debug builds only: serve it over HTTP on 127.0.0.1:<port>/mcp (curl)
  refdex index --root <dir> [--db <file>]    index a folder once; unchanged files are skipped
  refdex export <table> <out.csv> [--db <file>]  write files|symbols|imports|symbol_parts|edges as CSV
  refdex export-neo4j <out.cypher> --root <dir> [--app <name>] [--repo <name>] [--external]
                                             write the code graph as a Cypher script for Neo4j
                                             (cypher-shell -f <out.cypher>); paths relative to --root
  refdex neo4j check [--uri <uri>] [--user <name>] [--database <name>]
                                             check a Neo4j connection and list the apps loaded
  refdex neo4j load --root <dir> [--app <name>] [--repo <name>] [--uri ...] [--external] [--json]
                                             load the code graph into Neo4j as repository <repo> of
                                             app <app>, replacing that repository's previous load
  refdex neo4j queries --root <dir> [--app <name>] [--json]
                                             the starter queries a load stores with the app, as Cypher
  refdex search <query> [--db <file>]        full-text search over symbol names
  refdex outline <file> [--db <file>]        symbols and imports of one file
  refdex stats [--db <file>]                 file and symbol counts per language
  refdex selftest                            parse one snippet per language
  refdex --version
Options:
  --db <file>   index database (default: <root>/.refdex/index.db with --root, else refdex.db)
  --json        machine-readable output
  --limit <n>   maximum search results (default: 20)
  --exclude <pattern>  gitignore-style pattern to leave out (repeatable; serve and index)
  --include <pattern>  only index files matching these gitignore-style patterns (repeatable)
  --language <id>      only index these languages: python, typescript, java, csharp (repeatable)
  --no-watch    serve: do not watch files for changes
  --external    export-neo4j, neo4j load: also export uses of names outside the index, as :External nodes
  --app <name>  export-neo4j, neo4j load: the app the repository belongs to (default: the repository)
  --repo <name> export-neo4j, neo4j load: the repository's name in the app (default: the --root folder's name)
  --uri <uri>   neo4j: server address (default: neo4j://localhost:7687)
  --user <name> neo4j: username (default: neo4j); the password is read from REFDEX_NEO4J_PASSWORD,
                which a server on this machine may leave unset to use the local default (refdex-local)
  --database <name>  neo4j: database (default: the server's default database)
  --tools auto|always|never  mcp: offer the tools always, never, or (auto, default) only for a codebase
                             of at least --min-tokens; on a small one they cost more than they save
  --min-tokens <n>           mcp: size threshold for --tools auto, in estimated tokens of source
                             (default: ${DEFAULT_MIN_TOKENS})
Environment: REFDEX_ROOT, REFDEX_DB, REFDEX_TOOLS and REFDEX_MIN_TOKENS stand in for the flags.`;

async function main(argv: string[]): Promise<number> {
  const { values: opts, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      db: { type: 'string' },
      root: { type: 'string' },
      json: { type: 'boolean', default: false },
      limit: { type: 'string', default: '20' },
      version: { type: 'boolean', default: false },
      exclude: { type: 'string', multiple: true, default: [] },
      include: { type: 'string', multiple: true, default: [] },
      language: { type: 'string', multiple: true, default: [] },
      watch: { type: 'boolean', default: true },
      tools: { type: 'string' },
      'min-tokens': { type: 'string' },
      http: { type: 'string' },
      external: { type: 'boolean', default: false },
      app: { type: 'string' },
      repo: { type: 'string' },
      uri: { type: 'string' },
      user: { type: 'string' },
      database: { type: 'string' },
    },
    allowNegative: true,
  });
  if (opts.version) {
    console.log(VERSION);
    return 0;
  }
  const [command, ...args] = positionals;
  // Environment fallbacks, for MCP client configs and tools that pass settings that way.
  opts.root ??= process.env.REFDEX_ROOT || undefined;
  opts.db ??= process.env.REFDEX_DB || (opts.root ? join(resolve(opts.root), '.refdex', 'index.db') : 'refdex.db');
  const print = (json: unknown, text: () => string) => console.log(opts.json ? JSON.stringify(json) : text());
  if (command === 'serve' || command === 'index') mkdirSync(dirname(resolve(opts.db)), { recursive: true });
  const workspaceOptions = () => ({ exclude: opts.exclude, include: opts.include, languages: opts.language });
  const root = () => {
    if (!opts.root) throw new Error(`${command} needs --root <dir>`);
    return resolve(opts.root);
  };
  // export-neo4j and neo4j load read an index that must exist (read-only would only say "unable to open").
  const openIndex = () => {
    if (!existsSync(opts.db!)) throw new Error(`no index at ${opts.db}; build it first with refdex index --root <dir>${opts.root ? '' : ` --db ${opts.db}`}`);
    return new IndexDb(opts.db!, { readOnly: true });
  };
  // export-neo4j and neo4j load: which section of which app, and paths relative to --root.
  const neo4jTarget = () => {
    const dir = opts.root ? resolve(opts.root) : undefined;
    const repo = opts.repo ?? (dir ? basename(dir) : undefined);
    if (!repo) throw new Error(`${command} needs --root <dir> or --repo <name>`);
    return { app: opts.app ?? repo, repo, root: dir, external: opts.external };
  };

  switch (command) {
    case 'serve':
      await serve(root(), resolve(opts.db), { ...workspaceOptions(), watch: opts.watch });
      return -1; // keeps running until stdin closes
    case 'mcp': {
      const tools = (opts.tools ?? process.env.REFDEX_TOOLS ?? 'auto') as ToolsMode;
      if (!['auto', 'always', 'never'].includes(tools)) throw new Error(`--tools must be auto, always or never, not ${tools}`);
      // An empty value is not 0 (Number('') is): it would turn the tools on for every codebase.
      const rawMinTokens = opts['min-tokens'] ?? process.env.REFDEX_MIN_TOKENS ?? String(DEFAULT_MIN_TOKENS);
      const minTokens = rawMinTokens.trim() === '' ? NaN : Number(rawMinTokens);
      if (!Number.isFinite(minTokens) || minTokens < 0) {
        const source = opts['min-tokens'] !== undefined ? '--min-tokens' : 'REFDEX_MIN_TOKENS';
        throw new Error(`${source} must be a non-negative number, not "${rawMinTokens}"`);
      }
      if (opts.http !== undefined) {
        // Debug builds only: in a release bundle this branch, and mcp-http.ts with it, is gone.
        if (typeof __REFDEX_DEBUG__ === 'undefined' || __REFDEX_DEBUG__) {
          const port = Number(opts.http);
          if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`--http needs a port number, not ${opts.http}`);
          const { serveMcpHttp } = await import('./mcp-http.ts');
          await serveMcpHttp(root(), resolve(opts.db), VERSION, port, { tools, minTokens });
          return -1; // keeps running until stopped
        }
        throw new Error('--http is only in debug builds: set "debug": true in refdex.build.json and rebuild');
      }
      await serveMcp(root(), resolve(opts.db), VERSION, { tools, minTokens });
      return -1; // keeps running until the client disconnects
    }
    case 'selftest':
      return selftest();
    case 'index': {
      const indexer = new Indexer(new IndexDb(opts.db), await TreeSitter.create(wasmLoader()), root(), workspaceOptions());
      const s = await indexer.syncAll();
      print(s, () =>
        `indexed ${s.indexed} files (${s.unchanged} unchanged, ${s.removed} removed, ${s.failed.length} failed) in ${s.ms} ms; ` +
        `${s.files} files, ${s.symbols} symbols; imports: ${s.importsResolved} resolved, ${s.importsUnresolved} unresolved (external); ` +
        `uses: ${s.edgesResolved} linked, ${s.edgesUnresolved} unlinked (library, dynamic or ambiguous)`);
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
    case 'export-neo4j': {
      const [out] = args;
      if (!out) throw new Error('usage: refdex export-neo4j <out.cypher> --root <dir> [--app <name>] [--repo <name>] [--external]');
      const target = neo4jTarget();
      const db = openIndex();
      const s = await exportNeo4j(db, resolve(out), target);
      db.close();
      print(s, () => `wrote repository ${target.repo} of app ${target.app}: ${graphCounts(s)}\n  to ${out}`);
      return 0;
    }
    case 'neo4j': {
      const [action] = args;
      if (action === 'queries') {
        // No connection needed: what a load stores as (:StarterQuery), with names from this index.
        const target = neo4jTarget();
        const queries = neo4jStarterQueries(target.app, existsSync(opts.db!) ? { ...starterExamples(openIndex(), target.root), repo: target.repo } : {});
        const script = starterQueriesScript(target.app, queries);
        print({ app: target.app, queries, script }, () => script);
        return 0;
      }
      if (action !== 'check' && action !== 'load') throw new Error('usage: refdex neo4j check|load|queries [options] (see refdex --help)');
      const { checkNeo4j, describeNeo4jError, isLocalNeo4j, loadNeo4j, LOCAL_NEO4J } = await import('./neo4j-load.ts');
      const uri = opts.uri ?? LOCAL_NEO4J.uri;
      // The password comes from the environment, never the command line (other users can see that).
      // A server on this machine falls back to the local Docker setup's (neo4j/compose.yaml).
      const password = process.env.REFDEX_NEO4J_PASSWORD || (isLocalNeo4j(uri) ? LOCAL_NEO4J.password : undefined);
      const conn = { uri, user: opts.user ?? LOCAL_NEO4J.user, password: password ?? '', database: opts.database, userAgent: `refdex/${VERSION}` };
      const fail = (failure: { kind: string; message: string }) => {
        if (opts.json) console.log(JSON.stringify({ event: 'error', ...failure }));
        return new Error(failure.message);
      };
      if (!password) throw fail({ kind: 'auth', message: 'refdex neo4j reads the Neo4j password from REFDEX_NEO4J_PASSWORD' });
      try {
        if (action === 'check') {
          const info = await checkNeo4j(conn);
          print(info, () => `connected to Neo4j ${info.version} (${info.edition}) at ${info.address}, database ${info.database}` +
            (info.apps.length ? `\napps: ${info.apps.map((a) => `${a.name} (${a.repositories.join(', ')})`).join('; ')}` : ''));
          return 0;
        }
        const target = neo4jTarget();
        const db = openIndex();
        // --json: one line per batch for the IDE plugins; otherwise a status line on a terminal.
        const progress = opts.json
          ? (p: object) => console.log(JSON.stringify({ event: 'progress', ...p }))
          : process.stderr.isTTY ? (p: { stage: string; rows: number }) => process.stderr.write(`\r\x1b[K${p.stage}: ${p.rows.toLocaleString()} rows`) : undefined;
        const s = await loadNeo4j(db, conn, target, progress);
        db.close();
        if (progress && !opts.json) process.stderr.write('\r\x1b[K');
        print({ event: 'done', ...s }, () => `loaded repository ${s.repo} of app ${s.app} into ${conn.uri} in ${(s.ms / 1000).toFixed(1)} s: ${graphCounts(s)}` +
          (s.deleted ? `\n  replaced ${s.deleted.toLocaleString()} nodes from its previous load` : ''));
        return 0;
      } catch (e) {
        const failure = describeNeo4jError(e, conn.uri);
        if (failure.kind === 'auth' && !process.env.REFDEX_NEO4J_PASSWORD) {
          failure.message += ` (RefDex tried the local default password; set REFDEX_NEO4J_PASSWORD)`;
        }
        throw fail(failure);
      }
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

/** "1,152 nodes and 2,463 relationships (91 File, 1,061 Symbol; 796 CALLS, ...)" */
function graphCounts(s: Neo4jExportSummary): string {
  const total = (counts: Record<string, number>) => Object.values(counts).reduce((a, b) => a + b, 0).toLocaleString();
  const list = (counts: Record<string, number>) => Object.entries(counts).filter(([, v]) => v).map(([k, v]) => `${v.toLocaleString()} ${k}`).join(', ');
  return `${total(s.nodes)} nodes and ${total(s.relationships)} relationships (${list(s.nodes)}; ${list(s.relationships)})`;
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
