/**
 * Compare two programs for what they DO, not how the file happens to be written.
 *
 * Two copies of one program rarely compare equal as text: a line inserted near the top shifts
 * every number below it, one came off the controller with CRLF and ` ;`, the other was typed
 * without, the header carries the time it was last saved. A plain diff then marks every line.
 * `cleanForCompare` takes those out of BOTH sides so the diff shows only the lines that differ.
 * Nothing here is written to a file - the cleaned text exists only in the compare view.
 *
 * Pure: no vscode import, so the unit tests read it.
 */
import { parseTp } from './tp/parser';

export type CompareIgnore = 'lineNumbers' | 'terminators' | 'spacing' | 'header' | 'names' | 'commentLines' | 'positions' | 'case';

export const COMPARE_IGNORES: Array<{ id: CompareIgnore; label: string; detail: string; byDefault: boolean }> = [
  { id: 'lineNumbers', label: 'Line numbers', detail: 'the `  12:` in front of every TP line - a line added near the top renumbers all the others', byDefault: true },
  { id: 'terminators', label: 'Line terminators', detail: 'the ` ;` at the end of a TP line', byDefault: true },
  { id: 'spacing', label: 'Spacing', detail: 'spaces at the start and end of a line, and runs of spaces or tabs inside it', byDefault: true },
  { id: 'header', label: 'Header bookkeeping', detail: 'CREATE, MODIFIED, PROG_SIZE, MEMORY_SIZE, LINE_COUNT, FILE_NAME and VERSION in /ATTR - they change with every save', byDefault: true },
  { id: 'names', label: 'Register and I/O names', detail: 'the comment inside the brackets: R[5:count] and R[5] compare equal', byDefault: false },
  { id: 'commentLines', label: 'Comment lines', detail: '!comments, --eg comments and //remarks (KAREL: -- comments)', byDefault: false },
  { id: 'positions', label: 'Position data', detail: 'everything under /POS - compare the logic only', byDefault: false },
  { id: 'case', label: 'Upper / lower case', detail: 'IF and if compare equal', byDefault: false },
];

export const DEFAULT_COMPARE_IGNORES: CompareIgnore[] = COMPARE_IGNORES.filter(i => i.byDefault).map(i => i.id);

/** what a settings value says to ignore; anything unknown in it is dropped, a missing one is the default */
export function compareIgnores(value: unknown): Set<CompareIgnore> {
  if (!Array.isArray(value)) return new Set(DEFAULT_COMPARE_IGNORES);
  return new Set(value.filter((v): v is CompareIgnore => COMPARE_IGNORES.some(i => i.id === v)));
}

/** "line numbers, terminators and spacing" - for the title of the compare */
export function describeIgnores(ignore: ReadonlySet<CompareIgnore>): string {
  const names = COMPARE_IGNORES.filter(i => ignore.has(i.id)).map(i => i.label.toLowerCase());
  if (!names.length) return 'line endings';
  return names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

const BOOKKEEPING = /^(\s*(?:CREATE|MODIFIED|PROG_SIZE|MEMORY_SIZE|LINE_COUNT|FILE_NAME|VERSION)\s*)=.*$/i;

/** runs of spaces and tabs become one space - but not inside a quoted string, where they are data ('A  B' is not 'A B') */
const squeeze = (s: string) => s.split(/('[^']*'|"[^"]*")/).map((part, i) => (i % 2 ? part : part.replace(/[ \t]+/g, ' '))).join('').trim();

/** what a `:` continuation line starts with once the numbers are gone, so it never reads as a line of its own */
const CONT = '…';

/** `kind`: by file extension - `.ls` is a TP program, `.kl` KAREL, anything else is treated as plain text */
export function cleanForCompare(text: string, kind: 'tp' | 'karel' | 'text', ignore: ReadonlySet<CompareIgnore>): string {
  // line endings never count, whatever else is asked for
  // (some controller-written files end their lines CR CR LF: still one line ending)
  const lines = text.replace(/\r+\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const out: string[] = [];
  if (kind !== 'tp') {
    for (let l of lines) {
      if (ignore.has('commentLines') && kind === 'karel' && /^\s*--/.test(l)) continue;
      if (ignore.has('spacing')) l = squeeze(l); else l = l.replace(/[ \t]+$/, '');
      if (ignore.has('case')) l = l.toUpperCase();
      out.push(l);
    }
    return out.join('\n');
  }

  // Which `:` lines are the REST of the line above (a wrapped instruction, a circular move's
  // second point, the text of an extended comment) and which are instructions written without
  // a number is the parser's call. The difference has to survive the cleaning: `--eg: note` over
  // `:  R[1]=0 ;` is a comment that mentions R[1]; `--eg: note ;` over `6:  R[1]=0 ;` sets it.
  const rest = new Set(parseTp(lines.join('\n')).lines.filter(l => l.kind === 'continuation' || (l.ext === true && l.seq === undefined)).map(l => l.line));
  let section: 'head' | 'mn' | 'pos' | 'end' = 'head';
  /** inside an `--eg` comment that is being left out: its `:` lines go with it, up to the one that ends in ` ;` */
  let droppingExt = false;
  for (let n = 0; n < lines.length; n++) {
    const raw = lines[n];
    const mark = /^\/(PROG|ATTR|APPL|MN|POS|END)\b/.exec(raw);
    if (mark) {
      section = mark[1] === 'MN' ? 'mn' : mark[1] === 'POS' ? 'pos' : mark[1] === 'END' ? 'end' : 'head';
      droppingExt = false;
      out.push(ignore.has('spacing') ? squeeze(raw) : raw.replace(/[ \t]+$/, ''));
      continue;
    }
    if (section === 'pos' && ignore.has('positions')) continue;
    let l = raw;
    if (section === 'head' && ignore.has('header')) l = l.replace(BOOKKEEPING, '$1= …;');
    if (section === 'mn') {
      const head = /^(\s*\d*:)(.*)$/.exec(l);
      const body = (head ? head[2] : l).trim();
      const terminated = /;\s*$/.test(l);
      const continuation = rest.has(n);
      if (ignore.has('commentLines')) {
        if (droppingExt && continuation) { if (terminated) droppingExt = false; continue; }
        droppingExt = false;
        if (/^(\/\/)?--[a-z]{2}(?::|\b)/i.test(body)) { droppingExt = !terminated; continue; }
        if (/^(!|\/\/)/.test(body)) continue;
      }
      // The number field goes - `  12:`, the numberless `    :`, or none at all on a line just
      // typed - so the three compare equal. A continuation keeps a mark in its place.
      if (ignore.has('lineNumbers')) l = continuation ? CONT + (head ? head[2] : '  ' + l.trim()) : head ? head[2] : l.trim() ? '  ' + l.trim() : l;
      if (ignore.has('terminators')) l = l.replace(/\s*;\s*$/, '');
      // an empty line and the empty numbered line the renumber makes of it (`  67:   ;`) are the same line
      if (ignore.has('lineNumbers') && !continuation && /^\s*;?\s*$/.test(l)) l = '';
      if (ignore.has('names')) l = l.replace(/\b([A-Z]+\[\s*(?:[A-Z]+\[\s*)?\d+)\s*:[^\]]*(?=\])/g, '$1');
    }
    l = ignore.has('spacing') ? squeeze(l).replace(new RegExp(`^${CONT}\\s*`), CONT + ' ') : l.replace(/[ \t]+$/, '');
    if (ignore.has('case')) l = l.toUpperCase();
    out.push(l);
  }
  return out.join('\n');
}

export const kindOfFile = (path: string): 'tp' | 'karel' | 'text' => (/\.ls$/i.test(path) ? 'tp' : /\.kl$/i.test(path) ? 'karel' : 'text');
