/**
 * Register / I/O cross-reference across a set of TP programs: who reads, who writes.
 * Pure — takes parsed programs, returns rows. Also emits CSV / Markdown.
 */
import type { TpProgram, TpDataRef } from '../tp/parser';

export type Access = 'write' | 'read' | 'wait' | 'condition' | 'motion' | 'call-arg';

export interface XrefUse { program: string; tpLine: number; docLine: number; access: Access; text: string; comment?: string }
export interface XrefEntry {
  kind: string; index: number;
  comments: Map<string, number>;         // comment text → occurrences
  controllerComment?: string;
  uses: XrefUse[];
  writers: Set<string>; readers: Set<string>;
}

const WRITE_KINDS = new Set(['R', 'PR', 'SR', 'DO', 'RO', 'GO', 'AO', 'F', 'M', 'UO', 'SO', 'WO', 'SPO', 'TIMER', 'UFRAME', 'UTOOL']);

/**
 * Kinds for which "read but never written by a program" is worth saying. Outputs are left
 * out (reading back an output nobody drives is ordinary), and so is PR: a position register
 * is normally TAUGHT - recorded on the pendant, like a P[n] - so a program that moves to
 * PR[5] without any program assigning it is the usual case, not a finding.
 */
const EXPECTS_A_WRITER = new Set([...WRITE_KINDS].filter(k => !['DO', 'RO', 'GO', 'AO', 'PR'].includes(k)));

function classify(ref: TpDataRef, body: string, bodyStartCol: number): Access {
  const relCol = ref.span.col - bodyStartCol;
  const before = body.slice(0, Math.max(relCol, 0)).trim();
  const after = body.slice(relCol + ref.span.len).trimStart();
  if (before === '' && /^=(?!=)/.test(after) && WRITE_KINDS.has(ref.kind)) return 'write';
  if (/^(PR|R)\[\d+,\d+\]\s*=/.test(body) && before === '') return 'write';
  if (/^WAIT\b/.test(body)) return 'wait';
  if (/^(IF|SELECT|SKIP CONDITION|WHEN)\b/.test(body)) return 'condition';
  if (/^[JLCAS]\s/.test(body) && (ref.kind === 'PR' || /Offset|VOFFSET/.test(before))) return 'motion';
  if (/\bCALL\b.*\(/.test(before) || /^CALL\b/.test(body)) return 'call-arg';
  if (/^TIMER\[\d+\]\s*=/.test(body) && ref.kind === 'TIMER') return 'write';
  return 'read';
}

/**
 * How one program touches one register or I/O point, given the parsed program.
 *
 * Split out of buildXref so the workspace index can record the same judgement while it is
 * already parsing every file — the alternative was parsing the whole tree a second time
 * just to answer "does anyone else write this?" in the editor.
 */
export function accessOfRef(prog: TpProgram, ref: TpDataRef): Access {
  const line = prog.lines.find(l => l.line === ref.line);
  const body = line?.body ?? '';
  // body is trimmed; the span column is absolute, so account for the spaces after "N:"
  const afterNum = line ? line.raw.slice(line.bodyCol) : '';
  const bodyStartCol = (line?.bodyCol ?? 0) + (afterNum.length - afterNum.trimStart().length);
  return classify(ref, body, bodyStartCol);
}

/** Kinds this file considers writable, for callers that need the same rule. */
export function isWritableKind(kind: string): boolean { return WRITE_KINDS.has(kind); }

/**
 * The findings worth interrupting someone's editing for, derived from nothing more than
 * "which programs write this, which read it".
 *
 * Deliberately narrower than {@link xrefFindings}: comment disagreements are already
 * reported by the comment diagnostics, and repeating them inline would be two squiggles
 * for one problem. What is left is the shape of the usage itself, which nothing else sees.
 */
export function usageFindings(programs: Array<{ name: string; dataAccess: Map<string, 'w' | 'r'> }>): Map<string, string[]> {
  const writers = new Map<string, Set<string>>();
  const readers = new Map<string, Set<string>>();
  for (const p of programs) {
    for (const [key, how] of p.dataAccess) {
      const m = how === 'w' ? writers : readers;
      const set = m.get(key) ?? new Set<string>();
      set.add(p.name); m.set(key, set);
    }
  }
  const out = new Map<string, string[]>();
  const push = (key: string, msg: string) => { const a = out.get(key) ?? []; a.push(msg); out.set(key, a); };
  for (const key of new Set([...writers.keys(), ...readers.keys()])) {
    const kind = key.slice(0, key.indexOf(':'));
    const w = writers.get(key) ?? new Set<string>();
    const r = readers.get(key) ?? new Set<string>();
    // An output driven from two tasks at once is the one that bites in production.
    if ((kind === 'DO' || kind === 'RO' || kind === 'F') && w.size > 1) {
      push(key, `written from ${w.size} programs (${[...w].sort().join(', ')}) — check for a multitask conflict.`);
    }
    if (EXPECTS_A_WRITER.has(kind) && w.size === 0 && r.size > 0) {
      push(key, `read here but never written by any program in this robot's folder — set by KAREL, a PLC or the pendant?`);
    }
    if (['R', 'F', 'SR'].includes(kind) && r.size === 0 && w.size > 0) {
      push(key, `written but never read by any program in this robot's folder.`);
    }
  }
  return out;
}

export function buildXref(programs: Array<{ name: string; prog: TpProgram }>, controllerComment?: (kind: string, index: number) => string | undefined): XrefEntry[] {
  const map = new Map<string, XrefEntry>();
  for (const { name, prog } of programs) {
    for (const ref of prog.dataRefs) {
      if (ref.kind === 'AR' || ref.kind === 'GP') continue;
      const key = `${ref.kind}:${ref.index}`;
      let e = map.get(key);
      if (!e) { e = { kind: ref.kind, index: ref.index, comments: new Map(), controllerComment: controllerComment?.(ref.kind, ref.index), uses: [], writers: new Set(), readers: new Set() }; map.set(key, e); }
      const line = prog.lines.find(l => l.line === ref.line);
      const body = line?.body ?? '';
      const access = accessOfRef(prog, ref);
      e.uses.push({ program: name, tpLine: line?.num ?? 0, docLine: ref.line, access, text: body, comment: ref.comment });
      if (ref.comment) e.comments.set(ref.comment, (e.comments.get(ref.comment) ?? 0) + 1);
      (access === 'write' ? e.writers : e.readers).add(name);
    }
  }
  const kindOrder = ['R', 'PR', 'SR', 'DI', 'DO', 'RI', 'RO', 'GI', 'GO', 'AI', 'AO', 'UI', 'UO', 'SI', 'SO', 'F', 'M', 'TIMER', 'UALM', 'VR', 'WI', 'WO', 'SPI', 'SPO', 'WSI', 'WSO', 'DR', 'PL'];
  return [...map.values()].sort((a, b) => (kindOrder.indexOf(a.kind) - kindOrder.indexOf(b.kind)) || a.index - b.index);
}

export function xrefFindings(entries: XrefEntry[]): Array<{ entry: XrefEntry; finding: string }> {
  const out: Array<{ entry: XrefEntry; finding: string }> = [];
  for (const e of entries) {
    if (e.comments.size > 1) out.push({ entry: e, finding: `${e.comments.size} different inline comments: ${[...e.comments.keys()].map(c => `"${c}"`).join(', ')}` });
    if (EXPECTS_A_WRITER.has(e.kind) && e.writers.size === 0 && e.readers.size > 0) out.push({ entry: e, finding: 'read but never written in any indexed program (set by KAREL, PLC or the pendant?)' });
    if (e.readers.size === 0 && e.writers.size > 0 && (e.kind === 'R' || e.kind === 'F' || e.kind === 'SR')) out.push({ entry: e, finding: 'written but never read in any indexed program' });
    if ((e.kind === 'DO' || e.kind === 'RO' || e.kind === 'F') && e.writers.size > 1) out.push({ entry: e, finding: `written from ${e.writers.size} programs: ${[...e.writers].join(', ')} (multitask conflict?)` });
    if (e.controllerComment && e.comments.size && ![...e.comments.keys()].includes(e.controllerComment)) out.push({ entry: e, finding: `inline comment differs from controller comment "${e.controllerComment}"` });
  }
  return out;
}

export function xrefCsv(entries: XrefEntry[]): string {
  const esc = (s: string) => `"${String(s).replace(/"/g, '""')}"`;
  const rows = ['Kind,Index,ControllerComment,Program,TPLine,Access,InlineComment,Instruction'];
  for (const e of entries) for (const u of e.uses) rows.push([e.kind, e.index, e.controllerComment ?? '', u.program, u.tpLine, u.access, u.comment ?? '', u.text].map(x => esc(String(x))).join(','));
  return rows.join('\r\n');
}

export function xrefMarkdown(entries: XrefEntry[], findings: ReturnType<typeof xrefFindings>): string {
  const out = ['# Register & I/O cross-reference', '', `${entries.length} distinct items, ${entries.reduce((n, e) => n + e.uses.length, 0)} uses.`, ''];
  if (findings.length) { out.push('## Findings', ''); for (const f of findings) out.push(`- **${f.entry.kind}[${f.entry.index}]** — ${f.finding}`); out.push(''); }
  out.push('## Items', '', '| Item | Comment | Writers | Readers | Uses |', '|---|---|---|---|---|');
  for (const e of entries) out.push(`| ${e.kind}[${e.index}] | ${e.controllerComment ?? [...e.comments.keys()][0] ?? ''} | ${[...e.writers].join(', ')} | ${[...e.readers].join(', ')} | ${e.uses.length} |`);
  return out.join('\n');
}
