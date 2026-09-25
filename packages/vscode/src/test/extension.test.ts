import * as assert from 'assert';
import { appendFileSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as vscode from 'vscode';
import type { ClientState } from '../clients';
import { ClaudeCodeSetup, serverCommand } from '../clients';
import type { Daemon } from '../daemon';
import { installedSqliteEditors } from '../openDatabase';
import { indexPathFor } from '../session';
import { readUsage, UsageTail } from '../usage';

suite('RefDex extension', () => {
  let daemon: Daemon;
  let clientState: () => Promise<ClientState>;
  let aiTools: () => { enabled: boolean; reason: string };
  let extensionUri: vscode.Uri;

  suiteSetup(async () => {
    const ext = vscode.extensions.getExtension<{ daemon: Daemon; clientState: () => Promise<ClientState>; aiTools: typeof aiTools }>('danielonnet.refdex');
    assert.ok(ext, 'extension is installed in the test host');
    ({ daemon, clientState, aiTools } = await ext.activate());
    extensionUri = ext.extensionUri;
  });

  test('generates the index', async () => {
    await vscode.commands.executeCommand('refdex.generateIndex');
    const stats = await daemon.stats();
    assert.ok(stats.files >= 7, JSON.stringify(stats));
    assert.ok(stats.resolvedImports > 0);
    assert.ok(stats.resolvedEdges > 0 && stats.resolvedEdges <= stats.edges);
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

  test('follows the MCP usage log from its end, across partial lines and rotation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'refdex-usage-'));
    try {
      const path = join(dir, 'mcp-usage.jsonl');
      const call = (tool: string) => `${JSON.stringify({ t: new Date().toISOString(), client: 'claude-code', tool, args: { query: 'x' }, ms: 1, chars: 40 })}\n`;
      writeFileSync(path, call('old'));
      const tail = new UsageTail(path);
      assert.deepStrictEqual(await tail.read(), [], 'history is not replayed');
      appendFileSync(path, `${JSON.stringify({ t: new Date().toISOString(), client: 'claude-code', event: 'connect' })}\n${call('search_symbols')}{"t":"par`);
      const records = await tail.read();
      assert.deepStrictEqual(records.map((r) => r.event ?? r.tool), ['connect', 'search_symbols']);
      assert.deepStrictEqual(records[1].args, { query: 'x' });
      appendFileSync(path, `tial","client":"c","tool":"get_repo_map","ms":1,"chars":1}\n`);
      assert.deepStrictEqual((await tail.read()).map((r) => r.tool), ['get_repo_map']);
      renameSync(path, `${path}.1`);
      writeFileSync(path, call('find_references'));
      assert.deepStrictEqual((await tail.read()).map((r) => r.tool), ['find_references']);
      // Session lines are not calls.
      const usage = await readUsage(join(dir, 'index.db'));
      assert.strictEqual(usage.reduce((n, u) => n + u.calls, 0), 4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('keeps a single-folder index where it always was', () => {
    const folder = vscode.workspace.workspaceFolders![0];
    const storage = vscode.Uri.file('/tmp/storage');
    assert.strictEqual(vscode.workspace.workspaceFile, undefined);
    assert.strictEqual(indexPathFor(storage, folder), join('/tmp/storage', 'index.db'));
    assert.strictEqual(daemon.root, folder.uri.fsPath);
  });

  test('offers AI tools only for a codebase worth it, unless the settings say otherwise', async () => {
    await vscode.commands.executeCommand('refdex.generateIndex');
    // The fixture is a few hundred tokens of code, far below the default threshold.
    const small = aiTools();
    assert.strictEqual(small.enabled, false);
    assert.match(small.reason, /^small codebase: ~\d+ tokens of code \(threshold 100,000\)$/);

    const cfg = vscode.workspace.getConfiguration('refdex');
    try {
      await cfg.update('aiTools', 'always', vscode.ConfigurationTarget.Workspace);
      assert.strictEqual(aiTools().enabled, true);
      await cfg.update('aiTools', 'auto', vscode.ConfigurationTarget.Workspace);
      await cfg.update('aiToolsMinTokens', 10, vscode.ConfigurationTarget.Workspace);
      assert.strictEqual(aiTools().enabled, true);
    } finally {
      await cfg.update('aiTools', undefined, vscode.ConfigurationTarget.Workspace);
      await cfg.update('aiToolsMinTokens', undefined, vscode.ConfigurationTarget.Workspace);
      // Workspace settings are written into the fixture; leave it as it was.
      const dotVscode = join(vscode.workspace.workspaceFolders![0].uri.fsPath, '.vscode');
      if (readFileSync(join(dotVscode, 'settings.json'), 'utf8').replace(/\s/g, '') === '{}') {
        rmSync(dotVscode, { recursive: true, force: true });
      }
    }
    const cmd = serverCommand(extensionUri, '/p', '/p/index.db', { mode: 'auto', minTokens: 5000 });
    assert.deepStrictEqual(cmd.args.slice(-4), ['--tools', 'auto', '--min-tokens', '5000']);
  });

  test('finds SQLite viewer extensions by their custom editor pattern', () => {
    // None are installed in the test host; the scan itself must not fail.
    assert.deepStrictEqual(installedSqliteEditors('index.db'), []);
  });
});
