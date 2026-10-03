import { McpServer, type RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod';
import { existsSync } from 'node:fs';
import { IndexDb } from '@refdex/core';
import { DEFAULT_BLAST_DEPTH, DEFAULT_CONTEXT_TOKENS, MAX_BLAST_DEPTH, MAX_CONTEXT_TOKENS, MAX_SOURCE_NAMES, RefdexTools } from './tools.ts';
import { UsageLog } from './usage.ts';

const INSTRUCTIONS = `RefDex is a method-level index of this workspace's Python, TypeScript, Java and C# code.
Use it to find and read code instead of opening whole files:
1. find_references for "who calls this / which tests reach this / what breaks if I change this": one call
   returns callers, their callers and the tests that reach the symbol, instead of searching file by file;
2. search_symbols to find classes, methods and functions by name;
3. get_symbol_source to read just the code of symbols, several in one call (with_callees adds what they call);
4. get_file_outline to see a file's imports and signatures without its bodies;
5. get_repo_map or get_context for a first overview of unfamiliar code (keep it small; it is no substitute
   for reading the symbols you need).
Answers include file paths and line ranges; source is read from disk, so it is current.`;

/**
 * When to offer the tools. Their definitions and instructions (about 1,200 tokens) are sent with
 * every request a client makes, so on a small codebase, where reading files is cheap anyway, they
 * cost more than they save. `auto` offers them once the indexed code reaches `minTokens`.
 */
export type ToolsMode = 'auto' | 'always' | 'never';

/** About 400 KB of source. A heuristic until the token benchmark (Phase 5) gives a measured one. */
export const DEFAULT_MIN_TOKENS = 100_000;
const CHARS_PER_TOKEN = 4;
/** How often `auto` re-checks the index size while the tools are off. */
const RECHECK_MS = 60_000;

export interface McpOptions {
  tools: ToolsMode;
  minTokens: number;
}

export interface ToolsDecision {
  enabled: boolean;
  /** Why, for logs and the IDE: "~240,000 tokens of code (threshold 100,000)". */
  reason: string;
  /** Estimated tokens of indexed source; undefined without an index. */
  codeTokens?: number;
}

/** Whether the tools are worth offering for this index. */
export function toolsDecision(dbPath: string, opts: McpOptions): ToolsDecision {
  if (opts.tools === 'always') return { enabled: true, reason: 'always on (settings)' };
  if (opts.tools === 'never') return { enabled: false, reason: 'turned off in settings' };
  let codeChars: number;
  try {
    if (!existsSync(dbPath)) return { enabled: false, reason: 'no index yet' };
    const db = new IndexDb(dbPath, { readOnly: true });
    try {
      codeChars = db.stats().codeChars;
    } finally {
      db.close();
    }
  } catch {
    return { enabled: false, reason: 'no index yet' };
  }
  const codeTokens = Math.round(codeChars / CHARS_PER_TOKEN);
  const size = `~${codeTokens.toLocaleString('en-US')} tokens of code (threshold ${opts.minTokens.toLocaleString('en-US')})`;
  return codeTokens >= opts.minTokens
    ? { enabled: true, reason: size, codeTokens }
    : { enabled: false, reason: `small codebase: ${size}`, codeTokens };
}

/**
 * One MCP server over the shared tools: instructions, usage logging and every tool, disabled while
 * `decision()` says the codebase is too small. Used by the stdio server and, in debug builds, the
 * HTTP one (mcp-http.ts). `fallbackClient` names callers that skip the `initialize` handshake.
 */
export function createServer(
  root: string, version: string, tools: RefdexTools, usage: UsageLog, opts: McpOptions, decision: () => ToolsDecision, fallbackClient = 'unknown',
): { server: McpServer; registered: RegisteredTool[] } {
  // Without tools, only a short note: the full instructions would be overhead too. Clients get
  // instructions once, at initialize, so in `auto` the note also covers the tools arriving later.
  const instructions = decision().enabled
    ? INSTRUCTIONS
    : `RefDex's code index tools are off for this workspace (${decision().reason}); read files directly.` +
      (opts.tools === 'auto' ? ' If they appear later, use them to find and read code instead of opening whole files.' : '');
  const server = new McpServer({ name: 'refdex', title: 'RefDex code index', version }, { instructions });
  const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  const clientInfo = () => {
    const client = server.server.getClientVersion();
    return { client: client?.name ?? fallbackClient, clientVersion: client?.version };
  };
  server.server.oninitialized = () => {
    const { client, clientVersion } = clientInfo();
    const { enabled, reason } = decision();
    process.stderr.write(`refdex mcp: serving ${client} ${clientVersion ?? ''} for ${root}; tools ${enabled ? 'on' : 'off'} (${reason})\n`);
    void usage.record({ t: new Date().toISOString(), ...clientInfo(), event: 'connect', tools: enabled, reason });
  };
  /** Runs a tool, logs the call and its arguments with the client's name, and wraps the text as MCP content. */
  const run = async (tool: string, args: Record<string, unknown>, fn: () => Promise<string>) => {
    const started = performance.now();
    const t = new Date().toISOString();
    try {
      const text = await fn();
      void usage.record({ t, ...clientInfo(), tool, args, ms: Math.round(performance.now() - started), chars: text.length });
      return { content: [{ type: 'text' as const, text }] };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      void usage.record({ t, ...clientInfo(), tool, args, ms: Math.round(performance.now() - started), chars: 0, error });
      throw e;
    }
  };

  // Every tool is registered before connecting (the SDK can't add the capability later) and
  // disabled while the codebase is too small; disabled tools aren't listed.
  const registered = [
    server.registerTool(
      'get_context',
      {
        title: 'Get context for a task',
        description:
          'A small overview for a task in unfamiliar code: bodies of the symbols it names, signatures around them. ' +
          `At most ${MAX_CONTEXT_TOKENS.toLocaleString('en-US')} tokens. For specific symbols, get_symbol_source and find_references are cheaper.`,
        inputSchema: {
          task: z.string().min(1).describe('The task in your words; name the classes and methods involved where you know them'),
          // Not limited in the schema: a larger request is clamped rather than failing (a failed call costs a turn).
          budget: z.number().int().min(500).optional().describe(`Token budget (default ${DEFAULT_CONTEXT_TOKENS}, at most ${MAX_CONTEXT_TOKENS})`),
          seeds: z.array(z.string().min(1)).max(20).optional().describe('Qualified names to start from, besides the names in the task'),
          changes: z.boolean().optional().describe('Also start from the symbols changed in the git working tree'),
          depth: z.number().int().min(0).max(3).optional().describe('Hops over calls and inheritance from the starting symbols (default 2)'),
        },
        annotations: readOnly,
      },
      (args) => run('get_context', args, () => tools.getContext(args)),
    ),

    server.registerTool(
      'search_symbols',
      {
        title: 'Search symbols',
        description:
          'Find classes, functions, methods, properties and fields by name or prefix ("OrderServ" finds OrderService). ' +
          'Returns kind, qualified name, file:lines and signature; a single exact name match also comes with its code.',
        inputSchema: {
          query: z.string().min(1).describe('Name, prefix or qualified name'),
          kind: z.enum(['namespace', 'class', 'interface', 'enum', 'type_alias', 'function', 'method', 'property', 'field']).optional(),
          language: z.enum(['python', 'typescript', 'tsx', 'java', 'csharp']).optional(),
          limit: z.number().int().min(1).max(50).optional().describe('Default 20'),
        },
        annotations: readOnly,
      },
      (args) => run('search_symbols', args, () => tools.searchSymbols(args)),
    ),

    server.registerTool(
      'get_file_outline',
      {
        title: 'Get file outline',
        description:
          'A file\'s imports and its symbols\' signatures and line ranges, nested, without bodies. ' +
          'Far cheaper than reading the file; then get_symbol_source for the parts you need.',
        inputSchema: {
          path: z.string().min(1).describe('Relative to the workspace root, or absolute'),
        },
        annotations: readOnly,
      },
      (args) => run('get_file_outline', args, () => tools.getFileOutline(args)),
    ),

    server.registerTool(
      'get_symbol_source',
      {
        title: 'Get symbol source',
        description:
          'Source of symbols, read from disk: every overload and partial-class part. Read several at once with ' +
          'qualified_names (one call instead of one per symbol). Large types return their member list.',
        inputSchema: {
          qualified_name: z.string().min(1).optional()
            .describe('From search_symbols or get_file_outline, e.g. "src/orders:OrderService.find", "com.acme.Invoice"; a plain name if unique'),
          qualified_names: z.array(z.string().min(1)).max(MAX_SOURCE_NAMES).optional()
            .describe(`Several symbols in one call (up to ${MAX_SOURCE_NAMES})`),
          max_lines: z.number().int().min(10).max(2000).optional().describe('Summarize beyond this (default 250)'),
          with_callees: z.boolean().optional().describe('Add signatures of what it calls'),
        },
        annotations: readOnly,
      },
      (args) => run('get_symbol_source', args, () => tools.getSymbolSource(args)),
    ),

    server.registerTool(
      'find_references',
      {
        title: 'Find references',
        description:
          'Who uses a symbol: callers, their callers and the tests that reach it (blast radius), subclasses and type ' +
          'references, each with the calling method and the code of the first callers; then other lines naming it. ' +
          'Use for "who calls / which tests" questions and before changing or renaming code, instead of searching files.',
        inputSchema: {
          qualified_name: z.string().min(1).describe('As for get_symbol_source'),
          depth: z.number().int().min(1).max(MAX_BLAST_DEPTH).optional()
            .describe(`Levels of callers (default ${DEFAULT_BLAST_DEPTH}, usually enough; 1 for direct uses only)`),
        },
        annotations: readOnly,
      },
      (args) => run('find_references', args, () => tools.findReferences(args)),
    ),

    server.registerTool(
      'get_repo_map',
      {
        title: 'Get repo map',
        description:
          'The most-used symbols with signatures, grouped by file, within a token budget. ' +
          'Use first to get oriented in an unfamiliar codebase or folder.',
        inputSchema: {
          token_budget: z.number().int().min(100).max(20000).optional().describe('Default 1000'),
          path: z.string().min(1).optional().describe('Only code under this folder or file'),
        },
        annotations: readOnly,
      },
      (args) => run('get_repo_map', args, () => tools.getRepoMap(args)),
    ),
  ];
  if (!decision().enabled) {
    for (const t of registered) t.disable();
  }
  return { server, registered };
}

/**
 * `refdex mcp`: the MCP server AI clients (Claude Code, Copilot agent mode) start over stdio.
 * Read-only: the daemon keeps the index up to date, this process only queries it.
 */
export async function serveMcp(root: string, dbPath: string, version: string, opts: McpOptions = { tools: 'auto', minTokens: DEFAULT_MIN_TOKENS }): Promise<void> {
  const tools = new RefdexTools(root, dbPath);
  let decision = toolsDecision(dbPath, opts);
  const usage = new UsageLog(dbPath);
  const { server, registered } = createServer(root, version, tools, usage, opts, () => decision);

  let recheck: NodeJS.Timeout | undefined;
  if (!decision.enabled && opts.tools === 'auto') {
    // The codebase may grow past the threshold (or get its first index) while the client runs:
    // add the tools then, which tells the client that the tool list changed.
    recheck = setInterval(() => {
      decision = toolsDecision(dbPath, opts);
      if (!decision.enabled) return;
      clearInterval(recheck);
      process.stderr.write(`refdex mcp: tools on (${decision.reason})\n`);
      for (const t of registered) t.enable();
    }, RECHECK_MS);
    recheck.unref();
  }

  const transport = new StdioServerTransport();
  transport.onclose = () => {
    clearInterval(recheck);
    tools.close();
  };
  await server.connect(transport);
}
