import { appendFile, rename, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** Rotated to `.1` beyond this size, so the log stays small. */
const MAX_BYTES = 2_000_000;

export interface UsageRecord {
  /** ISO time of the call. */
  t: string;
  /** MCP `clientInfo.name`, e.g. "claude-code" or "Visual Studio Code". */
  client: string;
  clientVersion?: string;
  tool: string;
  ms: number;
  /** Characters returned to the client; roughly 4 per token. */
  chars: number;
}

/**
 * Appends one JSON line per MCP tool call to `mcp-usage.jsonl` beside the index. The index itself
 * is read-only for the MCP server; this log is its only write. The IDE plugins read it to show
 * calls per AI client, and it feeds the token-savings measurement.
 */
export class UsageLog {
  readonly path: string;
  private checked = 0;

  constructor(dbPath: string) {
    this.path = join(dirname(dbPath), 'mcp-usage.jsonl');
  }

  async record(entry: UsageRecord): Promise<void> {
    try {
      if (++this.checked % 100 === 1) {
        const size = (await stat(this.path).catch(() => undefined))?.size ?? 0;
        if (size > MAX_BYTES) await rename(this.path, `${this.path}.1`);
      }
      await appendFile(this.path, `${JSON.stringify(entry)}\n`);
    } catch {
      // Usage stats are best effort; a read-only location must not break the tools.
    }
  }
}
