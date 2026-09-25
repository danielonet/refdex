import { appendFile, rename, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** Rotated to `.1` beyond this size, so the log stays small. */
const MAX_BYTES = 2_000_000;

/** A tool call, or (with `event: 'connect'`) a client starting a session. */
export interface UsageRecord {
  /** ISO time of the call. */
  t: string;
  /** MCP `clientInfo.name`, e.g. "claude-code" or "Visual Studio Code". */
  client: string;
  clientVersion?: string;
  event?: 'connect';
  tool?: string;
  /** The tool's arguments, long strings clipped. */
  args?: Record<string, unknown>;
  ms?: number;
  /** Characters returned to the client; roughly 4 per token. */
  chars?: number;
  /** Set when the tool failed. */
  error?: string;
}

/**
 * Appends one JSON line per MCP tool call (and one per client session) to `mcp-usage.jsonl` beside
 * the index. The index itself
 * is read-only for the MCP server; this log is its only write. The IDE plugins read it to show
 * calls per AI client, and it feeds the token-savings measurement.
 */
export class UsageLog {
  readonly path: string;
  private checked = 0;

  constructor(dbPath: string) {
    this.path = join(dirname(dbPath), 'mcp-usage.jsonl');
  }

  record(entry: UsageRecord): Promise<void> {
    return this.write(entry.args ? { ...entry, args: clipArgs(entry.args) } : entry);
  }

  private async write(entry: UsageRecord): Promise<void> {
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

const MAX_ARG_LENGTH = 200;

function clipArgs(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).map(([k, v]) =>
    [k, typeof v === 'string' && v.length > MAX_ARG_LENGTH ? `${v.slice(0, MAX_ARG_LENGTH)}…` : v]));
}
