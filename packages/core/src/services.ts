import * as vscode from 'vscode';
import * as path from 'node:path';
import { WorkspaceIndex } from './workspaceIndex';
import { ContainerIndex } from './containerIndex';
import type { RobotManager } from './live/robotManager';
import type { RukusClusters } from './rukus/clusters';
import type { RobotMarker } from './robotContainers';

/** One controller backup a brand's data store has read: where it is and whose it is. */
export interface ControllerDataset {
  readonly folder: string;
  /** the robot, from the folder name */
  readonly name: string;
  /** what the views call it */
  label: string;
}

/**
 * What core needs from a brand's controller-data store (FANUC: the .va register dumps). The
 * brand's own code gets its concrete store through its own services subclass; core only
 * groups programs by backup folder and refreshes the store when the containers change.
 */
export interface ControllerData extends vscode.Disposable {
  readonly datasets: readonly ControllerDataset[];
  readonly onDidChange: vscode.Event<void>;
  markersProvider: () => readonly RobotMarker[];
  dataset(uri?: vscode.Uri | string): ControllerDataset | undefined;
  folderOf(uri: vscode.Uri | string): string | undefined;
  refresh(): Promise<void>;
}

/**
 * Shared services handed to every module. A brand extends this with its own (FANUC:
 * `FanucServices` adds the TP/KAREL parse caches and the $-variable reference) and narrows
 * `data` to its concrete store.
 */
export class Services<D extends ControllerData = ControllerData> implements vscode.Disposable {
  readonly containers = new ContainerIndex();
  readonly index = new WorkspaceIndex();
  readonly output = vscode.window.createOutputChannel('RUKUS Robotic Extensions');
  /** live-controller tier; set by the extension after construction */
  live: RobotManager | undefined;
  /** RUKUS's clusters and backup store on this PC; set by the extension after construction */
  rukus: RukusClusters | undefined;

  constructor(readonly data: D) {
    // Programs are grouped by the robot folder their controller data lives in.
    // When .robocode-robot markers exist, container markers take priority over
    // data.folderOf fallback, so working and snapshot programs share one group.
    this.index.groupResolver = uri => uri.scheme === 'file'
      ? (this.containers.markerOf(uri.fsPath)?.root
        ?? this.data.folderOf(uri)
        ?? path.dirname(uri.fsPath)).toLowerCase()
      : `${uri.scheme}://${uri.authority}${path.posix.dirname(uri.path)}`.toLowerCase();
    this.index.backupResolver = uri => uri.scheme === 'file'
      ? (this.containers.markerOf(uri.fsPath)?.snapshotDir ?? this.data.folderOf(uri))
      : undefined;
    this.index.partitionResolver = uri => uri.scheme === 'file'
      ? this.containers.classify(uri.fsPath)
      : 'unmanaged';
    this.index.snapshotRoots = () => this.containers.markers.map(m => m.snapshotDir);
    this.data.markersProvider = () => this.containers.markers;
    this.containers.onDidChange(() => {
      // Merge cell-defined controllers into RobotManager when available
      if (this.live) {
        const defs = this.containers.controllerDefs();
        if (Object.keys(defs).length) this.live.mergeCellProfiles(defs);
      }
      // a marker appearing or disappearing changes the partition: a full index rescan,
      // not just a regroup (files may need to be added or dropped)
      void this.data.refresh().then(() => void this.index.refresh());
    });
    this.data.onDidChange(() => this.index.regroup());
  }

  dispose() {
    this.containers.dispose();
    this.index.dispose();
    this.data.dispose();
    this.output.dispose();
  }
}
