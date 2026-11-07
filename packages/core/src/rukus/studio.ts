/**
 * RUKUS Studio's data on disk, read by the extension. Studio is the successor of the RUKUS
 * desktop app; the extension reads both (two-way compatibility is the goal), and Studio wins
 * when both are on the PC. No vscode import - test/sideBar.test.ts runs this against a
 * folder shaped like the real thing.
 *
 * Where Studio keeps things (rukus-studio: Rukus.Studio.Core/StudioPaths.cs, ShellSettings.cs,
 * Workspace.cs):
 *
 *     %LOCALAPPDATA%\Programs\RUKUS Studio\Rukus.Studio.exe     the installed app
 *     %LOCALAPPDATA%\RUKUS Studio\shell.json                     "workspace": the folder open last
 *     Documents\RUKUS Studio\Workspace\                          the default workspace folder
 *         rukus-workspace.json                                   clusters ("containers") and robots
 *         <cluster path>\<robot name>\<dated backup>\            a robot's folder and its backups
 *
 * A workspace's clusters nest ("Plant A/Line 2/Cell 1"); a robot sits in exactly one, or at the
 * top level ("" container). Passwords are never in the file (Studio keeps them in the OS store).
 */
import * as path from 'node:path';
import { realFs, deviceOf, type FsLike, type RukusCluster, type RukusRobot } from './store';

export const STUDIO_WORKSPACE_FILE = 'rukus-workspace.json';
export const STUDIO_PRODUCT_FOLDER = 'RUKUS Studio';
export const STUDIO_EXE = 'Rukus.Studio.exe';
/** Studio's default workspace folder name under Documents\RUKUS Studio */
export const STUDIO_DEFAULT_WORKSPACE = 'Workspace';

export interface StudioEnv {
  /** %LOCALAPPDATA% (undefined off Windows) */
  localAppData?: string;
  /** the user's Documents folder */
  documents: string;
  /** RUKUS_STUDIO_HOME: Studio's data folder when set (its own override) */
  studioHome?: string;
}

export interface StudioLocation {
  /** Rukus.Studio.exe was found */
  installed: boolean;
  exe?: string;
  /** the workspace folder (holding rukus-workspace.json), when one was found */
  workspace?: string;
}

/**
 * Where Studio is: the exe in its per-user install folder, and the workspace it had open last
 * (shell.json), else the default Documents\RUKUS Studio\Workspace when that holds a workspace file.
 */
export function locateStudio(env: StudioEnv, f: FsLike = realFs): StudioLocation {
  const exe = env.localAppData ? path.join(env.localAppData, 'Programs', STUDIO_PRODUCT_FOLDER, STUDIO_EXE) : undefined;
  const installed = !!exe && f.exists(exe);
  const dataRoot = env.studioHome || (env.localAppData ? path.join(env.localAppData, STUDIO_PRODUCT_FOLDER) : undefined);
  const candidates: string[] = [];
  if (dataRoot) {
    const shell = f.readText(path.join(dataRoot, 'shell.json'));
    if (shell) {
      try {
        const ws = JSON.parse(shell)?.workspace;
        if (typeof ws === 'string' && ws.trim()) candidates.push(ws.trim());
      } catch { /* a half-written shell.json: the default below */ }
    }
  }
  candidates.push(path.join(env.documents, STUDIO_PRODUCT_FOLDER, STUDIO_DEFAULT_WORKSPACE));
  const workspace = candidates.find(c => isStudioWorkspace(c, f));
  return { installed, ...(installed ? { exe } : {}), ...(workspace ? { workspace } : {}) };
}

/** a folder holding Studio's workspace file */
export function isStudioWorkspace(folder: string, f: FsLike = realFs): boolean {
  return f.exists(path.join(folder, STUDIO_WORKSPACE_FILE));
}

export interface StudioRobot {
  id: string;
  name: string;
  /** "fanuc", "abb", ... lower-case */
  brand: string;
  /** host or host:port; undefined for a backup-only robot */
  address?: string;
  /** the cluster path, "" = top level */
  container: string;
  model?: string;
  notes?: string;
  software?: string;
  writeLocked: boolean;
}

export interface StudioWorkspace {
  root: string;
  /** every cluster path, as the file lists them */
  containers: string[];
  robots: StudioRobot[];
}

const normContainer = (c: unknown): string =>
  typeof c === 'string' ? c.split(/[\\/]/).map(s => s.trim()).filter(Boolean).join('/') : '';

/** rukus-workspace.json; undefined when the text is not one (or a newer version than 1) */
export function parseStudioWorkspace(text: string, root: string): StudioWorkspace | undefined {
  let raw: any;
  try { raw = JSON.parse(text); } catch { return undefined; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  if (typeof raw.version === 'number' && raw.version > 1) return undefined;
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const containers = (Array.isArray(raw.containers) ? raw.containers : []).map(normContainer).filter(Boolean);
  const robots: StudioRobot[] = [];
  const seen = new Set<string>();
  for (const r of Array.isArray(raw.robots) ? raw.robots : []) {
    if (!r || typeof r !== 'object') continue;
    const id = str(r.id), name = str(r.name);
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    const container = normContainer(r.container);
    if (container && !containers.some((c: string) => c.toLowerCase() === container.toLowerCase())) containers.push(container);
    robots.push({
      id, name, brand: (str(r.brandTag) ?? 'fanuc').toLowerCase(), address: str(r.address), container,
      model: str(r.model), notes: str(r.notes), software: str(r.software) ?? str(r.controller?.software), writeLocked: r.writeLocked === true,
    });
  }
  return { root, containers, robots };
}

/** "127.0.0.9:3080" -> host + port; "[::1]:80" too; a bare host has no port */
export function splitAddress(address: string | undefined): { host: string; port?: number } {
  const a = (address ?? '').trim();
  if (!a) return { host: '' };
  const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(a);
  if (v6) return { host: v6[1], ...(v6[2] ? { port: Number(v6[2]) } : {}) };
  const m = /^([^:]+):(\d+)$/.exec(a);
  return m ? { host: m[1], port: Number(m[2]) } : { host: a };
}

/** path functions for a workspace root: Windows ones for a Windows path (a drive letter or backslashes), so
 * the result is the same on a Linux build machine as on the Windows PC the path came from */
function pathsFor(root: string): typeof path.win32 { return /^[A-Za-z]:|\\/.test(root) ? path.win32 : path; }

/** the top-level robots' pseudo-cluster: named after the workspace folder */
export function topLevelName(ws: StudioWorkspace): string {
  return pathsFor(ws.root).basename(ws.root.replace(/[\\/]+$/, '')) || 'Workspace';
}

/**
 * Studio's clusters as the extension's cluster records, so the RUKUS Clusters view, Open Cluster
 * and the ABB pick-up read them like RUKUS's: one per cluster path that has robots (or is a leaf),
 * plus one named after the workspace folder for robots at the top level. `file` is the workspace
 * file; `folder` (on the returned map) is where the cluster's robot folders are.
 */
export function studioClusters(ws: StudioWorkspace): { clusters: RukusCluster[]; folders: Map<string, string> } {
  const folders = new Map<string, string>();
  const p = pathsFor(ws.root);
  const file = p.join(ws.root, STUDIO_WORKSPACE_FILE);
  const byContainer = new Map<string, StudioRobot[]>();
  for (const r of ws.robots) byContainer.set(r.container, [...(byContainer.get(r.container) ?? []), r]);
  const out: RukusCluster[] = [];
  const add = (name: string, container: string, robots: StudioRobot[]) => {
    out.push({ name, file, robots: robots.map(toRukusRobot), raw: { studio: true, container } });
    folders.set(name.toLowerCase(), container ? p.join(ws.root, ...container.split('/')) : ws.root);
  };
  // a cluster with robots, or a leaf (an empty cell is still a cell); a parent with only sub-clusters is not listed
  for (const c of ws.containers) {
    const robots = byContainer.get(c) ?? [];
    const leaf = !ws.containers.some(o => o.toLowerCase().startsWith(c.toLowerCase() + '/'));
    if (robots.length || leaf) add(c, c, robots);
  }
  const top = byContainer.get('') ?? [];
  if (top.length) {
    let name = topLevelName(ws);
    if (out.some(c => c.name.toLowerCase() === name.toLowerCase())) name = `${name} (top level)`;
    add(name, '', top);
  }
  return { clusters: out.sort((a, b) => a.name.localeCompare(b.name)), folders };
}

function toRukusRobot(r: StudioRobot): RukusRobot {
  const { host, port } = splitAddress(r.address);
  const abb = r.brand === 'abb';
  // OmniCore runs RobotWare 7 and later; an unknown version is read as IRC5 (RWS 1.0), the
  // same default RUKUS cluster files have
  const rw = /RobotWare\s+(\d+)/i.exec(r.software ?? '');
  return {
    name: r.name, host, ftpUser: '', ftpDirectory: 'MD:/', device: deviceOf('MD:/'),
    isVirtual: /^(127\.|localhost$)/i.test(host) || /virtual/i.test(r.notes ?? ''),
    isWriteLocked: r.writeLocked, notes: r.notes, softwareVersion: r.software, make: r.brand,
    ...(!abb && port ? { httpPort: port } : {}),
    ...(abb ? {
      abb: {
        family: rw && Number(rw[1]) >= 7 ? 'omnicore' as const : 'irc5' as const,
        ...(port ? { port } : {}), https: false, user: 'Default User', mechUnit: 'ROB_1',
        robotWareName: r.software?.replace(/^RobotWare\s+/i, ''), robotType: r.model,
      },
    } : {}),
  };
}

// ---------------------------------------------------------------------------------------
// Which of the two the extension reads
// ---------------------------------------------------------------------------------------

export type RukusSource = 'studio' | 'rukus' | 'none';

export interface RukusDetection {
  /** where the clusters come from */
  source: RukusSource;
  /** RUKUS or RUKUS Studio is on this PC (the "not found" text goes) */
  found: boolean;
  /** what the side bar calls it */
  label: 'RUKUS Studio' | 'RUKUS';
  /** the Studio workspace folder read, when source is studio */
  studioWorkspace?: string;
}

/**
 * RUKUS Studio succeeds the RUKUS app, so its workspace wins when both are here.
 * robotCode.rukus.dataFolder (`override`) is the user's word: a folder holding
 * rukus-workspace.json is read as a Studio workspace, any other folder as RUKUS's data root.
 * Studio installed with no workspace yet still counts as found (its view says to open one).
 */
export function detectRukus(o: { override?: string; overrideIsStudio?: boolean; studio: StudioLocation; rukusRootExists: boolean }): RukusDetection {
  const studioThere = o.studio.installed || !!o.studio.workspace;
  if (o.override) {
    if (o.overrideIsStudio) return { source: 'studio', found: true, label: 'RUKUS Studio', studioWorkspace: o.override };
    if (o.rukusRootExists) return { source: 'rukus', found: true, label: 'RUKUS' };
    return { source: 'none', found: o.studio.installed, label: o.studio.installed ? 'RUKUS Studio' : 'RUKUS' };
  }
  if (o.studio.workspace) return { source: 'studio', found: true, label: 'RUKUS Studio', studioWorkspace: o.studio.workspace };
  if (o.rukusRootExists) return { source: 'rukus', found: true, label: 'RUKUS' };
  return { source: 'none', found: studioThere, label: studioThere ? 'RUKUS Studio' : 'RUKUS' };
}

// ---------------------------------------------------------------------------------------
// Folders that are no backups
// ---------------------------------------------------------------------------------------

/**
 * Folders Studio writes inside a robot's folder that are no backups (LastDone.NotBackups, the
 * list Studio's Kit and FanucCore use too): `replaced\<time>` holds the copies a send or a
 * snapshot restore replaced, the others are logs and reports. Only inside a Studio workspace:
 * a user's own folder called "reports" elsewhere is left alone.
 */
export const STUDIO_NOT_BACKUPS = new Set(['alarms', 'checks', 'dcs-out', 'reports', 'replaced', 'snapshots', 'watch']);

/**
 * Never a backup, anywhere: a download in progress (RUKUS's `.incoming`, Studio's
 * `.incoming-<name>`) and Studio's edit-on-robot working copies.
 */
export function isNeverBackupName(name: string): boolean {
  return /^\.incoming/i.test(name) || /^edit-on-robot$/i.test(name);
}

/**
 * Is `dir` (a folder holding program or data files) inside one of the folders above? The
 * Studio-only names count when an ancestor ABOVE that folder holds rukus-workspace.json.
 * `cache` remembers which folders are workspace roots, so a 2000-file scan asks the disk once
 * per folder.
 */
export function isNonBackupFolder(dir: string, f: FsLike = realFs, cache: Map<string, boolean> = new Map()): boolean {
  const parts = path.resolve(dir).split(/[\\/]+/).filter(Boolean);
  const isRoot = (i: number) => {
    // the folder made of parts[0..i]
    const p = parts.slice(0, i + 1).join(path.sep);
    const folder = /^[A-Za-z]:$/.test(parts[0]) ? p : path.sep + p;
    const key = folder.toLowerCase();
    let hit = cache.get(key);
    if (hit === undefined) { hit = isStudioWorkspace(folder.length === 2 ? folder + path.sep : folder, f); cache.set(key, hit); }
    return hit;
  };
  for (let i = 0; i < parts.length; i++) {
    const name = parts[i];
    if (isNeverBackupName(name)) return true;
    if (STUDIO_NOT_BACKUPS.has(name.toLowerCase())) {
      for (let j = i - 1; j >= 0; j--) if (isRoot(j)) return true;
    }
  }
  return false;
}
