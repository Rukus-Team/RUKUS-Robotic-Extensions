/**
 * TP line renumbering and normalisation. Pure functions returning per-line
 * replacements so the editor only touches lines that actually change.
 */
import { parseTp, type TpLine } from './parser';
import { reflowExtendedComment } from './extendedComment';

export interface RenumberOptions {
  /**
   * Reflow `--eg:` extended comments whose lines run past this many columns, the way the
   * pendant wraps them (see extendedComment.ts). 0 or undefined: leave them as they are.
   */
  extendedCommentWidth?: number;
  /** column width of the line number field (FANUC uses 4); 0 = as many digits as the number needs */
  width: number;
  /** text before the number field; the controller format has none, the custom style puts four spaces */
  indent?: string;
  /**
   * `show` writes the number and colon (the controller's way). `spaces` writes spaces where
   * the number and colon would have been, so the instruction column stays where it is;
   * `none` writes only the indent. Both are for reading and editing without the numbers;
   * switching back to `show` and renumbering puts them back. `scaffold` writes spaces the width
   * of the number field (at least the configured width, default four) plus a colon, so new
   * lines get a valid prefix without shifting existing line numbers.
   */
  number?: 'show' | 'ones' | 'spaces' | 'none' | 'scaffold';
  /** append " ;" to instruction lines that lack a terminator */
  autoSemicolon: boolean;
  /** document lines to leave untouched (e.g. the line the cursor is on) */
  skipLines?: Set<number>;
  /**
   * Touch only lines that carry no number yet (just typed or pasted); numbered lines and
   * continuations are left exactly as they are. The custom style works this way as you
   * edit, so switching to it does not rewrite the whole program.
   */
  onlyNew?: boolean;
  /** restrict edits to this range of document lines (a selection); LINE_COUNT is still updated */
  lines?: { start: number; end: number };
  /** also update LINE_COUNT in /ATTR */
  updateLineCount: boolean;
}

/**
 * One document line replaced. `newText` may hold several lines (an extended comment that
 * wrapped onto more lines than it had); `remove` deletes the line altogether (one that
 * wrapped onto fewer). Everything else is one line for one line.
 */
export interface LineEdit { line: number; newText: string; remove?: boolean }

export interface RenumberResult {
  edits: LineEdit[];
  lineCount: number;
}

const RE_NUMBERED = /^(\s*)(\d+):(.*)$/;
const RE_CONT = /^(\s*):(.*)$/;

/** Width (in spaces) of the blank prefix a scaffold line gets: the number field, never narrower than the configured width. */
function scaffoldWidth(lines: string[], mn: number, posOrEnd: number, fallback: number): number {
  let max = 0;
  for (let i = mn + 1; i < posOrEnd; i++) {
    const m = RE_NUMBERED.exec(lines[i]);
    if (m) { const n = Number(m[2]); if (n > max) max = n; }
  }
  // The number column is a fixed field, not the digit count: a controller writes `  25:` and
  // ` 100:` in the same four-wide column. Padding a scaffold to the number of digits left it
  // three columns shy of the others in a short program (`  :` where the lines have `  25:`).
  return Math.max(max > 0 ? String(max).length : 0, fallback, 4);
}

export function renumber(text: string, opts: RenumberOptions): RenumberResult {
  const prog = parseTp(text);
  const lines = text.split(/\r?\n/);
  const edits: LineEdit[] = [];
  const mn = prog.sections.mn;
  const posOrEnd = prog.sections.pos ?? prog.sections.end ?? lines.length;
  if (mn === undefined) return { edits, lineCount: 0 };
  const lineAt = new Map(prog.lines.map(l => [l.line, l] as const));
  // does document line `j` continue the line above it? (the parser decides, by context)
  const continues = (j: number) => { const nx = lineAt.get(j); return !!nx && (nx.kind === 'continuation' || (nx.ext === true && nx.seq === undefined)); };

  const scaffoldW = opts.number === 'scaffold' ? scaffoldWidth(lines, mn, posOrEnd, opts.width || 4) : 0;

  let n = 0;
  for (let i = mn + 1; i < posOrEnd; i++) {
    const raw = lines[i];
    const skip = opts.skipLines?.has(i) ?? false;
    const numbered = RE_NUMBERED.exec(raw);
    // A `:` line is a continuation only when the parser says the line above left something
    // to continue (a circular move or an extended comment without its terminator). Any
    // other `:` line is a numberless instruction - the `spaces` style writes exactly that.
    const colon = numbered ? null : RE_CONT.exec(raw);
    const parsed = colon ? lineAt.get(i) : undefined;
    const cont = colon && (parsed?.kind === 'continuation' || (parsed?.ext && parsed.seq === undefined)) ? colon : null;
    const bare = colon && !cont ? colon : null;   // numberless line written with its colon

    let body: string;
    let isContinuation = false;
    if (numbered) body = numbered[3];
    else if (cont) { body = cont[2]; isContinuation = true; }
    else if (bare) body = bare[2];
    else body = raw;

    const inRange = !opts.lines || (i >= opts.lines.start && i <= opts.lines.end);
    if (isContinuation) {
      // never numbered, but may need a terminator
      const fixed = skip || opts.onlyNew || !inRange ? raw : ensureTerminator(raw, continues(i + 1), opts.autoSemicolon);
      if (fixed !== raw) edits.push({ line: i, newText: fixed });
      continue;
    }

    n++;
    if (skip || !inRange) continue;
    if (opts.onlyNew && (numbered || bare)) continue;   // a numberless line with its colon is styled already

    // `ones` writes `1:` on every line - the number as a marker, not a count
    const style = opts.number === 'ones' ? 'show' : (opts.number ?? 'show');
    const field = opts.number === 'scaffold' ? ' '.repeat(scaffoldW) : (opts.number === 'ones' ? '1' : String(n)).padStart(opts.width, ' ');
    const indent = opts.indent ?? '';
    // `spaces` keeps the colon: the digits become spaces, the `:` stays, so the line still
    // reads as a TP line and the instruction column does not move.
    // `none` keeps it too: the number is simply gone, `    :  R[1]=1`.
    // `scaffold` writes spaces matching the highest existing number width + colon.
    const head = style === 'show' ? indent + field + ':' : style === 'spaces' || style === 'scaffold' ? indent + ' '.repeat(field.length) + ':' : indent + ':';
    let newBody: string;
    if (numbered && style === 'show') {
      newBody = body;
    } else if (numbered || bare) {
      newBody = body;                                  // the line had a colon: its body keeps its own spacing
    } else {
      // Unnumbered (just typed): the body is laid out from its own text. Motion lines hug
      // the colon, everything else gets two spaces.
      const t = raw.trim();
      if (t === '') newBody = '';
      else if (/^[JLCAS]\s+(P|PR)\[/.test(t) || /^[JLCAS]\s/.test(t)) newBody = t;
      else newBody = '  ' + t;
    }
    // In scaffold mode with autoSemicolon on, blank lines should still get the terminator.
    const scaffoldNumbered = style === 'scaffold' && opts.autoSemicolon;
    const newRaw = withTerminator(head, newBody, continues(i + 1), opts.autoSemicolon, style === 'show' || scaffoldNumbered);
    if (newRaw !== raw) edits.push({ line: i, newText: newRaw });
  }

  if (opts.extendedCommentWidth) reflowExtendedComments(lines, prog.lines, mn, posOrEnd, opts, edits);

  if (opts.updateLineCount) {
    const lc = prog.header.attrs.get('LINE_COUNT');
    if (lc && lc.value !== String(n)) {
      const raw = lines[lc.line];
      const replaced = raw.replace(/(LINE_COUNT\s*=\s*)\d+/, `$1${n}`);
      if (replaced !== raw) edits.push({ line: lc.line, newText: replaced });
    }
  }

  return { edits, lineCount: n };
}

/**
 * Head (number field, or the spaces standing in for it) plus body, with the terminator
 * rule applied to the body. A blank line becomes the `   ;` scaffold only when terminators
 * are being added AND the number is shown - without numbers a scaffold is just clutter,
 * and a blank stays blank rather than becoming a line of trailing spaces.
 */
function withTerminator(head: string, body: string, nextContinues: boolean, addTerminator: boolean, numbered: boolean): string {
  const trimmed = body.trimEnd();
  // A blank line keeps its head when the head has a colon (`  21:` or `     :`), so it still
  // counts as a line; a head of bare indent would leave trailing spaces, so that line goes empty.
  if (trimmed === '') return addTerminator && numbered ? head + '   ;' : head.trim() ? head : '';
  if (!addTerminator || trimmed.endsWith(';')) return head + body;
  if (nextContinues) return head + body;
  return head + trimmed + ' ;';
}

function ensureTerminator(raw: string, nextContinues: boolean, enabled: boolean): string {
  if (!enabled) return raw;
  const bodyMatch = /^(\s*\d*:)(.*)$/.exec(raw);
  if (!bodyMatch) return raw;
  const body = bodyMatch[2];
  const trimmed = body.trimEnd();
  if (trimmed === '') return bodyMatch[1] + '   ;';
  if (trimmed.endsWith(';')) return raw;
  // The next line continues this one - the second half of a circular move, or the next line
  // of a `--eg:` extended comment - and the terminator belongs on the last line of the
  // group, not here. Adding one to line 1 of an extended comment used to split it in two.
  if (nextContinues) return raw;
  return bodyMatch[1] + trimmed + ' ;';
}

export interface LabelRenumberResult {
  /** character-level replacements: [line, col, len, newText] */
  edits: Array<{ line: number; col: number; len: number; newText: string }>;
  mapping: Array<{ from: number; to: number }>;
  /** labels referenced indirectly (JMP LBL[R[n]]) that cannot be followed */
  indirectJumps: number;
}

/**
 * Renumber labels in order of appearance (start, start+step, …) and update every
 * JMP / TIMEOUT / Skip / VISION reference. Comments on labels are kept.
 */
export function renumberLabels(text: string, opts: { start: number; step: number }): LabelRenumberResult {
  const prog = parseTp(text);
  const lines = text.split(/\r?\n/);
  const labels = [...prog.labels].sort((a, b) => a.line - b.line);
  const mapping = new Map<number, number>();
  labels.forEach((l, i) => { if (!mapping.has(l.num)) mapping.set(l.num, opts.start + i * opts.step); });
  const edits: LabelRenumberResult['edits'] = [];
  const replaceNum = (line: number, col: number, len: number, oldNum: number) => {
    const to = mapping.get(oldNum);
    if (to === undefined || to === oldNum) return;
    const seg = lines[line].slice(col, col + len);
    const m = /LBL\[(\d+)/.exec(seg);
    if (!m) return;
    edits.push({ line, col: col + m.index + 4, len: m[1].length, newText: String(to) });
  };
  for (const l of labels) replaceNum(l.span.line, l.span.col, l.span.len, l.num);
  for (const j of prog.jumps) replaceNum(j.span.line, j.span.col, j.span.len, j.num);
  const indirectJumps = lines.reduce((n, l) => n + (/\bLBL\[\s*R\[/.test(l) ? 1 : 0), 0);
  return { edits, mapping: [...mapping.entries()].map(([from, to]) => ({ from, to })).filter(x => x.from !== x.to), indirectJumps };
}

/** Apply LineEdits to text (used by tests and by the "copy without positions" command). */
export function applyLineEdits(text: string, edits: LineEdit[]): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines: Array<string | undefined> = text.split(/\r?\n/);
  for (const e of edits) lines[e.line] = e.remove ? undefined : e.newText;
  return lines.filter((l): l is string => l !== undefined).join(eol);
}

/**
 * Every `--eg:` extended comment in /MN with a line wider than the pendant writes is
 * rewritten to the pendant's wrapping. A comment with the cursor on one of its lines, or
 * partly outside the selection being renumbered, is left alone - half a reflow is worse
 * than none. The first line keeps whatever head the main pass gave it.
 */
function reflowExtendedComments(lines: string[], parsed: TpLine[], mn: number, posOrEnd: number, opts: RenumberOptions, edits: LineEdit[]): void {
  const width = opts.extendedCommentWidth ?? 0;
  if (width <= 0) return;
  const byLine = new Map(edits.map(e => [e.line, e] as const));
  let i = 0;
  while (i < parsed.length) {
    const first = parsed[i];
    if (!(first.ext && first.seq !== undefined && first.line > mn && first.line < posOrEnd)) { i++; continue; }
    const group = [first];
    let j = i + 1;
    while (j < parsed.length && parsed[j].ext && parsed[j].seq === undefined && parsed[j].line === group[group.length - 1].line + 1) group.push(parsed[j++]);
    i = j;
    const skipped = group.some(l => opts.skipLines?.has(l.line) || (opts.lines && (l.line < opts.lines.start || l.line > opts.lines.end)));
    if (skipped) continue;
    const raw = group.map(l => byLine.get(l.line)?.newText ?? lines[l.line]);
    const flowed = reflowExtendedComment(raw, width);
    if (!flowed) continue;
    for (const l of group) { const e = byLine.get(l.line); if (e) edits.splice(edits.indexOf(e), 1); }
    const out = flowed.lines;
    group.forEach((l, k) => {
      const last = k === group.length - 1;
      if (k < out.length && !last) edits.push({ line: l.line, newText: out[k] });
      else if (last && k < out.length) edits.push({ line: l.line, newText: out.slice(k).join('\n') });   // grew: the rest ride on the last old line
      else edits.push({ line: l.line, newText: '', remove: true });                                       // shrank: this old line goes
    });
  }
}

/** what the caret line becomes when Enter is pressed at the end of a comment line */
export interface CommentScaffold {
  /** the caret line's new text */
  newText: string;
  /** where the caret goes: after the `!` or after the continuation's `:  ` */
  caretCol: number;
  /** the line above loses its ` ;` (it is now the middle of an extended comment) */
  stripPrevTerminator: boolean;
}

/**
 * Enter at the end of a comment line keeps the next line a comment, the way the pendant's
 * editor does and every code editor does for `//`:
 *
 *     5:  !EXIT ZONE ;        Enter ->     6:  ! ;          caret after the `!`
 *     6:  --eg: some text ;   Enter ->     6:  --eg: some text
 *                                           :   ;          caret after `:  `
 *
 * A comment line with nothing after its `!` (or an empty continuation) ends the run: Enter
 * there gives the ordinary `  7:   ;` scaffold, so two Enters get you out of a comment.
 * `scaffoldRaw` is the caret line as the renumber left it (`  12:   ;` or `     :   ;`);
 * `prev` is the parsed line above. `undefined` when there is nothing to continue.
 */
export function commentScaffold(prev: TpLine | undefined, scaffoldRaw: string): CommentScaffold | undefined {
  if (!prev || prev.kind !== 'comment') return undefined;
  const head = /^(\s*(?:\d+|\s*):)/.exec(scaffoldRaw)?.[1];
  if (!head) return undefined;
  if (prev.ext) {
    const text = prev.body.replace(/^--eg:?\s*/i, '').replace(/^:\s*/, '').trim();
    if (!text) return undefined;
    // the continuation head mirrors the number field: `  12:` -> `    :`
    const contHead = head.replace(/\d/g, ' ');
    return { newText: `${contHead}   ;`, caretCol: contHead.length + 2, stripPrevTerminator: /;\s*$/.test(prev.raw) };
  }
  if (!/^!/.test(prev.body)) return undefined;
  if (!prev.body.slice(1).trim()) return undefined;
  return { newText: `${head}  ! ;`, caretCol: head.length + 3, stripPrevTerminator: false };
}

/** Return the program with the /POS section emptied (positions removed but /POS kept). */
export function stripPositions(text: string): string {
  const prog = parseTp(text);
  if (prog.sections.pos === undefined) return text;
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const end = prog.sections.end ?? lines.length;
  return [...lines.slice(0, prog.sections.pos + 1), ...lines.slice(end)].join(eol);
}
