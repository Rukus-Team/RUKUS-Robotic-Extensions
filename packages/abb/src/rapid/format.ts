/**
 * RAPID indentation, Visual Basic style: every line's indent follows from the blocks it is in,
 * nothing else changes. MODULE and ENDMODULE sit in column 0; everything inside the module
 * starts at the BASE indent (the customer's: 2 on most controllers in the corpus, 4 on many);
 * each block adds one STEP.
 *
 *     MODULE Main                         base 2, step 4:
 *       VAR num n := 0;
 *       PROC main()
 *           IF n > 0 THEN
 *               TPWrite "n";
 *           ELSE
 *               n := 1;
 *           ENDIF
 *           TEST n                        CASE and DEFAULT sit with their TEST,
 *           CASE 1:                       their bodies one step in (as the controller does)
 *               Stop;
 *           ENDTEST
 *       ERROR                             a handler sits with its routine, its body one step in
 *           RETRY;
 *       ENDPROC
 *     ENDMODULE
 *
 * A statement wrapped over several lines keeps its continuation lines where they were relative
 * to its first line, so arguments aligned by hand stay aligned. Full-line comments take the
 * indent of the code they are in. Whitespace-only lines become empty. The `%%%` header of a
 * system-module file, and anything before MODULE, are left alone. Pure: text in, line edits out.
 */
import { lexRapid, type Token } from './lexer';

export interface RapidIndent {
  /** spaces before everything inside MODULE */
  base: number;
  /** spaces added per block level */
  step: number;
  /** indent with tabs (one tab = `tabWidth` columns, any remainder in spaces) instead of spaces */
  useTabs?: boolean;
  /** columns a tab stands for, when reading indents and when writing them with useTabs (default 4) */
  tabWidth?: number;
}

/** the leading whitespace for `cols` columns */
export function indentText(cols: number, opt: Pick<RapidIndent, 'useTabs' | 'tabWidth'> = {}): string {
  const tw = Math.max(1, opt.tabWidth ?? 4);
  return opt.useTabs ? '\t'.repeat(Math.floor(cols / tw)) + ' '.repeat(cols % tw) : ' '.repeat(cols);
}

export interface RapidLineEdit { line: number; newText: string }

const U = (t: Token | undefined) => (t?.kind === 'ident' ? t.text.toUpperCase() : t?.text ?? '');
const indentOf = (s: string, tabWidth = 4) => /^[ \t]*/.exec(s)![0].replace(/\t/g, ' '.repeat(Math.max(1, tabWidth))).length;

interface Stmt { first: number; last: number; tokens: Token[] }

/** Split a module's lines into statements: runs of lines that make one RAPID statement or block header. */
function statements(tokens: Token[]): Stmt[] {
  const byLine = new Map<number, Token[]>();
  for (const t of tokens) { const a = byLine.get(t.line); if (a) a.push(t); else byLine.set(t.line, [t]); }
  const lines = [...byLine.keys()].sort((a, b) => a - b);
  const out: Stmt[] = [];
  let cur: Stmt | undefined;
  let depth = 0;   // ( and [ depth: a line break inside brackets never ends a statement
  for (const ln of lines) {
    const toks = byLine.get(ln)!;
    if (!cur) cur = { first: ln, last: ln, tokens: [] };
    cur.last = ln;
    for (const t of toks) {
      cur.tokens.push(t);
      if (t.text === '(' || t.text === '[') depth++;
      else if ((t.text === ')' || t.text === ']') && depth > 0) depth--;
    }
    const lastTok = toks[toks.length - 1];
    if (depth === 0 && (lastTok.text === ';' || endsHeader(cur.tokens))) { out.push(cur); cur = undefined; }
  }
  if (cur) out.push(cur);
  return out;
}

/** A statement that ends at the end of its line without a `;`: block headers, closers, labels. */
function endsHeader(toks: Token[]): boolean {
  const f = U(toks[0]), l = U(toks[toks.length - 1]);
  const f2 = U(toks[1]);
  const lead = f === 'LOCAL' || f === 'TASK' ? f2 : f;
  if ((f === 'IF' || f === 'ELSEIF') ) return l === 'THEN';
  if (f === 'FOR' || f === 'WHILE') return l === 'DO';
  if (f === 'CASE' || f === 'DEFAULT') return l === ':';
  if (['ELSE', 'TEST', 'MODULE', 'ENDMODULE', 'ERROR', 'UNDO', 'BACKWARD', 'ENDPROC', 'ENDFUNC', 'ENDTRAP', 'ENDRECORD', 'ENDIF', 'ENDFOR', 'ENDWHILE', 'ENDTEST', 'RECORD'].includes(lead)) return true;
  if (lead === 'PROC' || lead === 'TRAP' || lead === 'FUNC') return l === ')';
  // a label: `name:` alone on its line
  return toks.length === 2 && toks[0].kind === 'ident' && toks[1].text === ':';
}

type FrameKind = 'MODULE' | 'ROUTINE' | 'RECORD' | 'IF' | 'FOR' | 'WHILE' | 'TEST';
interface Frame { kind: FrameKind; level: number }

const CLOSER: Record<string, FrameKind> = { ENDPROC: 'ROUTINE', ENDFUNC: 'ROUTINE', ENDTRAP: 'ROUTINE', ENDRECORD: 'RECORD', ENDIF: 'IF', ENDFOR: 'FOR', ENDWHILE: 'WHILE', ENDTEST: 'TEST', ENDMODULE: 'MODULE' };

/**
 * The indent every line should have, by line number; undefined for a line to leave alone
 * (the header before MODULE, and lines in an encrypted or unparseable file).
 */
export function rapidIndents(text: string, opt: RapidIndent): (number | undefined)[] {
  const lex = lexRapid(text);
  const lines = lex.lines;
  const want: (number | undefined)[] = new Array(lines.length).fill(undefined);
  // MODULE as a statement: first on its line, followed by the module's name
  const modTok = lex.tokens.findIndex((t, i) => t.kind === 'ident' && /^MODULE$/i.test(t.text)
    && (i === 0 || lex.tokens[i - 1].line < t.line) && lex.tokens[i + 1]?.kind === 'ident');
  if (modTok < 0) return want;
  const startLine = lex.tokens[modTok].line;
  const stmts = statements(lex.tokens.slice(modTok));

  const at = (level: number) => (level < 0 ? 0 : opt.base + level * opt.step);
  const stack: Frame[] = [];
  let level = -1;
  const popTo = (kind: FrameKind): Frame | undefined => {
    for (let i = stack.length - 1; i >= 0; i--) if (stack[i].kind === kind) { const f = stack[i]; stack.length = i; return f; }
    return undefined;
  };
  const top = (kind: FrameKind): Frame | undefined => { for (let i = stack.length - 1; i >= 0; i--) if (stack[i].kind === kind) return stack[i]; return undefined; };

  /** where each statement's first line goes; comment-only lines take the level in force when they are reached */
  const stmtAt = new Map<number, Stmt>();
  for (const s of stmts) stmtAt.set(s.first, s);
  const levelBefore: number[] = new Array(lines.length).fill(-1);

  for (const s of stmts) {
    const f = U(s.tokens[0]);
    const lead = f === 'LOCAL' || f === 'TASK' ? U(s.tokens[1]) : f;
    const last = U(s.tokens[s.tokens.length - 1]);
    let lv = level;
    if (lead === 'MODULE') { lv = -1; stack.length = 0; stack.push({ kind: 'MODULE', level: -1 }); level = 0; }
    else if (CLOSER[lead]) {
      const fr = popTo(CLOSER[lead]);
      lv = fr ? fr.level : Math.max(level - 1, 0);
      level = lead === 'ENDMODULE' ? -1 : lv;
    } else if (lead === 'ELSEIF' || lead === 'ELSE') {
      const fr = top('IF'); if (fr) { while (stack[stack.length - 1] !== fr) stack.pop(); lv = fr.level; level = fr.level + 1; }
    } else if (lead === 'CASE' || lead === 'DEFAULT') {
      const fr = top('TEST'); if (fr) { while (stack[stack.length - 1] !== fr) stack.pop(); lv = fr.level; level = fr.level + 1; }
    } else if ((lead === 'ERROR' || lead === 'UNDO' || lead === 'BACKWARD') && (s.tokens.length === 1 || s.tokens[1]?.text === '(') && top('ROUTINE')) {
      // a handler (`ERROR`, `ERROR (ERR_X, ERR_Y)`) - not the ERROR data type in a declaration
      const fr = top('ROUTINE')!; while (stack[stack.length - 1] !== fr) stack.pop(); lv = fr.level; level = fr.level + 1;
    } else {
      lv = level;
      const opens =
        lead === 'PROC' || lead === 'FUNC' || lead === 'TRAP' ? 'ROUTINE'
        : lead === 'RECORD' ? 'RECORD'
        : lead === 'IF' && last === 'THEN' ? 'IF'
        : (lead === 'FOR' || lead === 'WHILE') && last === 'DO' ? lead
        : lead === 'TEST' ? 'TEST' : undefined;
      if (opens) { stack.push({ kind: opens as FrameKind, level: lv }); level = opens === 'TEST' ? lv : lv + 1; }
    }
    // the statement's own lines
    const origFirst = indentOf(lines[s.first], opt.tabWidth);
    const newFirst = at(lv);
    want[s.first] = newFirst;
    for (let ln = s.first + 1; ln <= s.last; ln++) {
      if (!lines[ln].trim()) continue;
      want[ln] = Math.max(newFirst, newFirst + (indentOf(lines[ln], opt.tabWidth) - origFirst));
    }
    for (let ln = s.last + 1; ln < lines.length; ln++) levelBefore[ln] = level;
  }
  // full-line comments (and blank lines) between statements
  for (let ln = startLine; ln < lines.length; ln++) {
    if (want[ln] !== undefined) continue;
    const t = lines[ln].trim();
    if (!t) { want[ln] = 0; continue; }
    if (t.startsWith('!')) {
      // a comment right before a closer or a middle (ELSE, CASE, ENDPROC ...) belongs to the code above it
      want[ln] = at(levelBefore[ln] ?? 0);
    }
  }
  return want;
}

/** Edits that re-indent `text`; only lines whose leading whitespace changes. */
export function formatRapid(text: string, opt: RapidIndent, range?: { start: number; end: number }): RapidLineEdit[] {
  const lines = text.split(/\r?\n/);
  const want = rapidIndents(text, opt);
  const out: RapidLineEdit[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (range && (i < range.start || i > range.end)) continue;
    const w = want[i];
    if (w === undefined) continue;
    const body = lines[i].replace(/^[ \t]+/, '');
    const next = body ? indentText(w, opt) + body : '';
    if (next !== lines[i]) out.push({ line: i, newText: next });
  }
  return out;
}

/**
 * The base and step a file already uses, read off its routines: the indent of PROC/FUNC/TRAP
 * lines is the base, the most common first-line-in-a-block increase is the step. Undefined
 * parts when the file does not say (no routines, no blocks).
 */
export function detectRapidIndent(text: string): Partial<RapidIndent> {
  const lines = text.split(/\r?\n/);
  const base = new Map<number, number>(), step = new Map<number, number>();
  const inc = (m: Map<number, number>, k: number) => m.set(k, (m.get(k) ?? 0) + 1);
  let inRoutine = false;
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i].trim();
    if (/^(LOCAL\s+)?(PROC|FUNC|TRAP)\b/i.test(s)) { inc(base, indentOf(lines[i])); inRoutine = true; }
    else if (/^END(PROC|FUNC|TRAP)\b/i.test(s)) inRoutine = false;
    // module-level declarations say the base as well as routines do (a data-only module has nothing else)
    else if (!inRoutine && /^((LOCAL|TASK)\s+)?(VAR|PERS|CONST)\s/i.test(s)) inc(base, indentOf(lines[i]));
    if (/^((LOCAL\s+)?(PROC|FUNC|TRAP)\b|IF\b.*\bTHEN\s*(!.*)?$|FOR\b.*\bDO\s*(!.*)?$|WHILE\b.*\bDO\s*(!.*)?$)/i.test(s)) {
      let j = i + 1;
      while (j < lines.length && (!lines[j].trim() || lines[j].trim().startsWith('!'))) j++;
      if (j < lines.length && !/^\s*END/i.test(lines[j])) { const d = indentOf(lines[j]) - indentOf(lines[i]); if (d > 0 && d <= 8) inc(step, d); }
    }
  }
  const best = (m: Map<number, number>) => [...m.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0];
  // tabs when most indented lines start with one
  let tabbed = 0, spaced = 0;
  for (const l of lines) { if (l.startsWith('\t')) tabbed++; else if (/^ +\S/.test(l)) spaced++; }
  return { base: best(base), step: best(step), ...(tabbed + spaced ? { useTabs: tabbed > spaced } : {}) };
}
