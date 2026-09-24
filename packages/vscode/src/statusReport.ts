import * as vscode from 'vscode';
import type { IndexStats } from './daemon';
import { count, LANGUAGE_NAMES, timeAgo } from './webviewUtil';

/**
 * Commands behind the report's buttons. They are registered in code but not contributed in
 * package.json, so they stay out of the Command Palette: their only job is to close the report
 * before the real command opens a progress notification or a picker.
 */
const HOVER_GENERATE = 'refdex.hover.generateIndex';
const HOVER_SEARCH = 'refdex.hover.searchSymbols';
const HOVER_OPEN_DB = 'refdex.hover.openDatabase';
/** Clicking the status bar item opens its report instead of doing anything by itself. */
export const SHOW_REPORT = 'refdex.showStatusReport';

const IDLE = '$(refdex-logo)';

/**
 * The RefDex item in the status bar (right side, next to Copilot). Its tooltip is the index
 * report: what the index holds, and buttons to regenerate it, search it or open the database.
 */
export class StatusReport implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem('refdex.status', vscode.StatusBarAlignment.Right, 50);
  private stats: IndexStats | undefined;
  private watching = false;
  private error: string | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor() {
    this.item.name = 'RefDex';
    this.item.text = IDLE;
    this.item.accessibilityInformation = { label: 'RefDex: code index' };
    // Clicking opens the report; only its buttons act.
    this.item.command = SHOW_REPORT;
    this.item.tooltip = new vscode.MarkdownString('**RefDex**\n\nReading the index...');
    this.item.show();
    this.disposables.push(
      this.item,
      vscode.commands.registerCommand(SHOW_REPORT, () => this.show()),
      vscode.commands.registerCommand(HOVER_GENERATE, () => this.runFromHover('refdex.generateIndex')),
      vscode.commands.registerCommand(HOVER_SEARCH, () => this.runFromHover('refdex.searchSymbols')),
      vscode.commands.registerCommand(HOVER_OPEN_DB, () => this.runFromHover('refdex.openDatabase')),
    );
  }

  update(stats: IndexStats | undefined, watching: boolean): void {
    this.stats = stats;
    this.watching = watching;
    this.error = undefined;
    this.item.text = IDLE;
    this.item.tooltip = this.report();
  }

  indexing(): void {
    this.item.text = '$(sync~spin)';
    this.item.tooltip = new vscode.MarkdownString('**RefDex**\n\n$(sync~spin) Indexing...', true);
  }

  failed(message: string): void {
    this.error = message;
    this.item.text = `${IDLE} $(warning)`;
    this.item.tooltip = this.report();
  }

  noFolder(): void {
    this.item.tooltip = new vscode.MarkdownString('**RefDex**\n\nOpen a folder to index it.');
  }

  /** The report as Markdown: counts per language, import resolution, freshness, then actions. */
  private report(): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.supportThemeIcons = true;
    // Command links are what a tooltip has instead of buttons; only RefDex's own are trusted.
    md.isTrusted = { enabledCommands: [HOVER_GENERATE, HOVER_SEARCH, HOVER_OPEN_DB] };
    md.appendMarkdown('**RefDex — code index**\n\n');
    const stats = this.stats;
    if (this.error) {
      md.appendMarkdown(`$(error) ${escapeMd(this.error)}\n\n`);
    }
    if (!stats?.files) {
      md.appendMarkdown('This workspace has not been indexed yet.');
      md.appendMarkdown(`\n\n---\n\n[$(play) Generate index](command:${HOVER_GENERATE})`);
      return md;
    }
    md.appendMarkdown(`$(database) ${count(stats.symbols, 'symbol')} in ${count(stats.files, 'file')}\n\n`);
    // Per-language counts are their own group, fenced by rules; headings make them stand out.
    md.appendMarkdown('---\n\n');
    for (const l of stats.byLanguage) {
      md.appendMarkdown(`### $(symbol-file) ${LANGUAGE_NAMES[l.language] ?? l.language}: ${count(l.symbols, 'symbol')} in ${count(l.files, 'file')}\n\n`);
    }
    md.appendMarkdown('---\n\n');
    md.appendMarkdown(`$(references) ${stats.resolvedImports.toLocaleString()} of ${count(stats.imports, 'import')} resolved to workspace code\n\n`);
    md.appendMarkdown(this.watching ? '$(eye) Updating automatically when files change\n\n' : '$(eye-closed) Not watching for changes (refdex.watch is off)\n\n');
    if (stats.indexedAt) {
      md.appendMarkdown(`Last updated ${timeAgo(stats.indexedAt)}.`);
    }
    md.appendMarkdown('\n\n---\n\n');
    md.appendMarkdown(
      `[$(refresh) Regenerate index](command:${HOVER_GENERATE}) &nbsp;&nbsp; ` +
        `[$(search) Search symbols](command:${HOVER_SEARCH}) &nbsp;&nbsp; ` +
        `[$(table) Open database](command:${HOVER_OPEN_DB})`,
    );
    return md;
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
  private async runFromHover(command: string): Promise<void> {
    const run = (c: string) => vscode.commands.executeCommand(c).then(undefined, () => undefined);
    const tooltip = this.item.tooltip;
    this.item.tooltip = new vscode.MarkdownString('**RefDex**');
    await run(vscode.window.visibleTextEditors.length ? 'workbench.action.focusActiveEditorGroup' : 'workbench.action.focusStatusBar');
    await run('editor.action.hideHover');
    await new Promise((resolve) => setTimeout(resolve, 80));
    this.item.tooltip = tooltip;
    await vscode.commands.executeCommand(command);
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}

function escapeMd(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');
}
