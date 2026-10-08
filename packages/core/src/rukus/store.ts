/**
 * RUKUS's data on disk, read (and, for one file, written) by the extension.
 *
 * RUKUS is the store of record for the cell: which clusters exist, which robots are in
 * each, and how it lays out and names backups. The extension does not keep its own copy
 * of any of that; it reads RUKUS's files and turns a cluster into the cell.json the
 * containers feature already understands. No vscode import - test/rukusStore.test.ts runs
 * this against a folder shaped like the real thing.
 *
 * Where the data is (RUKUS.Core/Common/Constants.cs, Helpers/PortableModeHelper.cs):
 *
 *     <data root>\AppSettings.json          templates, custom folders
 *     <data root>\Clusters\<name>.json      one cluster; the FILE NAME is the cluster's name
 *     <data root>\Clusters\Backups\         RUKUS's safety copies of cluster files
 *     <data root>\Backups\<cluster>\...     the backup store (see robotContainers.ts)
 *
 * The data root is Documents\RUKUS for an installed RUKUS. A portable RUKUS has a
 * `RUKUS.portable` marker beside RUKUS.exe: empty = `RUKUS-Data` beside the exe, otherwise
 * the path in its first meaningful line (relative to the exe when relative). AppSettings
 * can point the clusters and the backups at custom folders; each is used only when it is
 * reachable, as RUKUS itself does.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CellControllerSpec } from '../robotContainers';

export const RUKUS_PORTABLE_MARKER = 'RUKUS.portable';
export const RUKUS_PORTABLE_FOLDER = 'RUKUS-Data';
export const RUKUS_PRODUCT_FOLDER = 'RUKUS';
export const RUKUS_CLUSTERS_DIR = 'Clusters';
export const RUKUS_BACKUPS_DIR = 'Backups';
export const RUKUS_APPSETTINGS = 'AppSettings.json';
export const RUKUS_MANIFEST = 'rukus-backup.json';
export const RUKUS_LATEST = 'Latest';
/** RUKUS's own defaults (BackupNamingHelper.cs) when AppSettings.json does not say */
export const DEFAULT_BATCH_TEMPLATE = '{ClusterName}\\{Date:yyyy-MM-dd_HH-mm}';
export const DEFAULT_ROBOT_TEMPLATE = '{RobotName}';
/** the stamp RUKUS gives a batch that its template does not date (BackupLayoutHelper.BatchStampFormat) */
export const BATCH_STAMP_FORMAT = 'yyyy-MM-dd_HH-mm';

export interface FsLike {
  exists(p: string): boolean;
  readText(p: string): string | undefined;
}

export const realFs: FsLike = {
  exists: p => { try { return fs.existsSync(p); } catch { return false; } },
  readText: p => { try { return fs.readFileSync(p, 'utf8'); } catch { return undefined; } },
};

// ---------------------------------------------------------------------------------------
// Where the data is
// ---------------------------------------------------------------------------------------

export interface RukusDataRoot { root: string; portable: boolean }

/**
 * The data root, from the same three facts RUKUS uses: the exe's folder (undefined when
 * RUKUS is not installed), the marker beside it, and the Documents folder. An unreadable
 * marker still means portable, for RUKUS's reason: the marker is there so the host PC is
 * not written to.
 */
export function resolveDataRoot(installDir: string | undefined, documentsFolder: string, f: FsLike = realFs): RukusDataRoot {
  const documentsRoot = path.join(documentsFolder, RUKUS_PRODUCT_FOLDER);
  if (!installDir) return { root: documentsRoot, portable: false };
  const marker = path.join(installDir, RUKUS_PORTABLE_MARKER);
  if (!f.exists(marker)) return { root: documentsRoot, portable: false };
  let text: string | undefined;
  try { text = f.readText(marker); } catch { text = undefined; }   // unreadable marker: still portable
  const chosen = firstMeaningfulLine(text);
  if (!chosen) return { root: path.join(installDir, RUKUS_PORTABLE_FOLDER), portable: true };
  return { root: path.isAbsolute(chosen) ? chosen : path.resolve(installDir, chosen), portable: true };
}

function firstMeaningfulLine(text: string | undefined): string | undefined {
  if (!text) return undefined;
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (t && !t.startsWith('#') && !t.startsWith('//')) return t;
  }
  return undefined;
}

export interface RukusAppSettings {
  customClustersFolderPath?: string;
  customBackupsFolderPath?: string;
  backupBatchFolderTemplate: string;
  backupRobotFolderTemplate: string;
  defaultClusterName?: string;
}

/** AppSettings.json; RUKUS's defaults for anything missing or unreadable. */
export function readAppSettings(root: string, f: FsLike = realFs): RukusAppSettings {
  const out: RukusAppSettings = { backupBatchFolderTemplate: DEFAULT_BATCH_TEMPLATE, backupRobotFolderTemplate: DEFAULT_ROBOT_TEMPLATE };
  const text = f.readText(path.join(root, RUKUS_APPSETTINGS));
  if (!text) return out;
  let raw: any;
  try { raw = JSON.parse(text); } catch { return out; }
  if (!raw || typeof raw !== 'object') return out;
  const str = (k: string) => (typeof raw[k] === 'string' && raw[k].trim() ? raw[k].trim() : undefined);
  out.customClustersFolderPath = str('CustomClustersFolderPath');
  out.customBackupsFolderPath = str('CustomBackupsFolderPath');
  out.backupBatchFolderTemplate = str('BackupBatchFolderTemplate') ?? DEFAULT_BATCH_TEMPLATE;
  out.backupRobotFolderTemplate = str('BackupRobotFolderTemplate') ?? DEFAULT_ROBOT_TEMPLATE;
  out.defaultClusterName = str('DefaultClusterName');
  return out;
}

/** the clusters folder: the custom one when set and reachable (RobotConfigService.ResolveClustersFolder), else local */
export function clustersFolder(root: string, s: RukusAppSettings, f: FsLike = realFs): string {
  if (s.customClustersFolderPath && f.exists(s.customClustersFolderPath)) return s.customClustersFolderPath;
  return path.join(root, RUKUS_CLUSTERS_DIR);
}

/** the backups root: the custom one when set and reachable, else local */
export function backupsFolder(root: string, s: RukusAppSettings, f: FsLike = realFs): string {
  if (s.customBackupsFolderPath && f.exists(s.customBackupsFolderPath)) return s.customBackupsFolderPath;
  return path.join(root, RUKUS_BACKUPS_DIR);
}

// ---------------------------------------------------------------------------------------
// Clusters
// ---------------------------------------------------------------------------------------

export interface RukusRobot {
  name: string;
  host: string;
  ftpUser: string;
  /** `MD:/` as RUKUS writes it */
  ftpDirectory: string;
  /** the same fact the way cell.json spells it: `MD:` */
  device: string;
  /**
   * RUKUS keeps the FTP password in the cluster file in clear. It is carried here so a
   * sync can put it into VS Code's secret storage - and nowhere else. Never written to
   * cell.json, never logged.
   */
  ftpPassword?: string;
  isVirtual: boolean;
  isWriteLocked: boolean;
  notes?: string;
  expectedFNumber?: string;
  softwareVersion?: string;
  /**
   * RUKUS's "Make", lower-case: 'fanuc' or 'abb'. Clusters are mixed since RUKUS's ABB
   * integration (RUKUS #28). A robot without one is FANUC - every file from before then.
   */
  make: string;
  /** an ABB robot's Robot Web Services connection; set when make is 'abb' */
  abb?: RukusAbbRobot;
}

/** An ABB robot as RUKUS keeps it (AbbRobotProfile). The password may be DPAPI-encrypted - see dpapi.ts. */
export interface RukusAbbRobot {
  /** IRC5 = RobotWare 6, RWS 1.0; OmniCore = RobotWare 7+, RWS 2.0 */
  family: 'irc5' | 'omnicore';
  /** undefined = the protocol default (80, 443 with HTTPS) */
  port?: number;
  https: boolean;
  /** 'Default User' when RUKUS has none */
  user: string;
  /** as the file holds it: plain, or "dpapi:v1:..." when the cluster encrypts passwords */
  password?: string;
  mechUnit: string;
  /** what the controller told RUKUS it is, when RUKUS has read it */
  systemName?: string;
  robotWareName?: string;
  robotType?: string;
}

export interface RukusCluster {
  /** the file name without .json - the cluster's name to RUKUS */
  name: string;
  file: string;
  robots: RukusRobot[];
  sourceAdapterName?: string;
  savedUtc?: string;
  savedBy?: string;
  /** the parsed file as it was, for a round trip that keeps every RUKUS-only field */
  raw: Record<string, any>;
}

/** One cluster file. `undefined` when the text is not a cluster. */
export function parseCluster(name: string, file: string, text: string): RukusCluster | undefined {
  let raw: any;
  try { raw = JSON.parse(text); } catch { return undefined; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const list = Array.isArray(raw.Robots) ? raw.Robots : [];
  const robots: RukusRobot[] = [];
  for (const r of list) {
    if (!r || typeof r !== 'object') continue;
    const robotName = typeof r.RobotName === 'string' ? r.RobotName.trim() : '';
    if (!robotName) continue;
    const ftpDirectory = typeof r.FTPDirectory === 'string' && r.FTPDirectory.trim() ? r.FTPDirectory.trim() : 'MD:/';
    const make = makeOf(r);
    const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
    robots.push({
      make,
      ...(make === 'abb' ? {
        abb: {
          family: /omnicore/i.test(String(r.Family ?? '')) ? 'omnicore' as const : 'irc5' as const,
          ...(typeof r.Port === 'number' && r.Port > 0 ? { port: r.Port } : {}),
          https: r.UseHttps === true,
          user: str(r.RwsUser) ?? 'Default User',
          password: typeof r.RwsPassword === 'string' && r.RwsPassword ? r.RwsPassword : undefined,
          mechUnit: str(r.MechUnit) ?? 'ROB_1',
          systemName: str(r.SystemName), robotWareName: str(r.RobotWareName), robotType: str(r.RobotType),
        },
      } : {}),
      name: robotName,
      host: typeof r.IPAddress === 'string' ? r.IPAddress.trim() : '',
      ftpUser: typeof r.FTPUser === 'string' ? r.FTPUser : '',
      ftpDirectory,
      device: deviceOf(ftpDirectory),
      ftpPassword: typeof r.FTPPassword === 'string' && r.FTPPassword ? r.FTPPassword : undefined,
      isVirtual: r.IsVirtual === true,
      isWriteLocked: r.IsWriteLocked === true,
      notes: typeof r.Notes === 'string' && r.Notes ? r.Notes : undefined,
      expectedFNumber: typeof r.ExpectedFNumber === 'string' && r.ExpectedFNumber ? r.ExpectedFNumber : undefined,
      softwareVersion: typeof r.SoftwareVersion === 'string' && r.SoftwareVersion ? r.SoftwareVersion : undefined,
    });
  }
  return {
    name, file, robots, raw,
    sourceAdapterName: typeof raw.SourceAdapterName === 'string' ? raw.SourceAdapterName : undefined,
    savedUtc: typeof raw.SavedUtc === 'string' ? raw.SavedUtc : undefined,
    savedBy: typeof raw.SavedBy === 'string' ? raw.SavedBy : undefined,
  };
}

/** A cluster file robot's brand, lower-case; FANUC when it does not say (files from before ABB). */
export function makeOf(r: any): string {
  return typeof r?.Make === 'string' && r.Make.trim() ? r.Make.trim().toLowerCase() : 'fanuc';
}

/** `MD:/` -> `MD:`, `UD1:` stays, `md:` -> `MD:` */
export function deviceOf(ftpDirectory: string): string {
  const d = ftpDirectory.trim().replace(/[\\/]+$/, '').toUpperCase();
  return d.endsWith(':') ? d : d ? `${d}:` : 'MD:';
}

/** Every `<name>.json` in the clusters folder, by name. RUKUS's own `Backups` subfolder is not a cluster. */
export function listClusters(dir: string): RukusCluster[] {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const out: RukusCluster[] = [];
  for (const e of entries) {
    if (!e.isFile() || !/\.json$/i.test(e.name)) continue;
    const file = path.join(dir, e.name);
    const text = realFs.readText(file);
    if (text === undefined) continue;
    const c = parseCluster(e.name.replace(/\.json$/i, ''), file, text);
    if (c) out.push(c);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * A cluster's robots as cell.json controllers: name, host, FTP user and device. RUKUS
 * connects over FTP, so `useFtp` is set when the robot has an FTP user other than the
 * anonymous default; the extension's HTTP reads need no login and are left as the default
 * otherwise. Passwords are not here (see RukusRobot.ftpPassword).
 */
export function clusterControllers(c: RukusCluster): Record<string, CellControllerSpec> {
  const out: Record<string, CellControllerSpec> = {};
  for (const r of c.robots) {
    // FANUC only: an ABB robot is not an FTP/HTTP FANUC controller (clusterAbbRobots is its way in)
    if (!r.host || r.make !== 'fanuc') continue;
    const spec: CellControllerSpec = { host: r.host, device: r.device };
    if (r.ftpUser) spec.ftpUser = r.ftpUser;
    if (r.ftpUser && !/^anonymous$/i.test(r.ftpUser)) spec.useFtp = true;
    out[r.name] = spec;
  }
  return out;
}

/** A cluster's ABB robots with an address - what the ABB Controllers view takes from the open cluster. */
export function clusterAbbRobots(c: RukusCluster): RukusRobot[] {
  return c.robots.filter(r => r.make === 'abb' && r.host && r.abb);
}

/**
 * The other direction: the cell's controllers written into a cluster file, keeping every
 * field RUKUS has that the cell does not know (passwords, KCL, notes, write lock, MAC...).
 * A controller RUKUS has never seen becomes a new Fanuc robot with RUKUS's own defaults;
 * a robot no controller names any more is kept - the cell is not allowed to delete robots
 * from RUKUS, only RUKUS is. The result is the text to write.
 */
export function mergeControllersIntoCluster(existingText: string | undefined, controllers: Record<string, CellControllerSpec>, savedBy: string, now = new Date()): string {
  let raw: Record<string, any> = {};
  if (existingText) { try { const p = JSON.parse(existingText); if (p && typeof p === 'object' && !Array.isArray(p)) raw = p; } catch { /* start fresh */ } }
  if (raw.ClusterType === undefined) raw.ClusterType = 1;   // FanucCluster
  const robots: any[] = Array.isArray(raw.Robots) ? raw.Robots.filter((r: any) => r && typeof r === 'object') : [];
  for (const [name, spec] of Object.entries(controllers)) {
    const named = (r: any) => typeof r.RobotName === 'string' && r.RobotName.trim().toLowerCase() === name.toLowerCase();
    // cell controllers are FANUC: only a FANUC robot of that name is updated. An ABB robot that
    // happens to share the name is never overwritten with FTP settings, nor shadowed by a new one.
    const found = robots.find(r => named(r) && makeOf(r) === 'fanuc');
    if (!found && robots.some(r => named(r))) continue;
    const device = (spec.device ?? 'MD:').toUpperCase().replace(/:?\/?$/, ':/');
    if (found) {
      found.IPAddress = spec.host;
      if (spec.ftpUser !== undefined) found.FTPUser = spec.ftpUser;
      found.FTPDirectory = device;
    } else {
      robots.push({
        Make: 'Fanuc', KCLUser: null, KCLPassword: '', FTPDirectory: device, IsPassive: true, AutoCollectAlarms: false,
        RobotName: name, IPAddress: spec.host, FTPUser: spec.ftpUser ?? 'anonymous', FTPPassword: '',
        ExpectedMac: null, ExpectedFNumber: null, SoftwareVersion: null, IsWriteLocked: false, Notes: null,
        IsVirtual: /^127\./.test(spec.host), IsSelected: false, IsAlive: false,
      });
    }
  }
  // the shape RUKUS writes: header fields first, robots last
  const { Robots: _drop, ...rest } = raw;
  const ordered: Record<string, any> = { ...rest, SavedUtc: now.toISOString(), SavedBy: savedBy, Robots: robots };
  return JSON.stringify(ordered, null, 2) + '\n';
}

// ---------------------------------------------------------------------------------------
// Naming templates (BackupNamingHelper.cs)
// ---------------------------------------------------------------------------------------

/** characters Windows refuses in a file name, which RUKUS drops from every segment */
const INVALID_NAME_CHARS = /[<>:"/\\|?*\u0000-\u001f]/g;

/**
 * `now` in a .NET custom date format, for the tokens a backup name uses: yyyy yy MM M dd d
 * HH H mm ss, `\x` for a literal x and '...' / "..." for literal text. Anything else is
 * copied as it is. An empty format is `yyyy-MM-dd`, as in RUKUS.
 */
export function dotnetDate(format: string, now: Date): string {
  const f = format || 'yyyy-MM-dd';
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  let out = '';
  for (let i = 0; i < f.length;) {
    const ch = f[i];
    if (ch === '\\' && i + 1 < f.length) { out += f[i + 1]; i += 2; continue; }
    if (ch === "'" || ch === '"') { const end = f.indexOf(ch, i + 1); if (end > i) { out += f.slice(i + 1, end); i = end + 1; continue; } }
    let run = 1;
    while (i + run < f.length && f[i + run] === ch) run++;
    switch (ch) {
      case 'y': out += run >= 4 ? String(now.getFullYear()) : run >= 2 ? pad(now.getFullYear() % 100) : String(now.getFullYear() % 100); break;
      case 'M': out += run >= 2 ? pad(now.getMonth() + 1) : String(now.getMonth() + 1); break;
      case 'd': out += run >= 2 ? pad(now.getDate()) : String(now.getDate()); break;
      case 'H': out += run >= 2 ? pad(now.getHours()) : String(now.getHours()); break;
      case 'h': { const h = now.getHours() % 12 || 12; out += run >= 2 ? pad(h) : String(h); break; }
      case 'm': out += run >= 2 ? pad(now.getMinutes()) : String(now.getMinutes()); break;
      case 's': out += run >= 2 ? pad(now.getSeconds()) : String(now.getSeconds()); break;
      case 't': out += now.getHours() < 12 ? 'AM' : 'PM'; break;
      default: out += ch.repeat(run);
    }
    i += run;
  }
  return out;
}

export interface TemplateVars { cluster?: string; robot?: string; type?: string; now: Date }

/**
 * A template resolved the way BackupNamingHelper.Resolve does it: `{Date:...}` first, then
 * the three names (case-insensitive), then every segment stripped of invalid characters
 * and trimmed, empty segments dropped, joined with the platform separator.
 */
export function resolveTemplate(template: string, v: TemplateVars): string {
  if (!template.trim()) return '';
  let s = template.replace(/\{Date:([^}]*)\}/gi, (_, fmt: string) => dotnetDate(fmt, v.now));
  s = s.replace(/\{ClusterName\}/gi, v.cluster ?? '').replace(/\{RobotName\}/gi, v.robot ?? '').replace(/\{BackupType\}/gi, v.type ?? '');
  return s.split(/[\\/]/).map(seg => seg.replace(INVALID_NAME_CHARS, '').trim()).filter(Boolean).join(path.sep);
}

/** the last segment of a template: the part that names a robot folder */
export function lastSegment(template: string): string {
  return template.split(/[\\/]/).filter(s => s.trim()).pop() ?? '';
}

function dateFormatToRegExp(format: string): string {
  const f = format || 'yyyy-MM-dd';
  let out = '';
  for (let i = 0; i < f.length;) {
    const ch = f[i];
    if (ch === '\\' && i + 1 < f.length) { out += escapeRe(f[i + 1]); i += 2; continue; }
    if (ch === "'" || ch === '"') { const end = f.indexOf(ch, i + 1); if (end > i) { out += escapeRe(f.slice(i + 1, end)); i = end + 1; continue; } }
    let run = 1;
    while (i + run < f.length && f[i + run] === ch) run++;
    if ('yMdHhms'.includes(ch)) out += ch === 'y' ? (run >= 4 ? '\\d{4}' : '\\d{2}') : run >= 2 ? '\\d{2}' : '\\d{1,2}';
    else if (ch === 't') out += '[AP]M';
    else out += escapeRe(ch.repeat(run));
    i += run;
  }
  return out;
}

function escapeRe(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/**
 * A robot-folder template as a matcher for folder NAMES, with the robot's name in the
 * `robot` group: `{RobotName}_({BackupType})_{Date:yyMMdd}` reads `S002R01_(MD)_260912`.
 * A template that does not name the robot at all (`{Date:yyyy-MM-dd}`) gives a matcher with
 * no `robot` group. Case-insensitive, whole name.
 */
export function templateToRegExp(template: string): RegExp {
  const seg = lastSegment(template);
  let re = '';
  for (let i = 0; i < seg.length;) {
    const m = /^\{(Date:([^}]*)|ClusterName|RobotName|BackupType)\}/i.exec(seg.slice(i));
    if (!m) { re += escapeRe(seg[i]); i++; continue; }
    const tok = m[1].toLowerCase();
    if (tok.startsWith('date:')) re += dateFormatToRegExp(m[2]);
    else if (tok === 'robotname') re += '(?<robot>.+?)';
    else if (tok === 'clustername') re += '(?<cluster>.+?)';
    else re += '(?<type>[A-Za-z]+)';
    i += m[0].length;
  }
  return new RegExp(`^${re}$`, 'i');
}

/** the robot's name read out of a folder name with the template, or undefined when it does not fit */
export function robotNameFromTemplate(folderName: string, template: string): string | undefined {
  const m = templateToRegExp(template).exec(folderName);
  return m?.groups?.robot?.trim() || undefined;
}

// ---------------------------------------------------------------------------------------
// The backup layout (BackupLayoutHelper.cs) - where the extension's own backups go
// ---------------------------------------------------------------------------------------

export interface BackupPlace {
  /** `<backups root>\<cluster>` */
  clusterFolder: string;
  /** the batch's name, from the template's last segment or the run stamp */
  batchName: string;
  /** `<cluster>\<robot name>\<batch>` - the robot's own archive, where an older backup of it lives */
  archiveFolder: string;
  /** the robot folder's name from the robot template, for a manifest and for the wizard to read back */
  robotFolderName: string;
}

/**
 * Where RUKUS would file one backup of `robot` in `cluster` right now, in its archive
 * (never in Latest: Latest is RUKUS's to rotate, and a second folder for the same robot in
 * it would be two "currents"). The batch name is dated by the template or, when its last
 * segment carries no {Date}, by the run stamp - as RUKUS does. Reserved names step aside.
 */
export function placeBackup(backupsRoot: string, s: RukusAppSettings, cluster: string, robot: string, type: string, now = new Date()): BackupPlace {
  const rel = resolveTemplate(s.backupBatchFolderTemplate, { cluster, robot, type, now });
  const segs = rel.split(path.sep).filter(Boolean);
  const clean = (x: string, fallback: string) => x.replace(INVALID_NAME_CHARS, '').trim() || fallback;
  let clusterFolder: string, batchName: string;
  if (segs.length >= 2) { clusterFolder = path.join(backupsRoot, ...segs.slice(0, -1)); batchName = segs[segs.length - 1]; }
  else { clusterFolder = path.join(backupsRoot, clean(cluster, 'Cluster')); batchName = segs[0] ?? ''; }
  const dated = /\{Date/i.test(lastSegment(s.backupBatchFolderTemplate));
  if (!batchName || isReservedName(batchName) || !dated) batchName = dotnetDate(BATCH_STAMP_FORMAT, now);
  let robotDir = clean(robot, 'Robot');
  if (isReservedName(robotDir)) robotDir += '_robot';
  const robotFolderName = resolveTemplate(s.backupRobotFolderTemplate, { cluster, robot, type, now }).split(path.sep).pop() || robotDir;
  return { clusterFolder, batchName, archiveFolder: path.join(clusterFolder, robotDir, batchName), robotFolderName };
}

export function isReservedName(name: string): boolean { return /^(latest|\.incoming)$/i.test(name.trim()); }

/** the manifest RUKUS writes into every backup folder (BackupManifest.cs, SchemaVersion 1), so RUKUS reads ours as one of its own */
export function backupManifest(m: { robotName: string; robotIp: string; clusterName: string; batchName: string; startedUtc: Date; finishedUtc: Date; backupType: string; filterExtensions: string[]; filesListed: number; filesDownloaded: number; failedFiles: string[]; rukusVersion: string; machineName: string; windowsUser: string }): string {
  return JSON.stringify({
    SchemaVersion: 1,
    RobotName: m.robotName, RobotIp: m.robotIp, ClusterName: m.clusterName, BatchName: m.batchName,
    StartedUtc: m.startedUtc.toISOString(), FinishedUtc: m.finishedUtc.toISOString(),
    BackupType: m.backupType, FilterExtensions: m.filterExtensions,
    FilesListed: m.filesListed, FilesDownloaded: m.filesDownloaded, FailedFiles: m.failedFiles,
    RukusVersion: m.rukusVersion, MachineName: m.machineName, WindowsUser: m.windowsUser,
  }, null, 2) + '\n';
}

/** `<backups root>\<cluster>` when `dir` is a cluster's folder in the store (or inside one): the cluster's name */
export function clusterOfFolder(backupsRoot: string, dir: string): string | undefined {
  const rel = path.relative(backupsRoot, dir);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
  return rel.split(/[\\/]/)[0] || undefined;
}

// ---------------------------------------------------------------------------------------
// RUKUS's write audit log (Models/AuditEntry.cs, Services/AuditLogService.cs)
// ---------------------------------------------------------------------------------------

export const RUKUS_AUDIT_LOG = 'WriteAuditLog.jsonl';

export interface AuditWrite {
  robotName: string;
  robotAddress: string;
  /** what was written: RUKUS uses Register / PositionRegister / Io / SysVar / Comment; the extension adds Program */
  targetKind: string;
  targetAddress: string;
  targetLabel?: string;
  oldValue?: string;
  newValue?: string;
  reason?: string;
  result: 'Ok' | 'Failed' | 'Cancelled' | 'Refused';
  error?: string;
  /** the call site, `RobotCode/UploadProgram` */
  origin: string;
  durationMs: number;
  when?: Date;
  machineName: string;
  windowsUser: string;
}

/**
 * One line for RUKUS's WriteAuditLog.jsonl, in RUKUS's own field names and order, so every
 * write to a controller from either program is in the one record RUKUS shows and bundles.
 * RukusUser and RukusRole are null: the extension has no RUKUS sign-in.
 */
export function auditLine(w: AuditWrite): string {
  return JSON.stringify({
    TimestampUtc: (w.when ?? new Date()).toISOString(),
    MachineName: w.machineName, WindowsUser: w.windowsUser, RukusUser: null, RukusRole: null,
    RobotName: w.robotName, RobotAddress: w.robotAddress,
    TargetKind: w.targetKind, TargetAddress: w.targetAddress, TargetLabel: w.targetLabel ?? '',
    OldValue: w.oldValue ?? null, NewValue: w.newValue ?? null, Reason: w.reason ?? null,
    Result: w.result, Error: w.error ?? null, Origin: w.origin, DurationMs: Math.max(0, Math.round(w.durationMs)),
  });
}

/** append one entry to the log in `root` (RUKUS's data root); the file is created when missing */
export function appendAudit(root: string, w: AuditWrite): void {
  const file = path.join(root, RUKUS_AUDIT_LOG);
  let text = auditLine(w) + '\r\n';
  try { const size = fs.statSync(file).size; if (size > 0) { const tail = fs.readFileSync(file).subarray(-1).toString(); if (tail !== '\n') text = '\r\n' + text; } } catch { /* new file */ }
  fs.appendFileSync(file, text, 'utf8');
}

/** A robot's newest backup in the RUKUS store: Backups/<cluster>/<robot>/<dated folder>. */
export interface RobotBackup { cluster: string; robot: string; folder: string; taken: string }

/**
 * The newest backup of every robot in the RUKUS store - what the empty Registers view offers to load.
 * A backup is a folder holding controller data (*.va); the newest is the last dated folder name
 * (RUKUS names them by date, so they sort). Hidden entries (.robocode-*, .incoming) and RUKUS's own
 * Latest copy are skipped - the dated folder is the one a person recognises.
 */
export function newestRobotBackups(backupsRoot: string): RobotBackup[] {
  const dirs = (p: string): string[] => { try { return fs.readdirSync(p, { withFileTypes: true }).filter(d => d.isDirectory() && !d.name.startsWith('.') && !isReservedName(d.name)).map(d => d.name); } catch { return []; } };
  const hasData = (p: string): boolean => { try { return fs.readdirSync(p).some(f => /\.va$/i.test(f)); } catch { return false; } };
  const out: RobotBackup[] = [];
  for (const cluster of dirs(backupsRoot)) for (const robot of dirs(path.join(backupsRoot, cluster))) {
    const robotDir = path.join(backupsRoot, cluster, robot);
    const taken = dirs(robotDir).filter(d => hasData(path.join(robotDir, d))).sort().pop();
    if (taken) out.push({ cluster, robot, folder: path.join(robotDir, taken), taken });
  }
  return out.sort((a, b) => a.cluster.localeCompare(b.cluster) || a.robot.localeCompare(b.robot));
}
