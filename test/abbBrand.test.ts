/**
 * The ABB brand as core sees it: which files it claims, how a RAPID module is indexed, what
 * an IRC5 backup looks like, and which folders make up a task. Wired in by test/run.ts:
 * `run(check)`. The corpus half reads the IRC5 backups in abb-reference and skips without them.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { abbBrand } from '@abb/brand';
import { taskFoldersOf } from '@abb/rapid/task';
import { robotTypeLabel, readBackupInfo, backupRootOf, taskFolderOf, homePathOf } from '@abb/backupInfo';
import { registerBrand, brandForFile, looksLikeAnyBackup, programFileRe } from '@core/brand';
import { fanucBrand } from '@fanuc/brand';
import { findCorpus } from './rapid.test';

type Check = (cond: unknown, msg: string) => void;

export function run(check: Check): void {
  registerBrand(fanucBrand);
  registerBrand(abbBrand);

  // ---- files, both brands side by side ----
  check(brandForFile('C:/x/MainModule.mod')?.id === 'abb' && brandForFile('C:/x/USER.SYS')?.id === 'abb' && brandForFile('C:/x/MAIN.LS')?.id === 'fanuc', 'brandForFile: .mod/.sys go to ABB, .ls to FANUC');
  check(programFileRe().test('a.mod') && programFileRe().test('a.KL') && !programFileRe().test('a.va'), 'programFileRe covers both brands and nothing else');

  // ---- indexing ----
  const text = ['%%%', '  VERSION:1', '  LANGUAGE:ENGLISH', '%%%', '', 'MODULE MainModule',
    '  CONST robtarget pHome := [[1000,0,1200],[0,0,1,0],[0,0,0,0],[9E+09,9E+09,9E+09,9E+09,9E+09,9E+09]];',
    '  VAR num nCount := 0;',
    '  PROC main()', '    MoveJ pHome, v1000, fine, tool0;', '    Weld;', '    nCount := nCount + 1;', '  ENDPROC',
    '  PROC Weld()', '    MoveL Offs(pHome,0,0,100), v500, z10, tool0;', '  ENDPROC', 'ENDMODULE', ''].join('\r\n');
  const f = abbBrand.indexProgram('C:/cell/RAPID/TASK1/PROGMOD/MainModule.mod', text);
  check(f?.name === 'MAINMODULE' && f.kind === 'rapid' && f.programType === 'RAPID program module', `indexProgram names the module: ${f?.name} ${f?.kind} ${f?.programType}`);
  check(f?.calls.join(',') === 'WELD', `indexProgram lists procedure calls, not built-ins: ${f?.calls.join(',')}`);
  check(f?.positions === 1, `indexProgram counts robtargets as positions: ${f?.positions}`);
  check(f?.dataAccess.get('DATA:NCOUNT') === 'w', `indexProgram records a write: ${f?.dataAccess.get('DATA:NCOUNT')}`);
  check(abbBrand.indexProgram('C:/Windows/System32/drivers/acpi.sys', 'MZ\u0090\u0000binary') === undefined, 'a Windows driver .sys is not a RAPID module');
  const enc = abbBrand.indexProgram('C:/cell/RAPID/TASK1/SYSMOD/SpotLib.sys', '\u00fc\u0012\u0000\u0034garbage');
  check(enc === undefined || enc.kind === 'rapid-encrypted', `an encrypted module indexes by file name or not at all: ${enc?.kind}`);

  // ---- backups ----
  check(abbBrand.looksLikeBackup(new Set(['backinfo', 'cs', 'home', 'rapid', 'syspar', 'system.xml'])), 'an IRC5 backup is recognised');
  check(!abbBrand.looksLikeBackup(new Set(['rapid'])) && !abbBrand.looksLikeBackup(new Set(['numreg.va'])), 'a lone RAPID folder or a FANUC dump is not an ABB backup');
  check(looksLikeAnyBackup(new Set(['numreg.va'])) && looksLikeAnyBackup(new Set(['backinfo', 'syspar'])), 'looksLikeAnyBackup asks both brands');

  // ---- the corpus ----
  const root = findCorpus();
  if (!root) { console.log('  (abb-reference corpus not found; ABB brand corpus checks skipped)'); return; }
  const backups = fs.readdirSync(root).map(n => path.join(root, n)).filter(p => fs.statSync(p).isDirectory());
  const recognised = backups.filter(b => looksLikeAnyBackup(new Set(fs.readdirSync(b).map(n => n.toLowerCase()))));
  check(recognised.length === backups.length, `every IRC5 backup is recognised as one: ${recognised.length}/${backups.length}`);

  let indexed = 0, encrypted = 0, none = 0, files = 0;
  const firstBackup = backups[0];
  for (const b of backups.slice(0, 3)) {
    const rapid = path.join(b, 'RAPID');
    const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
    for (const p of walk(rapid).filter(p => /\.(mod|sys)$/i.test(p))) {
      files++;
      const r = abbBrand.indexProgram(p, fs.readFileSync(p, 'latin1'));
      if (!r) none++; else if (r.kind === 'rapid-encrypted') encrypted++; else indexed++;
    }
  }
  check(files > 100 && none === 0, `every RAPID file in 3 backups indexes (${indexed} modules, ${encrypted} encrypted, ${none} not recognised, of ${files})`);
  console.log(`  abb brand: ${recognised.length} backups recognised; ${indexed} modules + ${encrypted} encrypted indexed from ${files} files in 3 backups`);

  // ---- what a backup says about itself (the RAPID sidebar's rows) ----
  const labels: [string, string][] = [['ROB1_6700_LeanID_2.65_220', 'IRB 6700-220/2.65 LeanID'], ['ROB1_6700_2.65_235', 'IRB 6700-235/2.65'], ['ROB1_8700_LeanID_3.50_630', 'IRB 8700-630/3.50 LeanID'], ['SOMETHING_ELSE', 'SOMETHING_ELSE']];
  for (const [t, want] of labels) check(robotTypeLabel(t) === want, `robotTypeLabel(${t}) = ${robotTypeLabel(t)}, want ${want}`);
  const infos = backups.map(b => readBackupInfo(b));
  const oneMotion = infos.filter(i => i.tasks.filter(t => t.motion).length === 1);
  check(oneMotion.length === infos.length, `every backup names exactly one motion task: ${oneMotion.length}/${infos.length} (${infos.filter(i => !oneMotion.includes(i)).map(i => path.basename(i.root)).join(', ')})`);
  check(infos.every(i => i.tasks.some(t => t.folder === 'TASK0' && t.shared)), 'every backup lists TASK0 as the shared modules');
  check(infos.every(i => /^IRB \d+-\d+\//.test(i.robotLabel ?? '')), `every backup names its robot: ${[...new Set(infos.map(i => i.robotLabel))].join(' | ')}`);
  check(infos.every(i => /^6\.\d+/.test(i.robotWare ?? '') && !!i.systemId), `RobotWare version and system id read: ${[...new Set(infos.map(i => i.robotWare))].join(', ')}`);
  const sample = path.join(firstBackup, 'RAPID', 'TASK1', 'SYSMOD', 'x.sys');
  check(backupRootOf(sample) === firstBackup && taskFolderOf(sample) === 'TASK1', `backupRootOf / taskFolderOf on the real layout: ${backupRootOf(sample)} ${taskFolderOf(sample)}`);
  check(backupRootOf('C:/work/cell/RAPID/TASK1/x.mod') === undefined, 'backupRootOf needs a BACKINFO folder, not just a RAPID path');
  const homeFile = path.join(firstBackup, 'HOME', 'GenRob', 'x.sys');
  check(backupRootOf(homeFile) === firstBackup && homePathOf(homeFile) === 'GenRob/x.sys' && taskFolderOf(homeFile) === undefined, `a HOME file belongs to its backup, under HOME, in no task: ${backupRootOf(homeFile)} ${homePathOf(homeFile)}`);
  check(homePathOf(sample) === undefined, 'a task file is not in HOME');
  console.log(`  abb backups: ${[...new Set(infos.map(i => i.robotLabel))].join(', ')}; motion tasks ${[...new Set(infos.flatMap(i => i.tasks.filter(t => t.motion).map(t => `${t.name}(${t.folder})`)))].join(', ')}`);

  // ---- task folders on the real layout ----
  const task1 = path.join(firstBackup, 'RAPID', 'TASK1');
  const anyProg = fs.existsSync(path.join(task1, 'PROGMOD')) ? path.join(task1, 'PROGMOD', 'x.mod') : path.join(task1, 'SYSMOD', 'x.sys');
  const tf = taskFoldersOf(anyProg);
  check(tf.task.some(d => /SYSMOD$/i.test(d)) && tf.shared.every(d => /TASK0[\\/](SYSMOD|PROGMOD)$/i.test(d)), `taskFoldersOf: TASK1's SYSMOD/PROGMOD, TASK0 shared: ${JSON.stringify(tf)}`);
  check(taskFoldersOf('C:/work/cell/main.mod').task[0].replace(/\\/g, '/') === 'C:/work/cell', 'taskFoldersOf: outside a backup, the file\'s folder is the task');
}
