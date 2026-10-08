/**
 * Which folders make up a RAPID file's task. Pure (node fs only) so the tests can check it
 * against a real backup layout.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface TaskFolders { task: string[]; shared: string[] }

/**
 * `.../RAPID/TASK2/PROGMOD/x.mod` -> TASK2's SYSMOD and PROGMOD, with TASK0's as the shared
 * modules (a backup keeps the installed `-Shared` modules there). Any other layout: the
 * file's own folder is the task, and nothing is shared.
 */
export function taskFoldersOf(fsPath: string): TaskFolders {
  const dir = path.dirname(fsPath);
  const m = /^(.*[\\/]RAPID[\\/])(TASK\d+)([\\/](?:SYSMOD|PROGMOD))?$/i.exec(dir);
  if (!m) return { task: [dir], shared: [] };
  const taskDir = m[1] + m[2];
  const sub = (d: string) => ['SYSMOD', 'PROGMOD'].map(s => path.join(d, s)).filter(p => fs.existsSync(p));
  const task = sub(taskDir);
  if (!task.length) task.push(dir);
  const shared = /^TASK0$/i.test(m[2]) ? [] : sub(m[1] + 'TASK0');
  return { task, shared };
}
