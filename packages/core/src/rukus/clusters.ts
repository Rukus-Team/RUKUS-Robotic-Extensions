/**
 * RUKUS's clusters in the sidebar, and the workspace that follows them.
 *
 * Clusters are mixed since RUKUS #28: a cluster's FANUC robots become the cell's controllers
 * here; its ABB robots are picked up by the ABB package from current() (packages/abb/src/live/
 * rukusCluster.ts), not written anywhere. Encrypted passwords (dpapi:v1:) are decrypted with dpapi.ts.
 *
 * With RUKUS on the PC there is nothing to set up by hand: its clusters are the cells.
 * The "RUKUS Clusters" view lists them straight from RUKUS's data folder; clicking one
 * makes that cluster's backup folder (`<backups root>\<cluster>`) the workspace and writes
 * the cluster's robots into the folder's `.robocode-cell\cell.json`, so the Controllers
 * view knows them and the Programs view shows the backups Latest first. Click another
 * cluster and the workspace switches to that one. RUKUS's files are watched: a robot added
 * in RUKUS shows up here without a step, and a cell whose workspace is open is re-synced.
 *
 * RUKUS is the store of record. The one thing that goes the other way is "Send Cell to
 * RUKUS", which writes the open cell's controllers into the cluster file keeping every
 * RUKUS-only field (KCL, passwords, notes, write lock...) - and never deletes a robot.
 *
 * The Initialize Cell Container wizard stays for a PC without RUKUS. The pure reading and
 * naming logic is in store.ts; this file is the VS Code half.
 */
import { watchViewVisibility } from '../views/viewVisibility';
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Services } from '../services';
import { config, viewDeclared, showRecoverableError } from '../util';
import { rukusInstallDir, RUKUS_DOWNLOAD_URL } from './launch';
import { locateStudio, isStudioWorkspace, detectRukus, parseStudioWorkspace, studioClusters, STUDIO_WORKSPACE_FILE, type RukusSource } from './studio';
import { unprotectAll, resolvePassword, isProtected } from './dpapi';
import {
  resolveDataRoot, readAppSettings, clustersFolder, backupsFolder, listClusters, clusterControllers,
  mergeControllersIntoCluster, templateToRegExp, clusterOfFolder, placeBackup, realFs, RUKUS_LATEST, RUKUS_MANIFEST,
  type RukusAppSettings, type RukusCluster, type RukusDataRoot, type RukusRobot,
} from './store';
import {
  CELL_DIR, CELL_JSON, parseCellJson, writeCellMarker, setCellRukusLink, writeRobotJson, underPath,
  ROBOT_DIR, ROBOT_JSON, type CellControllerSpec, type CellMarker,
} from '../robotContainers';
import { planClusterLink, linkFor, describeRobotPlan, aggregateBrand, type RobotLinkPlan } from '../clusterLink';
import { ROBOT_FOLDER_PATTERNS, robotNameFromFolder } from '@core/backupFolders';
import { commandRegistrar } from '../commandBoundary';

export class RukusClusters implements vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;
  private watchers: vscode.Disposable[] = [];
  private timer: NodeJS.Timeout | undefined;
  private syncing = false;

  dataRoot: RukusDataRoot | undefined;
  /** the data root exists on this PC */
  available = false;
  settings: RukusAppSettings = readAppSettings('', { exists: () => false, readText: () => undefined });
  clustersDir = '';
  backupsRoot = '';
  clusters: RukusCluster[] = [];
  lastError: string | undefined;

  constructor(private readonly s: Services) {}

  dispose() { this.stopWatching(); if (this.timer) clearTimeout(this.timer); this._onDidChange.dispose(); }

  /** Documents\RUKUS, the portable root, or robotCode.rukus.dataFolder */
  private async locate(): Promise<RukusDataRoot> {
    const override = config<string>('rukus.dataFolder', '').trim();
    if (override) return { root: override, portable: false };
    const documents = path.join(os.homedir(), 'Documents');
    return resolveDataRoot(await rukusInstallDir(), documents, realFs);
  }

  /**
   * Where the clusters come from: RUKUS Studio's workspace (rukus-workspace.json) when Studio is
   * here - it succeeds RUKUS - else RUKUS's data folder (studio.ts, detectRukus).
   */
  source: RukusSource = 'none';
  /** RUKUS or RUKUS Studio is on this PC */
  found = false;
  /** what the side bar calls it: "RUKUS Studio" or "RUKUS" */
  label: 'RUKUS Studio' | 'RUKUS' = 'RUKUS';
  /** a Studio cluster's folder in its workspace, by lower-case cluster name */
  private studioFolders = new Map<string, string>();

  /** Studio is the source: its clusters are read, never written (Studio imports cell folders itself) */
  get isStudio(): boolean { return this.source === 'studio'; }

  async refresh(): Promise<void> {
    try {
      const override = config<string>('rukus.dataFolder', '').trim();
      this.dataRoot = await this.locate();
      const studio = override ? { installed: false } : locateStudio({ localAppData: process.env.LOCALAPPDATA, documents: path.join(os.homedir(), 'Documents'), studioHome: process.env.RUKUS_STUDIO_HOME });
      if (override) studio.installed = locateStudio({ localAppData: process.env.LOCALAPPDATA, documents: '' }).installed;
      const d = detectRukus({ override, overrideIsStudio: !!override && isStudioWorkspace(override), studio, rukusRootExists: realFs.exists(this.dataRoot.root) });
      this.source = d.source; this.found = d.found; this.label = d.label;
      this.studioFolders = new Map();
      ROBOT_FOLDER_PATTERNS.length = 0;
      if (d.source === 'studio' && d.studioWorkspace) {
        // the workspace folder is both "clusters folder" and "backups root": <cluster path>\<robot>\<backup>
        this.dataRoot = { root: d.studioWorkspace, portable: false };
        this.settings = readAppSettings('', { exists: () => false, readText: () => undefined });
        this.clustersDir = d.studioWorkspace;
        this.backupsRoot = d.studioWorkspace;
        const text = realFs.readText(path.join(d.studioWorkspace, STUDIO_WORKSPACE_FILE));
        const ws = text === undefined ? undefined : parseStudioWorkspace(text, d.studioWorkspace);
        if (!ws) throw new Error(`${path.join(d.studioWorkspace, STUDIO_WORKSPACE_FILE)} is not a RUKUS Studio workspace file this version reads`);
        const read = studioClusters(ws);
        this.clusters = read.clusters;
        this.studioFolders = read.folders;
        this.available = true;
      } else {
        this.available = d.source === 'rukus';
        this.settings = readAppSettings(this.dataRoot.root);
        this.clustersDir = clustersFolder(this.dataRoot.root, this.settings);
        this.backupsRoot = backupsFolder(this.dataRoot.root, this.settings);
        this.clusters = this.available ? listClusters(this.clustersDir) : [];
        // the naming preset RUKUS is set to is the one the wizard and the views read folders with
        if (this.available) { try { ROBOT_FOLDER_PATTERNS.push(templateToRegExp(this.settings.backupRobotFolderTemplate)); } catch { /* an unusable template is RUKUS's problem to report */ } }
      }
      this.lastError = undefined;
    } catch (e: any) {
      this.available = false; this.clusters = []; this.lastError = e?.message ?? String(e);
    }
    // robotCode.rukusAvailable: RUKUS Studio or RUKUS is on this PC (the one key views and menus use).
    // What writes RUKUS's own files (Send Cell) checks isStudio itself: Studio's workspace file is never written.
    void vscode.commands.executeCommand('setContext', 'robotCode.rukusAvailable', this.found);
    this.watch();
    this._onDidChange.fire();
    // a cell whose workspace is open follows RUKUS's file without a step
    if (this.current()) await this.syncCurrent(false);
    void this.offerPending();
  }

  private stopWatching() { for (const w of this.watchers) w.dispose(); this.watchers = []; }

  private watch() {
    this.stopWatching();
    if (!this.available || !this.dataRoot) return;
    const schedule = () => { if (this.timer) clearTimeout(this.timer); this.timer = setTimeout(() => { this.timer = undefined; void this.refresh(); }, 400); };
    if (this.isStudio) {
      // Studio saves every change to its workspace file at once: a robot added there shows here
      const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(this.dataRoot.root), STUDIO_WORKSPACE_FILE));
      this.watchers.push(w, w.onDidChange(schedule), w.onDidCreate(schedule), w.onDidDelete(schedule));
      return;
    }
    for (const [dir, glob] of [[this.clustersDir, '*.json'], [this.dataRoot.root, 'AppSettings.json']] as const) {
      if (!realFs.exists(dir)) continue;
      const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(dir), glob));
      this.watchers.push(w, w.onDidChange(schedule), w.onDidCreate(schedule), w.onDidDelete(schedule));
    }
    // A backup RUKUS (or its scheduler) finishes into the open cluster's Latest: the manifest
    // is the last file written, so its arrival is the moment the backup is whole. Say so.
    const cur = this.current();
    if (cur) {
      const latest = path.join(cur.folder, RUKUS_LATEST);
      const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(latest), `*/${RUKUS_MANIFEST}`));
      const landed = (uri: vscode.Uri) => {
        let m: any = {};
        try { m = JSON.parse(fs.readFileSync(uri.fsPath, 'utf8')); } catch { /* half-written: the change event will follow */ }
        if (!m?.RobotName) return;
        const when = typeof m.FinishedUtc === 'string' ? new Date(m.FinishedUtc) : undefined;
        if (when && Date.now() - when.getTime() > 10 * 60 * 1000) return;   // an old manifest touched, not a fresh backup
        const files = typeof m.FilesDownloaded === 'number' ? `${m.FilesDownloaded} files` : '';
        const by = typeof m.RukusVersion === 'string' && /Robot Code/.test(m.RukusVersion) ? '' : ' by RUKUS';
        this.s.output.appendLine(`[RUKUS] fresh backup of ${m.RobotName} landed in Latest${by}: ${path.basename(path.dirname(uri.fsPath))} (${files || 'manifest read'})`);
        vscode.window.setStatusBarMessage(`$(archive) Fresh backup of ${m.RobotName} landed in Latest${by}${files ? ` · ${files}` : ''}`, 15000);
        void this.afterSync();
      };
      this.watchers.push(w, w.onDidCreate(landed), w.onDidChange(landed));
    }
  }

  cluster(name: string): RukusCluster | undefined { return this.clusters.find(c => c.name.toLowerCase() === name.toLowerCase()); }

  /** the cluster folder for `name` in the backup store, as RUKUS's batch template lays it out */
  folderOf(name: string): string {
    // a Studio cluster is a folder of its workspace: <workspace>\<cluster path>
    if (this.isStudio) return this.studioFolders.get(name.toLowerCase()) ?? path.join(this.backupsRoot, ...name.split('/'));
    return placeBackup(this.backupsRoot, this.settings, name, '', 'MD').clusterFolder;
  }

  /** the cluster whose folder is the first workspace folder, when it is one */
  current(): { cluster: RukusCluster; folder: string } | undefined {
    if (!this.available) return undefined;
    const wf = vscode.workspace.workspaceFolders?.[0];
    if (!wf || wf.uri.scheme !== 'file') return undefined;
    if (this.isStudio) {
      const norm = (p: string) => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
      const here = norm(wf.uri.fsPath);
      const cluster = this.clusters.find(c => norm(this.folderOf(c.name)) === here);
      return cluster ? { cluster, folder: wf.uri.fsPath } : undefined;
    }
    const name = clusterOfFolder(this.backupsRoot, wf.uri.fsPath);
    const cluster = name ? this.cluster(name) : undefined;
    return cluster ? { cluster, folder: wf.uri.fsPath } : undefined;
  }

  /** the clusters the open cell container(s) are linked to */
  linkedClusterNames(): string[] {
    const names = new Set<string>();
    for (const cell of this.s.containers.cells) if (cell.rukus?.cluster) names.add(cell.rukus.cluster);
    return [...names];
  }

  /**
   * Link a cell to one of RUKUS's clusters. It rewrites the cell's controllers and reconciles
   * every robot container to the cluster's identity, so nothing is written before the user
   * confirms; a robot that already has a container is a merge, never a silent overwrite.
   */
  async linkCell(cellRoot: string, clusterName: string): Promise<void> {
    const cluster = this.cluster(clusterName);
    if (!cluster) { vscode.window.showWarningMessage(`${this.label} has no cluster called "${clusterName}".`); return; }
    const cellFile = path.join(cellRoot, CELL_DIR, CELL_JSON);
    let cell: CellMarker | undefined;
    try { cell = parseCellJson(fs.readFileSync(cellFile, 'utf8'), cellRoot).cell; } catch { /* no cell.json yet */ }
    const markers = this.s.containers.markers.filter(m => underPath(m.root, cellRoot));
    let folders: string[] = [];
    try {
      folders = fs.readdirSync(cellRoot, { withFileTypes: true })
        .filter(e => e.isDirectory() && !e.name.startsWith('.'))
        .map(e => path.join(cellRoot, e.name));
    } catch { /* unreadable: a robot with no folder simply asks */ }
    const plan = planClusterLink(cluster, cell, markers, folders);

    const lines = [
      plan.renameCell ? `cell name: ${cell?.name ?? '(none)'} → ${plan.cellName}` : '',
      plan.changedControllers.length ? `controllers updated: ${plan.changedControllers.join(', ')}` : '',
      ...plan.robots.map(describeRobotPlan),
    ].filter(Boolean);
    const pick = await vscode.window.showInformationMessage(
      `Link this cell to RUKUS cluster "${cluster.name}"?`,
      { modal: true, detail: lines.join('\n') || 'Already in sync.' },
      'Apply all', 'Review each', 'Cancel');
    if (!pick || pick === 'Cancel') return;

    const applying: RobotLinkPlan[] = [];
    for (const rp of plan.robots) {
      if (rp.action === 'choose-folder') {
        const dir = await vscode.window.showOpenDialog({
          canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
          defaultUri: vscode.Uri.file(cellRoot),
          title: `Folder for ${rp.robot.name} (the robot container goes inside it)`,
        });
        if (!dir?.[0]) continue;
        rp.folder = dir[0].fsPath;
        rp.action = 'create';
      }
      if (pick === 'Review each') {
        const go = await vscode.window.showInformationMessage(
          `Robot ${rp.robot.name}`, { modal: true, detail: describeRobotPlan(rp) }, 'Apply', 'Skip');
        if (go !== 'Apply') continue;
      }
      applying.push(rp);
    }

    writeCellMarker(cellRoot, {
      name: plan.cellName,
      controllers: plan.controllers,
      brand: plan.brand ?? cell?.brand,
      rukus: linkFor(cluster, this.clustersDir),
    });
    for (const rp of applying) this.applyRobotLink(rp);
    const { secrets, unreadable } = await this.storeClusterSecrets(cluster);
    await this.afterSync();
    this._onDidChange.fire();
    const bits = [
      `${applying.length} robot(s) reconciled`,
      plan.changedControllers.length ? `${plan.changedControllers.length} controller(s) updated` : '',
      secrets ? `${secrets} FTP password(s) stored` : '',
      unreadable ? `${unreadable} encrypted password(s) another Windows account saved - enter them here` : '',
    ].filter(Boolean);
    vscode.window.setStatusBarMessage(`$(link) ${cluster.name}: ${bits.join('; ')}`, 6000);
  }

  /** write one robot's cluster-derived identity, keeping its working folders and excludes */
  private applyRobotLink(rp: RobotLinkPlan): void {
    if (rp.marker && rp.action === 'merge') {
      const p = path.join(rp.marker.root, ROBOT_DIR, ROBOT_JSON);
      let raw: Record<string, unknown> = {};
      try { raw = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { /* rebuild below */ }
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) raw = {};
      raw.name = rp.set.name;
      raw.controller = rp.set.controller;
      raw.brand = rp.set.brand;
      fs.writeFileSync(p, JSON.stringify(raw, null, 2) + '\n', 'utf8');
      return;
    }
    if (rp.folder) writeRobotJson(rp.folder, { name: rp.set.name, controller: rp.set.controller, brand: rp.set.brand });
  }

  /** remove the link only; the controllers and robot containers stay as they are */
  async unlinkCell(cellRoot: string): Promise<void> {
    setCellRukusLink(cellRoot, undefined);
    await this.s.containers.refresh();
    this._onDidChange.fire();
    vscode.window.setStatusBarMessage('$(link) Cell unlinked from RUKUS', 4000);
  }

  /** RUKUS's passwords into VS Code's secret storage, bound to the host */
  private async storeClusterSecrets(cluster: RukusCluster): Promise<{ secrets: number; unreadable: number }> {
    if (!this.s.live) return { secrets: 0, unreadable: 0 };
    const wanted = clusterControllers(cluster);
    const decrypted = await unprotectAll(cluster.robots.map(r => r.ftpPassword ?? ''));
    let secrets = 0, unreadable = 0;
    for (const r of cluster.robots) {
      if (!r.ftpPassword || !wanted[r.name]) continue;
      if (await this.s.live.getPassword(r.name)) continue;
      const password = resolvePassword(r.ftpPassword, decrypted);
      if (password === undefined) { unreadable++; continue; }
      await this.s.live.setPassword(r.name, password);
      secrets++;
    }
    return { secrets, unreadable };
  }

  /** which cluster a robot belongs to, by name (the first that has it) */
  clusterOfRobot(robotName: string): RukusCluster | undefined {
    return this.clusters.find(c => c.robots.some(r => r.name.toLowerCase() === robotName.toLowerCase()));
  }

  /** RUKUS's record of a robot, by name: the open cluster's first, then any cluster's */
  robot(robotName: string): RukusRobot | undefined {
    const n = robotName.toLowerCase();
    const cur = this.current()?.cluster.robots.find(r => r.name.toLowerCase() === n);
    return cur ?? this.clusterOfRobot(robotName)?.robots.find(r => r.name.toLowerCase() === n);
  }

  /** the Latest backup folder of a robot in the open cluster, when there is one */
  latestOf(robotName: string): string | undefined {
    const cur = this.current();
    if (!cur) return undefined;
    const latest = path.join(cur.folder, RUKUS_LATEST);
    let entries: string[] = [];
    try { entries = fs.readdirSync(latest); } catch { return undefined; }
    const hit = entries.find(e => robotNameFromFolder(e).toLowerCase() === robotName.toLowerCase() || e.toLowerCase().startsWith(robotName.toLowerCase()));
    return hit ? path.join(latest, hit) : undefined;
  }

  /**
   * Make `name` the workspace: its backup folder as the one workspace folder, its robots in
   * cell.json. Opening the folder reloads the window, so everything after the switch is done
   * BEFORE it; when the folder is already the workspace nothing reloads and the cell is synced.
   */
  async openCluster(name: string): Promise<void> {
    const cluster = this.cluster(name);
    if (!cluster) { vscode.window.showWarningMessage(`${this.label} has no cluster called ${name}.`); return; }
    const folder = this.folderOf(cluster.name);
    try { fs.mkdirSync(folder, { recursive: true }); } catch (e: any) { vscode.window.showErrorMessage(`Could not create ${folder}: ${e?.message ?? e}`); return; }
    const result = await this.applyCluster(cluster, folder);
    this.s.output.appendLine(`[RUKUS] cluster ${cluster.name}: ${result}`);
    const folders = vscode.workspace.workspaceFolders ?? [];
    const uri = vscode.Uri.file(folder);
    if (folders.length === 1 && folders[0].uri.fsPath.toLowerCase() === folder.toLowerCase()) {
      await this.afterSync();
      vscode.window.setStatusBarMessage(`$(sync) ${cluster.name}: ${result}`, 6000);
      return;
    }
    vscode.window.setStatusBarMessage(`$(folder-opened) Switching to cluster ${cluster.name}`, 4000);
    // The same window, as a plain folder workspace (what "switch to cluster X" means), not an
    // untitled multi-root workspace with the old folder swapped out. The window reloads.
    await vscode.commands.executeCommand('vscode.openFolder', uri, { forceReuseWindow: true });
  }

  /**
   * The cluster's robots into `<folder>\.robocode-cell\cell.json`: the cell takes the
   * cluster's name; a controller with a robot's name takes the robot's address, user and
   * device; a controller RUKUS does not know is kept (and said so). FTP passwords go into
   * VS Code's secret storage when none is stored yet - RUKUS keeps them in clear in the
   * cluster file, and typing them a second time is the setup this feature removes.
   */
  private async applyCluster(cluster: RukusCluster, folder: string): Promise<string> {
    const wanted = clusterControllers(cluster);
    const cellFile = path.join(folder, CELL_DIR, CELL_JSON);
    let existing: Record<string, CellControllerSpec> = {};
    let existingName: string | undefined;
    let existingBrand: CellMarker['brand'];
    try {
      const parsed = parseCellJson(fs.readFileSync(cellFile, 'utf8'), folder);
      if (parsed.cell) { existing = parsed.cell.controllers; existingName = parsed.cell.name; existingBrand = parsed.cell.brand; }
    } catch { /* no cell.json yet */ }
    const kept = Object.keys(existing).filter(n => !wanted[n]);
    const controllers: Record<string, CellControllerSpec> = { ...existing };
    let changed = 0;
    for (const [n, spec] of Object.entries(wanted)) {
      const merged: CellControllerSpec = { ...(existing[n] ?? {}), ...spec };
      if (JSON.stringify(existing[n]) !== JSON.stringify(merged)) changed++;
      controllers[n] = merged;
    }
    writeCellMarker(folder, {
      name: cluster.name,
      controllers,
      brand: aggregateBrand(cluster.robots) ?? existingBrand,
      rukus: linkFor(cluster, this.clustersDir),
    });
    // A cluster with "Encrypt robot passwords" on holds them as dpapi:v1:... - readable by the
    // Windows account that saved it, which is normally this one (dpapi.ts).
    const { secrets, unreadable } = await this.storeClusterSecrets(cluster);
    const bits = [`${Object.keys(wanted).length} robot(s) from RUKUS`, changed ? `${changed} updated` : 'nothing changed', kept.length ? `${kept.length} controller(s) not in RUKUS kept: ${kept.join(', ')}` : '', secrets ? `${secrets} FTP password(s) stored` : '', unreadable ? `${unreadable} encrypted password(s) another Windows account saved - enter them here` : '', existingName && existingName !== cluster.name ? `cell renamed from ${existingName}` : ''].filter(Boolean);
    return bits.join('; ');
  }

  private async afterSync(): Promise<void> {
    await this.s.containers.refresh();
    const defs = this.s.containers.controllerDefs();
    if (this.s.live && Object.keys(defs).length) this.s.live.mergeCellProfiles(defs);
  }

  /** the open cell's cell.json re-read from its cluster; quiet unless `explicit` */
  async syncCurrent(explicit: boolean): Promise<void> {
    if (this.syncing) return;
    const cur = this.current();
    if (!cur) { if (explicit) vscode.window.showInformationMessage(this.available ? 'The open folder is not a RUKUS cluster\'s backup folder. Click a cluster in RUKUS Clusters to open one.' : 'RUKUS was not found on this PC (robotCode.rukus.dataFolder can point at its data folder).'); return; }
    this.syncing = true;
    try {
      const result = await this.applyCluster(cur.cluster, cur.folder);
      await this.afterSync();
      this.s.output.appendLine(`[RUKUS] cluster ${cur.cluster.name} synced: ${result}`);
      if (explicit) vscode.window.setStatusBarMessage(`$(sync) ${cur.cluster.name}: ${result}`, 6000);
    } catch (e: any) {
      this.s.output.appendLine(`[RUKUS] sync of ${cur.cluster.name} failed: ${e?.message ?? e}`);
      if (explicit) void showRecoverableError(`Could not sync ${cur.cluster.name} from RUKUS: ${e?.message ?? e}`, this.s.output, () => this.syncCurrent(true));
    } finally { this.syncing = false; }
  }

  /**
   * The open cell's controllers into its cluster file (a new cluster when RUKUS has none of
   * that name). RUKUS's own safety copy is made first, the file is written whole and moved
   * into place, and RUKUS-only fields ride along untouched. RUKUS reads its clusters folder
   * when it starts or when its cluster list is refreshed, so the message says so.
   */
  async exportCell(): Promise<void> {
    if (this.isStudio) {
      vscode.window.showInformationMessage('RUKUS Studio reads this cell itself: in Studio, Clusters > Import, and pick this folder. Robot Code does not write into Studio\'s workspace file.');
      return;
    }
    if (!this.available) { vscode.window.showInformationMessage('RUKUS was not found on this PC, so there is nowhere to send the cell yet. It is remembered: when RUKUS is installed, this extension offers to send it.'); if (this.s.containers.cells[0]) this.rememberPending(this.s.containers.cells[0].root); return; }
    const cell = this.s.containers.cells[0];
    if (!cell) { vscode.window.showInformationMessage('No cell container is open. Initialize Cell Container… makes one, or click a cluster in RUKUS Clusters.'); return; }
    if (!Object.keys(cell.controllers).length) { vscode.window.showInformationMessage(`${cell.name} has no controllers in its cell.json; add robots in the Controllers view first.`); return; }
    await this.sendCell(cell, true);
  }

  // ---- cells made before RUKUS was on this PC (beta list 4, item 3) ----
  //
  // Initialize Cell Container works without RUKUS. Such a cell is remembered here (the
  // extension's global state, so any window knows) until RUKUS turns up - installed later,
  // or its data folder appears - and then the next window to open offers to send it over as
  // a cluster. Once sent, its cell.json carries a `rukus` block and it is forgotten.

  /** set by registerRukusClusters: where the pending list lives */
  state: vscode.Memento | undefined;
  private static readonly PENDING = 'robotCode.rukus.pendingCells';
  private pendingOffered = false;

  rememberPending(root: string): void {
    if (!this.state) return;
    const list = this.state.get<string[]>(RukusClusters.PENDING, []);
    if (!list.some(r => r.toLowerCase() === root.toLowerCase())) void this.state.update(RukusClusters.PENDING, [...list, root]);
  }
  private forgetPending(root: string): void {
    if (!this.state) return;
    void this.state.update(RukusClusters.PENDING, this.state.get<string[]>(RukusClusters.PENDING, []).filter(r => r.toLowerCase() !== root.toLowerCase()));
  }

  /** once per window, when RUKUS is there: the remembered cells that have not been sent */
  private async offerPending(): Promise<void> {
    // Studio imports Robot Code cell folders itself (Clusters > Import); nothing is written into its workspace file
    if (this.pendingOffered || !this.available || this.isStudio || !this.state) return;
    const cells: CellMarker[] = [];
    for (const root of this.state.get<string[]>(RukusClusters.PENDING, [])) {
      let text: string;
      try { text = fs.readFileSync(path.join(root, CELL_DIR, CELL_JSON), 'utf8'); } catch { this.forgetPending(root); continue; }   // cell deleted
      let raw: any; try { raw = JSON.parse(text); } catch { continue; }
      if (raw?.rukus) { this.forgetPending(root); continue; }   // already RUKUS's
      const parsed = parseCellJson(text, root);
      if (parsed.cell) cells.push({ ...parsed.cell, root });
    }
    if (!cells.length) return;
    this.pendingOffered = true;
    const names = cells.map(c => c.name).join(', ');
    const pick = await vscode.window.showInformationMessage(
      `RUKUS is on this PC now. ${cells.length === 1 ? `The cell ${names} was` : `${cells.length} cells (${names}) were`} set up before it - send ${cells.length === 1 ? 'it' : 'them'} to RUKUS as ${cells.length === 1 ? 'a cluster' : 'clusters'}?`,
      'Send to RUKUS', 'Not now', 'Never');
    if (pick === 'Never') { for (const c of cells) this.forgetPending(c.root); return; }
    if (pick !== 'Send to RUKUS') return;
    for (const c of cells) await this.sendCell(c, false);
  }

  /**
   * One cell into its cluster file (a new cluster when RUKUS has none of that name). RUKUS's
   * own safety copy is made first and the file is written whole and moved into place. On
   * success the cell's cell.json is linked to the cluster and it leaves the pending list.
   */
  async sendCell(cell: CellMarker, confirm: boolean): Promise<boolean> {
    const controllers = cell.controllers;
    const existing = this.cluster(cell.name);
    const target = existing?.file ?? path.join(this.clustersDir, `${cell.name.replace(/[<>:"/\\|?*]/g, '_')}.json`);
    if (confirm) {
      const ok = await vscode.window.showWarningMessage(
        `${existing ? 'Update' : 'Create'} RUKUS cluster ${cell.name}?`,
        { modal: true, detail: `${Object.keys(controllers).length} controller(s) from ${path.basename(cell.root)} go into\n${target}\n\nRobots RUKUS already has keep their passwords, KCL settings, notes and locks; a robot the cell does not name stays in RUKUS. ${existing ? 'The previous file is copied to Clusters\\Backups first.' : ''}` },
        existing ? 'Update cluster' : 'Create cluster');
      if (!ok) return false;
    }
    try {
      const before = existing ? fs.readFileSync(target, 'utf8') : undefined;
      if (before !== undefined) {
        const bak = path.join(this.clustersDir, 'Backups');
        fs.mkdirSync(bak, { recursive: true });
        fs.writeFileSync(path.join(bak, `${cell.name}_backup_${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')}.json`), before, 'utf8');
      }
      const text = mergeControllersIntoCluster(before, controllers, `${os.userInfo().username}@${os.hostname()} (Robot Code)`);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const tmp = `${target}.tmp`;
      fs.writeFileSync(tmp, text, 'utf8');
      fs.renameSync(tmp, target);
      this.s.output.appendLine(`[RUKUS] cluster ${cell.name} written: ${target}`);
      this.markCellSent(cell.root, cell.name);
      this.forgetPending(cell.root);
      vscode.window.showInformationMessage(`${cell.name} is ${existing ? 'updated' : 'created'} in RUKUS. RUKUS shows it after its cluster list is refreshed (or at its next start).`);
      await this.refresh();
      return true;
    } catch (e: any) {
      vscode.window.showErrorMessage(`Could not write ${target}: ${e?.message ?? e}`);
      return false;
    }
  }

  /** the cell's cell.json names the cluster it went to, keeping everything else in it */
  private markCellSent(root: string, cluster: string): void {
    const file = path.join(root, CELL_DIR, CELL_JSON);
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      raw.rukus = { ...(raw.rukus ?? {}), cluster, clustersFolder: this.clustersDir, sentUtc: new Date().toISOString() };
      fs.writeFileSync(file, JSON.stringify(raw, null, 2) + '\n', 'utf8');
    } catch (e: any) { this.s.output.appendLine(`[RUKUS] could not link ${file} to cluster ${cluster}: ${e?.message ?? e}`); }
  }
}

// ---------------------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------------------

type Node = { t: 'cluster'; c: RukusCluster } | { t: 'robot'; c: RukusCluster; r: RukusRobot } | { t: 'text'; label: string; icon: string; tip?: string };

class ClustersTree implements vscode.TreeDataProvider<Node> {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;
  constructor(private readonly r: RukusClusters) { r.onDidChange(() => this._onDidChange.fire()); vscode.workspace.onDidChangeWorkspaceFolders(() => this._onDidChange.fire()); }

  refresh() { this._onDidChange.fire(); }

  getChildren(el?: Node): Node[] {
    if (!el) {
      if (this.r.lastError) return [{ t: 'text', label: `${this.r.label} data could not be read`, icon: 'warning', tip: this.r.lastError }];
      if (!this.r.available) {
        // Studio installed, no workspace yet: say so instead of "not found"
        return this.r.found ? [{ t: 'text', label: `${this.r.label}: no workspace yet`, icon: 'info', tip: `Open or set up a workspace in ${this.r.label} (Clusters > Open workspace); its clusters then appear here.` }] : [];   // else the welcome text takes over
      }
      // A linked cell is the only cluster that matters to the workspace: showing the rest would
      // invite opening a cluster that does not belong to the cell. Unlinked cells show them all.
      const linked = this.r.linkedClusterNames();
      if (linked.length) {
        const found = linked.map(n => this.r.cluster(n)).filter((c): c is RukusCluster => !!c);
        const missing = linked.filter(n => !this.r.cluster(n));
        const out: Node[] = found.map(c => ({ t: 'cluster' as const, c }));
        if (missing.length) out.push({ t: 'text', label: `Linked cluster(s) not found in ${this.r.label}: ${missing.join(', ')}`, icon: 'warning', tip: 'Open the Cell page to link another cluster or unlink this cell.' });
        return out;
      }
      if (!this.r.clusters.length) return [{ t: 'text', label: `${this.r.label} has no clusters yet`, icon: 'info', tip: this.r.clustersDir }];
      return this.r.clusters.map(c => ({ t: 'cluster' as const, c }));
    }
    if (el.t === 'cluster') return el.c.robots.map(r => ({ t: 'robot' as const, c: el.c, r }));
    return [];
  }

  getTreeItem(el: Node): vscode.TreeItem {
    if (el.t === 'text') { const it = new vscode.TreeItem(el.label); it.iconPath = new vscode.ThemeIcon(el.icon); it.tooltip = el.tip; return it; }
    if (el.t === 'cluster') {
      const open = this.r.current()?.cluster.name.toLowerCase() === el.c.name.toLowerCase();
      const it = new vscode.TreeItem(el.c.name, open ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
      const folder = this.r.folderOf(el.c.name);
      const hasBackups = realFs.exists(folder);
      it.description = [`${el.c.robots.length} robot${el.c.robots.length === 1 ? '' : 's'}`, open ? 'open' : hasBackups ? '' : 'no backups yet'].filter(Boolean).join(' · ');
      it.tooltip = new vscode.MarkdownString(`**${el.c.name}** - ${this.r.label} cluster\n\n${el.c.file}\n\nBackups: ${folder}${el.c.savedBy ? `\n\nSaved by ${el.c.savedBy}${el.c.savedUtc ? ` at ${el.c.savedUtc.slice(0, 16).replace('T', ' ')} UTC` : ''}` : ''}\n\nClick to make this cluster the workspace.`);
      it.iconPath = new vscode.ThemeIcon(open ? 'folder-opened' : 'folder-library', open ? new vscode.ThemeColor('charts.green') : undefined);
      it.contextValue = open ? 'rukus-cluster-open' : 'rukus-cluster';
      it.command = { command: 'robotCode.rukus.openCluster', title: 'Open cluster as workspace', arguments: [el.c.name] };
      return it;
    }
    const it = new vscode.TreeItem(el.r.name, vscode.TreeItemCollapsibleState.None);
    const abb = el.r.make === 'abb' ? el.r.abb : undefined;
    const where = abb ? `${el.r.host}${abb.port ? `:${abb.port}` : ''}` : el.r.host;
    it.description = [where, abb ? (abb.family === 'omnicore' ? 'ABB OmniCore' : 'ABB IRC5') : '', el.r.isVirtual ? 'virtual' : '', el.r.isWriteLocked ? 'write-locked' : ''].filter(Boolean).join(' · ');
    const secret = (stored: string | undefined, what: string) => stored
      ? `\n${what} set in RUKUS${isProtected(stored) ? ' (encrypted for its Windows account)' : ''} - copied to VS Code secret storage on sync` : '';
    it.tooltip = abb
      ? `${el.r.name} at ${where} · ABB ${abb.family === 'omnicore' ? 'OmniCore (RWS 2.0)' : 'IRC5 (RWS 1.0)'} · ${abb.user}${[abb.systemName, abb.robotWareName ? `RobotWare ${abb.robotWareName}` : '', abb.robotType].filter(Boolean).map(x => `\n${x}`).join('')}${el.r.notes ? `\n${el.r.notes}` : ''}${secret(abb.password, 'RWS password')}\nIn the Cell view while this cluster is open.`
      : `${el.r.name} at ${el.r.host} · FTP ${el.r.ftpUser || 'anonymous'} · ${el.r.ftpDirectory}${el.r.notes ? `\n${el.r.notes}` : ''}${secret(el.r.ftpPassword, 'FTP password')}`;
    it.iconPath = new vscode.ThemeIcon(el.r.isVirtual ? 'vm' : 'server-environment');
    it.contextValue = 'rukus-robot';
    return it;
  }
}

export function registerRukusClusters(ctx: vscode.ExtensionContext, s: Services): RukusClusters {
  const r = new RukusClusters(s);
  r.state = ctx.globalState;
  const tree = new ClustersTree(r);
  ctx.subscriptions.push(r, s.containers.onDidChange(() => tree.refresh()));
  if (viewDeclared(ctx, 'robotCode.rukusClusters')) {
    const view = watchViewVisibility(vscode.window.createTreeView('robotCode.rukusClusters', { treeDataProvider: tree, showCollapseAll: false }));
    // the header names the source: "RUKUS Studio" when the clusters come from Studio's workspace
    const title = () => { view.title = r.label === 'RUKUS Studio' ? 'RUKUS Studio' : 'RUKUS Clusters'; };
    ctx.subscriptions.push(view, r.onDidChange(title));
    title();
  }
  const reg = commandRegistrar(ctx, s.output);
  reg('robotCode.rukus.openCluster', async (arg?: string | Node) => {
    const name = typeof arg === 'string' ? arg : arg && 't' in arg && arg.t === 'cluster' ? arg.c.name : undefined;
    if (name) return r.openCluster(name);
    if (!r.available) { vscode.window.showInformationMessage(r.found ? `${r.label} has no workspace open yet. Open one in ${r.label}, or point robotCode.rukus.dataFolder at a workspace folder.` : 'Neither RUKUS Studio nor RUKUS was found on this PC. Use Initialize Cell Container… to set a cell up by hand, or point robotCode.rukus.dataFolder at a RUKUS Studio workspace or RUKUS\'s data folder.'); return; }
    const pick = await vscode.window.showQuickPick(r.clusters.map(c => ({ label: c.name, description: `${c.robots.length} robots`, detail: r.folderOf(c.name) })), { placeHolder: `Which ${r.label} cluster becomes the workspace?` });
    if (pick) await r.openCluster(pick.label);
  });
  reg('robotCode.rukus.syncClusters', async () => { await r.refresh(); await r.syncCurrent(true); });
  reg('robotCode.rukus.exportCell', () => r.exportCell());
  reg('robotCode.rukus.revealData', async () => {
    if (!r.dataRoot) return;
    if (!r.available) { const pick = await vscode.window.showInformationMessage(`RUKUS's data folder is not there: ${r.dataRoot.root}`, 'Get RUKUS'); if (pick) await vscode.env.openExternal(vscode.Uri.parse(config<string>('rukus.downloadUrl', RUKUS_DOWNLOAD_URL))); return; }
    await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(r.clustersDir));
  });
  ctx.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('robotCode.rukus.dataFolder')) void r.refresh(); }));
  ctx.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => void r.refresh()));

  /**
   * The link INTO the editor, for RUKUS's "Open in Robot Code" (RUKUS-INTEGRATION.md):
   *     vscode://rukus-team.robot-code/cluster?name=Testing    that cluster becomes the workspace
   *     vscode://rukus-team.robot-code/sync                    the open cell re-read from RUKUS
   * A vscode:// link can be fired from any web page, so a route only ever opens or re-reads;
   * the cluster has to be one RUKUS actually has, and nothing here writes to a robot.
   */
  ctx.subscriptions.push(vscode.window.registerUriHandler({
    handleUri: async (uri: vscode.Uri) => {
      const q = new URLSearchParams(uri.query);
      const route = uri.path.replace(/^\/+|\/+$/g, '').toLowerCase();
      s.output.appendLine(`[RUKUS] link: ${uri.toString(true)}`);
      if (route === 'cluster') {
        const name = (q.get('name') ?? '').trim();
        if (!r.available) await r.refresh();
        if (!name || !r.cluster(name)) { vscode.window.showWarningMessage(name ? `${r.label} has no cluster called ${name} on this PC.` : 'The link named no cluster.'); return; }
        await r.openCluster(name);
      } else if (route === 'sync') {
        await r.refresh(); await r.syncCurrent(true);
      } else {
        vscode.window.showWarningMessage(`RUKUS Robotic Extensions does not know the link "${route || '/'}". It takes /cluster?name=<cluster> and /sync.`);
      }
    },
  }));
  void r.refresh();
  return r;
}
