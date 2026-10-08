/**
 * Task-wide RAPID analysis, pure: routines nothing calls, and who writes and reads each global
 * data item and each I/O signal. "Task" is the modules of one RAPID/TASKn folder plus the shared
 * (TASK0) modules, as the editor resolves names (symbols.ts).
 */
import { rapidSymbolAt, rapidOccurrences } from '../rapid/symbols';
import type { RapidModule } from '../rapid/parser';

export interface TaskModules {
  names: string[];
  mods: RapidModule[];
  /**
   * how many of `mods` (the first ones) are reported on; the rest are context only - the shared modules,
   * and libraries a backup keeps in HOME that the task loads at run time: their calls and uses count, their
   * own routines and data are not listed. All of them when omitted.
   */
  report?: number;
}
const reported = (task: TaskModules, i: number) => i < (task.report ?? task.mods.length);

export interface UnusedRoutine { module: string; name: string; kind: string; local: boolean; line: number }

/**
 * Routines nothing names: no call, no reference, no CONNECT ... WITH, no string that could be a late-bound
 * call. `main` and every TRAP that is connected count as used. Event routines run from the system
 * configuration (SYS.cfg EVENT) are not seen here: the report says so.
 */
export function unusedRoutines(task: TaskModules): UnusedRoutine[] {
  const out: UnusedRoutine[] = [];
  const strings = task.mods.flatMap(m => m.strings.map(s => s.text.replace(/^"|"$/g, '').toUpperCase())).filter(s => s.length >= 2);
  task.mods.forEach((mod, i) => {
    if (mod.encrypted || !reported(task, i)) return;
    for (const r of mod.routines) {
      if (/^main$/i.test(r.name)) continue;
      const sym = rapidSymbolAt(task.mods, i, r.nameSpan.line, r.nameSpan.col);
      if (!sym) continue;
      const uses = rapidOccurrences(task.mods, sym).filter(o => o.kind !== 'decl');
      if (uses.length) continue;
      const up = r.name.toUpperCase();
      if (strings.some(s => s === up || (s.length >= 3 && up.startsWith(s)))) continue;   // CallByVar "Path_", %"Name"%
      out.push({ module: mod.name ?? task.names[i], name: r.name, kind: r.kind, local: r.local, line: r.nameSpan.line });
    }
  });
  return out;
}

export interface XrefRow { name: string; what: 'data' | 'signal'; type?: string; writers: string[]; readers: string[]; findings: string[] }

const SIGNAL_WRITE = /^(SetDO|SetGO|SetAO|Set|Reset|PulseDO|InvertDO|SetAllDataVal)$/i;
const SIGNAL_READ = /^(WaitDI|WaitDO|WaitGI|WaitGO|WaitAI|WaitAO|TriggIO|ISignalDI|ISignalDO|ISignalGI|ISignalGO|ISignalAI|ISignalAO)$/i;
const SIGNAL_FUNC = /^(DInput|DOutput|GInput|GOutput|AInput|AOutput|GInputDnum|GOutputDnum|TestDI)$/i;

/**
 * Global PERS/VAR data and I/O signals across the task: written where (module › routine), read where,
 * with findings - a PERS written from several modules, data read but never written, a signal set in
 * several modules. Signals are not declared in RAPID: they are found as the signal argument of the I/O
 * instructions and functions.
 */
export function rapidXref(task: TaskModules): XrefRow[] {
  const rows: XrefRow[] = [];
  const where = (i: number, routine?: string) => `${task.mods[i].name ?? task.names[i]}${routine ? ` › ${routine}` : ''}`;
  // data
  task.mods.forEach((mod, i) => {
    if (mod.encrypted || !reported(task, i)) return;
    for (const d of mod.data) {
      if (d.storage === 'CONST') continue;
      const sym = rapidSymbolAt(task.mods, i, d.nameSpan.line, d.nameSpan.col);
      if (!sym) continue;
      const occ = rapidOccurrences(task.mods, sym).filter(o => o.kind !== 'decl');
      const writers = new Set<string>(), readers = new Set<string>();
      for (const o of occ) {
        const m = task.mods[o.module];
        const routine = m.routines.find(r => o.span.line >= r.startLine && o.span.line <= (r.endLine ?? r.startLine))?.name;
        (o.write ? writers : readers).add(where(o.module, routine));
      }
      const findings: string[] = [];
      const writerModules = new Set([...writers].map(w => w.split(' › ')[0]));
      if (d.storage === 'PERS' && writerModules.size > 1) findings.push(`written from ${writerModules.size} modules`);
      if (!writers.size && readers.size && d.storage === 'VAR' && !d.init) findings.push('read but never written here (no initial value)');
      // PERS is shared by name with every other task: only a VAR can be called unused from one task
      if (!writers.size && !readers.size && d.storage === 'VAR') findings.push('never used');
      rows.push({ name: d.name, what: 'data', type: `${d.storage} ${d.type}`, writers: [...writers], readers: [...readers], findings });
    }
  });
  // signals
  const sig = new Map<string, { name: string; writers: Set<string>; readers: Set<string> }>();
  const touch = (name: string, w: boolean, at: string) => {
    const k = name.toUpperCase();
    const s = sig.get(k) ?? { name, writers: new Set<string>(), readers: new Set<string>() };
    (w ? s.writers : s.readers).add(at);
    sig.set(k, s);
  };
  task.mods.forEach((mod, i) => {
    if (mod.encrypted) return;
    for (const c of mod.calls) {
      if (!c.name) continue;
      const first = c.args[0]?.text.trim();
      if (!first || !/^[A-Za-z_]\w*$/.test(first)) continue;
      const at = where(i, c.routine);
      if (c.kind === 'proc' && SIGNAL_WRITE.test(c.name)) touch(first, true, at);
      else if (c.kind === 'proc' && SIGNAL_READ.test(c.name)) touch(first, false, at);
      else if (c.kind === 'func' && SIGNAL_FUNC.test(c.name)) touch(first, false, at);
    }
  });
  for (const s of sig.values()) {
    const findings: string[] = [];
    const wm = new Set([...s.writers].map(w => w.split(' › ')[0]));
    if (wm.size > 1) findings.push(`set from ${wm.size} modules`);
    rows.push({ name: s.name, what: 'signal', writers: [...s.writers], readers: [...s.readers], findings });
  }
  return rows.sort((a, b) => a.what.localeCompare(b.what) || a.name.localeCompare(b.name));
}

export function unusedRoutinesMarkdown(task: string, list: UnusedRoutine[], modules: number): string {
  const out = [`# Unused routines - ${task}`, '', `${list.length} routine${list.length === 1 ? '' : 's'} nothing in the task's ${modules} modules calls or names.`, '',
    '> Calls from the shared (TASK0) modules and from the libraries in the backup\'s HOME folder count. Not seen from RAPID: event routines run from the system configuration (SYS.cfg EVENT), routines started from the FlexPendant or an application (Production Screen, PLC), and late binding through a string built at run time. Check those before deleting anything.', ''];
  if (!list.length) return out.concat('Every routine is used.').join('\n') + '\n';
  out.push('| Module | Routine | Kind | Line |', '|---|---|---|---|');
  for (const r of list) out.push(`| ${r.module} | ${r.name} | ${r.local ? 'LOCAL ' : ''}${r.kind} | ${r.line + 1} |`);
  return out.join('\n') + '\n';
}

export function xrefMarkdown(task: string, rows: XrefRow[]): string {
  const out = [`# RAPID cross-reference - ${task}`, ''];
  const flagged = rows.filter(r => r.findings.length);
  out.push(`${rows.filter(r => r.what === 'data').length} data items, ${rows.filter(r => r.what === 'signal').length} signals; ${flagged.length} with findings.`, '');
  if (flagged.length) {
    out.push('## Findings', '', '| Name | Kind | Finding |', '|---|---|---|');
    for (const r of flagged) out.push(`| ${r.name} | ${r.what === 'data' ? r.type : 'signal'} | ${r.findings.join('; ')} |`);
    out.push('');
  }
  for (const what of ['data', 'signal'] as const) {
    const list = rows.filter(r => r.what === what);
    if (!list.length) continue;
    out.push(`## ${what === 'data' ? 'Data (PERS / VAR)' : 'I/O signals'}`, '', '| Name | Written in | Read in |', '|---|---|---|');
    const cell = (xs: string[]) => (xs.length ? xs.slice(0, 6).join('<br>') + (xs.length > 6 ? `<br>… ${xs.length - 6} more` : '') : '-');
    for (const r of list) out.push(`| ${r.name}${r.type ? ` <sub>${r.type}</sub>` : ''} | ${cell(r.writers)} | ${cell(r.readers)} |`);
    out.push('');
  }
  return out.join('\n') + '\n';
}
