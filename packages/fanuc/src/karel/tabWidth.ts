/**
 * How wide a tab was in the editor a KAREL file was written in.
 *
 * ROBOGUIDE's editor puts a real tab character in the file and draws it 7 spaces wide (measured
 * 2026-10-03: one tab lines up with 7 spaces, two with 14). Other editors use 4 or 8. A file that is
 * indented with tabs alone looks right at any width; one that MIXES tabs and spaces only lines up at
 * the width it was written with - a customer deliverable lines up at 4, ROBOGUIDE-made files
 * at 7 or 8. So the width is read off the file: neighbouring lines in the same block, one indented
 * with a tab and the other with spaces, should start in the same column. Pure, for the unit tests.
 */

export const ROBOGUIDE_TAB_WIDTH = 7;
const CANDIDATES = [2, 3, 4, 5, 6, 7, 8];

/** the column an indent string reaches with tabs `tab` wide */
export function indentWidth(ws: string, tab: number): number {
  let c = 0;
  for (const ch of ws) c = ch === '\t' ? (Math.floor(c / tab) + 1) * tab : c + 1;
  return c;
}

// a line that opens a block indents the next one; a line that closes or splits a block outdents
const OPENS = /^\s*(IF\b.*\bTHEN\b|ELSE\b|FOR\b|WHILE\b|REPEAT\b|SELECT\b|CASE\b|BEGIN\b|ROUTINE\b|VAR\b|CONST\b|TYPE\b|CONDITION\b|USING\b|.*=\s*STRUCTURE\b)/i;
const CLOSES = /^\s*(ENDIF|ENDFOR|ENDWHILE|UNTIL|ENDSELECT|END\b|ELSE\b|CASE\b|ENDSTRUCTURE|ENDCONDITION|ENDUSING|BEGIN\b)/i;

/**
 * The tab width that lines this file up, or undefined when the file gives no clear evidence (no tabs,
 * tabs never next to space-indented lines of the same block, or no width that lines up most of those
 * lines - then the ROBOGUIDE default stands). Ties go to ROBOGUIDE's 7, then wider.
 */
export function detectTabWidth(lines: readonly string[]): number | undefined {
  const code = lines.filter(l => l.trim() && !/^\s*--/.test(l));
  const score = new Map<number, number>(CANDIDATES.map(t => [t, 0]));
  let pairs = 0;
  for (let i = 1; i < code.length; i++) {
    const a = /^[ \t]*/.exec(code[i - 1])![0], b = /^[ \t]*/.exec(code[i])![0];
    if (a === b) continue;
    const tabs = a.includes('\t') || b.includes('\t'), spaces = a.includes(' ') || b.includes(' ');
    if (!tabs || !spaces) continue;                          // only a tab beside spaces says anything
    if (OPENS.test(code[i - 1]) || CLOSES.test(code[i])) continue;
    pairs++;
    for (const t of CANDIDATES) if (indentWidth(a, t) === indentWidth(b, t)) score.set(t, score.get(t)! + 1);
  }
  if (pairs < 3) return undefined;
  const best = Math.max(...score.values());
  if (best === 0 || best < pairs * 0.6) return undefined;            // no width lines most of them up: no verdict
  const winners = CANDIDATES.filter(t => score.get(t) === best);
  return winners.includes(ROBOGUIDE_TAB_WIDTH) ? ROBOGUIDE_TAB_WIDTH : winners[winners.length - 1];
}
