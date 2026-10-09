import * as vscode from 'vscode';
import type { Span } from '@core/span';

export function spanToRange(s: { line: number; col: number; len: number }): vscode.Range {
  return new vscode.Range(s.line, s.col, s.line, s.col + s.len);
}

export function spanContains(s: Span, pos: vscode.Position): boolean {
  return s.line === pos.line && pos.character >= s.col && pos.character <= s.col + s.len;
}

export function debounce<T extends (...args: any[]) => void>(fn: T, ms: number): T & { cancel(): void } {
  let timer: NodeJS.Timeout | undefined;
  const wrapped = ((...args: any[]) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = undefined; fn(...args); }, ms);
  }) as T & { cancel(): void };
  wrapped.cancel = () => { if (timer) { clearTimeout(timer); timer = undefined; } };
  return wrapped;
}

export function config<T>(key: string, fallback: T, scope?: vscode.ConfigurationScope): T {
  return vscode.workspace.getConfiguration('robotCode', scope).get<T>(key, fallback);
}

/**
 * The backup folders THIS window scans, and the ones removed from its Backup panel.
 *
 * Only ever the workspace's own list. Folders used to be saved to user settings whenever no
 * folder was open, and a user-level list is read by every window - so each new window opened
 * with someone else's backups in its Backup panel. Now a folder workspace scans itself plus
 * what its own settings add, a new window starts empty, and a window with no folder keeps
 * its list for as long as it is open. A user-level value is ignored (said once in Output).
 */
export type WindowFolderList = 'data.backupFolders' | 'data.hiddenBackupFolders';
const sessionLists = new Map<WindowFolderList, string[]>();
const folderListChanged = new vscode.EventEmitter<WindowFolderList>();
const onDidChangeWindowFolders = folderListChanged.event;
let ignoredUserLevelSaid = false;

export function windowFolders(key: WindowFolderList, output?: vscode.OutputChannel): string[] {
  if (!vscode.workspace.workspaceFolders?.length) return [...(sessionLists.get(key) ?? [])];
  // an untrusted workspace does not get to point the scan at other folders
  if (!vscode.workspace.isTrusted) return [];
  const insp = vscode.workspace.getConfiguration('robotCode').inspect<string[]>(key);
  if (insp?.globalValue?.length && !ignoredUserLevelSaid && output) {
    ignoredUserLevelSaid = true;
    output.appendLine(`[RUKUS] ignoring robotCode.${key} in user settings (${insp.globalValue.join('; ')}): backup folders belong to a workspace, so a new window starts without them. Add them again from the Backup panel.`);
  }
  return [...(insp?.workspaceValue ?? [])];
}

export async function setWindowFolders(key: WindowFolderList, list: string[]): Promise<void> {
  const unique = [...new Map(list.map(f => [f.replace(/[\\/]+$/, '').toLowerCase(), f.replace(/[\\/]+$/, '')])).values()];
  if (vscode.workspace.workspaceFolders?.length) {
    await vscode.workspace.getConfiguration('robotCode').update(key, unique.length ? unique : undefined, vscode.ConfigurationTarget.Workspace);
  } else {
    // settings fire onDidChangeConfiguration themselves; the window-only list has to say so
    sessionLists.set(key, unique);
    folderListChanged.fire(key);
  }
}

/** a change to either list, from settings or window-only */
export function onDidChangeBackupLists(fn: () => void): vscode.Disposable {
  return vscode.Disposable.from(
    onDidChangeWindowFolders(() => fn()),
    vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('robotCode.data.backupFolders') || e.affectsConfiguration('robotCode.data.hiddenBackupFolders')) fn(); }));
}

/** under one of the folders removed from the Backup panel */
export function isHiddenBackup(fsPath: string): boolean {
  const p = fsPath.replace(/[\\/]+$/, '').toLowerCase();
  return windowFolders('data.hiddenBackupFolders').some(h => {
    const f = h.replace(/[\\/]+$/, '').toLowerCase();
    return p === f || p.startsWith(f + '\\') || p.startsWith(f + '/');
  });
}

/**
 * Is a view id in the manifest VS Code is running with? After an in-place update the new
 * code runs against the OLD package.json until the window is reloaded, and creating a view
 * the manifest does not declare throws. Check first; say "reload" once.
 */
let reloadSaid = false;
export function viewDeclared(ctx: vscode.ExtensionContext, id: string): boolean {
  const views = (ctx.extension.packageJSON?.contributes?.views?.robotCode ?? []) as Array<{ id: string }>;
  if (views.some(v => v.id === id)) return true;
  if (!reloadSaid) {
    reloadSaid = true;
    void vscode.window.showInformationMessage('RUKUS Robotic Extensions was updated. Reload the window to finish - some sidebar sections are not available until then.', 'Reload Window')
      .then(pick => { if (pick) void vscode.commands.executeCommand('workbench.action.reloadWindow'); });
  }
  return false;
}

export function programNameFromUri(uri: vscode.Uri): string {
  const base = uri.path.split('/').pop() ?? '';
  return base.replace(/\.[^.]+$/, '').toUpperCase();
}

export function md(...lines: string[]): vscode.MarkdownString {
  const m = new vscode.MarkdownString(lines.join('\n'), true); // supportThemeIcons: $(icon) renders
  m.isTrusted = true;
  m.supportHtml = false;
  return m;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

/**
 * Generic per-document parse cache keyed by uri + version.
 *
 * The version alone is not enough: a document that is closed and opened again starts over
 * at version 1, and a file read off a controller (or one a backup pull overwrote while it
 * was closed) can come back with different text under the same uri and the same number.
 * A parse kept across that put motion-line decorations at the OLD line numbers - all over
 * the new file's /POS. So the entry is dropped when the document closes (`Services` wires
 * that), and the line count and length are compared as a second, cheap guard.
 */
export class ParseCache<T> {
  private readonly map = new Map<string, { version: number; lines: number; length: number; value: T }>();
  constructor(private readonly parse: (text: string) => T) {}
  get(doc: vscode.TextDocument): T {
    const key = doc.uri.toString();
    const hit = this.map.get(key);
    if (hit && hit.version === doc.version && hit.lines === doc.lineCount) {
      // offsetAt(end) is the text length without building the string
      if (hit.length === doc.offsetAt(doc.lineAt(doc.lineCount - 1).range.end)) return hit.value;
    }
    const text = doc.getText();
    const value = this.parse(text);
    this.map.set(key, { version: doc.version, lines: doc.lineCount, length: text.length, value });
    return value;
  }
  drop(uri: vscode.Uri) { this.map.delete(uri.toString()); }
}

/**
 * An error the user can do something about (issue #3, 5b): **Retry** when the failed action can
 * simply run again, and **Open Output** where the full story is logged. Not awaited by callers - the
 * notification must not hold up the command that failed.
 */
export async function showRecoverableError(message: string, output: { show(preserveFocus?: boolean): void } | undefined, retry?: () => unknown): Promise<void> {
  const buttons = [...(retry ? ['Retry'] : []), ...(output ? ['Open Output'] : [])];
  const pick = await vscode.window.showErrorMessage(message, ...buttons);
  if (pick === 'Open Output') output?.show(true);
  else if (pick === 'Retry') await retry?.();
}
