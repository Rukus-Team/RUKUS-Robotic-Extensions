/**
 * Container discovery service — vscode-facing.
 * Finds .robocode-robot/robot.json and .robocode-cell/cell.json markers,
 * resolves them via the pure robotContainers module, and exposes the
 * current set of markers for other services to query.
 */
import * as vscode from 'vscode';
import * as path from 'node:path';
import {
  parseRobotJson, parseCellJson, markerOf, classifyPath, markersWithOverlap,
  readProvenance,
  ROBOT_DIR, ROBOT_JSON, CELL_DIR, CELL_JSON,
  type RobotMarker, type CellMarker, type CellControllerSpec, type PartitionKind, type SnapshotProvenance,
} from './robotContainers';

export class ContainerIndex implements vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;
  private readonly disposables: vscode.Disposable[] = [];
  private timer: NodeJS.Timeout | undefined;

  private _markers: RobotMarker[] = [];
  private _cells: CellMarker[] = [];
  private _warnings: string[] = [];
  private refreshing: Promise<void> | undefined;
  /** the extension refreshes data+index itself right after the first discovery; the
   *  event is only for markers appearing, changing or disappearing later */
  private first = true;

  constructor() {
    const watcher = vscode.workspace.createFileSystemWatcher(
      `**/${ROBOT_DIR}/${ROBOT_JSON}`
    );
    const cellWatcher = vscode.workspace.createFileSystemWatcher(
      `**/${CELL_DIR}/${CELL_JSON}`
    );
    this.disposables.push(
      watcher,
      watcher.onDidCreate(() => this.scheduleRefresh()),
      watcher.onDidChange(() => this.scheduleRefresh()),
      watcher.onDidDelete(() => this.scheduleRefresh()),
      cellWatcher,
      cellWatcher.onDidCreate(() => this.scheduleRefresh()),
      cellWatcher.onDidChange(() => this.scheduleRefresh()),
      cellWatcher.onDidDelete(() => this.scheduleRefresh()),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.scheduleRefresh()),
    );
  }

  dispose() {
    for (const d of this.disposables) d.dispose();
    this._onDidChange.dispose();
    if (this.timer) clearTimeout(this.timer);
  }

  get markers(): readonly RobotMarker[] { return this._markers; }
  get cells(): readonly CellMarker[] { return this._cells; }
  get warnings(): readonly string[] { return this._warnings; }

  /** Classify a file path. Before the first refresh, everything is unmanaged. */
  classify(fsPath: string): PartitionKind {
    return classifyPath(fsPath, this._markers);
  }

  /** Find the deepest robot marker for a path. */
  markerOf(fsPath: string): RobotMarker | undefined {
    return markerOf(fsPath, this._markers);
  }

  /** Get snapshot provenance for a robot, if available. */
  snapshotInfo(robotRoot: string): SnapshotProvenance | undefined {
    return readProvenance(robotRoot);
  }

  /** Get the snapshot dataset folder for a robot marker. */
  snapshotDir(marker: RobotMarker): string {
    return marker.snapshotDir;
  }

  /**
   * The robot marker a live robot profile belongs to: its declared `controller` name first,
   * then its own name. This is how the sync commands bind an editor/tree action to the one
   * snapshot that robot owns, without consulting robotCode.robots settings.
   */
  markerForRobot(name: string): RobotMarker | undefined {
    const n = name.trim().toLowerCase();
    if (!n) return undefined;
    return this._markers.find(m => (m.controller && m.controller.toLowerCase() === n) || m.name.toLowerCase() === n);
  }

  /** The snapshot directory for a live robot profile name, if it has a container. */
  snapshotDirFor(name: string): string | undefined {
    return this.markerForRobot(name)?.snapshotDir;
  }

  /** Merged controller definitions from all cell containers, keyed by name. */
  controllerDefs(): Record<string, CellControllerSpec> {
    const merged: Record<string, CellControllerSpec> = {};
    for (const cell of this._cells) {
      for (const [name, spec] of Object.entries(cell.controllers)) {
        merged[name] = spec;
      }
    }
    return merged;
  }

  /** Validate that each robot marker's controller reference resolves to a cell controller. Returns warnings. */
  validateControllerRefs(): string[] {
    const defs = this.controllerDefs();
    const warnings: string[] = [];
    for (const m of this._markers) {
      if (m.controller && !defs[m.controller]) {
        warnings.push(`Robot "${m.name}" references controller "${m.controller}" which is not defined in any cell.json`);
      }
    }
    return warnings;
  }

  private scheduleRefresh() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.refresh(), 500);
  }

  async refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.doRefresh().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  private async doRefresh() {
    const markers: RobotMarker[] = [];
    const cells: CellMarker[] = [];
    const warnings: string[] = [];

    // Discover robot markers
    const robotUris = await vscode.workspace.findFiles(
      `**/${ROBOT_DIR}/${ROBOT_JSON}`,
      '**/node_modules/**',
      100
    );
    for (const uri of robotUris) {
      const rootAbs = path.dirname(path.dirname(uri.fsPath)); // robot.json → .robocode-robot → robot root
      try {
        const text = (await vscode.workspace.fs.readFile(uri)).toString();
        const result = parseRobotJson(text, rootAbs);
        if (result.marker) markers.push(result.marker);
        if (result.errors.length) warnings.push(...result.errors);
      } catch (e: unknown) {
        warnings.push(`Failed to read ${uri.fsPath}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // Discover cell markers
    const cellUris = await vscode.workspace.findFiles(
      `**/${CELL_DIR}/${CELL_JSON}`,
      '**/node_modules/**',
      10
    );
    for (const uri of cellUris) {
      const rootAbs = path.dirname(path.dirname(uri.fsPath)); // cell.json → .robocode-cell → cell root
      try {
        const text = (await vscode.workspace.fs.readFile(uri)).toString();
        const result = parseCellJson(text, rootAbs);
        if (result.cell) cells.push(result.cell);
        if (result.errors.length) warnings.push(...result.errors);
      } catch (e: unknown) {
        warnings.push(`Failed to read ${uri.fsPath}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // Sort markers: deeper roots first for deterministic overlap detection
    markers.sort((a, b) => a.root.length - b.root.length);

    // Overlap warnings
    warnings.push(...markersWithOverlap(markers));

    // Validate robot→cell controller references
    const defs: Record<string, CellControllerSpec> = {};
    for (const cell of cells) {
      for (const [name, spec] of Object.entries(cell.controllers)) {
        defs[name] = spec;
      }
    }
    for (const m of markers) {
      if (m.controller && !defs[m.controller]) {
        warnings.push(`Robot "${m.name}" references controller "${m.controller}" which is not defined in any cell.json`);
      }
    }

    // Everything that decides the partition or a connection, not just WHERE the markers are.
    // Comparing roots alone meant that editing robot.json - a different `programs` list, a new
    // `exclude`, another `controller` - or a controller's host in cell.json changed nothing until
    // a manual Refresh: the new markers were stored, but nothing was told to rescan.
    const signature = (ms: readonly RobotMarker[], cs: readonly CellMarker[]) => JSON.stringify([
      ms.map(m => [m.root, m.name, m.programDirs ?? null, m.excludeDirs, m.snapshotDir, m.controller ?? null]),
      cs.map(c => [c.root, c.name, c.controllers]),
    ]);
    const changed = signature(markers, cells) !== signature(this._markers, this._cells);

    this._markers = markers;
    this._cells = cells;
    this._warnings = warnings;

    // Explorer menus ("Snapshot & Robot") exist only where a container does; the key is a
    // global because a context-menu `when` clause cannot inspect the clicked resource.
    void vscode.commands.executeCommand('setContext', 'robotCode.hasContainers', markers.length > 0);

    if (this.first) this.first = false;
    else if (changed) this._onDidChange.fire();
  }
}
