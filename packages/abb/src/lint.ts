/**
 * RAPID for the linter (core/lint/engine.ts): modules on disk, for Lint Folder and
 * robot-lint. No vscode. The modules of one task (RAPID/TASKn/SYSMOD + PROGMOD in a backup,
 * else one folder) are checked together, with TASK0's shared modules, as the editor does.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseRapid, type RapidModule } from './rapid/parser';
import { diagnoseModule, diagnoseTask, type RapidIssue } from './rapid/diagnostics';
import { rapidStyleChecks } from './rapid/style';
import { taskFoldersOf } from './rapid/task';
import { backupRootOf, taskFolderOf } from './backupInfo';
import { registerLintLanguage } from '@core/lint/engine';
import { DEFAULT_SETTINGS, type LintFinding, type LintSettings } from '@core/lint/types';

export const RAPID_EXTENSIONS = ['.mod', '.modx', '.sys', '.sysx', '.prg'];

/** a module's findings: the task-level issues, then the style rules */
export function rapidFindings(mod: RapidModule, issues: RapidIssue[], settings: LintSettings = DEFAULT_SETTINGS): LintFinding[] {
  const out: LintFinding[] = issues.filter(i => settings.enabled(i.code)).map(i => ({ code: i.code, message: i.message, severity: i.severity, span: i.span, unnecessary: i.code === 'rapid.unusedLocalRoutine' || undefined }));
  out.push(...rapidStyleChecks(mod, settings));
  return out;
}

/** every folder of a backup that holds modules a HOME library can see: each task's SYSMOD/PROGMOD and the HOME tree */
function backupLibraryDirs(root: string): string[] {
  const out: string[] = [];
  let tasks: string[] = [];
  try { tasks = fs.readdirSync(path.join(root, 'RAPID')).filter(n => /^TASK\d+$/i.test(n)); } catch { /* none */ }
  for (const t of tasks) for (const s of ['SYSMOD', 'PROGMOD']) { const d = path.join(root, 'RAPID', t, s); if (fs.existsSync(d)) out.push(d); }
  const walk = (d: string, depth: number) => {
    out.push(d);
    if (depth > 4) return;
    let names: fs.Dirent[] = [];
    try { names = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const n of names) if (n.isDirectory()) walk(path.join(d, n.name), depth + 1);
  };
  walk(path.join(root, 'HOME'), 0);
  return out;
}

export function registerAbbLint(): void {
  registerLintLanguage({
    id: 'abb-rapid',
    label: 'ABB RAPID',
    extensions: RAPID_EXTENSIONS,
    encoding: 'latin1',
    lintGroup(files, settingsOf) {
      const mods = new Map(files.map(f => [f.path, parseRapid(f.text)]));
      const byTask = new Map<string, { files: string[]; task: string[]; shared: string[] }>();
      for (const f of files) {
        const tf = taskFoldersOf(f.path);
        // a library in a backup's HOME folder is loaded into a task at run time: what it calls lives in the
        // backup's tasks or in other HOME files, so those are its shared modules
        const root = taskFolderOf(f.path) ? undefined : backupRootOf(f.path);
        if (root) tf.shared = backupLibraryDirs(root);
        const key = tf.task.map(d => d.toLowerCase()).sort().join('|');
        const g = byTask.get(key) ?? { files: [], task: tf.task, shared: tf.shared };
        g.files.push(f.path);
        byTask.set(key, g);
      }
      const dirCache = new Map<string, { path: string; mod: RapidModule }[]>();
      // every module of a folder: the ones being linted as parsed above, the rest read for context
      const modulesIn = (d: string) => {
        let list = dirCache.get(d);
        if (!list) {
          list = [];
          let names: string[] = [];
          try { names = fs.readdirSync(d); } catch { /* none */ }
          for (const n of names) {
            if (!RAPID_EXTENSIONS.includes(path.extname(n).toLowerCase())) continue;
            const p = path.join(d, n);
            const m = mods.get(p);
            if (m) list.push({ path: p, mod: m });
            else try { list.push({ path: p, mod: parseRapid(fs.readFileSync(p, 'latin1')) }); } catch { /* unreadable: left out */ }
          }
          dirCache.set(d, list);
        }
        return list;
      };
      const out = new Map<string, LintFinding[]>();
      for (const g of byTask.values()) {
        const list = g.files.map(f => mods.get(f)!);
        // the task's other modules on disk resolve calls too (a single file linted on its own); their findings are not reported
        const linted = new Set(g.files.map(f => path.resolve(f).toLowerCase()));
        const context = g.task.flatMap(modulesIn).filter(x => !linted.has(path.resolve(x.path).toLowerCase())).map(x => x.mod);
        const shared = g.shared.flatMap(modulesIn).map(x => x.mod);
        const issues = list.length + context.length > 1 || shared.length ? diagnoseTask([...list, ...context], { shared }) : list.map(diagnoseModule);
        g.files.forEach((f, i) => out.set(f, rapidFindings(list[i], issues[i], settingsOf(f))));
      }
      return out;
    },
  });
}
