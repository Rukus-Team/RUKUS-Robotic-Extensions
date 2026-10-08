/**
 * What an IRC5 backup says about itself, for the sidebar: the system, the RobotWare version,
 * the robot, and which task each RAPID/TASKn folder is. Pure (node fs only), cached per folder.
 *
 *   BACKINFO/backinfo.txt   >>SYSTEM_ID, >>PRODUCTS_ID (RobotWare Version: ...),
 *                           >>TASKn: (NAME,PROGRAM,) followed by the task's module files
 *   SYSPAR/SYS.cfg          CAB_TASKS: the task that carries -MotionTask is the robot's
 *   SYSPAR/MOC.cfg          ROBOT: -use_robot_type "ROB1_6700_LeanID_2.65_220"
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface AbbTaskInfo {
  /** the backup folder name: 'TASK5' */
  folder: string;
  /** the task's name on the controller: 'T_ROB1' */
  name: string;
  /** the program loaded in it, when there is one: 'PrgPM_Se' */
  program?: string;
  /** the task that moves the robot */
  motion: boolean;
  /** TASK0 in a backup: the installed modules every task shares */
  shared: boolean;
}

export interface AbbBackupInfo {
  /** the backup's root folder (holds BACKINFO, RAPID, SYSPAR) */
  root: string;
  systemId?: string;
  robotWare?: string;
  /** as the controller names it: 'ROB1_6700_LeanID_2.65_220' */
  robotType?: string;
  /** as a person names it: 'IRB 6700-220/2.65 LeanID' */
  robotLabel?: string;
  tasks: AbbTaskInfo[];
}

/** 'ROB1_6700_LeanID_2.65_220' -> 'IRB 6700-220/2.65 LeanID'; anything else comes back as it is. */
export function robotTypeLabel(type: string): string {
  const m = /^ROB\d+_(\d+)(?:_(LeanID))?_(\d+(?:\.\d+)?)_(\d+)$/i.exec(type);
  return m ? `IRB ${m[1]}-${m[4]}/${m[3]}${m[2] ? ' LeanID' : ''}` : type;
}

/**
 * The backup's root folder when `fsPath` sits in its RAPID tree or its HOME folder (the
 * controller's own disk: libraries and program sources a task may load); undefined otherwise.
 */
export function backupRootOf(fsPath: string): string | undefined {
  // every RAPID/TASKn or HOME segment is a candidate - a parent folder may be called HOME too -
  // and the one with BACKINFO beside it is the backup
  const re = /[\\/](?:RAPID[\\/]TASK\d+|HOME)(?=[\\/]|$)/gi;
  for (let m: RegExpExecArray | null; (m = re.exec(fsPath));) {
    const root = fsPath.slice(0, m.index);
    if (root && fs.existsSync(path.join(root, 'BACKINFO'))) return root;
  }
  return undefined;
}

/** The path under the backup's HOME folder ('GenRob/x.sys'), or undefined when the file is not in HOME. */
export function homePathOf(fsPath: string): string | undefined {
  const root = backupRootOf(fsPath);
  if (!root) return undefined;
  const rel = path.relative(path.join(root, 'HOME'), fsPath);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.replace(/\\/g, '/') : undefined;
}

/** 'TASK5' out of `.../RAPID/TASK5/PROGMOD/x.mod`. */
export function taskFolderOf(fsPath: string): string | undefined {
  return /[\\/]RAPID[\\/](TASK\d+)(?:[\\/]|$)/i.exec(fsPath)?.[1].toUpperCase();
}

const cache = new Map<string, { at: number; info: AbbBackupInfo }>();

export function readBackupInfo(root: string): AbbBackupInfo {
  const key = root.toLowerCase();
  let stamp = 0;
  try { stamp = fs.statSync(path.join(root, 'BACKINFO', 'backinfo.txt')).mtimeMs; } catch { /* none */ }
  const hit = cache.get(key);
  if (hit && hit.at === stamp) return hit.info;

  const read = (...p: string[]) => { try { return fs.readFileSync(path.join(root, ...p), 'latin1'); } catch { return ''; } };
  const info: AbbBackupInfo = { root, tasks: [] };

  const bi = read('BACKINFO', 'backinfo.txt');
  info.systemId = /^>>SYSTEM_ID:\s*\r?\n\s*(\S.*?)\s*$/m.exec(bi)?.[1];
  info.robotWare = /RobotWare Version:\s*(\S+)/.exec(bi)?.[1];

  // the motion task(s), from the CAB_TASKS entries in SYS.cfg (an entry is a run of lines ending in \)
  const sys = read('SYSPAR', 'SYS.cfg').replace(/\\\r?\n\s*/g, ' ');
  const motion = new Set<string>();
  const cab = /^CAB_TASKS:\s*$([\s\S]*?)^#/m.exec(sys)?.[1] ?? '';
  for (const line of cab.split(/\r?\n/)) {
    const name = /-Name\s+"([^"]+)"/.exec(line)?.[1];
    if (name && /-MotionTask\b/.test(line)) motion.add(name.toUpperCase());
  }

  for (const m of bi.matchAll(/^>>(TASK\d+):\s*\(([^,)]*),([^,)]*),?[^)]*\)/gm)) {
    const folder = m[1].toUpperCase();
    info.tasks.push({ folder, name: m[2].trim() || folder, program: m[3].trim() || undefined, motion: motion.has(m[2].trim().toUpperCase()), shared: folder === 'TASK0' });
  }

  const moc = read('SYSPAR', 'MOC.cfg').replace(/\\\r?\n\s*/g, ' ');
  info.robotType = /-use_robot_type\s+"([^"]+)"/.exec(moc)?.[1];
  if (info.robotType) info.robotLabel = robotTypeLabel(info.robotType);

  cache.set(key, { at: stamp, info });
  return info;
}
