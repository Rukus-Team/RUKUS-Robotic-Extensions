/**
 * Tells a file or module header comment (copyright, change history, routine list, "best
 * viewed in MS Word" ...) apart from the note that describes the declaration under it. The
 * RAPID and KAREL parsers take the comment block right above a declaration as its hover
 * text; a header that happens to sit on top of the first declaration must not be that text.
 * Pure, so the tests can use it.
 */

/** `!*****`, `-- =====`, `! ---------`, `!!!!!!!!` - a comment line made only of rule characters */
export function isDivider(line: string): boolean {
  const s = line.replace(/^\s*(?:!|--)?/, '');
  return /^[\s=*#\-_~+/\\|!]*$/.test(s) && /[=*#\-_~+!]{3,}/.test(s);
}

/**
 * `!!!! ROBOT POINTS !!!!`, `*** Pick ***`, `---- routines` - a section title: it starts or
 * ends with 3+ rule characters, or is less than half real text. It names the part of the
 * file below it, not the one declaration right under it. A plain divider is one too.
 */
export function isBanner(line: string): boolean {
  const s = line.replace(/^\s*(?:!|--)?\s*/, '').trim();
  if (!s) return false;
  if (/^[!=*#\-_~+]{3,}/.test(s) || /[!=*#\-_~+]{3,}$/.test(s)) return true;
  return s.replace(/[!=*#\-_~+/\\|\s]/g, '').length / s.length < 0.5;
}

/** Words that only a file or module header uses. */
const HEADER_MARK = new RegExp([
  'copyright', '\\(c\\)\\s*\\d', '©', 'all rights reserved', 'proprietary', 'confidential',
  'ms[- ]?word', 'microsoft word', 'tab ?stops?', 'best viewed',
  '(?:change|revision|modification|version|edit)\\s*(?:history|log|record)',
  '^\\s*(?:module|module ?name|file|file ?name|program ?name|project|project ?name|customer|company|cell|routines?|routine ?list|history)\\s*:',
].join('|'), 'im');

/**
 * True when the comment lines (raw, without the `!`/`--` marker or with it) read as a file
 * or module header. `atTop`: nothing but the MODULE/PROGRAM line (or nothing at all) comes
 * before the block, where a ruled or multi-line block is the header by position alone.
 */
export function isHeaderComment(lines: string[], atTop: boolean): boolean {
  const body = lines.map(s => s.replace(/^\s*(?:!|--)?\s?/, ''));
  const text = body.filter(s => !isDivider(s)).filter(s => s.trim());
  if (body.some(s => HEADER_MARK.test(s))) return true;
  if (text.length > 15) return true;
  return atTop && (lines.some(isDivider) || text.length > 3);
}
