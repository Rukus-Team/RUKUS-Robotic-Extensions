import * as vscode from 'vscode';
import { type TpProgram } from './parser';
import { FanucServices } from '../services';
import { spanToRange, config, debounce } from '@core/util';
import { resolveProgram, robotOf } from '@core/resolve';
import { autoRenumberMode } from './renumberSettings';
import { integerAxisValues, formatPositions } from './teach';
import { COMMENT_WIDTH, commentOverrun } from './headers';
import { extCommentColumns } from './extendedComment';
import { FANUC_PROGRAMS, CATALOG_MACROS } from './syntaxCatalog';

const CATALOG_MACRO_SET = new Set(CATALOG_MACROS);
import { extendedCommentWidth } from './renumberSettings';

export function registerTpDiagnostics(ctx: vscode.ExtensionContext, s: FanucServices) {
  const coll = vscode.languages.createDiagnosticCollection('fanuc-tp');
  ctx.subscriptions.push(coll);
  const timers = new Map<string, ReturnType<typeof debounce>>();

  const run = (doc: vscode.TextDocument) => {
    if (doc.languageId !== 'fanuc-tp') return;
    coll.set(doc.uri, computeTpDiagnostics(doc, s));
  };
  const schedule = (doc: vscode.TextDocument) => {
    if (doc.languageId !== 'fanuc-tp') return;
    const key = doc.uri.toString();
    let t = timers.get(key);
    if (!t) { t = debounce(() => run(doc), 350); timers.set(key, t); }
    t();
  };
  const runAllOpen = () => { for (const d of vscode.workspace.textDocuments) run(d); };

  ctx.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(run),
    vscode.workspace.onDidChangeTextDocument(e => schedule(e.document)),
    vscode.workspace.onDidCloseTextDocument(d => { coll.delete(d.uri); timers.delete(d.uri.toString()); }),
    vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('robotCode.tp')) runAllOpen(); }),
    s.index.onDidChange(runAllOpen),
    s.data.onDidChange(runAllOpen),
    vscode.languages.registerCodeActionsProvider({ language: 'fanuc-tp' }, new TpCodeActions(), { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }),
  );
  runAllOpen();
}

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

/**
 * Does this line do something that has to happen AT the point the robot just moved to?
 *
 * Deliberately a configurable list rather than a clever guess: what counts as "work" is
 * plant-specific (a weld here is a `CALL SPOT`, a dispense there is a `DO[120]`), and a
 * rule that cries wolf on every `DO` would be switched off within a day. The defaults are
 * the shapes that are nearly always real: a TP application instruction, a pulse, or a
 * hand/tool signal.
 */
function operationAt(body: string, doc: vscode.TextDocument): string | undefined {
  const extra = config<string[]>('tp.diagnostics.fineRequiredPatterns', [], doc);
  for (const pat of extra) {
    try { if (new RegExp(pat, 'i').test(body)) return `matches "${pat}"`; } catch { /* a bad pattern in settings is the user's to fix, not a crash */ }
  }
  if (/^(Weld Start|Spot|Arc Start|Dispense|Seal|Paint)\b/i.test(body)) return 'starts a process';
  if (/=\s*PULSE\b/i.test(body)) return 'pulses an output';
  if (/^(RO|SO)\[/.test(body)) return 'drives a hand/tool signal';
  if (/^(OPEN|CLOSE)\s+HAND\b/i.test(body)) return 'operates the hand';
  return undefined;
}

export function computeTpDiagnostics(doc: vscode.TextDocument, s: FanucServices): vscode.Diagnostic[] {
  const text = doc.getText();
  if (!/^\/PROG\b/m.test(text) && !/^\/MN\b/m.test(text)) return []; // not a program (alarm log etc.)
  const prog: TpProgram = s.tp.get(doc);
  const out: vscode.Diagnostic[] = [];
  const add = (range: vscode.Range, message: string, severity: vscode.DiagnosticSeverity, code: string, tags?: vscode.DiagnosticTag[], related?: vscode.DiagnosticRelatedInformation[]) => {
    const d = new vscode.Diagnostic(range, message, severity);
    d.code = code; d.source = 'FANUC TP';
    if (tags) d.tags = tags;
    if (related) d.relatedInformation = related;
    out.push(d);
  };
  const lineRange = (line: number) => doc.lineAt(Math.min(line, doc.lineCount - 1)).range;
  const autoRenumber = autoRenumberMode(doc) !== 'off';
  const { Error: E, Warning: W, Information: I, Hint: H } = vscode.DiagnosticSeverity;

  // ---- header ----
  if (!prog.header.name) add(lineRange(0), 'Missing "/PROG <name>" header line.', W, CODES.header);
  if (prog.sections.mn === undefined) { add(lineRange(0), 'Missing "/MN" section.', E, CODES.header); return out; }
  if (prog.sections.end === undefined) add(lineRange(doc.lineCount - 1), 'Missing "/END" marker.', W, CODES.header);

  // ---- labels ----
  const labelsByNum = new Map<number, typeof prog.labels>();
  for (const l of prog.labels) { const arr = labelsByNum.get(l.num) ?? []; arr.push(l); labelsByNum.set(l.num, arr); }
  for (const [num, defs] of labelsByNum) {
    if (defs.length > 1) {
      for (const d of defs.slice(1)) add(spanToRange(d.span), `Duplicate LBL[${num}]; first defined on line ${defs[0].line + 1}.`, E, CODES.dupLabel, undefined, [new vscode.DiagnosticRelatedInformation(new vscode.Location(doc.uri, spanToRange(defs[0].span)), 'First definition')]);
    }
    if (config<boolean>('tp.diagnostics.unusedLabels', true, doc) && !prog.jumps.some(j => j.num === num)) {
      add(spanToRange(defs[0].span), `LBL[${num}] is never jumped to.`, H, CODES.unusedLabel, [vscode.DiagnosticTag.Unnecessary]);
    }
  }
  for (const j of prog.jumps) {
    if (!labelsByNum.has(j.num)) add(spanToRange(j.span), `LBL[${j.num}] is not defined in this program.`, E, CODES.undefLabel);
  }

  // ---- positions ----
  const posDefined = new Set(prog.positions.map(p => p.index));
  const posUsed = new Set(prog.posRefs.map(r => r.index));
  const untaught = new Set(prog.positions.filter(p => p.groups.length && p.groups.every(g => g.untaught)).map(p => p.index));
  for (const r of prog.posRefs) {
    if (!posDefined.has(r.index)) add(spanToRange(r.span), `P[${r.index}] has no data in /POS (motion will fault with "position not taught").`, E, CODES.undefPos);
    else if (untaught.has(r.index)) add(spanToRange(r.span), `P[${r.index}] is not taught — its block holds no position (UF/UT "F", values "********"). The controller faults when this line runs. Teach it from the robot or a PR.`, W, CODES.untaughtPos);
  }
  if (config<boolean>('tp.diagnostics.unusedPositions', true, doc)) {
    for (const p of prog.positions) if (!posUsed.has(p.index)) add(spanToRange(p.span), `P[${p.index}] is taught but no instruction uses it.`, H, CODES.unusedPos, [vscode.DiagnosticTag.Unnecessary]);
  }
  // "J1= 0 deg": typed by hand, never written by the controller, which writes 0.000.
  for (const v of integerAxisValues(text)) {
    add(new vscode.Range(v.line, v.col, v.line, v.col + v.len), `${v.axis} is written as the integer ${v.token}; the controller writes position values as floats (${v.token}.000). Format Document lays the /POS section out the controller's way.`, W, CODES.integerAxis);
  }
  const dupPos = new Map<number, number>();
  for (const p of prog.positions) { if (dupPos.has(p.index)) add(spanToRange(p.span), `Duplicate position data for P[${p.index}].`, E, CODES.undefPos); else dupPos.set(p.index, p.line); }

  // Two points at effectively the same place. This is how a program silts up: a point gets
  // touched up, a copy gets left behind, and years later nobody dares delete either. Only
  // points in the SAME user frame are compared - across frames the numbers are not distances.
  const nearTol = config<number>('tp.diagnostics.duplicatePositionTolerance', 0.5, doc);
  if (nearTol > 0) {
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
        add(spanToRange(b.p.span),
          `P[${b.p.index}] is ${d < 0.001 ? 'at the same place as' : `${d.toFixed(3)} mm from`} P[${a.p.index}]${rot > 0.5 ? ` (orientation differs by up to ${rot.toFixed(1)}°)` : ''}. One of them is probably left over.`,
          H, CODES.nearDupPos, undefined,
          [new vscode.DiagnosticRelatedInformation(new vscode.Location(doc.uri, spanToRange(a.p.span)), `P[${a.p.index}] is here`)]);
        break;   // one report per position is enough; a cluster of five should not produce ten
      }
    }
  }

  // ---- line numbers / terminators / blocks / speeds ----
  let expected = 1;
  const blockStack: Array<{ kind: 'IF' | 'FOR'; line: number }> = [];
  const mnLines = prog.lines.filter(l => l.line > prog.sections.mn! && (prog.sections.pos === undefined || l.line < prog.sections.pos) && l.kind !== 'section');
  const commentLimit = config<number>('tp.diagnostics.commentLength', COMMENT_WIDTH, doc);
  const extWidth = extendedCommentWidth(doc);
  for (let idx = 0; idx < mnLines.length; idx++) {
    const l = mnLines[idx];
    if (l.kind === 'empty' || l.kind === 'pos') continue;
    // A comment line holds 32 characters (the longest of 26,000 in real backups is exactly
    // 32). Only the part that does not fit is underlined, so it reads as "cut here".
    if (l.kind === 'comment' && !l.ext) {
      const over = commentOverrun(l.body, commentLimit);
      const start = over ? l.raw.indexOf(l.body, l.bodyCol) : -1;
      if (over && start >= 0) add(new vscode.Range(l.line, start + over.from, l.line, start + over.to), `Comment is ${over.to - 1} characters; a comment line holds ${commentLimit}. The controller will not take the rest - shorten it, split it, or make it an extended comment (--eg:).`, W, CODES.commentLength);
    }
    // An extended comment line wider than the pendant writes (78 columns, measured). The
    // controller loads it, but the pendant will show it re-wrapped; the renumber does the
    // same wrap here, so the file reads the way the pendant will show it.
    if (l.kind === 'comment' && l.ext && extWidth > 0) {
      const cols = extCommentColumns(l.raw);
      if (cols > extWidth) add(new vscode.Range(l.line, extWidth, l.line, cols), `Extended comment line is ${cols} columns; the pendant writes them ${extWidth} wide and wraps between words. ${autoRenumber ? 'It is re-wrapped when the caret leaves it' : 'Run "FANUC TP: Renumber Lines" to re-wrap it'} (robotCode.tp.extendedCommentWidth).`, W, CODES.extCommentWidth);
    }
    // A line with no number is a program line like any other (the scaffold/numberless style,
    // or a line just typed), not a different kind: only an instruction missing its number is
    // worth a warning, and the expected count advances for every line the controller numbers.
    if (l.kind !== 'continuation') {
      if (l.num === undefined) {
        if (!autoRenumber && (l.kind === 'instruction' || l.kind === 'motion')) add(lineRange(l.line), 'Instruction has no line number. Run "FANUC TP: Renumber Lines".', W, CODES.lineSeq);
      } else if (l.num !== expected && !autoRenumber) {
        add(new vscode.Range(l.line, 0, l.line, l.bodyCol), `Line number ${l.num} out of sequence (expected ${expected}).`, W, CODES.lineSeq);
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
      if (!isCircFirst && !extMiddle && !autoRenumber) add(lineRange(l.line), 'Missing " ;" terminator.', W, CODES.terminator);
    }
    // ` ; ;` at the end: the controller refuses to load the program (ASBN-031 Expecting ':', checked on
    // V9.40). Not in a comment or remark, whose text may end in a semicolon of its own.
    const dbl = /;(\s*;)+\s*$/.exec(raw);
    if (dbl && l.kind !== 'comment' && l.kind !== 'remark' && !l.ext) {
      const at = raw.length - dbl[0].length;
      add(new vscode.Range(l.line, at, l.line, raw.length), 'More than one ";" at the end of the line - the controller will not load the program (ASBN-031).', E, CODES.doubleTerminator);
    }
    if (l.kind === 'instruction') {
      if (/^IF\b.*\bTHEN\s*$/.test(l.body) || /^FOR\b/.test(l.body)) blockStack.push({ kind: l.body.startsWith('IF') ? 'IF' : 'FOR', line: l.line });
      else if (/^ENDIF\b/.test(l.body)) { const t = blockStack.pop(); if (!t || t.kind !== 'IF') { add(lineRange(l.line), t ? `ENDIF closes a FOR opened on line ${t.line + 1}; expected ENDFOR.` : 'ENDIF without a matching IF ... THEN.', E, CODES.block); if (t) blockStack.push(t); } }
      else if (/^ENDFOR\b/.test(l.body)) { const t = blockStack.pop(); if (!t || t.kind !== 'FOR') { add(lineRange(l.line), t ? `ENDFOR closes an IF opened on line ${t.line + 1}; expected ENDIF.` : 'ENDFOR without a matching FOR.', E, CODES.block); if (t) blockStack.push(t); } }
      else if (/^ELSE\s*$/.test(l.body)) { const t = blockStack[blockStack.length - 1]; if (!t || t.kind !== 'IF') add(lineRange(l.line), 'ELSE outside of an IF ... THEN block.', E, CODES.block); }
    }
    if (l.motion?.speed && /^\d/.test(l.motion.speed.value)) {
      const v = parseFloat(l.motion.speed.value);
      if (l.motion.speed.unit === '%' && (v > 100 || v <= 0)) add(spanToRange(l.motion.speed.span), 'Joint speed must be 1–100%.', E, CODES.speed);
      if (l.motion.speed.unit === 'mm/sec' && v <= 0) add(spanToRange(l.motion.speed.span), 'Speed must be greater than 0.', E, CODES.speed);
      if (l.motion.speed.unit === 'mm/sec' && v > 2000 && l.motion.type !== 'J') add(spanToRange(l.motion.speed.span), `Speed ${v} mm/sec is above the usual 2000 mm/sec cartesian limit; the controller clamps it unless $PARAM_GROUP.$SPEEDLIM allows more.`, I, CODES.speed);
    }
    if (l.motion?.termination) {
      const m = /^CNT(\d+)$/.exec(l.motion.termination.value);
      if (m && parseInt(m[1], 10) > 100) add(spanToRange(l.motion.termination.span), 'CNT value must be 0–100.', E, CODES.speed);

      // A CNT move does not stop at the point — it rounds the corner and carries on. If
      // the very next thing is an operation that has to happen AT the point (a gun fires,
      // a gripper closes, a program is called to do work there), the robot is somewhere
      // else when it happens. The rounder the corner, the further away.
      if (m && parseInt(m[1], 10) > 0 && config<boolean>('tp.diagnostics.cntBeforeOperation', true, doc)) {
        const next = mnLines.find(x => x.line > l.line && x.kind !== 'comment' && x.kind !== 'remark' && x.kind !== 'blank' && x.kind !== 'empty' && x.kind !== 'continuation');
        const op = next && operationAt(next.body, doc);
        if (op) {
          add(spanToRange(l.motion.termination.span),
            `${l.motion.termination.value} does not stop at the point — the robot rounds the corner — but the next line ${op}. Use FINE if it has to happen at this position.`,
            W, CODES.cntBeforeOp, undefined,
            [new vscode.DiagnosticRelatedInformation(new vscode.Location(doc.uri, lineRange(next!.line)), next!.body)]);
        }
      }
    }
  }
  for (const b of blockStack) add(lineRange(b.line), `${b.kind} block is never closed (missing ${b.kind === 'IF' ? 'ENDIF' : 'ENDFOR'}).`, E, CODES.block);

  const lc = prog.header.attrs.get('LINE_COUNT');
  if (lc && !autoRenumber && parseInt(lc.value, 10) !== prog.numberedLineCount) add(lineRange(lc.line), `LINE_COUNT is ${lc.value} but the program has ${prog.numberedLineCount} lines.`, W, CODES.lineCount);

  // ---- what the rest of the robot's programs do with these registers and I/O ----
  //
  // The cross-reference report has known this for a while; it just lived in a webview
  // nobody has open while editing. An output written from two programs, or a register
  // this program reads that nothing ever sets, is worth knowing at the line that reads it.
  // Reported once per register, at its first use, so a program that touches R[10] twenty
  // times gets one note rather than twenty.
  if (config<boolean>('tp.diagnostics.crossReference', true, doc) && s.index.programCount > 1) {
    const findings = s.index.findings(doc.uri);
    const reported = new Set<string>();
    const self = s.index.forUri(doc.uri)?.name;
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
        add(spanToRange(ref.span), `${ref.kind}[${ref.index}] is ${msg}`, I, CODES.xref);
      }
    }
  }

  // ---- calls / macros ----
  // A file opened off a controller is judged against that controller: a CALL target that
  // is on the robot's device is found, and "missing" is only said once the device has
  // been listed - before that the honest answer is "unknown", which is no squiggle.
  const robot = robotOf(doc.uri);
  const listingKnown = !robot || !!s.live?.hasListing(robot);
  if (config<boolean>('tp.diagnostics.missingPrograms', true, doc) && (s.index.programCount > 0 || robot) && listingKnown) {
    for (const c of prog.calls) {
      if (/^(SR|PROG|R|AR)$/.test(c.name)) continue; // indirect call
      if (FANUC_PROGRAMS[c.name.toUpperCase()]) continue;  // installed by an option on the controller, never in the workspace
      const res = resolveProgram(s, c.name, doc.uri);
      if (!res) add(spanToRange(c.span), robot ? `Program "${c.name}" is not on ${robot}'s device and not in the workspace.` : `Program "${c.name}" was not found in this robot's folder or anywhere in the workspace.`, I, CODES.missingProg);
      else if (!robot && s.index.list(doc.uri).length && !s.index.list(doc.uri).some(p => p.name === c.name.toUpperCase())) add(spanToRange(c.span), `Program "${c.name}" exists in another robot's folder but not in this one.`, I, CODES.missingProg);
    }
    const ds = s.data.dataset(doc.uri);
    if (ds && ds.macros.size > 0) {
      for (const m of prog.macros) {
        if (CATALOG_MACRO_SET.has(m.name.toUpperCase().replace(/\s+/g, ' '))) continue;   // an option's macro (Menu Utility ...)
        const entry = ds.macro(m.name);
        if (!entry) add(spanToRange(m.span), `"${m.name}" is not in the controller macro table (sysmacro.va). If this is not a macro instruction, check the syntax.`, I, CODES.missingMacro);
        else if (!resolveProgram(s, entry.progName, doc.uri)) add(spanToRange(m.span), `Macro "${m.name}" runs ${entry.progName}, which was not found in the workspace.`, I, CODES.missingProg);
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
    add(spanToRange(ref.span),
      `${ref.kind}[${ref.index}] has ${ref.extra.length === 1 ? 'an extra segment' : `${ref.extra.length} extra segments`} inside the brackets (${ref.extra.map(x => `"${x}"`).join(', ')}) that this parser does not recognise. Read as ${ref.kind}[${ref.index}]${ref.comment ? ` with comment "${ref.comment}"` : ''}; the rest is ignored.`,
      I, CODES.bracketShape);
  }

  // ---- payload schedules ----
  {
    const ds = s.data.dataset(doc.uri);
    if (ds?.payloads.size) {
      for (const l of prog.lines) {
        if (l.kind !== 'instruction') continue;
        const m = /^PAYLOAD\[(\d+)\]/.exec(l.body);
        if (!m) continue;
        const n = parseInt(m[1], 10);
        const p = ds.payloads.get(n);
        const range = new vscode.Range(l.line, l.bodyCol + l.raw.slice(l.bodyCol).indexOf('PAYLOAD['), l.line, l.bodyCol + l.raw.slice(l.bodyCol).indexOf('PAYLOAD[') + m[0].length);
        if (!p) add(range, `Payload schedule ${n} does not exist on this controller (${ds.payloads.size} schedules in ${ds.label}).`, W, CODES.payload);
        else if (!p.initialized) add(range, `Payload schedule ${n} has never been set up on this controller - it still carries the default ${p.mass} kg and no comment.`, I, CODES.payload);
      }
    }
  }

  // ---- comments ----
  if (config<boolean>('tp.diagnostics.commentMismatch', true, doc)) {
    const seen = new Map<string, { comment: string; line: number }>();
    for (const d of prog.dataRefs) {
      if (!d.comment || !d.commentSpan) continue;
      const key = `${d.kind}:${d.index}`;
      const ctrl = s.data.comment(d.kind, d.index, doc.uri);
      if (ctrl && ctrl !== d.comment) {
        const diag = new vscode.Diagnostic(spanToRange(d.commentSpan), `Controller comment for ${d.kind}[${d.index}] is "${ctrl}".`, I);
        diag.code = CODES.commentMismatch; diag.source = 'FANUC TP';
        (diag as any).fixComment = ctrl;
        out.push(diag);
      }
      const prev = seen.get(key);
      if (prev && prev.comment !== d.comment) add(spanToRange(d.commentSpan), `${d.kind}[${d.index}] is commented "${prev.comment}" on line ${prev.line + 1} but "${d.comment}" here.`, W, CODES.commentInconsistent, undefined, [new vscode.DiagnosticRelatedInformation(new vscode.Location(doc.uri, lineRange(prev.line)), 'Other comment')]);
      else if (!prev) seen.set(key, { comment: d.comment, line: d.line });
    }
  }
  return out;
}

class TpCodeActions implements vscode.CodeActionProvider {
  provideCodeActions(doc: vscode.TextDocument, _range: vscode.Range, ctx: vscode.CodeActionContext): vscode.CodeAction[] {
    const out: vscode.CodeAction[] = [];
    for (const d of ctx.diagnostics) {
      if (d.code === CODES.commentMismatch && (d as any).fixComment) {
        const a = new vscode.CodeAction(`Use controller comment "${(d as any).fixComment}"`, vscode.CodeActionKind.QuickFix);
        a.edit = new vscode.WorkspaceEdit(); a.edit.replace(doc.uri, d.range, (d as any).fixComment); a.diagnostics = [d]; a.isPreferred = true;
        out.push(a);
      }
      if (d.code === CODES.lineSeq || d.code === CODES.lineCount || d.code === CODES.terminator) {
        const a = new vscode.CodeAction('Renumber lines', vscode.CodeActionKind.QuickFix);
        a.command = { command: 'robotCode.tp.renumber', title: 'Renumber lines' }; a.diagnostics = [d]; a.isPreferred = true;
        out.push(a);
      }
      if (d.code === CODES.doubleTerminator) {
        const a = new vscode.CodeAction('Keep one " ;"', vscode.CodeActionKind.QuickFix);
        a.edit = new vscode.WorkspaceEdit(); a.edit.replace(doc.uri, d.range, ';'); a.diagnostics = [d]; a.isPreferred = true;
        out.push(a);
      }
      if (d.code === CODES.integerAxis) {
        const a = new vscode.CodeAction("Write position values the controller's way", vscode.CodeActionKind.QuickFix);
        a.edit = new vscode.WorkspaceEdit();
        for (const e of formatPositions(doc.getText())) a.edit.replace(doc.uri, doc.lineAt(e.line).range, e.newText);
        a.diagnostics = [d]; a.isPreferred = true;
        out.push(a);
      }
      if (d.code === CODES.unusedLabel) {
        const a = new vscode.CodeAction('Remove unused label', vscode.CodeActionKind.QuickFix);
        a.edit = new vscode.WorkspaceEdit(); a.edit.delete(doc.uri, doc.lineAt(d.range.start.line).rangeIncludingLineBreak); a.diagnostics = [d];
        out.push(a);
      }
      if (d.code === CODES.unusedPos) {
        const a = new vscode.CodeAction('Remove unused position data', vscode.CodeActionKind.QuickFix);
        // delete from P[n]{ to the closing }; line
        let end = d.range.start.line;
        while (end < doc.lineCount - 1 && !/^\s*\}\s*;/.test(doc.lineAt(end).text)) end++;
        a.edit = new vscode.WorkspaceEdit(); a.edit.delete(doc.uri, new vscode.Range(d.range.start.line, 0, end + 1, 0)); a.diagnostics = [d];
        out.push(a);
      }
    }
    return out;
  }
}
