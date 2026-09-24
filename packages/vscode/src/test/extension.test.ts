import * as assert from 'assert';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as vscode from 'vscode';
import type { ClientState } from '../clients';
import { ClaudeCodeSetup, serverCommand } from '../clients';
import type { Daemon } from '../daemon';
import { installedSqliteEditors } from '../openDatabase';

suite('RefDex extension', () => {
  let daemon: Daemon;
  let clientState: () => Promise<ClientState>;
  let extensionUri: vscode.Uri;

  suiteSetup(async () => {
    const ext = vscode.extensions.getExtension<{ daemon: Daemon; clientState: () => Promise<ClientState> }>('danielonnet.refdex');
    assert.ok(ext, 'extension is installed in the test host');
    ({ daemon, clientState } = await ext.activate());
    extensionUri = ext.extensionUri;
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

  test('registers with Copilot when Copilot Chat is present', async () => {
    const state = await clientState();
    const copilotPresent = !!vscode.extensions.getExtension('GitHub.copilot-chat');
    assert.strictEqual(state.copilot.installed, copilotPresent);
    assert.strictEqual(state.copilot.registered, copilotPresent);
  });

  test('writes, refreshes and removes the Claude Code .mcp.json entry', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'refdex-claude-'));
    try {
      writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'x' } } }));
      const log = vscode.window.createOutputChannel('RefDex test');
      const setup = new ClaudeCodeSetup(dir, log);
      assert.strictEqual(await setup.current(), undefined);
      const cmd = serverCommand(extensionUri, dir, join(dir, 'index.db'));
      await setup.connect('project', cmd);
      const written = JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf8'));
      assert.deepStrictEqual(Object.keys(written.mcpServers).sort(), ['other', 'refdex']);
      assert.strictEqual(written.mcpServers.refdex.env.ELECTRON_RUN_AS_NODE, '1');
      assert.deepStrictEqual(written.mcpServers.refdex.args.slice(1), ['mcp', '--root', dir, '--db', join(dir, 'index.db')]);
      assert.strictEqual((await setup.current())?.scope, 'project');

      // After an update the daemon path changes; an existing entry follows it.
      await setup.refreshIfStale({ ...cmd, args: ['/new/path/refdex.cjs', ...cmd.args.slice(1)] });
      assert.strictEqual(JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf8')).mcpServers.refdex.args[0], '/new/path/refdex.cjs');

      await setup.disconnect('project');
      assert.deepStrictEqual(Object.keys(JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf8')).mcpServers), ['other']);
      log.dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('finds SQLite viewer extensions by their custom editor pattern', () => {
    // None are installed in the test host; the scan itself must not fail.
    assert.deepStrictEqual(installedSqliteEditors('index.db'), []);
  });
});
