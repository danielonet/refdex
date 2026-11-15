import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import * as vscode from 'vscode';
import { indexPathFor, localFolders } from './session';

/**
 * Loads workspace folders into Neo4j: each folder is a repository in an app, by default named
 * after the workspace. The bundled CLI does the loading (`refdex neo4j load --json`, see
 * server/src/neo4j-load.ts) in a background process, one folder at a time, from the folder's index.
 *
 * The password lives in VS Code's secret storage (the OS keychain), keyed by server and user, and
 * reaches the CLI in its environment, never on its command line. Without a saved password, the
 * CLI uses the local default for a server on this machine (the README's Docker Compose setup).
 */

/** The defaults, which match neo4j/compose.yaml; see LOCAL_NEO4J in server/src/neo4j-load.ts. */
const DEFAULT_URI = 'neo4j://localhost:7687';
const DEFAULT_USER = 'neo4j';

/** workspaceState key of the last load, for the About view. */
const LAST_LOAD_KEY = 'refdex.neo4j.lastLoad';

export interface Neo4jSettings {
  uri: string;
  user: string;
  /** Empty: the server's default database. */
  database: string;
  app: string;
  external: boolean;
}

export interface LastLoad {
  app: string;
  uri: string;
  at: string;
  repositories: { name: string; nodes: number; relationships: number }[];
}

export interface Neo4jState {
  settings: Neo4jSettings;
  /** A password is saved for this server and user. */
  saved: boolean;
  /** The server is on this machine, where the local default password applies. */
  local: boolean;
  lastLoad?: LastLoad;
}

interface ServerInfo {
  address: string;
  version: string;
  edition: string;
  database: string;
  apps: { name: string; repositories: string[] }[];
}

interface LoadSummary {
  app: string;
  repo: string;
  nodes: Record<string, number>;
  relationships: Record<string, number>;
  deleted: number;
  ms: number;
}

/** What `refdex neo4j queries --json` prints (core/src/neo4j-queries.ts). */
interface StarterQueries {
  app: string;
  queries: { name: string; title: string; description: string; view: 'graph' | 'table'; cypher: string }[];
  /** All of them as one Cypher file, with comments. */
  script: string;
}

/** A failed CLI run: `kind` as the CLI reports it (auth, unreachable, other) or `cancelled`. */
class Neo4jError extends Error {
  constructor(readonly kind: string, message: string) {
    super(message);
  }
}

export function neo4jSettings(): Neo4jSettings {
  const cfg = vscode.workspace.getConfiguration('refdex.neo4j');
  return {
    uri: cfg.get<string>('uri', DEFAULT_URI).trim() || DEFAULT_URI,
    user: cfg.get<string>('username', DEFAULT_USER).trim() || DEFAULT_USER,
    database: cfg.get<string>('database', '').trim(),
    app: cfg.get<string>('app', '').trim() || workspaceAppName(),
    external: cfg.get<boolean>('includeExternal', false),
  };
}

/** The workspace's name, without the " (Workspace)" VS Code adds for a .code-workspace file. */
function workspaceAppName(): string {
  return (vscode.workspace.name ?? 'workspace').replace(/ \(Workspace\)$/, '');
}

export function isLocalNeo4j(uri: string): boolean {
  try {
    const host = new URL(uri.replace(/^[a-z0-9+]+:/i, 'http:')).hostname;
    return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(host);
  } catch {
    return false;
  }
}

export class Neo4jIntegration implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  /** Fires when the connection or the last load changes, for the About view. */
  readonly onDidChange = this.changed.event;
  /** One load at a time: two would write the same repositories. */
  private loading = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: vscode.LogOutputChannel,
    /** The extension's workspace storage, where the folders' indexes are; undefined without a folder. */
    private readonly storage: vscode.Uri | undefined,
  ) {}

  async state(): Promise<Neo4jState> {
    const settings = neo4jSettings();
    return {
      settings,
      saved: !!(await this.savedPassword(settings)),
      local: isLocalNeo4j(settings.uri),
      lastLoad: this.context.workspaceState.get<LastLoad>(LAST_LOAD_KEY),
    };
  }

  /** "Connect to Neo4j…": asks for the address, user and password, checks them and saves them. */
  async connect(): Promise<boolean> {
    const current = neo4jSettings();
    const uri = await vscode.window.showInputBox({
      title: 'Connect to Neo4j (1/3): server',
      prompt: 'Bolt address. The default is Neo4j on this computer (Docker or Neo4j Desktop). For Neo4j Aura or another server online, use its neo4j+s:// address.',
      value: current.uri,
      ignoreFocusOut: true,
      validateInput: (v) => (/^(neo4j|bolt)(\+s|\+ssc)?:\/\/\S+$/.test(v.trim()) ? undefined : 'Use neo4j://host:7687, or neo4j+s://host for TLS'),
    });
    if (uri === undefined) {
      return false;
    }
    const user = await vscode.window.showInputBox({ title: 'Connect to Neo4j (2/3): username', value: current.user, ignoreFocusOut: true });
    if (!user) {
      return false;
    }
    const target = { ...current, uri: uri.trim(), user: user.trim() };
    const local = isLocalNeo4j(target.uri);
    const password = await vscode.window.showInputBox({
      title: 'Connect to Neo4j (3/3): password',
      prompt: `Password of ${target.user}. RefDex keeps it in VS Code's secret storage, not in settings.` +
        (local ? ' Leave it empty to use the local default, refdex-local (the Docker Compose setup in the README).' : ''),
      password: true,
      ignoreFocusOut: true,
    });
    if (password === undefined || (!password && !local)) {
      return false;
    }
    let info: ServerInfo;
    try {
      info = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `RefDex: connecting to ${target.uri}…` },
        () => this.check(target, password || undefined),
      );
    } catch (e) {
      const again = await vscode.window.showErrorMessage(`RefDex: ${errorMessage(e)}`, 'Try Again');
      return again ? this.connect() : false;
    }
    await updateSetting('uri', target.uri, DEFAULT_URI);
    await updateSetting('username', target.user, DEFAULT_USER);
    if (password) {
      await this.context.secrets.store(secretKey(target), password);
    } else {
      await this.context.secrets.delete(secretKey(target));
    }
    this.changed.fire();
    const apps = info.apps.length ? ` It has ${info.apps.length} RefDex app${info.apps.length === 1 ? '' : 's'}: ${info.apps.map((a) => a.name).join(', ')}.` : '';
    void vscode.window.showInformationMessage(`RefDex: connected to Neo4j ${info.version} (${info.edition}) at ${target.uri}.${apps}`, 'Load into Neo4j')
      .then((a) => a && vscode.commands.executeCommand('refdex.neo4jLoad'));
    return true;
  }

  /** "Forget Neo4j Password": removes the saved password of the configured server and user. */
  async forget(): Promise<void> {
    const settings = neo4jSettings();
    await this.context.secrets.delete(secretKey(settings));
    this.changed.fire();
    void vscode.window.showInformationMessage(`RefDex: forgot the password of ${settings.user} at ${settings.uri}.`);
  }

  /** "Load into Neo4j…": loads the chosen workspace folders as repositories of the app. */
  async load(): Promise<void> {
    if (this.loading) {
      void vscode.window.showInformationMessage('RefDex: a load into Neo4j is already running.');
      return;
    }
    this.loading = true;
    try {
      await this.loadFolders();
    } finally {
      this.loading = false;
    }
  }

  private async loadFolders(): Promise<void> {
    if (!this.storage) {
      void vscode.window.showWarningMessage('RefDex: open a folder to index it.');
      return;
    }
    const storage = this.storage;
    const indexed = localFolders().filter((f) => existsSync(indexPathFor(storage, f)));
    if (!indexed.length) {
      const generate = await vscode.window.showWarningMessage('RefDex: no workspace folder has an index yet.', 'Generate Index');
      if (generate) {
        await vscode.commands.executeCommand('refdex.generateIndex');
      }
      return;
    }
    let settings = neo4jSettings();
    let folders = indexed;
    if (indexed.length > 1) {
      const picked = await vscode.window.showQuickPick(
        indexed.map((f) => ({ label: f.name, description: f.uri.fsPath, picked: true, folder: f })),
        { title: `Load into Neo4j app "${settings.app}"`, placeHolder: 'Repositories to load; each replaces its previous load', canPickMany: true },
      );
      if (!picked?.length) {
        return;
      }
      folders = picked.map((p) => p.folder);
    }

    // Check the login first: ask for it when the saved one (or the local default) doesn't work.
    let password = await this.savedPassword(settings);
    try {
      await this.check(settings, password);
    } catch (e) {
      if (!(e instanceof Neo4jError) || e.kind !== 'auth') {
        await this.showFailure(e);
        return;
      }
      if (!(await this.connect())) {
        return;
      }
      settings = neo4jSettings();
      password = await this.savedPassword(settings);
    }

    const names = repositoryNames(folders);
    const loaded: LastLoad['repositories'] = [];
    const cancelled = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `RefDex: loading into Neo4j app "${settings.app}"`, cancellable: true },
      async (progress, token) => {
        for (const [i, folder] of folders.entries()) {
          const repo = names[i];
          const step = folders.length > 1 ? ` (${i + 1} of ${folders.length})` : '';
          progress.report({ message: `${repo}${step}` });
          try {
            const s = await this.loadFolder(folder, repo, settings, password, token, (stage, rows) =>
              progress.report({ message: `${repo}${step}: ${stage === 'removing the previous graph' ? 'removing its previous load' : stage}, ${rows.toLocaleString()} rows` }));
            loaded.push({ name: repo, nodes: sum(s.nodes), relationships: sum(s.relationships) });
            this.log.info(`neo4j: loaded ${repo} into app ${s.app} at ${settings.uri} in ${s.ms} ms (${sum(s.nodes)} nodes, ${sum(s.relationships)} relationships, ${s.deleted} replaced)`);
          } catch (e) {
            if (e instanceof Neo4jError && e.kind === 'cancelled') {
              return repo;
            }
            await this.showFailure(e, repo);
            return undefined;
          } finally {
            progress.report({ increment: 100 / folders.length });
          }
        }
        return undefined;
      },
    );
    if (loaded.length) {
      await this.context.workspaceState.update(LAST_LOAD_KEY, { app: settings.app, uri: settings.uri, at: new Date().toISOString(), repositories: loaded } satisfies LastLoad);
      this.changed.fire();
    }
    if (cancelled) {
      void vscode.window.showWarningMessage(`RefDex: loading cancelled. ${cancelled} is incomplete in Neo4j until you load it again.`);
    } else if (loaded.length === folders.length) {
      const what = loaded.length === 1 ? loaded[0].name : `${loaded.length} repositories`;
      const counts = `${sum(loaded.map((r) => r.nodes)).toLocaleString()} nodes, ${sum(loaded.map((r) => r.relationships)).toLocaleString()} relationships`;
      const actions = [...(isLocalNeo4j(settings.uri) ? ['Open Neo4j Browser'] : []), 'Starter Queries'];
      const action = await vscode.window.showInformationMessage(`RefDex: loaded ${what} into Neo4j app "${settings.app}" (${counts}).`, ...actions);
      if (action === 'Open Neo4j Browser') {
        await vscode.env.openExternal(vscode.Uri.parse(neo4jBrowserUrl(settings.uri)));
      } else if (action === 'Starter Queries') {
        await this.starterQueries();
      }
    }
  }

  /**
   * "Neo4j Starter Queries…": the queries a load stores with the app, for people new to Cypher.
   * Picking one copies it for Neo4j Browser; "Open all" shows them in an editor.
   */
  async starterQueries(): Promise<void> {
    const settings = neo4jSettings();
    const storage = this.storage;
    // Names in the queries come from an indexed folder; without one they are placeholders.
    const folder = storage && localFolders().find((f) => existsSync(indexPathFor(storage, f)));
    const source = folder ? ['--root', folder.uri.fsPath, '--db', indexPathFor(storage, folder)] : ['--repo', settings.app];
    let list: StarterQueries;
    try {
      [list] = (await this.run(['neo4j', 'queries', '--app', settings.app, ...source], undefined)) as unknown as StarterQueries[];
    } catch (e) {
      await this.showFailure(e);
      return;
    }
    type Item = vscode.QuickPickItem & { query?: StarterQueries['queries'][number]; all?: boolean };
    const items: Item[] = [
      { label: '$(file-code) Open all in an editor', detail: 'Every starter query with what it shows, as one Cypher file', all: true },
      { label: '', kind: vscode.QuickPickItemKind.Separator },
      ...list.queries.map((q) => ({ label: `${q.view === 'graph' ? '$(type-hierarchy)' : '$(table)'} ${q.title}`, detail: q.description, query: q })),
    ];
    const picked = await vscode.window.showQuickPick(items, {
      title: `Neo4j starter queries for app "${settings.app}"`,
      placeHolder: 'Pick one to copy it, then paste it into Neo4j Browser',
      matchOnDetail: true,
    });
    if (picked?.all) {
      const language = (await vscode.languages.getLanguages()).includes('cypher') ? 'cypher' : 'plaintext';
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ language, content: list.script }));
    } else if (picked?.query) {
      await vscode.env.clipboard.writeText(picked.query.cypher);
      const actions = isLocalNeo4j(settings.uri) ? ['Open Neo4j Browser'] : [];
      const action = await vscode.window.showInformationMessage(
        `RefDex: copied "${picked.query.title}". Paste it into Neo4j Browser's editor and run it with Ctrl+Enter (Cmd+Enter on a Mac).`, ...actions);
      if (action) {
        await vscode.env.openExternal(vscode.Uri.parse(neo4jBrowserUrl(settings.uri)));
      }
    }
  }

  dispose(): void {
    this.changed.dispose();
  }

  private async savedPassword(s: Pick<Neo4jSettings, 'uri' | 'user'>): Promise<string | undefined> {
    return (await this.context.secrets.get(secretKey(s))) || undefined;
  }

  private async check(s: Neo4jSettings, password: string | undefined): Promise<ServerInfo> {
    const [info] = await this.run(['neo4j', 'check', ...connectionArgs(s)], password);
    return info as unknown as ServerInfo;
  }

  private async loadFolder(folder: vscode.WorkspaceFolder, repo: string, s: Neo4jSettings, password: string | undefined,
    token: vscode.CancellationToken, onProgress: (stage: string, rows: number) => void): Promise<LoadSummary> {
    const args = [
      'neo4j', 'load', '--root', folder.uri.fsPath, '--db', indexPathFor(this.storage!, folder), '--app', s.app, '--repo', repo,
      ...connectionArgs(s), ...(s.external ? ['--external'] : []),
    ];
    const events = await this.run(args, password, token, (e) => {
      if (e.event === 'progress') {
        onProgress(String(e.stage), Number(e.rows));
      }
    });
    return events.find((e) => e.event === 'done') as unknown as LoadSummary;
  }

  /**
   * Runs the bundled CLI with `--json` and returns the JSON lines it printed. Rejects with the
   * failure it reports (or its last line on stderr), or `cancelled` once the token fires.
   */
  private run(args: string[], password: string | undefined, token?: vscode.CancellationToken,
    onEvent?: (e: Record<string, unknown>) => void): Promise<Record<string, unknown>[]> {
    const script = vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'daemon', 'refdex.cjs').fsPath;
    const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
    delete env.REFDEX_NEO4J_PASSWORD;
    if (password) {
      env.REFDEX_NEO4J_PASSWORD = password;
    }
    this.log.info(`neo4j: refdex ${args.join(' ')} --json`);
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [script, ...args, '--json'], { env });
      const events: Record<string, unknown>[] = [];
      let stderr = '';
      const cancel = token?.onCancellationRequested(() => child.kill());
      createInterface({ input: child.stdout }).on('line', (line) => {
        try {
          const e = JSON.parse(line) as Record<string, unknown>;
          events.push(e);
          onEvent?.(e);
        } catch {
          this.log.info(line);
        }
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
        this.log.append(chunk.toString());
      });
      child.on('error', (e) => reject(new Neo4jError('other', e.message)));
      child.on('close', (code) => {
        cancel?.dispose();
        if (token?.isCancellationRequested) {
          reject(new Neo4jError('cancelled', 'cancelled'));
        } else if (code === 0) {
          resolve(events.filter((e) => e.event !== 'progress'));
        } else {
          const failure = events.find((e) => e.event === 'error');
          const last = stderr.trim().split('\n').at(-1) || `refdex exited with code ${code}`;
          reject(new Neo4jError(String(failure?.kind ?? 'other'), String(failure?.message ?? last)));
        }
      });
    });
  }

  private async showFailure(e: unknown, repo?: string): Promise<void> {
    const prefix = repo ? `RefDex: loading ${repo} into Neo4j failed: ` : 'RefDex: ';
    const unreachable = e instanceof Neo4jError && e.kind === 'unreachable';
    const actions = unreachable ? ['How to Start Neo4j', 'Connection Settings…'] : ['Show Log'];
    const action = await vscode.window.showErrorMessage(`${prefix}${errorMessage(e)}`, ...actions);
    if (action === 'How to Start Neo4j') {
      await this.openReadme();
    } else if (action === 'Connection Settings…') {
      await vscode.commands.executeCommand('workbench.action.openSettings', 'refdex.neo4j');
    } else if (action === 'Show Log') {
      this.log.show();
    }
  }

  /** The extension's README, whose Neo4j section shows how to start a local server. */
  private async openReadme(): Promise<void> {
    // Packaging lowercases the root readme to readme.md; the source tree has README.md.
    for (const name of ['README.md', 'readme.md']) {
      const uri = vscode.Uri.joinPath(this.context.extensionUri, name);
      if (existsSync(uri.fsPath)) {
        await vscode.commands.executeCommand('markdown.showPreview', uri);
        return;
      }
    }
  }
}

/** Neo4j Browser of a local server, on its default HTTP port. */
function neo4jBrowserUrl(uri: string): string {
  const host = new URL(uri.replace(/^[a-z0-9+]+:/i, 'http:')).hostname;
  return `http://${host}:7474/browser/`;
}

function connectionArgs(s: Neo4jSettings): string[] {
  return ['--uri', s.uri, '--user', s.user, ...(s.database ? ['--database', s.database] : [])];
}

function secretKey(s: Pick<Neo4jSettings, 'uri' | 'user'>): string {
  return `refdex.neo4j.password:${s.uri}:${s.user}`;
}

/** Folder names, made unique within the app: two folders called `api` become `api` and `api (2)`. */
function repositoryNames(folders: readonly vscode.WorkspaceFolder[]): string[] {
  const seen = new Map<string, number>();
  return folders.map((f) => {
    const n = (seen.get(f.name) ?? 0) + 1;
    seen.set(f.name, n);
    return n === 1 ? f.name : `${f.name} (${n})`;
  });
}

/** Changes a setting where it is set, so a workspace value doesn't shadow the change. */
async function updateSetting(key: string, value: string, defaultValue: string): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('refdex.neo4j');
  const inspected = cfg.inspect<string>(key);
  if ((cfg.get<string>(key) || defaultValue) === value) {
    return;
  }
  const target = inspected?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
  await cfg.update(key, value === defaultValue && target === vscode.ConfigurationTarget.Global ? undefined : value, target);
}

function sum(values: Record<string, number> | number[]): number {
  return (Array.isArray(values) ? values : Object.values(values)).reduce((a, b) => a + b, 0);
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
