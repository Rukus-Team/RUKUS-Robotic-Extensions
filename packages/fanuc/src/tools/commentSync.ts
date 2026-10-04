/**
 * Bulk comment sync, PULL direction: rewrite every inline register / I/O / PR comment in
 * a program to what the controller's own comment tables say (`numreg.va`, `posreg.va`,
 * `strreg.va`, `diocfgsv.va`). Pure - no vscode - so the corpus test can run it.
 *
 * This is the `tp.commentMismatch` diagnostic and its "Use controller comment" quick fix
 * applied to a whole file, or a whole backup, in one edit. The comparison is the
 * diagnostic's own rule, kept in ONE place (`commentDiffers`): a reference that carries a
 * comment, a controller comment that exists, and the two not identical byte for byte. No
 * case folding, no trimming - the controller keeps what it was given, so any difference is
 * a real one that the diagnostic would also show.
 *
 * PUSH direction (inline comments -> controller) is deliberately NOT here. It would be a
 * `.cm` command file the controller runs (KCL over the pendant's command interpreter), and
 * the exact syntax has not been verified on a controller by anyone on this project. What
 * would need confirming before building it, on a real R-30iB:
 *   - the KCL verbs for register / I/O comments (`SET VAR $NUMREG[n].$COMMENT`? `SETIOCMT`?
 *     the `SETREG` mnemonic mentioned in FEATURES.md) and their argument order;
 *   - the 16-character pendant limit for register comments and the I/O comment limit, and
 *     whether the controller truncates or rejects longer text;
 *   - whether comment writes are allowed while a program is running, and which
 *     controller mode they need;
 *   - how the file is executed (`RUN` from FILE menu vs. `.cm` autoexec) and what the
 *     failure output looks like.
 * Until then, pulling is the safe half: it only ever writes to a file on the PC.
 */
import type { TpProgram } from '../tp/parser';

/** where the controller comment comes from - `Dataset.comment` has exactly this shape */
export interface CommentSource { comment(kind: string, index: number): string | undefined }

export interface CommentEdit {
  /** zero-based document line */
  line: number;
  col: number;
  len: number;
  newText: string;
  oldText: string;
  kind: string;
  index: number;
}

export interface CommentSyncPlan {
  edits: CommentEdit[];
  /** references that would change, per kind (`R`, `DI`, `PR`, ...) */
  byKind: Record<string, number>;
}

/** the `tp.commentMismatch` rule: both comments exist and are not identical */
export function commentDiffers(controller: string | undefined, inline: string | undefined): controller is string {
  return !!controller && !!inline && controller !== inline;
}

export function planCommentSync(prog: TpProgram, source: CommentSource): CommentSyncPlan {
  const edits: CommentEdit[] = [];
  const byKind: Record<string, number> = {};
  for (const d of prog.dataRefs) {
    if (!d.comment || !d.commentSpan) continue;
    const ctrl = source.comment(d.kind, d.index);
    if (!commentDiffers(ctrl, d.comment)) continue;
    edits.push({ line: d.commentSpan.line, col: d.commentSpan.col, len: d.commentSpan.len, newText: ctrl, oldText: d.comment, kind: d.kind, index: d.index });
    byKind[d.kind] = (byKind[d.kind] ?? 0) + 1;
  }
  return { edits, byKind };
}

export interface ProgramPlan { name: string; plan: CommentSyncPlan }

/** the same, over several programs (a backup); programs with nothing to change are omitted */
export function planCommentSyncMany(programs: Array<{ name: string; prog: TpProgram }>, source: CommentSource): { programs: ProgramPlan[]; total: number; byKind: Record<string, number> } {
  const out: ProgramPlan[] = [];
  const byKind: Record<string, number> = {};
  let total = 0;
  for (const p of programs) {
    const plan = planCommentSync(p.prog, source);
    if (!plan.edits.length) continue;
    out.push({ name: p.name, plan });
    total += plan.edits.length;
    for (const [k, n] of Object.entries(plan.byKind)) byKind[k] = (byKind[k] ?? 0) + n;
  }
  return { programs: out, total, byKind };
}

/** apply a plan to text (tests, and anywhere an editor is not involved); edits are right-to-left per line */
export function applyCommentEdits(text: string, edits: CommentEdit[]): string {
  const lines = text.split(/\r?\n/);
  const eol = /\r\n/.test(text) ? '\r\n' : '\n';
  const byLine = new Map<number, CommentEdit[]>();
  for (const e of edits) { const a = byLine.get(e.line) ?? []; a.push(e); byLine.set(e.line, a); }
  for (const [line, es] of byLine) {
    let s = lines[line];
    for (const e of [...es].sort((a, b) => b.col - a.col)) s = s.slice(0, e.col) + e.newText + s.slice(e.col + e.len);
    lines[line] = s;
  }
  return lines.join(eol);
}

/** "12 references in 3 programs: R 7 · DI 4 · PR 1" */
export function describeSyncPlan(total: number, programs: number, byKind: Record<string, number>): string {
  const kinds = Object.entries(byKind).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(' · ');
  return `${total} reference${total === 1 ? '' : 's'} in ${programs} program${programs === 1 ? '' : 's'}${kinds ? `: ${kinds}` : ''}`;
}
