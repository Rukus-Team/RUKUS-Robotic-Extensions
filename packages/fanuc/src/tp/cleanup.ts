/**
 * Positions nothing runs any more.
 *
 * A program silts up in two ways: a point that no line mentions at all, and a point whose
 * only mentions are on lines the controller ignores - a `//` remark or a `!` comment left
 * behind when a move was commented out "for now". The second kind is the sneaky one: a
 * search for `P[7]` finds it, so it looks used, and it stays in the file for years.
 *
 * Pure: text in, findings out. Removing anything is the caller's decision, after a review.
 */
import { parseTp } from './parser';
import type { LineChange } from './refactor';

export interface StalePosition {
  index: number;
  comment?: string;
  /** the `/POS` block, first and last document line inclusive */
  line: number;
  endLine: number;
  /** 'unused': no line mentions it. 'remarked': only commented-out lines mention it. */
  reason: 'unused' | 'remarked';
  /** document lines of the commented-out mentions, for the review */
  mentions: number[];
}

export function findStalePositions(text: string): StalePosition[] {
  const prog = parseTp(text);
  const live = new Set(prog.posRefs.map(r => r.index));
  const mentions = new Map<number, number[]>();
  for (const l of prog.lines) {
    if (l.kind !== 'remark' && l.kind !== 'comment') continue;
    // the same guard the parser uses: the P of GP[ and SP[ is not a position
    for (const m of l.body.matchAll(/(?<![A-Za-z])P\[(\d+)/g)) {
      const i = parseInt(m[1], 10);
      const arr = mentions.get(i) ?? [];
      arr.push(l.line); mentions.set(i, arr);
    }
  }
  return prog.positions
    .filter(p => !live.has(p.index))
    .map(p => ({
      index: p.index, comment: p.comment, line: p.line, endLine: p.endLine,
      reason: mentions.has(p.index) ? 'remarked' : 'unused',
      mentions: mentions.get(p.index) ?? [],
    }));
}

/** Whole-line deletions of the chosen blocks; apply with applyLineChanges or the editor. */
export function planPositionRemoval(text: string, indexes: number[]): LineChange[] {
  const want = new Set(indexes);
  return parseTp(text).positions
    .filter(p => want.has(p.index))
    .map(p => ({ from: p.line, to: p.endLine }))
    .sort((a, b) => b.from - a.from);
}
