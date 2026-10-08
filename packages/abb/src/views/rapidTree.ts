/**
 * The RAPID section of the sidebar: every RAPID module the workspace index knows, the way an
 * IRC5 lays them out.
 *
 *   2V04_V01AR21            IRB 6700-220/2.65 LeanID · 23-09-16     one row per backup
 *     T_ROB1  TASK5         motion task · PrgPM_Se · 18 modules      one row per task
 *       MainModule          program module · 12 routines             program modules first,
 *       DataTypes           system module · 3 routines               then system modules,
 *       SpotLib             encrypted                                encrypted ones last, locked
 *         main()            PROC                                     routines, click to open
 *
 * TASK0 in a backup is not a task but the shared modules every task sees; it is listed as
 * "Shared". HOME is the controller's own disk - libraries and program sources a task may load,
 * not loaded by being there - and comes after the tasks, by subfolder. Files outside a backup
 * layout group under their folder, with no task level.
 */
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Services } from '@core/services';
import type { ProgramInfo } from '@core/workspaceIndex';
import { icon } from '@core/views/typeStyle';
import { viewDeclared } from '@core/util';
import { robotNameFromFolder, folderDate } from '@core/backupFolders';
import { compareBackupDirs } from '@core/robotContainers';
import { parseRapid, type RapidRoutine } from '../rapid/parser';
import { backupRootOf, readBackupInfo, taskFolderOf, homePathOf, type AbbTaskInfo } from '../backupInfo';

/** ABB's colour in the sidebar: the same red family as the file icon */
const ABB_COLOR = 'charts.red';

type Node =
  | { type: 'backup'; root: string; modules: ProgramInfo[] }
  | { type: 'task'; root: string; task: AbbTaskInfo; modules: ProgramInfo[] }
  | { type: 'home'; root: string; modules: ProgramInfo[] }
  | { type: 'dir'; root: string; rel: string; modules: ProgramInfo[] }
  | { type: 'module'; info: ProgramInfo }
  | { type: 'routine'; info: ProgramInfo; routine: RapidRoutine };

const isEncrypted = (p: ProgramInfo) => p.kind === 'rapid-encrypted';
const isSystem = (p: ProgramInfo) => /system/i.test(p.programType ?? '');
/** program modules, then system modules, then the encrypted ones; by name inside each */
const moduleOrder = (a: ProgramInfo, b: ProgramInfo) =>
  (+isEncrypted(a) - +isEncrypted(b)) || (+isSystem(a) - +isSystem(b)) || a.name.localeCompare(b.name);

export class RapidTree implements vscode.TreeDataProvider<Node> {
  private readonly _onDidChange = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this._onDidChange.event;
  /** routines per file, re-parsed only when the file changes */
  private readonly routines = new Map<string, { mtime: number; list: RapidRoutine[]; name?: string }>();

  constructor(private readonly s: Services) {}
  refresh() { this._onDidChange.fire(undefined); }

  modules(): ProgramInfo[] { return this.s.index.list().filter(p => p.brand === 'abb' && !p.reference); }

  getChildren(el?: Node): Node[] {
    if (!el) {
      const byRoot = new Map<string, ProgramInfo[]>();
      for (const p of this.modules()) {
        const root = (p.uri.scheme === 'file' ? backupRootOf(p.uri.fsPath) : undefined) ?? path.dirname(p.uri.fsPath);
        byRoot.set(root, [...(byRoot.get(root) ?? []), p]);
      }
      return [...byRoot.entries()]
        .sort((a, b) => compareBackupDirs(a[0], b[0]) || path.basename(a[0]).localeCompare(path.basename(b[0])))
        .map(([root, modules]) => ({ type: 'backup', root, modules }));
    }
    if (el.type === 'backup') {
      if (!backupRootOf(el.modules[0]?.uri.fsPath ?? '')) return el.modules.sort(moduleOrder).map(info => ({ type: 'module', info }));
      const info = readBackupInfo(el.root);
      const byTask = new Map<string, ProgramInfo[]>();
      const home: ProgramInfo[] = [];
      for (const p of el.modules) {
        const t = taskFolderOf(p.uri.fsPath);
        if (t) byTask.set(t, [...(byTask.get(t) ?? []), p]); else home.push(p);
      }
      const known = new Map(info.tasks.map(t => [t.folder, t]));
      const tasks: Node[] = [...byTask.entries()]
        .map(([folder, modules]) => ({ type: 'task' as const, root: el.root, task: known.get(folder) ?? { folder, name: folder, motion: false, shared: folder === 'TASK0' }, modules }))
        // the robot's own task first, the shared modules last, the rest in controller order
        .sort((a, b) => (+b.task.motion - +a.task.motion) || (+a.task.shared - +b.task.shared) || taskNo(a.task.folder) - taskNo(b.task.folder));
      return home.length ? [...tasks, { type: 'home', root: el.root, modules: home }] : tasks;
    }
    if (el.type === 'home') {
      // one row per first-level folder under HOME; a file directly in HOME is a row of its own
      const dirs = new Map<string, ProgramInfo[]>();
      const loose: ProgramInfo[] = [];
      for (const p of el.modules) {
        const rel = homePathOf(p.uri.fsPath) ?? '';
        const slash = rel.indexOf('/');
        if (slash < 0) loose.push(p); else { const d = rel.slice(0, slash); dirs.set(d, [...(dirs.get(d) ?? []), p]); }
      }
      return [
        ...[...dirs.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([rel, modules]) => ({ type: 'dir' as const, root: el.root, rel, modules })),
        ...loose.sort(moduleOrder).map(info => ({ type: 'module' as const, info })),
      ];
    }
    if (el.type === 'task' || el.type === 'dir') return el.modules.sort(moduleOrder).map(info => ({ type: 'module', info }));
    if (el.type === 'module') return this.routinesOf(el.info).map(routine => ({ type: 'routine', info: el.info, routine }));
    return [];
  }

  getTreeItem(el: Node): vscode.TreeItem {
    if (el.type === 'backup') {
      const inBackup = !!backupRootOf(el.modules[0]?.uri.fsPath ?? '');
      const info = inBackup ? readBackupInfo(el.root) : undefined;
      const base = path.basename(el.root);
      const it = new vscode.TreeItem(inBackup ? robotNameFromFolder(base) : base || el.root, vscode.TreeItemCollapsibleState.Collapsed);
      const date = folderDate(base);
      it.description = [info?.robotLabel, date, inBackup ? undefined : `${el.modules.length} modules`].filter(Boolean).join(' · ');
      it.tooltip = new vscode.MarkdownString([
        `**${base}**`, '',
        info?.systemId ? `System ${info.systemId}` : '',
        info?.robotWare ? `RobotWare ${info.robotWare}` : '',
        info?.robotType ? `Robot ${info.robotLabel} (\`${info.robotType}\`)` : '',
        `${el.modules.length} modules · ${el.modules.filter(isEncrypted).length} encrypted`, '',
        el.root,
      ].filter((l, i, a) => l || a[i - 1]).join('  \n'));
      it.iconPath = icon('vm', ABB_COLOR);
      it.resourceUri = vscode.Uri.file(el.root);
      it.contextValue = 'rapid-backup';
      it.id = `rapid:${el.root.toLowerCase()}`;
      return it;
    }
    if (el.type === 'task') {
      const t = el.task;
      const it = new vscode.TreeItem(t.shared ? 'Shared' : t.name, vscode.TreeItemCollapsibleState[t.motion ? 'Expanded' : 'Collapsed']);
      it.description = [t.shared ? 'TASK0 · every task sees these' : t.folder, t.motion ? 'motion task' : undefined, t.program, `${el.modules.length} modules`].filter(Boolean).join(' · ');
      it.tooltip = `${t.shared ? 'Shared modules (installed -Shared, visible to every task)' : `Task ${t.name}`}${t.program ? `\nProgram ${t.program}` : ''}\n${path.join(el.root, 'RAPID', t.folder)}`;
      it.iconPath = icon(t.shared ? 'library' : t.motion ? 'robot' : 'server-process', t.motion ? ABB_COLOR : undefined);
      it.contextValue = 'rapid-task';
      it.id = `rapid:${el.root.toLowerCase()}:${t.folder}`;
      return it;
    }
    if (el.type === 'home' || el.type === 'dir') {
      const it = new vscode.TreeItem(el.type === 'home' ? 'HOME' : el.rel, vscode.TreeItemCollapsibleState.Collapsed);
      it.description = `${el.type === 'home' ? 'controller disk · ' : ''}${el.modules.length} modules`;
      it.tooltip = el.type === 'home'
        ? 'The controller\'s HOME disk: libraries and program sources a task can load. Being here does not load them.'
        : path.join(el.root, 'HOME', el.rel);
      it.iconPath = icon(el.type === 'home' ? 'home' : 'folder');
      it.contextValue = el.type === 'home' ? 'rapid-home' : 'rapid-home-folder';
      it.id = `rapid:${el.root.toLowerCase()}:${el.type === 'home' ? 'HOME' : `HOME/${el.rel}`}`;
      return it;
    }
    if (el.type === 'module') {
      const p = el.info;
      const enc = isEncrypted(p);
      const n = enc ? 0 : this.routinesOf(p).length;
      // the index keeps names upper-cased for lookups; the row shows MODULE's name as written
      const shown = enc ? path.basename(p.uri.fsPath) : this.routines.get(p.uri.fsPath)?.name ?? p.name;
      const it = new vscode.TreeItem(shown, enc ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Collapsed);
      it.description = enc ? 'encrypted' : `${isSystem(p) ? 'system' : 'program'} · ${n} routine${n === 1 ? '' : 's'}${p.positions ? ` · ${p.positions} points` : ''}`;
      it.tooltip = enc
        ? `${path.basename(p.uri.fsPath)} is encrypted (an option or site library): the controller runs it, but there is nothing to read.`
        : `${p.programType} ${p.name}\n${p.lineCount} lines · ${n} routines · ${p.positions} robtargets/jointtargets${p.calls.length ? `\ncalls ${p.calls.slice(0, 8).join(', ')}${p.calls.length > 8 ? ', …' : ''}` : ''}\n${vscode.workspace.asRelativePath(p.uri)}`;
      it.iconPath = enc ? icon('lock', 'disabledForeground') : icon(isSystem(p) ? 'gear' : 'symbol-module', ABB_COLOR);
      it.resourceUri = p.uri;
      it.contextValue = enc ? 'rapid-module-encrypted' : 'rapid-module';
      if (!enc) it.command = { command: 'robotCode.rapid.open', title: 'Open', arguments: [p.uri] };
      return it;
    }
    const r = el.routine;
    const it = new vscode.TreeItem(`${r.name}${r.kind === 'TRAP' ? '' : '()'}`, vscode.TreeItemCollapsibleState.None);
    it.description = `${r.local ? 'LOCAL ' : ''}${r.kind}${r.returnType ? ` ${r.returnType}` : ''}${r.params.length ? ` · ${r.params.length} param${r.params.length === 1 ? '' : 's'}` : ''}`;
    it.tooltip = new vscode.MarkdownString().appendCodeblock(r.signature, 'rapid').appendMarkdown(r.doc ? `\n\n${r.doc}` : '');
    it.iconPath = icon(r.kind === 'FUNC' ? 'symbol-function' : r.kind === 'TRAP' ? 'symbol-event' : 'symbol-method', r.local ? 'disabledForeground' : ABB_COLOR);
    it.command = { command: 'robotCode.rapid.open', title: 'Open', arguments: [el.info.uri, r.nameSpan.line] };
    return it;
  }

  private routinesOf(p: ProgramInfo): RapidRoutine[] {
    if (isEncrypted(p) || p.uri.scheme !== 'file') return [];
    let mtime = 0;
    try { mtime = fs.statSync(p.uri.fsPath).mtimeMs; } catch { return []; }
    const hit = this.routines.get(p.uri.fsPath);
    if (hit && hit.mtime === mtime) return hit.list;
    let list: RapidRoutine[] = [], name: string | undefined;
    try { const mod = parseRapid(fs.readFileSync(p.uri.fsPath, 'latin1')); list = mod.routines; name = mod.name; } catch { /* unreadable: no children */ }
    this.routines.set(p.uri.fsPath, { mtime, list, name });
    return list;
  }
}

const taskNo = (folder: string) => parseInt(/\d+/.exec(folder)?.[0] ?? '999', 10);

export function registerRapidView(ctx: vscode.ExtensionContext, s: Services) {
  const tree = new RapidTree(s);
  const view = viewDeclared(ctx, 'robotCode.rapid') ? vscode.window.createTreeView('robotCode.rapid', { treeDataProvider: tree, showCollapseAll: true }) : undefined;
  const summarise = () => {
    if (!view) return;
    const mods = tree.modules();
    const roots = new Set(mods.map(p => backupRootOf(p.uri.fsPath) ?? path.dirname(p.uri.fsPath)));
    view.description = mods.length ? `${roots.size} backup${roots.size === 1 ? '' : 's'} · ${mods.length} modules` : '';
  };
  ctx.subscriptions.push(
    ...(view ? [view] : []),
    s.index.onDidChange(() => { tree.refresh(); summarise(); }),
    vscode.commands.registerCommand('robotCode.rapid.open', async (uri: vscode.Uri, line?: number) => {
      const ed = await vscode.window.showTextDocument(uri, { preview: true });
      if (line !== undefined) { const pos = new vscode.Position(line, 0); ed.selection = new vscode.Selection(pos, pos); ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport); }
    }),
    vscode.commands.registerCommand('robotCode.rapid.refresh', () => { tree.refresh(); summarise(); }),
    // hidden: what the section shows, for the smoke test - header summary plus the first rows two levels down
    vscode.commands.registerCommand('robotCode.rapid._state', async () => {
      const label = (n: Node) => { const it = tree.getTreeItem(n); return `${typeof it.label === 'string' ? it.label : it.label?.label ?? ''}${it.description ? ` — ${it.description}` : ''}`; };
      const top = tree.getChildren();
      const first = top[0] ? tree.getChildren(top[0]) : [];
      const second = first[0] ? tree.getChildren(first[0]) : [];
      const third = second.find(n => n.type === 'module' && !isEncrypted(n.info));
      return { description: view?.description, backups: top.map(label), first: first.map(label), modules: second.map(label), routines: third ? tree.getChildren(third).map(label) : [] };
    }),
  );
  summarise();
}
