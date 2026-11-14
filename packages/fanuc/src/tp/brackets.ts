/** Bracket counting for the bracket guard (bracketGuard.ts) - no vscode import, so the unit tests can read it */

export const CLOSER_OF: Record<string, string> = { ']': '[', ')': '(' };

/**
 * `line` already holds the closer just typed. True when it is one too many: the line has
 * exactly one more of that closer than of its opener (strings aside), so it was balanced
 * before the keystroke. A line that was already unbalanced is left to its author.
 */
export function surplusCloser(line: string, closer: string): boolean {
  const opener = CLOSER_OF[closer];
  if (!opener) return false;
  // the name in a bracket first (R[1:a's] - an apostrophe there is text), then the strings
  const code = line.replace(/(\[[^\[\]:'"]*):[^\]\n]*/g, '$1').replace(/'[^']*'?|"[^"]*"?/g, '');
  let opens = 0, closes = 0;
  for (const c of code) { if (c === opener) opens++; else if (c === closer) closes++; }
  return closes === opens + 1;
}
