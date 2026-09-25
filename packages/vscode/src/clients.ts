import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';
import * as vscode from 'vscode';

const run = promisify(execFile);

/** Marketplace IDs; checked on each Marketplace page (Phase 5 re-checks before release). */
export const COPILOT_CHAT_ID = 'GitHub.copilot-chat';
export const CLAUDE_CODE_ID = 'anthropic.claude-code';
const SERVER_NAME = 'refdex';

export type ClaudeScope = 'local' | 'project';

export interface ClientState {
  copilot: { installed: boolean; registered: boolean };
  claude: { installed: boolean; scope: ClaudeScope | undefined; cliFound: boolean };
}

/** The stdio command AI clients start: VS Code's own runtime in Node mode running the bundled daemon. */
export interface ServerCommand {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** When the MCP server offers its tools (`refdex mcp --tools --min-tokens`); see `refdex.aiTools`. */
export interface AiToolsSettings {
  mode: 'auto' | 'always' | 'never';
  minTokens: number;
}

export function serverCommand(extensionUri: vscode.Uri, root: string, dbPath: string, tools?: AiToolsSettings): ServerCommand {
  return {
    command: process.execPath,
    args: [
      vscode.Uri.joinPath(extensionUri, 'dist', 'daemon', 'refdex.cjs').fsPath, 'mcp', '--root', root, '--db', dbPath,
      ...(tools ? ['--tools', tools.mode, '--min-tokens', String(tools.minTokens)] : []),
    ],
    env: { ELECTRON_RUN_AS_NODE: '1' },
  };
}

/**
 * Registers RefDex as an MCP server for VS Code's agent mode (GitHub Copilot). Detection only
 * decides whether to offer this; the server itself behaves the same for every client. `cmd` serves
 * the folder being indexed; call `refresh` when that changes.
 */
export function registerCopilotProvider(cmd: () => ServerCommand | undefined, version: string): vscode.Disposable & { refresh(): void } {
  const changed = new vscode.EventEmitter<void>();
  const registration = vscode.lm.registerMcpServerDefinitionProvider('refdex.mcp', {
    onDidChangeMcpServerDefinitions: changed.event,
    provideMcpServerDefinitions: () => {
      const c = cmd();
      return c ? [new vscode.McpStdioServerDefinition('RefDex', c.command, c.args, c.env, version)] : [];
    },
  });
  return {
    refresh: () => changed.fire(),
    dispose: () => {
      registration.dispose();
      changed.dispose();
    },
  };
}

export function isInstalled(id: string): boolean {
  return !!vscode.extensions.getExtension(id);
}

/**
 * Claude Code's MCP entry for this project: `local` scope lives in ~/.claude.json, private to
 * this user and folder; `project` scope is the folder's shared .mcp.json.
 */
export class ClaudeCodeSetup {
  constructor(
    private readonly root: string,
    private readonly log: vscode.OutputChannel,
  ) {}

  /** Where RefDex is configured for this project, and the entry found there. */
  async current(): Promise<{ scope: ClaudeScope; entry: ServerEntry } | undefined> {
    const local = (await readJson(join(homedir(), '.claude.json')))?.projects?.[this.root]?.mcpServers?.[SERVER_NAME];
    if (local) {
      return { scope: 'local', entry: local };
    }
    const project = (await readJson(join(this.root, '.mcp.json')))?.mcpServers?.[SERVER_NAME];
    return project ? { scope: 'project', entry: project } : undefined;
  }

  /** The Claude Code CLI: on PATH, or the binary bundled with the Claude Code extension. */
  cli(): string | undefined {
    const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
    for (const dir of (process.env.PATH ?? '').split(delimiter)) {
      if (dir && existsSync(join(dir, exe))) {
        return join(dir, exe);
      }
    }
    const ext = vscode.extensions.getExtension(CLAUDE_CODE_ID);
    const bundled = ext && join(ext.extensionPath, 'resources', 'native-binary', exe);
    return bundled && existsSync(bundled) ? bundled : undefined;
  }

  async connect(scope: ClaudeScope, cmd: ServerCommand): Promise<void> {
    const entry: ServerEntry = { type: 'stdio', command: cmd.command, args: cmd.args, env: cmd.env };
    if (scope === 'project') {
      // Merge into .mcp.json, keeping any other servers in it.
      const path = join(this.root, '.mcp.json');
      const config = (await readJson(path)) ?? {};
      config.mcpServers = { ...(config.mcpServers ?? {}), [SERVER_NAME]: entry };
      await writeFile(path, `${JSON.stringify(config, null, 2)}\n`);
      this.log.appendLine(`Claude Code: wrote ${SERVER_NAME} to ${path}`);
      return;
    }
    const cli = this.cli();
    if (!cli) {
      throw new Error('the Claude Code CLI was not found (install Claude Code, or use the shared .mcp.json option)');
    }
    // `add-json` refuses to overwrite, so replace any older entry first.
    await run(cli, ['mcp', 'remove', SERVER_NAME, '--scope', 'local'], { cwd: this.root }).catch(() => undefined);
    await run(cli, ['mcp', 'add-json', SERVER_NAME, JSON.stringify(entry), '--scope', 'local'], { cwd: this.root });
    this.log.appendLine(`Claude Code: added ${SERVER_NAME} for ${this.root} (local scope, via ${cli})`);
  }

  async disconnect(scope: ClaudeScope): Promise<void> {
    if (scope === 'project') {
      const path = join(this.root, '.mcp.json');
      const config = await readJson(path);
      if (config?.mcpServers?.[SERVER_NAME]) {
        delete config.mcpServers[SERVER_NAME];
        await writeFile(path, `${JSON.stringify(config, null, 2)}\n`);
      }
      return;
    }
    const cli = this.cli();
    if (cli) {
      await run(cli, ['mcp', 'remove', SERVER_NAME, '--scope', 'local'], { cwd: this.root });
    }
  }

  /**
   * After an extension update the bundled daemon moves to a new versioned folder; rewrite an
   * existing entry so Claude Code keeps working. Never creates an entry the user did not ask for.
   */
  async refreshIfStale(cmd: ServerCommand): Promise<void> {
    const found = await this.current();
    if (!found || (found.entry.command === cmd.command && JSON.stringify(found.entry.args) === JSON.stringify(cmd.args))) {
      return;
    }
    this.log.appendLine(`Claude Code: updating the ${found.scope} ${SERVER_NAME} entry to this RefDex version`);
    await this.connect(found.scope, cmd).catch((e) => this.log.appendLine(`Claude Code: update failed: ${e}`));
  }
}

interface ServerEntry {
  type?: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

async function readJson(path: string): Promise<any> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return undefined;
  }
}
