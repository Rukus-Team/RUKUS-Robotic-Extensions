/**
 * Control-flow graph of one TP program: basic blocks split at labels, jumps, IF/SELECT
 * branches, FOR loops and terminators; edges carry the condition text. Pure TypeScript.
 */
import type { TpProgram, TpLine } from './parser';

export type FlowNodeKind = 'entry' | 'label' | 'block' | 'branch' | 'loop' | 'end';
export interface FlowLine { num: number; docLine: number; text: string; kind: 'motion' | 'call' | 'macro' | 'logic' | 'comment' }
export interface FlowNode {
  id: number;
  kind: FlowNodeKind;
  /** LBL number when the block starts with a label */
  label?: number;
  title: string;
  lines: FlowLine[];
  /** first document line (for click-to-reveal) */
  docLine: number;
  firstNum?: number;
  lastNum?: number;
}
export type FlowEdgeKind = 'next' | 'jump' | 'true' | 'false' | 'case' | 'timeout' | 'skip' | 'loop' | 'exit';
/**
 * `label` is the full text, never shortened here: which condition sends control where is
 * the whole point of the drawing, and a condition cut off at 36 characters was routinely
 * cut off before the part that differed between two branches. Renderers wrap or tooltip
 * it; they do not truncate it. On a `true`/`false` edge the label IS the IF condition,
 * and both edges of one IF carry the same text so the reader sees "R[1]=1 → here, NOT
 * R[1]=1 → there" without having to find the other arrow.
 */
export interface FlowEdge { from: number; to: number; kind: FlowEdgeKind; label?: string; back: boolean }
export interface FlowGraph { nodes: FlowNode[]; edges: FlowEdge[]; unresolved: Array<{ label: number; from: number }> }

const RE_IF_JMP = /^IF\s+(.+?),\s*JMP\s+LBL\[(\d+)\]/;
const RE_IF_CALL = /^IF\s+(.+?),\s*CALL\s+([A-Za-z0-9_]+)/;
const RE_IF_THEN = /^IF\s+(.+?)\s+THEN\s*$/;
const RE_SELECT = /^SELECT\s+(.+?)=(.+?),\s*(JMP\s+LBL\[(\d+)\]|CALL\s+\S+)/;
const RE_CASE = /^=(.+?),\s*(JMP\s+LBL\[(\d+)\]|CALL\s+\S+)/;
const RE_ELSE_CASE = /^ELSE,\s*(JMP\s+LBL\[(\d+)\]|CALL\s+\S+)/;
const RE_JMP = /^JMP\s+LBL\[(\d+)\]/;
const RE_LBL = /^LBL\[(\d+)(?::([^\]]*))?\]/;
const RE_TIMEOUT = /TIMEOUT,\s*LBL\[(\d+)\]/;
const RE_SKIP = /Skip,\s*LBL\[(\d+)\]/;
const RE_END = /^(END|ABORT|RETURN)\b/;
const RE_FOR = /^FOR\s+(.+)$/;

export function buildFlow(prog: TpProgram): FlowGraph {
  const nodes: FlowNode[] = [];
  const edges: FlowEdge[] = [];
  const unresolved: FlowGraph['unresolved'] = [];
  const mn = prog.sections.mn;
  if (mn === undefined) return { nodes, edges, unresolved };
  const posStart = prog.sections.pos ?? prog.sections.end ?? Number.MAX_SAFE_INTEGER;
  // `seq` not `num`: a program in the editor's numberless style still has every line counted
  const body = prog.lines.filter(l => l.line > mn && l.line < posStart && l.seq !== undefined && l.kind !== 'blank' && l.kind !== 'empty' && l.kind !== 'remark');

  // ---- pass 1: cut into blocks ----
  let cur: FlowNode | undefined;
  let pendingComment: string | undefined;
  const pendingJumps: Array<{ from: number; label: number; kind: FlowEdgeKind; text?: string }> = [];
  const fallthrough: Array<{ from: number; kind: FlowEdgeKind; text?: string }> = []; // edges to "whatever block comes next"
  const ifThenStack: Array<{ ifNode: number; cond: string; thenEnd?: number; elseStart?: boolean; falseTargets: Array<{ from: number; kind: FlowEdgeKind; text?: string }> }> = [];
  const forStack: Array<{ forNode: number }> = [];

  /**
   * ELSE / ENDIF lines waiting for the block they belong to.
   *
   * They mark a merge, so their home is the block control flow merges INTO — the next
   * one — not the branch that just ended. Deferring them is also the only way they can
   * be recorded at all when that branch ended in JMP, END or ABORT and left no block
   * open, which is how they used to fall on the floor entirely.
   */
  const pendingLines: TpLine[] = [];

  /**
   * Comments ahead of the first block. They used to vanish - the entry node was titled
   * "Start" regardless - so a program's banner, the one comment that says what it is for,
   * was the one the graph did not show. They ride on the entry title now.
   */
  const leading: string[] = [];
  const newNode = (kind: FlowNodeKind, title: string, l: TpLine, label?: number): FlowNode => {
    const n: FlowNode = { id: nodes.length, kind, title, lines: [], docLine: l.line, label };
    nodes.push(n);
    // wire everything that was waiting for "the next block"
    for (const f of fallthrough.splice(0)) edges.push({ from: f.from, to: n.id, kind: f.kind, label: f.text, back: false });
    drainPending(n);
    return n;
  };
  const entryTitle = () => (leading.length ? `Start · ${leading.join(' · ')}` : 'Start');
  // A comment titles the ONE block that follows it. It used to stay armed, so every block
  // after a "!Set Robot UFRAME/UTOOL" was titled that until the next comment came along.
  const ensure = (l: TpLine): FlowNode => {
    if (cur) return cur;
    cur = newNode(nodes.length ? 'block' : 'entry', nodes.length ? (pendingComment ?? '') : entryTitle(), l);
    pendingComment = undefined;
    return cur;
  };
  const closeNode = (kind: FlowEdgeKind = 'next', text?: string) => { if (cur) { fallthrough.push({ from: cur.id, kind, text }); cur = undefined; } };
  const addLine = (n: FlowNode, l: TpLine, kind: FlowLine['kind']) => { const num = l.num ?? l.seq!; n.lines.push({ num, docLine: l.line, text: l.body, kind }); n.firstNum ??= num; n.lastNum = num; };
  function drainPending(n: FlowNode) { for (const p of pendingLines.splice(0)) addLine(n, p, 'logic'); }

  for (const l of body) {
    const t = l.body;
    if (l.kind === 'comment') {
      const text = t.replace(/^--eg:?\s*/i, '').replace(/^!+\s*/, '').replace(/^[-*=_ ]+$/, '').trim();
      if (text && !/^[-*=_]{3,}/.test(text)) { if (!cur) { pendingComment = text; if (!nodes.length) leading.push(text); } else if (cur.lines.length < 40) addLine(cur, l, 'comment'); }
      continue;
    }
    if (l.kind === 'continuation') { if (cur) addLine(cur, l, 'motion'); continue; }

    // label starts a new block (merge point)
    const lbl = RE_LBL.exec(t);
    if (lbl) {
      closeNode();
      const num = parseInt(lbl[1], 10);
      // a program that opens with a label: its banner still belongs to the first node
      const banner = !nodes.length && leading.length ? ` · ${leading.join(' · ')}` : '';
      cur = newNode('label', `LBL[${num}]${lbl[2] ? ` ${lbl[2].trim()}` : pendingComment ? ` ${pendingComment}` : ''}${banner}`, l, num);
      pendingComment = undefined;
      addLine(cur, l, 'logic');
      continue;
    }
    pendingComment = pendingComment && !cur ? pendingComment : pendingComment;

    let m: RegExpExecArray | null;
    if ((m = RE_JMP.exec(t))) { const n = ensure(l); addLine(n, l, 'logic'); pendingJumps.push({ from: n.id, label: parseInt(m[1], 10), kind: 'jump' }); cur = undefined; continue; }
    if ((m = RE_IF_JMP.exec(t))) {
      const n = ensure(l); addLine(n, l, 'logic'); n.kind = n.kind === 'entry' || n.kind === 'label' ? n.kind : 'branch';
      const cond = tidy(m[1]);
      pendingJumps.push({ from: n.id, label: parseInt(m[2], 10), kind: 'true', text: cond });
      closeNode('false', cond); continue;
    }
    if ((m = RE_SELECT.exec(t))) {
      const n = ensure(l); addLine(n, l, 'logic'); n.kind = n.kind === 'entry' || n.kind === 'label' ? n.kind : 'branch';
      if (m[4]) pendingJumps.push({ from: n.id, label: parseInt(m[4], 10), kind: 'case', text: `${tidy(m[1])} = ${m[2].trim()}` });
      cur = n; // cases follow on the next lines; keep node open in "select" mode
      (n as any)._select = tidy(m[1]);
      continue;
    }
    if (cur && (cur as any)._select && (m = RE_CASE.exec(t))) { addLine(cur, l, 'logic'); if (m[3]) pendingJumps.push({ from: cur.id, label: parseInt(m[3], 10), kind: 'case', text: `${(cur as any)._select} = ${m[1].trim()}` }); continue; }
    if (cur && (cur as any)._select && (m = RE_ELSE_CASE.exec(t))) {
      addLine(cur, l, 'logic');
      if (m[2]) { pendingJumps.push({ from: cur.id, label: parseInt(m[2], 10), kind: 'case', text: 'ELSE' }); cur = undefined; } else closeNode('case', 'ELSE');
      continue;
    }
    if (cur && (cur as any)._select) { const sel = (cur as any)._select; delete (cur as any)._select; closeNode('false', `${sel} matched no case`); }

    if ((m = RE_IF_THEN.exec(t))) {
      const n = ensure(l); addLine(n, l, 'logic'); n.kind = n.kind === 'entry' || n.kind === 'label' ? n.kind : 'branch';
      const cond = tidy(m[1]);
      ifThenStack.push({ ifNode: n.id, cond, falseTargets: [] });
      // true path = next block; the false path waits for ELSE/ENDIF
      fallthrough.push({ from: n.id, kind: 'true', text: cond });
      cur = undefined; continue;
    }
    if (/^ELSE\s*$/.test(t)) {
      const f = ifThenStack[ifThenStack.length - 1];
      if (f) { if (cur) { f.falseTargets.push({ from: cur.id, kind: 'next' }); cur = undefined; } else if (fallthrough.length) f.falseTargets.push(...fallthrough.splice(0)); f.elseStart = true; fallthrough.push({ from: f.ifNode, kind: 'false', text: f.cond }); }
      pendingLines.push(l);   // heads the else branch
      continue;
    }
    if (/^ENDIF\s*$/.test(t)) {
      const f = ifThenStack.pop();
      if (f) { closeNode(); if (!f.elseStart) fallthrough.push({ from: f.ifNode, kind: 'false', text: f.cond }); fallthrough.push(...f.falseTargets); }
      pendingLines.push(l);   // heads the block the branches merge into
      continue;
    }
    if ((m = RE_FOR.exec(t))) {
      closeNode();
      // a program that opens with a FOR: its banner rides on the loop node, as it does on a label
      const banner = !nodes.length && leading.length ? ` · ${leading.join(' · ')}` : '';
      cur = newNode('loop', `FOR ${tidy(m[1])}${banner}`, l); pendingComment = undefined; addLine(cur, l, 'logic'); forStack.push({ forNode: cur.id }); closeNode('true', 'loop body'); continue;
    }
    if (/^ENDFOR\s*$/.test(t)) {
      const f = forStack.pop();
      if (f) { const n = ensure(l); addLine(n, l, 'logic'); edges.push({ from: n.id, to: f.forNode, kind: 'loop', label: 'next iteration', back: true }); cur = undefined; fallthrough.push({ from: f.forNode, kind: 'exit', text: 'done' }); }
      continue;
    }
    if (RE_END.exec(t)) { const n = ensure(l); addLine(n, l, 'logic'); n.kind = 'end'; if (!n.title) n.title = t; cur = undefined; continue; }

    // ordinary line
    const n = ensure(l);
    const kind: FlowLine['kind'] = l.kind === 'motion' ? 'motion' : /^(CALL|RUN)\b/.test(t) ? 'call' : prog.macros.some(mc => mc.line === l.line) ? 'macro' : 'logic';
    addLine(n, l, kind);
    if ((m = RE_TIMEOUT.exec(t))) { pendingJumps.push({ from: n.id, label: parseInt(m[1], 10), kind: 'timeout', text: 'timeout' }); }
    if ((m = RE_SKIP.exec(t))) { pendingJumps.push({ from: n.id, label: parseInt(m[1], 10), kind: 'skip', text: 'skip' }); }
    if ((m = RE_IF_CALL.exec(t))) { /* conditional call stays inside the block */ }
  }
  // end of program: whatever is still open runs off the end into an implicit END.
  // A trailing ELSE/ENDIF lands here too — it is the last merge point there is.
  if (cur) { delete (cur as any)._select; closeNode(); }
  if (fallthrough.length || pendingLines.length) {
    const endNode: FlowNode = { id: nodes.length, kind: 'end', title: 'END', lines: [], docLine: body[body.length - 1]?.line ?? mn };
    nodes.push(endNode);
    for (const f of fallthrough.splice(0)) edges.push({ from: f.from, to: endNode.id, kind: f.kind, label: f.text, back: false });
    drainPending(endNode);
  }

  // ---- pass 2: resolve jumps to label nodes ----
  const byLabel = new Map<number, number>();
  for (const n of nodes) if (n.label !== undefined && !byLabel.has(n.label)) byLabel.set(n.label, n.id);
  for (const j of pendingJumps) {
    const to = byLabel.get(j.label);
    if (to === undefined) { unresolved.push({ label: j.label, from: j.from }); continue; }
    edges.push({ from: j.from, to, kind: j.kind, label: j.kind === 'jump' ? undefined : j.text, back: to <= j.from });
  }
  // dedupe identical edges
  const seen = new Set<string>();
  const uniq = edges.filter(e => { const k = `${e.from}>${e.to}:${e.kind}:${e.label ?? ''}`; if (seen.has(k)) return false; seen.add(k); return true; });
  // titles for untitled blocks - the full first line; the renderer sizes the box to fit
  for (const n of nodes) {
    if (!n.title) {
      const first = n.lines.find(x => x.kind !== 'comment');
      n.title = first ? tidy(first.text) : `lines ${n.firstNum ?? ''}–${n.lastNum ?? ''}`;
    }
    delete (n as any)._select;
  }
  return { nodes, edges: uniq, unresolved };
}

/** whitespace-normalised, nothing removed */
function tidy(s: string): string { return s.replace(/\s+/g, ' ').trim(); }

export function shorten(s: string, max = 36): string {
  const t = tidy(s);
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

/**
 * What an edge says, with its routing spelled out: a `true` edge reads "TRUE: R[1]=1" and
 * its sibling "FALSE: R[1]=1", so either arrow on its own tells you the whole decision.
 */
export function edgeText(e: FlowEdge): string {
  if (!e.label) return '';
  if (e.kind === 'true') return `TRUE: ${e.label}`;
  if (e.kind === 'false') return `FALSE: ${e.label}`;
  return e.label;
}

/** Where an edge lands, named the way the program names it: a label, else a line number, else END. */
export function landing(g: FlowGraph, e: FlowEdge): string {
  const n = g.nodes[e.to];
  if (!n) return '?';
  if (n.kind === 'end') return n.firstNum !== undefined ? `END (line ${n.firstNum})` : 'END';
  if (n.label !== undefined) return `LBL[${n.label}]${n.firstNum !== undefined ? ` (line ${n.firstNum})` : ''}`;
  return n.firstNum !== undefined ? `line ${n.firstNum}` : n.title;
}

/**
 * The whole caption of an edge: how control gets there and where it lands. A fall-through
 * is captioned too - "falls through → line 12" - because the branch nobody drew is the one
 * that surprises people.
 */
export function edgeCaption(g: FlowGraph, e: FlowEdge): string {
  const t = edgeText(e);
  const land = landing(g, e);
  if (e.kind === 'next') return `falls through → ${land}`;
  if (e.kind === 'jump') return `JMP → ${land}`;
  return `${t ? `${t} ` : ''}→ ${land}`;
}

/** Mermaid flowchart export - full text, no truncation, so the export reads like the program */
export function flowToMermaid(g: FlowGraph, programName: string): string {
  const esc = (s: string) => s.replace(/"/g, "'").replace(/[\[\]{}()]/g, ' ').replace(/\|/g, '/');
  const out = ['flowchart TD', `  %% ${programName}`];
  for (const n of g.nodes) {
    const shown = n.lines.filter(l => l.kind !== 'comment');
    const body = shown.slice(0, 6).map(l => `${l.num}: ${esc(tidy(l.text))}`).join('<br/>');
    const label = `${esc(n.title)}${body ? '<br/>' + body : ''}${shown.length > 6 ? `<br/>… ${shown.length - 6} more` : ''}`;
    const shape = n.kind === 'entry' || n.kind === 'end' ? [`([`, `])`] : n.kind === 'branch' ? ['{{', '}}'] : n.kind === 'loop' ? ['[/', '/]'] : ['[', ']'];
    out.push(`  B${n.id}${shape[0]}"${label}"${shape[1]}`);
  }
  for (const e of g.edges) { const t = edgeCaption(g, e); out.push(`  B${e.from} ${e.back ? '-.->' : '-->'}${t ? `|${esc(t)}|` : ''} B${e.to}`); }
  return out.join('\n');
}
