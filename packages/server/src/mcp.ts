import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod';
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
 * `refdex mcp`: the MCP server AI clients (Claude Code, Copilot agent mode) start over stdio.
 * Read-only: the daemon keeps the index up to date, this process only queries it.
 */
export async function serveMcp(root: string, dbPath: string, version: string): Promise<void> {
  const tools = new RefdexTools(root, dbPath);
  const server = new McpServer({ name: 'refdex', title: 'RefDex code index', version }, { instructions: INSTRUCTIONS });
  const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  const usage = new UsageLog(dbPath);
  let announced = false;
  /** Runs a tool, logs the call with the client's name, and wraps the text as MCP content. */
  const run = async (tool: string, fn: () => Promise<string>) => {
    const started = performance.now();
    const text = await fn();
    const client = server.server.getClientVersion();
    if (!announced) {
      announced = true;
      process.stderr.write(`refdex mcp: serving ${client?.name ?? 'unknown client'} ${client?.version ?? ''} for ${root}\n`);
    }
    void usage.record({
      t: new Date().toISOString(),
      client: client?.name ?? 'unknown',
      clientVersion: client?.version,
      tool,
      ms: Math.round(performance.now() - started),
      chars: text.length,
    });
    return { content: [{ type: 'text' as const, text }] };
  };

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
    (args) => run('search_symbols', () => tools.searchSymbols(args)),
  );

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
    (args) => run('get_file_outline', () => tools.getFileOutline(args)),
  );

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
    (args) => run('get_symbol_source', () => tools.getSymbolSource(args)),
  );

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
    (args) => run('find_references', () => tools.findReferences(args)),
  );

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
    (args) => run('get_repo_map', () => tools.getRepoMap(args)),
  );

  const transport = new StdioServerTransport();
  transport.onclose = () => tools.close();
  await server.connect(transport);
}
