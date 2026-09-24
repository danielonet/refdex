import { watch } from 'node:fs';
import { dirname } from 'node:path';
import * as vscode from 'vscode';
import { AboutViewProvider } from './aboutView';
import {
  CLAUDE_CODE_ID, ClaudeCodeSetup, COPILOT_CHAT_ID, isInstalled, registerCopilotProvider, serverCommand,
  type ClaudeScope, type ClientState,
} from './clients';
import { Daemon, type DaemonOptions, type IndexStats } from './daemon';
import { DatabaseBrowser } from './databaseBrowser';
import { exportCsv, openDatabase } from './openDatabase';
import { StatusReport } from './statusReport';
import { readUsage } from './usage';

function options(): DaemonOptions {
  const cfg = vscode.workspace.getConfiguration('refdex');
  return {
    exclude: cfg.get<string[]>('exclude', []),
    include: cfg.get<string[]>('include', []),
    languages: cfg.get<string[]>('languages', []),
    watch: cfg.get<boolean>('watch', true),
  };
}

export async function activate(context: vscode.ExtensionContext) {
  const log = vscode.window.createOutputChannel('RefDex');
  const status = new StatusReport();
  context.subscriptions.push(log, status, vscode.commands.registerCommand('refdex.showLog', () => log.show()));

  // The index lives in the extension's per-workspace storage, not in the user's repo.
  const storage = context.storageUri;
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!storage || !root) {
    status.noFolder();
    const about = new AboutViewProvider(context, undefined);
    const needFolder = () => vscode.window.showWarningMessage('RefDex: open a folder to index it.');
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(AboutViewProvider.viewType, about),
      ...['refdex.generateIndex', 'refdex.updateIndex', 'refdex.searchSymbols', 'refdex.openDatabase', 'refdex.browseDatabase', 'refdex.exportCsv', 'refdex.connectClaudeCode']
        .map((id) => vscode.commands.registerCommand(id, needFolder)),
    );
    return;
  }
  await vscode.workspace.fs.createDirectory(storage);
  const dbPath = vscode.Uri.joinPath(storage, 'index.db').fsPath;
  const daemon = new Daemon(context.extensionUri, root, dbPath, options(), log);
  const about = new AboutViewProvider(context, daemon);
  context.subscriptions.push(daemon, vscode.window.registerWebviewViewProvider(AboutViewProvider.viewType, about));

  // ---- AI clients: RefDex's MCP server for Copilot (agent mode) and Claude Code ----
  const version = (context.extension.packageJSON as { version: string }).version;
  const mcpCommand = () => serverCommand(context.extensionUri, root, dbPath);
  const copilot = isInstalled(COPILOT_CHAT_ID) ? registerCopilotProvider(mcpCommand, version) : undefined;
  if (copilot) {
    context.subscriptions.push(copilot);
    log.appendLine('Copilot Chat found: registered RefDex as an MCP server for agent mode');
  }
  const claude = new ClaudeCodeSetup(root, log);
  const clientState = async (): Promise<ClientState> => ({
    copilot: { installed: !!copilot || isInstalled(COPILOT_CHAT_ID), registered: !!copilot },
    claude: { installed: isInstalled(CLAUDE_CODE_ID), scope: (await claude.current())?.scope, cliFound: !!claude.cli() },
  });
  const refreshClients = async () => {
    const [clients, usage] = await Promise.all([clientState(), readUsage(dbPath)]);
    about.clients = clients;
    status.update({ clients, usage });
    void about.refresh();
  };
  // Tool calls are logged by the MCP server next to the index; show them as they happen.
  let usageTimer: NodeJS.Timeout | undefined;
  try {
    const usageWatcher = watch(dirname(dbPath), (_event, name) => {
      if (name?.toString().startsWith('mcp-usage')) {
        clearTimeout(usageTimer);
        usageTimer = setTimeout(() => void refreshClients(), 1000);
      }
    });
    context.subscriptions.push({ dispose: () => usageWatcher.close() });
  } catch (e) {
    log.appendLine(`cannot watch MCP usage: ${e}`);
  }

  let stats: IndexStats | undefined;
  const showStats = async (fresh?: IndexStats) => {
    stats = fresh ?? (await daemon.stats().catch(() => undefined));
    const info = await daemon.info().catch(() => undefined);
    status.update({ stats, watching: info?.watching ?? false, watchSetting: options().watch, dbBytes: info?.dbBytes });
    void about.refresh(stats);
    void vscode.commands.executeCommand('setContext', 'refdex.indexed', !!stats?.files);
  };

  // The daemon re-indexes changed files on its own; keep the status bar, About view and browser in step.
  context.subscriptions.push(
    daemon.onEvent((e) => {
      if (e.event === 'indexing') {
        status.indexing();
      } else if (e.event === 'indexed') {
        void showStats(e.stats);
        DatabaseBrowser.refresh();
      } else {
        status.failed(e.message);
      }
    }),
  );

  let indexing: Thenable<void> | undefined;
  /** `rebuild`: drop the index and build it from scratch; otherwise re-index what changed. */
  const runIndex = (rebuild: boolean) =>
    (indexing ??= vscode.window
      .withProgress(
        { location: vscode.ProgressLocation.Notification, title: rebuild ? 'RefDex: regenerating index…' : 'RefDex: indexing workspace…' },
        async () => {
          try {
            const result = rebuild ? await daemon.rebuild() : await daemon.reindex(true);
            const failed = result.failed.length ? `, ${result.failed.length} failed (see Output > RefDex)` : '';
            for (const f of result.failed) {
              log.appendLine(`failed: ${f.path}: ${f.error}`);
            }
            vscode.window.showInformationMessage(
              `RefDex: ${result.symbols.toLocaleString()} symbols in ${result.files.toLocaleString()} files ` +
                `(${result.indexed} indexed${rebuild ? '' : `, ${result.unchanged} unchanged`}${failed}) in ${(result.ms / 1000).toFixed(1)} s.`,
            );
          } catch (e) {
            log.appendLine(String(e));
            status.failed(e instanceof Error ? e.message : String(e));
            vscode.window.showErrorMessage(`RefDex: indexing failed: ${e instanceof Error ? e.message : e}`);
          }
        },
      )
      .then(() => {
        indexing = undefined;
      }));

  const browse = () => DatabaseBrowser.show(context, daemon, (table, filter) => exportCsv(daemon, table, filter));
  context.subscriptions.push(
    // Generate when there is no index yet, regenerate from scratch when there is.
    vscode.commands.registerCommand('refdex.generateIndex', () => runIndex(!!stats?.files)),
    vscode.commands.registerCommand('refdex.updateIndex', () => runIndex(false)),
    vscode.commands.registerCommand('refdex.searchSymbols', () => searchSymbols(daemon, log)),
    vscode.commands.registerCommand('refdex.openDatabase', () => openDatabase(context, daemon)),
    vscode.commands.registerCommand('refdex.browseDatabase', browse),
    vscode.commands.registerCommand('refdex.exportCsv', () => exportCsv(daemon)),
    vscode.commands.registerCommand('refdex.toggleWatch', async () => {
      // Change the setting where it is set, so a workspace value does not shadow the change.
      const cfg = vscode.workspace.getConfiguration('refdex');
      const inspected = cfg.inspect<boolean>('watch');
      const target = inspected?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
      await cfg.update('watch', !options().watch, target);
    }),
    vscode.commands.registerCommand('refdex.connectClaudeCode', () => connectClaudeCode(claude, mcpCommand, refreshClients)),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('refdex')) {
        log.appendLine('settings changed; restarting the daemon');
        daemon.restart(options());
        void showStats();
      }
    }),
  );

  daemon.start();
  await showStats();
  // Keep an existing Claude Code entry pointing at this version's files, then show client state.
  await claude.refreshIfStale(mcpCommand());
  await refreshClients();
  context.subscriptions.push(
    daemon.onEvent((e) => {
      if (e.event === 'indexed' && e.stats.files) {
        void offerClaudeCode(context, claude, mcpCommand, refreshClients);
      }
    }),
  );
  if (stats?.files) {
    void offerClaudeCode(context, claude, mcpCommand, refreshClients);
  }
  // For the integration tests.
  return { daemon, clientState };
}

/** Adds (or removes) RefDex in Claude Code's MCP settings for this project, in the scope the user picks. */
async function connectClaudeCode(claude: ClaudeCodeSetup, cmd: () => ReturnType<typeof serverCommand>, refresh: () => Promise<void>) {
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
  const picked = await vscode.window.showQuickPick(items, { title: 'Connect RefDex to Claude Code', placeHolder: 'Where should Claude Code find RefDex?' });
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
      await claude.connect(picked.scope, cmd());
      void vscode.window.showInformationMessage(
        `RefDex: connected to Claude Code for this project. Start a new Claude Code session (or run /mcp) to use it` +
          (picked.scope === 'project' ? '; Claude Code asks once to approve servers from .mcp.json.' : '.'),
      );
    }
  } catch (e) {
    void vscode.window.showErrorMessage(`RefDex: could not update Claude Code: ${e instanceof Error ? e.message : e}`);
  } finally {
    await refresh();
  }
}

/** After the first index, offer once per workspace to connect Claude Code if it is installed. */
async function offerClaudeCode(
  context: vscode.ExtensionContext,
  claude: ClaudeCodeSetup,
  cmd: () => ReturnType<typeof serverCommand>,
  refresh: () => Promise<void>,
) {
  const key = 'refdex.claudeOffer';
  if (context.workspaceState.get(key) || !(isInstalled(CLAUDE_CODE_ID) || claude.cli()) || (await claude.current())) {
    return;
  }
  await context.workspaceState.update(key, 'shown');
  const choice = await vscode.window.showInformationMessage(
    'RefDex: connect the index to Claude Code, so it can look up code instead of reading whole files?',
    'Connect',
    'Not now',
  );
  if (choice === 'Connect') {
    await connectClaudeCode(claude, cmd, refresh);
  }
}

async function searchSymbols(daemon: Daemon, log: vscode.OutputChannel) {
  const pick = vscode.window.createQuickPick<vscode.QuickPickItem & { hit?: { path: string; line: number } }>();
  pick.placeholder = 'Search indexed symbols by name (e.g. OrderService or find)';
  pick.matchOnDescription = true;
  let request = 0;
  pick.onDidChangeValue(async (query) => {
    const id = ++request;
    if (!query.trim()) {
      pick.items = [];
      return;
    }
    pick.busy = true;
    try {
      const hits = await daemon.search(query);
      if (id !== request) {
        return;
      }
      pick.items = hits.map((h) => ({
        label: `$(${symbolIcon(h.kind)}) ${h.qualified_name}`,
        description: h.signature,
        detail: `${vscode.workspace.asRelativePath(h.path)}:${h.start_line}`,
        tooltip: h.doc ?? undefined,
        alwaysShow: true,
        hit: { path: h.path, line: h.start_line },
      }));
    } catch (e) {
      log.appendLine(String(e));
    } finally {
      if (id === request) {
        pick.busy = false;
      }
    }
  });
  pick.onDidAccept(async () => {
    const hit = pick.selectedItems[0]?.hit;
    pick.hide();
    if (!hit) {
      return;
    }
    const position = new vscode.Position(hit.line - 1, 0);
    await vscode.window.showTextDocument(vscode.Uri.file(hit.path), { selection: new vscode.Range(position, position) });
  });
  pick.onDidHide(() => pick.dispose());
  pick.show();
}

function symbolIcon(kind: string): string {
  switch (kind) {
    case 'class': return 'symbol-class';
    case 'interface': return 'symbol-interface';
    case 'enum': return 'symbol-enum';
    case 'method': return 'symbol-method';
    case 'function': return 'symbol-function';
    case 'property': return 'symbol-property';
    case 'field': return 'symbol-field';
    case 'namespace': return 'symbol-namespace';
    default: return 'symbol-misc';
  }
}

export function deactivate() {}
