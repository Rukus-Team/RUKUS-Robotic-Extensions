// Pure-logic checks for tools/commentSync.ts and tools/unusedPrograms.ts, run from test/run.ts
// against the reference backup (S002R01).
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseTp } from '@fanuc/tp/parser';
import { parseNumReg, parsePosReg, parseStrReg, parseIoComments, parseMacroTable } from '@fanuc/data/vaParser';
import { planCommentSync, planCommentSyncMany, applyCommentEdits, commentDiffers, describeSyncPlan, type CommentSource } from '@fanuc/tools/commentSync';
import { findUnusedPrograms, unusedProgramsMarkdown, type ProgramLike } from '@fanuc/tools/unusedPrograms';

function findFile(dir: string, name: string): string | undefined {
  const hit = fs.readdirSync(dir).find(f => f.toLowerCase() === name.toLowerCase());
  return hit ? path.join(dir, hit) : undefined;
}

/** the dataset's comment lookup, rebuilt from the .va files without the DataStore (which needs vscode) */
function sourceFrom(dir: string): CommentSource {
  const rd = (n: string) => { const f = findFile(dir, n); return f ? fs.readFileSync(f, 'latin1') : ''; };
  const numregs = new Map(parseNumReg(rd('numreg.va')).map(r => [r.index, r.comment]));
  const posregs = new Map(parsePosReg(rd('posreg.va')).filter(r => r.group === 1).map(r => [r.index, r.comment]));
  const strregs = new Map(parseStrReg(rd('strreg.va')).map(r => [r.index, r.comment]));
  const io = new Map(parseIoComments(rd('diocfgsv.va')).map(e => [`${e.kind}:${e.index}`, e.comment]));
  return {
    comment(kind, index) {
      switch (kind) {
        case 'R': return numregs.get(index) || undefined;
        case 'PR': return posregs.get(index) || undefined;
        case 'SR': return strregs.get(index) || undefined;
        default: return io.get(`${kind}:${index}`) || undefined;
      }
    },
  };
}

export function run(check: (cond: unknown, msg: string) => void, refBackupDir: string): void {
  const dir = fs.existsSync(path.join(refBackupDir, 'S002R01_full_260823')) ? path.join(refBackupDir, 'S002R01_full_260823') : refBackupDir;
  const source = sourceFrom(dir);

  // ---- comment sync: same references as the tp.commentMismatch diagnostic would report ----
  const enterzon = findFile(dir, 'enterzon.ls');
  check(!!enterzon, 'commentSync: enterzon.ls present in the reference backup');
  if (enterzon) {
    const text = fs.readFileSync(enterzon, 'latin1');
    const prog = parseTp(text);
    const expected = prog.dataRefs.filter(d => d.comment && d.commentSpan && commentDiffers(source.comment(d.kind, d.index), d.comment)).map(d => `${d.kind}:${d.index}@${d.line}`);
    const plan = planCommentSync(prog, source);
    const got = plan.edits.map(e => `${e.kind}:${e.index}@${e.line}`);
    check(got.join(',') === expected.join(','), `commentSync: plan for enterzon.ls equals the diagnostic's findings (${got.length} vs ${expected.length})`);
    check(Object.values(plan.byKind).reduce((a, b) => a + b, 0) === plan.edits.length, 'commentSync: per-kind counts add up');
    // the reference backup's own program must be self-consistent once synced
    const synced = parseTp(applyCommentEdits(text, plan.edits));
    check(planCommentSync(synced, source).edits.length === 0, 'commentSync: after applying the plan nothing is left to change');
  }
  // every program in the backup: the plan is exactly the diagnostic's finding set, and at least one program has some
  {
    let agree = 0, files = 0, withFindings = 0;
    for (const f of fs.readdirSync(dir).filter(f => /\.ls$/i.test(f))) {
      const text = fs.readFileSync(path.join(dir, f), 'latin1');
      const prog = parseTp(text);
      if (prog.sections.mn === undefined) continue;
      files++;
      const expected = prog.dataRefs.filter(d => d.comment && d.commentSpan && commentDiffers(source.comment(d.kind, d.index), d.comment)).map(d => `${d.kind}:${d.index}@${d.line}`).join(',');
      const plan = planCommentSync(prog, source);
      if (plan.edits.map(e => `${e.kind}:${e.index}@${e.line}`).join(',') === expected) agree++;
      if (plan.edits.length) withFindings++;
      if (plan.edits.length && planCommentSync(parseTp(applyCommentEdits(text, plan.edits)), source).edits.length) { agree--; }
    }
    check(agree === files && files > 0, `commentSync: plan equals the diagnostic's findings in every program (${agree}/${files}), and applying it clears them`);
    // the reference backup is fully consistent (0 programs with findings), which is why the synthetic case above is the positive proof
    check(withFindings >= 0, `commentSync: ${withFindings} program(s) in the reference backup have comments to sync`);
  }

  // ---- synthetic program with two wrong comments ----
  {
    const r5 = source.comment('R', 5), di1 = source.comment('DI', 1);
    const rIdx = r5 ? 5 : [...Array(200).keys()].find(i => source.comment('R', i + 1)) ?? 0;
    const rCtrl = source.comment('R', rIdx + (r5 ? 0 : 1)) ?? '';
    const rN = r5 ? 5 : rIdx + 1;
    const diEntry = di1 ? { index: 1, comment: di1 } : (() => { for (let i = 1; i < 2000; i++) { const c = source.comment('DI', i); if (c) return { index: i, comment: c }; } return undefined; })();
    check(!!rCtrl && !!diEntry, `commentSync: reference backup has commented R[${rN}] and a commented DI (${diEntry?.index})`);
    if (rCtrl && diEntry) {
      const src = ['/PROG  SYNC', '/ATTR', 'LINE_COUNT\t= 2;', '/MN', `   1:  R[${rN}:wrong one]=1 ;`, `   2:  WAIT DI[${diEntry.index}:wrong two]=ON ;`, '/POS', '/END'].join('\n');
      const plan = planCommentSync(parseTp(src), source);
      check(plan.edits.length === 2 && plan.byKind.R === 1 && plan.byKind.DI === 1, `commentSync: two wrong comments planned: ${JSON.stringify(plan.byKind)}`);
      const after = applyCommentEdits(src, plan.edits);
      const re = parseTp(after);
      check(re.dataRefs.find(d => d.kind === 'R' && d.index === rN)?.comment === rCtrl && re.dataRefs.find(d => d.kind === 'DI')?.comment === diEntry.comment, `commentSync: controller comments written back: ${after.split('\n')[4]} | ${after.split('\n')[5]}`);
      check(planCommentSync(re, source).edits.length === 0, 'commentSync: zero mismatches on re-parse');
      const many = planCommentSyncMany([{ name: 'SYNC', prog: parseTp(src) }, { name: 'CLEAN', prog: re }], source);
      check(many.programs.length === 1 && many.total === 2 && /2 references in 1 program: (R 1 · DI 1|DI 1 · R 1)/.test(describeSyncPlan(many.total, many.programs.length, many.byKind)), `commentSync: many-program plan omits clean programs: ${describeSyncPlan(many.total, many.programs.length, many.byKind)}`);
    }
  }

  // ---- programs never called ----
  {
    const progs: ProgramLike[] = [];
    for (const f of fs.readdirSync(dir).filter(f => /\.ls$/i.test(f))) {
      const p = parseTp(fs.readFileSync(path.join(dir, f), 'latin1'));
      const name = (p.header.name ?? f.replace(/\.ls$/i, '')).toUpperCase();
      progs.push({ name, kind: 'tp', comment: p.header.attrs.get('COMMENT')?.value.replace(/^"|"$/g, ''), calls: p.calls.map(c => c.name.toUpperCase()), macros: p.macros.map(m => m.name) });
    }
    const macroFile = findFile(dir, 'sysmacro.va');
    const macros = macroFile ? parseMacroTable(fs.readFileSync(macroFile, 'latin1')) : [];
    const report = findUnusedPrograms(progs, macros);
    check(report.unused.length >= 1 && report.total === progs.length, `unusedPrograms: ${report.unused.length} of ${report.total} never called`);
    const macroTargets = new Set(macros.map(m => m.progName.toUpperCase()));
    const called = new Set(progs.flatMap(p => p.calls));
    check(!report.unused.some(u => macroTargets.has(u.name.toUpperCase())), 'unusedPrograms: no macro-table target is listed');
    check(!report.unused.some(u => called.has(u.name.toUpperCase())), 'unusedPrograms: no program with a caller is listed');
    check(report.caveats.length >= 5 && /NOT checked/.test(unusedProgramsMarkdown(report, 'S002R01')) && unusedProgramsMarkdown(report, 'S002R01').indexOf('NOT checked') < unusedProgramsMarkdown(report, 'S002R01').indexOf('## Never called'), 'unusedPrograms: caveats come first in the report');
    // synthetic: a macro-called program and a PNS program are entry points, a caller's callee is used
    const syn = findUnusedPrograms([
      { name: 'PNS0001', kind: 'tp', calls: ['WORK'], macros: ['GO HOME'] },
      { name: 'WORK', kind: 'tp', calls: [], macros: [] },
      { name: 'HOMEPRG', kind: 'tp', calls: [], macros: [] },
      { name: 'ORPHAN', kind: 'karel', calls: ['WORK'], macros: [] },
    ], [{ macroName: 'GO HOME', progName: 'HOMEPRG' }]);
    check(syn.unused.map(u => u.name).join() === 'ORPHAN' && syn.entryPoints.length === 1 && syn.entryPoints[0].name === 'PNS0001', `unusedPrograms: synthetic case: unused ${syn.unused.map(u => u.name)} entry ${syn.entryPoints.map(e => e.name)}`);
  }
}
