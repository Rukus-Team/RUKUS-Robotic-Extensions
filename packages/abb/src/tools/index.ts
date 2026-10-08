/**
 * ABB analysis commands: Compare Two ABB Backups, Unused Routines and the RAPID cross-reference.
 * Each opens a Markdown report; the work is in backupDiff.ts and analysis.ts (pure).
 */
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseRapid, type RapidModule } from '../rapid/parser';
import { taskFoldersOf } from '../rapid/task';
import { readBackupInfo, backupRootOf } from '../backupInfo';
import { diffAbbBackups, abbBackupDiffMarkdown, isAbbBackup } from './backupDiff';
import { unusedRoutines, unusedRoutinesMarkdown, rapidXref, xrefMarkdown, type TaskModules } from './analysis';

const RAPID = /\.(mod|modx|sys|sysx|prg)$/i;

async function showMarkdown(md: string): Promise<void> {
  const doc = await vscode.workspace.openTextDocument({ content: md, language: 'markdown' });
  await vscode.window.showTextDocument(doc, { preview: false });
}

/** the backup's HOME folder and its subfolders: libraries a task loads at run time */
function homeDirs(root: string | undefined): string[] {
  if (!root) return [];
  const out: string[] = [];
  const walk = (d: string, depth: number) => {
    out.push(d);
    if (depth > 4) return;
    try { for (const e of fs.readdirSync(d, { withFileTypes: true })) if (e.isDirectory()) walk(path.join(d, e.name), depth + 1); } catch { /* unreadable */ }
  };
  if (fs.existsSync(path.join(root, 'HOME'))) walk(path.join(root, 'HOME'), 0);
  return out;
}

/**
 * A task's modules from disk (open editors win). The task's own folders are reported on; the shared
 * (TASK0) modules and, in a backup, the HOME libraries are context: their uses count.
 */
function loadTask(own: string[], context: string[]): TaskModules {
  const open = new Map(vscode.workspace.textDocuments.filter(d => d.uri.scheme === 'file').map(d => [d.uri.fsPath.toLowerCase(), d.getText()]));
  const names: string[] = [], mods: RapidModule[] = [];
  const read = (folders: string[]) => {
    for (const dir of folders) {
      let list: string[] = [];
      try { list = fs.readdirSync(dir).filter(n => RAPID.test(n)); } catch { continue; }
      for (const n of list) {
        const p = path.join(dir, n);
        try { mods.push(parseRapid(open.get(p.toLowerCase()) ?? fs.readFileSync(p, 'latin1'))); names.push(n.replace(/\.[^.]+$/, '')); } catch { /* unreadable */ }
      }
    }
  };
  read(own);
  const report = mods.length;
  read(context);
  return { names, mods, report };
}

/** The task to analyse: the active RAPID file's, else one picked from the backups in the workspace. */
async function pickTask(): Promise<{ label: string; own: string[]; context: string[] } | undefined> {
  const ed = vscode.window.activeTextEditor;
  if (ed?.document.languageId === 'abb-rapid' && ed.document.uri.scheme === 'file') {
    const f = taskFoldersOf(ed.document.uri.fsPath);
    const root = backupRootOf(ed.document.uri.fsPath);
    const taskDir = /[\\/](TASK\d+)[\\/]/i.exec(ed.document.uri.fsPath)?.[1];
    const name = root && taskDir ? readBackupInfo(root).tasks.find(t => t.folder.toUpperCase() === taskDir.toUpperCase())?.name : undefined;
    return { label: [root ? path.basename(root) : path.basename(f.task[0]), name ?? taskDir].filter(Boolean).join(' · '), own: f.task, context: [...f.shared, ...homeDirs(root)] };
  }
  const files = await vscode.workspace.findFiles('**/RAPID/TASK*/{PROGMOD,SYSMOD}/*.{mod,MOD,sys,SYS}', '**/node_modules/**', 20000);
  const tasks = new Map<string, string>();
  for (const f of files) { const m = /^(.*[\\/]RAPID[\\/]TASK\d+)[\\/]/i.exec(f.fsPath); if (m && !/[\\/]TASK0$/i.test(m[1])) tasks.set(m[1].toLowerCase(), m[1]); }
  if (!tasks.size) { void vscode.window.showInformationMessage('Open a RAPID module, or a folder with ABB backups (RAPID/TASKn).'); return undefined; }
  const items = [...tasks.values()].map(dir => {
    const root = path.dirname(path.dirname(dir));
    const info = readBackupInfo(root).tasks.find(t => t.folder.toUpperCase() === path.basename(dir).toUpperCase());
    return { label: `${path.basename(root)} · ${info?.name ?? path.basename(dir)}`, description: info?.motion ? 'motion task' : undefined, dir };
  }).sort((a, b) => a.label.localeCompare(b.label));
  const pick = items.length === 1 ? items[0] : await vscode.window.showQuickPick(items, { placeHolder: 'RAPID task to analyse', matchOnDescription: true });
  if (!pick) return undefined;
  const f = taskFoldersOf(path.join(pick.dir, 'PROGMOD', 'x.mod'));
  return { label: pick.label, own: f.task, context: [...f.shared, ...homeDirs(path.dirname(path.dirname(pick.dir)))] };
}

async function pickBackup(title: string, near?: string): Promise<string | undefined> {
  const r = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, title, openLabel: 'Use this backup', defaultUri: near ? vscode.Uri.file(path.dirname(near)) : vscode.workspace.workspaceFolders?.[0]?.uri });
  return r?.[0]?.fsPath;
}

export function registerAbbTools(ctx: vscode.ExtensionContext): void {
  const reg = (id: string, fn: (...a: any[]) => any) => ctx.subscriptions.push(vscode.commands.registerCommand(id, fn));

  reg('robotCode.abb.compareBackups', async (a?: vscode.Uri, b?: vscode.Uri) => {
    const dirA = a instanceof vscode.Uri ? a.fsPath : await pickBackup('ABB backup A (older)');
    if (!dirA) return;
    const dirB = b instanceof vscode.Uri ? b.fsPath : await pickBackup('ABB backup B (newer)', dirA);
    if (!dirB) return;
    for (const d of [dirA, dirB]) if (!isAbbBackup(d)) { void vscode.window.showWarningMessage(`${d} is not an ABB backup (no BACKINFO with RAPID or SYSPAR beside it).`); return; }
    const diff = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Comparing ABB backups…' }, async () => diffAbbBackups(dirA, dirB));
    await showMarkdown(abbBackupDiffMarkdown(diff));
  });

  reg('robotCode.abb.unusedRoutines', async () => {
    const t = await pickTask(); if (!t) return;
    const task = loadTask(t.own, t.context);
    await showMarkdown(unusedRoutinesMarkdown(t.label, unusedRoutines(task), task.report ?? task.mods.length));
  });

  reg('robotCode.abb.xrefReport', async () => {
    const t = await pickTask(); if (!t) return;
    await showMarkdown(xrefMarkdown(t.label, rapidXref(loadTask(t.own, t.context))));
  });
}
