import { readFile } from 'node:fs/promises';
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

const CLIENT_NAMES: Record<string, string> = {
  'claude-code': 'Claude Code',
  'Visual Studio Code': 'Copilot',
  'Visual Studio Code - Insiders': 'Copilot',
};

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
      const r = JSON.parse(line) as { t: string; client: string; chars: number };
      const name = CLIENT_NAMES[r.client] ?? r.client;
      const u = byClient.get(name) ?? { name, calls: 0, callsToday: 0, chars: 0, lastUsed: r.t };
      u.calls++;
      u.chars += r.chars;
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
