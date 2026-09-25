import { existsSync } from 'node:fs';
import * as vscode from 'vscode';
import { AboutViewProvider } from './aboutView';
import { COPILOT_CHAT_ID, isInstalled, registerCopilotProvider } from './clients';
import { DatabaseBrowser } from './databaseBrowser';
import type { Daemon } from './daemon';
import { exportCsv, openDatabase } from './openDatabase';
import { FolderSession, indexPathFor } from './session';
import { StatusReport } from './statusReport';

/** workspaceState key of the folder the user picked, as a URI string. */
const FOLDER_KEY = 'refdex.folder';

/** Folders RefDex can index: those on disk (not virtual file systems). */
function localFolders(): readonly vscode.WorkspaceFolder[] {
  return (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file');
}

export async function activate(context: vscode.ExtensionContext) {
  // A log channel: timestamps and levels, and every daemon request and MCP call (see session.ts).
  const log = vscode.window.createOutputChannel('RefDex', { log: true });
  const status = new StatusReport();
  context.subscriptions.push(log, status, vscode.commands.registerCommand('refdex.showLog', () => log.show()));

  // The index lives in the extension's per-workspace storage, not in the user's repo.
  const storage = context.storageUri;
  const about = new AboutViewProvider(context, undefined);
  context.subscriptions.push(vscode.window.registerWebviewViewProvider(AboutViewProvider.viewType, about));
  if (!storage || !localFolders().length) {
    status.noFolder();
    const needFolder = () => vscode.window.showWarningMessage('RefDex: open a folder to index it.');
    context.subscriptions.push(
      ...['refdex.generateIndex', 'refdex.updateIndex', 'refdex.searchSymbols', 'refdex.openDatabase', 'refdex.browseDatabase',
        'refdex.exportCsv', 'refdex.connectClaudeCode', 'refdex.selectFolder', 'refdex.toggleWatch']
        .map((id) => vscode.commands.registerCommand(id, needFolder)),
    );
    return;
  }
  await vscode.workspace.fs.createDirectory(storage);

  // ---- the folder being indexed; commands act on whichever is current ----
  let session: FolderSession | undefined;
  const version = (context.extension.packageJSON as { version: string }).version;
  const copilot = isInstalled(COPILOT_CHAT_ID) ? registerCopilotProvider(() => session?.mcpCommand(), version) : undefined;
  if (copilot) {
    context.subscriptions.push(copilot);
    log.info('Copilot Chat found: registered RefDex as an MCP server for agent mode');
  }
  const sessionContext = { context, log, status, about, copilot, storage };

  // Folder switches run one at a time, in order.
  let switching: Promise<void> = Promise.resolve();
  const openFolder = (folder: vscode.WorkspaceFolder | undefined) =>
    (switching = switching.then(async () => {
      if (session && folder && session.root === folder.uri.fsPath) {
        return;
      }
      session?.dispose();
      session = undefined;
      DatabaseBrowser.close();
      if (!folder) {
        about.setDaemon(undefined);
        status.noFolder();
        return;
      }
      await context.workspaceState.update(FOLDER_KEY, folder.uri.toString());
      session = await FolderSession.open(sessionContext, folder);
    }).catch((e) => log.error(`could not open ${folder?.uri.fsPath}: ${e}`)));

  const withSession = (fn: (s: FolderSession) => unknown) => () => {
    if (session) {
      return fn(session);
    }
    return vscode.window.showWarningMessage('RefDex: open a folder to index it.');
  };

  const saved = context.workspaceState.get<string>(FOLDER_KEY);
  await openFolder(localFolders().find((f) => f.uri.toString() === saved) ?? localFolders()[0]);

  context.subscriptions.push(
    // Generate when there is no index yet, regenerate from scratch when there is.
    vscode.commands.registerCommand('refdex.generateIndex', withSession((s) => s.runIndex(s.indexed))),
    vscode.commands.registerCommand('refdex.updateIndex', withSession((s) => s.runIndex(false))),
    vscode.commands.registerCommand('refdex.searchSymbols', withSession((s) => searchSymbols(s.daemon, log))),
    vscode.commands.registerCommand('refdex.openDatabase', withSession((s) => openDatabase(context, s.daemon))),
    vscode.commands.registerCommand('refdex.browseDatabase', withSession((s) =>
      DatabaseBrowser.show(context, s.daemon, (table, filter) => exportCsv(s.daemon, table, filter)))),
    vscode.commands.registerCommand('refdex.exportCsv', withSession((s) => exportCsv(s.daemon))),
    vscode.commands.registerCommand('refdex.connectClaudeCode', withSession((s) => s.connectClaudeCode())),
    vscode.commands.registerCommand('refdex.selectFolder', () => selectFolder(storage, session, openFolder)),
    vscode.commands.registerCommand('refdex.toggleWatch', async () => {
      // Change the setting where it is set, so a workspace value does not shadow the change.
      const cfg = vscode.workspace.getConfiguration('refdex');
      const inspected = cfg.inspect<boolean>('watch');
      const target = inspected?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
      await cfg.update('watch', !cfg.get<boolean>('watch', true), target);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('refdex')) {
        session?.restart();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      // The indexed folder was removed: fall back to the first one. Otherwise just update the count.
      if (!session || !localFolders().some((f) => f.uri.fsPath === session!.root)) {
        void openFolder(localFolders()[0]);
      } else {
        void session.showStats();
        void about.refresh();
      }
    }),
    { dispose: () => session?.dispose() },
  );

  // For the integration tests.
  return {
    get daemon(): Daemon {
      return session!.daemon;
    },
    clientState: () => session!.clientState(),
    openFolder: (folder: vscode.WorkspaceFolder) => openFolder(folder),
  };
}

/** Lets the user pick which workspace folder RefDex indexes and serves to AI clients. */
async function selectFolder(
  storage: vscode.Uri,
  current: FolderSession | undefined,
  open: (folder: vscode.WorkspaceFolder) => Promise<void>,
): Promise<void> {
  const folders = localFolders();
  if (folders.length < 2) {
    void vscode.window.showInformationMessage('RefDex: only one folder is open, and RefDex already indexes it.');
    return;
  }
  type Item = vscode.QuickPickItem & { folder: vscode.WorkspaceFolder };
  const items: Item[] = folders.map((folder) => {
    const isCurrent = folder.uri.fsPath === current?.root;
    return {
      label: `$(${isCurrent ? 'check' : 'root-folder'}) ${folder.name}`,
      description: folder.uri.fsPath,
      detail: isCurrent ? 'Indexed now' : existsSync(indexPathFor(storage, folder)) ? 'Has an index' : 'Not indexed yet',
      folder,
    };
  });
  const picked = await vscode.window.showQuickPick(items, {
    title: 'RefDex: Select Workspace Folder',
    placeHolder: 'Which folder should RefDex index and serve to AI assistants?',
  });
  if (picked) {
    await open(picked.folder);
  }
}

async function searchSymbols(daemon: Daemon, log: vscode.LogOutputChannel) {
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
      log.error(String(e));
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
