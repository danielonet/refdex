import * as vscode from 'vscode';
import type { ClientState } from './clients';
import type { IndexStats } from './daemon';
import type { ClientUsage } from './usage';
import { count, formatBytes, LANGUAGE_NAMES, timeAgo } from './webviewUtil';

/**
 * Commands behind the report's links. They are registered in code but not contributed in
 * package.json, so they stay out of the Command Palette: their job is to close the report
 * before the real command opens a progress notification or a picker.
 */
const HOVER_GENERATE = 'refdex.hover.generateIndex';
const HOVER_SEARCH = 'refdex.hover.searchSymbols';
const HOVER_OPEN_DB = 'refdex.hover.openDatabase';
const HOVER_SETTINGS = 'refdex.hover.openSettings';
const HOVER_TOGGLE_WATCH = 'refdex.hover.toggleWatch';
const HOVER_CONNECT_CLAUDE = 'refdex.hover.connectClaudeCode';
/** The ⓘ icons: hovering shows the explanation as a tooltip, clicking shows it as a message. */
const HOVER_EXPLAIN = 'refdex.hover.explain';
/** Clicking the status bar item opens its report instead of doing anything by itself. */
export const SHOW_REPORT = 'refdex.showStatusReport';

const IDLE = '$(refdex-logo)';

const EXPLAIN = {
  symbols: 'Classes, methods, properties and other declarations. AI assistants look these up by name instead of reading whole files.',
  imports: 'Imports that point at code in this workspace. Standard-library and third-party imports stay unresolved on purpose.',
  watch: 'When enabled, saved, created and deleted files are re-indexed within a moment. Only changed files are parsed again.',
  database: 'The index is a SQLite database in VS Code\'s storage for this workspace, not in your repository. Open it to browse or export its tables.',
  regenerate: 'Drops the whole index and builds it again from scratch. Normally not needed: the index updates itself as files change.',
  index: 'RefDex parses Python, TypeScript, Java and C# files into a local symbol index that AI assistants query instead of reading whole files.',
  copilot: 'RefDex is registered as an MCP server for GitHub Copilot agent mode. Copilot starts it when a chat needs its tools.',
  claude: 'Claude Code reads MCP servers from its settings. Connecting adds RefDex for this project only (private to you) or to the shared .mcp.json.',
  calls: 'Tool calls AI clients made to RefDex, with the amount of text returned (about 4 characters per token).',
} as const;
type Topic = keyof typeof EXPLAIN;

export interface ReportState {
  stats: IndexStats | undefined;
  watching: boolean;
  watchSetting: boolean;
  dbBytes: number | undefined;
  clients?: ClientState;
  usage?: ClientUsage[];
}

/**
 * The RefDex item in the status bar (right side, next to Copilot). Its tooltip is the index
 * report, styled after Copilot's status popup: sections fenced by rules, a bold title with grey
 * details on the right, big numbers, thin bars, ⓘ explanations and links as actions.
 *
 * It is a Markdown hover, so layout is limited to what VS Code's hover sanitizer lets through:
 * tables (`width`, `align`), spans coloured with `--vscode-*` theme variables, headings and rules.
 * Codicons render inside that HTML too. Everything sits in table rows so it lines up: cells have
 * padding that plain paragraphs do not.
 */
export class StatusReport implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem('refdex.status', vscode.StatusBarAlignment.Right, 50);
  private state: ReportState = { stats: undefined, watching: false, watchSetting: true, dbBytes: undefined };
  private error: string | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor() {
    this.item.name = 'RefDex';
    this.item.text = IDLE;
    this.item.accessibilityInformation = { label: 'RefDex: code index' };
    // Clicking opens the report; only its links act.
    this.item.command = SHOW_REPORT;
    this.item.tooltip = new vscode.MarkdownString('**RefDex**\n\nReading the index...');
    this.item.show();
    this.disposables.push(
      this.item,
      vscode.commands.registerCommand(SHOW_REPORT, () => this.show()),
      vscode.commands.registerCommand(HOVER_GENERATE, () => this.runFromHover('refdex.generateIndex')),
      vscode.commands.registerCommand(HOVER_SEARCH, () => this.runFromHover('refdex.searchSymbols')),
      vscode.commands.registerCommand(HOVER_OPEN_DB, () => this.runFromHover('refdex.openDatabase')),
      vscode.commands.registerCommand(HOVER_SETTINGS, () => this.runFromHover('workbench.action.openSettings', '@ext:danielonnet.refdex')),
      vscode.commands.registerCommand(HOVER_TOGGLE_WATCH, () => this.runFromHover('refdex.toggleWatch')),
      vscode.commands.registerCommand(HOVER_CONNECT_CLAUDE, () => this.runFromHover('refdex.connectClaudeCode')),
      vscode.commands.registerCommand(HOVER_EXPLAIN, (topic: Topic) => vscode.window.showInformationMessage(`RefDex: ${EXPLAIN[topic] ?? ''}`)),
    );
  }

  update(state: Partial<ReportState>): void {
    this.state = { ...this.state, ...state };
    this.error = undefined;
    this.item.text = IDLE;
    this.item.tooltip = this.report();
  }

  indexing(): void {
    this.item.text = '$(sync~spin)';
    const md = this.markdown();
    md.appendMarkdown(row('<strong>RefDex</strong>', grey('Indexing…')));
    this.item.tooltip = md;
  }

  failed(message: string): void {
    this.error = message;
    this.item.text = `${IDLE} $(warning)`;
    this.item.tooltip = this.report();
  }

  noFolder(): void {
    const md = this.markdown();
    md.appendMarkdown(row('<strong>RefDex</strong>', ''));
    md.appendMarkdown('---\n\n');
    md.appendMarkdown(row(`<strong>Code index</strong> ${info('index')}`, grey('No folder open')));
    this.item.tooltip = md;
  }

  private markdown(): vscode.MarkdownString {
    const md = new vscode.MarkdownString(undefined, true);
    md.supportHtml = true;
    // Links are what a hover has instead of buttons; only RefDex's own commands are trusted.
    md.isTrusted = { enabledCommands: [HOVER_GENERATE, HOVER_SEARCH, HOVER_OPEN_DB, HOVER_SETTINGS, HOVER_TOGGLE_WATCH, HOVER_CONNECT_CLAUDE, HOVER_EXPLAIN] };
    return md;
  }

  private report(): vscode.MarkdownString {
    const md = this.markdown();
    const { stats, watching, watchSetting, dbBytes } = this.state;
    const indexed = !!stats?.files;

    // Title row, with icon buttons on the right like Copilot's.
    const buttons = indexed
      ? `${iconLink('search', HOVER_SEARCH, 'Search symbols')} &nbsp;${iconLink('table', HOVER_OPEN_DB, 'Open database')} &nbsp;${iconLink('settings-gear', HOVER_SETTINGS, 'RefDex settings')}`
      : iconLink('settings-gear', HOVER_SETTINGS, 'RefDex settings');
    md.appendMarkdown(row('<strong>RefDex</strong>', buttons));
    md.appendMarkdown('---\n\n');

    if (this.error) {
      md.appendMarkdown(row(`${colored('$(error)', 'charts-red')} <strong>Last run failed</strong>`, grey('See Output › RefDex')));
      md.appendMarkdown(row(grey(escapeHtml(this.error)), ''));
      md.appendMarkdown('---\n\n');
    }

    if (!stats || !indexed) {
      md.appendMarkdown(row(`<strong>Code index</strong> ${info('index')}`, grey('Not indexed')));
      md.appendMarkdown(link('Index?', HOVER_GENERATE));
      return md;
    }

    // Symbols: the headline number, then one line per language.
    md.appendMarkdown(row(`<strong>Symbols</strong> ${info('symbols')}`, grey(stats.indexedAt ? `Updated ${timeAgo(stats.indexedAt)}` : '')));
    md.appendMarkdown(headline(stats.symbols.toLocaleString(), `in ${count(stats.files, 'file')}`));
    for (const l of stats.byLanguage) {
      md.appendMarkdown(row(LANGUAGE_NAMES[l.language] ?? l.language, grey(`${count(l.symbols, 'symbol')} · ${count(l.files, 'file')}`)));
    }
    md.appendMarkdown('---\n\n');

    // Imports: share resolved to workspace code, as a percentage and a bar.
    const share = stats.imports ? stats.resolvedImports / stats.imports : 0;
    md.appendMarkdown(row(`<strong>Imports resolved</strong> ${info('imports')}`, grey(`${stats.resolvedImports.toLocaleString()} of ${stats.imports.toLocaleString()}`)));
    md.appendMarkdown(headline(`${Math.round(share * 100)}%`, 'to workspace code'));
    md.appendMarkdown(bar(share));
    md.appendMarkdown('---\n\n');

    this.appendClients(md);

    // Settings-style rows: name and ⓘ on the left, state on the right, an action link below.
    md.appendMarkdown(row(`<strong>Watch for changes</strong> ${info('watch')}`, grey(watching ? 'Enabled' : watchSetting ? 'Starting…' : 'Disabled')));
    md.appendMarkdown(link(watchSetting ? 'Disable?' : 'Enable?', HOVER_TOGGLE_WATCH));
    md.appendMarkdown('---\n\n');
    md.appendMarkdown(row(`<strong>Index database</strong> ${info('database')}`, grey(dbBytes !== undefined ? formatBytes(dbBytes) : '')));
    md.appendMarkdown(link('Open?', HOVER_OPEN_DB));
    md.appendMarkdown('---\n\n');
    md.appendMarkdown(row(`<strong>Regenerate index</strong> ${info('regenerate')}`, grey('From scratch')));
    md.appendMarkdown(link('Regenerate?', HOVER_GENERATE));
    return md;
  }

  /** One row per AI client: whether it is connected, and how much it used RefDex. */
  private appendClients(md: vscode.MarkdownString): void {
    const { clients, usage = [] } = this.state;
    if (!clients) {
      return;
    }
    const used = (name: string) => {
      const u = usage.find((x) => x.name === name);
      return u ? ` · ${count(u.calls, 'call')}` : '';
    };
    const copilot = clients.copilot.registered ? `Connected${used('Copilot')}` : clients.copilot.installed ? 'Not registered' : 'Not installed';
    md.appendMarkdown(row(`<strong>Copilot</strong> ${info('copilot')}`, grey(copilot)));
    md.appendMarkdown('---\n\n');
    const claude = clients.claude.scope
      ? `Connected${clients.claude.scope === 'project' ? ' (.mcp.json)' : ''}${used('Claude Code')}`
      : clients.claude.installed || clients.claude.cliFound ? 'Not connected' : 'Not installed';
    md.appendMarkdown(row(`<strong>Claude Code</strong> ${info('claude')}`, grey(claude)));
    if (!clients.claude.scope && (clients.claude.installed || clients.claude.cliFound)) {
      md.appendMarkdown(link('Connect?', HOVER_CONNECT_CLAUDE));
    }
    md.appendMarkdown('---\n\n');
    // Other MCP clients that found RefDex on their own (e.g. configured by hand).
    for (const u of usage.filter((x) => x.name !== 'Copilot' && x.name !== 'Claude Code')) {
      md.appendMarkdown(row(`<strong>${escapeHtml(u.name)}</strong>`, grey(`Connected · ${count(u.calls, 'call')}`)));
      md.appendMarkdown('---\n\n');
    }
    if (usage.length) {
      const calls = usage.reduce((n, u) => n + u.calls, 0);
      const today = usage.reduce((n, u) => n + u.callsToday, 0);
      const tokens = Math.round(usage.reduce((n, u) => n + u.chars, 0) / 4);
      md.appendMarkdown(row(`<strong>Tool calls</strong> ${info('calls')}`, grey(`${today.toLocaleString()} today`)));
      md.appendMarkdown(headline(calls.toLocaleString(), `calls · ~${tokens.toLocaleString()} tokens returned`));
      md.appendMarkdown('---\n\n');
    }
  }

  /**
   * Opens the report. Clicking the item focuses it, and `workbench.action.showHover` opens (and
   * focuses) the hover of the focused element, so the report appears on a click and can be
   * reached from the keyboard, not only by hovering.
   */
  private async show(): Promise<void> {
    try {
      await vscode.commands.executeCommand('workbench.action.showHover');
    } catch {
      // Older VS Code without that command: the report still opens on hover.
    }
  }

  /**
   * Closes the report, then runs `command`. VS Code has no API to close a workbench hover; it
   * closes when focus moves away, so focus goes back to the editor (or the status bar) first.
   */
  private async runFromHover(command: string, ...args: unknown[]): Promise<void> {
    const run = (c: string) => vscode.commands.executeCommand(c).then(undefined, () => undefined);
    const tooltip = this.item.tooltip;
    this.item.tooltip = new vscode.MarkdownString('**RefDex**');
    await run(vscode.window.visibleTextEditors.length ? 'workbench.action.focusActiveEditorGroup' : 'workbench.action.focusStatusBar');
    await run('editor.action.hideHover');
    await new Promise((resolve) => setTimeout(resolve, 80));
    this.item.tooltip = tooltip;
    await vscode.commands.executeCommand(command, ...args);
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}

// ---- hover building blocks ----

/** A full-width row: `left` as is, `right` right-aligned. */
function row(left: string, right: string): string {
  return `<table width="100%"><tr><td>${left}</td><td align="right">${right}</td></tr></table>\n\n`;
}

function colored(html: string, color: string): string {
  return `<span style="color:var(--vscode-${color});">${html}</span>`;
}

function grey(text: string): string {
  return colored(text, 'descriptionForeground');
}

function commandUri(command: string, args?: unknown[]): string {
  return `command:${command}${args ? `?${encodeURIComponent(JSON.stringify(args))}` : ''}`;
}

/** A row holding one action link, like Copilot's "Index?". */
function link(text: string, command: string): string {
  return row(`<a href="${commandUri(command)}">${text}</a>`, '');
}

/** The big number of a section, e.g. "93,007 in 3,000 files". */
function headline(value: string, detail: string): string {
  return row(`<h2>${value} ${grey(detail)}</h2>`, '');
}

function iconLink(icon: string, command: string, title: string): string {
  return `<a href="${commandUri(command)}" title="${escapeHtml(title)}">$(${icon})</a>`;
}

function info(topic: Topic): string {
  return `<a href="${commandUri(HOVER_EXPLAIN, [topic])}" title="${escapeHtml(EXPLAIN[topic])}">$(info)</a>`;
}

/** A thin progress bar, like Copilot's quota bars. */
function bar(fraction: number, width = 52): string {
  const filled = Math.round(Math.max(0, Math.min(1, fraction)) * width);
  return row(colored('━'.repeat(filled), 'charts-blue') + colored('━'.repeat(width - filled), 'charts-lines'), '');
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
