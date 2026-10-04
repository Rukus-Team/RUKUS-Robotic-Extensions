/**
 * Structural edits to TP programs: moving lines into a new program, pulling a called
 * program back inline, and renumbering a register or I/O point across a whole robot.
 *
 * All pure — text in, edits out — and all of it refuses rather than guesses. A TP program
 * is not a language with block scope: control flow is `JMP LBL[n]` across the whole file
 * and data lives in `P[n]` numbered per program. That means a cut which looks innocent in
 * the editor can be meaningless once it lands somewhere else, and the only safe posture is
 * to check every way out of the selection and stop when one of them leaves.
 */
import { parseTp, type TpProgram } from './parser';

export interface RefactorEdit { line: number; col: number; len: number; newText: string }
/** whole-line replacement; `newText` of undefined deletes the line */
export interface LineChange { from: number; to: number; newText?: string }

export interface RefactorPlan {
  edits: RefactorEdit[];
  lineChanges: LineChange[];
  blockers: string[];
  warnings: string[];
}

// ---------------------------------------------------------------- remap

export interface RemapResult { edits: RefactorEdit[]; count: number; collision: boolean }

/**
 * Renumber every reference to one register / I/O point in a program.
 *
 * Only the index is rewritten, never the inline comment: `R[5:Cycle count]` becomes
 * `R[105:Cycle count]` and keeps saying what it is. `collision` reports that the
 * destination is already used in this program — not fatal (the caller may be merging on
 * purpose) but never something to do silently.
 */
export function planRemap(text: string, kind: string, from: number, to: number): RemapResult {
  const prog = parseTp(text);
  const lines = text.split(/\r?\n/);
  const edits: RefactorEdit[] = [];
  let collision = false;

  for (const ref of prog.dataRefs) {
    if (ref.kind !== kind) continue;
    if (ref.index === to) collision = true;
    if (ref.index !== from) continue;
    // The span covers "R[5:Comment]"; rewrite just the digits after the bracket.
    const raw = lines[ref.line] ?? '';
    const open = raw.indexOf('[', ref.span.col);
    if (open < 0) continue;
    const digits = /^\d+/.exec(raw.slice(open + 1));
    if (!digits) continue;
    edits.push({ line: ref.line, col: open + 1, len: digits[0].length, newText: String(to) });
  }
  edits.sort((a, b) => a.line - b.line || a.col - b.col);
  return { edits, count: edits.length, collision };
}

// ---------------------------------------------------------------- extract

export interface ExtractResult extends RefactorPlan {
  /** the complete text of the new program */
  programText: string;
  /** positions moved out of the host, old index → new index */
  positionMap: Map<number, number>;
  movedLines: number;
}

/**
 * Move a run of lines into a new program and leave a `CALL` behind.
 *
 * Refuses when the selection is not a self-contained piece of control flow, because TP
 * has no scope to protect it: a label outside cannot be jumped to from inside the new
 * program, and a jump from outside into the middle of the extracted run has nowhere to
 * land once those lines are somewhere else.
 */
export function planExtract(text: string, startLine: number, endLine: number, newName: string): ExtractResult {
  const prog = parseTp(text);
  const lines = text.split(/\r?\n/);
  const blockers: string[] = [];
  const warnings: string[] = [];
  const positionMap = new Map<number, number>();

  const mn = prog.sections.mn ?? -1;
  const posStart = prog.sections.pos ?? prog.sections.end ?? lines.length;
  if (startLine <= mn || endLine >= posStart) {
    blockers.push('Select lines inside /MN — the program body — not the header or the position data.');
    return { programText: '', edits: [], lineChanges: [], blockers, warnings, positionMap, movedLines: 0 };
  }

  const inRange = (l: number) => l >= startLine && l <= endLine;
  // Numbered lines AND the unnumbered lines that belong to them: the second half of a
  // circular move, the later lines of a `--eg` comment. Dropping those used to leave the
  // extracted program with a `C P[1]` that arrived nowhere.
  const body = prog.lines.filter(l => inRange(l.line) && (l.seq !== undefined || isContinuation(l)));
  if (!body.some(l => l.seq !== undefined)) {
    blockers.push('The selection contains no program lines.');
    return { programText: '', edits: [], lineChanges: [], blockers, warnings, positionMap, movedLines: 0 };
  }
  // A continuation belongs to the numbered line above it, so the selection may neither
  // start on one (the head would stay behind) nor stop just short of one (the extracted
  // circular move would end at its first point and the host would keep an orphan `:` line).
  const firstSel = prog.lines.find(l => l.line === startLine);
  const afterSel = prog.lines.find(l => l.line === endLine + 1);
  if (firstSel && isContinuation(firstSel)) blockers.push(`Line ${startLine + 1} continues the line above it - start the selection on that line.`);
  if (afterSel && isContinuation(afterSel)) blockers.push(`Line ${endLine + 2} continues the last selected line - include it in the selection.`);
  if (blockers.length) return { programText: '', edits: [], lineChanges: [], blockers, warnings, positionMap, movedLines: 0 };

  // ---- control flow has to stay inside ----
  const labelsInside = new Set(prog.labels.filter(l => inRange(l.line)).map(l => l.num));
  for (const j of prog.jumps) {
    if (inRange(j.line) && !labelsInside.has(j.num)) {
      blockers.push(`Line ${lineNumAt(prog, j.line)} jumps to LBL[${j.num}], which is outside the selection. A jump cannot leave the program it is in.`);
    }
    if (!inRange(j.line) && labelsInside.has(j.num)) {
      blockers.push(`LBL[${j.num}] is inside the selection but line ${lineNumAt(prog, j.line)} jumps to it from outside.`);
    }
  }

  // Block structure must balance, or the new program has a dangling ENDIF and the old
  // one loses its close.
  let depth = 0;
  for (const l of body) {
    if (/^IF\b.*\bTHEN\s*$/.test(l.body) || /^FOR\b/.test(l.body)) depth++;
    else if (/^(ENDIF|ENDFOR)\b/.test(l.body)) depth--;
    if (depth < 0) { blockers.push('The selection closes an IF or FOR block that starts before it.'); break; }
  }
  if (depth > 0) blockers.push('The selection opens an IF or FOR block that it does not close.');

  if (blockers.length) return { programText: '', edits: [], lineChanges: [], blockers, warnings, positionMap, movedLines: 0 };

  // ---- positions used only by the moved lines come along ----
  const usedInside = new Set(prog.posRefs.filter(r => inRange(r.line)).map(r => r.index));
  const usedOutside = new Set(prog.posRefs.filter(r => !inRange(r.line)).map(r => r.index));
  const moving = [...usedInside].filter(i => !usedOutside.has(i)).sort((a, b) => a - b);
  const shared = [...usedInside].filter(i => usedOutside.has(i)).sort((a, b) => a - b);
  moving.forEach((old, i) => positionMap.set(old, i + 1));
  if (shared.length) {
    // A point used on both sides has to exist in both programs, so it is copied, and the
    // two copies drift apart the moment anyone touches one of them. Say so plainly.
    shared.forEach((old, i) => positionMap.set(old, moving.length + i + 1));
    warnings.push(`P[${shared.join('], P[')}] ${shared.length === 1 ? 'is' : 'are'} used on both sides of the cut, so ${shared.length === 1 ? 'it is' : 'they are'} COPIED into ${newName.toUpperCase()}. Teaching one copy afterwards will not move the other.`);
  }

  // ---- build the new program ----
  const movedBodies = body.map(l => ({ text: renumberRefs(l.raw.slice(l.bodyCol), 'P', positionMap).trimEnd(), cont: isContinuation(l) }));
  const posBlocks = [...positionMap.entries()]
    .sort((a, b) => a[1] - b[1])
    .map(([oldIdx, newIdx]) => renumberPosBlock(lines, prog, oldIdx, newIdx))
    .filter(Boolean) as string[];

  const programText = buildProgram(newName.toUpperCase(), movedBodies, posBlocks, prog);

  // ---- the host loses those lines and gains a CALL ----
  const lineChanges: LineChange[] = [{ from: startLine, to: endLine, newText: `  CALL ${newName.toUpperCase()} ;` }];
  const orphaned = [...positionMap.keys()].filter(i => !usedOutside.has(i));
  if (orphaned.length) {
    for (const idx of orphaned) {
      const p = prog.positions.find(x => x.index === idx);
      if (p) lineChanges.push({ from: p.line, to: p.endLine });
    }
  }
  return { programText, edits: [], lineChanges, blockers, warnings, positionMap, movedLines: body.filter(l => l.seq !== undefined).length };
}

/**
 * `P[2]` → `P[1]` and `P[1]` → `P[2]` in ONE pass. Applying the map one entry at a time
 * sent a reference through two renumberings when the map swapped indices - `P[2]` became
 * `P[1]` and then, on the next entry, `P[2]` again - so an extracted circular move ended
 * up with the same point at both ends.
 */
function renumberRefs(s: string, kind: 'P' | 'LBL', map: Map<number, number>): string {
  if (!map.size) return s;
  return s.replace(new RegExp(`\\b${kind}\\[(\\d+)(?=[\\]:])`, 'g'), (all, idx: string) => { const to = map.get(parseInt(idx, 10)); return to === undefined ? all : `${kind}[${to}`; });
}

/** an unnumbered line that belongs to the numbered line above it */
function isContinuation(l: TpProgram['lines'][number]): boolean {
  return l.seq === undefined && (l.kind === 'continuation' || l.ext === true);
}

// ---------------------------------------------------------------- inline

/**
 * Replace a `CALL X` with X's body.
 *
 * The callee's labels and positions are renumbered into free space in the host so nothing
 * collides. Refuses when the callee is not a plain straight-through subprogram — anything
 * that takes arguments, returns early, or is more than one motion group is not something
 * that can simply be pasted in.
 */
export function planInline(hostText: string, callDocLine: number, calleeText: string, calleeName: string): RefactorPlan & { positionMap: Map<number, number>; labelMap: Map<number, number> } {
  const host = parseTp(hostText);
  const callee = parseTp(calleeText);
  const blockers: string[] = [];
  const warnings: string[] = [];
  const positionMap = new Map<number, number>();
  const labelMap = new Map<number, number>();

  const callLine = host.lines.find(l => l.line === callDocLine);
  if (!callLine || !/\bCALL\b/.test(callLine.body)) {
    blockers.push('Put the cursor on a CALL line.');
    return { edits: [], lineChanges: [], blockers, warnings, positionMap, labelMap };
  }
  if (/\bCALL\s+\w+\s*\(/.test(callLine.body)) {
    blockers.push(`${calleeName} is called with arguments. Inlining would drop them — AR[n] inside the callee has no meaning once the body is in the caller.`);
  }
  if (callee.lines.some(l => /^END\b/.test(l.body))) {
    warnings.push(`${calleeName} contains END. Inlined, that ends the CALLER — which is not what it did as a subprogram.`);
  }
  const grp = callee.header.attrs.get('DEFAULT_GROUP')?.value;
  const hostGrp = host.header.attrs.get('DEFAULT_GROUP')?.value;
  if (grp && hostGrp && grp !== hostGrp) blockers.push(`${calleeName} has DEFAULT_GROUP ${grp} but this program has ${hostGrp}.`);

  if (blockers.length) return { edits: [], lineChanges: [], blockers, warnings, positionMap, labelMap };

  // renumber the callee's labels and positions past whatever the host already uses
  let nextLabel = Math.max(0, ...host.labels.map(l => l.num)) + 10;
  for (const l of callee.labels) { labelMap.set(l.num, nextLabel); nextLabel += 10; }
  let nextPos = Math.max(0, ...host.positions.map(p => p.index)) + 1;
  for (const p of callee.positions) { positionMap.set(p.index, nextPos++); }

  const calleeLines = calleeText.split(/\r?\n/);
  const mn = callee.sections.mn ?? -1;
  const posStart = callee.sections.pos ?? callee.sections.end ?? calleeLines.length;
  const bodies = callee.lines
    .filter(l => l.line > mn && l.line < posStart && (l.seq !== undefined || isContinuation(l)))
    .map(l => {
      const s = renumberRefs(renumberRefs(l.raw.slice(l.bodyCol).trimEnd(), 'LBL', labelMap), 'P', positionMap);
      // a continuation keeps its `:` so the renumber leaves it unnumbered, as the controller does
      return isContinuation(l) ? `    :  ${s.trim()}` : s;
    });

  const banner = [`  !--- inlined from ${calleeName} ---`, ...bodies, `  !--- end ${calleeName} ---`];
  const lineChanges: LineChange[] = [{ from: callDocLine, to: callDocLine, newText: banner.join('\n') }];

  // the callee's position blocks join the host's /POS
  const hostPosLine = host.sections.pos;
  if (hostPosLine !== undefined && positionMap.size) {
    const blocks = [...positionMap.entries()].sort((a, b) => a[1] - b[1])
      .map(([o, n]) => renumberPosBlock(calleeLines, callee, o, n)).filter(Boolean) as string[];
    const end = host.sections.end ?? hostPosLine + 1;
    lineChanges.push({ from: end, to: end - 1, newText: blocks.join('\n') });   // insert before /END
  }
  return { edits: [], lineChanges, blockers, warnings, positionMap, labelMap };
}

// ---------------------------------------------------------------- combine

export interface CombinePart { name: string; text: string }

export interface CombineResult {
  programText: string;
  blockers: string[];
  warnings: string[];
  /** per part: lines taken, positions and labels renumbered */
  parts: Array<{ name: string; lines: number; positions: number; labels: number }>;
  lineCount: number;
}

/**
 * Several programs, one after the other, as ONE program (beta list 2, item 8). The order
 * given is the order in the result. Each part's body follows a `!--- NAME ---` banner;
 * labels and positions are renumbered so nothing from one part lands on another's
 * (labels go on in tens from where the previous part stopped, positions carry on from the
 * last index), and every reference in the body follows. Each part's `/POS` blocks are
 * copied byte-for-byte apart from the index. Nothing is sent to the robot.
 *
 * An `END` inside a part ends the WHOLE combined program where it stands, which is the one
 * thing the parts did not mean - it is a warning, not a blocker, because `END` at the very
 * end of a part is harmless and common. Different DEFAULT_GROUPs are a blocker: the result
 * can only have one.
 */
export function planCombine(parts: CombinePart[], newName: string): CombineResult {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const out: CombineResult = { programText: '', blockers, warnings, parts: [], lineCount: 0 };
  if (parts.length < 2) { blockers.push('Pick at least two programs.'); return out; }
  const parsed = parts.map(p => ({ ...p, prog: parseTp(p.text), lines: p.text.split(/\r?\n/) }));
  for (const p of parsed) if (p.prog.sections.mn === undefined) blockers.push(`${p.name} has no /MN section.`);
  const groups = new Set(parsed.map(p => p.prog.header.attrs.get('DEFAULT_GROUP')?.value).filter(Boolean));
  if (groups.size > 1) blockers.push(`The programs use different DEFAULT_GROUP masks (${[...groups].join(' / ')}); a combined program can only have one.`);
  if (blockers.length) return out;

  const bodies: Array<{ text: string; cont: boolean }> = [];
  const posBlocks: string[] = [];
  let nextLabel = 10;
  let nextPos = 1;
  for (const p of parsed) {
    const labelMap = new Map<number, number>();
    for (const l of p.prog.labels) if (!labelMap.has(l.num)) { labelMap.set(l.num, nextLabel); nextLabel += 10; }
    const positionMap = new Map<number, number>();
    for (const pos of p.prog.positions) if (!positionMap.has(pos.index)) positionMap.set(pos.index, nextPos++);
    const mn = p.prog.sections.mn ?? -1;
    const posStart = p.prog.sections.pos ?? p.prog.sections.end ?? p.lines.length;
    const body = p.prog.lines.filter(l => l.line > mn && l.line < posStart && (l.seq !== undefined || isContinuation(l)));
    if (body.some(l => /^END\b/.test(l.body))) warnings.push(`${p.name} contains END, which will end the combined program where it stands.`);
    const uncounted = p.prog.lines.filter(l => l.line > mn && l.line < posStart && l.num === undefined && (l.kind === 'instruction' || l.kind === 'motion')).length;
    if (uncounted) warnings.push(`${p.name}: ${uncounted} line(s) without a number are copied as they are.`);
    bodies.push({ text: `!--- ${p.name} ---`, cont: false });
    for (const l of body) {
      const s = renumberRefs(renumberRefs(l.raw.slice(l.bodyCol).trimEnd(), 'LBL', labelMap), 'P', positionMap);
      bodies.push({ text: s, cont: isContinuation(l) });
    }
    const blocks = [...positionMap.entries()].sort((a, b) => a[1] - b[1]).map(([o, n]) => renumberPosBlock(p.lines, p.prog, o, n)).filter(Boolean) as string[];
    posBlocks.push(...blocks);
    out.parts.push({ name: p.name, lines: body.filter(l => !isContinuation(l)).length, positions: positionMap.size, labels: labelMap.size });
  }
  out.programText = buildProgram(newName.toUpperCase(), bodies, posBlocks, parsed[0].prog);
  out.lineCount = bodies.filter(b => !b.cont).length;
  return out;
}

// ---------------------------------------------------------------- shared

/** One `/POS` block, copied out verbatim with only its index changed. */
function renumberPosBlock(lines: string[], prog: TpProgram, oldIdx: number, newIdx: number): string | undefined {
  const p = prog.positions.find(x => x.index === oldIdx);
  if (!p) return undefined;
  const block = lines.slice(p.line, p.endLine + 1);
  // only the header line carries the number; the values below are untouched, which keeps
  // the byte-for-byte formatting the teach surgery depends on
  block[0] = block[0].replace(/^P\[\d+/, `P[${newIdx}`);
  return block.join('\n');
}

function lineNumAt(prog: TpProgram, docLine: number): number | string {
  return prog.lines.find(l => l.line === docLine)?.num ?? docLine + 1;
}

/** A complete, loadable .ls file around a body and a set of position blocks. */
function buildProgram(name: string, bodies: Array<{ text: string; cont: boolean }>, posBlocks: string[], from: TpProgram): string {
  const now = new Date();
  const d = `${String(now.getFullYear()).slice(2)}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const t = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
  const group = from.header.attrs.get('DEFAULT_GROUP')?.value ?? '1,*,*,*,*';
  let n = 0;
  const numbered = bodies.map((b, i) => {
    const text = b.text.trim();
    // the terminator sits on the LAST line of a group: a line followed by a continuation has none
    const term = /;\s*$/.test(text) || bodies[i + 1]?.cont ? '' : ' ;';
    if (b.cont) return `    :  ${text}${term}`;
    n++;
    return `${String(n).padStart(4, ' ')}:${/^[JLCAS]\s/.test(text) ? text : `  ${text}`}${term}`;
  });
  return [
    `/PROG  ${name}`, '/ATTR', 'OWNER\t\t= MNEDITOR;', `COMMENT\t\t= "${name.slice(0, 16)}";`, 'PROG_SIZE\t= 0;',
    `CREATE\t\t= DATE ${d}  TIME ${t};`, `MODIFIED\t= DATE ${d}  TIME ${t};`, 'FILE_NAME\t= ;', 'VERSION\t\t= 0;',
    `LINE_COUNT\t= ${n};`, 'MEMORY_SIZE\t= 0;', 'PROTECT\t\t= READ_WRITE;',
    'TCD:  STACK_SIZE\t= 0,', '      TASK_PRIORITY\t= 50,', '      TIME_SLICE\t= 0,', '      BUSY_LAMP_OFF\t= 0,',
    '      ABORT_REQUEST\t= 0,', '      PAUSE_REQUEST\t= 0;',
    `DEFAULT_GROUP\t= ${group};`, 'CONTROL_CODE\t= 00000000 00000000;',
    '/MN', ...numbered, '/POS', ...posBlocks, '/END', '',
  ].join('\n');
}

/**
 * Apply whole-line changes bottom-up so earlier line numbers stay valid.
 *
 * Each line keeps its OWN terminator. Real backups mix them - `alt123.ls` carries 79 CRLF
 * and two lone LF - and since extract and inline write the whole document back, normalising
 * them here would show up as a diff on every line of a file where two lines were touched.
 * Inserted lines take the terminator of the block they replace, or the file's prevailing
 * one when they are replacing nothing.
 */
export function applyLineChanges(text: string, changes: LineChange[]): string {
  // split AFTER each newline, so every element carries its own ending
  const lines = text.split(/(?<=\n)/);
  const prevailing = (text.match(/\r\n/g)?.length ?? 0) * 2 >= (text.match(/\n/g)?.length ?? 0) ? '\r\n' : '\n';

  for (const c of [...changes].sort((a, b) => b.from - a.from)) {
    const count = Math.max(0, c.to - c.from + 1);
    let replacement: string[] = [];
    if (c.newText !== undefined) {
      // reuse the ending of the last line being replaced; a pure insert has none to reuse
      const displaced = count > 0 ? lines[c.from + count - 1] ?? '' : '';
      const ending = /\r\n$/.test(displaced) ? '\r\n' : /\n$/.test(displaced) ? '\n' : count > 0 ? '' : prevailing;
      replacement = c.newText.split('\n').map((l, i, all) => (i === all.length - 1 ? l + ending : l + prevailing));
    }
    lines.splice(c.from, count, ...replacement);
  }
  return lines.join('');
}
