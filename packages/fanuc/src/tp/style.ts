/**
 * TP house rules (`tp.style.*`) and the catalog of every TP rule. The program loads and runs
 * either way; these are what a reviewer would ask about. The ones most plants agree on are on
 * as hints, the opinionated ones are off until a .robotlint.json turns them on.
 */
import type { TpProgram } from './parser';
import { defineLintRules, lineSpan, type LintFinding, type LintRule, type LintSettings } from '@core/lint/types';

const L = 'fanuc-tp';
const check = (code: string, defaultSeverity: LintRule['defaultSeverity'], description: string): LintRule => ({ code, language: L, kind: 'check', defaultSeverity, description });
const style = (code: string, defaultSeverity: LintRule['defaultSeverity'], description: string, options?: LintRule['options']): LintRule => ({ code, language: L, kind: 'style', defaultSeverity, description, options });

export const TP_STYLE = {
  programComment: 'tp.style.programComment',
  waitTimeout: 'tp.style.waitTimeout',
  todo: 'tp.style.todo',
  fixedWait: 'tp.style.fixedWait',
  uncommentedIo: 'tp.style.uncommentedIo',
  programLength: 'tp.style.programLength',
  programName: 'tp.style.programName',
  frameSelect: 'tp.style.frameSelect',
  maxSpeed: 'tp.style.maxSpeed',
} as const;

defineLintRules([
  check('tp.header', 'error', '/PROG, /MN and /END are where the controller expects them'),
  check('tp.duplicateLabel', 'error', 'a LBL[n] defined twice'),
  check('tp.undefinedLabel', 'error', 'a JMP to a label the program does not have'),
  check('tp.unusedLabel', 'hint', 'a label nothing jumps to'),
  check('tp.undefinedPosition', 'error', 'a P[n] with no data in /POS, or data given twice'),
  check('tp.untaughtPosition', 'warning', 'a P[n] whose /POS block holds no position'),
  check('tp.unusedPosition', 'hint', 'position data no instruction uses'),
  check('tp.duplicatePosition', 'hint', 'two points at (nearly) the same place in one user frame'),
  check('tp.integerAxisValue', 'warning', 'a position value written as an integer'),
  check('tp.lineSequence', 'warning', 'line numbers out of sequence or missing'),
  check('tp.lineCount', 'warning', 'LINE_COUNT does not match the program'),
  check('tp.missingTerminator', 'warning', 'a line without its " ;"'),
  check('tp.doubleTerminator', 'error', 'more than one ";" at the end of a line'),
  check('tp.block', 'error', 'IF/FOR blocks that are not closed or closed by the wrong word'),
  check('tp.speed', 'error', 'speeds and CNT values out of range'),
  check('tp.cntBeforeOperation', 'warning', 'a CNT move right before an operation that has to happen at the point'),
  check('tp.commentLength', 'warning', 'a comment line longer than the controller keeps'),
  check('tp.extendedCommentWidth', 'warning', 'an extended comment line wider than the pendant writes'),
  check('tp.crossReference', 'info', 'what the robot\'s other programs do with a register or I/O (editor only)'),
  check('tp.missingProgram', 'info', 'a CALL or macro to a program that is not there'),
  check('tp.unknownMacro', 'info', 'a macro not in the controller\'s macro table (editor only)'),
  check('tp.bracketShape', 'info', 'bracket arguments the parser had to guess at'),
  check('tp.payload', 'warning', 'PAYLOAD[n] that does not exist or was never set up (editor only)'),
  check('tp.commentMismatch', 'info', 'an inline comment that differs from the controller\'s (editor only)'),
  check('tp.commentInconsistent', 'warning', 'one register or I/O commented two ways in one program'),
  style(TP_STYLE.programComment, 'hint', 'the program has no COMMENT in /ATTR'),
  style(TP_STYLE.waitTimeout, 'hint', 'a WAIT on a condition with no TIMEOUT,LBL[...] waits forever if the signal never comes'),
  style(TP_STYLE.todo, 'hint', 'TODO / FIXME / XXX left in a comment'),
  style(TP_STYLE.fixedWait, 'off', 'a fixed time WAIT (n sec) instead of waiting for a condition', { minSeconds: 0 }),
  style(TP_STYLE.uncommentedIo, 'off', 'I/O used without a comment in brackets'),
  style(TP_STYLE.programLength, 'off', 'a program longer than max lines', { max: 500 }),
  style(TP_STYLE.programName, 'off', 'the program name does not match the plant naming pattern', { pattern: '^[A-Z][A-Z0-9_]*$' }),
  style(TP_STYLE.frameSelect, 'off', 'a program that moves the robot without selecting UFRAME_NUM and UTOOL_NUM first'),
  style(TP_STYLE.maxSpeed, 'off', 'motion faster than the plant limit', { jointPercent: 100, linearMmSec: 2000 }),
]);

const IO_KINDS = new Set(['DI', 'DO', 'RI', 'RO', 'GI', 'GO', 'AI', 'AO', 'UI', 'UO', 'SI', 'SO', 'WI', 'WO']);

export function tpStyleChecks(_text: string, lines: string[], prog: TpProgram, settings: LintSettings): LintFinding[] {
  const out: LintFinding[] = [];
  const on = (code: string) => settings.enabled(code);
  const mn = prog.lines.filter(l => prog.sections.mn !== undefined && l.line > prog.sections.mn && (prog.sections.pos === undefined || l.line < prog.sections.pos));

  if (on(TP_STYLE.programComment) && prog.sections.attr !== undefined) {
    const c = prog.header.attrs.get('COMMENT');
    if (!c || !c.value.replace(/["';\s]/g, '')) out.push({ code: TP_STYLE.programComment, severity: 'hint', span: lineSpan(lines, c?.line ?? prog.sections.prog ?? 0), message: 'The program has no COMMENT. The pendant\'s program list shows it next to the name - say what the program does.' });
  }

  if (on(TP_STYLE.programName) && prog.header.name) {
    const pattern = settings.option(TP_STYLE.programName, 'pattern', '^[A-Z][A-Z0-9_]*$');
    let re: RegExp | undefined;
    try { re = new RegExp(pattern); } catch { /* a bad pattern: the rule says nothing */ }
    if (re && !re.test(prog.header.name)) out.push({ code: TP_STYLE.programName, severity: 'hint', span: lineSpan(lines, prog.sections.prog ?? 0), message: `Program name "${prog.header.name}" does not match the naming pattern ${pattern}.` });
  }

  if (on(TP_STYLE.programLength)) {
    const max = settings.option(TP_STYLE.programLength, 'max', 500);
    if (prog.numberedLineCount > max) out.push({ code: TP_STYLE.programLength, severity: 'hint', span: lineSpan(lines, prog.sections.prog ?? 0), message: `The program has ${prog.numberedLineCount} lines (limit ${max}). Split it into called programs.` });
  }

  const ioReported = new Set<string>();
  const framesSet = { uf: false, ut: false };
  let frameReported = false;
  const maxJ = settings.option(TP_STYLE.maxSpeed, 'jointPercent', 100);
  const maxL = settings.option(TP_STYLE.maxSpeed, 'linearMmSec', 2000);
  const minFixed = settings.option(TP_STYLE.fixedWait, 'minSeconds', 0);
  for (const l of mn) {
    const body = l.body ?? '';
    if ((l.kind === 'comment' || l.kind === 'remark') && on(TP_STYLE.todo)) {
      const m = /\b(TODO|FIXME|XXX)\b/i.exec(l.raw);
      if (m) out.push({ code: TP_STYLE.todo, severity: 'hint', span: { line: l.line, col: m.index, len: m[0].length }, message: `${m[1].toUpperCase()} left in the program.` });
    }
    if (l.kind === 'instruction') {
      if (/^UFRAME_NUM\s*=/.test(body)) framesSet.uf = true;
      if (/^UTOOL_NUM\s*=/.test(body)) framesSet.ut = true;
      if (/^WAIT\b/.test(body)) {
        const timed = /^WAIT\s+(\d+(?:\.\d+)?)\s*\(sec\)/i.exec(body);
        if (timed) {
          if (on(TP_STYLE.fixedWait) && parseFloat(timed[1]) >= minFixed) out.push({ code: TP_STYLE.fixedWait, severity: 'hint', span: { line: l.line, col: l.bodyCol, len: timed[0].length }, message: `A fixed ${timed[1]} sec wait. Waiting for the condition it stands in for is faster and safer.` });
        } else if (on(TP_STYLE.waitTimeout) && /[=<>]|\b(ON|OFF)\b/.test(body) && !/\bTIMEOUT\b/i.test(body)) {
          out.push({ code: TP_STYLE.waitTimeout, severity: 'hint', span: { line: l.line, col: l.bodyCol, len: 4 }, message: 'WAIT on a condition with no TIMEOUT,LBL[...]: if the condition never comes, the robot waits here forever with no alarm. Add a timeout branch that reports it.' });
        }
      }
    }
    if (l.kind === 'motion' && l.motion) {
      if (on(TP_STYLE.frameSelect) && !frameReported && (!framesSet.uf || !framesSet.ut) && l.motion.target?.kind === 'P') {
        frameReported = true;
        const missing = [!framesSet.uf && 'UFRAME_NUM', !framesSet.ut && 'UTOOL_NUM'].filter(Boolean).join(' and ');
        out.push({ code: TP_STYLE.frameSelect, severity: 'hint', span: lineSpan(lines, l.line), message: `The first move runs before ${missing} is set in this program, so it uses whatever frame the caller left active.` });
      }
      const sp = l.motion.speed;
      if (on(TP_STYLE.maxSpeed) && sp && /^\d/.test(sp.value)) {
        const v = parseFloat(sp.value);
        if (sp.unit === '%' && v > maxJ) out.push({ code: TP_STYLE.maxSpeed, severity: 'hint', span: sp.span, message: `Joint speed ${v}% is above the plant limit of ${maxJ}%.` });
        if (sp.unit === 'mm/sec' && v > maxL) out.push({ code: TP_STYLE.maxSpeed, severity: 'hint', span: sp.span, message: `Speed ${v} mm/sec is above the plant limit of ${maxL} mm/sec.` });
      }
    }
  }

  if (on(TP_STYLE.uncommentedIo)) {
    for (const d of prog.dataRefs) {
      if (!IO_KINDS.has(d.kind) || d.comment) continue;
      const key = `${d.kind}:${d.index}`;
      if (ioReported.has(key)) continue;
      ioReported.add(key);
      out.push({ code: TP_STYLE.uncommentedIo, severity: 'hint', span: d.span, message: `${d.kind}[${d.index}] has no comment. Write what the signal is: ${d.kind}[${d.index}:comment].` });
    }
  }
  return out;
}
