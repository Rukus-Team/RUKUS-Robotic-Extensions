/**
 * ABB RAPID module parser (.mod / .sys). Pure TypeScript, no VS Code dependency, so it can
 * be unit-tested against real IRC5 backups with plain node.
 *
 * Written against 24 RobotWare 6.13 / SpotWare backups (about 1000 distinct plain modules).
 * What that corpus taught, and why the parser is shaped the way it is:
 *
 * - A statement ends at `;`, not at the end of a line, so the text is tokenized first
 *   ({@link lexRapid}) and statements are grouped from tokens. Every name still gets a
 *   single-line {@link Span}, which is what go-to-definition and the outline need.
 * - It is forgiving. A module that would not load on the controller still parses, and the
 *   structural problems (an ENDIF with no IF, a PROC never closed) are collected in
 *   {@link RapidModule.problems} for the diagnostics to report, instead of the parser
 *   giving up. It never throws on any input.
 * - RAPID is case-insensitive (`Movej` appears in production code next to `MoveJ`); every
 *   lookup key is upper-cased, every reported name keeps the author's spelling.
 * - About half the distinct .sys files in a backup are encrypted modules, not text. They
 *   are recognised ({@link looksEncrypted}) and returned as an empty module with
 *   `encrypted: true`, so a caller can still say "this task has code we cannot see".
 */

import type { Span } from '@core/span';
import { lexRapid, looksEncrypted, RAPID_RESERVED, type Token, type RapidComment } from './lexer';
export type { Span, RapidComment };
export { looksEncrypted, RAPID_RESERVED };

// ---------------------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------------------

/** A position in the source; used where a range can run over several lines. */
export interface TextPos { line: number; col: number }

/** Source text of an expression or argument, with where it starts. */
export interface RapidArg {
  text: string;
  /** span on the argument's FIRST line; clamped to that line when the argument wraps */
  span: Span;
  /** where the argument ends (exclusive), for arguments that wrap */
  end: TextPos;
}

/** `\Name`, `\Name:=value` or `\Name?value` (the last passes an optional argument on only if it was given). */
export interface RapidOptArg {
  name: string;
  nameSpan: Span;
  value?: RapidArg;
  /** `\Name?value` */
  conditional?: boolean;
}

export type RapidStorage = 'VAR' | 'PERS' | 'CONST';
/** `LOCAL` = this module only, `TASK` = this task only (PERS), `global` = the whole task */
export type RapidScope = 'global' | 'LOCAL' | 'TASK';

export interface RapidData {
  name: string;
  nameSpan: Span;
  storage: RapidStorage;
  type: string;
  typeSpan: Span;
  scope: RapidScope;
  /** array dimension expressions, `{3}` -> ['3'], `{MAXN,2}` -> ['MAXN', '2'] */
  dims?: string[];
  /** the initial value after `:=`, if any; may wrap over lines */
  init?: RapidArg;
  /** routine it is declared in; undefined at module level */
  routine?: string;
  line: number;
  /** the full declaration text, for hovers */
  detail: string;
  doc?: string;
}

export type RapidParamMode = 'IN' | 'VAR' | 'PERS' | 'INOUT';

export interface RapidParam {
  name: string;
  nameSpan: Span;
  type: string;
  mode: RapidParamMode;
  /** declared with a leading `\` */
  optional: boolean;
  /** `\switch Name`: an optional flag with no value */
  switch: boolean;
  /** `{*}` / `{*,*}`: an open array of that many dimensions */
  dims?: number;
  /** parameters joined by `|` share a group number: only one of them may be given */
  altGroup?: number;
}

export type RapidRoutineKind = 'PROC' | 'FUNC' | 'TRAP';

export interface RapidHandler { kind: 'ERROR' | 'UNDO' | 'BACKWARD'; span: Span; line: number; errnos?: string[] }

export interface RapidLabel { name: string; span: Span; line: number }

export interface RapidRoutine {
  kind: RapidRoutineKind;
  name: string;
  nameSpan: Span;
  local: boolean;
  /** FUNC only */
  returnType?: string;
  params: RapidParam[];
  /** data declared inside the routine */
  data: RapidData[];
  labels: RapidLabel[];
  handlers: RapidHandler[];
  /** line of the PROC/FUNC/TRAP keyword (after LOCAL) */
  startLine: number;
  /** line of ENDPROC/ENDFUNC/ENDTRAP; undefined when the routine is never closed */
  endLine?: number;
  /** header text as written, whitespace collapsed, for hovers */
  signature: string;
  doc?: string;
}

export interface RapidRecord {
  name: string;
  nameSpan: Span;
  local: boolean;
  fields: { name: string; type: string; nameSpan: Span }[];
  startLine: number;
  endLine?: number;
}

export interface RapidAlias { name: string; nameSpan: Span; type: string; local: boolean; line: number }

export type RapidCallKind =
  | 'proc'   // `Name args;`
  | 'late'   // `%"Name"% args;` or `%expr% args;` - late binding
  | 'func';  // `Name(...)` inside an expression

export interface RapidCall {
  kind: RapidCallKind;
  /** routine name; for a late-bound call only when the expression is one string literal */
  name?: string;
  /** name span (the string literal's content for `%"Name"%`, the whole `%...%` when dynamic) */
  span: Span;
  line: number;
  routine?: string;
  args: RapidArg[];
  optArgs: RapidOptArg[];
  /** late binding: the expression between the `%` signs */
  expr?: string;
}

export type RapidMoveKind = 'joint' | 'linear' | 'circular' | 'absj' | 'extj' | 'search' | 'spot' | 'calib';

/** A motion instruction with its arguments named. */
export interface RapidMove {
  instruction: string;
  kind: RapidMoveKind;
  span: Span;
  line: number;
  routine?: string;
  target?: RapidArg;
  /** MoveC / SearchC / TriggC: the circle point */
  circPoint?: RapidArg;
  speed?: RapidArg;
  zone?: RapidArg;
  tool?: RapidArg;
  wobj?: RapidArg;
  tload?: RapidArg;
  /** SpotL / SpotJ / CalibL / CalibJ: the gun */
  gun?: RapidArg;
  /** SpotL / SpotJ: the spotdata */
  spot?: RapidArg;
  args: RapidArg[];
  optArgs: RapidOptArg[];
}

export interface RapidRef {
  name: string;
  span: Span;
  routine?: string;
  /** left-hand side of `:=` */
  write?: boolean;
}

export interface RapidConnect { interrupt: string; trap: string; trapSpan: Span; line: number; routine?: string }

export interface RapidGoto { label: string; span: Span; line: number; routine?: string }

export type RapidBlockKind = 'MODULE' | 'PROC' | 'FUNC' | 'TRAP' | 'RECORD' | 'IF' | 'FOR' | 'WHILE' | 'TEST';

export interface RapidBlock { kind: RapidBlockKind; open: Span; close?: Span; name?: string }

export interface RapidProblem { code: string; message: string; span: Span; severity: 'error' | 'warning' | 'info' | 'hint' }

export interface RapidModule {
  /** MODULE name; undefined for an encrypted or headerless file */
  name?: string;
  nameSpan?: Span;
  /** SYSMODULE, NOSTEPIN, VIEWONLY, READONLY, NOVIEW - upper-cased */
  attributes: string[];
  /** `%%% VERSION:1 LANGUAGE:ENGLISH %%%` header of older / exported modules */
  header?: { version?: string; language?: string };
  encrypted: boolean;
  routines: RapidRoutine[];
  /** module-level data */
  data: RapidData[];
  records: RapidRecord[];
  aliases: RapidAlias[];
  calls: RapidCall[];
  moves: RapidMove[];
  refs: RapidRef[];
  gotos: RapidGoto[];
  connects: RapidConnect[];
  /** `<SMT>` and the other pendant placeholders left in the code */
  placeholders: { text: string; span: Span; routine?: string }[];
  /** every string literal outside comments, quotes included */
  strings: { text: string; span: Span }[];
  comments: RapidComment[];
  blocks: RapidBlock[];
  problems: RapidProblem[];
  lines: string[];
}

// ---------------------------------------------------------------------------------------
// Motion instruction signatures
// ---------------------------------------------------------------------------------------

type Role = 'target' | 'circPoint' | 'speed' | 'zone' | 'tool' | 'gun' | 'spot' | 'x';

/**
 * Positional arguments of the motion instructions, by role. Optional `\Name` arguments are
 * not counted - `MoveL \Conc, p10, v100, z10, tool0\WObj:=wobj1` has four positional ones.
 * MoveJ/L/C/AbsJ, the DO/Sync variants, Search and Trigg follow the RAPID instruction
 * reference. SpotL/SpotJ and CalibL/CalibJ are SpotWare; their argument order is taken
 * from how the corpus writes them (`SpotL wp, v500, Gun\GunD:=gd, sd_1, GunTCP\WObj:=w`).
 */
const MOVE_SIGS: Record<string, { kind: RapidMoveKind; roles: Role[] }> = {
  MOVEJ: { kind: 'joint', roles: ['target', 'speed', 'zone', 'tool'] },
  MOVEL: { kind: 'linear', roles: ['target', 'speed', 'zone', 'tool'] },
  MOVEC: { kind: 'circular', roles: ['circPoint', 'target', 'speed', 'zone', 'tool'] },
  MOVEABSJ: { kind: 'absj', roles: ['target', 'speed', 'zone', 'tool'] },
  MOVEEXTJ: { kind: 'extj', roles: ['target', 'speed', 'zone'] },
  MOVEJDO: { kind: 'joint', roles: ['target', 'speed', 'zone', 'tool', 'x', 'x'] },
  MOVELDO: { kind: 'linear', roles: ['target', 'speed', 'zone', 'tool', 'x', 'x'] },
  MOVECDO: { kind: 'circular', roles: ['circPoint', 'target', 'speed', 'zone', 'tool', 'x', 'x'] },
  MOVEJSYNC: { kind: 'joint', roles: ['target', 'speed', 'zone', 'tool', 'x'] },
  MOVELSYNC: { kind: 'linear', roles: ['target', 'speed', 'zone', 'tool', 'x'] },
  MOVECSYNC: { kind: 'circular', roles: ['circPoint', 'target', 'speed', 'zone', 'tool', 'x'] },
  SEARCHJ: { kind: 'search', roles: ['x', 'x', 'target', 'speed', 'tool'] },
  SEARCHL: { kind: 'search', roles: ['x', 'x', 'target', 'speed', 'tool'] },
  SEARCHC: { kind: 'search', roles: ['x', 'x', 'circPoint', 'target', 'speed', 'tool'] },
  TRIGGJ: { kind: 'joint', roles: ['target', 'speed', 'x', 'zone', 'tool'] },
  TRIGGL: { kind: 'linear', roles: ['target', 'speed', 'x', 'zone', 'tool'] },
  TRIGGC: { kind: 'circular', roles: ['circPoint', 'target', 'speed', 'x', 'zone', 'tool'] },
  TRIGGJIOS: { kind: 'joint', roles: ['target', 'speed', 'zone', 'tool'] },
  TRIGGLIOS: { kind: 'linear', roles: ['target', 'speed', 'zone', 'tool'] },
  SPOTJ: { kind: 'spot', roles: ['target', 'speed', 'gun', 'spot', 'tool'] },
  SPOTL: { kind: 'spot', roles: ['target', 'speed', 'gun', 'spot', 'tool'] },
  CALIBJ: { kind: 'calib', roles: ['target', 'speed', 'gun', 'zone', 'tool'] },
  CALIBL: { kind: 'calib', roles: ['target', 'speed', 'gun', 'zone', 'tool'] },
};
/** Names of the instructions {@link RapidModule.moves} captures, upper-cased. */
export const RAPID_MOVE_INSTRUCTIONS: ReadonlySet<string> = new Set(Object.keys(MOVE_SIGS));

// ---------------------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------------------

const CLOSERS: Record<string, RapidBlockKind> = {
  ENDMODULE: 'MODULE', ENDPROC: 'PROC', ENDFUNC: 'FUNC', ENDTRAP: 'TRAP', ENDRECORD: 'RECORD',
  ENDIF: 'IF', ENDFOR: 'FOR', ENDWHILE: 'WHILE', ENDTEST: 'TEST',
};
const OPENER_WORD: Record<RapidBlockKind, string> = {
  MODULE: 'MODULE', PROC: 'PROC', FUNC: 'FUNC', TRAP: 'TRAP', RECORD: 'RECORD', IF: 'IF', FOR: 'FOR', WHILE: 'WHILE', TEST: 'TEST',
};
const CLOSER_OF: Record<RapidBlockKind, string> = {
  MODULE: 'ENDMODULE', PROC: 'ENDPROC', FUNC: 'ENDFUNC', TRAP: 'ENDTRAP', RECORD: 'ENDRECORD', IF: 'ENDIF', FOR: 'ENDFOR', WHILE: 'ENDWHILE', TEST: 'ENDTEST',
};
/**
 * Words that can only start a statement or a block part. Meeting one of them at bracket
 * depth 0 while still looking for a statement's `;` means the `;` is missing: the statement
 * stops there instead of swallowing the next block.
 */
const HARD_STOP = new Set(['ENDIF', 'ENDFOR', 'ENDWHILE', 'ENDTEST', 'ENDPROC', 'ENDFUNC', 'ENDTRAP', 'ENDMODULE', 'ENDRECORD',
  'PROC', 'FUNC', 'TRAP', 'MODULE', 'RECORD', 'ELSE', 'ELSEIF', 'CASE', 'DEFAULT', 'THEN', 'DO']);
/** Operators spelled as words: an identifier after one of these is an operand, not a new statement. */
const WORD_OPS = new Set(['AND', 'OR', 'XOR', 'NOT', 'DIV', 'MOD']);
const OPEN_BR = new Set(['(', '[', '{']);
const CLOSE_BR = new Set([')', ']', '}']);

interface Ctx { kind: RapidBlockKind; block: RapidBlock; routine?: RapidRoutine; record?: RapidRecord }

export interface RapidParseOptions {
  /** capture identifier references (default true); the corpus survey turns it off for speed */
  refs?: boolean;
}

/** Parse one RAPID module. Never throws. */
export function parseRapid(text: string, opts: RapidParseOptions = {}): RapidModule {
  const mod: RapidModule = {
    attributes: [], encrypted: false, routines: [], data: [], records: [], aliases: [], calls: [], moves: [],
    refs: [], gotos: [], connects: [], placeholders: [], strings: [], comments: [], blocks: [], problems: [], lines: [],
  };
  if (looksEncrypted(text)) { mod.encrypted = true; return mod; }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // an editor never shows the BOM, so columns count without it
  const lex = lexRapid(text);
  mod.lines = lex.lines;
  mod.comments = lex.comments;
  const wantRefs = opts.refs !== false;

  let T: Token[] = lex.tokens;
  // `%%%` header: VERSION / LANGUAGE lines between two `%%%` lines, before MODULE
  {
    const firstCode = lex.lines.findIndex(l => l.trim() !== '' && !/^\s*!/.test(l));
    if (firstCode >= 0 && /^\s*%%%\s*$/.test(lex.lines[firstCode])) {
      let close = -1;
      const header: { version?: string; language?: string } = {};
      for (let l = firstCode + 1; l < lex.lines.length; l++) {
        if (/^\s*%%%\s*$/.test(lex.lines[l])) { close = l; break; }
        const m = /^\s*(VERSION|LANGUAGE)\s*:\s*(\S+)/i.exec(lex.lines[l]);
        if (m) header[m[1].toLowerCase() as 'version' | 'language'] = m[2];
      }
      if (close > 0) { mod.header = header; T = T.filter(t => t.line > close); }
    }
  }

  const lineLen = (l: number) => lex.lines[l]?.length ?? 0;
  const tokSpan = (t: Token): Span => ({ line: t.line, col: t.col, len: t.end - t.off });
  const isOp = (t: Token | undefined, s: string) => !!t && t.kind === 'op' && t.text === s;
  const upper = (t: Token | undefined) => (t && t.kind === 'ident' ? t.text.toUpperCase() : undefined);
  /** the source text of tokens [a, b) */
  const argOf = (a: number, b: number): RapidArg | undefined => {
    if (b <= a) return undefined;
    const f = T[a], l = T[b - 1];
    const len = f.line === l.line ? l.end - f.off : lineLen(f.line) - f.col;
    return { text: text.slice(f.off, l.end), span: { line: f.line, col: f.col, len }, end: { line: l.line, col: l.col + (l.end - l.off) } };
  };
  const collapse = (s: string) => s.replace(/\s*\r?\n\s*/g, ' ').replace(/\s+/g, ' ').trim();

  /**
   * Scan from `from` to the first depth-0 token accepted by `stop`. Returns the index of that
   * token, or of a {@link HARD_STOP} word (`hard: true`), or T.length.
   */
  const scan = (from: number, stop: (t: Token) => boolean, hardStops = true): { at: number; hard: boolean } => {
    let depth = 0;
    for (let k = from; k < T.length; k++) {
      const t = T[k];
      if (t.kind === 'op' && OPEN_BR.has(t.text)) { depth++; continue; }
      if (t.kind === 'op' && CLOSE_BR.has(t.text)) { if (depth > 0) depth--; continue; }
      if (depth === 0 && stop(t)) return { at: k, hard: false };
      if (hardStops && t.kind === 'ident' && HARD_STOP.has(t.text.toUpperCase())) {
        // THEN / DO only end an IF / WHILE / FOR head; anywhere else they are a mistake too
        return { at: k, hard: true };
      }
    }
    return { at: T.length, hard: true };
  };
  const semi = (t: Token) => isOp(t, ';');

  // ---- comment lookup for doc text ----
  const fullLineComment = new Map<number, string>();
  for (const c of lex.comments) if (c.fullLine) fullLineComment.set(c.span.line, c.text);
  const tidyDoc = (lines: string[]) => {
    const kept = lines.map(s => s.replace(/^[#*\s]+/, '').replace(/\s+$/, '')).filter(s => s && !/^[=*#\-_~+\s]+$/.test(s));
    return kept.length ? kept.join('\n') : undefined;
  };
  const docAbove = (line: number) => {
    const out: string[] = [];
    for (let l = line - 1; l >= 0 && fullLineComment.has(l); l--) out.unshift(fullLineComment.get(l)!);
    return tidyDoc(out);
  };
  const docBelow = (line: number) => {
    const out: string[] = [];
    for (let l = line + 1; l < lex.lines.length && fullLineComment.has(l); l++) out.push(fullLineComment.get(l)!);
    return tidyDoc(out);
  };

  // ---- context stack ----
  const stack: Ctx[] = [];
  const routineNow = () => { for (let k = stack.length - 1; k >= 0; k--) if (stack[k].routine) return stack[k].routine; return undefined; };
  const problem = (code: string, message: string, span: Span, severity: RapidProblem['severity'] = 'error') =>
    mod.problems.push({ code, message, span, severity });
  const open = (kind: RapidBlockKind, t: Token, extra: Partial<Ctx> = {}, name?: string) => {
    const block: RapidBlock = { kind, open: tokSpan(t), name };
    mod.blocks.push(block);
    const c: Ctx = { kind, block, ...extra };
    stack.push(c);
    return c;
  };
  const closeCtx = (c: Ctx, t: Token) => {
    c.block.close = tokSpan(t);
    if (c.routine) c.routine.endLine = t.line;
    if (c.record) c.record.endLine = t.line;
  };
  const unclosed = (c: Ctx) =>
    problem('rapid.unclosedBlock', `${OPENER_WORD[c.kind]}${c.block.name ? ' ' + c.block.name : ''} has no ${CLOSER_OF[c.kind]}.`, c.block.open);
  /** handle an ENDxxx word */
  const closeWord = (t: Token, kind: RapidBlockKind) => {
    let k = stack.length - 1;
    while (k >= 0 && stack[k].kind !== kind) k--;
    if (k < 0) {
      problem('rapid.unmatchedEnd', `${t.text} without a matching ${OPENER_WORD[kind]}.`, tokSpan(t));
      return;
    }
    while (stack.length - 1 > k) unclosed(stack.pop()!);
    closeCtx(stack.pop()!, t);
  };
  /** a PROC/FUNC/TRAP/RECORD header closes whatever routine is still open: it was never ended */
  const closeRoutinesBefore = () => {
    while (stack.length && stack[stack.length - 1].kind !== 'MODULE') unclosed(stack.pop()!);
  };
  const top = () => stack[stack.length - 1];

  // ---- references and function calls in an expression range ----
  const exprRefs = (a: number, b: number, writeFirst = false) => {
    if (!wantRefs) return;
    const routine = routineNow()?.name;
    let first = true;
    for (let k = a; k < b; k++) {
      const t = T[k];
      if (t.kind !== 'ident') continue;
      const U = t.text.toUpperCase();
      const prev = T[k - 1];
      if (RAPID_RESERVED.has(U)) { first = false; continue; }
      if (isOp(prev, '.') || isOp(prev, '\\')) continue; // record field / optional-argument name
      if (isOp(T[k + 1], '(')) {
        const close = matchClose(k + 1);
        const { args, optArgs } = splitArgs(k + 2, close);
        mod.calls.push({ kind: 'func', name: t.text, span: tokSpan(t), line: t.line, routine, args, optArgs });
        first = false;
        continue;
      }
      mod.refs.push({ name: t.text, span: tokSpan(t), routine, write: writeFirst && first ? true : undefined });
      first = false;
    }
  };
  const matchClose = (openIdx: number) => {
    let depth = 0;
    for (let k = openIdx; k < T.length; k++) {
      const t = T[k];
      if (t.kind === 'op' && OPEN_BR.has(t.text)) depth++;
      else if (t.kind === 'op' && CLOSE_BR.has(t.text)) { depth--; if (depth === 0) return k; }
      else if (isOp(t, ';')) return k;
    }
    return T.length;
  };

  /**
   * Split an argument list [a, b) into positional arguments and `\Name[:=|?value]` ones.
   * Commas separate arguments; an optional argument may also follow the previous one with no
   * comma (`tool0\WObj:=wobj1`), so each comma-separated piece is split again at depth-0 `\`.
   */
  const splitArgs = (a: number, b: number) => {
    const args: RapidArg[] = [];
    const optArgs: RapidOptArg[] = [];
    const pieces: [number, number][] = [];
    let depth = 0, s = a;
    for (let k = a; k < b; k++) {
      const t = T[k];
      if (t.kind === 'op' && OPEN_BR.has(t.text)) depth++;
      else if (t.kind === 'op' && CLOSE_BR.has(t.text)) { if (depth > 0) depth--; }
      else if (depth === 0 && isOp(t, ',')) { pieces.push([s, k]); s = k + 1; }
    }
    if (b > a) pieces.push([s, b]);
    for (const [pa, pb] of pieces) {
      const cuts: number[] = [];
      let d = 0;
      for (let k = pa; k < pb; k++) {
        const t = T[k];
        if (t.kind === 'op' && OPEN_BR.has(t.text)) d++;
        else if (t.kind === 'op' && CLOSE_BR.has(t.text)) { if (d > 0) d--; }
        else if (d === 0 && isOp(t, '\\')) cuts.push(k);
      }
      const posEnd = cuts.length ? cuts[0] : pb;
      const pos = argOf(pa, posEnd);
      if (pos) args.push(pos);
      cuts.forEach((c, ci) => {
        const ce = ci + 1 < cuts.length ? cuts[ci + 1] : pb;
        const nameTok = T[c + 1];
        if (!nameTok || c + 1 >= ce || nameTok.kind !== 'ident') return;
        const opt: RapidOptArg = { name: nameTok.text, nameSpan: tokSpan(nameTok) };
        const sep = T[c + 2];
        if (c + 2 < ce && (isOp(sep, ':=') || isOp(sep, '?'))) {
          opt.value = argOf(c + 3, ce);
          if (isOp(sep, '?')) opt.conditional = true;
        }
        optArgs.push(opt);
      });
    }
    return { args, optArgs };
  };

  const recordMove = (name: Token, args: RapidArg[], optArgs: RapidOptArg[]) => {
    const sig = MOVE_SIGS[name.text.toUpperCase()];
    if (!sig) return;
    const mv: RapidMove = { instruction: name.text, kind: sig.kind, span: tokSpan(name), line: name.line, routine: routineNow()?.name, args, optArgs };
    sig.roles.forEach((r, i) => { if (r !== 'x' && args[i]) (mv as any)[r] = args[i]; });
    for (const o of optArgs) {
      const n = o.name.toUpperCase();
      if (n === 'WOBJ' && o.value) mv.wobj = o.value;
      if (n === 'TLOAD' && o.value) mv.tload = o.value;
    }
    mod.moves.push(mv);
  };

  // ---- declarations ----
  /** `VAR|PERS|CONST type name [{dims}] [:= init] ;` starting at the storage word */
  const parseDecl = (k: number, scope: RapidScope, lineStartTok: Token): number => {
    const storage = T[k].text.toUpperCase() as RapidStorage;
    const typeTok = T[k + 1], nameTok = T[k + 2];
    const end = scan(k, semi);
    if (!typeTok || !nameTok || typeTok.kind !== 'ident' || nameTok.kind !== 'ident' || k + 2 >= end.at) {
      problem('rapid.badDeclaration', `${storage} declaration needs a type and a name.`, tokSpan(T[k]));
      return end.hard ? end.at : end.at + 1;
    }
    let j = k + 3;
    let dims: string[] | undefined;
    if (isOp(T[j], '{')) {
      const c = matchClose(j);
      dims = [];
      let s = j + 1, d = 0;
      for (let q = j + 1; q < c; q++) {
        const t = T[q];
        if (t.kind === 'op' && OPEN_BR.has(t.text)) d++;
        else if (t.kind === 'op' && CLOSE_BR.has(t.text)) d--;
        else if (d === 0 && isOp(t, ',')) { dims.push(argOf(s, q)?.text ?? ''); s = q + 1; }
      }
      dims.push(argOf(s, c)?.text ?? '');
      j = c + 1;
    }
    let init: RapidArg | undefined;
    if (isOp(T[j], ':=')) { init = argOf(j + 1, end.at); exprRefs(j + 1, end.at); }
    const routine = routineNow();
    const d: RapidData = {
      name: nameTok.text, nameSpan: tokSpan(nameTok), storage, type: typeTok.text, typeSpan: tokSpan(typeTok), scope,
      dims, init, routine: routine?.name, line: nameTok.line,
      detail: collapse(text.slice(lineStartTok.off, (T[end.at] && !end.hard ? T[end.at].end : T[end.at - 1].end))),
      doc: docAbove(lineStartTok.line),
    };
    if (routine) routine.data.push(d); else mod.data.push(d);
    if (end.hard) problem('rapid.missingSemicolon', `Missing ";" after the declaration of ${nameTok.text}.`, tokSpan(T[end.at - 1]), 'warning');
    return end.hard ? end.at : end.at + 1;
  };

  /** parameter list tokens [a, b) of a PROC/FUNC header */
  const parseParams = (a: number, b: number): RapidParam[] => {
    const out: RapidParam[] = [];
    let group = 0;
    // split at depth-0 commas; within a piece, `|` joins alternatives
    const pieces: [number, number][] = [];
    let s = a, d = 0;
    for (let k = a; k < b; k++) {
      const t = T[k];
      if (t.kind === 'op' && OPEN_BR.has(t.text)) d++;
      else if (t.kind === 'op' && CLOSE_BR.has(t.text)) d--;
      else if (d === 0 && isOp(t, ',')) { pieces.push([s, k]); s = k + 1; }
    }
    if (b > a) pieces.push([s, b]);
    for (const [pa, pb] of pieces) {
      const alts: [number, number][] = [];
      let as = pa;
      for (let k = pa; k < pb; k++) if (isOp(T[k], '|')) { alts.push([as, k]); as = k + 1; }
      alts.push([as, pb]);
      const g = alts.length > 1 ? ++group : undefined;
      for (const [x, y] of alts) {
        let k = x;
        let optional = false;
        if (isOp(T[k], '\\')) { optional = true; k++; }
        let mode: RapidParamMode = 'IN';
        const m = upper(T[k]);
        if (m === 'VAR' || m === 'PERS' || m === 'INOUT') { mode = m; k++; }
        const typeTok = T[k], nameTok = T[k + 1];
        if (!typeTok || typeTok.kind !== 'ident' || k >= y) continue;
        const isSwitch = typeTok.text.toUpperCase() === 'SWITCH';
        if (!nameTok || nameTok.kind !== 'ident' || k + 1 >= y) continue;
        let dims: number | undefined;
        if (isOp(T[k + 2], '{')) dims = T.slice(k + 3, matchClose(k + 2)).filter(t => isOp(t, '*')).length || 1;
        out.push({ name: nameTok.text, nameSpan: tokSpan(nameTok), type: typeTok.text, mode, optional, switch: isSwitch, dims, altGroup: g });
      }
    }
    return out;
  };

  // ---- the statement loop ----
  let p = 0;
  let guard = 0;
  const statement = (scope: RapidScope = 'global', scopeTok?: Token): void => {
    const t = T[p];
    const U = upper(t);
    const routine = routineNow();
    if (guard++ > T.length * 4 + 100) { p = T.length; return; } // cannot happen; belt and braces

    if (t.kind === 'placeholder') {
      mod.placeholders.push({ text: t.text, span: tokSpan(t), routine: routine?.name });
      p++;
      if (isOp(T[p], ';')) p++;
      return;
    }
    if (isOp(t, ';')) { p++; return; } // empty statement
    if (isOp(t, '%')) { lateCall(); return; }
    if (t.kind !== 'ident') {
      const end = scan(p, semi);
      problem('rapid.syntax', `Unexpected "${t.text}" at the start of a statement.`, tokSpan(t), 'warning');
      p = end.hard ? Math.max(end.at, p + 1) : end.at + 1;
      return;
    }

    // inside RECORD ... ENDRECORD every statement is `type name;`
    if (top()?.kind === 'RECORD' && U !== 'ENDRECORD') {
      const rec = top().record!;
      const nameTok = T[p + 1];
      const end = scan(p, semi);
      if (nameTok?.kind === 'ident' && p + 1 < end.at) rec.fields.push({ name: nameTok.text, type: t.text, nameSpan: tokSpan(nameTok) });
      p = end.hard ? Math.max(end.at, p + 1) : end.at + 1;
      return;
    }

    switch (U) {
      case 'MODULE': {
        const nameTok = T[p + 1];
        if (nameTok?.kind === 'ident') {
          if (mod.name === undefined) { mod.name = nameTok.text; mod.nameSpan = tokSpan(nameTok); }
          open('MODULE', t, {}, nameTok.text);
          p += 2;
          if (isOp(T[p], '(') && T[p].line === nameTok.line) {
            const c = matchClose(p);
            for (let k = p + 1; k < c; k++) if (T[k].kind === 'ident') mod.attributes.push(T[k].text.toUpperCase());
            p = c + 1;
          }
        } else { problem('rapid.syntax', 'MODULE needs a name.', tokSpan(t)); open('MODULE', t); p++; }
        return;
      }
      case 'LOCAL': case 'TASK': {
        const next = upper(T[p + 1]);
        const scopeNow: RapidScope = U;
        if (next && ['VAR', 'PERS', 'CONST', 'PROC', 'FUNC', 'TRAP', 'RECORD', 'ALIAS'].includes(next)) {
          p++;
          statement(scopeNow, t);
          return;
        }
        break;
      }
      case 'VAR': case 'PERS': case 'CONST':
        p = parseDecl(p, scope, scopeTok ?? t);
        return;
      case 'PROC': case 'FUNC': case 'TRAP': {
        closeRoutinesBefore();
        const kind = U as RapidRoutineKind;
        let k = p + 1;
        let returnType: string | undefined;
        if (kind === 'FUNC' && T[k]?.kind === 'ident') { returnType = T[k].text; k++; }
        const nameTok = T[k];
        if (!nameTok || nameTok.kind !== 'ident') { problem('rapid.syntax', `${U} needs a name.`, tokSpan(t)); p++; return; }
        let params: RapidParam[] = [];
        let headerEnd = k; // index of last header token
        if (kind !== 'TRAP') {
          if (isOp(T[k + 1], '(')) {
            const c = matchClose(k + 1);
            params = parseParams(k + 2, c);
            headerEnd = Math.min(c, T.length - 1);
          } else problem('rapid.syntax', `${U} ${nameTok.text} needs a parameter list "( )".`, tokSpan(nameTok), 'warning');
        }
        const startTok = scopeTok ?? t;
        const r: RapidRoutine = {
          kind, name: nameTok.text, nameSpan: tokSpan(nameTok), local: scope === 'LOCAL', returnType, params,
          data: [], labels: [], handlers: [], startLine: t.line,
          signature: collapse(text.slice(startTok.off, T[headerEnd].end)),
          doc: docAbove(startTok.line) ?? docBelow(T[headerEnd].line),
        };
        mod.routines.push(r);
        open(kind, t, { routine: r }, nameTok.text);
        p = headerEnd + 1;
        return;
      }
      case 'RECORD': {
        closeRoutinesBefore();
        const nameTok = T[p + 1];
        const rec: RapidRecord = { name: nameTok?.kind === 'ident' ? nameTok.text : '', nameSpan: nameTok ? tokSpan(nameTok) : tokSpan(t), local: scope === 'LOCAL', fields: [], startLine: t.line };
        mod.records.push(rec);
        open('RECORD', t, { record: rec }, rec.name);
        p += nameTok?.kind === 'ident' ? 2 : 1;
        return;
      }
      case 'ALIAS': {
        const typeTok = T[p + 1], nameTok = T[p + 2];
        const end = scan(p, semi);
        if (typeTok?.kind === 'ident' && nameTok?.kind === 'ident') mod.aliases.push({ name: nameTok.text, nameSpan: tokSpan(nameTok), type: typeTok.text, local: scope === 'LOCAL', line: t.line });
        p = end.hard ? Math.max(end.at, p + 1) : end.at + 1;
        return;
      }
      case 'ENDMODULE': case 'ENDPROC': case 'ENDFUNC': case 'ENDTRAP': case 'ENDRECORD':
      case 'ENDIF': case 'ENDFOR': case 'ENDWHILE': case 'ENDTEST':
        closeWord(t, CLOSERS[U]);
        p++;
        return;
      case 'IF': {
        const end = scan(p + 1, x => semi(x) || upper(x) === 'THEN', false);
        const stopTok = T[end.at];
        if (upper(stopTok) === 'THEN') {
          exprRefs(p + 1, end.at);
          open('IF', t);
          p = end.at + 1;
          return;
        }
        // compact IF: `IF cond statement;` - find where the condition ends
        const s = compactSplit(p + 1, end.at);
        exprRefs(p + 1, s);
        p = s;
        if (s < end.at) statement();
        else { problem('rapid.syntax', 'IF without THEN or a statement.', tokSpan(t), 'warning'); p = end.at + 1; }
        return;
      }
      case 'ELSEIF': case 'ELSE': {
        if (top()?.kind !== 'IF') problem('rapid.misplaced', `${t.text} outside IF ... ENDIF.`, tokSpan(t));
        if (U === 'ELSEIF') {
          const end = scan(p + 1, x => upper(x) === 'THEN', false);
          exprRefs(p + 1, end.at);
          p = end.at + 1;
        } else p++;
        return;
      }
      case 'FOR': {
        const end = scan(p + 1, x => upper(x) === 'DO', false);
        // FOR i FROM a TO b [STEP c] DO - i is the loop's own variable, not a reference
        exprRefs(p + 2, end.at);
        open('FOR', t);
        p = end.at + 1;
        return;
      }
      case 'WHILE': {
        const end = scan(p + 1, x => upper(x) === 'DO', false);
        exprRefs(p + 1, end.at);
        open('WHILE', t);
        p = end.at + 1;
        return;
      }
      case 'TEST': {
        const end = scan(p + 1, x => ['CASE', 'DEFAULT', 'ENDTEST'].includes(upper(x) ?? ''), false);
        exprRefs(p + 1, end.at);
        open('TEST', t);
        p = end.at;
        return;
      }
      case 'CASE': case 'DEFAULT': {
        if (top()?.kind !== 'TEST') problem('rapid.misplaced', `${t.text} outside TEST ... ENDTEST.`, tokSpan(t));
        const end = scan(p + 1, x => isOp(x, ':'));
        if (U === 'CASE') exprRefs(p + 1, end.at);
        p = end.hard ? end.at : end.at + 1;
        return;
      }
      case 'ERROR': case 'UNDO': case 'BACKWARD': {
        const tp = top();
        if (!tp || !tp.routine) problem('rapid.misplaced', `${t.text} handler must be at the top level of a routine.`, tokSpan(t));
        const h: RapidHandler = { kind: U as RapidHandler['kind'], span: tokSpan(t), line: t.line };
        p++;
        if (U === 'ERROR' && isOp(T[p], '(') && T[p].line === t.line) {
          const c = matchClose(p);
          h.errnos = T.slice(p + 1, c).filter(x => x.kind === 'ident' || x.kind === 'num').map(x => x.text);
          p = c + 1;
        }
        routine?.handlers.push(h);
        return;
      }
      case 'THEN': case 'DO': {
        problem('rapid.misplaced', `${t.text} without IF, ELSEIF, FOR or WHILE.`, tokSpan(t));
        p++;
        return;
      }
      case 'RETURN': case 'RAISE': {
        const end = scan(p + 1, semi);
        exprRefs(p + 1, end.at);
        p = end.hard ? end.at : end.at + 1;
        return;
      }
      case 'RETRY': case 'TRYNEXT': case 'EXIT': {
        const end = scan(p + 1, semi);
        p = end.hard ? end.at : end.at + 1;
        return;
      }
      case 'GOTO': {
        const lab = T[p + 1];
        if (lab?.kind === 'ident') mod.gotos.push({ label: lab.text, span: tokSpan(lab), line: lab.line, routine: routine?.name });
        const end = scan(p + 1, semi);
        p = end.hard ? end.at : end.at + 1;
        return;
      }
      case 'CONNECT': {
        const end = scan(p + 1, semi);
        let w = p + 1;
        while (w < end.at && upper(T[w]) !== 'WITH') w++;
        exprRefs(p + 1, w, true);
        const trap = T[w + 1];
        if (w < end.at && trap?.kind === 'ident') {
          mod.connects.push({ interrupt: argOf(p + 1, w)?.text ?? '', trap: trap.text, trapSpan: tokSpan(trap), line: t.line, routine: routine?.name });
          if (wantRefs) mod.refs.push({ name: trap.text, span: tokSpan(trap), routine: routine?.name });
        }
        p = end.hard ? end.at : end.at + 1;
        return;
      }
    }

    // a label: `name:` (a single colon, not :=)
    if (isOp(T[p + 1], ':') && routine) {
      routine.labels.push({ name: t.text, span: tokSpan(t), line: t.line });
      p += 2;
      return;
    }

    // assignment or procedure call
    const end = scan(p, semi);
    // `x := ...` is an assignment; the `:=` of an optional argument (`tool0\WObj:=wobj1`) is not
    const assign = (() => {
      let d = 0;
      for (let k = p; k < end.at; k++) {
        const x = T[k];
        if (x.kind === 'op' && OPEN_BR.has(x.text)) d++;
        else if (x.kind === 'op' && CLOSE_BR.has(x.text)) d--;
        else if (d === 0 && isOp(x, ':=') && !isOp(T[k - 2], '\\')) return k;
      }
      return -1;
    })();
    if (assign >= 0) {
      exprRefs(p, assign, true);
      exprRefs(assign + 1, end.at);
    } else {
      const { args, optArgs } = splitArgs(p + 1, end.at);
      mod.calls.push({ kind: 'proc', name: t.text, span: tokSpan(t), line: t.line, routine: routine?.name, args, optArgs });
      recordMove(t, args, optArgs);
      exprRefs(p + 1, end.at);
      if (!routine && top()?.kind === 'MODULE') problem('rapid.syntax', `Statement outside a routine: ${t.text}.`, tokSpan(t), 'warning');
    }
    if (end.hard) {
      const last = T[end.at - 1] ?? t;
      problem('rapid.missingSemicolon', 'Missing ";" at the end of the statement.', tokSpan(last), 'warning');
      p = Math.max(end.at, p + 1);
    } else p = end.at + 1;
  };

  /**
   * Where does the condition of a compact `IF cond statement;` end? RAPID has no separator,
   * so: the first identifier (or `%`) that follows a complete operand - a name, a number, a
   * string, a closing bracket - and is not itself a word operator, starts the statement.
   * `IF NOT giInterlock=0 WaitTime 0.5;` splits before WaitTime.
   */
  function compactSplit(a: number, b: number): number {
    let depth = 0;
    for (let k = a; k < b; k++) {
      const t = T[k];
      if (t.kind === 'op' && OPEN_BR.has(t.text)) { depth++; continue; }
      if (t.kind === 'op' && CLOSE_BR.has(t.text)) { if (depth > 0) depth--; continue; }
      if (depth || k === a) continue;
      const prev = T[k - 1];
      const prevEndsOperand = prev.kind === 'num' || prev.kind === 'str' || (prev.kind === 'ident' && !WORD_OPS.has(prev.text.toUpperCase())) || (prev.kind === 'op' && CLOSE_BR.has(prev.text));
      if (!prevEndsOperand) continue;
      if ((t.kind === 'ident' && !WORD_OPS.has(t.text.toUpperCase())) || isOp(t, '%') || t.kind === 'placeholder') return k;
    }
    return b;
  }

  /** `%expr% args;` */
  function lateCall() {
    const t = T[p];
    let c = p + 1;
    while (c < T.length && !isOp(T[c], '%') && !isOp(T[c], ';')) c++;
    const end = scan(c + 1, semi);
    const routine = routineNow();
    const inner = T.slice(p + 1, c);
    const { args, optArgs } = splitArgs(c + 1, end.at);
    const call: RapidCall = { kind: 'late', span: tokSpan(t), line: t.line, routine: routine?.name, args, optArgs, expr: argOf(p + 1, c)?.text ?? '' };
    if (inner.length === 1 && inner[0].kind === 'str') {
      const s = inner[0];
      call.name = s.text.replace(/^"|"$/g, '').replace(/""/g, '"');
      call.span = { line: s.line, col: s.col + 1, len: Math.max(0, s.end - s.off - 2) };
    } else if (T[c]) {
      const last = T[c];
      call.span = { line: t.line, col: t.col, len: last.line === t.line ? last.end - t.off : lineLen(t.line) - t.col };
    }
    mod.calls.push(call);
    exprRefs(p + 1, c);
    exprRefs(c + 1, end.at);
    p = end.hard ? Math.max(end.at, p + 1) : end.at + 1;
  }

  while (p < T.length) {
    const before = p;
    statement();
    if (p <= before) p = before + 1; // always make progress
  }
  while (stack.length) unclosed(stack.pop()!);

  for (const t of T) if (t.kind === 'str') mod.strings.push({ text: t.text, span: tokSpan(t) });
  // placeholders inside expressions (`x := <EXP>;`) were skipped by the statement loop
  const seen = new Set(mod.placeholders.map(x => `${x.span.line}:${x.span.col}`));
  for (const t of T) if (t.kind === 'placeholder' && !seen.has(`${t.line}:${t.col}`)) {
    const r = mod.routines.find(r => t.line >= r.startLine && (r.endLine === undefined || t.line <= r.endLine));
    mod.placeholders.push({ text: t.text, span: tokSpan(t), routine: r?.name });
  }
  return mod;
}

// ---------------------------------------------------------------------------------------
// Aggregate literals: robtarget and jointtarget values
// ---------------------------------------------------------------------------------------

/** A parsed `[...]` aggregate: nested arrays of numbers, strings and raw expression text. */
export type RapidValue = number | string | boolean | RapidValue[] | { expr: string };

/**
 * Parse a RAPID aggregate such as `[[0,0,-450],[1,0,0,0],[-2,1,-1,0],[9E+09,...]]`.
 * Numbers become numbers, "strings" strings (unquoted), TRUE/FALSE booleans; anything
 * else (a name, an expression) is kept as `{ expr }`. Returns undefined when the brackets
 * do not balance.
 */
export function parseAggregate(text: string): RapidValue | undefined {
  let i = 0;
  const s = text;
  const ws = () => { while (i < s.length && /\s/.test(s[i])) i++; };
  const value = (): RapidValue | undefined => {
    ws();
    if (s[i] === '[') {
      i++;
      const out: RapidValue[] = [];
      ws();
      if (s[i] === ']') { i++; return out; }
      for (;;) {
        const v = value();
        if (v === undefined) return undefined;
        out.push(v);
        ws();
        if (s[i] === ',') { i++; continue; }
        if (s[i] === ']') { i++; return out; }
        return undefined;
      }
    }
    if (s[i] === '"') {
      let j = i + 1, str = '';
      while (j < s.length) { if (s[j] === '"') { if (s[j + 1] === '"') { str += '"'; j += 2; continue; } break; } str += s[j++]; }
      if (j >= s.length) return undefined;
      i = j + 1;
      return str;
    }
    // a scalar or expression: up to the next depth-0 , or ]
    const st = i;
    let d = 0;
    while (i < s.length) {
      const c = s[i];
      if (c === '(' || c === '{') d++;
      else if (c === ')' || c === '}') d--;
      else if (d === 0 && (c === ',' || c === ']')) break;
      else if (c === '"') { i++; while (i < s.length && s[i] !== '"') i++; }
      i++;
    }
    const raw = s.slice(st, i).trim();
    if (!raw) return undefined;
    if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(raw)) return Number(raw);
    if (/^TRUE$/i.test(raw)) return true;
    if (/^FALSE$/i.test(raw)) return false;
    return { expr: raw };
  };
  const v = value();
  ws();
  return v !== undefined && i >= s.length ? v : undefined;
}

/**
 * The value RAPID uses for an external axis that is not there. The controller writes it as
 * `9E+09` (9 000 000 000); anything this large is "unused", whatever the spelling.
 */
export const EXTAX_UNUSED = 9e9;
export const isUnusedAxis = (v: number) => Math.abs(v) >= 8.9e9;

export interface RobTargetValue {
  /** x, y, z in mm */
  trans: [number, number, number];
  /** quaternion q1..q4 */
  rot: [number, number, number, number];
  /** cf1, cf4, cf6, cfx */
  robconf: [number, number, number, number];
  /** eax_a..eax_f; unused axes are 9E+09 (see {@link isUnusedAxis}) */
  extax: number[];
}

export interface JointTargetValue {
  /** rax_1..rax_6 in degrees */
  robax: number[];
  /** eax_a..eax_f; unused axes are 9E+09 */
  extax: number[];
}

const nums = (v: RapidValue | undefined, n: number): number[] | undefined =>
  Array.isArray(v) && v.length === n && v.every(x => typeof x === 'number') ? (v as number[]) : undefined;

/** `[[x,y,z],[q1,q2,q3,q4],[cf1,cf4,cf6,cfx],[eax_a,...,eax_f]]` -> numbers, or undefined when it is not that shape. */
export function parseRobTarget(text: string): RobTargetValue | undefined {
  return robTargetFrom(parseAggregate(text));
}

/** An already-parsed aggregate as a robtarget, e.g. one element of a robtarget array. */
export function robTargetFrom(v: RapidValue | undefined): RobTargetValue | undefined {
  if (!Array.isArray(v) || v.length !== 4) return undefined;
  const trans = nums(v[0], 3), rot = nums(v[1], 4), robconf = nums(v[2], 4), extax = nums(v[3], 6);
  if (!trans || !rot || !robconf || !extax) return undefined;
  return { trans: trans as RobTargetValue['trans'], rot: rot as RobTargetValue['rot'], robconf: robconf as RobTargetValue['robconf'], extax };
}

/** `[[rax_1..rax_6],[eax_a..eax_f]]` -> numbers, or undefined when it is not that shape. */
export function parseJointTarget(text: string): JointTargetValue | undefined {
  return jointTargetFrom(parseAggregate(text));
}

/** An already-parsed aggregate as a jointtarget. */
export function jointTargetFrom(v: RapidValue | undefined): JointTargetValue | undefined {
  if (!Array.isArray(v) || v.length !== 2) return undefined;
  const robax = nums(v[0], 6), extax = nums(v[1], 6);
  return robax && extax ? { robax, extax } : undefined;
}

/**
 * The robtarget values of a declaration: one for `robtarget p := [...]`, one per element
 * for an array (`robtarget path{3} := [[...],[...],[...]]`). Undefined when the type is not
 * robtarget, there is no literal, or any element is not a robtarget.
 */
export function robTargetsOf(d: RapidData): RobTargetValue[] | undefined {
  if (!/^robtarget$/i.test(d.type) || !d.init) return undefined;
  const v = parseAggregate(d.init.text);
  if (!d.dims) { const one = robTargetFrom(v); return one ? [one] : undefined; }
  const flat: RobTargetValue[] = [];
  const walk = (x: RapidValue | undefined, depth: number): boolean => {
    if (depth === 0) { const t = robTargetFrom(x); if (t) flat.push(t); return !!t; }
    return Array.isArray(x) && x.every(e => walk(e, depth - 1));
  };
  return walk(v, d.dims.length) ? flat : undefined;
}

// ---------------------------------------------------------------------------------------
// Small lookups the providers will want
// ---------------------------------------------------------------------------------------

/** The routine whose body contains `line`, if any. */
export function routineAt(mod: RapidModule, line: number): RapidRoutine | undefined {
  return mod.routines.find(r => line >= r.startLine && (r.endLine === undefined || line <= r.endLine));
}

/** Every declared name in the module with its span: routines, module data, records, aliases. */
export function moduleSymbols(mod: RapidModule): { name: string; kind: 'routine' | 'data' | 'record' | 'alias'; span: Span; local: boolean }[] {
  return [
    ...mod.routines.map(r => ({ name: r.name, kind: 'routine' as const, span: r.nameSpan, local: r.local })),
    ...mod.data.map(d => ({ name: d.name, kind: 'data' as const, span: d.nameSpan, local: d.scope === 'LOCAL' })),
    ...mod.records.map(r => ({ name: r.name, kind: 'record' as const, span: r.nameSpan, local: r.local })),
    ...mod.aliases.map(a => ({ name: a.name, kind: 'alias' as const, span: a.nameSpan, local: a.local })),
  ];
}
