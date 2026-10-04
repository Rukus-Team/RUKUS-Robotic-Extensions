/**
 * `--eg:` extended comments, the way the controller writes them.
 *
 * An extended comment is one comment spread over several lines: the first line carries the
 * line number and `--eg:`, every further line is a `:` continuation, and only the last line
 * carries the ` ;`. The pendant's comment editor wraps the text between words so that no
 * line is wider than EXT_COMMENT_WIDTH columns - measured on a ROBOGUIDE controller's own
 * EXITZONE.LS (2026-09-11), where the widest line the pendant wrote is exactly 78 columns
 * and every wrap happened where one more word would have passed it:
 *
 *     6:  --eg: testing 123 this has to end at some point i dont know how to tell
 *      :  123 this has to end at some point i dont know how to tell 123 this has
 *      :  to end at some point i eg: !dont know how to tell 123 this has to end
 *      :  at some point i dont know how to t ;
 *
 * The controller itself does not refuse a wider line: a `.LS` with a 165-character
 * continuation (test/fixtures-extended-comment.ls, from a real S002R05) loads. So the width
 * is a pendant rule, and matching it here means a program written in the editor reads on
 * the pendant the way it reads in the file. Reflowing only touches a comment that has a line
 * over the width; one the pendant wrote is never rewritten.
 */

/** Widest line, in columns, the pendant writes for an extended comment (the ` ;` excluded). */
export const EXT_COMMENT_WIDTH = 78;

/** the pendant writes a space after `--eg:` */
const EG = '--eg: ';
/** the continuation head the controller writes: four spaces, a colon, two spaces */
const CONT_HEAD = '    :  ';

const RE_FIRST = /^(\s*\d*:)(\s*)--eg:?/i;
const RE_CONT = /^(\s*:)(\s*)/;

/** columns a line occupies before its ` ;` terminator, if any */
export function extCommentColumns(raw: string): number {
  return raw.replace(/\s*;\s*$/, '').trimEnd().length;
}

/**
 * The text of an extended comment, the line breaks taken out. The first line's text is
 * what follows `--eg:`, a continuation's what follows its `:`; the terminator is dropped.
 */
export function extCommentText(rawLines: string[]): string {
  const parts: string[] = [];
  rawLines.forEach((raw, i) => {
    const m = i === 0 ? RE_FIRST.exec(raw) : RE_CONT.exec(raw);
    let text = m ? raw.slice(m[0].length) : raw;
    if (i === rawLines.length - 1) text = text.replace(/\s*;\s*$/, '');
    parts.push(text.trim());
  });
  return parts.filter(Boolean).join(' ');
}

/**
 * Break `text` between words so that each piece fits `firstWidth` (the first) or
 * `restWidth` (the others). A single word wider than a line is cut at the width, which is
 * the one case where the result is not the pendant's - the pendant simply cannot be given
 * such a word.
 */
export function wrapWords(text: string, firstWidth: number, restWidth: number): string[] {
  const out: string[] = [];
  let line = '';
  let width = firstWidth;
  const push = () => { out.push(line); line = ''; width = restWidth; };
  for (const word of text.split(/\s+/).filter(Boolean)) {
    let w = word;
    while (w.length > width) {
      // fill what is left of this line, then continue the word on the next
      if (line) push();
      out.push(w.slice(0, width)); w = w.slice(width); width = restWidth;
    }
    if (!w) continue;
    if (!line) line = w;
    else if (line.length + 1 + w.length <= width) line += ' ' + w;
    else { push(); line = w; }
  }
  if (line || !out.length) out.push(line);
  return out;
}

export interface ReflowedExtComment {
  /** the lines as the controller would write them, terminator on the last */
  lines: string[];
}

/**
 * Rewrite one extended comment (its raw lines, first line first) to the controller's
 * width. `undefined` when every line already fits - such a comment is left exactly as
 * it is, spacing and all. The first line keeps its own head (`   6:` or the numberless
 * `     :`), so a renumber can hand in the head it has just decided on.
 */
export function reflowExtendedComment(rawLines: string[], width = EXT_COMMENT_WIDTH): ReflowedExtComment | undefined {
  if (!rawLines.length || width <= 0) return undefined;
  if (!rawLines.some(raw => extCommentColumns(raw) > width)) return undefined;
  const first = RE_FIRST.exec(rawLines[0]);
  if (!first) return undefined;
  const head = first[1] + (first[2] || '  ');   // `   6:  ` - the two spaces every instruction gets
  const text = extCommentText(rawLines);
  const firstWidth = width - head.length - EG.length;
  const restWidth = width - CONT_HEAD.length;
  if (firstWidth < 8 || restWidth < 8) return undefined;   // an absurd width; do nothing rather than shred the text
  const pieces = wrapWords(text, firstWidth, restWidth);
  const lines = pieces.map((p, i) => (i === 0 ? head + EG.trimEnd() + (p ? ' ' + p : '') : CONT_HEAD + p));
  lines[lines.length - 1] += ' ;';
  return { lines };
}
