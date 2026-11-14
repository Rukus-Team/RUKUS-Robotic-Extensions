/**
 * Compare Ignoring Line Numbers: two programs side by side with the line numbers, terminators,
 * spacing and header bookkeeping taken out of both, so only real differences are marked
 * (cleanCompare.ts). Both panes are read-only views of the files; nothing is written.
 */
import * as vscode from 'vscode';
import * as path from 'node:path';
import { config } from '@core/util';
import type { FanucServices } from './services';
import { COMPARE_IGNORES, cleanForCompare, compareIgnores, describeIgnores, kindOfFile, type CompareIgnore } from './cleanCompare';

const SCHEME = 'robotcode-clean';
const SETTING = 'compare.ignore';

/** the view of `real` with `ignore` taken out: the real URI and the list travel in the query */
function cleanUri(real: vscode.Uri, ignore: ReadonlySet<CompareIgnore>): vscode.Uri {
  return vscode.Uri.from({ scheme: SCHEME, path: real.path, query: JSON.stringify({ u: real.toString(), i: [...ignore] }) });
}
function parse(uri: vscode.Uri): { real: vscode.Uri; ignore: Set<CompareIgnore> } | undefined {
  try { const q = JSON.parse(uri.query) as { u: string; i: unknown }; return { real: vscode.Uri.parse(q.u), ignore: compareIgnores(q.i) }; } catch { return undefined; }
}

async function textOf(real: vscode.Uri): Promise<string> {
  // what is in the editor, unsaved changes included; a file that is not open is read as the controller writes it
  const open = vscode.workspace.textDocuments.find(d => d.uri.toString() === real.toString());
  if (open) return open.getText();
  return Buffer.from(await vscode.workspace.fs.readFile(real)).toString('latin1');
}

const isProgram = (u: vscode.Uri | undefined): u is vscode.Uri => !!u && /\.(ls|kl)$/i.test(u.path);

export function registerCleanCompare(ctx: vscode.ExtensionContext, s: FanucServices): void {
  const changed = new vscode.EventEmitter<vscode.Uri>();
  const shown = new Set<string>();   // the clean views handed out, to refresh when their file changes
  ctx.subscriptions.push(
    changed,
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, {
      onDidChange: changed.event,
      async provideTextDocumentContent(uri) {
        const p = parse(uri);
        if (!p) return '';
        shown.add(uri.toString());
        try { return cleanForCompare(await textOf(p.real), kindOfFile(p.real.path), p.ignore); } catch { return `could not read ${p.real.fsPath}`; }
      },
    }),
    vscode.workspace.onDidCloseTextDocument(d => { if (d.uri.scheme === SCHEME) shown.delete(d.uri.toString()); }),
    // the compare follows the file as it is edited
    vscode.workspace.onDidChangeTextDocument(e => {
      if (e.document.uri.scheme === SCHEME || !shown.size) return;
      const key = e.document.uri.toString();
      for (const v of shown) { const u = vscode.Uri.parse(v); if (parse(u)?.real.toString() === key) changed.fire(u); }
    }),

    vscode.commands.registerCommand('robotCode.compare.clean', async (clicked?: vscode.Uri, selected?: vscode.Uri[]) => {
      // two files picked in the Explorer, else this file (clicked, or the one being edited) against one to choose
      const picked = (selected ?? []).filter(isProgram);
      let a: vscode.Uri | undefined, b: vscode.Uri | undefined;
      if (picked.length >= 2) [a, b] = picked;
      else {
        b = isProgram(clicked) ? clicked : isProgram(vscode.window.activeTextEditor?.document.uri) ? vscode.window.activeTextEditor!.document.uri : undefined;
        if (!b) { void vscode.window.showInformationMessage('Open a .ls or .kl program, or select two of them in the Explorer, then run Compare Ignoring Line Numbers.'); return; }
        a = await pickOther(s, b);
        if (!a) return;
      }
      const ignore = compareIgnores(config<unknown>(SETTING, undefined));
      const [ta, tb] = await Promise.all([textOf(a), textOf(b)].map(p => p.catch(() => undefined)));
      if (ta === undefined || tb === undefined) { void vscode.window.showWarningMessage('One of the two files could not be read.'); return; }
      const same = cleanForCompare(ta, kindOfFile(a.path), ignore) === cleanForCompare(tb, kindOfFile(b.path), ignore);
      const label = (u: vscode.Uri, other: vscode.Uri) => (path.basename(u.path) === path.basename(other.path) ? `${path.basename(path.dirname(u.path))}/${path.basename(u.path)}` : path.basename(u.path));
      await vscode.commands.executeCommand('vscode.diff', cleanUri(a, ignore), cleanUri(b, ignore), `${label(a, b)} ↔ ${label(b, a)} (ignoring ${describeIgnores(ignore)})`);
      if (same) void vscode.window.showInformationMessage(ta === tb ? 'The two files are identical.' : `No differences once ${describeIgnores(ignore)} are ignored.`, 'What to Ignore...').then(x => { if (x) void vscode.commands.executeCommand('robotCode.compare.options'); });
    }),

    vscode.commands.registerCommand('robotCode.compare.options', async () => {
      const now = compareIgnores(config<unknown>(SETTING, undefined));
      const picks = await vscode.window.showQuickPick(
        COMPARE_IGNORES.map(i => ({ label: i.label, detail: i.detail, picked: now.has(i.id), id: i.id })),
        { canPickMany: true, title: 'Compare Ignoring Line Numbers: what to leave out of the comparison (line endings never count)' });
      if (!picks) return;
      await vscode.workspace.getConfiguration('robotCode').update(SETTING, picks.map(p => p.id), vscode.ConfigurationTarget.Global);
      // an open compare is redrawn with the new choice
      const next = new Set(picks.map(p => p.id));
      for (const tab of vscode.window.tabGroups.all.flatMap(g => g.tabs)) {
        const input = tab.input;
        if (!(input instanceof vscode.TabInputTextDiff) || input.original.scheme !== SCHEME) continue;
        const l = parse(input.original), r = parse(input.modified);
        if (!l || !r) continue;
        await vscode.window.tabGroups.close(tab);
        await vscode.commands.executeCommand('vscode.diff', cleanUri(l.real, next), cleanUri(r.real, next), `${path.basename(l.real.path)} ↔ ${path.basename(r.real.path)} (ignoring ${describeIgnores(next)})`);
      }
    }),
  );
}

/** The file to compare `mine` with: the other copies of the same program, the other programs open, or one browsed for */
async function pickOther(s: FanucServices, mine: vscode.Uri): Promise<vscode.Uri | undefined> {
  type Item = vscode.QuickPickItem & { uri?: vscode.Uri; browse?: boolean };
  const items: Item[] = [];
  const seen = new Set([mine.toString()]);
  const add = (uri: vscode.Uri, description: string) => {
    if (seen.has(uri.toString()) || !isProgram(uri)) return;
    seen.add(uri.toString());
    items.push({ label: path.basename(uri.path), description, detail: vscode.workspace.asRelativePath(uri), uri });
  };
  const name = path.basename(mine.path).replace(/\.[^.]+$/, '');
  const copies = s.index.all(name).filter(p => p.kind !== 'binary');
  if (copies.length > 1) items.push({ label: `Other copies of ${name.toUpperCase()}`, kind: vscode.QuickPickItemKind.Separator });
  for (const p of copies) add(p.uri, 'same program');
  const before = items.length;
  for (const g of vscode.window.tabGroups.all) for (const t of g.tabs) if (t.input instanceof vscode.TabInputText) add(t.input.uri, 'open');
  if (items.length > before) items.splice(before, 0, { label: 'Open programs', kind: vscode.QuickPickItemKind.Separator });
  items.push({ label: '', kind: vscode.QuickPickItemKind.Separator }, { label: '$(folder-opened) Browse...', browse: true });
  const pick = await vscode.window.showQuickPick(items, { title: `Compare ${path.basename(mine.path)} with...`, matchOnDescription: true, matchOnDetail: true });
  if (!pick) return undefined;
  if (pick.uri) return pick.uri;
  const chosen = await vscode.window.showOpenDialog({ canSelectMany: false, defaultUri: vscode.Uri.joinPath(mine, '..'), filters: { 'Robot programs': ['ls', 'kl'], 'All files': ['*'] }, openLabel: 'Compare' });
  return chosen?.[0];
}
