/**
 * ABB analysis tools: backup compare, unused routines and the data/signal cross-reference. Synthetic
 * fixtures pin each rule; the corpus half compares an IRC5 backup with itself (no change) and with a
 * scratch copy changed in known ways, and runs both task reports over every task.
 * Wired in by test/run.ts: `run(check)`.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseRapid } from '@abb/rapid/parser';
import { diffAbbBackups, abbBackupDiffMarkdown, isAbbBackup } from '@abb/tools/backupDiff';
import { unusedRoutines, rapidXref, unusedRoutinesMarkdown, xrefMarkdown } from '@abb/tools/analysis';
import { looksLikeAbb } from '@abb/detect';
import { looksLikeFanuc } from '@fanuc/detect';
import { findCorpus } from './rapid.test';

type Check = (cond: unknown, msg: string) => void;

const MAIN = [
  'MODULE MainModule',
  '  PERS num nShared := 0;',
  '  VAR num nNeverSet;',
  '  VAR num nIdle := 0;',
  '  PROC main()',
  '    nShared := 1;',
  '    PickPart;',
  '    SetDO doGrip, 1;',
  '    WaitDI diPart, 1;',
  '    IF DInput(diPart) = 1 THEN',
  '      TPWrite "x" \\Num:=nNeverSet;',
  '    ENDIF',
  '    CONNECT iTimer WITH tTimer;',
  '    %"Late_" + "One"%;',
  '  ENDPROC',
  '  TRAP tTimer',
  '  ENDTRAP',
  '  PROC Orphan()',
  '  ENDPROC',
  '  PROC Late_One()',
  '  ENDPROC',
  'ENDMODULE',
].join('\n');
const GRIP = [
  'MODULE Gripper',
  '  PROC PickPart()',
  '    nShared := 2;',
  '    SetDO doGrip, 0;',
  '    Tidy;',
  '  ENDPROC',
  '  LOCAL PROC Tidy()',
  '  ENDPROC',
  '  LOCAL PROC NeverCalled()',
  '  ENDPROC',
  'ENDMODULE',
].join('\n');

export function run(check: Check): void {
  const task = { names: ['MainModule', 'Gripper'], mods: [parseRapid(MAIN), parseRapid(GRIP)] };
  const unused = unusedRoutines(task).map(u => `${u.module}.${u.name}`).sort();
  check(unused.join(' ') === 'Gripper.NeverCalled MainModule.Orphan', `unused: main, connected TRAPs, calls across modules and "Late_" strings count as used: ${unused.join(' ')}`);
  check(/2 routines nothing/.test(unusedRoutinesMarkdown('T', unusedRoutines(task), 2)), 'unused report text');

  const x = rapidXref(task);
  const row = (n: string) => x.find(r => r.name.toUpperCase() === n.toUpperCase());
  check(row('nShared')?.findings.includes('written from 2 modules') && row('nShared')!.writers.length === 2, `PERS written in two modules is flagged: ${JSON.stringify(row('nShared'))}`);
  check(row('nNeverSet')?.findings.some(f => /never written/.test(f)), `VAR read but never written: ${JSON.stringify(row('nNeverSet'))}`);
  check(row('nIdle')?.findings.includes('never used'), 'VAR never used');
  check(row('doGrip')?.what === 'signal' && row('doGrip')!.findings.includes('set from 2 modules'), `signal set from two modules: ${JSON.stringify(row('doGrip'))}`);
  check(row('diPart')?.what === 'signal' && row('diPart')!.readers.length >= 1 && !row('diPart')!.writers.length, `signal read by WaitDI and DInput: ${JSON.stringify(row('diPart'))}`);
  check(/## Findings/.test(xrefMarkdown('T', x)), 'xref report has a findings table');

  // ---- backup compare on scratch backups ----
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'abb-diff-'));
  try {
    const mk = (root: string, files: Record<string, string>) => { for (const [rel, text] of Object.entries(files)) { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text, 'latin1'); } };
    const A = path.join(tmp, 'A'), B = path.join(tmp, 'B');
    const base = {
      'BACKINFO/backinfo.txt': '>>TASK1: (T_ROB1,Main,)\n', 'system.xml': '<x/>',
      'SYSPAR/SYS.cfg': 'SYS:CFG_1.0:6:0::\n#\nCAB_TASKS:\n      -Name "T_ROB1" -Type "NORMAL" -MotionTask \n',
      'SYSPAR/EIO.cfg': 'EIO:CFG_1.0:6:0::\n',
      'RAPID/TASK1/PROGMOD/Main.mod': 'MODULE Main\n  CONST robtarget pA := [[100,0,0],[1,0,0,0],[0,0,0,0],[9E9,9E9,9E9,9E9,9E9,9E9]];\n  PROC main()\n    MoveJ pA, v100, fine, tool0;\n  ENDPROC\nENDMODULE\n',
      'RAPID/TASK1/PROGMOD/Old.mod': 'MODULE Old\nENDMODULE\n',
    };
    mk(A, base);
    mk(B, { ...base,
      'RAPID/TASK1/PROGMOD/Main.mod': 'MODULE Main\n    CONST robtarget pA := [[100,0,3],[1,0,0,0],[0,0,0,0],[9E9,9E9,9E9,9E9,9E9,9E9]];\n    PROC main()\n        MoveJ pA, v100, fine, tool0;\n        Extra;\n    ENDPROC\n    PROC Extra()\n    ENDPROC\nENDMODULE\n',
      'SYSPAR/EIO.cfg': 'EIO:CFG_1.0:6:0::\nEIO_SIGNAL:\n  -Name "doNew" -SignalType "DO"\n',
    });
    fs.rmSync(path.join(B, 'RAPID/TASK1/PROGMOD/Old.mod'));
    mk(B, { 'RAPID/TASK1/PROGMOD/New.mod': 'MODULE New\nENDMODULE\n' });
    check(isAbbBackup(A) && !isAbbBackup(tmp), 'isAbbBackup: BACKINFO with RAPID/SYSPAR');
    const d = diffAbbBackups(A, B);
    const m = (n: string) => d.modules.find(x => x.module.toUpperCase() === n.toUpperCase());
    check(m('Old')?.kind === 'removed' && m('New')?.kind === 'added' && m('Main')?.kind === 'changed' && d.modules.length === 3, `modules added/removed/changed: ${d.modules.map(x => `${x.module}:${x.kind}`).join(' ')}`);
    check(m('Main')!.task === 'T_ROB1', `task named from backinfo.txt: ${m('Main')!.task}`);
    const r = m('Main')!.routines.map(x => `${x.name}:${x.kind}`).sort().join(' ');
    check(r === 'Extra:added main:changed', `routines (indentation alone is no change): ${r}`);
    const t = m('Main')!.targets[0];
    check(m('Main')!.targets.length === 1 && t.name === 'pA' && t.kind === 'moved' && Math.abs(t.distance! - 3) < 1e-9, `robtarget moved 3 mm: ${JSON.stringify(m('Main')!.targets)}`);
    check(d.cfg.length === 1 && d.cfg[0].file === 'EIO.cfg' && d.cfg[0].linesAdded === 2, `config: ${JSON.stringify(d.cfg)}`);
    const md = abbBackupDiffMarkdown(d);
    check(/## T_ROB1/.test(md) && /\| pA \| moved \| 3\.00 mm \|/.test(md) && /## Configuration/.test(md), 'markdown report');
    check(diffAbbBackups(A, A).modules.length === 0 && /same RAPID and configuration/.test(abbBackupDiffMarkdown(diffAbbBackups(A, A))), 'a backup against itself: no change');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }

  // ---- ABB detection at activation (abbAuto: ABB loads by itself in a workspace that has ABB files) ----
  const det = fs.mkdtempSync(path.join(os.tmpdir(), 'abb-detect-'));
  try {
    fs.mkdirSync(path.join(det, 'cell', 'r1'), { recursive: true });
    fs.writeFileSync(path.join(det, 'cell', 'r1', 'MAIN.ls'), '/PROG MAIN\n/MN\n/END\n');
    check(!looksLikeAbb([det]), 'detect: a FANUC-only folder is not ABB');
    check(looksLikeFanuc([det]), 'detect: a .ls a few levels down is FANUC');
    fs.writeFileSync(path.join(det, 'cell', 'r1', 'Main.mod'), 'MODULE Main\nENDMODULE\n');
    check(looksLikeAbb([det]), 'detect: a .mod a few levels down is ABB');
    check(!looksLikeAbb([path.join(det, 'nope')]), 'detect: a missing folder is not ABB');
  } finally { fs.rmSync(det, { recursive: true, force: true }); }
  const fanucRef = path.resolve(__dirname, '..', '..', 'reference-backup');
  if (fs.existsSync(fanucRef)) check(!looksLikeAbb([fanucRef]) && looksLikeFanuc([fanucRef]), 'detect: the FANUC reference backup is FANUC, not ABB');

  // ---- corpus ----
  const root = findCorpus();
  if (root) check(looksLikeAbb([path.dirname(root)]) && !looksLikeFanuc([root]), 'detect: the IRC5 backups folder is ABB, not FANUC');
  if (!root) { console.log('  (abb-reference corpus not found; ABB tools corpus checks skipped)'); return; }
  const backups = fs.readdirSync(root).map(n => path.join(root, n)).filter(isAbbBackup);
  check(backups.length > 5, `corpus backups found: ${backups.length}`);
  const one = backups[0];
  const self = diffAbbBackups(one, one);
  check(self.modules.length === 0 && self.cfg.length === 0 && self.unchanged > 10, `a corpus backup against itself: no change (${self.unchanged} modules)`);
  const two = diffAbbBackups(backups[0], backups[1]);
  check(two.modules.length + two.unchanged > 10, `two corpus backups compare without error: ${two.modules.length} differ, ${two.unchanged} same, ${two.cfg.length} cfg`);
  let tasks = 0, unusedTotal = 0, xrefTotal = 0;
  for (const b of backups) {
    let dirs: string[] = [];
    try { dirs = fs.readdirSync(path.join(b, 'RAPID')).filter(n => /^TASK[1-9]\d*$/i.test(n)); } catch { continue; }
    for (const t of dirs) {
      const folders = ['SYSMOD', 'PROGMOD', '../TASK0/SYSMOD', '../TASK0/PROGMOD'].map(s => path.join(b, 'RAPID', t, s)).filter(p => fs.existsSync(p));
      const names: string[] = [], mods = [];
      for (const dir of folders) for (const n of fs.readdirSync(dir).filter(f => /\.(mod|sys)$/i.test(f))) { names.push(n); mods.push(parseRapid(fs.readFileSync(path.join(dir, n), 'latin1'))); }
      tasks++;
      unusedTotal += unusedRoutines({ names, mods }).length;
      xrefTotal += rapidXref({ names, mods }).length;
    }
  }
  check(tasks > 20 && xrefTotal > 100, `task reports over the corpus: ${tasks} tasks, ${unusedTotal} unused routines, ${xrefTotal} xref rows`);
}
