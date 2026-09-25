import { open, readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface ClientUsage {
  /** Display name, e.g. "Claude Code". */
  name: string;
  calls: number;
  callsToday: number;
  /** Characters of tool output sent to the client; about 4 per token. */
  chars: number;
  lastUsed: string;
}

/** One line of the MCP server's usage log (see server/src/usage.ts). */
export interface UsageRecord {
  t: string;
  client: string;
  clientVersion?: string;
  /** `connect`: a client started a session; otherwise the line is a tool call. */
  event?: 'connect';
  /** On `connect`: whether the server offers its tools, and why. */
  tools?: boolean;
  reason?: string;
  tool?: string;
  args?: Record<string, unknown>;
  ms?: number;
  chars?: number;
  error?: string;
}

const CLIENT_NAMES: Record<string, string> = {
  'claude-code': 'Claude Code',
  'Visual Studio Code': 'Copilot',
  'Visual Studio Code - Insiders': 'Copilot',
};

export function clientName(client: string): string {
  return CLIENT_NAMES[client] ?? client;
}

export function usageLogPath(dbPath: string): string {
  return join(dirname(dbPath), 'mcp-usage.jsonl');
}

/** Tool calls per MCP client, from the log the MCP server appends to (see server/src/usage.ts). */
export async function readUsage(dbPath: string): Promise<ClientUsage[]> {
  const path = usageLogPath(dbPath);
  const text = [await readFile(`${path}.1`, 'utf8').catch(() => ''), await readFile(path, 'utf8').catch(() => '')].join('\n');
  const today = new Date().toISOString().slice(0, 10);
  const byClient = new Map<string, ClientUsage>();
  for (const line of text.split('\n')) {
    if (!line.trim()) {
      continue;
    }
    try {
      const r = JSON.parse(line) as UsageRecord;
      if (!r.tool) {
        continue;
      }
      const name = clientName(r.client);
      const u = byClient.get(name) ?? { name, calls: 0, callsToday: 0, chars: 0, lastUsed: r.t };
      u.calls++;
      u.chars += r.chars ?? 0;
      if (r.t.startsWith(today)) {
        u.callsToday++;
      }
      if (r.t > u.lastUsed) {
        u.lastUsed = r.t;
      }
      byClient.set(name, u);
    } catch {
      // a partly written line
    }
  }
  return [...byClient.values()].sort((a, b) => b.calls - a.calls);
}

/**
 * Follows the usage log like `tail -f`: each `read()` returns the records appended since the last
 * one. It starts at the end, so older calls are not replayed, and starts over after rotation.
 */
export class UsageTail {
  private offset: number | undefined;
  private partial = '';

  constructor(private readonly path: string) {}

  async read(): Promise<UsageRecord[]> {
    const size = (await stat(this.path).catch(() => undefined))?.size ?? 0;
    if (this.offset === undefined || size < this.offset) {
      // First read: skip history. Smaller than before: the log was rotated, read the new one whole.
      const first = this.offset === undefined;
      this.offset = first ? size : 0;
      this.partial = '';
      if (first) {
        return [];
      }
    }
    if (size === this.offset) {
      return [];
    }
    const file = await open(this.path, 'r');
    try {
      const buffer = Buffer.alloc(size - this.offset);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, this.offset);
      this.offset += bytesRead;
      const lines = (this.partial + buffer.subarray(0, bytesRead).toString('utf8')).split('\n');
      this.partial = lines.pop() ?? '';
      const records: UsageRecord[] = [];
      for (const line of lines) {
        try {
          records.push(JSON.parse(line) as UsageRecord);
        } catch {
          // not a record
        }
      }
      return records;
    } finally {
      await file.close();
    }
  }
}
