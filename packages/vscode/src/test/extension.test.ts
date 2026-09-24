import * as assert from 'assert';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as vscode from 'vscode';
import type { Daemon } from '../daemon';
import { installedSqliteEditors } from '../openDatabase';

suite('RefDex extension', () => {
  let daemon: Daemon;

  suiteSetup(async () => {
    const ext = vscode.extensions.getExtension<{ daemon: Daemon }>('danielonnet.refdex');
    assert.ok(ext, 'extension is installed in the test host');
    daemon = (await ext.activate()).daemon;
  });

  test('generates the index', async () => {
    await vscode.commands.executeCommand('refdex.generateIndex');
    const stats = await daemon.stats();
    assert.ok(stats.files >= 7, JSON.stringify(stats));
    assert.ok(stats.resolvedImports > 0);
    const hits = await daemon.search('OrderMod');
    assert.strictEqual(hits[0]?.qualified_name, 'src/models/order:OrderModel');
  });

  test('regenerates the index from scratch', async () => {
    await vscode.commands.executeCommand('refdex.generateIndex');
    const info = await daemon.info();
    assert.ok(info.watching, 'watching after indexing');
    assert.ok(info.dbBytes > 0);
  });

  test('browses and exports tables', async () => {
    const tables = await daemon.tables();
    assert.deepStrictEqual(tables.map((t) => t.name), ['files', 'symbols', 'imports', 'symbol_parts', 'edges']);
    const page = await daemon.browse('symbols', 'order', 0, 5);
    assert.ok(page.total > 0 && page.rows.length <= 5);
    const dir = mkdtempSync(join(tmpdir(), 'refdex-ext-'));
    try {
      const { rows } = await daemon.exportCsv('files', join(dir, 'files.csv'));
      assert.strictEqual(readFileSync(join(dir, 'files.csv'), 'utf8').trimEnd().split('\r\n').length, rows + 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('opens the About view and the database browser', async () => {
    await vscode.commands.executeCommand('workbench.view.extension.refdex');
    await vscode.commands.executeCommand('refdex.browseDatabase');
    await new Promise((r) => setTimeout(r, 500));
    const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs.map((t) => t.label));
    assert.ok(tabs.includes('RefDex Database'), tabs.join());
  });

  test('finds SQLite viewer extensions by their custom editor pattern', () => {
    // None are installed in the test host; the scan itself must not fail.
    assert.deepStrictEqual(installedSqliteEditors('index.db'), []);
  });
});
