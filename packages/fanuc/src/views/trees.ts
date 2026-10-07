/**
 * The file-based sections of the sidebar: Backup, TP programs, PC programs, Macros, Data.
 *
 * Each is its own view - a labelled, collapsible section with a hairline between it and
 * the next - and each view's header carries a count or a status summary on the right.
 * Inside, a row's label says what the thing IS and its description what is known about
 * it. Colour follows `typeStyle.ts` (amber TP, blue PC, teal macro, grey data) and is
 * always paired with the kind's icon; amber on a count means it is a problem.
 */
import * as vscode from 'vscode';
import * as path from 'node:path';
import { FanucServices } from '../services';
import type { ProgramInfo } from '@core/workspaceIndex';
import type { Dataset } from '../data/dataStore';
import { DATA_KIND_DOCS } from '../tp/docs';
import { describePayload, type MacroEntry } from '../data/vaParser';
import { icon, TYPE_COLOR } from '@core/views/typeStyle';
import { MODIFIED_COLOR } from '@core/containerCompare';
import { isIdentityFrame } from '../data/sysFrameParser';
import { fmtFrame } from '../tp/frameHover';
import { viewDeclared, config, windowFolders } from '@core/util';
import { newestRobotBackups } from '@core/rukus/store';
import { existsSync } from 'node:fs';
import { snapshotStatus, snapshotStatusText, syncRelation } from '@core/containerCompare';
import { robotCompareOf } from '@core/robotCompare';
import { comparedChanged } from '@core/snapshotSync';
import {
  backupRank, compareBackupDirs, listSnapshotFiles, snapshotFileAge, isSnapshotDataFile, isSnapshotProgramFile,
  type RobotMarker, type SnapshotProvenance, type SnapshotFileEntry,
} from '@core/robotContainers';
import { findUses } from '@core/views/findUses';

export function registerViews(ctx: vscode.ExtensionContext, s: FanucServices) {
  const tp = new TpProgramsTree(s);
  const pc = new PcProgramsTree(s);
  const macros = new MacrosTree(s);
  const snapshot = new SnapshotTree(s);
  const data = new DataTree(s);
  // A view the running manifest does not know (an update awaiting a reload) is skipped, not crashed on.
  const mk = <T>(id: string, provider: vscode.TreeDataProvider<T>) => (viewDeclared(ctx, id) ? vscode.window.createTreeView(id, { treeDataProvider: provider, showCollapseAll: true }) : undefined);
  const views = {
    snapshot: mk('robotCode.snapshot', snapshot),
    tp: mk('robotCode.programs', tp),
    pc: mk('robotCode.pcPrograms', pc),
    macros: mk('robotCode.macros', macros),
    data: mk('robotCode.registers', data),
  };
  ctx.subscriptions.push(
    // "Show N more…" at the end of a long Registers group (robotCode.views.listLimit)
    vscode.commands.registerCommand('robotCode.views._showMore', (key: string) => data.showMore(key)),
    vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('robotCode.views.listLimit')) data.refresh(); }),
  );
  // The right-hand summary on each section header.
  const summarise = () => {
    const all = s.index.list().filter(p => !p.reference);
    const tps = tpProgramsOnePerName(all);
    const raw = tps.reduce((n, p) => n + p.rawTokens, 0);
    if (views.tp) views.tp.description = `${tps.length}${raw ? ` · ⚠ ${raw} raw` : ''}`;
    const pcs = all.filter(p => p.kind === 'karel' || (p.kind === 'binary' && /KAREL/.test(p.programType ?? '')));
    // one per name PER ROBOT, the same dedupe the rows use - two backups each carrying MOV_HOME.pc are two rows
    if (views.pc) views.pc.description = `${new Set(pcs.map(p => `${p.group}|${p.name}`)).size}`;
    const ds = s.data.datasets;
    const macroCount = ds.reduce((n, d) => n + d.macros.size, 0);
    const missing = ds.reduce((n, d) => n + [...d.macros.values()].filter(m => !s.index.get(m.progName, d.folder ? vscode.Uri.file(d.folder) : undefined)).length, 0);
    if (views.macros) views.macros.description = macroCount ? `${macroCount}${missing ? ` · ⚠ ${missing} missing` : ''}` : '';
    const robotCount = s.containers.markers.length;
    if (views.snapshot) views.snapshot.description = robotCount ? `${robotCount} robot${robotCount === 1 ? '' : 's'}` : '';
    const regs = ds.reduce((n, d) => n + d.numregs.size, 0), io = ds.reduce((n, d) => n + d.io.size, 0);
    if (views.data) views.data.description = ds.length ? `${regs} R · ${io} I/O` : '';
  };
  ctx.subscriptions.push(
    ...Object.values(views).filter((v): v is vscode.TreeView<any> => !!v),
    s.index.onDidChange(summarise), s.data.onDidChange(summarise), s.containers.onDidChange(summarise),
    vscode.commands.registerCommand('robotCode.views.revealInEditor', async (uri: vscode.Uri) => { await vscode.window.showTextDocument(uri, { preview: true }); }),
    vscode.commands.registerCommand('robotCode.views.findUses', (kind: string, index: number, folder?: string) => findUses(kind, index, folder)),
    vscode.commands.registerCommand('robotCode.views.toggleLatestOnly', async () => {
      const on = !latestOnly();
      await vscode.workspace.getConfiguration('robotCode').update('views.latestBackupsOnly', on, vscode.workspace.workspaceFolders ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global);
      vscode.window.setStatusBarMessage(on ? '$(filter) Programs: latest backups only' : '$(list-flat) Programs: all backups', 4000);
    }),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (!e.affectsConfiguration('robotCode.views.latestBackupsOnly')) return;
      void vscode.commands.executeCommand('setContext', 'robotCode.latestOnly', latestOnly());
      tp.refresh(); pc.refresh(); snapshot.refresh();
    }),
    // hidden: what each section shows, for the smoke test - header summary plus top-level rows
    vscode.commands.registerCommand('robotCode.views._state', async () => {
      summarise();   // deterministic: the header summary is otherwise set asynchronously
      const rows = async (p: vscode.TreeDataProvider<any>) => {
        const out: string[] = [];
        for (const k of ((await p.getChildren()) ?? []).slice(0, 80)) {
          const it = await p.getTreeItem(k);
          const label = typeof it.label === 'string' ? it.label : it.label?.label ?? '';
          out.push(`${label}${it.description ? ` — ${it.description}` : ''}`);
        }
        return out;
      };
      return {
        snapshot: { description: views.snapshot?.description, rows: await rows(snapshot) },
        tp: { description: views.tp?.description, rows: await rows(tp) },
        pc: { description: views.pc?.description, rows: await rows(pc) },
        macros: { description: views.macros?.description, rows: await rows(macros) },
        data: { description: views.data?.description, rows: await rows(data) },
      };
    }),
  );
  summarise();
  void vscode.commands.executeCommand('setContext', 'robotCode.latestOnly', latestOnly());
}

function groupLabel(s: FanucServices, group: string, sample?: ProgramInfo): string {
  // programs opened off a controller group under that controller, not under a folder name
  const remote = /^fanuc:\/\/([^/]+)\/(.*)$/.exec(group);
  if (remote) return `${decodeURIComponent(remote[1]).toUpperCase()} (robot, ${remote[2].toUpperCase()}:)`;
  const ds = sample ? s.data.dataset(sample.uri) : undefined;
  if (ds) return ds.label;
  const base = path.basename(group);
  return base || group;
}

/**
 * Modified-vs-snapshot status lives in core/containerCompare.ts (shared with the
 * CodeLens and the diff command); the trees import it from there.
 */

/** "numreg.va" / "Numeric registers · 200" rather than a path with a count on the end */
function sourceRow(src: { file: string; kind: string; entries: number }): { label: string; desc: string; tooltip: string } {
  return { label: path.basename(src.file), desc: `${src.kind} · ${src.entries}`, tooltip: src.file };
}

function isTpBinary(p: ProgramInfo) { return p.kind === 'binary' && /TP/.test(p.programType ?? ''); }

/**
 * TP programs, one per name per robot. A backup carries X.TP next to X.LS for every program
 * the controller exported as text; the .tp is the same program and listing both doubled
 * every folder. The .ls is the row; a .tp appears only where no .ls of that name exists
 * (the controller lacked ASCII upload, or the export skipped it) - it still resolves CALLs.
 */
function tpProgramsOnePerName(all: ProgramInfo[]): ProgramInfo[] {
  const byKey = new Map<string, ProgramInfo>();
  for (const p of all) {
    if (!(p.kind === 'tp' || isTpBinary(p))) continue;
    const key = `${p.group}|${p.name.toUpperCase()}`;
    const prev = byKey.get(key);
    if (!prev || (prev.kind === 'binary' && p.kind === 'tp')) byKey.set(key, p);
  }
  return [...byKey.values()];
}
function isPcBinary(p: ProgramInfo) { return p.kind === 'binary' && /KAREL/.test(p.programType ?? ''); }

// ---------------------------------------------------------------------------
type PNode =
  | { type: 'robot'; group: string; programs: ProgramInfo[] }
  | { type: 'program'; info: ProgramInfo }
  | { type: 'group'; label: string; info: ProgramInfo; items: string[]; icon: string }
  | { type: 'ref'; name: string; near: vscode.Uri };

/** the Calls / Called by children shared by both program trees */
function programChildren(s: FanucServices, info: ProgramInfo): PNode[] {
  const out: PNode[] = [];
  const near = info.uri;
  const callees = [...new Set([...info.calls, ...info.macros.map(m => s.data.macro(m, near)?.progName.toUpperCase()).filter((x): x is string => !!x)])].sort();
  const callers = s.index.callers(info.name, near).map(c => c.name).sort();
  if (callees.length) out.push({ type: 'group', label: 'Calls', info, items: callees, icon: 'arrow-right' });
  if (callers.length) out.push({ type: 'group', label: 'Called by', info, items: callers, icon: 'arrow-left' });
  return out;
}

function refItem(s: FanucServices, el: { name: string; near: vscode.Uri }): vscode.TreeItem {
  const info = s.index.get(el.name, el.near);
  const sameRobot = info && s.index.groupOf(info.uri) === s.index.groupOf(el.near);
  const it = new vscode.TreeItem(el.name, vscode.TreeItemCollapsibleState.None);
  it.description = !info ? 'not found' : !sameRobot ? `in ${path.basename(path.dirname(info.uri.fsPath))}` : info.kind === 'binary' ? 'compiled only' : info.comment ?? '';
  it.iconPath = !info
    ? icon('warning', TYPE_COLOR.missing)
    : !sameRobot
      ? icon('references', 'descriptionForeground')
      : icon(info.kind === 'binary' ? 'file-binary' : info.kind === 'karel' ? 'symbol-class' : 'file-code');
  it.tooltip = !info ? `${el.name} is not in this robot's folder or anywhere in the workspace.` : `${info.kind === 'karel' ? 'KAREL source' : info.kind === 'binary' ? info.programType : 'TP program'} · ${vscode.workspace.asRelativePath(info.uri)}${sameRobot ? '' : ' (another robot\'s folder)'}`;
  if (info) it.command = { command: 'robotCode.views.revealInEditor', title: 'Open', arguments: [info.uri] };
  return it;
}

/** robotCode.views.latestBackupsOnly - hide every robot folder that is not RUKUS's Latest copy */
export function latestOnly(): boolean { return config<boolean>('views.latestBackupsOnly', false); }

/**
 * One row per robot folder, in backup-store order: RUKUS's `Latest` copies first, then the
 * dated backups newest first, then everything else by name (beta list 2, item 2). With
 * "latest backups only" on, the dated copies are left out - as long as there is a Latest to
 * show; a workspace with no Latest folder shows everything, so the filter can never empty
 * the view.
 */
function robotRows(s: FanucServices, groups: Map<string, ProgramInfo[]>): Array<{ type: 'robot'; group: string; programs: ProgramInfo[] }> {
  let rows = [...groups.entries()].map(([group, programs]) => ({ type: 'robot' as const, group, programs }));
  if (latestOnly() && rows.some(r => backupRank(r.group).latest)) rows = rows.filter(r => backupRank(r.group).latest);
  return rows.sort((a, b) => compareBackupDirs(a.group, b.group) || groupLabel(s, a.group, a.programs[0]).localeCompare(groupLabel(s, b.group, b.programs[0])));
}

/** How a robot's programs read against the snapshot, and whether the robot side was compared. */
function syncCounts(s: FanucServices, programs: ProgramInfo[]) {
  let synced = 0, modified = 0, missing = 0, robot = 0, total = 0;
  for (const p of programs) {
    const st = snapshotStatus(s, p);
    if (!st) continue;   // no container: not part of the snapshot story
    total++;
    if (st.state === 'same') synced++;
    else if (st.state === 'modified') modified++;
    else missing++;
    if (robotCompareOf(p.uri.fsPath)?.differs) robot++;
  }
  return { synced, modified, missing, robot, total };
}

function robotItem(s: FanucServices, group: string, programs: ProgramInfo[], what: string): vscode.TreeItem {
  const it = new vscode.TreeItem(groupLabel(s, group, programs[0]), vscode.TreeItemCollapsibleState.Collapsed);
  const rank = /^[a-z][a-z0-9+.-]*:\/\//i.test(group) ? undefined : backupRank(group);
  const c = syncCounts(s, programs);
  it.description = [
    `${programs.length} ${what}`,
    rank?.latest ? 'Latest' : rank?.date,
    c.total ? `${c.synced}/${c.total} synced` : '',
    c.modified ? `↑${c.modified}` : '',
    c.robot ? `↓${c.robot}` : '',
    c.missing ? `?${c.missing}` : '',
  ].filter(Boolean).join(' · ');
  it.tooltip = `${group}${c.total ? `\n\n${c.synced}/${c.total} synced with the snapshot${c.modified ? `, ${c.modified} with local changes` : ''}${c.missing ? `, ${c.missing} not in the snapshot` : ''}${c.robot ? `, ${c.robot} where the robot changed` : ''}.` : ''}`;
  it.iconPath = icon('vm'); it.contextValue = 'robot-folder';
  // a robot's device (`fanuc://robot/md`) is not a path on disk; Uri.file would make `file:///fanuc:/...`
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(group)) it.resourceUri = vscode.Uri.file(group);
  return it;
}

class TpProgramsTree implements vscode.TreeDataProvider<PNode> {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;
  constructor(private s: FanucServices) {
    s.index.onDidChange(() => this._onDidChange.fire());
    s.data.onDidChange(() => this._onDidChange.fire());
    comparedChanged.event(() => this._onDidChange.fire());
  }
  refresh() { this._onDidChange.fire(); }

  /** one row per program name per robot: the .ls when there is one, the .tp only when there is not.
   *  Snapshot (reference) copies are never rows - they resolve CALLs but are not for editing. */
  private mine(): ProgramInfo[] { return tpProgramsOnePerName(this.s.index.list().filter(p => !p.reference)); }

  getChildren(el?: PNode): PNode[] {
    if (!el) {
      const groups = new Map<string, ProgramInfo[]>();
      for (const p of this.mine()) { const arr = groups.get(p.group) ?? []; arr.push(p); groups.set(p.group, arr); }
      if (groups.size <= 1) return this.mine().map(info => ({ type: 'program', info }));
      return robotRows(this.s, groups);
    }
    if (el.type === 'robot') return el.programs.map(info => ({ type: 'program', info }));
    if (el.type === 'program') return programChildren(this.s, el.info);
    if (el.type === 'group') return el.items.map(name => ({ type: 'ref', name, near: el.info.uri }));
    return [];
  }

  getTreeItem(el: PNode): vscode.TreeItem {
    if (el.type === 'robot') return robotItem(this.s, el.group, el.programs, 'TP programs');
    if (el.type === 'program') {
      const info = el.info;
      const it = new vscode.TreeItem(info.name, info.kind === 'binary' ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Collapsed);
      const snap = snapshotStatus(this.s, info);
      const rc = robotCompareOf(info.uri.fsPath);
      const rel = syncRelation(snap, rc);
      const bits = [info.comment ?? '', info.programType === 'Macro' ? '(macro program)' : '', info.kind === 'binary' ? 'compiled only (.tp)' : '', info.rawTokens ? `⚠ ${info.rawTokens} raw` : '', snap || rc ? rel.symbol : ''].filter(Boolean);
      it.description = bits.join(' · ');
      (it as any).filterText = `${info.name} ${info.comment ?? ''} ${rel.symbol}`;
      const robotNote = rc ? `\n\nRobot: ${rc.differs ? `differs (${rc.changed ?? '?'} line(s))${rc.metadataOnly ? ' - metadata only' : ''}` : 'identical'}${rc.at ? `, compared ${Math.round((Date.now() - rc.at) / 1000)}s ago` : ''}` : '';
      it.tooltip = new vscode.MarkdownString(`**${info.name}** — TP program${info.comment ? ` — ${info.comment}` : ''}\n\n${vscode.workspace.asRelativePath(info.uri)}\n\n${info.kind === 'binary' ? `${info.programType} — no ASCII export in this backup; CALLs to it resolve, there is nothing to read.` : `${info.lineCount} lines · ${info.labels} labels · ${info.positions} positions`}${snap ? `\n\n**${rel.symbol}** — ${rel.words}` : ''}${robotNote}${info.rawTokens ? `\n\n⚠ ${info.rawTokens} bracket argument${info.rawTokens === 1 ? '' : 's'} read on the fallback rule (see Problems when open)` : ''}`);
      it.iconPath = info.kind === 'binary' ? icon('file-binary', 'disabledForeground') : icon('file-code', rel.modified ? MODIFIED_COLOR : undefined);
      it.command = { command: 'robotCode.views.revealInEditor', title: 'Open', arguments: [info.uri] };
      it.contextValue = snap?.state === 'modified' ? 'program-modified' : 'program';
      return it;
    }
    if (el.type === 'group') {
      const it = new vscode.TreeItem(el.label, vscode.TreeItemCollapsibleState.Collapsed);
      it.description = `${el.items.length}`; it.iconPath = icon(el.icon, 'descriptionForeground');
      return it;
    }
    return refItem(this.s, el);
  }
}

class PcProgramsTree implements vscode.TreeDataProvider<PNode> {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;
  constructor(private s: FanucServices) {
    s.index.onDidChange(() => this._onDidChange.fire());
    s.data.onDidChange(() => this._onDidChange.fire());
    comparedChanged.event(() => this._onDidChange.fire());
  }
  refresh() { this._onDidChange.fire(); }

  /** one row per program name: the .kl source when there is one, else the .pc.
   *  Snapshot (reference) copies are never rows. */
  private mine(): ProgramInfo[] {
    const byName = new Map<string, ProgramInfo>();
    for (const p of this.s.index.list().filter(p => !p.reference && (p.kind === 'karel' || isPcBinary(p)))) {
      const key = `${p.group}|${p.name}`;
      const prev = byName.get(key);
      if (!prev || (prev.kind === 'binary' && p.kind === 'karel')) byName.set(key, p);
    }
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
  private hasBinary(p: ProgramInfo): boolean { return this.s.index.all(p.name).some(x => x.group === p.group && isPcBinary(x)); }

  getChildren(el?: PNode): PNode[] {
    if (!el) {
      const groups = new Map<string, ProgramInfo[]>();
      for (const p of this.mine()) { const arr = groups.get(p.group) ?? []; arr.push(p); groups.set(p.group, arr); }
      if (groups.size <= 1) return this.mine().map(info => ({ type: 'program', info }));
      return robotRows(this.s, groups);
    }
    if (el.type === 'robot') return el.programs.map(info => ({ type: 'program', info }));
    if (el.type === 'program') return programChildren(this.s, el.info);
    if (el.type === 'group') return el.items.map(name => ({ type: 'ref', name, near: el.info.uri }));
    return [];
  }

  getTreeItem(el: PNode): vscode.TreeItem {
    if (el.type === 'robot') return robotItem(this.s, el.group, el.programs, 'PC programs');
    if (el.type === 'program') {
      const info = el.info;
      const callers = this.s.index.callers(info.name, info.uri).length;
      const it = new vscode.TreeItem(info.name, callers ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
      const compiled = info.kind === 'binary' ? 'compiled only (.pc)' : this.hasBinary(info) ? 'source + .pc' : 'source';
      const snap = snapshotStatus(this.s, info);
      const rc = robotCompareOf(info.uri.fsPath);
      const rel = syncRelation(snap, rc);
      it.description = [info.comment ?? '', compiled, snap || rc ? rel.symbol : ''].filter(Boolean).join(' · ');
      (it as any).filterText = `${info.name} ${info.comment ?? ''} ${rel.symbol}`;
      const robotNote = rc ? `\n\nRobot: ${rc.differs ? `differs (${rc.changed ?? '?'} line(s))${rc.metadataOnly ? ' - metadata only' : ''}` : 'identical'}` : '';
      it.tooltip = new vscode.MarkdownString(`**${info.name}** — PC program (KAREL)${info.comment ? ` — ${info.comment}` : ''}\n\n${vscode.workspace.asRelativePath(info.uri)}\n\n${info.kind === 'binary' ? 'Only the compiled .pc is in this backup; CALLs to it resolve, there is no source to read.' : `${info.lineCount} lines of KAREL source${this.hasBinary(info) ? ', compiled .pc alongside' : ''}`}${snap ? `\n\n**${rel.symbol}** — ${rel.words}` : ''}${robotNote}`);
      it.iconPath = icon(info.kind === 'karel' ? 'symbol-class' : 'file-binary', rel.modified ? MODIFIED_COLOR : undefined);
      it.command = { command: 'robotCode.views.revealInEditor', title: 'Open', arguments: [info.uri] };
      it.contextValue = snap?.state === 'modified' ? 'program-modified' : 'program';
      return it;
    }
    if (el.type === 'group') {
      const it = new vscode.TreeItem(el.label, vscode.TreeItemCollapsibleState.Collapsed);
      it.description = `${el.items.length}`; it.iconPath = icon(el.icon, 'descriptionForeground');
      return it;
    }
    return refItem(this.s, el);
  }
}

// ---------------------------------------------------------------------------
type MNode =
  | { type: 'robot'; ds: Dataset }
  | { type: 'macro'; ds: Dataset; m: MacroEntry }
  | { type: 'user'; name: string; near: vscode.Uri };

/** The controller's macro table: instruction name → program, with whether the program is there. */
class MacrosTree implements vscode.TreeDataProvider<MNode> {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;
  constructor(private s: FanucServices) { s.index.onDidChange(() => this._onDidChange.fire()); s.data.onDidChange(() => this._onDidChange.fire()); }

  private near(ds: Dataset) { return vscode.Uri.file(ds.folder); }
  private macrosOf(ds: Dataset): MNode[] { return [...ds.macros.values()].sort((a, b) => a.index - b.index).map(m => ({ type: 'macro', ds, m })); }

  getChildren(el?: MNode): MNode[] {
    if (!el) {
      const withMacros = this.s.data.datasets.filter(d => d.macros.size);
      if (!withMacros.length) return [];
      if (withMacros.length === 1) return this.macrosOf(withMacros[0]);
      return withMacros.map(ds => ({ type: 'robot', ds }));
    }
    if (el.type === 'robot') return this.macrosOf(el.ds);
    if (el.type === 'macro') return this.s.index.list(this.near(el.ds)).filter(p => p.macros.includes(el.m.macroName)).map(p => ({ type: 'user', name: p.name, near: p.uri }));
    return [];
  }

  getTreeItem(el: MNode): vscode.TreeItem {
    if (el.type === 'robot') {
      const it = new vscode.TreeItem(el.ds.label, vscode.TreeItemCollapsibleState.Collapsed);
      const missing = [...el.ds.macros.values()].filter(m => !this.s.index.get(m.progName, this.near(el.ds))).length;
      it.description = `${el.ds.macros.size} macros${missing ? ` · ⚠ ${missing} missing` : ''}`;
      it.tooltip = el.ds.folder; it.iconPath = icon('vm');
      return it;
    }
    if (el.type === 'macro') {
      const target = this.s.index.get(el.m.progName, this.near(el.ds));
      const users = this.s.index.list(this.near(el.ds)).filter(p => p.macros.includes(el.m.macroName)).length;
      const it = new vscode.TreeItem(el.m.macroName, users ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
      it.description = `→ ${el.m.progName}${target ? '' : ' · ⚠ not in backup'}${users ? ` · used by ${users}` : ''}`;
      (it as any).filterText = `${el.m.macroName} ${el.m.progName}`;
      it.tooltip = `Macro table entry ${el.m.index}: "${el.m.macroName}" runs ${el.m.progName}${target ? ` (${target.kind === 'karel' || isPcBinary(target) ? 'PC program' : 'TP program'})` : ' — that program is not in this backup or the workspace'}\n${users} program${users === 1 ? '' : 's'} use${users === 1 ? 's' : ''} it`;
      it.iconPath = target ? icon('symbol-event') : icon('warning', TYPE_COLOR.missing);
      if (target) it.command = { command: 'robotCode.views.revealInEditor', title: 'Open', arguments: [target.uri] };
      it.contextValue = 'macro';
      return it;
    }
    const info = this.s.index.get(el.name, el.near);
    const it = new vscode.TreeItem(el.name, vscode.TreeItemCollapsibleState.None);
    it.description = 'uses it'; it.iconPath = icon('file-code');
    if (info) it.command = { command: 'robotCode.views.revealInEditor', title: 'Open', arguments: [info.uri] };
    return it;
  }
}

// ---------------------------------------------------------------------------
type SNode =
  | { type: 'robot'; marker: RobotMarker; prov?: SnapshotProvenance; ds?: Dataset }
  | { type: 'scope'; marker: RobotMarker; scope: 'programs' | 'data' | 'files' }
  | { type: 'file'; marker: RobotMarker; entry: SnapshotFileEntry; scope: 'programs' | 'data' | 'files' }
  | { type: 'dir'; marker: RobotMarker; prefix: string; entries: SnapshotFileEntry[] }
  | { type: 'onsnapshot'; marker: RobotMarker; programs: ProgramInfo[] }
  | { type: 'onsnapshot-program'; marker: RobotMarker; info: ProgramInfo };

/** "2 h ago" from a timestamp, so a snapshot file's age reads at a glance. */
function agoWords(at: number): string {
  const s = Math.round((Date.now() - at) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/**
 * The Snapshot view - the robot's index, git-style. One row per robot container with its
 * snapshot date and a modified count; under it scope groups (Programs, Data & I/O) and a
 * raw mirror of the snapshot directory. Every file carries its age and, for programs, its
 * `=`/`≠` state against the working copy. This replaced the old read-only Backup inventory.
 */
class SnapshotTree implements vscode.TreeDataProvider<SNode> {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;
  /** snapshot-dir -> the last listing, keyed by provenance so a fetch invalidates it */
  private readonly listingCache = new Map<string, { sig: string; entries: SnapshotFileEntry[] }>();
  constructor(private s: FanucServices) {
    s.index.onDidChange(() => this.invalidate());
    s.data.onDidChange(() => this.invalidate());
    s.containers.onDidChange(() => this.invalidate());
  }
  refresh() { this._onDidChange.fire(); }
  private invalidate() { this.listingCache.clear(); this._onDidChange.fire(); }

  private programsOf(ds: Dataset): ProgramInfo[] { return this.s.index.backupOf(vscode.Uri.file(path.join(ds.folder, 'x'))).programs; }

  /** programs that exist only in the robot's snapshot - on the controller, never copied into a working folder */
  private snapshotOnly(marker: RobotMarker): ProgramInfo[] {
    const group = marker.root.toLowerCase();
    const progs = this.s.index.list().filter(p => p.group === group);
    const working = new Set(progs.filter(p => !p.reference).map(p => p.name));
    return progs.filter(p => p.reference && !working.has(p.name)).sort((a, b) => a.name.localeCompare(b.name));
  }

  /** working programs of this robot that differ from their snapshot copy, by normalized hash. */
  private modifiedCount(marker: RobotMarker): number {
    const group = marker.root.toLowerCase();
    const refs = new Set(this.s.index.list().filter(p => p.reference && p.group === group && p.textHash).map(p => `${p.name}|${p.textHash}`));
    return this.s.index.list().filter(p => !p.reference && p.group === group && p.textHash).filter(p => !refs.has(`${p.name}|${p.textHash}`)).length;
  }

  private entriesOf(marker: RobotMarker): SnapshotFileEntry[] {
    const key = marker.snapshotDir.toLowerCase();
    const prov = this.s.containers.snapshotInfo(marker.root);
    const sig = `${prov?.updatedAt ?? ''}|${prov?.fileCount ?? ''}`;
    const hit = this.listingCache.get(key);
    if (hit && hit.sig === sig) return hit.entries;
    const entries = listSnapshotFiles(marker.snapshotDir);
    this.listingCache.set(key, { sig, entries });
    return entries;
  }

  getChildren(el?: SNode): SNode[] {
    if (!el) {
      return this.s.containers.markers.map(marker => ({
        type: 'robot' as const,
        marker,
        prov: this.s.containers.snapshotInfo(marker.root),
        ds: this.s.data.datasets.find(d => d.folder.toLowerCase() === marker.snapshotDir.toLowerCase()),
      }));
    }
    if (el.type === 'robot') {
      const out: SNode[] = [
        { type: 'scope', marker: el.marker, scope: 'programs' },
        { type: 'scope', marker: el.marker, scope: 'data' },
        { type: 'scope', marker: el.marker, scope: 'files' },
      ];
      const snapOnly = this.snapshotOnly(el.marker);
      if (snapOnly.length) out.push({ type: 'onsnapshot', marker: el.marker, programs: snapOnly });
      return out;
    }
    if (el.type === 'scope') {
      const entries = this.entriesOf(el.marker);
      if (el.scope === 'programs') return entries.filter(e => isSnapshotProgramFile(path.basename(e.rel))).map(entry => ({ type: 'file' as const, marker: el.marker, entry, scope: 'programs' as const }));
      if (el.scope === 'data') return entries.filter(e => isSnapshotDataFile(path.basename(e.rel))).map(entry => ({ type: 'file' as const, marker: el.marker, entry, scope: 'data' as const }));
      return this.directChildren(el.marker, entries, '').map(child => child);
    }
    if (el.type === 'dir') return this.directChildren(el.marker, el.entries, el.prefix);
    if (el.type === 'onsnapshot') return el.programs.map(info => ({ type: 'onsnapshot-program' as const, marker: el.marker, info }));
    return [];
  }

  /** the direct children (dirs then files) of a prefix in the raw snapshot mirror */
  private directChildren(marker: RobotMarker, entries: SnapshotFileEntry[], prefix: string): SNode[] {
    const p = prefix ? prefix.replace(/\/+$/, '') + '/' : '';
    const dirs = new Set<string>();
    const files: SnapshotFileEntry[] = [];
    for (const e of entries) {
      if (p && !e.rel.toLowerCase().startsWith(p.toLowerCase())) continue;
      const rest = e.rel.slice(p.length);
      if (!rest) continue;
      const slash = rest.indexOf('/');
      if (slash >= 0) dirs.add(rest.slice(0, slash));
      else files.push(e);
    }
    const out: SNode[] = [...dirs].sort((a, b) => a.localeCompare(b)).map(name => ({ type: 'dir' as const, marker, prefix: p + name, entries }));
    for (const file of files.sort((a, b) => a.rel.localeCompare(b.rel))) out.push({ type: 'file', marker, entry: file, scope: 'files' });
    return out;
  }

  /** the `=`/`≠` state of a snapshot program file against its working copy */
  private programState(marker: RobotMarker, entry: SnapshotFileEntry): string {
    const base = path.basename(entry.rel);
    const stem = base.replace(/\.[^.]+$/, '').toUpperCase();
    const ext = path.extname(base).toLowerCase();
    const group = marker.root.toLowerCase();
    // match on the program name (/PROG) first, then the file name: a file whose stem is not
    // its program name is still the same working copy. Match the SAME representation too, so a
    // compiled `.tp` row never reports the source `.ls`'s state (they are not compared).
    const sameExt = (p: { uri: vscode.Uri }) => path.extname(p.uri.fsPath).toLowerCase() === ext;
    const mine = this.s.index.list().filter(p => p.group === group && !p.reference);
    const working = mine.find(p => p.name === stem && sameExt(p))
      ?? mine.find(p => path.basename(p.uri.fsPath).replace(/\.[^.]+$/, '').toUpperCase() === stem && sameExt(p));
    if (!working) return 'on robot only';
    const st = snapshotStatus(this.s, working);
    return st ? snapshotStatusText(st) : '=';
  }

  private fileDescription(marker: RobotMarker, entry: SnapshotFileEntry, scope: 'programs' | 'data' | 'files'): string {
    const prov = this.s.containers.snapshotInfo(marker.root);
    const age = agoWords(snapshotFileAge(prov, entry.rel, entry.mtime));
    const state = scope === 'programs' || isSnapshotProgramFile(path.basename(entry.rel)) ? this.programState(marker, entry) : '';
    return [age, state].filter(Boolean).join(' · ');
  }

  getTreeItem(el: SNode): vscode.TreeItem {
    if (el.type === 'robot') {
      const progs = el.ds ? this.programsOf(el.ds) : [];
      const tp = tpProgramsOnePerName(progs).length;
      const pc = new Set(progs.filter(p => p.kind === 'karel' || isPcBinary(p)).map(p => p.name)).size;
      const snapOnly = this.snapshotOnly(el.marker).length;
      const modified = this.modifiedCount(el.marker);
      const date = el.prov?.date.slice(0, 10);
      const from = el.prov ? (el.prov.source.kind === 'robot' ? `from robot ${el.prov.source.name}` : 'from a backup folder') : '';
      const updated = el.prov?.updatedAt ? ` · updated ${agoWords(Date.parse(el.prov.updatedAt))}` : '';
      const it = new vscode.TreeItem(el.marker.name, vscode.TreeItemCollapsibleState.Collapsed);
      it.description = [
        date ?? 'no snapshot yet',
        el.ds ? `${tp} TP` : '',
        el.ds ? `${pc} PC` : '',
        modified ? `${modified} modified` : '',
        snapOnly ? `${snapOnly} on robot only` : '',
      ].filter(Boolean).join(' · ');
      (it as any).filterText = `${el.marker.name} ${it.description}`;
      it.tooltip = `${el.marker.root}\n${date ? `snapshot ${date}${from ? ` · ${from}` : ''}${updated}\n` : ''}${el.ds ? `${el.ds.sources.length} data files read · ${progs.length} programs` : 'No snapshot yet - run "Fetch" or snapshot it from a backup folder.'}\n\nFetch, pull and push keep the working copy and the robot in sync.`;
      it.iconPath = icon('archive', el.ds ? undefined : 'disabledForeground');
      it.contextValue = 'robot-container';
      it.resourceUri = vscode.Uri.file(el.marker.root);
      return it;
    }
    if (el.type === 'scope') {
      const entries = this.entriesOf(el.marker);
      const count = el.scope === 'programs'
        ? entries.filter(e => isSnapshotProgramFile(path.basename(e.rel))).length
        : el.scope === 'data'
          ? entries.filter(e => isSnapshotDataFile(path.basename(e.rel))).length
          : entries.length;
      const label = el.scope === 'programs' ? 'Programs' : el.scope === 'data' ? 'Data & I/O' : 'All files';
      const it = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Collapsed);
      it.description = `${count}`;
      it.iconPath = icon(el.scope === 'programs' ? 'file-code' : el.scope === 'data' ? 'database' : 'files');
      it.contextValue = `snapshot-scope-${el.scope}`;
      it.tooltip = el.scope === 'files' ? 'Every file in the snapshot, as it sits on disk.' : `Snapshot files fetched from the robot. Right-click to fetch from the controller.`;
      (it as any).filterText = `${el.marker.name} ${label}`;
      return it;
    }
    if (el.type === 'dir') {
      const it = new vscode.TreeItem(path.basename(el.prefix), vscode.TreeItemCollapsibleState.Collapsed);
      it.iconPath = vscode.ThemeIcon.Folder;
      it.contextValue = 'snapshot-dir';
      return it;
    }
    if (el.type === 'onsnapshot') {
      const it = new vscode.TreeItem('On robot, not in working folders', vscode.TreeItemCollapsibleState.Collapsed);
      it.description = `${el.programs.length} program${el.programs.length === 1 ? '' : 's'}`;
      it.iconPath = icon('cloud', 'descriptionForeground');
      it.contextValue = 'snapshot-only';
      it.tooltip = `Programs that exist in the snapshot but not in any working folder:\n\n${el.programs.slice(0, 20).map(p => p.name).join('\n')}${el.programs.length > 20 ? `\n… and ${el.programs.length - 20} more` : ''}\n\nRight-click one to pull its snapshot copy into a working folder.`;
      return it;
    }
    if (el.type === 'onsnapshot-program') {
      const info = el.info;
      const it = new vscode.TreeItem(info.name, vscode.TreeItemCollapsibleState.None);
      it.description = 'on robot only';
      (it as any).filterText = `${info.name} on robot only`;
      it.tooltip = `${info.name} is in the robot's snapshot but not in any working folder.\n\nRight-click to pull its snapshot copy into a working folder - the snapshot itself is never edited.`;
      it.iconPath = icon(info.kind === 'binary' ? 'file-binary' : info.kind === 'karel' ? 'symbol-class' : 'file-code');
      it.contextValue = 'snapshot-only-program';
      it.resourceUri = info.uri;
      it.command = { command: 'robotCode.views.revealInEditor', title: 'Open', arguments: [info.uri] };
      return it;
    }
    // file
    const name = path.basename(el.entry.rel);
    const it = new vscode.TreeItem(name, vscode.TreeItemCollapsibleState.None);
    it.description = this.fileDescription(el.marker, el.entry, el.scope);
    (it as any).filterText = `${name} ${it.description}`;
    it.tooltip = `${el.marker.name}: snapshot/${el.entry.rel}\n${it.description}\n\nRight-click to fetch, pull, diff, download or look at the history.`;
    // amber only when the working copy differs from this snapshot copy - the git-style marker
    const modified = isSnapshotProgramFile(name) && this.programState(el.marker, el.entry).startsWith('≠');
    it.iconPath = isSnapshotProgramFile(name)
      ? icon(/\.(kl)$/i.test(name) ? 'symbol-class' : 'file-code', modified ? MODIFIED_COLOR : undefined)
      : icon('database');
    it.contextValue = 'snapshot-file';
    it.resourceUri = vscode.Uri.file(el.entry.abs);
    it.command = { command: 'robotCode.views.revealInEditor', title: 'Open', arguments: [vscode.Uri.file(el.entry.abs)] };
    return it;
  }
}

// ---------------------------------------------------------------------------
type RKind = 'R' | 'PR' | 'SR' | 'PAYLOAD' | 'UF' | 'UT';
type DNode =
  | { type: 'robot'; ds: Dataset }
  | { type: 'rgroup'; ds: Dataset; kind: RKind; count: number }
  | { type: 'ritem'; ds: Dataset; kind: RKind; index: number; label: string; desc: string; tooltip: string; dim?: boolean }
  | { type: 'iogroup'; ds: Dataset; kind: string; count: number }
  | { type: 'ioitem'; ds: Dataset; kind: string; index: number; comment: string }
  | { type: 'source'; src: { file: string; kind: string; entries: number } }
  // nothing loaded: backups it can offer (issue #3, 1c) - one click loads one
  | { type: 'suggest'; folder: string; label: string; reason: 'hidden' | 'rukus'; detail: string }
  | { type: 'suggestAdd' }
  // the rest of a long group, not drawn yet (robotCode.views.listLimit)
  | { type: 'more'; key: string; left: number; step: number };

const RKIND_LABEL: Record<RKind, string> = { R: 'Numeric registers', PR: 'Position registers', SR: 'String registers', PAYLOAD: 'Payload schedules', UF: 'User frames', UT: 'Tool frames' };
const RKIND_ICON: Record<RKind, string> = { R: 'symbol-number', PR: 'location', SR: 'symbol-string', PAYLOAD: 'package', UF: 'globe', UT: 'tools' };

/** frames worth a row: set to something (the identity means never set up), or the one selected */
function frameRows(ds: Dataset, which: 'UF' | 'UT'): DNode[] {
  const table = which === 'UF' ? ds.frames : ds.tools;
  const active = which === 'UF' ? ds.activeFrame : ds.activeTool;
  return [...table.entries()].filter(([i, f]) => !isIdentityFrame(f) || i === active).sort((a, b) => a[0] - b[0]).map(([i, f]) => ({
    type: 'ritem' as const, ds, kind: which, index: i,
    label: `${which === 'UF' ? 'UFRAME' : 'UTOOL'}[${i}]${i === active ? '  (selected)' : ''}`,
    desc: isIdentityFrame(f) ? 'all zeros' : fmtFrame(f),
    dim: isIdentityFrame(f),
    tooltip: `${which === 'UF' ? 'User' : 'Tool'} frame ${i} on ${ds.label}${i === active ? ' - selected when the backup was taken' : ''}\n${fmtFrame(f)}${isIdentityFrame(f) ? '\n⚠ all zeros: never set up' : ''}`,
  }));
}

/** Registers, payloads and I/O of each backup, in one section. */
class DataTree implements vscode.TreeDataProvider<DNode> {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;
  private liveHooked = false;
  constructor(private s: FanucServices) { s.data.onDidChange(() => this._onDidChange.fire()); }
  private hookLive() { if (!this.liveHooked && this.s.live) { this.liveHooked = true; this.s.live.onDidChange(() => this._onDidChange.fire()); } }

  private groupsFor(ds: Dataset): DNode[] {
    const out: DNode[] = [];
    if (ds.numregs.size) out.push({ type: 'rgroup', ds, kind: 'R', count: [...ds.numregs.values()].filter(r => r.comment || r.value !== 0).length });
    if (ds.posregs.size) out.push({ type: 'rgroup', ds, kind: 'PR', count: [...ds.posregs.values()].filter(r => r.group === 1 && (r.comment || r.kind !== 'uninit')).length });
    if (ds.strregs.size) out.push({ type: 'rgroup', ds, kind: 'SR', count: [...ds.strregs.values()].filter(r => r.comment || r.value).length });
    if (ds.payloads.size) out.push({ type: 'rgroup', ds, kind: 'PAYLOAD', count: [...ds.payloads.values()].filter(p => p.initialized).length });
    if (ds.frames.size) out.push({ type: 'rgroup', ds, kind: 'UF', count: frameRows(ds, 'UF').length });
    if (ds.tools.size) out.push({ type: 'rgroup', ds, kind: 'UT', count: frameRows(ds, 'UT').length });
    for (const [kind, arr] of ds.ioByKind()) out.push({ type: 'iogroup', ds, kind, count: arr.length });
    return out;
  }

  getChildren(el?: DNode): DNode[] {
    const d = this.s.data;
    if (!el) {
      const withData = d.datasets.filter(ds => ds.size > 0);
      if (!withData.length) return this.suggestions();
      if (withData.length === 1) return [...this.groupsFor(withData[0]), ...withData[0].sources.filter(x => !/sysmacro|sysframe|symotn|sysmotn/i.test(x.file)).map(src => ({ type: 'source' as const, src }))];
      return withData.map(ds => ({ type: 'robot', ds }));
    }
    if (el.type === 'robot') return this.groupsFor(el.ds);
    if (el.type === 'iogroup' || el.type === 'rgroup') return this.capped(el, this.groupItems(el));
    return [];
  }

  /** how many of a group are drawn: robotCode.views.listLimit, raised per group by "Show more…" */
  private readonly shown = new Map<string, number>();
  private capped(el: Extract<DNode, { type: 'iogroup' | 'rgroup' }>, items: DNode[]): DNode[] {
    const step = config<number>('views.listLimit', 100);
    if (!step || items.length <= step) return items;
    const key = `${el.ds.folder}|${el.type}|${el.kind}`;
    const n = this.shown.get(key) ?? step;
    if (items.length <= n) return items;
    return [...items.slice(0, n), { type: 'more', key, left: items.length - n, step }];
  }
  refresh() { this.shown.clear(); this._onDidChange.fire(); }
  showMore(key: string) {
    const step = config<number>('views.listLimit', 100) || Infinity;
    this.shown.set(key, (this.shown.get(key) ?? step) + step);
    this._onDidChange.fire();
  }

  private groupItems(el: Extract<DNode, { type: 'iogroup' | 'rgroup' }>): DNode[] {
    if (el.type === 'iogroup') return (el.ds.ioByKind().get(el.kind) ?? []).map(e => ({ type: 'ioitem', ds: el.ds, kind: e.kind, index: e.index, comment: e.comment }));
    const ds = el.ds;
    if (el.kind === 'R') return [...ds.numregs.values()].filter(r => r.comment || r.value !== 0).map(r => ({ type: 'ritem', ds, kind: 'R', index: r.index, label: `R[${r.index}]  ${r.comment}`, desc: `= ${r.value}`, tooltip: `R[${r.index}] "${r.comment}" = ${r.value}` }));
    if (el.kind === 'PR') return [...ds.posregs.values()].filter(r => r.group === 1 && (r.comment || r.kind !== 'uninit')).sort((a, b) => a.index - b.index).map(r => ({ type: 'ritem', ds, kind: 'PR', index: r.index, label: `PR[${r.index}]  ${r.comment}`, desc: r.kind === 'uninit' ? 'uninit' : r.summary, dim: r.kind === 'uninit', tooltip: `PR[${r.index}] "${r.comment}"\n${r.kind}${r.uf !== undefined ? ` UF${r.uf}` : ''}${r.ut !== undefined ? ` UT${r.ut}` : ''}${r.config ? ` ${r.config}` : ''}\n${r.summary}` }));
    if (el.kind === 'UF' || el.kind === 'UT') return frameRows(ds, el.kind);
    if (el.kind === 'PAYLOAD') return [...ds.payloads.values()].map(p => ({ type: 'ritem', ds, kind: 'PAYLOAD', index: p.index, label: `PAYLOAD[${p.index}]  ${p.initialized ? p.comment : ''}`, desc: describePayload(p), dim: !p.initialized, tooltip: p.initialized ? `Payload schedule ${p.index} "${p.comment}"\n${p.mass} kg\nCoG X ${p.cg.x} Y ${p.cg.y} Z ${p.cg.z} mm\nInertia Ix ${p.inertia.ix} Iy ${p.inertia.iy} Iz ${p.inertia.iz} kg·cm²` : `Payload schedule ${p.index} has never been set up (default ${p.mass} kg).` }));
    return [...ds.strregs.values()].filter(r => r.comment || r.value).map(r => ({ type: 'ritem', ds, kind: 'SR', index: r.index, label: `SR[${r.index}]  ${r.comment}`, desc: r.value ? `'${r.value}'` : '', tooltip: `SR[${r.index}] "${r.comment}" = '${r.value}'` }));
  }

  /**
   * The empty view offers what it can load (issue #3, 1c - the robot form's backup chips, for the
   * Registers view): backups taken out of the panel earlier, then the newest RUKUS backup of each
   * robot. Nothing to offer: no rows, and the view's welcome text (Add Backup Folder) shows instead.
   */
  private suggestions(): DNode[] {
    const out: DNode[] = [];
    const seen = new Set<string>();
    const key = (f: string) => path.resolve(f).toLowerCase();
    for (const f of windowFolders('data.hiddenBackupFolders')) {
      if (seen.has(key(f)) || !existsSync(f)) continue;
      seen.add(key(f));
      out.push({ type: 'suggest', folder: f, label: path.basename(f), reason: 'hidden', detail: 'removed from the panel' });
    }
    const root = this.s.rukus?.backupsRoot;
    if (root) for (const b of newestRobotBackups(root)) {
      if (seen.has(key(b.folder))) continue;
      seen.add(key(b.folder));
      out.push({ type: 'suggest', folder: b.folder, label: b.robot, reason: 'rukus', detail: `RUKUS · ${b.cluster} · ${b.taken}` });
    }
    return out.length ? [...out, { type: 'suggestAdd' }] : [];
  }

  getTreeItem(el: DNode): vscode.TreeItem {
    const grey = TYPE_COLOR.data;
    if (el.type === 'suggest') {
      const it = new vscode.TreeItem(`Load ${el.label}`, vscode.TreeItemCollapsibleState.None);
      it.description = el.detail; it.tooltip = `${el.folder}
Click to load this backup's registers, frames and I/O.`;
      it.iconPath = icon(el.reason === 'hidden' ? 'eye' : 'cloud-download');
      it.command = { command: 'robotCode.data.addBackupFolder', title: 'Load backup', arguments: [el.folder] };
      return it;
    }
    if (el.type === 'more') {
      const it = new vscode.TreeItem(`Show ${Math.min(el.step, el.left)} more…`, vscode.TreeItemCollapsibleState.None);
      it.description = `${el.left} not shown`; it.iconPath = icon('ellipsis');
      it.tooltip = 'Long groups show robotCode.views.listLimit at a time (10 / 50 / 100 / 250 / All)';
      it.command = { command: 'robotCode.views._showMore', title: 'Show more', arguments: [el.key] };
      return it;
    }
    if (el.type === 'suggestAdd') {
      const it = new vscode.TreeItem('Add Backup Folder…', vscode.TreeItemCollapsibleState.None);
      it.iconPath = icon('folder-opened'); it.tooltip = 'Pick any controller backup folder';
      it.command = { command: 'robotCode.data.addBackupFolder', title: 'Add Backup Folder' };
      return it;
    }
    if (el.type === 'robot') {
      const it = new vscode.TreeItem(el.ds.label, vscode.TreeItemCollapsibleState.Collapsed);
      it.description = [`${el.ds.numregs.size} R`, `${[...el.ds.posregs.values()].filter(r => r.group === 1).length} PR`, `${el.ds.strregs.size} SR`, el.ds.payloads.size ? `${el.ds.payloads.size} PAYLOAD` : '', `${el.ds.io.size} I/O`].filter(Boolean).join(' · ');
      it.tooltip = el.ds.folder; it.iconPath = icon('vm');
      it.contextValue = 'backup';   // Remove from Backup Panel (beta list 4, item 1) lives on this row now
      return it;
    }
    if (el.type === 'rgroup') {
      const it = new vscode.TreeItem(RKIND_LABEL[el.kind], vscode.TreeItemCollapsibleState.Collapsed);
      it.description = `${el.kind} · ${el.count}`; it.iconPath = icon(RKIND_ICON[el.kind], grey);
      it.tooltip = `${DATA_KIND_DOCS[el.kind]?.description ?? RKIND_LABEL[el.kind]}\n${el.count} with a comment or a value`;
      return it;
    }
    if (el.type === 'iogroup') {
      const name = DATA_KIND_DOCS[el.kind]?.name ?? 'I/O';
      const it = new vscode.TreeItem(`${name}${/s$/.test(name) ? '' : 's'}`, vscode.TreeItemCollapsibleState.Collapsed);
      it.description = `${el.kind} · ${el.count}`;
      it.iconPath = icon(el.kind === 'F' || el.kind === 'M' ? 'symbol-boolean' : /I$/.test(el.kind) ? 'arrow-small-right' : 'arrow-small-left', grey);
      it.tooltip = `${DATA_KIND_DOCS[el.kind]?.description ?? name}\n${el.count} named points`;
      return it;
    }
    if (el.type === 'source') {
      const row = sourceRow(el.src);
      const it = new vscode.TreeItem(row.label, vscode.TreeItemCollapsibleState.None);
      it.description = row.desc; it.tooltip = row.tooltip; it.iconPath = icon('database', grey);
      return it;
    }
    if (el.type === 'ritem') {
      const it = new vscode.TreeItem(el.label, vscode.TreeItemCollapsibleState.None);
      it.description = el.desc; it.tooltip = el.tooltip + '\n\nClick to find uses in this robot\'s programs';
      (it as any).filterText = `${el.label} ${el.desc}`;
      it.iconPath = icon(RKIND_ICON[el.kind], el.dim ? 'disabledForeground' : grey);
      // a frame is not a data reference programs name by kind; there is nothing to "find uses" of
      if (el.kind !== 'UF' && el.kind !== 'UT') it.command = { command: 'robotCode.views.findUses', title: 'Find uses', arguments: [el.kind, el.index, el.ds.folder] };
      return it;
    }
    this.hookLive();
    const it = new vscode.TreeItem(`${el.kind}[${el.index}]  ${el.comment}`, vscode.TreeItemCollapsibleState.None);
    it.tooltip = `${el.kind}[${el.index}:${el.comment}]\n\nClick to find uses in this robot's programs`;
    it.iconPath = icon('circle-outline', grey);
    (it as any).filterText = `${el.kind}[${el.index}] ${el.comment}`;
    it.command = { command: 'robotCode.views.findUses', title: 'Find uses', arguments: [el.kind, el.index, el.ds.folder] };
    const live = this.s.live?.liveValue(el.kind, el.index);
    if (live) {
      // state, not type: ON green, OFF outline, a number orange
      it.description = live.text === 'ON' ? '● ON' : live.text === 'OFF' ? '○ OFF' : `= ${live.text}`;
      it.iconPath = icon(live.text === 'ON' ? 'circle-filled' : live.text === 'OFF' ? 'circle-outline' : 'symbol-number', live.text === 'ON' ? 'testing.iconPassed' : live.text === 'OFF' ? 'descriptionForeground' : undefined);
      it.tooltip = `${el.kind}[${el.index}:${el.comment}]\nRead from ${live.robot}: ${live.text} (${Math.round(live.age / 1000)} s ago)\n\nClick to find uses`;
    }
    return it;
  }
}
