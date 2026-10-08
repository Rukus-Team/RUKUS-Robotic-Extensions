/**
 * RAPID house rules (`rapid.style.*`) and the catalog of every RAPID rule. The controller
 * loads and runs the module either way; these are what a reviewer would ask about. Pure.
 */
import type { RapidModule } from './parser';
import { RAPID_RESERVED } from './lexer';
import { defineLintRules, type LintFinding, type LintRule, type LintSettings } from '@core/lint/types';

const L = 'abb-rapid';
const check = (code: string, defaultSeverity: LintRule['defaultSeverity'], description: string): LintRule => ({ code, language: L, kind: 'check', defaultSeverity, description });
const style = (code: string, defaultSeverity: LintRule['defaultSeverity'], description: string, options?: LintRule['options']): LintRule => ({ code, language: L, kind: 'style', defaultSeverity, description, options });

export const RAPID_STYLE = {
  todo: 'rapid.style.todo',
  waitTimeout: 'rapid.style.waitTimeout',
  breakInstruction: 'rapid.style.breakInstruction',
  unusedLocalData: 'rapid.style.unusedLocalData',
  routineLength: 'rapid.style.routineLength',
  lineLength: 'rapid.style.lineLength',
  inlineTarget: 'rapid.style.inlineTarget',
  dataNaming: 'rapid.style.dataNaming',
  keywordCase: 'rapid.style.keywordCase',
} as const;

export const DEFAULT_DATA_PREFIXES: Record<string, string> = { robtarget: 'p', jointtarget: 'j', tooldata: 't', wobjdata: 'wobj', speeddata: 'v', zonedata: 'z' };

defineLintRules([
  check('rapid.unclosedBlock', 'error', 'IF/FOR/WHILE/TEST/PROC/... with no END word'),
  check('rapid.unmatchedEnd', 'error', 'an END word with nothing open to close'),
  check('rapid.misplaced', 'error', 'ELSE outside IF, CASE outside TEST, a handler inside a block'),
  check('rapid.duplicateName', 'error', 'two routines/data/records with one name in a module, or a local that repeats a parameter'),
  check('rapid.undefinedLabel', 'error', 'GOTO to a label the routine does not have'),
  check('rapid.unknownRoutine', 'warning', 'a call to a routine the task does not declare and RAPID does not have'),
  check('rapid.unusedLocalRoutine', 'hint', 'a LOCAL routine nothing in its module names'),
  check('rapid.missingSemicolon', 'warning', 'a statement without its ";"'),
  check('rapid.syntax', 'warning', 'a statement the parser could not read'),
  check('rapid.badDeclaration', 'warning', 'a declaration the parser could not read'),
  style(RAPID_STYLE.todo, 'hint', 'TODO / FIXME / XXX left in a comment'),
  style(RAPID_STYLE.waitTimeout, 'hint', 'WaitDI/WaitDO/WaitUntil/... with no \\MaxTime waits forever if the condition never comes'),
  style(RAPID_STYLE.breakInstruction, 'info', 'a BREAK (debug stop) left in the program'),
  style(RAPID_STYLE.unusedLocalData, 'hint', 'LOCAL module data nothing in its module uses'),
  style(RAPID_STYLE.routineLength, 'off', 'a routine longer than max lines', { max: 200 }),
  style(RAPID_STYLE.lineLength, 'off', 'a line longer than max characters', { max: 120 }),
  style(RAPID_STYLE.inlineTarget, 'off', 'a move to an inline target (*) instead of a named robtarget'),
  style(RAPID_STYLE.dataNaming, 'off', 'data whose name does not start with its type\'s prefix (options: type -> prefix)', { ...DEFAULT_DATA_PREFIXES }),
  style(RAPID_STYLE.keywordCase, 'off', 'a RAPID keyword not written in upper case'),
]);

const WAITS = /^\s*(WaitDI|WaitDO|WaitAI|WaitAO|WaitGI|WaitGO|WaitUntil)\b/i;
const U = (s: string) => s.toUpperCase();

/** the line with comments and string contents blanked, columns kept */
function code(line: string): string {
  let out = '', inStr = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inStr) { out += c === '"' ? '"' : ' '; if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === '!') return out + ' '.repeat(line.length - i);
    out += c;
  }
  return out;
}

export function rapidStyleChecks(mod: RapidModule, settings: LintSettings): LintFinding[] {
  const out: LintFinding[] = [];
  if (mod.encrypted) return out;
  const on = (c: string) => settings.enabled(c);
  const lines = mod.lines;

  if (on(RAPID_STYLE.todo)) {
    for (const c of mod.comments) {
      const m = /\b(TODO|FIXME|XXX)\b/i.exec(c.text);
      if (m) out.push({ code: RAPID_STYLE.todo, severity: 'hint', span: { line: c.span.line, col: c.span.col + 1 + m.index, len: m[0].length }, message: `${m[1].toUpperCase()} left in the module.` });
    }
  }

  if (on(RAPID_STYLE.breakInstruction)) {
    for (const c of mod.calls) if (c.kind === 'proc' && c.name && U(c.name) === 'BREAK') out.push({ code: RAPID_STYLE.breakInstruction, severity: 'info', span: c.span, message: 'BREAK stops the program for debugging. Remove it before production.' });
  }

  if (on(RAPID_STYLE.waitTimeout)) {
    for (let i = 0; i < lines.length; i++) {
      const m = WAITS.exec(code(lines[i]));
      if (!m) continue;
      // the statement runs to its ';', which may be lines further down
      let stmt = '';
      for (let j = i; j < lines.length && j < i + 10; j++) { stmt += code(lines[j]); if (stmt.includes(';')) break; }
      if (/\\\s*MaxTime\b/i.test(stmt)) continue;
      const col = m[0].length - m[1].length;
      out.push({ code: RAPID_STYLE.waitTimeout, severity: 'hint', span: { line: i, col, len: m[1].length }, message: `${m[1]} with no \\MaxTime: if the condition never comes, the task waits here forever with no error. Add \\MaxTime (and \\TimeFlag or an ERROR handler for ERR_WAIT_MAXTIME).` });
    }
  }

  if (on(RAPID_STYLE.unusedLocalData)) {
    const used = new Set(mod.refs.map(r => U(r.name)));
    const strings = mod.strings.map(s => U(s.text));
    for (const d of mod.data) {
      if (d.routine || d.scope !== 'LOCAL') continue;
      const k = U(d.name);
      if (used.has(k) || strings.some(s => s.includes(k))) continue;
      out.push({ code: RAPID_STYLE.unusedLocalData, severity: 'hint', span: d.nameSpan, unnecessary: true, message: `LOCAL ${d.storage} ${d.name} is never used in this module.` });
    }
  }

  if (on(RAPID_STYLE.routineLength)) {
    const max = settings.option(RAPID_STYLE.routineLength, 'max', 200);
    for (const r of mod.routines) {
      if (r.endLine === undefined) continue;
      const n = r.endLine - r.startLine + 1;
      if (n > max) out.push({ code: RAPID_STYLE.routineLength, severity: 'hint', span: r.nameSpan, message: `${r.kind} ${r.name} is ${n} lines (limit ${max}). Split it.` });
    }
  }

  if (on(RAPID_STYLE.inlineTarget)) {
    for (const mv of mod.moves) {
      const t = mv.target?.text.trim();
      if (t === '*' || t?.startsWith('[')) out.push({ code: RAPID_STYLE.inlineTarget, severity: 'hint', span: mv.target!.span, message: `${mv.instruction} to an inline target. A named robtarget can be found, touched up and reused.` });
    }
  }

  if (on(RAPID_STYLE.dataNaming)) {
    // options are type -> prefix: ["hint", { "robtarget": "p", "tooldata": "tool" }]
    const map: Record<string, string> = {};
    for (const t of Object.keys(DEFAULT_DATA_PREFIXES)) map[t] = settings.option(RAPID_STYLE.dataNaming, t, DEFAULT_DATA_PREFIXES[t]);
    for (const d of [...mod.data, ...mod.routines.flatMap(r => r.data)]) {
      const p = map[d.type.toLowerCase()];
      if (!p || d.name.toLowerCase().startsWith(p.toLowerCase())) continue;
      out.push({ code: RAPID_STYLE.dataNaming, severity: 'hint', span: d.nameSpan, message: `${d.type} ${d.name} does not start with "${p}".` });
    }
  }

  const maxLine = settings.option(RAPID_STYLE.lineLength, 'max', 120);
  const caseOn = on(RAPID_STYLE.keywordCase);
  for (let i = 0; i < lines.length; i++) {
    if (on(RAPID_STYLE.lineLength) && lines[i].length > maxLine) out.push({ code: RAPID_STYLE.lineLength, severity: 'hint', span: { line: i, col: maxLine, len: lines[i].length - maxLine }, message: `Line is ${lines[i].length} characters (limit ${maxLine}).` });
    if (caseOn) {
      for (const m of code(lines[i]).matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
        const w = m[0];
        if (w !== U(w) && RAPID_RESERVED.has(U(w))) out.push({ code: RAPID_STYLE.keywordCase, severity: 'hint', span: { line: i, col: m.index!, len: w.length }, message: `Keyword "${w}" is written ${U(w)} in RAPID by convention.` });
      }
    }
  }
  return out;
}
