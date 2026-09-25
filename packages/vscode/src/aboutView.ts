import { basename } from 'node:path';
import * as vscode from 'vscode';
import type { ClientState } from './clients';
import type { Daemon, DaemonInfo, IndexStats } from './daemon';
import { escapeHtml, formatBytes, getNonce, LANGUAGE_NAMES } from './webviewUtil';

/**
 * The "About" view in RefDex's activity bar panel: version, current configuration and buttons for
 * the commands you would otherwise look for in the Command Palette. Index statistics live in the
 * status bar report instead.
 */
export class AboutViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'refdex.about';
  private view: vscode.WebviewView | undefined;
  private stats: IndexStats | undefined;
  /** Set by the extension once AI clients have been detected. */
  clients: ClientState | undefined;
  /** Whether AI clients get the tools, set with each index update. */
  aiTools: { enabled: boolean; reason: string } | undefined;
  /** The daemon of the indexed folder; replaced when the user switches folders. */
  private daemon: Daemon | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    daemon: Daemon | undefined,
  ) {
    this.daemon = daemon;
  }

  /** Shows another folder's index. */
  setDaemon(daemon: Daemon | undefined): void {
    this.daemon = daemon;
    this.stats = undefined;
    this.clients = undefined;
    this.aiTools = undefined;
    void this.refresh();
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true, localResourceRoots: [this.context.extensionUri] };
    webviewView.webview.onDidReceiveMessage((message: { type: string; command?: string; args?: unknown[] }) => {
      if (message.type === 'command' && message.command) {
        void vscode.commands.executeCommand(message.command, ...(message.args ?? []));
      } else if (message.type === 'openReadme') {
        void this.openReadme();
      }
    });
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        void this.refresh();
      }
    });
    webviewView.onDidDispose(() => (this.view = undefined));
    void this.refresh();
  }

  /** Re-renders with the latest index state (the action button reads "Generate" or "Regenerate"). */
  async refresh(stats?: IndexStats): Promise<void> {
    if (stats) {
      this.stats = stats;
    }
    if (!this.view?.visible) {
      return;
    }
    let info: DaemonInfo | undefined;
    if (this.daemon) {
      [info, this.stats] = await Promise.all([
        this.daemon.info().catch(() => undefined),
        this.stats ? Promise.resolve(this.stats) : this.daemon.stats().catch(() => undefined),
      ]);
    }
    if (this.view) {
      this.view.webview.html = this.html(this.view.webview, info);
    }
  }

  private async openReadme(): Promise<void> {
    // Packaging lowercases the root readme to readme.md; the source tree has README.md.
    for (const name of ['README.md', 'readme.md']) {
      const uri = vscode.Uri.joinPath(this.context.extensionUri, name);
      try {
        await vscode.workspace.fs.stat(uri);
        await vscode.commands.executeCommand('markdown.showPreview', uri);
        return;
      } catch {
        // try the next candidate
      }
    }
    void vscode.window.showWarningMessage('RefDex: could not find README.md in the installed extension.');
  }

  private html(webview: vscode.Webview, info: DaemonInfo | undefined): string {
    const pkg = this.context.extension.packageJSON as { version?: string; description?: string };
    const cfg = vscode.workspace.getConfiguration('refdex');
    const exclude = cfg.get<string[]>('exclude', []);
    const include = cfg.get<string[]>('include', []);
    const enabled = cfg.get<string[]>('languages', []);
    const watch = cfg.get<boolean>('watch', true);
    const indexed = !!this.stats?.files;
    const folder = this.daemon ? basename(this.daemon.root) : undefined;
    const folderCount = vscode.workspace.workspaceFolders?.length ?? 0;
    const nonce = getNonce();
    const row = (key: string, value: string, title?: string) =>
      `<tr><td class="key">${escapeHtml(key)}</td><td class="val"${title ? ` title="${escapeHtml(title)}"` : ''}>${value}</td></tr>`;
    const languages = enabled.length
      ? enabled.map((l) => LANGUAGE_NAMES[l] ?? l).join(', ')
      : [...new Set(Object.values(LANGUAGE_NAMES))].filter((l) => l !== 'TSX').join(', ');
    const c = this.clients;
    const copilot = !c ? '—' : c.copilot.registered ? 'connected' : c.copilot.installed ? 'not registered' : 'not installed';
    const claude = !c ? '—' : c.claude.scope ? `connected (${c.claude.scope === 'local' ? 'this project, private' : '.mcp.json'})`
      : c.claude.installed || c.claude.cliFound ? 'not connected' : 'not installed';
    const daemonState = !this.daemon
      ? 'not started (no folder open)'
      : info
        ? `running (pid ${info.pid}, Node ${escapeHtml(info.node)})`
        : this.daemon.running ? 'starting…' : 'stopped';

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 0 12px 12px; }
  header { display: flex; align-items: center; gap: 10px; margin: 12px 0 4px; }
  header img { width: 40px; height: 40px; }
  h2 { margin: 0; }
  .version { color: var(--vscode-descriptionForeground); font-size: 0.9em; }
  .desc { margin: 10px 0 16px; line-height: 1.4; }
  h3 { margin: 16px 0 6px; font-size: 0.85em; text-transform: uppercase; letter-spacing: 0.04em; color: var(--vscode-descriptionForeground); }
  table { width: 100%; border-collapse: collapse; margin-bottom: 8px; table-layout: fixed; }
  td { padding: 3px 0; font-size: 0.9em; vertical-align: top; overflow-wrap: anywhere; }
  td.key { color: var(--vscode-descriptionForeground); width: 42%; }
  td.val { font-family: var(--vscode-editor-font-family); }
  button { display: block; width: 100%; margin: 6px 0; padding: 6px 10px; background: var(--vscode-button-background);
    color: var(--vscode-button-foreground); border: none; border-radius: 2px; cursor: pointer; font-size: 0.9em; text-align: left; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button:disabled { opacity: 0.5; cursor: default; }
  .hint { color: var(--vscode-descriptionForeground); font-size: 0.85em; margin-top: 12px; line-height: 1.4; }
</style>
</head>
<body>
  <header>
    <img src="${webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'icon.png'))}" alt="" />
    <div><h2>RefDex</h2><div class="version">v${escapeHtml(pkg.version ?? '0.0.0')}</div></div>
  </header>
  <div class="desc">${escapeHtml(pkg.description ?? '')}</div>

  <h3>Current configuration</h3>
  <table>
    ${row(folderCount > 1 ? `Workspace (1 of ${folderCount})` : 'Workspace', escapeHtml(folder ?? '—'), this.daemon?.root)}
    ${row('Languages', escapeHtml(languages))}
    ${row('Watch for changes', watch ? 'on' : 'off')}
    ${row('Include', include.length ? include.map(escapeHtml).join('<br>') : 'everything')}
    ${row('Exclude', exclude.length ? exclude.map(escapeHtml).join('<br>') : '— (.gitignore only)')}
    ${row('Database', this.daemon ? `index.db${info ? ` (${formatBytes(info.dbBytes)})` : ''}` : '—', this.daemon?.dbPath)}
    ${row('Index', indexed ? 'built' : 'not built yet')}
    ${row('Daemon', daemonState)}
  </table>

  <h3>AI clients</h3>
  <table>
    ${row('Tools', this.aiTools ? escapeHtml(`${this.aiTools.enabled ? 'on' : 'off'}: ${this.aiTools.reason}`) : '—')}
    ${row('Copilot', escapeHtml(copilot))}
    ${row('Claude Code', escapeHtml(claude))}
  </table>

  <h3>Actions</h3>
  <button data-command="refdex.generateIndex">${indexed ? 'Regenerate Index' : 'Generate Index'}</button>
  ${folderCount > 1 ? '<button class="secondary" data-command="refdex.selectFolder">Switch Workspace Folder…</button>' : ''}
  <button class="secondary" data-command="refdex.openDatabase"${indexed ? '' : ' disabled'}>Open Database…</button>
  <button class="secondary" data-command="refdex.searchSymbols"${indexed ? '' : ' disabled'}>Search Symbols</button>
  <button class="secondary" data-command="refdex.connectClaudeCode"${c && (c.claude.installed || c.claude.cliFound) ? '' : ' disabled'}>${c?.claude.scope ? 'Reconnect Claude Code…' : 'Connect Claude Code…'}</button>
  <button class="secondary" data-command="workbench.action.openSettings" data-args='["@ext:danielonnet.refdex"]'>Open Settings</button>
  <button class="secondary" data-command="refdex.showLog">Show Log</button>
  <button class="secondary" id="readme">View README</button>

  <div class="hint">Index statistics are in the RefDex item on the status bar. Click it for the report.</div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.querySelectorAll('button[data-command]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const argsAttr = btn.getAttribute('data-args');
        vscode.postMessage({ type: 'command', command: btn.getAttribute('data-command'), args: argsAttr ? JSON.parse(argsAttr) : [] });
      });
    });
    document.getElementById('readme').addEventListener('click', () => vscode.postMessage({ type: 'openReadme' }));
  </script>
</body>
</html>`;
  }
}
