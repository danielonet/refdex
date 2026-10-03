import { createServer as createHttpServer, type IncomingMessage } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer, toolsDecision, type McpOptions } from './mcp.ts';
import { RefdexTools } from './tools.ts';
import { UsageLog } from './usage.ts';

/**
 * `refdex mcp --http <port>`, debug builds only (refdex.build.json `"debug": true`): the same tools
 * over MCP's Streamable HTTP transport, for testing them with curl instead of typing JSON-RPC into
 * stdio. main.ts imports this module behind the build flag, so release bundles don't contain it.
 *
 * Stateless: every POST to /mcp is answered by a fresh server with plain JSON, so no session has to
 * be carried between requests. Listens on 127.0.0.1 only and rejects other Host headers (DNS
 * rebinding protection). Calls are logged like any client's, named after the User-Agent.
 */
export async function serveMcpHttp(root: string, dbPath: string, version: string, port: number, opts: McpOptions): Promise<void> {
  const tools = new RefdexTools(root, dbPath);
  const usage = new UsageLog(dbPath);
  const host = '127.0.0.1';
  const http = createHttpServer(async (req, res) => {
    const reply = (status: number, message: string) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
    };
    if (new URL(req.url ?? '/', 'http://localhost').pathname !== '/mcp') return reply(404, 'Not found: POST JSON-RPC requests to /mcp');
    if (req.method !== 'POST') return reply(405, 'Method not allowed: this stateless server only takes POST');
    let body: unknown;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return reply(400, 'Parse error: the body must be a JSON-RPC request');
    }
    // Decided per request, so a codebase that grows past the threshold gets its tools right away.
    const decision = toolsDecision(dbPath, opts);
    const { server } = createServer(root, version, tools, usage, opts, () => decision, req.headers['user-agent'] ?? 'http');
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      enableDnsRebindingProtection: true,
      allowedHosts: [`${host}:${port}`, `localhost:${port}`],
    });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      if (!res.headersSent) reply(500, e instanceof Error ? e.message : String(e));
    }
  });
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(port, host, resolve);
  });
  process.stderr.write(`refdex mcp: debug HTTP server on http://${host}:${port}/mcp for ${root}\n`);
  const stop = () => {
    http.close();
    tools.close();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => (data += chunk));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}
