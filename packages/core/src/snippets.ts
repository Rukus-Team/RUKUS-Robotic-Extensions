/**
 * The extension's snippets (snippets/*.json), offered by the completion providers instead of as a
 * static `contributes.snippets` list. VS Code shows a static snippet wherever the word being typed
 * fuzzy-matches its prefix - so the `THEN` of a half-written `IF (R[1]=1) TH` matched `ifthen` and
 * taking it wrote a second, whole IF block into the line. Served from here a snippet is offered
 * only where its statement can start, and a block statement that is already under way is offered
 * its remainder instead (`THEN ... ENDIF`, `DO ... ENDFOR`, `OF ... ENDSELECT`).
 *
 * No vscode import: the providers turn these into completion items, the unit tests read them as is.
 */

export interface Snippet {
  name: string;
  /** what the user types; the first one is the label */
  prefixes: string[];
  /** snippet syntax, lines joined with \n */
  body: string;
  description?: string;
}

type SnippetFile = Record<string, { prefix: string | string[]; body: string | string[]; description?: string }>;

export function readSnippets(json: SnippetFile): Snippet[] {
  return Object.entries(json).map(([name, s]) => ({
    name,
    prefixes: Array.isArray(s.prefix) ? s.prefix : [s.prefix],
    body: Array.isArray(s.body) ? s.body.join('\n') : s.body,
    description: s.description,
  }));
}

export type SnippetLanguage = 'tp' | 'karel' | 'rapid';

/** The rest of a block statement, from the keyword that ends its first line (THEN, DO, OF) on */
export interface BlockTail {
  /** the word that starts the statement: IF, FOR, WHILE, SELECT */
  head: string;
  /** the keyword the tail starts with: THEN, DO, OF */
  pivot: string;
  /** the word that closes the block: ENDIF, ENDFOR, ... */
  closer: string;
  /** `THEN ... ENDIF` */
  label: string;
  /** snippet syntax */
  insert: string;
  /** the snippet it is the tail of */
  from: string;
}

const PIVOTS = 'THEN|DO|OF';

/**
 * The block tails a snippet list implies: every multi-line snippet whose first line is
 * `HEAD <placeholder> PIVOT` gives `PIVOT` + the lines under it. A first line with nothing to fill
 * in (KAREL's `IF status <> 0 THEN` check) is a whole statement, not a block to finish.
 */
export function blockTails(snippets: readonly Snippet[]): BlockTail[] {
  const out: BlockTail[] = [];
  const seen = new Set<string>();
  for (const s of snippets) {
    const lines = s.body.split('\n');
    if (lines.length < 2) continue;
    const m = new RegExp(`^([A-Za-z]+)\\b.*\\$\\{.*\\}.*?\\b((?:${PIVOTS})\\b[^$]*)$`).exec(lines[0]);
    const closer = /^([A-Za-z]+)/.exec(lines[lines.length - 1])?.[1];
    if (!m || !closer) continue;
    const insert = [m[2], ...lines.slice(1)].join('\n');
    if (seen.has(insert)) continue;
    seen.add(insert);
    const pivot = /^[A-Za-z]+/.exec(m[2])![0];
    // the keywords at the left edge of the lines under it: THEN ... ELSE ... ENDIF
    const steps = lines.slice(1).map(l => /^([A-Za-z]+)/.exec(l)?.[1]).filter((x): x is string => !!x);
    out.push({ head: m[1].toUpperCase(), pivot: pivot.toUpperCase(), closer: closer.toUpperCase(), label: [pivot, ...steps].join(' … '), insert, from: s.name });
  }
  return out;
}

/** A line without its comment and with its strings as underscores (same length up to the comment) */
function codeOf(lang: SnippetLanguage, line: string): string {
  if (lang === 'tp') {
    const head = /^\s*\d*:\s*|^\s*/.exec(line)![0];
    const body = line.slice(head.length);
    if (/^(!|\/\/|--[a-z]{2}\b)/i.test(body)) return ' '.repeat(head.length);
    return ' '.repeat(head.length) + body.replace(/'[^']*'?|"[^"]*"?/g, x => '_'.repeat(x.length));
  }
  const quote = lang === 'karel' ? "'" : '"';
  let out = '', inStr = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === quote) { inStr = !inStr; out += '_'; continue; }
    if (!inStr && (lang === 'karel' ? c === '-' && line[i + 1] === '-' : c === '!')) break;
    out += inStr ? '_' : c;
  }
  return out;
}

const word = (w: string) => new RegExp(`\\b${w}\\b`, 'i');
/** a condition still being written ends on an operator: `IF x =`, `IF a AND`, `FOR i = 1 TO` */
const UNFINISHED = /(?:[=<>+\-*/(,:]|\b(?:AND|OR|NOT|DIV|MOD|TO|DOWNTO|FROM|STEP|IF|FOR|WHILE|SELECT|ELSEIF))$/i;

export interface BlockContinuation {
  /** the part of the pivot keyword already typed (may be empty), ending at the caret */
  word: string;
  /** how much after the caret the insert replaces: a TP line's own ` ;` */
  tail: number;
  /** the pivot keyword on its own, for a block whose closing line is already there - or first, then the tails */
  keyword: string;
  tails: BlockTail[];
}

/**
 * Is the caret (line, col) where the keyword that ends a block statement's first line goes - the
 * statement's head and a finished condition before it, nothing after it? Then: the keyword, and
 * the block tails that fit, unless the document already has this block's closing line (one more
 * closer than complete openers), in which case the keyword alone is what is missing.
 */
export function blockContinuation(lang: SnippetLanguage, tails: readonly BlockTail[], lines: readonly string[] | { lineCount: number; lineAt(i: number): string }, line: number, col: number): BlockContinuation | undefined {
  const count = 'lineCount' in lines ? lines.lineCount : lines.length;
  const at = (i: number) => ('lineAt' in lines ? lines.lineAt(i) : lines[i]) ?? '';
  const text = at(line);
  const code = codeOf(lang, text);
  if (code.length < Math.min(col, text.length)) return undefined;   // the caret is in a comment
  const before = code.slice(0, col);
  const after = text.slice(col);
  const tail = lang === 'tp' ? /^\s*;?\s*$/.exec(after)?.[0].length : /^\s*$/.exec(after)?.[0].length;
  if (tail === undefined) return undefined;
  const m = /^\s*([A-Za-z]+)\b(.*?)([A-Za-z]*)$/.exec(before);
  if (!m) return undefined;
  const head = m[1].toUpperCase(), typed = m[3];
  const between = m[2];
  // the keyword is its own word: `IF (x)TH` and `IF xTH` are not it
  if (!/\s$/.test(between) && !(lang === 'tp' && /\)$/.test(between))) return undefined;
  const cond = between.trim();
  if (!cond || UNFINISHED.test(cond)) return undefined;
  if ((cond.match(/\(/g)?.length ?? 0) !== (cond.match(/\)/g)?.length ?? 0)) return undefined;
  if (cond.lastIndexOf('[') > cond.lastIndexOf(']')) return undefined;
  // TP: only the mixed-logic form takes THEN - `IF R[1]=1,JMP LBL[2]` is finished as it stands
  if (lang === 'tp' && !/^\(.*\)$/.test(cond)) return undefined;
  const fits = tails.filter(t => t.head === head && t.pivot.startsWith(typed.toUpperCase()) && !word(t.pivot).test(cond));
  if (!fits.length) return undefined;
  const { pivot, closer } = fits[0];
  let opens = 0, closes = 0;
  const opener = new RegExp(`^\\s*${head}\\b`, 'i'), closing = new RegExp(`\\b${closer}\\b`, 'gi');
  for (let i = 0; i < count; i++) {
    if (i === line) continue;
    const c = codeOf(lang, at(i));
    if (opener.test(c) && word(pivot).test(c)) opens++;
    closes += c.match(closing)?.length ?? 0;
  }
  return { word: typed, tail, keyword: fits[0].insert.split('\n')[0], tails: closes > opens ? [] : fits };
}

/** Is the caret at the start of a statement - where a whole-statement snippet belongs? Returns the word typed so far. */
export function statementStart(lang: SnippetLanguage, lineText: string, col: number): string | undefined {
  // TP: after the line number (`  12:  `) or on a fresh line; `!` and `/` start a comment or remark
  if (lang === 'tp') return /^(?:\s*\d*:\s*|\s*)([A-Za-z!/][A-Za-z!/=+]*|)$/.exec(lineText.slice(0, col))?.[1];
  const code = codeOf(lang, lineText);
  if (code.length < Math.min(col, lineText.length)) return undefined;
  // KAREL and RAPID: a fresh line, or after the keyword that opens a block on the same line
  return /(?:^|;|\b(?:THEN|ELSE|DO)\s)\s*([A-Za-z_]*)$/i.exec(code.slice(0, col))?.[1];
}
