/**
 * Programs nothing calls - the "programs" half of the dead-code item in FEATURES.md.
 * Pure - no vscode - so the corpus test can run it on the reference backup.
 *
 * A program counts as used when another program CALLs or RUNs it, or when a macro
 * instruction resolves to it through the macro table. It is an ENTRY POINT, and never
 * listed, when the macro table names it, or when its name is one the controller itself
 * launches: PNS/RSR/STYLE program selection (`PNS0001`, `RSR0003`, `STYLE12`) and `MAIN*`.
 *
 * What this does NOT know, and says so in the report: condition handlers, KAREL
 * `CALL_PROG` with a name in a string, programs a PLC selects by number, timer-started
 * programs, and the RSR/PNS tables themselves when no sysvars dump exposes them. The
 * data store does not read `sysvars.va` for `$SHELL_WRK` / `$SHELL_CFG`, so the job
 * program fields there are also unchecked; a program named only there will show up here.
 */
import type { ProgramKind } from '@core/brand';

export interface ProgramLike {
  name: string;
  kind: ProgramKind;
  comment?: string;
  /** upper-case CALL/RUN targets */
  calls: string[];
  /** macro instruction names this program uses */
  macros: string[];
}

export interface MacroLike { macroName: string; progName: string }

export interface UnusedProgram {
  name: string;
  kind: ProgramLike['kind'];
  comment?: string;
  /** what it calls in turn - a whole dead cluster is visible from its root */
  calls: string[];
}

export interface UnusedReport {
  unused: UnusedProgram[];
  /** programs kept off the list because the controller launches them, not a CALL */
  entryPoints: Array<{ name: string; why: string }>;
  total: number;
  caveats: string[];
}

export const CAVEATS: readonly string[] = [
  'Condition handlers (`WHEN ... CALL`) inside KAREL programs are not followed.',
  'KAREL `CALL_PROG` / `CALL_PROGLIN` with the program name in a string variable is not followed.',
  'Programs a PLC selects by number (PNS/RSR/STYLE) are treated as entry points by name pattern only; the selection tables themselves are not read.',
  'Programs started by a timer, an alarm recovery or a system event are not known.',
  '`$SHELL_WRK` / `$SHELL_CFG` job program fields are not read (no `sysvars.va` parsing yet); a program named only there will appear here.',
  'A program on the robot that this backup does not carry cannot be seen as a caller.',
];

const RE_ENTRY = /^(PNS|RSR|STYLE)\d+$|^MAIN/i;

export function findUnusedPrograms(programs: ProgramLike[], macros: MacroLike[]): UnusedReport {
  const byName = new Map<string, ProgramLike>();
  for (const p of programs) if (!byName.has(p.name.toUpperCase())) byName.set(p.name.toUpperCase(), p);
  const macroTarget = new Map<string, string>();   // macro instruction name -> program
  for (const m of macros) if (m.macroName && m.progName) macroTarget.set(m.macroName.toUpperCase(), m.progName.toUpperCase());
  const called = new Set<string>();
  for (const p of programs) {
    // a program calling itself is not a caller: a loop that re-enters itself and that
    // nothing else starts is exactly as dead as one that does not
    const self = p.name.toUpperCase();
    for (const c of p.calls) if (c.toUpperCase() !== self) called.add(c.toUpperCase());
    for (const m of p.macros) { const t = macroTarget.get(m.toUpperCase()); if (t && t !== self) called.add(t); }
  }
  const macroPrograms = new Set(macroTarget.values());
  const unused: UnusedProgram[] = [];
  const entryPoints: UnusedReport['entryPoints'] = [];
  for (const p of [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    const n = p.name.toUpperCase();
    if (called.has(n)) continue;
    if (macroPrograms.has(n)) { entryPoints.push({ name: p.name, why: 'named in the macro table' }); continue; }
    if (RE_ENTRY.test(n)) { entryPoints.push({ name: p.name, why: 'launched by the controller (PNS/RSR/STYLE/MAIN name)' }); continue; }
    unused.push({ name: p.name, kind: p.kind, comment: p.comment, calls: [...new Set(p.calls.map(c => c.toUpperCase()))].sort() });
  }
  return { unused, entryPoints, total: byName.size, caveats: [...CAVEATS] };
}

export function unusedProgramsMarkdown(report: UnusedReport, robot: string): string {
  const out: string[] = [];
  out.push(`# Programs never called — ${robot}`, '');
  out.push(`${report.unused.length} of ${report.total} programs have no CALL, RUN or macro instruction pointing at them.`, '');
  out.push('## Read this first — what was NOT checked', '');
  for (const c of report.caveats) out.push(`- ${c}`);
  out.push('', 'A program on this list may still run. Check how the cell starts it before deleting anything.', '');
  out.push('## Never called', '');
  if (!report.unused.length) out.push('_None._');
  else {
    out.push('| Program | Kind | Comment | Calls in turn |', '|---|---|---|---|');
    for (const u of report.unused) out.push(`| \`${u.name}\` | ${u.kind === 'karel' ? 'KAREL' : u.kind === 'binary' ? 'compiled' : 'TP'} | ${(u.comment ?? '').replace(/\|/g, '\\|')} | ${u.calls.map(c => `\`${c}\``).join(', ')} |`);
  }
  out.push('', '## Entry points (not listed above)', '');
  if (!report.entryPoints.length) out.push('_None recognised._');
  else for (const e of report.entryPoints) out.push(`- \`${e.name}\` — ${e.why}`);
  out.push('');
  return out.join('\n');
}
