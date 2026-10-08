/**
 * The TP program checks, without vscode: the editor (diagnostics.ts), the Lint Folder
 * command and robot-lint all run this. What only the editor knows - the robot's other
 * programs, its .va data, settings - comes in through TpCheckEnv; a check whose input is
 * missing simply does not run.
 */
import { type TpProgram } from './parser';
import { integerAxisValues } from './teach';
import { COMMENT_WIDTH, commentOverrun } from './headers';
import { extCommentColumns, EXT_COMMENT_WIDTH } from './extendedComment';
import { FANUC_PROGRAMS, CATALOG_MACROS } from './syntaxCatalog';
import { tpStyleChecks } from './style';
import { DEFAULT_SETTINGS, lineSpan, type LintFinding, type LintRelated, type LintSettings, type LintSeverity } from '@core/lint/types';
import type { Span } from '@core/span';

const CATALOG_MACRO_SET = new Set(CATALOG_MACROS);

export const CODES = {
  dupLabel: 'tp.duplicateLabel',
  undefLabel: 'tp.undefinedLabel',
  unusedLabel: 'tp.unusedLabel',
  undefPos: 'tp.undefinedPosition',
  unusedPos: 'tp.unusedPosition',
  lineSeq: 'tp.lineSequence',
  lineCount: 'tp.lineCount',
  terminator: 'tp.missingTerminator',
  missingProg: 'tp.missingProgram',
  missingMacro: 'tp.unknownMacro',
  commentMismatch: 'tp.commentMismatch',
  commentInconsistent: 'tp.commentInconsistent',
  block: 'tp.block',
  speed: 'tp.speed',
  header: 'tp.header',
  nearDupPos: 'tp.duplicatePosition',
  cntBeforeOp: 'tp.cntBeforeOperation',
  xref: 'tp.crossReference',
  bracketShape: 'tp.bracketShape',
  payload: 'tp.payload',
  untaughtPos: 'tp.untaughtPosition',
  commentLength: 'tp.commentLength',
  extCommentWidth: 'tp.extendedCommentWidth',
  integerAxis: 'tp.integerAxisValue',
  doubleTerminator: 'tp.doubleTerminator',
} as const;

/** The robot's .va data, as far as the checks need it (the editor's Dataset fits). */
export interface TpDataset {
  label: string;
  macros: { size: number };
  macro(name: string): { progName: string } | undefined;
  payloads: ReadonlyMap<number, { initialized: boolean; mass: number }>;
  comment(kind: string, index: number): string | undefined;
}

export interface TpCheckEnv {
  /** rule switches from .robotlint.json */
  settings?: LintSettings;
  /** robotCode.tp.diagnostics.<key> in the editor; the default everywhere else */
  setting?<T>(key: string, fallback: T): T;
  /** the editor renumbers lines itself: line-number and terminator findings would only flicker */
  autoRenumber?: boolean;
  extCommentWidth?: number;
  /** cross-reference notes keyed `KIND:index` (needs every program of the robot) */
  xref?: { findings: Map<string, string[]>; self?: string };
  /** CALL targets. Undefined = cannot tell, so nothing is said. */
  calls?: {
    resolve(name: string): 'found' | 'missing' | 'elsewhere';
    /** the robot whose device listing decides "missing", for the message */
    robot?: string;
  };
  dataset?: TpDataset;
}

/**
 * Does this line do something that has to happen AT the point the robot just moved to?
 *
 * Deliberately a configurable list rather than a clever guess: what counts as "work" is
 * plant-specific (a weld here is a `CALL SPOT`, a dispense there is a `DO[120]`), and a
 * rule that cries wolf on every `DO` would be switched off within a day. The defaults are
 * the shapes that are nearly always real: a TP application instruction, a pulse, or a
 * hand/tool signal.
 */
function operationAt(body: string, extra: string[]): string | undefined {
  for (const pat of extra) {
    try { if (new RegExp(pat, 'i').test(body)) return `matches "${pat}"`; } catch { /* a bad pattern in settings is the user's to fix, not a crash */ }
  }
  if (/^(Weld Start|Spot|Arc Start|Dispense|Seal|Paint)\b/i.test(body)) return 'starts a process';
  if (/=\s*PULSE\b/i.test(body)) return 'pulses an output';
  if (/^(RO|SO)\[/.test(body)) return 'drives a hand/tool signal';
  if (/^(OPEN|CLOSE)\s+HAND\b/i.test(body)) return 'operates the hand';
  return undefined;
}

export function tpChecks(text: string, prog: TpProgram, env: TpCheckEnv = {}): LintFinding[] {
  if (!/^\/PROG\b/m.test(text) && !/^\/MN\b/m.test(text)) return []; // not a program (alarm log etc.)
  const settings = env.settings ?? DEFAULT_SETTINGS;
  const setting = <T>(key: string, fallback: T): T => (env.setting ? env.setting(key, fallback) : fallback);
  const lines = text.split(/\r?\n/);
  const out: LintFinding[] = [];
  const add = (span: Span, message: string, severity: LintSeverity, code: string, extra?: { unnecessary?: boolean; related?: LintRelated[]; data?: unknown }) => {
    if (!settings.enabled(code)) return;
    out.push({ code, message, severity, span, ...extra });
  };
  const lineRange = (line: number) => lineSpan(lines, line);
  const range = (line: number, from: number, to: number): Span => ({ line, col: from, len: Math.max(0, to - from) });
  const autoRenumber = !!env.autoRenumber;

  // ---- header ----
  if (!prog.header.name) add(lineRange(0), 'Missing "/PROG <name>" header line.', 'warning', CODES.header);
  if (prog.sections.mn === undefined) { add(lineRange(0), 'Missing "/MN" section.', 'error', CODES.header); return out; }
  if (prog.sections.end === undefined) add(lineRange(lines.length - 1), 'Missing "/END" marker.', 'warning', CODES.header);

  // ---- labels ----
  const labelsByNum = new Map<number, typeof prog.labels>();
  for (const l of prog.labels) { const arr = labelsByNum.get(l.num) ?? []; arr.push(l); labelsByNum.set(l.num, arr); }
  for (const [num, defs] of labelsByNum) {
    if (defs.length > 1) {
      for (const d of defs.slice(1)) add(d.span, `Duplicate LBL[${num}]; first defined on line ${defs[0].line + 1}.`, 'error', CODES.dupLabel, { related: [{ span: defs[0].span, message: 'First definition' }] });
    }
    if (setting('tp.diagnostics.unusedLabels', true) && !prog.jumps.some(j => j.num === num)) {
      add(defs[0].span, `LBL[${num}] is never jumped to.`, 'hint', CODES.unusedLabel, { unnecessary: true });
    }
  }
  for (const j of prog.jumps) {
    if (!labelsByNum.has(j.num)) add(j.span, `LBL[${j.num}] is not defined in this program.`, 'error', CODES.undefLabel);
  }

  // ---- positions ----
  const posDefined = new Set(prog.positions.map(p => p.index));
  const posUsed = new Set(prog.posRefs.map(r => r.index));
  const untaught = new Set(prog.positions.filter(p => p.groups.length && p.groups.every(g => g.untaught)).map(p => p.index));
  for (const r of prog.posRefs) {
    if (!posDefined.has(r.index)) add(r.span, `P[${r.index}] has no data in /POS (motion will fault with "position not taught").`, 'error', CODES.undefPos);
    else if (untaught.has(r.index)) add(r.span, `P[${r.index}] is not taught — its block holds no position (UF/UT "F", values "********"). The controller faults when this line runs. Teach it from the robot or a PR.`, 'warning', CODES.untaughtPos);
  }
  if (setting('tp.diagnostics.unusedPositions', true)) {
    for (const p of prog.positions) if (!posUsed.has(p.index)) add(p.span, `P[${p.index}] is taught but no instruction uses it.`, 'hint', CODES.unusedPos, { unnecessary: true });
  }
  // "J1= 0 deg": typed by hand, never written by the controller, which writes 0.000.
  for (const v of integerAxisValues(text)) {
    add(range(v.line, v.col, v.col + v.len), `${v.axis} is written as the integer ${v.token}; the controller writes position values as floats (${v.token}.000). Format Document lays the /POS section out the controller's way.`, 'warning', CODES.integerAxis);
  }
  const dupPos = new Map<number, number>();
  for (const p of prog.positions) { if (dupPos.has(p.index)) add(p.span, `Duplicate position data for P[${p.index}].`, 'error', CODES.undefPos); else dupPos.set(p.index, p.line); }

  // Two points at effectively the same place. This is how a program silts up: a point gets
  // touched up, a copy gets left behind, and years later nobody dares delete either. Only
  // points in the SAME user frame are compared - across frames the numbers are not distances.
  const nearTol = setting('tp.diagnostics.duplicatePositionTolerance', 0.5);
  if (nearTol > 0 && settings.enabled(CODES.nearDupPos)) {
    const cart = prog.positions
      .map(p => ({ p, g: p.groups[0] }))
      .filter(x => x.g?.kind === 'cartesian' && ['X', 'Y', 'Z'].every(k => x.g!.values[k]));
    for (let i = 0; i < cart.length; i++) {
      for (let j = i + 1; j < cart.length; j++) {
        const a = cart[i], b = cart[j];
        if (a.g!.uf !== b.g!.uf) continue;
        const d = Math.hypot(...['X', 'Y', 'Z'].map(k => a.g!.values[k].value - b.g!.values[k].value));
        if (d > nearTol) continue;
        const rot = Math.max(...['W', 'P', 'R'].map(k => Math.abs((a.g!.values[k]?.value ?? 0) - (b.g!.values[k]?.value ?? 0))));
        add(b.p.span,
          `P[${b.p.index}] is ${d < 0.001 ? 'at the same place as' : `${d.toFixed(3)} mm from`} P[${a.p.index}]${rot > 0.5 ? ` (orientation differs by up to ${rot.toFixed(1)}°)` : ''}. One of them is probably left over.`,
          'hint', CODES.nearDupPos, { related: [{ span: a.p.span, message: `P[${a.p.index}] is here` }] });
        break;   // one report per position is enough; a cluster of five should not produce ten
      }
    }
  }

  // ---- line numbers / terminators / blocks / speeds ----
  let expected = 1;
  const blockStack: Array<{ kind: 'IF' | 'FOR'; line: number }> = [];
  const mnLines = prog.lines.filter(l => l.line > prog.sections.mn! && (prog.sections.pos === undefined || l.line < prog.sections.pos) && l.kind !== 'section');
  const commentLimit = setting('tp.diagnostics.commentLength', COMMENT_WIDTH);
  const extWidth = env.extCommentWidth ?? EXT_COMMENT_WIDTH;
  const fineExtra = setting<string[]>('tp.diagnostics.fineRequiredPatterns', []);
  for (let idx = 0; idx < mnLines.length; idx++) {
    const l = mnLines[idx];
    if (l.kind === 'empty' || l.kind === 'pos') continue;
    // A comment line holds 32 characters (the longest of 26,000 in real backups is exactly
    // 32). Only the part that does not fit is underlined, so it reads as "cut here".
    if (l.kind === 'comment' && !l.ext) {
      const over = commentOverrun(l.body, commentLimit);
      const start = over ? l.raw.indexOf(l.body, l.bodyCol) : -1;
      if (over && start >= 0) add(range(l.line, start + over.from, start + over.to), `Comment is ${over.to - 1} characters; a comment line holds ${commentLimit}. The controller will not take the rest - shorten it, split it, or make it an extended comment (--eg:).`, 'warning', CODES.commentLength);
    }
    // An extended comment line wider than the pendant writes (78 columns, measured). The
    // controller loads it, but the pendant will show it re-wrapped; the renumber does the
    // same wrap here, so the file reads the way the pendant will show it.
    if (l.kind === 'comment' && l.ext && extWidth > 0) {
      const cols = extCommentColumns(l.raw);
      if (cols > extWidth) add(range(l.line, extWidth, cols), `Extended comment line is ${cols} columns; the pendant writes them ${extWidth} wide and wraps between words. ${autoRenumber ? 'It is re-wrapped when the caret leaves it' : 'Run "FANUC TP: Renumber Lines" to re-wrap it'} (robotCode.tp.extendedCommentWidth).`, 'warning', CODES.extCommentWidth);
    }
    // A line with no number is a program line like any other (the scaffold/numberless style,
    // or a line just typed), not a different kind: only an instruction missing its number is
    // worth a warning, and the expected count advances for every line the controller numbers.
    if (l.kind !== 'continuation') {
      if (l.num === undefined) {
        if (!autoRenumber && (l.kind === 'instruction' || l.kind === 'motion')) add(lineRange(l.line), 'Instruction has no line number. Run "FANUC TP: Renumber Lines".', 'warning', CODES.lineSeq);
      } else if (l.num !== expected && !autoRenumber) {
        add(range(l.line, 0, l.bodyCol), `Line number ${l.num} out of sequence (expected ${expected}).`, 'warning', CODES.lineSeq);
      }
      expected++;
    }
    // terminator
    const raw = l.raw;
    if (!/;\s*$/.test(raw) && l.kind !== 'blank') {
      const next = mnLines[idx + 1];
      const isCircFirst = /^[CA]\s/.test(l.body) && next?.kind === 'continuation';
      // an extended comment ends with one ` ;`, on its last line - but only a `:` continuation
      // is its next line; a second numbered `--eg` line is a new comment and the first one is unterminated
      const extMiddle = l.ext && next?.ext && next.seq === undefined;
      if (!isCircFirst && !extMiddle && !autoRenumber) add(lineRange(l.line), 'Missing " ;" terminator.', 'warning', CODES.terminator);
    }
    // ` ; ;` at the end: the controller refuses to load the program (ASBN-031 Expecting ':', checked on
    // V9.40). Not in a comment or remark, whose text may end in a semicolon of its own.
    const dbl = /;(\s*;)+\s*$/.exec(raw);
    if (dbl && l.kind !== 'comment' && l.kind !== 'remark' && !l.ext) {
      const at = raw.length - dbl[0].length;
      add(range(l.line, at, raw.length), 'More than one ";" at the end of the line - the controller will not load the program (ASBN-031).', 'error', CODES.doubleTerminator);
    }
    if (l.kind === 'instruction') {
      if (/^IF\b.*\bTHEN\s*$/.test(l.body) || /^FOR\b/.test(l.body)) blockStack.push({ kind: l.body.startsWith('IF') ? 'IF' : 'FOR', line: l.line });
      else if (/^ENDIF\b/.test(l.body)) { const t = blockStack.pop(); if (!t || t.kind !== 'IF') { add(lineRange(l.line), t ? `ENDIF closes a FOR opened on line ${t.line + 1}; expected ENDFOR.` : 'ENDIF without a matching IF ... THEN.', 'error', CODES.block); if (t) blockStack.push(t); } }
      else if (/^ENDFOR\b/.test(l.body)) { const t = blockStack.pop(); if (!t || t.kind !== 'FOR') { add(lineRange(l.line), t ? `ENDFOR closes an IF opened on line ${t.line + 1}; expected ENDIF.` : 'ENDFOR without a matching FOR.', 'error', CODES.block); if (t) blockStack.push(t); } }
      else if (/^ELSE\s*$/.test(l.body)) { const t = blockStack[blockStack.length - 1]; if (!t || t.kind !== 'IF') add(lineRange(l.line), 'ELSE outside of an IF ... THEN block.', 'error', CODES.block); }
    }
    if (l.motion?.speed && /^\d/.test(l.motion.speed.value)) {
      const v = parseFloat(l.motion.speed.value);
      if (l.motion.speed.unit === '%' && (v > 100 || v <= 0)) add(l.motion.speed.span, 'Joint speed must be 1–100%.', 'error', CODES.speed);
      if (l.motion.speed.unit === 'mm/sec' && v <= 0) add(l.motion.speed.span, 'Speed must be greater than 0.', 'error', CODES.speed);
      if (l.motion.speed.unit === 'mm/sec' && v > 2000 && l.motion.type !== 'J') add(l.motion.speed.span, `Speed ${v} mm/sec is above the usual 2000 mm/sec cartesian limit; the controller clamps it unless $PARAM_GROUP.$SPEEDLIM allows more.`, 'info', CODES.speed);
    }
    if (l.motion?.termination) {
      const m = /^CNT(\d+)$/.exec(l.motion.termination.value);
      if (m && parseInt(m[1], 10) > 100) add(l.motion.termination.span, 'CNT value must be 0–100.', 'error', CODES.speed);

      // A CNT move does not stop at the point — it rounds the corner and carries on. If
      // the very next thing is an operation that has to happen AT the point (a gun fires,
      // a gripper closes, a program is called to do work there), the robot is somewhere
      // else when it happens. The rounder the corner, the further away.
      if (m && parseInt(m[1], 10) > 0 && setting('tp.diagnostics.cntBeforeOperation', true)) {
        const next = mnLines.find(x => x.line > l.line && x.kind !== 'comment' && x.kind !== 'remark' && x.kind !== 'blank' && x.kind !== 'empty' && x.kind !== 'continuation');
        const op = next && operationAt(next.body, fineExtra);
        if (op) {
          add(l.motion.termination.span,
            `${l.motion.termination.value} does not stop at the point — the robot rounds the corner — but the next line ${op}. Use FINE if it has to happen at this position.`,
            'warning', CODES.cntBeforeOp, { related: [{ span: lineRange(next!.line), message: next!.body }] });
        }
      }
    }
  }
  for (const b of blockStack) add(lineRange(b.line), `${b.kind} block is never closed (missing ${b.kind === 'IF' ? 'ENDIF' : 'ENDFOR'}).`, 'error', CODES.block);

  const lc = prog.header.attrs.get('LINE_COUNT');
  if (lc && !autoRenumber && parseInt(lc.value, 10) !== prog.numberedLineCount) add(lineRange(lc.line), `LINE_COUNT is ${lc.value} but the program has ${prog.numberedLineCount} lines.`, 'warning', CODES.lineCount);

  // ---- what the rest of the robot's programs do with these registers and I/O ----
  //
  // The cross-reference report has known this for a while; it just lived in a webview
  // nobody has open while editing. An output written from two programs, or a register
  // this program reads that nothing ever sets, is worth knowing at the line that reads it.
  // Reported once per register, at its first use, so a program that touches R[10] twenty
  // times gets one note rather than twenty.
  if (env.xref && setting('tp.diagnostics.crossReference', true)) {
    const findings = env.xref.findings;
    const reported = new Set<string>();
    const self = env.xref.self;
    for (const ref of prog.dataRefs) {
      const key = `${ref.kind}:${ref.index}`;
      if (reported.has(key)) continue;
      const msgs = findings.get(key);
      if (!msgs?.length) continue;
      reported.add(key);
      for (const msg of msgs) {
        // "written from 2 programs" is noise when this is the only one of them open and
        // the other name IS this program under a different file — cheap guard for that.
        if (self && /written from \d+ programs \(([^)]*)\)/.test(msg)) {
          const names = /\(([^)]*)\)/.exec(msg)![1].split(', ');
          if (names.length === new Set(names).size && names.every(n => n === self)) continue;
        }
        add(ref.span, `${ref.kind}[${ref.index}] is ${msg}`, 'info', CODES.xref);
      }
    }
  }

  // ---- calls / macros ----
  // A file opened off a controller is judged against that controller: a CALL target that
  // is on the robot's device is found, and "missing" is only said once the device has
  // been listed - before that the honest answer is "unknown", which is no squiggle.
  if (env.calls && setting('tp.diagnostics.missingPrograms', true)) {
    const robot = env.calls.robot;
    for (const c of prog.calls) {
      if (/^(SR|PROG|R|AR)$/.test(c.name)) continue; // indirect call
      if (FANUC_PROGRAMS[c.name.toUpperCase()]) continue;  // installed by an option on the controller, never in the workspace
      const res = env.calls.resolve(c.name);
      if (res === 'missing') add(c.span, robot ? `Program "${c.name}" is not on ${robot}'s device and not in the workspace.` : `Program "${c.name}" was not found in this robot's folder or anywhere in the workspace.`, 'info', CODES.missingProg);
      else if (res === 'elsewhere') add(c.span, `Program "${c.name}" exists in another robot's folder but not in this one.`, 'info', CODES.missingProg);
    }
    const ds = env.dataset;
    if (ds && ds.macros.size > 0) {
      for (const m of prog.macros) {
        if (CATALOG_MACRO_SET.has(m.name.toUpperCase().replace(/\s+/g, ' '))) continue;   // an option's macro (Menu Utility ...)
        const entry = ds.macro(m.name);
        if (!entry) add(m.span, `"${m.name}" is not in the controller macro table (sysmacro.va). If this is not a macro instruction, check the syntax.`, 'info', CODES.missingMacro);
        else if (env.calls.resolve(entry.progName) === 'missing') add(m.span, `Macro "${m.name}" runs ${entry.progName}, which was not found in the workspace.`, 'info', CODES.missingProg);
      }
    }
  }

  // ---- bracket arguments the parser had to guess at ----
  //
  // `GO[10:curr value:name]` and whatever the next controller version invents. The parser
  // reads the index and takes the last segment as the comment, which is right for every
  // shape seen so far - but it IS a guess, so it is said out loud, once per line, rather
  // than either failing the parse or pretending the file was ordinary.
  for (const ref of prog.dataRefs) {
    if (!ref.extra?.length) continue;
    add(ref.span,
      `${ref.kind}[${ref.index}] has ${ref.extra.length === 1 ? 'an extra segment' : `${ref.extra.length} extra segments`} inside the brackets (${ref.extra.map(x => `"${x}"`).join(', ')}) that this parser does not recognise. Read as ${ref.kind}[${ref.index}]${ref.comment ? ` with comment "${ref.comment}"` : ''}; the rest is ignored.`,
      'info', CODES.bracketShape);
  }

  // ---- payload schedules ----
  {
    const ds = env.dataset;
    if (ds?.payloads.size) {
      for (const l of prog.lines) {
        if (l.kind !== 'instruction') continue;
        const m = /^PAYLOAD\[(\d+)\]/.exec(l.body);
        if (!m) continue;
        const n = parseInt(m[1], 10);
        const p = ds.payloads.get(n);
        const at = l.bodyCol + l.raw.slice(l.bodyCol).indexOf('PAYLOAD[');
        const span = range(l.line, at, at + m[0].length);
        if (!p) add(span, `Payload schedule ${n} does not exist on this controller (${ds.payloads.size} schedules in ${ds.label}).`, 'warning', CODES.payload);
        else if (!p.initialized) add(span, `Payload schedule ${n} has never been set up on this controller - it still carries the default ${p.mass} kg and no comment.`, 'info', CODES.payload);
      }
    }
  }

  // ---- comments ----
  if (setting('tp.diagnostics.commentMismatch', true)) {
    const seen = new Map<string, { comment: string; line: number }>();
    for (const d of prog.dataRefs) {
      if (!d.comment || !d.commentSpan) continue;
      const key = `${d.kind}:${d.index}`;
      const ctrl = env.dataset?.comment(d.kind, d.index);
      if (ctrl && ctrl !== d.comment) add(d.commentSpan, `Controller comment for ${d.kind}[${d.index}] is "${ctrl}".`, 'info', CODES.commentMismatch, { data: { fixComment: ctrl } });
      const prev = seen.get(key);
      if (prev && prev.comment !== d.comment) add(d.commentSpan, `${d.kind}[${d.index}] is commented "${prev.comment}" on line ${prev.line + 1} but "${d.comment}" here.`, 'warning', CODES.commentInconsistent, { related: [{ span: lineRange(prev.line), message: 'Other comment' }] });
      else if (!prev) seen.set(key, { comment: d.comment, line: d.line });
    }
  }

  out.push(...tpStyleChecks(text, lines, prog, settings));
  return out;
}
