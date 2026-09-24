import * as vscode from 'vscode';
import { AboutViewProvider } from './aboutView';
import { Daemon, type DaemonOptions, type IndexStats } from './daemon';
import { DatabaseBrowser } from './databaseBrowser';
import { exportCsv, openDatabase } from './openDatabase';
import { StatusReport } from './statusReport';

function options(): DaemonOptions {
  const cfg = vscode.workspace.getConfiguration('refdex');
  return { exclude: cfg.get<string[]>('exclude', []), watch: cfg.get<boolean>('watch', true) };
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
      ...['refdex.generateIndex', 'refdex.updateIndex', 'refdex.searchSymbols', 'refdex.openDatabase', 'refdex.browseDatabase', 'refdex.exportCsv']
        .map((id) => vscode.commands.registerCommand(id, needFolder)),
    );
    return;
  }
  await vscode.workspace.fs.createDirectory(storage);
  const daemon = new Daemon(context.extensionUri, root, vscode.Uri.joinPath(storage, 'index.db').fsPath, options(), log);
  const about = new AboutViewProvider(context, daemon);
  context.subscriptions.push(daemon, vscode.window.registerWebviewViewProvider(AboutViewProvider.viewType, about));

  let stats: IndexStats | undefined;
  const showStats = async (fresh?: IndexStats) => {
    stats = fresh ?? (await daemon.stats().catch(() => undefined));
    const watching = stats?.files ? (await daemon.info().catch(() => undefined))?.watching ?? false : false;
    status.update(stats, watching);
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
  // For the integration tests.
  return { daemon };
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
