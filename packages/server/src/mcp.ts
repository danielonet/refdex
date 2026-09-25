import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod';
import { existsSync } from 'node:fs';
import { IndexDb } from '@refdex/core';
import { RefdexTools } from './tools.ts';
import { UsageLog } from './usage.ts';

const INSTRUCTIONS = `RefDex is a method-level index of this workspace's Python, TypeScript, Java and C# code.
Use it to find and read code instead of opening whole files:
1. get_repo_map for an overview of the most used code, when starting in unfamiliar code;
2. search_symbols to find classes, methods and functions by name;
3. get_file_outline to see a file's imports and signatures without its bodies;
4. get_symbol_source to read just the code of one symbol (with_callees adds what it calls);
5. find_references to see where a symbol is used before changing it.
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
 * `refdex mcp`: the MCP server AI clients (Claude Code, Copilot agent mode) start over stdio.
 * Read-only: the daemon keeps the index up to date, this process only queries it.
 */
export async function serveMcp(root: string, dbPath: string, version: string, opts: McpOptions = { tools: 'auto', minTokens: DEFAULT_MIN_TOKENS }): Promise<void> {
  const tools = new RefdexTools(root, dbPath);
  let decision = toolsDecision(dbPath, opts);
  // Without tools, only a short note: the full instructions would be overhead too. Clients get
  // instructions once, at initialize, so in `auto` the note also covers the tools arriving later.
  const instructions = decision.enabled
    ? INSTRUCTIONS
    : `RefDex's code index tools are off for this workspace (${decision.reason}); read files directly.` +
      (opts.tools === 'auto' ? ' If they appear later, use them to find and read code instead of opening whole files.' : '');
  const server = new McpServer({ name: 'refdex', title: 'RefDex code index', version }, { instructions });
  const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  const usage = new UsageLog(dbPath);
  const clientInfo = () => {
    const client = server.server.getClientVersion();
    return { client: client?.name ?? 'unknown', clientVersion: client?.version };
  };
  server.server.oninitialized = () => {
    const { client, clientVersion } = clientInfo();
    process.stderr.write(`refdex mcp: serving ${client} ${clientVersion ?? ''} for ${root}; tools ${decision.enabled ? 'on' : 'off'} (${decision.reason})\n`);
    void usage.record({ t: new Date().toISOString(), ...clientInfo(), event: 'connect', tools: decision.enabled, reason: decision.reason });
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
      'search_symbols',
      {
        title: 'Search symbols',
        description:
          'Find classes, interfaces, functions, methods, properties and fields by name across the workspace. ' +
          'Matches name prefixes (e.g. "OrderServ" finds OrderService; several words must all match). ' +
          'Returns each symbol\'s kind, qualified name, file:line range and signature - usually enough to answer ' +
          'without reading the file. Start here before get_symbol_source or opening files.',
        inputSchema: {
          query: z.string().min(1).describe('Name or name prefix, e.g. "OrderService" or "find"; qualified names like "orders:OrderService" work too'),
          kind: z.enum(['namespace', 'class', 'interface', 'enum', 'type_alias', 'function', 'method', 'property', 'field']).optional()
            .describe('Only symbols of this kind'),
          language: z.enum(['python', 'typescript', 'tsx', 'java', 'csharp']).optional().describe('Only symbols in this language'),
          limit: z.number().int().min(1).max(50).optional().describe('Maximum results (default 20)'),
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
          'Show a file\'s imports (with where each resolves) and every symbol\'s signature and line range, nested by ' +
          'class, without the bodies. Much cheaper than reading the file; use it to understand a file\'s structure, ' +
          'then get_symbol_source for the parts you need.',
        inputSchema: {
          path: z.string().min(1).describe('File path, relative to the workspace root or absolute'),
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
          'Read the source code of one symbol (function, method, class, ...) from disk, with its file and line range. ' +
          'Call only after search_symbols or get_file_outline, when you need implementation details. Overloads and ' +
          'partial classes return every declaration. Large types return their member list instead; then ask for the ' +
          'member you need.',
        inputSchema: {
          qualified_name: z.string().min(1)
            .describe('Qualified name from search_symbols or get_file_outline, e.g. "src/orders:OrderService.find", "shop.orders.Order.total", "com.acme.Invoice"; a plain name works when unique'),
          max_lines: z.number().int().min(10).max(2000).optional().describe('Longest source to return before summarizing (default 250)'),
          with_callees: z.boolean().optional()
            .describe('Also list the signatures of the functions and methods it calls, saving a lookup per callee'),
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
          'List where a symbol is used: calls, subclasses and implementations, and type references the index linked to ' +
          'this declaration, each with the calling symbol; then other lines naming it in the files that import its ' +
          'module or share its package/namespace (imports, values passed around). Use before renaming or changing a signature.',
        inputSchema: {
          qualified_name: z.string().min(1).describe('Qualified name from search_symbols or get_file_outline; a plain name works when unique'),
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
          'A compact map of the most important code: the symbols used most across the workspace (PageRank over calls, ' +
          'inheritance and type references), with their signatures, grouped by file and trimmed to a token budget. ' +
          'Use it first to get oriented in an unfamiliar codebase or folder, then search_symbols or get_symbol_source.',
        inputSchema: {
          token_budget: z.number().int().min(100).max(20000).optional().describe('Approximate size of the answer in tokens (default 1000)'),
          path: z.string().min(1).optional().describe('Only map code under this folder or file (relative to the workspace root or absolute)'),
        },
        annotations: readOnly,
      },
      (args) => run('get_repo_map', args, () => tools.getRepoMap(args)),
    ),
  ];

  let recheck: NodeJS.Timeout | undefined;
  if (!decision.enabled) {
    for (const t of registered) t.disable();
  }
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
