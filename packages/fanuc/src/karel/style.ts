/**
 * KAREL house rules (`karel.style.*`) and the catalog of every KAREL rule. ktrans and the
 * robot accept the program either way; these are what a reviewer would ask about.
 */
import { stripCommentAndStrings, KAREL_KEYWORDS, type KProgram } from './parser';
import { LINT_CODES } from './lint';
import { defineLintRules, lineSpan, type LintFinding, type LintRule, type LintSettings } from '@core/lint/types';

const L = 'fanuc-karel';
const check = (code: string, defaultSeverity: LintRule['defaultSeverity'], description: string): LintRule => ({ code, language: L, kind: 'check', defaultSeverity, description });
const style = (code: string, defaultSeverity: LintRule['defaultSeverity'], description: string, options?: LintRule['options']): LintRule => ({ code, language: L, kind: 'style', defaultSeverity, description, options });

export const KAREL_STYLE = {
  programComment: 'karel.style.programComment',
  todo: 'karel.style.todo',
  routineLength: 'karel.style.routineLength',
  lineLength: 'karel.style.lineLength',
  keywordCase: 'karel.style.keywordCase',
} as const;

const LINT_DESCRIPTIONS: Record<keyof typeof LINT_CODES, [LintRule['defaultSeverity'], string]> = {
  cStyle: ['error', 'C-style syntax that is not KAREL'],
  declAfterBegin: ['error', 'a declaration after BEGIN'],
  directivePlacement: ['error', 'a directive inside a body or after the declarations'],
  commentLength: ['warning', '%COMMENT longer than the controller keeps'],
  stringLength: ['error', 'a string literal or STRING[n] longer than KAREL holds'],
  integerRange: ['error', 'an INTEGER literal out of range'],
  reservedName: ['error', 'a reserved word used as a name'],
  duplicate: ['error', 'a name declared twice'],
  assignConst: ['error', 'an assignment to a constant'],
  argCount: ['error', 'a routine called with the wrong number of arguments'],
  returnValue: ['error', 'RETURN without a value in a function, or with one in a procedure'],
  lockGroup: ['error', 'MOVE with %NOLOCKGROUP, or %NOLOCKGROUP missing from a program that does not move'],
  noBegin: ['error', 'a program or routine with no BEGIN'],
  elseif: ['error', 'ELSEIF, which KAREL does not have'],
};

defineLintRules([
  check('karel.unbalanced', 'error', 'blocks not closed or closed by the wrong word'),
  check('karel.endName', 'error', 'END name does not match the PROGRAM or ROUTINE'),
  check('karel.compiledFile', 'info', 'a compiled .pc saved under a .kl name'),
  check('karel.identLength', 'warning', 'a name longer than the core version allows'),
  check('karel.unused', 'hint', 'a variable, constant or routine nothing uses'),
  check('karel.undeclared', 'warning', 'a name used but never declared (ktrans does not catch this)'),
  check('karel.environment', 'warning', 'a built-in whose %ENVIRONMENT group is not in the header'),
  check('karel.fileName', 'warning', 'the program name differs from the file name'),
  check('karel.includeMissing', 'error', 'an %INCLUDE file that is not there (Check Before Compile)'),
  ...Object.entries(LINT_CODES).map(([k, code]) => check(code, LINT_DESCRIPTIONS[k as keyof typeof LINT_CODES][0], LINT_DESCRIPTIONS[k as keyof typeof LINT_CODES][1])),
  style(KAREL_STYLE.programComment, 'hint', 'the program has no %COMMENT'),
  style(KAREL_STYLE.todo, 'hint', 'TODO / FIXME / XXX left in a comment'),
  style(KAREL_STYLE.routineLength, 'off', 'a routine or main body longer than max lines', { max: 200 }),
  style(KAREL_STYLE.lineLength, 'off', 'a line longer than max characters', { max: 120 }),
  style(KAREL_STYLE.keywordCase, 'off', 'a keyword not written in upper case'),
]);

export function karelStyleChecks(prog: KProgram, settings: LintSettings): LintFinding[] {
  const out: LintFinding[] = [];
  const on = (code: string) => settings.enabled(code);
  const lines = prog.lines;

  if (on(KAREL_STYLE.programComment) && prog.name && prog.nameSpan && !prog.directives.some(d => d.name === 'COMMENT')) {
    out.push({ code: KAREL_STYLE.programComment, severity: 'hint', span: prog.nameSpan, message: `${prog.name} has no %COMMENT. The pendant's program list shows it next to the name - say what the program does.` });
  }

  if (on(KAREL_STYLE.routineLength)) {
    const max = settings.option(KAREL_STYLE.routineLength, 'max', 200);
    for (const r of prog.routines) {
      if (r.from || r.endLine === undefined) continue;
      const n = r.endLine - r.line + 1;
      if (n > max) out.push({ code: KAREL_STYLE.routineLength, severity: 'hint', span: r.span, message: `ROUTINE ${r.name} is ${n} lines (limit ${max}). Split it.` });
    }
    if (prog.mainBegin !== undefined && prog.mainEnd !== undefined && prog.mainEnd - prog.mainBegin + 1 > max && prog.name) {
      out.push({ code: KAREL_STYLE.routineLength, severity: 'hint', span: lineSpan(lines, prog.mainBegin), message: `The main body of ${prog.name} is ${prog.mainEnd - prog.mainBegin + 1} lines (limit ${max}). Move parts into routines.` });
    }
  }

  const maxLine = settings.option(KAREL_STYLE.lineLength, 'max', 120);
  const caseOn = on(KAREL_STYLE.keywordCase);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (on(KAREL_STYLE.todo)) {
      const c = raw.indexOf('--');
      const m = c >= 0 ? /\b(TODO|FIXME|XXX)\b/i.exec(raw.slice(c)) : null;
      if (m) out.push({ code: KAREL_STYLE.todo, severity: 'hint', span: { line: i, col: c + m.index, len: m[0].length }, message: `${m[1].toUpperCase()} left in the program.` });
    }
    if (on(KAREL_STYLE.lineLength) && raw.length > maxLine) out.push({ code: KAREL_STYLE.lineLength, severity: 'hint', span: { line: i, col: maxLine, len: raw.length - maxLine }, message: `Line is ${raw.length} characters (limit ${maxLine}).` });
    if (caseOn) {
      const clean = stripCommentAndStrings(raw);
      for (const m of clean.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
        const w = m[0];
        if (w !== w.toUpperCase() && KAREL_KEYWORDS.has(w.toUpperCase())) {
          out.push({ code: KAREL_STYLE.keywordCase, severity: 'hint', span: { line: i, col: m.index!, len: w.length }, message: `Keyword "${w}" is written ${w.toUpperCase()} in KAREL by convention.` });
        }
      }
    }
  }
  return out;
}
