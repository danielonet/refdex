import { createHash } from 'node:crypto';
import { watch } from 'node:fs';
import { basename, dirname } from 'node:path';
import * as vscode from 'vscode';
import type { AboutViewProvider } from './aboutView';
import {
  CLAUDE_CODE_ID, ClaudeCodeSetup, COPILOT_CHAT_ID, isInstalled, serverCommand,
  type AiToolsSettings, type ClaudeScope, type ClientState, type ServerCommand,
} from './clients';
import { Daemon, type DaemonOptions, type IndexStats } from './daemon';
import { DatabaseBrowser } from './databaseBrowser';
import type { StatusReport } from './statusReport';
import { clientName, readUsage, usageLogPath, UsageTail, type UsageRecord } from './usage';

export function daemonOptions(): DaemonOptions {
  const cfg = vscode.workspace.getConfiguration('refdex');
  return {
    exclude: cfg.get<string[]>('exclude', []),
    include: cfg.get<string[]>('include', []),
    languages: cfg.get<string[]>('languages', []),
    watch: cfg.get<boolean>('watch', true),
  };
}

export function aiToolsSettings(): AiToolsSettings {
  const cfg = vscode.workspace.getConfiguration('refdex');
  return { mode: cfg.get<AiToolsSettings['mode']>('aiTools', 'auto'), minTokens: cfg.get<number>('aiToolsMinTokens', 100_000) };
}

/** Whether AI clients get RefDex's tools for this folder, and why. */
export interface AiToolsState {
  enabled: boolean;
  reason: string;
}

/** What every folder session shares: the extension's UI and its Copilot registration. */
export interface SessionContext {
  context: vscode.ExtensionContext;
  log: vscode.LogOutputChannel;
  status: StatusReport;
  about: AboutViewProvider;
  /** Present when Copilot Chat is installed; refreshed so it serves the current folder. */
  copilot?: { refresh(): void };
  /** The extension's storage for this workspace. */
  storage: vscode.Uri;
}

/**
 * Where a folder's index lives. A single-folder window keeps `index.db` at the top of the
 * extension's workspace storage (as before multi-root support); a multi-root workspace gets one
 * subfolder per workspace folder, so each keeps its own index.
 */
export function indexPathFor(storage: vscode.Uri, folder: vscode.WorkspaceFolder): string {
  if (!vscode.workspace.workspaceFile) {
    return vscode.Uri.joinPath(storage, 'index.db').fsPath;
  }
  const root = folder.uri.fsPath;
  const key = `${basename(root).replace(/[^\w.-]/g, '_')}-${createHash('sha1').update(root).digest('hex').slice(0, 8)}`;
  return vscode.Uri.joinPath(storage, 'folders', key, 'index.db').fsPath;
}

/**
 * Everything tied to the one workspace folder RefDex indexes: its daemon, its index, Claude Code's
 * entry for it and the MCP usage log beside the index. Switching folders disposes the session and
 * opens a new one; commands always act on the current session.
 */
export class FolderSession implements vscode.Disposable {
  readonly root: string;
  readonly daemon: Daemon;
  readonly claude: ClaudeCodeSetup;
  private stats: IndexStats | undefined;
  /** Last decision, to notice when the codebase crosses the threshold. */
  private toolsEnabled: boolean | undefined;
  private indexing: Thenable<void> | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly timers = new Set<NodeJS.Timeout>();

  static async open(ctx: SessionContext, folder: vscode.WorkspaceFolder): Promise<FolderSession> {
    const dbPath = indexPathFor(ctx.storage, folder);
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(dirname(dbPath)));
    const session = new FolderSession(ctx, folder, dbPath);
    await session.start();
    return session;
  }

  private constructor(
    private readonly ctx: SessionContext,
    readonly folder: vscode.WorkspaceFolder,
    readonly dbPath: string,
  ) {
    this.root = folder.uri.fsPath;
    this.daemon = new Daemon(ctx.context.extensionUri, this.root, dbPath, daemonOptions(), ctx.log);
    this.claude = new ClaudeCodeSetup(this.root, ctx.log);
    this.disposables.push(this.daemon);
  }

  get indexed(): boolean {
    return !!this.stats?.files;
  }

  mcpCommand(): ServerCommand {
    return serverCommand(this.ctx.context.extensionUri, this.root, this.dbPath, aiToolsSettings());
  }

  /**
   * Whether the tools are worth offering: the same rule as the MCP server's (server/src/mcp.ts),
   * which each client's server applies again on its own. Their definitions cost about 1,200
   * tokens per request, more than they save on a small codebase.
   */
  aiTools(): AiToolsState {
    const { mode, minTokens } = aiToolsSettings();
    if (mode === 'always') {
      return { enabled: true, reason: 'always on (settings)' };
    }
    if (mode === 'never') {
      return { enabled: false, reason: 'turned off in settings' };
    }
    if (!this.stats?.files) {
      return { enabled: false, reason: 'no index yet' };
    }
    const tokens = Math.round(this.stats.codeChars / 4);
    const size = `~${tokens.toLocaleString()} tokens of code (threshold ${minTokens.toLocaleString()})`;
    return tokens >= minTokens ? { enabled: true, reason: size } : { enabled: false, reason: `small codebase: ${size}` };
  }

  /** Copilot's server definition: none while the tools are off, so Copilot doesn't start it at all. */
  copilotCommand(): ServerCommand | undefined {
    return this.aiTools().enabled ? this.mcpCommand() : undefined;
  }

  async clientState(): Promise<ClientState> {
    const { copilot } = this.ctx;
    return {
      copilot: { installed: !!copilot || isInstalled(COPILOT_CHAT_ID), registered: !!copilot },
      claude: { installed: isInstalled(CLAUDE_CODE_ID), scope: (await this.claude.current())?.scope, cliFound: !!this.claude.cli() },
    };
  }

  private async start(): Promise<void> {
    const { log, status, about } = this.ctx;
    log.info(`indexing workspace folder ${this.folder.name} (${this.root}); index at ${this.dbPath}`);
    status.update({ stats: undefined, clients: undefined, usage: undefined, folder: this.folderInfo() });
    about.setDaemon(this.daemon);
    this.watchUsage();

    // The daemon re-indexes changed files on its own; keep the status bar, About view and browser in step.
    this.disposables.push(
      this.daemon.onEvent((e) => {
        if (e.event === 'indexing') {
          status.indexing();
        } else if (e.event === 'indexed') {
          void this.showStats(e.stats);
          DatabaseBrowser.refresh();
          if (e.stats.files) {
            void this.offerClaudeCode();
          }
        } else {
          status.failed(e.message);
        }
      }),
    );

    this.daemon.start();
    await this.showStats();
    // Keep an existing Claude Code entry pointing at this version's files, then show client state.
    await this.claude.refreshIfStale(this.mcpCommand());
    await this.refreshClients();
    this.ctx.copilot?.refresh();
    if (this.indexed) {
      void this.offerClaudeCode();
    }
  }

  /** The folder row of the status report; call again when folders are added or removed. */
  folderInfo(): { name: string; path: string; count: number } {
    return { name: this.folder.name, path: this.root, count: vscode.workspace.workspaceFolders?.length ?? 1 };
  }

  async showStats(fresh?: IndexStats): Promise<void> {
    // Keep the last known stats while the daemon restarts (a settings change) rather than
    // briefly showing no index.
    this.stats = fresh ?? (await this.daemon.stats().catch(() => undefined)) ?? this.stats;
    const info = await this.daemon.info().catch(() => undefined);
    const aiTools = this.aiTools();
    this.ctx.status.update({
      stats: this.stats, watching: info?.watching ?? false, watchSetting: daemonOptions().watch, dbBytes: info?.dbBytes, folder: this.folderInfo(), aiTools,
    });
    this.ctx.about.aiTools = aiTools;
    void this.ctx.about.refresh(this.stats);
    if (aiTools.enabled !== this.toolsEnabled) {
      this.ctx.log.info(`AI tools ${aiTools.enabled ? 'on' : 'off'}: ${aiTools.reason}`);
      this.toolsEnabled = aiTools.enabled;
      this.ctx.copilot?.refresh();
    }
    void vscode.commands.executeCommand('setContext', 'refdex.indexed', this.indexed);
  }

  async refreshClients(): Promise<void> {
    const [clients, usage] = await Promise.all([this.clientState(), readUsage(this.dbPath)]);
    this.ctx.about.clients = clients;
    this.ctx.status.update({ clients, usage });
    void this.ctx.about.refresh();
  }

  /**
   * MCP servers run in the AI clients' own processes and append each tool call to a log beside the
   * index. Follow it: every call goes to the RefDex log right away, the counts a moment later.
   */
  private watchUsage(): void {
    const tail = new UsageTail(usageLogPath(this.dbPath));
    void tail.read(); // start at the end of the log
    const debounce = (key: { timer?: NodeJS.Timeout }, ms: number, fn: () => void) => {
      if (key.timer) {
        clearTimeout(key.timer);
        this.timers.delete(key.timer);
      }
      key.timer = setTimeout(() => {
        this.timers.delete(key.timer!);
        fn();
      }, ms);
      this.timers.add(key.timer);
    };
    const tailTimer: { timer?: NodeJS.Timeout } = {};
    const countsTimer: { timer?: NodeJS.Timeout } = {};
    try {
      const watcher = watch(dirname(this.dbPath), (_event, name) => {
        if (name?.toString().startsWith('mcp-usage')) {
          debounce(tailTimer, 100, () => void tail.read().then((records) => records.forEach((r) => this.logUsage(r))));
          debounce(countsTimer, 1000, () => void this.refreshClients());
        }
      });
      this.disposables.push({ dispose: () => watcher.close() });
    } catch (e) {
      this.ctx.log.warn(`cannot watch MCP usage: ${e}`);
    }
  }

  private logUsage(r: UsageRecord): void {
    const who = `${clientName(r.client)}${r.clientVersion ? ` ${r.clientVersion}` : ''}`;
    if (r.event === 'connect') {
      const tools = r.tools === undefined ? '' : `; tools ${r.tools ? 'on' : 'off'}${r.reason ? ` (${r.reason})` : ''}`;
      this.ctx.log.info(`MCP ${who} connected${tools}`);
      return;
    }
    const args = Object.entries(r.args ?? {}).map(([k, v]) => ` ${k}=${JSON.stringify(v)}`).join('');
    if (r.error) {
      this.ctx.log.error(`MCP ${who} → ${r.tool}${args} failed after ${r.ms} ms: ${r.error}`);
    } else {
      const chars = r.chars ?? 0;
      this.ctx.log.info(`MCP ${who} → ${r.tool}${args} · ${r.ms} ms · ${chars.toLocaleString()} chars (~${Math.round(chars / 4).toLocaleString()} tokens)`);
    }
  }

  /** `rebuild`: drop the index and build it from scratch; otherwise re-index what changed. */
  runIndex(rebuild: boolean): Thenable<void> {
    const { log, status } = this.ctx;
    return (this.indexing ??= vscode.window
      .withProgress(
        { location: vscode.ProgressLocation.Notification, title: rebuild ? 'RefDex: regenerating index…' : 'RefDex: indexing workspace…' },
        async () => {
          try {
            const result = rebuild ? await this.daemon.rebuild() : await this.daemon.reindex(true);
            const failed = result.failed.length ? `, ${result.failed.length} failed (see Output > RefDex)` : '';
            for (const f of result.failed) {
              log.warn(`failed: ${f.path}: ${f.error}`);
            }
            vscode.window.showInformationMessage(
              `RefDex: ${result.symbols.toLocaleString()} symbols in ${result.files.toLocaleString()} files ` +
                `(${result.indexed} indexed${rebuild ? '' : `, ${result.unchanged} unchanged`}${failed}) in ${(result.ms / 1000).toFixed(1)} s.`,
            );
          } catch (e) {
            log.error(String(e));
            status.failed(e instanceof Error ? e.message : String(e));
            vscode.window.showErrorMessage(`RefDex: indexing failed: ${e instanceof Error ? e.message : e}`);
          }
        },
      )
      .then(() => {
        this.indexing = undefined;
      }));
  }

  /** Settings changed: restart the daemon with them, and point AI clients at the new tool settings. */
  restart(): void {
    this.ctx.log.info('settings changed; restarting the daemon');
    this.daemon.restart(daemonOptions());
    void this.showStats();
    this.ctx.copilot?.refresh();
    void this.claude.refreshIfStale(this.mcpCommand());
  }

  /** Adds (or removes) RefDex in Claude Code's MCP settings for this folder, in the scope the user picks. */
  async connectClaudeCode(): Promise<void> {
    const claude = this.claude;
    const current = await claude.current();
    type Item = vscode.QuickPickItem & { scope?: ClaudeScope; disconnect?: boolean };
    const items: Item[] = [
      {
        label: '$(lock) This project, only for me',
        description: current?.scope === 'local' ? 'current' : 'recommended',
        detail: 'Adds RefDex to your Claude Code settings for this folder. Nothing is written to the repository.',
        scope: 'local',
      },
      {
        label: '$(repo) This project, in .mcp.json',
        description: current?.scope === 'project' ? 'current' : undefined,
        detail: 'Writes .mcp.json in the workspace root. It holds paths on this machine, so it is not meant to be committed.',
        scope: 'project',
      },
      ...(current ? [{ label: '$(trash) Disconnect', detail: `Remove RefDex from Claude Code (${current.scope === 'local' ? 'your settings' : '.mcp.json'})`, disconnect: true }] : []),
    ];
    const tools = this.aiTools();
    const picked = await vscode.window.showQuickPick(items, {
      title: `Connect RefDex to Claude Code for ${this.folder.name}`,
      // Connecting a small codebase is allowed; say that its tools stay off until it grows.
      placeHolder: tools.enabled ? 'Where should Claude Code find RefDex?' : `RefDex's tools stay off until they pay off (${tools.reason}). Where should Claude Code find RefDex?`,
    });
    if (!picked) {
      return;
    }
    try {
      if (picked.disconnect && current) {
        await claude.disconnect(current.scope);
        void vscode.window.showInformationMessage('RefDex: disconnected from Claude Code.');
      } else if (picked.scope) {
        if (current && current.scope !== picked.scope) {
          await claude.disconnect(current.scope);
        }
        await claude.connect(picked.scope, this.mcpCommand());
        void vscode.window.showInformationMessage(
          `RefDex: connected to Claude Code for this project. Start a new Claude Code session (or run /mcp) to use it` +
            (picked.scope === 'project' ? '; Claude Code asks once to approve servers from .mcp.json.' : '.'),
        );
      }
    } catch (e) {
      void vscode.window.showErrorMessage(`RefDex: could not update Claude Code: ${e instanceof Error ? e.message : e}`);
    } finally {
      await this.refreshClients();
    }
  }

  /** After the first index, offer once per folder to connect Claude Code if it is installed. */
  private async offerClaudeCode(): Promise<void> {
    const state = this.ctx.context.workspaceState;
    // A single-folder window keeps the key it always had.
    const key = vscode.workspace.workspaceFile ? `refdex.claudeOffer:${this.root}` : 'refdex.claudeOffer';
    // Only where it pays off: on a small codebase the tools cost Claude more tokens than they save.
    if (!this.aiTools().enabled || state.get(key) || !(isInstalled(CLAUDE_CODE_ID) || this.claude.cli()) || (await this.claude.current())) {
      return;
    }
    await state.update(key, 'shown');
    const choice = await vscode.window.showInformationMessage(
      `RefDex: connect the index of ${this.folder.name} to Claude Code, so it can look up code instead of reading whole files?`,
      'Connect',
      'Not now',
    );
    if (choice === 'Connect') {
      await this.connectClaudeCode();
    }
  }

  dispose(): void {
    for (const t of this.timers) {
      clearTimeout(t);
    }
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
