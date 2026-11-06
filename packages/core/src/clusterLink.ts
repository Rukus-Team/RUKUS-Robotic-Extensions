/**
 * Linking a cell to a RUKUS cluster: the pure planning half.
 *
 * A link is a merge, not a copy: the cluster is authoritative for how to reach each robot
 * (host, device, protocol, auth), the cell keeps what only it knows (a robot's working
 * folders, `programs` / `exclude`), and every robot container is reconciled to the cluster's
 * identity (name, controller binding, brand). The VS Code side (rukus/clusters.ts) turns a
 * plan into prompts and writes; this module only decides what *would* change, so it can be
 * tested without a controller or a webview.
 */
import * as path from 'node:path';
import type { RukusCluster, RukusRobot } from './rukus/store';
import { clusterControllers } from './rukus/store';
import type { CellControllerSpec, CellMarker, CellRukusLink, RobotBrand, RobotMarker, RobotMarkerSpec } from './robotContainers';

export interface FieldChange { field: string; from?: string; to?: string }

/** What linking does to one robot container. */
export interface RobotLinkPlan {
  robot: RukusRobot;
  brand: RobotBrand;
  /** the existing container this robot maps to, when there is one */
  marker?: RobotMarker;
  /** for a new container: the folder it would go in (undefined = ask) */
  folder?: string;
  action: 'merge' | 'create' | 'choose-folder' | 'skip';
  /** the fields written to robot.json (name, controller, brand) */
  set: Required<Pick<RobotMarkerSpec, 'name' | 'controller' | 'brand'>>;
  /** only the fields that actually differ, for the confirmation */
  changes: FieldChange[];
}

export interface ClusterLinkPlan {
  cluster: string;
  cellName: string;
  renameCell: boolean;
  controllers: Record<string, CellControllerSpec>;
  changedControllers: string[];
  brand: CellBrandAggregate;
  robots: RobotLinkPlan[];
}

export type CellBrandAggregate = 'fanuc' | 'abb' | 'mixed' | undefined;

const brandOf = (r: RukusRobot): RobotBrand => (r.make === 'abb' ? 'abb' : 'fanuc');

/** The cell's brand from its robots: one brand, or mixed. Undefined for a cluster with no robots. */
export function aggregateBrand(robots: readonly RukusRobot[]): CellBrandAggregate {
  const brands = new Set(robots.map(brandOf));
  if (!brands.size) return undefined;
  return brands.size === 1 ? [...brands][0] : 'mixed';
}

/** Does this container (or its folder name) belong to `name`? */
function matches(marker: RobotMarker, name: string): boolean {
  const n = name.toLowerCase();
  if (marker.name.toLowerCase() === n) return true;
  if ((marker.controller ?? '').toLowerCase() === n) return true;
  const base = path.basename(marker.root).toLowerCase();
  return base === n || base.startsWith(`${n}_`) || base.startsWith(`${n}-`);
}

/** A direct sub-folder of the cell that looks like this robot's (`SLR1_136.129.3.60`). */
function folderFor(folders: readonly string[], name: string): string | undefined {
  const n = name.toLowerCase();
  return folders.find(f => {
    const base = path.basename(f).toLowerCase();
    return base === n || base.startsWith(`${n}_`) || base.startsWith(`${n}-`);
  });
}

/**
 * Plan a link. `folders` are the direct sub-folders of the cell root (so a robot with no
 * container can be offered the folder its backups already sit in).
 */
export function planClusterLink(
  cluster: RukusCluster,
  cell: CellMarker | undefined,
  markers: readonly RobotMarker[],
  folders: readonly string[] = [],
): ClusterLinkPlan {
  const wanted = clusterControllers(cluster);
  const existing = cell?.controllers ?? {};
  const controllers: Record<string, CellControllerSpec> = { ...existing };
  const changedControllers: string[] = [];
  for (const [name, spec] of Object.entries(wanted)) {
    const merged: CellControllerSpec = { ...(existing[name] ?? {}), ...spec };
    if (JSON.stringify(existing[name]) !== JSON.stringify(merged)) changedControllers.push(name);
    controllers[name] = merged;
  }

  const robots: RobotLinkPlan[] = cluster.robots.map(robot => {
    const brand = brandOf(robot);
    const marker = markers.find(m => matches(m, robot.name));
    const set = { name: robot.name, controller: robot.name, brand };
    if (marker) {
      const changes: FieldChange[] = [];
      if (marker.name !== robot.name) changes.push({ field: 'name', from: marker.name, to: robot.name });
      if ((marker.controller ?? '') !== robot.name) changes.push({ field: 'controller', from: marker.controller, to: robot.name });
      if (marker.brand !== brand) changes.push({ field: 'brand', from: marker.brand, to: brand });
      return { robot, brand, marker, action: 'merge', set, changes };
    }
    const folder = folderFor(folders, robot.name);
    return folder
      ? { robot, brand, folder, action: 'create', set, changes: [{ field: 'name', to: robot.name }, { field: 'controller', to: robot.name }, { field: 'brand', to: brand }] }
      : { robot, brand, action: 'choose-folder', set, changes: [{ field: 'name', to: robot.name }, { field: 'controller', to: robot.name }, { field: 'brand', to: brand }] };
  });

  return {
    cluster: cluster.name,
    cellName: cluster.name,
    renameCell: cell !== undefined && cell.name !== cluster.name,
    controllers,
    changedControllers,
    brand: aggregateBrand(cluster.robots),
    robots,
  };
}

/** The link block written to cell.json for this cluster. */
export function linkFor(cluster: RukusCluster, clustersFolder: string, now = new Date()): CellRukusLink {
  return { cluster: cluster.name, clustersFolder, syncedUtc: now.toISOString() };
}

/** A human line for a robot's merge, e.g. `SLR1 — controller SLR1, brand fanuc`. */
export function describeRobotPlan(p: RobotLinkPlan): string {
  if (!p.changes.length) return `${p.robot.name} — already matches`;
  return `${p.robot.name} — ${p.changes.map(c => `${c.field}${c.to ? ` ${c.to}` : ''}`).join(', ')}`;
}
