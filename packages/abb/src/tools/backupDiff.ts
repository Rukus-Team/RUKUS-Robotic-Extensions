/**
 * Compare two ABB backups (IRC5 or OmniCore): per task, the modules added, removed and changed,
 * inside a changed module the routines added, removed and changed and the robtargets that moved,
 * and the SYSPAR configuration files that changed. Pure (node fs only), so it is tested against
 * real backups; the command (index.ts) only shows the Markdown.
 *
 * A module is compared by its text with whitespace runs folded, so a re-indented module is not
 * "changed". Encrypted modules are compared by bytes only.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseRapid, robTargetsOf, type RapidModule } from '../rapid/parser';
import { readBackupInfo } from '../backupInfo';

export interface RoutineChange { name: string; kind: 'added' | 'removed' | 'changed'; linesA?: number; linesB?: number }
export interface TargetMove { name: string; kind: 'moved' | 'added' | 'removed'; distance?: number; rotated?: boolean }
export interface ModuleChange {
  task: string;
  module: string;
  kind: 'added' | 'removed' | 'changed';
  fileA?: string; fileB?: string;
  linesAdded: number; linesRemoved: number;
  routines: RoutineChange[];
  targets: TargetMove[];
  /** module-level data whose declaration was added, removed or changed (robtargets are in `targets`) */
  data: { name: string; kind: 'added' | 'removed' | 'changed'; type: string }[];
  encrypted?: boolean;
}
export interface CfgChange { file: string; kind: 'added' | 'removed' | 'changed'; linesAdded: number; linesRemoved: number }
export interface AbbBackupDiff {
  a: string; b: string;
  modules: ModuleChange[];
  cfg: CfgChange[];
  /** modules with the same text in both */
  unchanged: number;
}

const RAPID = /\.(mod|modx|sys|sysx|prg)$/i;
const norm = (s: string) => s.replace(/\r\n?/g, '\n').split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean);

/** every module of a backup by `TASK/NAME` (task by its controller name when the backup says it) */
function modulesOf(root: string): Map<string, { task: string; file: string }> {
  const out = new Map<string, { task: string; file: string }>();
  const info = readBackupInfo(root);
  const nameOf = (folder: string) => info.tasks.find(t => t.folder.toUpperCase() === folder.toUpperCase())?.name ?? folder;
  let tasks: string[] = [];
  try { tasks = fs.readdirSync(path.join(root, 'RAPID')).filter(n => /^TASK\d+$/i.test(n)); } catch { /* no RAPID folder (nothing but BASE loaded) */ }
  for (const t of tasks) for (const sub of ['SYSMOD', 'PROGMOD']) {
    const dir = path.join(root, 'RAPID', t, sub);
    let names: string[] = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) if (RAPID.test(n)) out.set(`${nameOf(t)}/${n.replace(/\.[^.]+$/, '').toUpperCase()}`, { task: nameOf(t), file: path.join(dir, n) });
  }
  return out;
}

/** lines only in A, lines only in B (as multisets, order ignored: a moved block is not a change) */
function lineDelta(a: string[], b: string[]): { added: number; removed: number } {
  const count = new Map<string, number>();
  for (const l of a) count.set(l, (count.get(l) ?? 0) + 1);
  let added = 0;
  for (const l of b) { const n = count.get(l) ?? 0; if (n > 0) count.set(l, n - 1); else added++; }
  let removed = 0;
  for (const n of count.values()) removed += n;
  return { added, removed };
}

function routineTexts(mod: RapidModule): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const r of mod.routines) out.set(r.name.toUpperCase(), norm(mod.lines.slice(r.startLine, (r.endLine ?? r.startLine) + 1).join('\n')));
  return out;
}

function targetsOf(mod: RapidModule): Map<string, { trans: number[]; rot: number[] }> {
  const out = new Map<string, { trans: number[]; rot: number[] }>();
  for (const d of [...mod.data, ...mod.routines.flatMap(r => r.data)]) {
    const t = robTargetsOf(d);
    if (t?.length === 1) out.set(d.name.toUpperCase(), t[0]);
  }
  return out;
}

export function diffAbbBackups(a: string, b: string): AbbBackupDiff {
  const ma = modulesOf(a), mb = modulesOf(b);
  const diff: AbbBackupDiff = { a, b, modules: [], cfg: [], unchanged: 0 };
  for (const key of [...new Set([...ma.keys(), ...mb.keys()])].sort()) {
    const A = ma.get(key), B = mb.get(key);
    const [task, module] = [A?.task ?? B!.task, key.split('/')[1]];
    if (!A || !B) {
      const f = (A ?? B)!.file;
      const lines = norm(fs.readFileSync(f, 'latin1')).length;
      diff.modules.push({ task, module: path.basename(f).replace(/\.[^.]+$/, ''), kind: A ? 'removed' : 'added', fileA: A?.file, fileB: B?.file, linesAdded: A ? 0 : lines, linesRemoved: A ? lines : 0, routines: [], targets: [], data: [] });
      continue;
    }
    const ta = fs.readFileSync(A.file, 'latin1'), tb = fs.readFileSync(B.file, 'latin1');
    const pa = parseRapid(ta), pb = parseRapid(tb);
    if (pa.encrypted || pb.encrypted) {
      if (ta !== tb) diff.modules.push({ task, module, kind: 'changed', fileA: A.file, fileB: B.file, linesAdded: 0, linesRemoved: 0, routines: [], targets: [], data: [], encrypted: true });
      else diff.unchanged++;
      continue;
    }
    const la = norm(ta), lb = norm(tb);
    if (la.join('\n') === lb.join('\n')) { diff.unchanged++; continue; }
    const { added, removed } = lineDelta(la, lb);
    const ra = routineTexts(pa), rb = routineTexts(pb);
    const routines: RoutineChange[] = [];
    for (const r of [...new Set([...ra.keys(), ...rb.keys()])]) {
      const x = ra.get(r), y = rb.get(r);
      const name = pb.routines.find(q => q.name.toUpperCase() === r)?.name ?? pa.routines.find(q => q.name.toUpperCase() === r)!.name;
      if (!x) routines.push({ name, kind: 'added', linesB: y!.length });
      else if (!y) routines.push({ name, kind: 'removed', linesA: x.length });
      else if (x.join('\n') !== y.join('\n')) routines.push({ name, kind: 'changed', linesA: x.length, linesB: y.length });
    }
    const xa = targetsOf(pa), xb = targetsOf(pb);
    const targets: TargetMove[] = [];
    for (const t of [...new Set([...xa.keys(), ...xb.keys()])]) {
      const p = xa.get(t), q = xb.get(t);
      const name = pb.data.find(d => d.name.toUpperCase() === t)?.name ?? pa.data.find(d => d.name.toUpperCase() === t)?.name ?? t;
      if (!p) { targets.push({ name, kind: 'added' }); continue; }
      if (!q) { targets.push({ name, kind: 'removed' }); continue; }
      const distance = Math.hypot(q.trans[0] - p.trans[0], q.trans[1] - p.trans[1], q.trans[2] - p.trans[2]);
      const rotated = p.rot.some((v, i) => Math.abs(v - q.rot[i]) > 1e-4);
      if (distance > 0.001 || rotated) targets.push({ name, kind: 'moved', distance, rotated });
    }
    const decl = (m: RapidModule) => new Map(m.data.filter(d => !/^robtarget$/i.test(d.type)).map(d => [d.name.toUpperCase(), { d, text: d.detail.replace(/s+/g, ' ') }]));
    const da = decl(pa), db = decl(pb);
    const data: ModuleChange['data'] = [];
    for (const k of [...new Set([...da.keys(), ...db.keys()])]) {
      const x = da.get(k), y = db.get(k);
      if (!x) data.push({ name: y!.d.name, kind: 'added', type: y!.d.type });
      else if (!y) data.push({ name: x.d.name, kind: 'removed', type: x.d.type });
      else if (x.text !== y.text) data.push({ name: y.d.name, kind: 'changed', type: y.d.type });
    }
    diff.modules.push({ task, module: pb.name ?? module, kind: 'changed', fileA: A.file, fileB: B.file, linesAdded: added, linesRemoved: removed, routines, targets, data });
  }
  // SYSPAR
  const cfgOf = (root: string) => { try { return fs.readdirSync(path.join(root, 'SYSPAR')).filter(n => /\.cfg$/i.test(n)); } catch { return []; } };
  const ca = new Set(cfgOf(a).map(n => n.toUpperCase())), cb = new Set(cfgOf(b).map(n => n.toUpperCase()));
  const real = (root: string, upper: string) => cfgOf(root).find(n => n.toUpperCase() === upper)!;
  for (const n of [...new Set([...ca, ...cb])].sort()) {
    if (!ca.has(n) || !cb.has(n)) { diff.cfg.push({ file: real(ca.has(n) ? a : b, n), kind: ca.has(n) ? 'removed' : 'added', linesAdded: 0, linesRemoved: 0 }); continue; }
    const x = norm(fs.readFileSync(path.join(a, 'SYSPAR', real(a, n)), 'latin1')), y = norm(fs.readFileSync(path.join(b, 'SYSPAR', real(b, n)), 'latin1'));
    if (x.join('\n') === y.join('\n')) continue;
    const d = lineDelta(x, y);
    diff.cfg.push({ file: real(b, n), kind: 'changed', linesAdded: d.added, linesRemoved: d.removed });
  }
  return diff;
}

/** Is this folder an ABB backup (BACKINFO beside RAPID or SYSPAR)? */
export function isAbbBackup(dir: string): boolean {
  return fs.existsSync(path.join(dir, 'BACKINFO')) && (fs.existsSync(path.join(dir, 'RAPID')) || fs.existsSync(path.join(dir, 'SYSPAR')));
}

export function abbBackupDiffMarkdown(d: AbbBackupDiff): string {
  const out = [`# ABB backup compare`, '', `- **A:** \`${d.a}\``, `- **B:** \`${d.b}\``, ''];
  const ch = d.modules;
  out.push(`${ch.length} module${ch.length === 1 ? '' : 's'} differ (${ch.filter(m => m.kind === 'added').length} added, ${ch.filter(m => m.kind === 'removed').length} removed, ${ch.filter(m => m.kind === 'changed').length} changed), ${d.unchanged} the same; ${d.cfg.length} configuration file${d.cfg.length === 1 ? '' : 's'} differ.`, '');
  if (!ch.length && !d.cfg.length) { out.push('The backups hold the same RAPID and configuration.'); return out.join('\n') + '\n'; }
  const enc = ch.filter(m => m.encrypted);
  for (const task of [...new Set(ch.filter(m => !m.encrypted).map(m => m.task))]) {
    out.push(`## ${task}`, '');
    for (const m of ch.filter(x => x.task === task && !x.encrypted)) {
      const file = m.fileB ?? m.fileA!;
      out.push(`### ${m.module} - ${m.kind}${m.encrypted ? ' (encrypted: bytes differ)' : m.kind === 'changed' ? ` (+${m.linesAdded} / -${m.linesRemoved} lines)` : ` (${m.linesAdded || m.linesRemoved} lines)`}`, '', `[${path.basename(file)}](${encodeURI('file:///' + file.replace(/\\/g, '/'))})`, '');
      if (m.routines.length) {
        out.push('| Routine | Change | Lines |', '|---|---|---|');
        for (const r of m.routines) out.push(`| ${r.name} | ${r.kind} | ${r.kind === 'changed' ? `${r.linesA} → ${r.linesB}` : r.linesA ?? r.linesB} |`);
        out.push('');
      }
      if (m.data.length) {
        const shown = m.data.slice(0, 40);
        out.push(`Data: ${shown.map(x => `${x.name} (${x.type}, ${x.kind})`).join(', ')}${m.data.length > shown.length ? `, … ${m.data.length - shown.length} more` : ''}`, '');
      }
      if (m.targets.length) {
        out.push('| Robtarget | Change | Distance |', '|---|---|---|');
        for (const t of m.targets.sort((x, y) => (y.distance ?? 0) - (x.distance ?? 0))) out.push(`| ${t.name} | ${t.kind}${t.rotated ? ', re-oriented' : ''} | ${t.distance !== undefined ? `${t.distance.toFixed(2)} mm` : ''} |`);
        out.push('');
      }
    }
  }
  if (enc.length) {
    // an encrypted module is only bytes: one line per task, not a section each
    out.push('## Encrypted modules (bytes differ, contents not readable)', '');
    for (const task of [...new Set(enc.map(m => m.task))]) out.push(`- **${task}:** ${enc.filter(m => m.task === task).map(m => m.module).join(', ')}`);
    out.push('');
  }
  if (d.cfg.length) {
    out.push('## Configuration (SYSPAR)', '', '| File | Change | Lines |', '|---|---|---|');
    for (const c of d.cfg) out.push(`| ${c.file} | ${c.kind} | ${c.kind === 'changed' ? `+${c.linesAdded} / -${c.linesRemoved}` : ''} |`);
    out.push('');
  }
  return out.join('\n') + '\n';
}
