/**
 * Backup diff: compare two controller backup folders (or any two folders of .ls/.va files).
 * Pure node — no VS Code dependency — so it is unit-tested against the real backup.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { parseTp, type TpProgram, type TpPosition } from '../tp/parser';
import { parseNumReg, parsePosReg, parseStrReg, parseIoComments, parseMacroTable } from '../data/vaParser';

export interface PositionDelta { index: number; dx: number; dy: number; dz: number; dw: number; dp: number; dr: number; distance: number; ufChanged?: [number | undefined, number | undefined]; utChanged?: [number | undefined, number | undefined]; kind: 'moved' | 'added' | 'removed' | 'reframed' }
export interface ProgramChange {
  name: string;
  kind: 'added' | 'removed' | 'changed' | 'positions-only' | 'header-only';
  fileA?: string; fileB?: string;
  linesA?: number; linesB?: number;
  /** instruction lines added/removed (body text, ignoring line numbers) */
  linesAdded: number; linesRemoved: number;
  positions: PositionDelta[];
  commentA?: string; commentB?: string;
}
export interface ValueChange<T = string> { index: number; a?: T; b?: T; commentA?: string; commentB?: string; kind: 'added' | 'removed' | 'value' | 'comment' | 'both' }
export interface IoChange { kind: string; index: number; a?: string; b?: string; change: 'added' | 'removed' | 'renamed' }
export interface OtherFileChange { name: string; kind: 'added' | 'removed' | 'changed'; sizeA?: number; sizeB?: number }

export interface BackupDiff {
  a: string; b: string;
  programs: ProgramChange[];
  numregs: ValueChange<number | string>[];
  posregs: ValueChange<string>[];
  strregs: ValueChange<string>[];
  io: IoChange[];
  macros: Array<{ index: number; a?: string; b?: string }>;
  otherFiles: OtherFileChange[];
  summary: { programs: number; positions: number; numregs: number; posregs: number; strregs: number; io: number; macros: number; otherFiles: number };
}

const VOLATILE_ATTRS = new Set(['CREATE', 'MODIFIED', 'PROG_SIZE', 'MEMORY_SIZE', 'FILE_NAME', 'VERSION']);
const REGISTER_FILES = new Set(['numreg.va', 'posreg.va', 'strreg.va', 'diocfgsv.va', 'sysmacro.va']);
const IGNORED_FILES = /\.(dg|zip|log|txt)$|^err.*\.ls$|^hist\.ls$|^logbook\.ls$|^updtlog\.ls$|^vtrndiag\.ls$/i;

function listFiles(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string, depth: number) => {
    if (depth > 3) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (!out.has(e.name.toLowerCase())) out.set(e.name.toLowerCase(), p);
    }
  };
  walk(dir, 0);
  return out;
}

function read(p: string | undefined): string | undefined { return p ? fs.readFileSync(p, 'latin1') : undefined; }
function hash(p: string): string { return createHash('sha1').update(fs.readFileSync(p)).digest('hex'); }

export function diffBackups(dirA: string, dirB: string): BackupDiff {
  const fa = listFiles(dirA), fb = listFiles(dirB);
  const names = new Set([...fa.keys(), ...fb.keys()]);
  const result: BackupDiff = { a: dirA, b: dirB, programs: [], numregs: [], posregs: [], strregs: [], io: [], macros: [], otherFiles: [], summary: { programs: 0, positions: 0, numregs: 0, posregs: 0, strregs: 0, io: 0, macros: 0, otherFiles: 0 } };

  for (const name of [...names].sort()) {
    const pa = fa.get(name), pb = fb.get(name);
    if (name.endsWith('.ls') && !IGNORED_FILES.test(name)) {
      const ta = read(pa), tb = read(pb);
      if ((ta && !/^\/PROG\b/m.test(ta)) || (tb && !/^\/PROG\b/m.test(tb))) continue;
      const ch = diffProgram(name.replace(/\.ls$/, '').toUpperCase(), pa, pb, ta, tb);
      if (ch) result.programs.push(ch);
      continue;
    }
    if (REGISTER_FILES.has(name)) continue; // handled below
    if (IGNORED_FILES.test(name)) continue;
    if (!pa || !pb) result.otherFiles.push({ name, kind: pa ? 'removed' : 'added', sizeA: pa ? fs.statSync(pa).size : undefined, sizeB: pb ? fs.statSync(pb).size : undefined });
    else if (hash(pa) !== hash(pb)) result.otherFiles.push({ name, kind: 'changed', sizeA: fs.statSync(pa).size, sizeB: fs.statSync(pb).size });
  }

  // registers
  const na = parseNumReg(read(fa.get('numreg.va')) ?? ''), nb = parseNumReg(read(fb.get('numreg.va')) ?? '');
  result.numregs = diffValues(new Map(na.map(r => [r.index, { v: r.value, c: r.comment }])), new Map(nb.map(r => [r.index, { v: r.value, c: r.comment }])));
  const pa = parsePosReg(read(fa.get('posreg.va')) ?? '').filter(r => r.group === 1), pb = parsePosReg(read(fb.get('posreg.va')) ?? '').filter(r => r.group === 1);
  result.posregs = diffValues(new Map(pa.map(r => [r.index, { v: r.kind === 'uninit' ? '' : r.summary, c: r.comment }])), new Map(pb.map(r => [r.index, { v: r.kind === 'uninit' ? '' : r.summary, c: r.comment }])));
  const sa = parseStrReg(read(fa.get('strreg.va')) ?? ''), sb = parseStrReg(read(fb.get('strreg.va')) ?? '');
  result.strregs = diffValues(new Map(sa.map(r => [r.index, { v: r.value, c: r.comment }])), new Map(sb.map(r => [r.index, { v: r.value, c: r.comment }])));
  // I/O comments
  const ia = new Map(parseIoComments(read(fa.get('diocfgsv.va')) ?? '').map(e => [`${e.kind}:${e.index}`, e.comment]));
  const ib = new Map(parseIoComments(read(fb.get('diocfgsv.va')) ?? '').map(e => [`${e.kind}:${e.index}`, e.comment]));
  for (const key of new Set([...ia.keys(), ...ib.keys()])) {
    const a = ia.get(key), b = ib.get(key);
    if (a === b) continue;
    const [kind, idx] = key.split(':');
    result.io.push({ kind, index: parseInt(idx, 10), a, b, change: a === undefined ? 'added' : b === undefined ? 'removed' : 'renamed' });
  }
  result.io.sort((x, y) => x.kind.localeCompare(y.kind) || x.index - y.index);
  // macros
  const ma = new Map(parseMacroTable(read(fa.get('sysmacro.va')) ?? '').map(m => [m.index, `${m.macroName} → ${m.progName}`]));
  const mb = new Map(parseMacroTable(read(fb.get('sysmacro.va')) ?? '').map(m => [m.index, `${m.macroName} → ${m.progName}`]));
  for (const i of new Set([...ma.keys(), ...mb.keys()])) if (ma.get(i) !== mb.get(i)) result.macros.push({ index: i, a: ma.get(i), b: mb.get(i) });
  result.macros.sort((x, y) => x.index - y.index);

  result.summary = {
    programs: result.programs.length,
    positions: result.programs.reduce((n, p) => n + p.positions.length, 0),
    numregs: result.numregs.length, posregs: result.posregs.length, strregs: result.strregs.length,
    io: result.io.length, macros: result.macros.length, otherFiles: result.otherFiles.length,
  };
  return result;
}

function diffValues<T>(a: Map<number, { v: T; c: string }>, b: Map<number, { v: T; c: string }>): ValueChange<T>[] {
  const out: ValueChange<T>[] = [];
  for (const i of [...new Set([...a.keys(), ...b.keys()])].sort((x, y) => x - y)) {
    const ra = a.get(i), rb = b.get(i);
    if (!ra && rb) { if (rb.v !== '' && rb.v !== 0 || rb.c) out.push({ index: i, b: rb.v, commentB: rb.c, kind: 'added' }); continue; }
    if (ra && !rb) { if (ra.v !== '' && ra.v !== 0 || ra.c) out.push({ index: i, a: ra.v, commentA: ra.c, kind: 'removed' }); continue; }
    if (!ra || !rb) continue;
    const vDiff = String(ra.v) !== String(rb.v), cDiff = ra.c !== rb.c;
    if (vDiff || cDiff) out.push({ index: i, a: ra.v, b: rb.v, commentA: ra.c, commentB: rb.c, kind: vDiff && cDiff ? 'both' : vDiff ? 'value' : 'comment' });
  }
  return out;
}

function bodyLines(p: TpProgram): string[] {
  return p.lines.filter(l => l.kind !== 'header' && l.kind !== 'section' && l.kind !== 'pos' && l.kind !== 'empty' && l.seq !== undefined || l.kind === 'continuation').map(l => l.body.replace(/\s+/g, ' ').trim());
}

/**
 * Compare one program against another copy of itself. Exported because "has anyone touched
 * this on the pendant?" is the same question as a backup diff, asked about one file.
 */
export function diffProgram(name: string, fileA: string | undefined, fileB: string | undefined, ta: string | undefined, tb: string | undefined): ProgramChange | undefined {
  if (!ta && !tb) return undefined;
  if (!ta || !tb) {
    const p = parseTp(ta ?? tb!);
    return { name, kind: ta ? 'removed' : 'added', fileA, fileB, linesA: ta ? p.numberedLineCount : undefined, linesB: tb ? p.numberedLineCount : undefined, linesAdded: tb ? p.numberedLineCount : 0, linesRemoved: ta ? p.numberedLineCount : 0, positions: [], commentA: ta ? attr(p, 'COMMENT') : undefined, commentB: tb ? attr(p, 'COMMENT') : undefined };
  }
  const pa = parseTp(ta), pb = parseTp(tb);
  const la = bodyLines(pa), lb = bodyLines(pb);
  const { added, removed } = lcsDiffCounts(la, lb);
  const positions = diffPositions(pa.positions, pb.positions);
  const headerDiff = [...new Set([...pa.header.attrs.keys(), ...pb.header.attrs.keys()])].filter(k => !VOLATILE_ATTRS.has(k)).some(k => pa.header.attrs.get(k)?.value !== pb.header.attrs.get(k)?.value);
  if (!added && !removed && !positions.length && !headerDiff) return undefined;
  const kind: ProgramChange['kind'] = added || removed ? 'changed' : positions.length ? 'positions-only' : 'header-only';
  return { name, kind, fileA, fileB, linesA: pa.numberedLineCount, linesB: pb.numberedLineCount, linesAdded: added, linesRemoved: removed, positions, commentA: attr(pa, 'COMMENT'), commentB: attr(pb, 'COMMENT') };
}

function attr(p: TpProgram, key: string): string | undefined { return p.header.attrs.get(key)?.value.replace(/^"|"$/g, ''); }

/** counts of added/removed lines via LCS on normalised instruction text */
export function lcsDiffCounts(a: string[], b: string[]): { added: number; removed: number } {
  const n = a.length, m = b.length;
  if (n * m > 4_000_000) { // very large: fall back to multiset difference
    const cnt = new Map<string, number>();
    for (const x of a) cnt.set(x, (cnt.get(x) ?? 0) + 1);
    let common = 0;
    for (const y of b) { const c = cnt.get(y) ?? 0; if (c > 0) { common++; cnt.set(y, c - 1); } }
    return { added: m - common, removed: n - common };
  }
  const prev = new Uint32Array(m + 1); const cur = new Uint32Array(m + 1);
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    prev.set(cur);
  }
  const lcs = prev[m];
  return { added: m - lcs, removed: n - lcs };
}

function diffPositions(a: TpPosition[], b: TpPosition[]): PositionDelta[] {
  const out: PositionDelta[] = [];
  const ma = new Map(a.map(p => [p.index, p])), mb = new Map(b.map(p => [p.index, p]));
  for (const i of [...new Set([...ma.keys(), ...mb.keys()])].sort((x, y) => x - y)) {
    const pa = ma.get(i), pb = mb.get(i);
    if (!pa || !pb) { out.push({ index: i, dx: 0, dy: 0, dz: 0, dw: 0, dp: 0, dr: 0, distance: 0, kind: pa ? 'removed' : 'added' }); continue; }
    const ga = pa.groups[0], gb = pb.groups[0];
    if (!ga || !gb) continue;
    const v = (g: typeof ga, k: string) => g.values[k]?.value ?? 0;
    const keys = ga.kind === 'joint' ? Object.keys({ ...ga.values, ...gb.values }) : ['X', 'Y', 'Z', 'W', 'P', 'R'];
    const deltas = keys.map(k => v(gb, k) - v(ga, k));
    const moved = deltas.some(d => Math.abs(d) > 0.0005) || ga.kind !== gb.kind || ga.config !== gb.config;
    const reframed = ga.uf !== gb.uf || ga.ut !== gb.ut;
    if (!moved && !reframed) continue;
    const [dx = 0, dy = 0, dz = 0, dw = 0, dp = 0, dr = 0] = deltas;
    out.push({ index: i, dx, dy, dz, dw, dp, dr, distance: ga.kind === 'joint' ? Math.max(...deltas.map(Math.abs)) : Math.hypot(dx, dy, dz), kind: moved ? 'moved' : 'reframed', ufChanged: ga.uf !== gb.uf ? [ga.uf, gb.uf] : undefined, utChanged: ga.ut !== gb.ut ? [ga.ut, gb.ut] : undefined });
  }
  return out;
}

/** Markdown report (for saving / sharing) */
export function backupDiffMarkdown(d: BackupDiff): string {
  const f = (n: number) => (Math.abs(n) < 0.0005 ? '0' : n.toFixed(3));
  const out: string[] = [`# Backup diff`, '', `- A: \`${d.a}\``, `- B: \`${d.b}\``, '', `| Programs | Positions | R | PR | SR | I/O comments | Macros | Other files |`, `|---|---|---|---|---|---|---|---|`, `| ${d.summary.programs} | ${d.summary.positions} | ${d.summary.numregs} | ${d.summary.posregs} | ${d.summary.strregs} | ${d.summary.io} | ${d.summary.macros} | ${d.summary.otherFiles} |`, ''];
  if (d.programs.length) {
    out.push('## Programs', '', '| Program | Change | Lines A → B | +/− | Positions | Comment |', '|---|---|---|---|---|---|');
    for (const p of d.programs) out.push(`| ${p.name} | ${p.kind} | ${p.linesA ?? '—'} → ${p.linesB ?? '—'} | +${p.linesAdded} / −${p.linesRemoved} | ${p.positions.length} | ${p.commentA === p.commentB ? p.commentA ?? '' : `${p.commentA ?? ''} → ${p.commentB ?? ''}`} |`);
    out.push('');
    for (const p of d.programs.filter(x => x.positions.length)) {
      out.push(`### ${p.name} positions`, '', '| P | Change | ΔX | ΔY | ΔZ | ΔW | ΔP | ΔR | Distance | Frame |', '|---|---|---|---|---|---|---|---|---|---|');
      for (const q of p.positions) out.push(`| P[${q.index}] | ${q.kind} | ${f(q.dx)} | ${f(q.dy)} | ${f(q.dz)} | ${f(q.dw)} | ${f(q.dp)} | ${f(q.dr)} | ${f(q.distance)} | ${q.ufChanged ? `UF ${q.ufChanged[0]}→${q.ufChanged[1]} ` : ''}${q.utChanged ? `UT ${q.utChanged[0]}→${q.utChanged[1]}` : ''} |`);
      out.push('');
    }
  }
  const vals = (title: string, prefix: string, rows: ValueChange<any>[]) => {
    if (!rows.length) return;
    out.push(`## ${title}`, '', '| Register | Change | A | B | Comment A | Comment B |', '|---|---|---|---|---|---|');
    for (const r of rows) out.push(`| ${prefix}[${r.index}] | ${r.kind} | ${r.a ?? ''} | ${r.b ?? ''} | ${r.commentA ?? ''} | ${r.commentB ?? ''} |`);
    out.push('');
  };
  vals('Numeric registers', 'R', d.numregs); vals('Position registers', 'PR', d.posregs); vals('String registers', 'SR', d.strregs);
  if (d.io.length) { out.push('## I/O comments', '', '| Point | Change | A | B |', '|---|---|---|---|'); for (const i of d.io) out.push(`| ${i.kind}[${i.index}] | ${i.change} | ${i.a ?? ''} | ${i.b ?? ''} |`); out.push(''); }
  if (d.macros.length) { out.push('## Macro table', '', '| # | A | B |', '|---|---|---|'); for (const m of d.macros) out.push(`| ${m.index} | ${m.a ?? ''} | ${m.b ?? ''} |`); out.push(''); }
  if (d.otherFiles.length) { out.push('## Other files', '', '| File | Change | Size A | Size B |', '|---|---|---|---|'); for (const o of d.otherFiles) out.push(`| ${o.name} | ${o.kind} | ${o.sizeA ?? ''} | ${o.sizeB ?? ''} |`); out.push(''); }
  return out.join('\n');
}
