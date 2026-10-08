/**
 * Take an IRC5 backup over RWS and bring it to the PC. No VS Code here, so the test can run it
 * against the mock; the command in view.ts does the asking and the confirming.
 *
 *   1. POST /ctrl/backup?action=backup into $BACKUP/<name> - the FlexPendant's Backup, same place;
 *   2. poll the backup state until it is done;
 *   3. walk $BACKUP/<name> and GET every file into <local>/<name>;
 *   4. only if asked, delete $BACKUP/<name> on the controller (one recursive DELETE).
 *
 * "Backup Ready" is the state after ANY finished backup, including one from before this call, so
 * a Ready only counts once this backup was seen running or its folder exists.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { RwsClient } from '../rws/client';

export interface BackupProgress { (message: string, done?: number, total?: number): void }

export interface BackupResult { remote: string; local: string; files: number; bytes: number; removed: boolean; ms: number }

/** `IRC5_1_Backup_20260925_2231`: what the FlexPendant proposes, plus the time so two a day do not collide */
export function defaultBackupName(system: string | undefined, now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const sys = (system ?? 'IRC5').replace(/[^\w-]+/g, '_');
  return `${sys}_Backup_${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}_${p(now.getHours())}${p(now.getMinutes())}`;
}

/** a name the controller and Windows both accept as a folder */
export const validBackupName = (s: string) => /^[A-Za-z0-9_][\w.-]{0,63}$/.test(s) && !/\.$/.test(s);

/** a name from a controller listing that is safe to write under a local folder */
const safeSegment = (s: string) => s !== '' && s !== '.' && s !== '..' && !/[\\/:*?"<>|\x00-\x1f]/.test(s);

export async function takeBackup(c: RwsClient, name: string, localRoot: string, opts: {
  remove?: boolean; progress?: BackupProgress; timeoutMs?: number; pollMs?: number;
} = {}): Promise<BackupResult> {
  if (!validBackupName(name)) throw new Error(`"${name}" is not a usable backup name (letters, digits, _ - .)`);
  const t0 = Date.now();
  const say = opts.progress ?? (() => undefined);
  const remote = `$BACKUP/${name}`;
  const local = path.join(localRoot, name);
  if (fs.existsSync(local)) throw new Error(`${local} already exists; pick another name`);
  if (await c.exists(remote)) throw new Error(`The controller already has ${remote}; pick another name`);
  const before = await c.backupState();
  if (/progress/i.test(before ?? '')) throw new Error('The controller is already taking a backup; try again when it is done');

  say('Asking the controller for a backup…');
  await c.startBackup(remote);

  const deadline = Date.now() + (opts.timeoutMs ?? 10 * 60_000);
  let seenRunning = false;
  for (;;) {
    const st = await c.backupState() ?? '';
    if (/progress/i.test(st)) { seenRunning = true; say('The controller is writing the backup…'); }
    else if (/error|timeout|fail/i.test(st)) throw new Error(`The controller reports: ${st}`);
    else if (/ready/i.test(st) && (seenRunning || await c.exists(`${remote}/system.xml`))) break;
    if (Date.now() > deadline) throw new Error(`The backup did not finish within ${Math.round((opts.timeoutMs ?? 600_000) / 1000)} s (state: ${st || 'unknown'})`);
    await new Promise(r => setTimeout(r, opts.pollMs ?? 500));
  }

  // walk it first, so the download can say "12 of 180"
  say('Listing the backup…');
  const files: { rel: string[]; size: number }[] = [];
  const walk = async (rel: string[]) => {
    const l = await c.listDir([remote, ...rel].join('/'));
    for (const f of l.files) if (safeSegment(f.name)) files.push({ rel: [...rel, f.name], size: f.size });
    for (const d of l.dirs) if (safeSegment(d)) await walk([...rel, d]);
  };
  await walk([]);
  if (!files.length) throw new Error(`${remote} is empty on the controller`);

  let bytes = 0;
  fs.mkdirSync(local, { recursive: true });
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    say(`Downloading ${f.rel.join('/')}`, i, files.length);
    const data = await c.file([remote, ...f.rel].join('/'));
    const to = path.join(local, ...f.rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, data);
    bytes += data.length;
  }
  say('Downloaded', files.length, files.length);

  let removed = false;
  if (opts.remove) { say(`Removing ${remote} from the controller…`); await c.deletePath(remote); removed = true; }
  return { remote, local, files: files.length, bytes, removed, ms: Date.now() - t0 };
}
