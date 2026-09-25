import * as assert from 'assert';
import { basename, dirname } from 'path';
import * as vscode from 'vscode';
import type { Daemon } from '../../daemon';

interface Api {
  daemon: Daemon;
  openFolder(folder: vscode.WorkspaceFolder): Promise<void>;
}

suite('RefDex in a multi-root workspace', () => {
  let api: Api;
  let folders: readonly vscode.WorkspaceFolder[];

  suiteSetup(async () => {
    const ext = vscode.extensions.getExtension<Api>('danielonnet.refdex');
    assert.ok(ext);
    api = await ext.activate();
    folders = vscode.workspace.workspaceFolders ?? [];
    assert.deepStrictEqual(folders.map((f) => f.name), ['typescript', 'python']);
  });

  test('indexes one folder at a time, each into its own index', async () => {
    await api.openFolder(folders[0]);
    const first = api.daemon;
    assert.strictEqual(first.root, folders[0].uri.fsPath);
    await vscode.commands.executeCommand('refdex.generateIndex');
    assert.deepStrictEqual((await first.stats()).byLanguage.map((l) => l.language).sort(), ['tsx', 'typescript']);

    await api.openFolder(folders[1]);
    const second = api.daemon;
    assert.notStrictEqual(second, first);
    assert.strictEqual(second.root, folders[1].uri.fsPath);
    assert.strictEqual(first.running, false, 'the previous folder\'s daemon is stopped');
    assert.notStrictEqual(dirname(second.dbPath), dirname(first.dbPath));
    assert.match(basename(dirname(second.dbPath)), /^python-[0-9a-f]{8}$/);
    await vscode.commands.executeCommand('refdex.generateIndex');
    assert.deepStrictEqual((await second.stats()).byLanguage.map((l) => l.language), ['python']);

    // Back to the first: its index is still there.
    await api.openFolder(folders[0]);
    assert.strictEqual(api.daemon.root, folders[0].uri.fsPath);
    assert.ok((await api.daemon.stats()).files > 0);
  });
});
