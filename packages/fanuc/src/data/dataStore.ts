/**
 * Controller data from .va dumps, scoped per robot folder.
 *
 * A "dataset" is a folder that contains at least one known .va file (numreg.va, posreg.va,
 * strreg.va, diocfgsv.va, sysmacro.va). A backup tree such as
 *   Backups/Latest/S002R01_(MD)_260912/  … five robots side by side, plus dated copies …
 * yields one dataset per robot folder, and a program is matched to the dataset whose folder
 * contains it. Data from a different robot is never used for a program.
 */
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
export { robotNameFromFolder } from './vaParser';
import { parseSysFrames } from './sysFrameParser';
import type { Xyzwpr } from '../tp/frameMath';
import { parseNumReg, parsePosReg, parseStrReg, parseIoComments, parseMacroTable, parsePayloads, KNOWN_VA_FILES, robotNameFromFolder, type NumRegEntry, type PosRegEntry, type StrRegEntry, type IoEntry, type MacroEntry, type PayloadEntry } from './vaParser';
import { windowFolders, isHiddenBackup, onDidChangeBackupLists } from '@core/util';
import { classifyPath, markerOf, type RobotMarker } from '@core/robotContainers';

export interface DataSource { file: string; kind: string; entries: number }

export class Dataset {
  readonly numregs = new Map<number, NumRegEntry>();
  /** key "group:index" */
  readonly posregs = new Map<string, PosRegEntry>();
  readonly strregs = new Map<number, StrRegEntry>();
  /** key "DI:25" */
  readonly io = new Map<string, IoEntry>();
  /** upper-case macro name → entry */
  readonly macros = new Map<string, MacroEntry>();
  /**
   * User and tool frames from sysframe.va, per robot folder. What makes converting a
   * taught position between frames arithmetic rather than guesswork - see tp/frameMath.ts.
   */
  readonly frames = new Map<number, Xyzwpr>();
  readonly tools = new Map<number, Xyzwpr>();
  /** the user / tool frame selected on the pendant when sysframe.va was written */
  activeFrame?: number;
  activeTool?: number;
  /** payload schedules from symotn.va - what `PAYLOAD[n]` selects */
  readonly payloads = new Map<number, PayloadEntry>();
  /** the mass the controller was using when the backup was taken, kg */
  activePayloadMass?: number;
  readonly sources: DataSource[] = [];
  /** display label, e.g. "S002R01 · Latest" when the same robot appears in several folders */
  label: string;
  constructor(readonly folder: string, readonly name: string) { this.label = name; }

  get size(): number { return this.numregs.size + this.posregs.size + this.strregs.size + this.io.size + this.macros.size + this.payloads.size; }

  comment(kind: string, index: number): string | undefined {
    switch (kind) {
      case 'R': return this.numregs.get(index)?.comment || undefined;
      case 'PR': return this.posreg(index)?.comment || undefined;
      case 'SR': return this.strregs.get(index)?.comment || undefined;
      default: return this.io.get(`${kind}:${index}`)?.comment || undefined;
    }
  }
  posreg(index: number, group = 1): PosRegEntry | undefined { return this.posregs.get(`${group}:${index}`) ?? this.posregs.get(`1:${index}`); }
  macro(name: string): MacroEntry | undefined { return this.macros.get(name.toUpperCase()); }
  ioByKind(): Map<string, IoEntry[]> {
    const out = new Map<string, IoEntry[]>();
    for (const e of this.io.values()) { const arr = out.get(e.kind) ?? []; arr.push(e); out.set(e.kind, arr); }
    for (const arr of out.values()) arr.sort((a, b) => a.index - b.index);
    return new Map([...out.entries()].sort((a, b) => a[0].localeCompare(b[0])));
  }
}

function normFolder(p: string): string { return path.resolve(p).replace(/[\\/]+$/, '').toLowerCase(); }

export class DataStore implements vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;
  readonly datasets: Dataset[] = [];
  private readonly disposables: vscode.Disposable[] = [];
  private timer: NodeJS.Timeout | undefined;
  private refreshing: Promise<void> | undefined;
  /**
   * Set by Services: the resolved .robocode-robot markers, if any. Under a marker the
   * snapshot is the robot's one dataset; .va files elsewhere under the robot folder
   * (dated backups, stray copies) are ignored. Empty = today's behavior.
   */
  markersProvider: () => readonly RobotMarker[] = () => [];

  constructor() {
    const watcher = vscode.workspace.createFileSystemWatcher('**/*.{va,VA}');
    this.disposables.push(watcher,
      watcher.onDidCreate(() => this.scheduleRefresh()),
      watcher.onDidChange(() => this.scheduleRefresh()),
      watcher.onDidDelete(() => this.scheduleRefresh()),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.scheduleRefresh()),
      onDidChangeBackupLists(() => this.scheduleRefresh()),
    );
  }

  dispose() { for (const d of this.disposables) d.dispose(); this._onDidChange.dispose(); }

  get hasData(): boolean { return this.datasets.some(d => d.size > 0); }
  /** all sources, for status/logging */
  get sources(): DataSource[] { return this.datasets.flatMap(d => d.sources); }

  /**
   * Dataset for a file: with .robocode markers, a file under a robot marker gets that
   * robot's snapshot dataset - or nothing, never another robot's and never the
   * single-dataset guess. Without markers: the deepest dataset folder that contains it;
   * when the file is not inside any dataset folder and exactly one dataset exists, that
   * one is used (single-robot workspace). Otherwise undefined — we never guess between robots.
   */
  dataset(uri?: vscode.Uri | string): Dataset | undefined {
    if (uri) {
      const p = normFolder(typeof uri === 'string' ? uri : uri.fsPath);
      const marker = markerOf(p, this.markersProvider());
      if (marker) {
        const snap = normFolder(marker.snapshotDir);
        return this.datasets.find(d => normFolder(d.folder) === snap);
      }
      let best: Dataset | undefined;
      for (const d of this.datasets) {
        const f = normFolder(d.folder);
        if (p === f || p.startsWith(f + path.sep)) { if (!best || f.length > normFolder(best.folder).length) best = d; }
      }
      if (best) return best;
    }
    return this.datasets.length === 1 ? this.datasets[0] : undefined;
  }
  /** the dataset folder a file belongs to (used to group programs of the same robot) */
  folderOf(uri: vscode.Uri | string): string | undefined { return this.dataset(uri)?.folder; }

  comment(kind: string, index: number, uri?: vscode.Uri | string): string | undefined { return this.dataset(uri)?.comment(kind, index); }
  posreg(index: number, group = 1, uri?: vscode.Uri | string): PosRegEntry | undefined { return this.dataset(uri)?.posreg(index, group); }
  macro(name: string, uri?: vscode.Uri | string): MacroEntry | undefined { return this.dataset(uri)?.macro(name); }

  private scheduleRefresh() { if (this.timer) clearTimeout(this.timer); this.timer = setTimeout(() => this.refresh(), 500); }

  /** re-entrant: concurrent callers share the in-flight refresh instead of interleaving */
  async refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.doRefresh().finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }

  private async doRefresh() {
    const markers = this.markersProvider();
    const files: string[] = [];
    if (vscode.workspace.workspaceFolders?.length) {
      const pattern = `**/{${KNOWN_VA_FILES.join(',')},${KNOWN_VA_FILES.map(f => f.toUpperCase()).join(',')}}`;
      for (const u of await vscode.workspace.findFiles(pattern, '**/node_modules/**', 2000)) {
        // container partition: under a robot marker only the snapshot's .va files become
        // datasets - dated backups and stray working-dir .va files are ignored. Files not
        // under any marker keep today's behavior.
        const kind = classifyPath(u.fsPath, markers);
        if (kind === 'working' || kind === 'excluded') continue;
        if (isHiddenBackup(path.dirname(u.fsPath))) continue;   // removed from the Backup panel
        files.push(u.fsPath);
      }
    }
    for (const folder of windowFolders('data.backupFolders')) findVa(folder, files);
    for (let i = files.length - 1; i >= 0; i--) if (isHiddenBackup(path.dirname(files[i]))) files.splice(i, 1);

    // snapshot datasets are named from their robot marker, not their folder (which is
    // literally "snapshot" and would label every robot identically)
    const snapshotNames = new Map<string, string>();
    for (const m of markers) snapshotNames.set(normFolder(m.snapshotDir), m.name);

    const byFolder = new Map<string, Dataset>();
    for (const file of files) {
      const folder = path.dirname(file);
      const key = normFolder(folder);
      let ds = byFolder.get(key);
      if (!ds) { ds = new Dataset(folder, snapshotNames.get(key) ?? robotNameFromFolder(folder)); byFolder.set(key, ds); }
      let text: string;
      try { text = fs.readFileSync(file, 'latin1'); } catch { continue; }
      const base = path.basename(file).toLowerCase();
      if (base === 'numreg.va') { const e = parseNumReg(text); for (const r of e) ds.numregs.set(r.index, r); ds.sources.push({ file, kind: 'Numeric registers', entries: e.length }); }
      else if (base === 'posreg.va') { const e = parsePosReg(text); for (const r of e) ds.posregs.set(`${r.group}:${r.index}`, r); ds.sources.push({ file, kind: 'Position registers', entries: e.length }); }
      else if (base === 'strreg.va') { const e = parseStrReg(text); for (const r of e) ds.strregs.set(r.index, r); ds.sources.push({ file, kind: 'String registers', entries: e.length }); }
      else if (base === 'diocfgsv.va') { const e = parseIoComments(text); for (const r of e) ds.io.set(`${r.kind}:${r.index}`, r); ds.sources.push({ file, kind: 'I/O comments', entries: e.length }); }
      else if (base === 'sysmacro.va') { const e = parseMacroTable(text); for (const r of e) ds.macros.set(r.macroName.toUpperCase(), r); ds.sources.push({ file, kind: 'Macro table', entries: e.length }); }
      else if (base === 'sysframe.va') {
        const e = parseSysFrames(text);
        for (const [i, f] of e.frames) ds.frames.set(i, f);
        for (const [i, t] of e.tools) ds.tools.set(i, t);
        if (e.activeFrame !== undefined) ds.activeFrame = e.activeFrame;
        if (e.activeTool !== undefined) ds.activeTool = e.activeTool;
        ds.sources.push({ file, kind: 'User / tool frames', entries: e.frames.size + e.tools.size });
      }
      else if (base === 'symotn.va' || base === 'sysmotn.va') {
        const e = parsePayloads(text);
        for (const p of e.schedules) ds.payloads.set(p.index, p);
        ds.activePayloadMass = e.activeMass;
        if (e.schedules.length) ds.sources.push({ file, kind: 'Payload schedules', entries: e.schedules.length });
      }
    }
    // labels: disambiguate robots that appear in several folders with the parent folder name
    const byName = new Map<string, Dataset[]>();
    for (const d of byFolder.values()) { const arr = byName.get(d.name) ?? []; arr.push(d); byName.set(d.name, arr); }
    for (const arr of byName.values()) if (arr.length > 1) for (const d of arr) d.label = `${d.name} · ${path.basename(path.dirname(d.folder))}`;

    this.datasets.length = 0;
    this.datasets.push(...[...byFolder.values()].sort((a, b) => a.label.localeCompare(b.label)));
    this._onDidChange.fire();
  }
}

function findVa(dir: string, out: string[], depth = 0) {
  if (depth > 6) return;
  try {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) findVa(p, out, depth + 1);
      else if ((KNOWN_VA_FILES as readonly string[]).includes(e.name.toLowerCase())) out.push(p);
    }
  } catch { /* ignore */ }
}
