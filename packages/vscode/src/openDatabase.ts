import { basename, join } from 'node:path';
import * as vscode from 'vscode';
import { DatabaseBrowser } from './databaseBrowser';
import type { Daemon } from './daemon';

interface SqliteEditor {
  viewType: string;
  displayName: string;
  extension: string;
}

/**
 * Custom editors from installed extensions that open *.db files (SQLite Viewer and the like).
 * Found by their `customEditors` contribution, so any such extension works, not a fixed list.
 */
export function installedSqliteEditors(dbFileName: string): SqliteEditor[] {
  const out: SqliteEditor[] = [];
  for (const ext of vscode.extensions.all) {
    const editors = (ext.packageJSON?.contributes?.customEditors ?? []) as {
      viewType: string;
      displayName?: string;
      selector?: { filenamePattern?: string }[];
    }[];
    for (const editor of editors) {
      if (editor.selector?.some((s) => s.filenamePattern && globMatches(s.filenamePattern, dbFileName))) {
        out.push({
          viewType: editor.viewType,
          displayName: editor.displayName ?? editor.viewType,
          extension: ext.packageJSON.displayName ?? ext.id,
        });
      }
    }
  }
  return out;
}

/** The "Open Database" picker: RefDex's grid, any installed SQLite viewer, CSV export, file actions. */
export async function openDatabase(context: vscode.ExtensionContext, daemon: Daemon): Promise<void> {
  const dbUri = vscode.Uri.file(daemon.dbPath);
  const editors = installedSqliteEditors(basename(daemon.dbPath));
  type Item = vscode.QuickPickItem & { run?: () => Promise<unknown> | unknown };
  const items: Item[] = [
    {
      label: '$(table) Browse in RefDex',
      description: 'built in',
      detail: 'Grid of every table with filtering, paging, CSV export and jump-to-source',
      run: () => DatabaseBrowser.show(context, daemon, (table, filter) => exportCsv(daemon, table, filter)),
    },
    ...editors.map<Item>((e) => ({
      label: `$(extensions) Open with ${e.displayName}`,
      description: e.extension,
      detail: 'Shows a snapshot of the index; reopen it to see later changes',
      run: async () => {
        // Viewers read index.db directly, so move the write-ahead log into it first.
        await daemon.checkpoint();
        await vscode.commands.executeCommand('vscode.openWith', dbUri, e.viewType);
      },
    })),
    {
      label: '$(export) Export a table to CSV…',
      detail: 'Save files, symbols, imports, symbol_parts or edges as a .csv file and open it',
      run: () => exportCsv(daemon),
    },
    { label: '', kind: vscode.QuickPickItemKind.Separator },
    ...(editors.length
      ? []
      : [
          {
            label: '$(cloud-download) Find a SQLite viewer extension…',
            detail: 'Search the Marketplace; once installed it shows up in this list',
            run: () => vscode.commands.executeCommand('workbench.extensions.search', 'sqlite viewer'),
          },
        ]),
    {
      label: '$(copy) Copy database path',
      description: daemon.dbPath,
      run: async () => {
        await vscode.env.clipboard.writeText(daemon.dbPath);
        void vscode.window.showInformationMessage('RefDex: database path copied. Stop VS Code before writing to it with other tools.');
      },
    },
    {
      label: '$(folder-opened) Reveal database file',
      run: async () => {
        await daemon.checkpoint();
        await vscode.commands.executeCommand('revealFileInOS', dbUri);
      },
    },
  ];
  const picked = await vscode.window.showQuickPick(items, { title: 'Open RefDex Database', placeHolder: 'How do you want to open the index database?' });
  await picked?.run?.();
}

/** Asks for a table (unless given) and a file, writes the CSV through the daemon, then opens it. */
export async function exportCsv(daemon: Daemon, table?: string, filter?: string): Promise<void> {
  if (!table) {
    const tables = await daemon.tables();
    const picked = await vscode.window.showQuickPick(
      tables.map((t) => ({ label: t.name, description: `${t.rows.toLocaleString()} rows`, detail: t.description })),
      { title: 'Export RefDex table to CSV' },
    );
    if (!picked) {
      return;
    }
    table = picked.label;
  }
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? daemon.root;
  const target = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(join(folder, `refdex-${table}.csv`)),
    filters: { CSV: ['csv'] },
    title: `Export ${table}${filter ? ` (filter: ${filter})` : ''} to CSV`,
  });
  if (!target) {
    return;
  }
  const { rows } = await daemon.exportCsv(table, target.fsPath, filter);
  const action = await vscode.window.showInformationMessage(`RefDex: exported ${rows.toLocaleString()} rows to ${basename(target.fsPath)}.`, 'Open');
  if (action === 'Open') {
    await vscode.commands.executeCommand('vscode.open', target);
  }
}

/** Minimal glob match for customEditor filename patterns: `*`, `**`, `?`, `{a,b}`, on the file name. */
function globMatches(pattern: string, fileName: string): boolean {
  const name = pattern.replace(/^(\*\*\/)+/, '');
  let re = '';
  for (let i = 0; i < name.length; i++) {
    const c = name[i];
    if (c === '*') {
      re += name[i + 1] === '*' ? '.*' : '[^/]*';
      if (name[i + 1] === '*') {
        i++;
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '{') {
      const end = name.indexOf('}', i);
      re += `(?:${name.slice(i + 1, end).split(',').map(escapeRe).join('|')})`;
      i = end;
    } else {
      re += escapeRe(c);
    }
  }
  return new RegExp(`^${re}$`, 'i').test(fileName);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
