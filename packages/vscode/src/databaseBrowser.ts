import * as vscode from 'vscode';
import type { Daemon } from './daemon';
import { getNonce } from './webviewUtil';

const PAGE_SIZE = 100;

type BrowserMessage =
  | { type: 'ready' }
  | { type: 'load'; table: string; filter: string; offset: number }
  | { type: 'open'; path: string; line: number }
  | { type: 'export'; table: string; filter: string };

/**
 * The RefDex database as a grid: a table list, a filter box that matches any column, paging, CSV
 * export of what is shown, and rows with a file and line that open that location. Reads go
 * through the daemon, so no SQLite extension is needed.
 */
export class DatabaseBrowser {
  private static current: DatabaseBrowser | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  static show(context: vscode.ExtensionContext, daemon: Daemon, exportCsv: (table?: string, filter?: string) => Promise<void>): void {
    if (DatabaseBrowser.current) {
      DatabaseBrowser.current.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel('refdex.database', 'RefDex Database', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [],
    });
    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.png');
    DatabaseBrowser.current = new DatabaseBrowser(panel, daemon, exportCsv);
  }

  /** Closes the browser, e.g. when another workspace folder's index is selected. */
  static close(): void {
    DatabaseBrowser.current?.panel.dispose();
  }

  /** Called after re-indexing so an open browser shows fresh counts and rows. */
  static refresh(): void {
    void DatabaseBrowser.current?.panel.webview.postMessage({ type: 'refresh' });
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly daemon: Daemon,
    private readonly exportCsv: (table?: string, filter?: string) => Promise<void>,
  ) {
    panel.webview.html = this.html();
    this.disposables.push(
      panel.webview.onDidReceiveMessage((m: BrowserMessage) => this.onMessage(m)),
      panel.onDidDispose(() => this.dispose()),
    );
  }

  private async onMessage(m: BrowserMessage): Promise<void> {
    try {
      switch (m.type) {
        case 'ready': {
          const tables = await this.daemon.tables();
          await this.panel.webview.postMessage({ type: 'tables', tables, root: this.daemon.root });
          break;
        }
        case 'load': {
          const page = await this.daemon.browse(m.table, m.filter, m.offset, PAGE_SIZE);
          await this.panel.webview.postMessage({ type: 'page', table: m.table, offset: m.offset, pageSize: PAGE_SIZE, ...page });
          break;
        }
        case 'open': {
          const position = new vscode.Position(Math.max(0, m.line - 1), 0);
          await vscode.window.showTextDocument(vscode.Uri.file(m.path), {
            selection: new vscode.Range(position, position),
            viewColumn: vscode.ViewColumn.Beside,
          });
          break;
        }
        case 'export':
          await this.exportCsv(m.table, m.filter);
          break;
      }
    } catch (e) {
      await this.panel.webview.postMessage({ type: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  }

  private dispose(): void {
    DatabaseBrowser.current = undefined;
    for (const d of this.disposables) {
      d.dispose();
    }
  }

  private html(): string {
    const nonce = getNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
<style>
  html, body { height: 100%; margin: 0; }
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); display: flex; }
  nav { width: 190px; flex: none; border-right: 1px solid var(--vscode-panel-border); padding: 8px 0; overflow-y: auto; }
  nav h3 { margin: 4px 12px 8px; font-size: 0.8em; text-transform: uppercase; letter-spacing: 0.04em; color: var(--vscode-descriptionForeground); }
  nav button { display: flex; justify-content: space-between; width: 100%; padding: 5px 12px; border: none; background: none;
    color: var(--vscode-foreground); cursor: pointer; font: inherit; text-align: left; }
  nav button:hover { background: var(--vscode-list-hoverBackground); }
  nav button.active { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  nav .count { color: var(--vscode-descriptionForeground); }
  nav button.active .count { color: inherit; }
  main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
  .toolbar { display: flex; gap: 8px; align-items: center; padding: 8px; border-bottom: 1px solid var(--vscode-panel-border); }
  .toolbar input { flex: 1; min-width: 120px; padding: 4px 6px; background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent); font: inherit; }
  .toolbar input:focus { outline: 1px solid var(--vscode-focusBorder); }
  .toolbar button { padding: 4px 10px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground);
    border: none; border-radius: 2px; cursor: pointer; font: inherit; white-space: nowrap; }
  .toolbar button:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }
  .toolbar button:disabled { opacity: 0.5; cursor: default; }
  .toolbar .range { color: var(--vscode-descriptionForeground); white-space: nowrap; }
  .description { padding: 6px 8px; color: var(--vscode-descriptionForeground); font-size: 0.9em; }
  .grid { flex: 1; overflow: auto; }
  table { border-collapse: collapse; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); }
  th, td { padding: 3px 8px; text-align: left; white-space: nowrap; max-width: 420px; overflow: hidden; text-overflow: ellipsis;
    border-bottom: 1px solid var(--vscode-panel-border); }
  th { position: sticky; top: 0; background: var(--vscode-editorGroupHeader-tabsBackground, var(--vscode-editor-background)); font-weight: 600; z-index: 1; }
  tr:hover td { background: var(--vscode-list-hoverBackground); }
  tr.link td { cursor: pointer; }
  td.null { color: var(--vscode-disabledForeground, var(--vscode-descriptionForeground)); font-style: italic; }
  td.num { text-align: right; }
  .message { padding: 16px; color: var(--vscode-descriptionForeground); }
  .error { color: var(--vscode-errorForeground); }
</style>
</head>
<body>
  <nav><h3>Tables</h3><div id="tables"></div></nav>
  <main>
    <div class="toolbar">
      <input id="filter" type="search" placeholder="Filter rows (matches any column)" />
      <span class="range" id="range"></span>
      <button id="prev" title="Previous page">‹ Prev</button>
      <button id="next" title="Next page">Next ›</button>
      <button id="export" title="Save the rows matching the filter as a CSV file">Export CSV…</button>
    </div>
    <div class="description" id="description"></div>
    <div class="grid" id="grid"><div class="message">Loading…</div></div>
  </main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const state = Object.assign({ table: 'symbols', filter: '', offset: 0 }, vscode.getState() || {});
    let tables = [];
    let root = '';
    let page;
    const $ = (id) => document.getElementById(id);
    $('filter').value = state.filter;

    const save = () => vscode.setState(state);
    const load = () => { save(); vscode.postMessage({ type: 'load', table: state.table, filter: state.filter, offset: state.offset }); };
    const rel = (p) => (typeof p === 'string' && root && p.startsWith(root + '/')) ? p.slice(root.length + 1) : p;
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

    function renderTables() {
      $('tables').innerHTML = tables.map((t) =>
        '<button data-table="' + t.name + '" class="' + (t.name === state.table ? 'active' : '') + '" title="' + esc(t.description) + '">' +
        '<span>' + t.name + '</span><span class="count">' + t.rows.toLocaleString() + '</span></button>').join('');
      document.querySelectorAll('nav button').forEach((b) => b.addEventListener('click', () => {
        state.table = b.dataset.table; state.offset = 0; renderTables(); load();
      }));
      const t = tables.find((t) => t.name === state.table);
      $('description').textContent = t ? t.description : '';
    }

    function renderPage() {
      const { columns, rows, total, offset, pageSize } = page;
      $('range').textContent = total ? (offset + 1).toLocaleString() + '–' + (offset + rows.length).toLocaleString() + ' of ' + total.toLocaleString() : '0 rows';
      $('prev').disabled = offset === 0;
      $('next').disabled = offset + rows.length >= total;
      if (!rows.length) {
        $('grid').innerHTML = '<div class="message">' + (state.filter ? 'No rows match the filter.' : 'This table is empty.') + '</div>';
        return;
      }
      // Rows with a file path and a line open that location when clicked.
      const pathCol = columns.indexOf('path');
      const lineCol = columns.indexOf('start_line') >= 0 ? columns.indexOf('start_line') : columns.indexOf('line');
      const head = '<tr>' + columns.map((c) => '<th>' + esc(c) + '</th>').join('') + '</tr>';
      const body = rows.map((r, i) => {
        const link = pathCol >= 0;
        return '<tr data-row="' + i + '"' + (link ? ' class="link" title="Click to open ' + esc(rel(r[pathCol])) + (lineCol >= 0 ? ':' + r[lineCol] : '') + '"' : '') + '>' +
          r.map((v) => {
            if (v === null) return '<td class="null">null</td>';
            const text = rel(v);
            return '<td' + (typeof v === 'number' ? ' class="num"' : '') + ' title="' + esc(text) + '">' + esc(text) + '</td>';
          }).join('') + '</tr>';
      }).join('');
      $('grid').innerHTML = '<table><thead>' + head + '</thead><tbody>' + body + '</tbody></table>';
      if (pathCol >= 0) {
        document.querySelectorAll('tr.link').forEach((tr) => tr.addEventListener('click', () => {
          const r = rows[Number(tr.dataset.row)];
          vscode.postMessage({ type: 'open', path: r[pathCol], line: lineCol >= 0 ? r[lineCol] : 1 });
        }));
      }
      $('grid').scrollTop = 0;
    }

    let timer;
    $('filter').addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => { state.filter = $('filter').value; state.offset = 0; load(); }, 250);
    });
    $('prev').addEventListener('click', () => { state.offset = Math.max(0, state.offset - page.pageSize); load(); });
    $('next').addEventListener('click', () => { state.offset += page.pageSize; load(); });
    $('export').addEventListener('click', () => vscode.postMessage({ type: 'export', table: state.table, filter: state.filter }));

    window.addEventListener('message', ({ data }) => {
      if (data.type === 'tables') {
        tables = data.tables; root = data.root;
        if (!tables.some((t) => t.name === state.table)) state.table = tables[0].name;
        renderTables(); load();
      } else if (data.type === 'page') {
        page = data; renderPage();
      } else if (data.type === 'refresh') {
        vscode.postMessage({ type: 'ready' });
      } else if (data.type === 'error') {
        $('grid').innerHTML = '<div class="message error">' + esc(data.message) + '</div>';
      }
    });
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}
