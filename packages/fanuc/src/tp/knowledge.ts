/**
 * What the Knowledge view shows: the kinds of TP program and what each may hold, and the
 * building blocks that go into a program at the caret.
 *
 * A rule says where it comes from. `source` is a manual and page (taken from the syntax catalog,
 * data/tp-syntax.json, which records them) - those are the ones the view presents as fact. A rule
 * WITHOUT a source was written from experience and has not been checked against a manual page;
 * the view marks it "to confirm" and a finding from it is worded as a question, not an error.
 * Correct or source a rule here and both the view and the check follow.
 *
 * Pure: no vscode import, so the unit tests read it.
 */
import type { TpProgram } from './parser';
import { readSnippets, type Snippet } from '@core/snippets';
import tpSnippets from '../../../../snippets/tp.json';

export type ProgramKindId = 'tp' | 'macro' | 'cond' | 'bglogic';

export interface KnowledgeRule { text: string; source?: string }
export interface ProgramKind {
  id: ProgramKindId;
  label: string;
  summary: string;
  /** how a program becomes this kind / is started */
  setup: string[];
  rules: KnowledgeRule[];
}

/** R-30iB / R-30iB Plus Operator's Manual (Basic Function), B-83284EN/10 - the pages the rules below were checked against */
const BASIC = 'Basic Function manual B-83284EN/10';
/** the syntax catalog's own references (data/tp-syntax.json) */
const BASIC9 = 'Basic Operation manual B-83284EN/09';
/** loaded as .LS into a ROBOGUIDE V9.40 virtual controller, 2026-11-13: what it took and what it refused (ASBN-002) */
const VC = 'tried on a V9.40 virtual controller';

export const PROGRAM_KINDS: ProgramKind[] = [
  {
    id: 'tp', label: 'TP program', summary: 'An ordinary program (Sub Type: None): motion, logic, calls - anything.',
    setup: ['Selected and run from the pendant, called with CALL, or started by RSR / PNS / UOP.'],
    rules: [
      { text: 'The name in /PROG and the file name are the same - the controller refuses to load the file otherwise (ASBN-002).', source: VC },
      { text: 'A !comment line holds 32 characters - the controller cuts the rest off without a word. A longer note is an extended comment (--eg:), whose lines can be any length.', source: VC },
      { text: 'Every line has its number and ends in " ;". The numbers themselves and LINE_COUNT may be wrong - the controller renumbers on load - but a line with no number is refused.', source: VC },
      { text: 'A ] too many is refused at load.', source: VC },
    ],
  },
  {
    id: 'macro', label: 'Macro', summary: 'A program (Sub Type: Macro) given a name in the macro table, so it runs from a key, an input, a menu or as an instruction of its own.',
    setup: [
      'Create the program with Sub Type Macro, then MENU > SETUP > Macro: give it an instruction name and, if wanted, a device to start it from.',
      'In a program the macro is written by its instruction name on a line of its own (GRIP PART), not with CALL.',
      'Devices: MF[1-99] manual functions screen, UK[1-7] user key, SU[1-7] SHIFT + user key, DI / RI, UI[7] (HOME; other UI need $MACROUOPENBL), F[ ] flags and M[ ] markers.',
    ],
    rules: [
      { text: 'It is written like any other program - IF, JMP, CALL, motion are all allowed. (The forward-only jump is a background logic rule, not a macro rule.)', source: `${BASIC} p.536; ${VC}` },
      { text: 'A macro with a motion group cannot run from a user key without SHIFT (UK[1-7]); give it SHIFT + user key (SU[1-7]). This is about the motion group in the header, not about whether it has motion lines.', source: `${BASIC} p.545` },
      { text: 'A macro with no motion instructions should have no motion group (DEFAULT_GROUP all *): it can then start even while an alarm is active.', source: `${BASIC} p.536` },
      { text: 'From MF and SU a macro with a motion group runs only while SHIFT is held, to the end.', source: `${BASIC} p.544-545` },
      { text: 'Started from DI, RI, UI, F or M, the teach pendant must be disabled.', source: `${BASIC} p.546` },
      { text: 'DI and RI together can start at most 10 macros.', source: `${BASIC} p.537` },
      { text: 'It always starts at its first line, cannot be single-stepped, and is aborted rather than paused.', source: `${BASIC} p.542` },
      { text: 'The instruction name is up to 36 characters, without ( or ).', source: `${BASIC} p.536` },
      { text: 'Up to 150 macros; a registered macro program cannot be deleted.', source: `${BASIC} p.536` },
      { text: 'A macro can take arguments (up to 30), read inside it as AR[n].', source: `${BASIC} sec. 4.7.6` },
      { text: 'A macro on a pendant key replaces that key\'s own function. Compare the macro tables before copying macro programs to another controller.', source: `${BASIC} p.536-537, 546` },
    ],
  },
  {
    id: 'cond', label: 'Condition program (Cond)', summary: 'The list of conditions a MONITOR instruction watches while another program runs (Sub Type: Cond).',
    setup: [
      'Create the program with Sub Type Cond; it cannot be run directly.',
      'Program monitor: MONITOR <program> starts it and MONITOR END <program> (or the end of the program) stops it. By default it stops while the program is paused.',
      'System monitor: started and stopped on the System Monitor status screen, not from a program, and independent of what is running.',
    ],
    rules: [
      { text: 'Only condition lines: WHEN <condition>,CALL <program>. No motion, assignments or jumps - anything else is refused at load.', source: `${BASIC} p.594; ${VC}` },
      { text: 'Conditions on one line are joined with AND, or with OR - never a mix of both (refused at load).', source: `${BASIC} p.596; ${VC}` },
      { text: 'Up to 5 conditions on one line (a sixth is refused at load).', source: `${BASIC} p.596; ${VC}` },
      { text: 'Up to 10 conditions are monitored at the same time; each WHEN line is a monitor of its own.', source: `${BASIC} p.598` },
      { text: 'It has no motion group - the pendant sets it to all * - and the program it calls must have none either (default setting).', source: `${BASIC} p.596, 598` },
      { text: 'A condition fires once: when it is met the monitor ends. To keep watching, clear the condition and run MONITOR again.', source: `${BASIC} p.598` },
      { text: 'A condition compares R[ ], a system variable or analog / group I/O with a value; digital I/O with ON, OFF, another signal or an edge; or an error number (aabbb, e.g. 11006 for SRVO-006).', source: `${BASIC} p.594-596` },
      { text: 'It cannot be edited while its monitor is running or paused.', source: `${BASIC} p.597-598` },
    ],
  },
  {
    id: 'bglogic', label: 'Background logic', summary: 'A program the controller scans from top to bottom over and over, behind whatever else is running - interlocks and signal logic.',
    setup: [
      'An ordinary program (Sub Type: None), entered on MENU > SETUP > BG Logic and set to RUN there. Each program has a MODE: Normal or High.',
      'Nothing in the file says it is background logic - pick this type here to have it checked as one.',
      'While it runs as background logic it cannot be edited, run as a normal program, or overwritten by a file load.',
    ],
    rules: [
      { text: 'Only these lines: mixed-logic assignments - DO[1]=(DI[1] AND !DI[2]) - IF (...) with an assignment or a jump, JMP LBL[ ], LBL[ ], RUN, SELECT and UALM[ ]. Anything else (WAIT, CALL, motion, IF...THEN, FOR) and it will not start: INTP-443.', source: `${BASIC} p.633` },
      { text: 'A jump only goes forward: the LBL comes after its JMP.', source: `${BASIC} p.634` },
      { text: 'An IF needs its condition in parentheses: IF (DI[1]=ON),JMP LBL[1] - not IF DI[1]=ON,JMP LBL[1].', source: `${BASIC} p.634` },
      { text: 'A marker M[n] can be read but not assigned.', source: `${BASIC} p.633` },
      { text: 'A pulse is allowed: IF (DI[1]),DO[1]=PULSE,1.0sec. With no time it lasts one scan.', source: `${BASIC} p.634` },
      { text: 'RUN: the program started must have no motion group and must not already be running - guard the RUN with a flag so it happens once.', source: `${BASIC} p.634` },
      { text: 'It is not stopped by an emergency stop, a hold or an alarm, and starts again by itself at the next power-up.', source: `${BASIC} p.632-633` },
      { text: 'Up to 8 programs at once.', source: `${BASIC} p.632` },
      { text: 'Normal mode: 600 items (operands and operators) are scanned every 8 ms; more only makes the scan slower. High mode: scanned completely every 8 ms, 540 items in all - more gives INTP-651.', source: `${BASIC} p.632` },
      { text: 'Flags F[n] and the math functions (ABS[ ], SQRT[ ] ...) can be used. Edges (ON+ / OFF-) and position data cannot.', source: `${BASIC} sec. 4.19; ${BASIC9} p.640-642` },
      { text: 'Give it no motion group (DEFAULT_GROUP all *). Common practice; the manual states it only for a program started by RUN.' },
    ],
  },
];

export const programKind = (id: ProgramKindId): ProgramKind => PROGRAM_KINDS.find(k => k.id === id) ?? PROGRAM_KINDS[0];

/** The kind the file itself states: the Sub Type on its /PROG line. Background logic is not in the file. */
export function kindOfProgram(prog: TpProgram): ProgramKindId {
  const t = (prog.header.programType ?? '').toLowerCase();
  return t === 'macro' ? 'macro' : t === 'cond' ? 'cond' : 'tp';
}

export interface KnowledgeFinding {
  /** document line */
  line: number;
  message: string;
  /** from a rule with a manual source; false = from a rule still to confirm */
  sourced: boolean;
}

const noGroup = (prog: TpProgram) => /^\s*\*(\s*,\s*\*)*\s*$/.test(prog.header.attrs.get('DEFAULT_GROUP')?.value ?? '*');

/** Where a program does not fit the kind it is being written as */
export function kindFindings(kind: ProgramKindId, prog: TpProgram): KnowledgeFinding[] {
  const out: KnowledgeFinding[] = [];
  const mn = prog.sections.mn;
  if (mn === undefined) return out;
  // one entry per instruction: the `:` lines a long one is wrapped onto are joined to it (a
  // circular move's second point stays a line of its own, so the move is still seen as motion)
  const body: Array<{ line: number; kind: TpProgram['lines'][number]['kind']; body: string }> = [];
  for (const l of prog.lines) {
    if (l.line <= mn || (prog.sections.pos !== undefined && l.line >= prog.sections.pos)) continue;
    const head = body[body.length - 1];
    if (l.kind === 'continuation' && head && head.kind === 'instruction') head.body += ' ' + l.body;
    else body.push({ line: l.line, kind: l.kind, body: l.body });
  }
  const group = prog.header.attrs.get('DEFAULT_GROUP');
  if (kind === 'cond') {
    if (group && !noGroup(prog)) out.push({ line: group.line, message: `DEFAULT_GROUP is ${group.value} - a Cond program has no motion group (all *).`, sourced: true });
    for (const l of body) {
      if (l.kind === 'motion' || l.kind === 'continuation') out.push({ line: l.line, message: 'A motion instruction - a Cond program holds WHEN lines only.', sourced: true });
      else if (l.kind !== 'instruction') continue;
      else if (!/^WHEN\b/i.test(l.body)) out.push({ line: l.line, message: 'Not a WHEN line - a Cond program holds WHEN <condition>,CALL <program> lines only.', sourced: true });
      else {
        const ands = l.body.match(/\bAND\b/gi)?.length ?? 0, ors = l.body.match(/\bOR\b/gi)?.length ?? 0;
        if (ands && ors) out.push({ line: l.line, message: 'AND and OR in one WHEN - the conditions of a line are joined with one or the other.', sourced: true });
        else if (ands + ors + 1 > 5) out.push({ line: l.line, message: `${ands + ors + 1} conditions on one line - a WHEN takes up to 5.`, sourced: true });
      }
    }
  }
  if (kind === 'bglogic') {
    if (group && !noGroup(prog)) out.push({ line: group.line, message: `DEFAULT_GROUP is ${group.value} - background logic is normally given no motion group (all *).`, sourced: false });
    const labelLine = new Map(prog.labels.map(l => [l.num, l.line] as const));
    for (const j of prog.jumps) {
      const at = labelLine.get(j.num);
      if (at !== undefined && at <= j.line) out.push({ line: j.line, message: `Jumps back to LBL[${j.num}] - in background logic the label has to come after the JMP (INTP-443).`, sourced: true });
    }
    const NOT_TAKEN = 'background logic takes assignments, IF (...), JMP LBL, LBL, RUN, SELECT and UALM only; the program will not start (INTP-443).';
    for (const l of body) {
      if (l.kind === 'motion' || l.kind === 'continuation') { out.push({ line: l.line, message: `A motion instruction - ${NOT_TAKEN}`, sourced: true }); continue; }
      if (l.kind !== 'instruction') continue;
      const b = l.body;
      if (/^(LBL\[|JMP\s+LBL\[|RUN\s|SELECT\s|UALM\[|=|ELSE\s*,)/i.test(b)) continue;
      const iff = /^IF\b\s*(\(?)/i.exec(b);
      if (iff) {
        if (!iff[1]) out.push({ line: l.line, message: 'IF without parentheses - in background logic the condition goes in ( ): IF (DI[1]=ON),...', sourced: true });
        else if (/\bTHEN\s*$/i.test(b)) out.push({ line: l.line, message: `IF ... THEN - ${NOT_TAKEN}`, sourced: true });
        else if (/\)\s*,\s*M\[[^\]]*\]\s*=/i.test(b)) out.push({ line: l.line, message: 'Assigns a marker - M[n] cannot be assigned inside a background logic program.', sourced: true });
        else if (/\)\s*,\s*(CALL|WAIT)\b/i.test(b)) out.push({ line: l.line, message: `IF (...) with ${/CALL/i.test(b) ? 'CALL' : 'WAIT'} - ${NOT_TAKEN}`, sourced: true });
        continue;
      }
      if (/^M\[[^\]]*\]\s*=/i.test(b)) out.push({ line: l.line, message: 'Assigns a marker - M[n] cannot be assigned inside a background logic program.', sourced: true });
      else if (/^[A-Z_$][A-Z0-9_$.]*(\[[^=]*\])?\s*=\s*(\(|PULSE\b)/i.test(b)) continue;
      else if (/^[A-Z_$][A-Z0-9_$.]*(\[[^=]*\])?\s*=/i.test(b)) out.push({ line: l.line, message: 'An assignment without parentheses - is it a mixed-logic one? Background logic takes X=(...).', sourced: false });
      else out.push({ line: l.line, message: `${/^[A-Z_]+/i.exec(b)?.[0] ?? 'This line'} - ${NOT_TAKEN}`, sourced: true });
    }
  }
  return out.sort((a, b) => a.line - b.line);
}

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

export interface Block {
  group: string;
  label: string;
  detail: string;
  /** snippet syntax; the lines carry their own ` ;` */
  insert: string;
  /** the kinds of program it belongs in; undefined = any but Cond and background logic */
  kinds?: ProgramKindId[];
}

/** the snippet prefix -> the group its block is listed under, in the order the view shows them */
const GROUPS: [string, string[]][] = [
  ['IF', ['ifjmp', 'ifcall', 'ifthen', 'ifelse']],
  ['SELECT / FOR', ['select', 'for']],
  ['Labels and jumps', ['lbl', 'jmp']],
  ['Motion', ['j', 'l', 'c', 'a', 'jpr', 'lpr', 'loff', 'ltoff', 'lvoff', 'skip']],
  ['WAIT', ['wait', 'waitto', 'waitsec']],
  ['Registers', ['r=', 'r++', 'pr=', 'pr[', 'sr=']],
  ['I/O', ['do', 'dopulse', 'ro', 'flag', 'go']],
  ['CALL / RUN', ['call', 'callarg', 'run']],
  ['Frames and setup', ['uframe', 'utool', 'payload', 'override', 'colguard']],
  ['Timers, alarms, messages', ['timer', 'ualm', 'message']],
  ['Program control', ['abort', 'pause', 'end', 'monitor']],
  ['Vision', ['visrun']],
  ['Comments', ['!', 'banner']],
];

const EXTRA: Block[] = [
  { group: 'Condition program', label: 'WHEN ... CALL', detail: 'One watched condition', insert: 'WHEN ${1:DI[1]}=${2|ON,OFF|},CALL ${3:PROGRAM} ;', kinds: ['cond'] },
  { group: 'Condition program', label: 'WHEN ... AND ... CALL', detail: 'Both conditions', insert: 'WHEN ${1:DI[1]}=${2|ON,OFF|} AND ${3:R[1]}=${4:1},CALL ${5:PROGRAM} ;', kinds: ['cond'] },
  { group: 'Condition program', label: 'WHEN ... OR ... CALL', detail: 'Either condition', insert: 'WHEN ${1:DI[1]}=${2|ON,OFF|} OR ${3:DI[2]}=${4|ON,OFF|},CALL ${5:PROGRAM} ;', kinds: ['cond'] },
  { group: 'Background logic', label: 'Output from inputs', detail: 'DO[ ]=( ... AND ... )', insert: 'DO[${1:1}]=(${2:DI[1]} AND ${3:!DI[2]}) ;', kinds: ['bglogic', 'tp', 'macro'] },
  { group: 'Background logic', label: 'Flag from a condition', detail: 'F[ ]=( ... )', insert: 'F[${1:1}]=(${2:DI[1] OR DI[2]}) ;', kinds: ['bglogic', 'tp', 'macro'] },
  { group: 'Background logic', label: 'IF ( ), assignment', detail: 'Assign only while the condition is true', insert: 'IF (${1:DI[1]}),${2:DO[1]}=(${3:ON}) ;', kinds: ['bglogic', 'tp', 'macro'] },
  { group: 'Background logic', label: 'IF ( ), jump forward', detail: 'Skip the lines up to a label further down', insert: 'IF (${1:DI[1]}),JMP LBL[${2:1}] ;', kinds: ['bglogic', 'tp', 'macro'] },
  { group: 'Background logic', label: 'IF ( ), pulse', detail: 'Pulse an output when the condition is true', insert: 'IF (${1:DI[1]}),DO[${2:1}]=PULSE,${3:1.0}sec ;', kinds: ['bglogic', 'tp', 'macro'] },
  { group: 'Background logic', label: 'Register from an expression', detail: 'R[ ]=( ... )', insert: 'R[${1:1}]=(${2:R[2]+1}) ;', kinds: ['bglogic', 'tp', 'macro'] },
];

function fromSnippets(snippets: Snippet[]): Block[] {
  const byPrefix = new Map(snippets.map(s => [s.prefixes[0], s] as const));
  const out: Block[] = [];
  for (const [group, prefixes] of GROUPS) {
    for (const p of prefixes) {
      const s = byPrefix.get(p);
      if (!s) continue;
      const kinds: ProgramKindId[] | undefined = p === '!' || p === 'banner' ? ['tp', 'macro', 'cond', 'bglogic'] : p === 'lbl' || p === 'jmp' || p === 'run' || p === 'select' || p === 'ualm' ? ['tp', 'macro', 'bglogic'] : undefined;
      out.push({ group, label: s.name, detail: s.description ?? '', insert: s.body, kinds });
    }
  }
  return out;
}

export const BLOCKS: Block[] = [...EXTRA.filter(b => b.group === 'Condition program'), ...fromSnippets(readSnippets(tpSnippets)), ...EXTRA.filter(b => b.group !== 'Condition program')];

export const blockFits = (b: Block, kind: ProgramKindId): boolean => (b.kinds ? b.kinds.includes(kind) : kind === 'tp' || kind === 'macro');

/** a block as the text it writes, for the preview: placeholders as their defaults, choices as the first one */
export function blockPreview(insert: string): string {
  let out = insert, prev = '';
  while (out !== prev) {
    prev = out;
    out = out.replace(/\$\{\d+\|([^,|}]*)[^}]*\|\}/g, '$1').replace(/\$\{\d+:([^${}]*)\}/g, '$1').replace(/\$\{\d+\}|\$\d+/g, '');
  }
  return out;
}
