/**
 * ABB RAPID tokenizer. Pure TypeScript, no VS Code dependency.
 *
 * Why tokens and not lines, when the FANUC parsers are line-oriented: a TP line IS a
 * statement, but a RAPID statement ends at `;`, not at the end of the line. The IRC5
 * backups this was written against wrap declarations (`PERS tooldata Tool,` ... `;`),
 * routine headers (`FUNC num GetWeldEquipNr(` / `gunnum Gun)`), long SpotL argument lists
 * and compact IFs over several lines, well over a thousand times each. A line regex
 * would see half a statement. So the text is cut into tokens first, each still carrying
 * its own line and column, and the parser groups tokens into statements.
 *
 * Tokens never span lines: RAPID has no multi-line strings or block comments, so every
 * token has a single-line {@link Span} - which is what the editor-side providers need.
 *
 * The lexer never throws and never drops a character silently: anything it does not
 * recognise becomes a one-character `op` token, so a stray `#` or a Latin-1 byte in the
 * code (not just in a comment) still ends up somewhere the parser can report.
 */

import type { Span } from '@core/span';

export type TokKind =
  | 'ident'        // Name, keyword or type - the parser decides which
  | 'num'          // 12, 1.5, 9E+09, .5, 0xFF
  | 'str'          // "text" with "" and \\ escapes, quotes included
  | 'op'           // := <> <= >= and every single punctuation character
  | 'placeholder'; // <SMT>, <EXP>, ... - the pendant's "fill me in" markers

export interface Token {
  kind: TokKind;
  text: string;
  /** 0-based line */
  line: number;
  /** 0-based column on that line */
  col: number;
  /** absolute offset of the first character in the source text */
  off: number;
  /** absolute offset one past the last character */
  end: number;
}

export interface RapidComment {
  /** the text after `!`, untrimmed */
  text: string;
  /** span of the whole comment including the `!` */
  span: Span;
  /** true when nothing but whitespace precedes the `!` on its line */
  fullLine: boolean;
}

export interface LexResult {
  tokens: Token[];
  comments: RapidComment[];
  /** the source split into lines (CR LF or LF), for slicing and length clamps */
  lines: string[];
  /** absolute offset where each line starts */
  lineStarts: number[];
}

/**
 * The pendant's placeholder markers. A routine created on the FlexPendant and not yet
 * filled in holds `<SMT>` (statement); expressions left open hold `<EXP>`, `<ARG>`, `<VAR>`,
 * `<ID>` and friends. They are only recognised with exactly these names so that `a<B>c`
 * stays a comparison.
 */
const PLACEHOLDERS = /^<(SMT|EXP|ARG|VAR|ID|DDN|RDN|PAR|TDN|CSE|ANY|DIM|TYPE|ELSEIF|ELSE)>/;

const TWO_CHAR_OPS = new Set([':=', '<>', '<=', '>=']);

/** Tokenize RAPID source. Never throws. */
export function lexRapid(text: string): LexResult {
  const tokens: Token[] = [];
  const comments: RapidComment[] = [];
  const lines: string[] = [];
  const lineStarts: number[] = [];
  // split keeping offsets; a lone CR is treated as a line break too (old editors)
  {
    let start = 0;
    for (let i = 0; i <= text.length; i++) {
      const c = text.charCodeAt(i);
      if (i === text.length || c === 10 || c === 13) {
        lines.push(text.slice(start, i));
        lineStarts.push(start);
        if (c === 13 && text.charCodeAt(i + 1) === 10) i++;
        start = i + 1;
      }
    }
  }

  for (let ln = 0; ln < lines.length; ln++) {
    const s = lines[ln];
    const base = lineStarts[ln];
    let i = 0;
    let sawCode = false;
    while (i < s.length) {
      const c = s[i];
      if (c === ' ' || c === '\t' || c === '\f' || c === '\v' || c === ' ') { i++; continue; }
      const push = (kind: TokKind, len: number) => {
        tokens.push({ kind, text: s.substr(i, len), line: ln, col: i, off: base + i, end: base + i + len });
        i += len; sawCode = true;
      };
      if (c === '!') {
        comments.push({ text: s.slice(i + 1), span: { line: ln, col: i, len: s.length - i }, fullLine: !sawCode });
        break;
      }
      if (c === '"') {
        // "" is an escaped quote; \\ and \hh are escapes too, but they never contain a
        // quote, so only "" needs care. An unterminated string runs to the end of the line.
        let j = i + 1;
        while (j < s.length) {
          if (s[j] === '"') { if (s[j + 1] === '"') { j += 2; continue; } j++; break; }
          j++;
        }
        push('str', j - i);
        continue;
      }
      if (/[A-Za-z_]/.test(c)) {
        let j = i + 1;
        while (j < s.length && /[A-Za-z0-9_]/.test(s[j])) j++;
        push('ident', j - i);
        continue;
      }
      if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(s[i + 1] ?? ''))) {
        const m = /^(0[xX][0-9A-Fa-f]+|0[bB][01]+|0[oO][0-7]+|(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?)/.exec(s.slice(i));
        push('num', m ? m[0].length : 1);
        continue;
      }
      if (c === '<') {
        const m = PLACEHOLDERS.exec(s.slice(i));
        if (m) { push('placeholder', m[0].length); continue; }
      }
      const two = s.substr(i, 2);
      if (TWO_CHAR_OPS.has(two)) { push('op', 2); continue; }
      push('op', 1);
    }
  }
  return { tokens, comments, lines, lineStarts };
}

/** RAPID's reserved words (RAPID Kernel reference, "Reserved words"). Upper-case. */
export const RAPID_RESERVED = new Set([
  'ALIAS', 'AND', 'BACKWARD', 'CASE', 'CONNECT', 'CONST', 'DEFAULT', 'DIV', 'DO', 'ELSE', 'ELSEIF',
  'ENDFOR', 'ENDFUNC', 'ENDIF', 'ENDMODULE', 'ENDPROC', 'ENDRECORD', 'ENDTEST', 'ENDTRAP', 'ENDWHILE',
  'ERROR', 'EXIT', 'FALSE', 'FOR', 'FROM', 'FUNC', 'GOTO', 'IF', 'INOUT', 'LOCAL', 'MOD', 'MODULE',
  'NOSTEPIN', 'NOT', 'NOVIEW', 'OR', 'PERS', 'PROC', 'RAISE', 'READONLY', 'RECORD', 'RETRY', 'RETURN',
  'STEP', 'SYSMODULE', 'TASK', 'TEST', 'THEN', 'TO', 'TRAP', 'TRUE', 'TRYNEXT', 'UNDO', 'VAR',
  'VIEWONLY', 'WHILE', 'WITH', 'XOR',
]);

/**
 * True when the text is not RAPID source at all but one of the controller's encrypted
 * modules. About half of the distinct .sys files in the IRC5 corpus are: SpotWare and
 * the site's own "GenRob" library ship some modules encrypted, and the backup stores them
 * as-is. They start with a 0xFC/0xFE byte and are full of control characters; a real
 * module is text (Latin-1 at most) and starts with `MODULE`, a `!` comment or `%%%`.
 */
export function looksEncrypted(text: string): boolean {
  if (!text.length) return false;
  const first = text.charCodeAt(0);
  if (first >= 0xf0 && first <= 0xff) return true;
  const sample = text.slice(0, 4096);
  let ctrl = 0;
  for (let i = 0; i < sample.length; i++) {
    const c = sample.charCodeAt(i);
    if (c < 32 && c !== 9 && c !== 10 && c !== 13 && c !== 12) ctrl++;
  }
  return ctrl > Math.max(2, sample.length / 200);
}
