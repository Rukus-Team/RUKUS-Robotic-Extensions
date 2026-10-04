/**
 * FANUC TP (.ls) parser. Pure TypeScript, no VS Code dependency, so it can be
 * unit-tested against real controller backups with plain node.
 *
 * The parser is line-oriented and forgiving: a program that does not pass the
 * controller's own checks still parses here, so diagnostics can point at the
 * problem instead of the parser giving up.
 */

export type TpLineKind =
  | 'header'        // anything before /MN or after /POS
  | 'section'       // /PROG /ATTR /APPL /MN /POS /END
  | 'motion'        // J/L/C/A/S motion instruction
  | 'continuation'  // "    :  P[2] 500mm/sec FINE ;" second line of a circular move etc.
  | 'comment'       // !comment
  | 'remark'        // //remark (line is ignored by the controller)
  | 'blank'         // "   8:   ;"
  | 'instruction'   // any other numbered instruction; also a numberless one (user is typing, or the scaffold/numberless style)
  | 'pos'           // inside /POS
  | 'empty';        // truly empty line

import type { Span } from '@core/span';
import { CATALOG_HEADS } from './syntaxCatalog';
export type { Span };

export interface MotionInfo {
  type: 'J' | 'L' | 'C' | 'A' | 'S';
  target?: { kind: 'P' | 'PR'; index: number; comment?: string; span: Span };
  speed?: { value: string; unit: string; span: Span };
  termination?: { value: string; span: Span };
  options: string;
}

export interface TpLine {
  /** zero-based document line */
  line: number;
  raw: string;
  kind: TpLineKind;
  /** TP line number, if present */
  num?: number;
  /**
   * The line's position in the controller's count (1-based), whether or not the number is
   * written on it - what `LINE_COUNT` counts. Continuations have none. Use this where a
   * line number is shown and the file may be in a numberless style; `num` is only what
   * the text says.
   */
  seq?: number;
  /** column where the instruction body begins (after "N:") */
  bodyCol: number;
  /** instruction body without the line number and trailing " ;" */
  body: string;
  motion?: MotionInfo;
  /**
   * Part of an extended comment: `--eg:` on a numbered line opens one, the text carries on
   * over `    :` continuation lines, and only the LAST line carries the ` ;`. Every line of
   * it is kind 'comment'; this flag is what tells the renumber and the terminator check
   * that a missing ` ;` on the earlier lines is the format, not a mistake.
   */
  ext?: boolean;
}

export interface TpLabel { num: number; comment?: string; span: Span; line: number }
export interface TpJump {
  num: number; span: Span; line: number;
  /** IF/WAIT/SKIP/SELECT/TIMEOUT context or plain JMP */
  kind: 'JMP' | 'TIMEOUT' | 'Skip' | 'VISION' | 'OTHER';
}
export interface TpCall { name: string; kind: 'CALL' | 'RUN'; args?: string; span: Span; line: number }
/** A macro instruction, e.g. "GO TO HOME POS" — the text is the macro's name in the controller's macro table, not a program name. */
export interface TpMacroCall { name: string; args?: string; span: Span; line: number }

/** First words that identify a normal instruction, so a bare-text line is not mistaken for a macro call. */
const INSTRUCTION_FIRST_WORDS = new Set(['IF', 'WAIT', 'JMP', 'CALL', 'RUN', 'LBL', 'SELECT', 'FOR', 'ENDFOR', 'ELSE', 'ENDIF', 'ABORT', 'PAUSE', 'END', 'RETURN', 'MONITOR', 'RSR', 'SKIP', 'TIMER', 'UALM', 'MESSAGE', 'VISION', 'COL', 'LOCK', 'UNLOCK', 'SEMAPHORE', 'PAYLOAD', 'ERROR_PROG', 'RESUME_PROG', 'MAINT_PROG', 'RETURN_PATH_DSBL', 'CLEAR_RESUME_PROG', 'TIP', 'WELD', 'ARC', 'Arc', 'Weave', 'TRACK', 'Track', 'POINT_LOGIC', 'ACC', 'SPOT', 'PRESSURE', 'BACKUP', 'GET_VAR', 'SET_VAR', 'ENABLE', 'DISABLE', 'INDEPENDENT', 'SIMULTANEOUS', 'OVERRIDE', 'UFRAME_NUM', 'UTOOL_NUM', 'WHEN', 'DO', 'THEN', 'TIMEOUT', 'Offset', 'Tool_Offset', 'OFFSET', 'TOOL_OFFSET', 'VOFFSET', 'Skip', 'Toggle', 'TOGGLE', 'PULSE', 'RESET', 'CLEAR', 'NOP']);

/** heads of option instructions from the FANUC manuals (generated catalog): such a line is not a macro call */
const CATALOG_HEAD_RES = CATALOG_HEADS.flatMap(s => { try { return [new RegExp('^' + s, 'i')]; } catch { return []; } });
export function isCatalogInstruction(body: string): boolean { return CATALOG_HEAD_RES.some(re => re.test(body)); }

export type DataKind =
  | 'R' | 'PR' | 'SR' | 'AR' | 'VR' | 'GP' | 'TIMER' | 'UALM' | 'DR' | 'PL'
  | 'DI' | 'DO' | 'RI' | 'RO' | 'GI' | 'GO' | 'AI' | 'AO' | 'UI' | 'UO' | 'SI' | 'SO'
  | 'F' | 'M' | 'WI' | 'WO' | 'WSI' | 'WSO' | 'SPI' | 'SPO';

export const IO_KINDS: ReadonlySet<string> = new Set(['DI', 'DO', 'RI', 'RO', 'GI', 'GO', 'AI', 'AO', 'UI', 'UO', 'SI', 'SO', 'F', 'M', 'WI', 'WO', 'WSI', 'WSO', 'SPI', 'SPO']);
export const REG_KINDS: ReadonlySet<string> = new Set(['R', 'PR', 'SR', 'AR', 'VR', 'GP', 'TIMER', 'UALM', 'DR', 'PL']);

export interface TpDataRef {
  kind: DataKind;
  index: number;
  /** PR[1,2] element */
  sub?: number;
  comment?: string;
  span: Span;
  /** span of the comment text inside the brackets (after the colon) */
  commentSpan?: Span;
  line: number;
  /**
   * Colon-separated segments between the index and the comment that this parser has no
   * name for, e.g. the `curr value` in `GO[10:curr value:name]` that some V8.3 backups
   * write. Kept rather than rejected: the reference is still `GO[10]` and its comment is
   * still the last segment, so everything downstream works, and diagnostics can say what
   * was skipped instead of the parse failing on a shape nobody has documented.
   */
  extra?: string[];
  /**
   * The point's state when the listing was exported, which V8.30 controllers write as a
   * middle segment: `DI[45:OFF:BIN 1 TRIG]`, `GI[28: * :LOAD POS SEL BITS]`. `ON`, `OFF`,
   * a number, or `*` for "not connected". Informational - it is not the comment, and it
   * is not a value that can be trusted now.
   */
  state?: string;
}

export interface TpPosValue { value: number; unit: string }
export interface TpPosGroup {
  group: number;
  uf?: number;
  ut?: number;
  config?: string;
  kind: 'cartesian' | 'joint' | 'unknown';
  values: Record<string, TpPosValue>;
  line: number;
  /**
   * The block exists but was never taught: the controller writes `UF : F, UT : F` and
   * `X = ********`. A motion to it faults at run time, so it is worth knowing.
   */
  untaught?: boolean;
}
export interface TpPosition {
  index: number;
  comment?: string;
  /** the text inside the quotes of `P[1:"Home"]{`, for renaming */
  commentSpan?: Span;
  line: number;
  endLine: number;
  span: Span;
  groups: TpPosGroup[];
}
export interface TpPosRef {
  index: number; span: Span; line: number;
  /** inline comment of a `P[1:Home]` reference on a motion line */
  comment?: string;
  commentSpan?: Span;
}

export interface TpAttr { key: string; value: string; line: number; valueCol: number }

export interface TpHeader {
  name?: string;
  nameSpan?: Span;
  programType?: string;
  attrs: Map<string, TpAttr>;
}

export interface TpProgram {
  header: TpHeader;
  lines: TpLine[];
  sections: { prog?: number; attr?: number; appl?: number; mn?: number; pos?: number; end?: number };
  labels: TpLabel[];
  jumps: TpJump[];
  calls: TpCall[];
  macros: TpMacroCall[];
  dataRefs: TpDataRef[];
  positions: TpPosition[];
  posRefs: TpPosRef[];
  /** count of numbered lines in /MN */
  numberedLineCount: number;
  maxLineNumber: number;
}

const RE_SECTION = /^\/(PROG|ATTR|APPL|MN|POS|END)\b/;
const RE_PROG = /^\/PROG\s+([A-Za-z0-9_\-]+)\s*([A-Za-z]+)?/;
const RE_NUMBERED = /^(\s*)(\d+)(:)/;
const RE_CONTINUATION = /^(\s*)(:)/;
const RE_ATTR = /^(?:TCD:\s*)?\s*([A-Z_]+)\s*=\s*(.*?)\s*[;,]?\s*$/;
const RE_MOTION = /^(J|L|C|A|S)\s+(P|PR)\[(\d+)(?::([^\]]*))?\]\s*(.*)$/;
const RE_CONT_MOTION = /^\s*(P|PR)\[(\d+)(?::([^\]]*))?\]\s*(.*)$/;
const RE_SPEED = /(\d+(?:\.\d+)?|R\[\d+(?::[^\]]*)?\]|AR\[\d+\])(mm\/sec|cm\/min|inch\/min|deg\/sec|%|sec|msec)/;
const RE_TERM = /\b(FINE|CNT\d{1,3}|CD\d{1,3}|CR\d{1,3})\b/;
const RE_LABEL_DEF = /^LBL\[(\d+)(?::([^\]]*))?\]/;
const RE_JUMPS = /\b(JMP|TIMEOUT,|Skip,|SkipJump,|VISION[^;]*?)\s*LBL\[(\d+)(?::[^\]]*)?\]/g;
const RE_CALLS = /\b(CALL|RUN)\s+([A-Za-z0-9_\-]+)(\s*\(([^)]*)\))?/g;
const RE_DATA = /\b(PR|SR|AR|VR|GP|TIMER|UALM|DR|PL|R|DI|DO|RI|RO|GI|GO|AI|AO|UI|UO|SI|SO|F|M|WI|WO|WSI|WSO|SPI|SPO)\[(\d+)(?:,(\d+))?(?::([^\]]*))?\]/g;
const RE_POSREF = /\bP\[(\d+)(?::([^\]]*))?\]/g;
const RE_POS_START = /^P\[(\d+)(?::"([^"]*)")?\]\s*\{/;
const RE_POS_GROUP = /^\s*GP(\d+):/;
const RE_POS_UFUT = /\bUF\s*:\s*(\d+|F)\s*,\s*UT\s*:\s*(\d+|F)/;
const RE_POS_UNTAUGHT = /=\s*\*{3,}/;
const RE_POS_CONFIG = /\bCONFIG\s*:\s*'([^']*)'/;
const RE_POS_VALUE = /\b(X|Y|Z|W|P|R|E\d|J\d+)\s*=\s*(-?[0-9]*\.?[0-9]+)\s*(mm|deg|inch)?/g;

export function parseTp(text: string): TpProgram {
  const rawLines = text.split(/\r?\n/);
  const prog: TpProgram = {
    header: { attrs: new Map() },
    lines: [],
    sections: {},
    labels: [], jumps: [], calls: [], macros: [], dataRefs: [], positions: [], posRefs: [],
    numberedLineCount: 0,
    maxLineNumber: 0,
  };

  let section: 'pre' | 'attr' | 'appl' | 'mn' | 'pos' | 'end' = 'pre';
  let currentPos: TpPosition | undefined;
  let currentGroup: TpPosGroup | undefined;
  let lastMotionLine: TpLine | undefined;
  /** inside a `--eg:` extended comment whose ` ;` has not arrived yet */
  let extComment = false;

  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i];
    const sec = RE_SECTION.exec(raw);
    if (sec) {
      const key = sec[1].toLowerCase() as keyof TpProgram['sections'];
      prog.sections[key] = i;
      section = key === 'prog' ? 'pre' : key === 'attr' ? 'attr' : key === 'appl' ? 'appl' : key === 'mn' ? 'mn' : key === 'pos' ? 'pos' : 'end';
      if (key === 'prog') {
        const m = RE_PROG.exec(raw);
        if (m) {
          prog.header.name = m[1];
          prog.header.nameSpan = { line: i, col: raw.indexOf(m[1]), len: m[1].length };
          prog.header.programType = m[2];
        }
      }
      prog.lines.push({ line: i, raw, kind: 'section', bodyCol: 0, body: raw });
      continue;
    }

    if (section === 'pre' || section === 'attr' || section === 'appl' || section === 'end') {
      if (section === 'attr') {
        const m = RE_ATTR.exec(raw);
        if (m) prog.header.attrs.set(m[1], { key: m[1], value: m[2], line: i, valueCol: raw.indexOf(m[2], raw.indexOf('=')) });
      }
      prog.lines.push({ line: i, raw, kind: raw.trim() === '' ? 'empty' : 'header', bodyCol: 0, body: raw });
      continue;
    }

    if (section === 'pos') {
      prog.lines.push({ line: i, raw, kind: 'pos', bodyCol: 0, body: raw });
      const start = RE_POS_START.exec(raw);
      if (start) {
        currentPos = { index: parseInt(start[1], 10), comment: start[2], line: i, endLine: i, span: { line: i, col: 0, len: raw.indexOf(']') + 1 }, groups: [] };
        if (start[2] !== undefined) currentPos.commentSpan = { line: i, col: raw.indexOf('"') + 1, len: start[2].length };
        prog.positions.push(currentPos);
        currentGroup = undefined;
        continue;
      }
      if (!currentPos) continue;
      if (/^\s*\}\s*;/.test(raw)) { currentPos.endLine = i; currentPos = undefined; currentGroup = undefined; continue; }
      const g = RE_POS_GROUP.exec(raw);
      if (g) { currentGroup = { group: parseInt(g[1], 10), kind: 'unknown', values: {}, line: i }; currentPos.groups.push(currentGroup); continue; }
      if (!currentGroup) { currentGroup = { group: 1, kind: 'unknown', values: {}, line: i }; currentPos.groups.push(currentGroup); }
      const ufut = RE_POS_UFUT.exec(raw);
      if (ufut) {
        if (ufut[1] === 'F' || ufut[2] === 'F') currentGroup.untaught = true;
        else { currentGroup.uf = parseInt(ufut[1], 10); currentGroup.ut = parseInt(ufut[2], 10); }
      }
      if (RE_POS_UNTAUGHT.test(raw)) currentGroup.untaught = true;
      const cfg = RE_POS_CONFIG.exec(raw);
      if (cfg) currentGroup.config = cfg[1];
      RE_POS_VALUE.lastIndex = 0;
      let v: RegExpExecArray | null;
      while ((v = RE_POS_VALUE.exec(raw))) {
        currentGroup.values[v[1]] = { value: parseFloat(v[2]), unit: v[3] ?? '' };
        if (/^J\d/.test(v[1])) currentGroup.kind = 'joint';
        else if (/^[XYZWPR]$/.test(v[1])) currentGroup.kind = 'cartesian';
      }
      continue;
    }

    // ---- /MN section ----
    if (raw.trim() === '') { prog.lines.push({ line: i, raw, kind: 'empty', bodyCol: 0, body: '' }); continue; }

    const numbered = RE_NUMBERED.exec(raw);
    const cont = numbered ? null : RE_CONTINUATION.exec(raw);
    // A `:` line continues the line above only when that line left something to continue:
    // a circular / arc move or a continuation without its terminator (extended comments are
    // tracked by `extComment`). Any other `:` line is an instruction written without its
    // number - the editor's numberless style - and is counted and parsed as one.
    const prev = prog.lines[prog.lines.length - 1];
    const openCont = !!prev && prev.line === i - 1 && !/;\s*$/.test(prev.raw) && prev.kind !== 'comment' && prev.kind !== 'remark'
      && (prev.kind === 'continuation' || /^[CA]\s/.test(prev.body));
    let bodyCol: number;
    let num: number | undefined;
    if (numbered) { bodyCol = numbered[0].length; num = parseInt(numbered[2], 10); }
    else if (cont) { bodyCol = cont[0].length; }
    else { bodyCol = 0; }

    let body = raw.slice(bodyCol);
    const bodyTrimmedEnd = body.replace(/\s*;\s*$/, '');
    const bodyLeading = body.length - body.trimStart().length;
    const bodyText = bodyTrimmedEnd.trim();

    const tpLine: TpLine = { line: i, raw, kind: 'instruction', num, bodyCol, body: bodyText };
    if (num !== undefined && num > prog.maxLineNumber) prog.maxLineNumber = num;

    // ---- --eg: extended comment ----
    // The continuation lines are text, whatever they look like: a `P[2] 500mm/sec` inside
    // one is prose, not the second half of a circular move, so they are claimed here before
    // the motion logic below can see them.
    if (extComment && cont) {
      tpLine.kind = 'comment'; tpLine.ext = true;
      if (/;\s*$/.test(raw)) extComment = false;
      prog.lines.push(tpLine); continue;
    }
    extComment = false;
    if (!cont && /^--eg(?::|\b)/i.test(bodyText)) {
      tpLine.kind = 'comment'; tpLine.ext = true;
      tpLine.seq = ++prog.numberedLineCount;
      extComment = !/;\s*$/.test(raw);
      prog.lines.push(tpLine); continue;
    }

    if (cont && !openCont) {
      // A `:` line that does not continue anything is an instruction written without a
      // number - the editor's numberless style, and the scaffold a new line gets. It keeps
      // the default kind 'instruction' with `num` undefined, so hover, block diagnostics,
      // folding, labels and macros all see it as the program line it is.
    } else if (cont) {
      tpLine.kind = 'continuation';
      const cm = RE_CONT_MOTION.exec(body);
      if (cm && lastMotionLine?.motion) {
        // second target of a circular move
        const col = bodyCol + body.indexOf(cm[1]);
        const info = parseMotionTail(cm[4], i, bodyCol + body.indexOf(cm[4], col));
        tpLine.motion = { type: lastMotionLine.motion.type, target: { kind: cm[1] as 'P' | 'PR', index: parseInt(cm[2], 10), comment: cm[3], span: { line: i, col, len: cm[1].length + cm[2].length + 2 + (cm[3] ? cm[3].length + 1 : 0) } }, ...info };
      }
    }

    // Count what the CONTROLLER counts, which is every line that takes a number - not
    // every line that currently carries one. Real backups contain lines written without
    // their number: `vmdata*.ls` has a bare " ;" sitting where line 4 should be while
    // LINE_COUNT still says 12. Counting only numbered lines made the parser disagree
    // with renumber() about the same file and fired a bogus LINE_COUNT diagnostic.
    if (tpLine.kind !== 'continuation') tpLine.seq = ++prog.numberedLineCount;

    if (bodyText === '') { if (tpLine.kind === 'instruction') tpLine.kind = 'blank'; prog.lines.push(tpLine); continue; }

    if (bodyText.startsWith('!')) { tpLine.kind = 'comment'; prog.lines.push(tpLine); continue; }
    if (bodyText.startsWith('//')) { tpLine.kind = 'remark'; prog.lines.push(tpLine); continue; }

    if (tpLine.kind !== 'continuation') {
      const mm = RE_MOTION.exec(bodyText);
      if (mm && bodyLeading === 0) {
        tpLine.kind = 'motion';
        const targetCol = bodyCol + body.indexOf(mm[2] + '[');
        const tail = mm[5];
        const tailCol = bodyCol + body.indexOf(tail, targetCol);
        tpLine.motion = {
          type: mm[1] as MotionInfo['type'],
          target: { kind: mm[2] as 'P' | 'PR', index: parseInt(mm[3], 10), comment: mm[4], span: { line: i, col: targetCol, len: mm[2].length + mm[3].length + 2 + (mm[4] ? mm[4].length + 1 : 0) } },
          ...parseMotionTail(tail, i, tailCol),
        };
        lastMotionLine = tpLine;
      } else if (bodyLeading === 0 && /^[JLCAS]\s/.test(bodyText)) {
        // Motion with unusual target, still mark as motion
        tpLine.kind = 'motion';
        tpLine.motion = { type: bodyText[0] as MotionInfo['type'], options: bodyText.slice(2) };
        lastMotionLine = tpLine;
      }
    }

    // macro instruction: bare words (optionally with an argument list), no assignment, no index brackets
    if (tpLine.kind === 'instruction') {
      const mm2 = /^([A-Za-z][A-Za-z0-9 _.'\/-]*?)\s*(\(([^)]*)\))?\s*$/.exec(bodyText);
      if (mm2 && !INSTRUCTION_FIRST_WORDS.has(mm2[1].split(/\s+/)[0]) && !/[=\[\]]/.test(mm2[1]) && !isCatalogInstruction(bodyText)) {
        const name = mm2[1].trim();
        prog.macros.push({ name, args: mm2[3], line: i, span: { line: i, col: bodyCol + body.indexOf(name), len: name.length } });
      }
    }

    // labels
    const ld = RE_LABEL_DEF.exec(bodyText);
    if (ld && tpLine.kind === 'instruction') {
      const col = bodyCol + body.indexOf('LBL[');
      prog.labels.push({ num: parseInt(ld[1], 10), comment: ld[2]?.trim() || undefined, span: { line: i, col, len: ld[0].length }, line: i });
    }
    // Text inside a reference's brackets is comment/name, never code: `RUN`/`CALL` or
    // `LBL[...]` inside `DO[1:RUN INTRPT ACK]` must not be read as a call or a jump.
    const bracketRegions: Array<[number, number]> = [];
    const bracketRe = /\[[^\]]*\]/g;
    for (let bm = bracketRe.exec(body); bm; bm = bracketRe.exec(body)) bracketRegions.push([bm.index, bm.index + bm[0].length]);
    const inBracket = (idx: number) => bracketRegions.some(([a, b]) => idx >= a && idx < b);
    // jumps
    RE_JUMPS.lastIndex = 0;
    let jm: RegExpExecArray | null;
    while ((jm = RE_JUMPS.exec(body))) {
      if (inBracket(jm.index)) continue;
      const lblIdx = jm[0].lastIndexOf('LBL[');
      const kw = jm[1];
      const kind: TpJump['kind'] = kw === 'JMP' ? 'JMP' : kw.startsWith('TIMEOUT') ? 'TIMEOUT' : kw.startsWith('Skip') ? 'Skip' : kw.startsWith('VISION') ? 'VISION' : 'OTHER';
      prog.jumps.push({ num: parseInt(jm[2], 10), kind, line: i, span: { line: i, col: bodyCol + jm.index + lblIdx, len: jm[0].length - lblIdx } });
    }
    // calls
    RE_CALLS.lastIndex = 0;
    let cm2: RegExpExecArray | null;
    while ((cm2 = RE_CALLS.exec(body))) {
      if (inBracket(cm2.index)) continue;
      const nameCol = bodyCol + cm2.index + cm2[0].indexOf(cm2[2], cm2[1].length);
      prog.calls.push({ name: cm2[2], kind: cm2[1] as 'CALL' | 'RUN', args: cm2[4], line: i, span: { line: i, col: nameCol, len: cm2[2].length } });
    }
    // data refs
    RE_DATA.lastIndex = 0;
    let dm: RegExpExecArray | null;
    while ((dm = RE_DATA.exec(body))) {
      const ref: TpDataRef = {
        kind: dm[1] as DataKind,
        index: parseInt(dm[2], 10),
        sub: dm[3] !== undefined ? parseInt(dm[3], 10) : undefined,
        comment: dm[4]?.trim() || undefined,
        line: i,
        span: { line: i, col: bodyCol + dm.index, len: dm[0].length },
      };
      if (dm[4] !== undefined) {
        const colonAt = dm[0].indexOf(':');
        let commentCol = bodyCol + dm.index + colonAt + 1;
        let commentText = dm[4];
        // More than one colon inside the brackets is a shape this parser was not written
        // for. The LAST segment is taken as the comment - that is where FANUC puts the name
        // in every documented form - and the rest is kept as `extra` for the diagnostics to
        // mention. A general rule, so the next undocumented shape degrades the same way
        // instead of needing its own special case.
        const segs = dm[4].split(':');
        if (segs.length > 1) {
          commentText = segs[segs.length - 1];
          commentCol += dm[4].length - commentText.length;
          ref.comment = commentText.trim() || undefined;
          const middle = segs.slice(0, -1).map(s => s.trim());
          // V8.30's `[index:state:comment]`: exactly one middle segment that is ON, OFF, a
          // number or `*` is the exported state, not an unknown shape.
          if (middle.length === 1 && /^(ON|OFF|\*|-?\d+(?:\.\d+)?)$/.test(middle[0])) ref.state = middle[0];
          else ref.extra = middle;
        }
        ref.commentSpan = { line: i, col: commentCol, len: commentText.length };
      }
      prog.dataRefs.push(ref);
    }
    // position refs
    RE_POSREF.lastIndex = 0;
    let pm: RegExpExecArray | null;
    while ((pm = RE_POSREF.exec(body))) {
      // avoid matching the P inside "GP[" or "SP[", or a P[..] inside a reference comment
      if (pm.index > 0 && /[A-Za-z]/.test(body[pm.index - 1])) continue;
      if (inBracket(pm.index)) continue;
      const pref: TpPosRef = { index: parseInt(pm[1], 10), line: i, span: { line: i, col: bodyCol + pm.index, len: pm[0].length } };
      if (pm[2] !== undefined) {
        pref.comment = pm[2].trim() || undefined;
        pref.commentSpan = { line: i, col: bodyCol + pm.index + pm[0].indexOf(':') + 1, len: pm[2].length };
      }
      prog.posRefs.push(pref);
    }

    prog.lines.push(tpLine);
  }

  return prog;
}

function parseMotionTail(tail: string, line: number, tailCol: number): { speed?: MotionInfo['speed']; termination?: MotionInfo['termination']; options: string } {
  const out: { speed?: MotionInfo['speed']; termination?: MotionInfo['termination']; options: string } = { options: '' };
  let rest = tail.replace(/\s*;\s*$/, '');
  const sp = RE_SPEED.exec(rest);
  if (sp) {
    out.speed = { value: sp[1], unit: sp[2], span: { line, col: tailCol + sp.index, len: sp[0].length } };
  }
  const tm = RE_TERM.exec(rest);
  if (tm) {
    out.termination = { value: tm[1], span: { line, col: tailCol + tm.index, len: tm[1].length } };
  }
  // options = everything after the termination type
  if (tm) rest = rest.slice(tm.index + tm[0].length);
  else if (sp) rest = rest.slice(sp.index + sp[0].length);
  out.options = rest.trim();
  return out;
}

/** Helpers used by several providers. */
export function findLabel(prog: TpProgram, num: number): TpLabel | undefined {
  return prog.labels.find(l => l.num === num);
}
export function findPosition(prog: TpProgram, index: number): TpPosition | undefined {
  return prog.positions.find(p => p.index === index);
}
export function lineAt(prog: TpProgram, line: number): TpLine | undefined {
  return prog.lines[line]?.line === line ? prog.lines[line] : prog.lines.find(l => l.line === line);
}

/**
 * True when the reference at `col` is the register of an indirect label, `LBL[R[n]]` (as in
 * `JMP LBL[R[168]]`). Such a register is a label index, not data, so a controller comment is
 * not a label suggestion for it.
 */
export function isIndirectLabelIndex(raw: string, col: number): boolean {
  return /LBL\[\s*$/i.test(raw.slice(0, col));
}

/** Which piece of a position's inline hint a part is, so `tp.decorations.positionFields` can pick. */
export type PositionHintField = 'type' | 'userFrame' | 'userTool';

/**
 * The pieces of a position's inline hint, in order: the representation (`JNT`/`XYZ`/`POS`),
 * then the user frame (UFn) and the user tool (UTn) it is written against. Each is tagged with
 * its field so the drawing code can include only the parts the user asked for.
 */
export function frameHintFields(g: { kind: TpPosGroup['kind']; uf?: number; ut?: number } | undefined): Array<{ field: PositionHintField; text: string }> {
  if (!g) return [];
  const out: Array<{ field: PositionHintField; text: string }> = [
    { field: 'type', text: g.kind === 'joint' ? 'JNT' : g.kind === 'cartesian' ? 'XYZ' : 'POS' },
  ];
  if (g.uf !== undefined) out.push({ field: 'userFrame', text: `UF${g.uf}` });
  if (g.ut !== undefined) out.push({ field: 'userTool', text: `UT${g.ut}` });
  return out;
}

/**
 * "Joint UF2/UT6" or "Cartesian UF1/UT1": what a position is and which frames it is
 * written against, spelled out. The old shorthand (`JUF2/UT6`) packed the same facts into
 * a glyph nobody could read without already knowing the convention.
 */
export function frameLabel(g: { kind: TpPosGroup['kind']; uf?: number; ut?: number } | undefined): string {
  if (!g) return 'no data';
  return frameHintFields(g).map(p => `[${p.text}]`).join('');
}

/** A human-readable one-line summary of a position, e.g. "UF:0 UT:1  X 557.4 Y -1586.9 Z 525.4 W -158.3 P -0.8 R 4.7  E1 357.6" */
export function describePosition(pos: TpPosition, group?: number): string {
  const g = group !== undefined ? pos.groups.find(x => x.group === group) : pos.groups[0];
  if (!g) return `P[${pos.index}] (no data)`;
  if (g.untaught) return 'untaught';
  const parts: string[] = [];
  if (g.uf !== undefined) parts.push(`UF:${g.uf}`);
  if (g.ut !== undefined) parts.push(`UT:${g.ut}`);
  const order = g.kind === 'joint' ? Object.keys(g.values) : ['X', 'Y', 'Z', 'W', 'P', 'R', ...Object.keys(g.values).filter(k => /^E\d/.test(k))];
  const vals = order.filter(k => g.values[k]).map(k => `${k} ${fmt(g.values[k].value)}`);
  return [parts.join(' '), vals.join('  ')].filter(Boolean).join('  ');
}

export function positionMarkdown(pos: TpPosition): string {
  const out: string[] = [];
  out.push(`**P[${pos.index}${pos.comment ? `:"${pos.comment}"` : ''}]**`);
  for (const g of pos.groups) {
    const head = [`GP${g.group}`];
    if (g.untaught) { out.push('', `_GP${g.group} — ⚠ **untaught**: the block exists but holds no position (\`UF : F, UT : F\`, \`********\`). A motion to it faults on the controller._`); continue; }
    if (g.uf !== undefined) head.push(`UF ${g.uf}`);
    if (g.ut !== undefined) head.push(`UT ${g.ut}`);
    if (g.config) head.push(`CONFIG '${g.config}'`);
    out.push('', `_${head.join(' · ')}_`, '');
    out.push('| Axis | Value |', '|---|---|');
    for (const [k, v] of Object.entries(g.values)) out.push(`| ${k} | ${fmt(v.value)} ${v.unit} |`);
  }
  return out.join('\n');
}

function fmt(n: number): string {
  return Number.isInteger(n) ? n.toString() : n.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}
