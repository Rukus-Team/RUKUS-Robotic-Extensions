/**
 * RAPID diagnostics. Pure: takes parsed modules, returns issues with spans; the VS Code
 * side only converts them.
 *
 * The bar is precision. Every module in the IRC5 corpus this was written against runs on a
 * real controller, and the tests assert that the corpus produces no error at all. So an
 * error here is something the controller itself would refuse to load or run:
 *
 * | code                        | severity | why it is certain                                     |
 * |-----------------------------|----------|-------------------------------------------------------|
 * | rapid.unclosedBlock         | error    | IF/FOR/WHILE/TEST/PROC/... with no END word           |
 * | rapid.unmatchedEnd          | error    | an END word with nothing open to close                |
 * | rapid.misplaced             | error    | ELSE outside IF, CASE outside TEST, a handler in a block |
 * | rapid.duplicateName         | error    | two routines/data/records with one name in a module, or a local that repeats a parameter |
 * | rapid.undefinedLabel        | error    | GOTO to a label the routine does not have             |
 * | rapid.unknownRoutine        | warning  | a call to a name the task does not declare and the built-in list does not know (options add instructions no backup declares; a hint when the task has encrypted modules) |
 * | rapid.unusedLocalRoutine    | hint     | a LOCAL routine nothing in its module names           |
 * | rapid.missingSemicolon, rapid.syntax, rapid.badDeclaration | warning | the parser had to guess |
 */

import type { Span } from '@core/span';
import type { RapidModule, RapidRoutine } from './parser';
import { RAPID_INSTRUCTIONS } from './builtins';

export type RapidSeverity = 'error' | 'warning' | 'info' | 'hint';

export interface RapidIssue { code: string; message: string; span: Span; severity: RapidSeverity }

export const RAPID_DIAGNOSTIC_CODES = [
  'rapid.unclosedBlock', 'rapid.unmatchedEnd', 'rapid.misplaced', 'rapid.duplicateName', 'rapid.undefinedLabel',
  'rapid.unknownRoutine', 'rapid.unusedLocalRoutine', 'rapid.missingSemicolon', 'rapid.syntax', 'rapid.badDeclaration',
] as const;

const U = (s: string) => s.toUpperCase();

/** Issues that need only the module itself. */
export function diagnoseModule(mod: RapidModule): RapidIssue[] {
  const out: RapidIssue[] = [];
  if (mod.encrypted) return out;
  for (const p of mod.problems) out.push({ ...p });

  // ---- duplicate names at module level: routines, data, records and aliases share one namespace ----
  const seen = new Map<string, { what: string; line: number }>();
  const declare = (name: string, span: Span, what: string) => {
    const k = U(name);
    const prev = seen.get(k);
    if (prev) out.push({ code: 'rapid.duplicateName', severity: 'error', span, message: `"${name}" is already declared in this module (${prev.what}, line ${prev.line + 1}).` });
    else seen.set(k, { what, line: span.line });
  };
  for (const r of mod.routines) declare(r.name, r.nameSpan, r.kind);
  for (const d of mod.data) declare(d.name, d.nameSpan, d.storage);
  for (const r of mod.records) if (r.name) declare(r.name, r.nameSpan, 'RECORD');
  for (const a of mod.aliases) declare(a.name, a.nameSpan, 'ALIAS');

  for (const r of mod.routines) {
    // ---- inside a routine: parameters and local data share a namespace ----
    const local = new Map<string, number>();
    for (const p of r.params) {
      const k = U(p.name);
      // alternatives (`\num a | \num b`) have distinct names; a repeat is still a duplicate
      if (local.has(k)) out.push({ code: 'rapid.duplicateName', severity: 'error', span: p.nameSpan, message: `Parameter "${p.name}" is declared twice in ${r.name}.` });
      else local.set(k, p.nameSpan.line);
    }
    for (const d of r.data) {
      const k = U(d.name);
      if (local.has(k)) out.push({ code: 'rapid.duplicateName', severity: 'error', span: d.nameSpan, message: `"${d.name}" is already declared in ${r.name} (line ${local.get(k)! + 1}).` });
      else local.set(k, d.nameSpan.line);
    }
    // ---- GOTO targets ----
    const labels = new Set(r.labels.map(l => U(l.name)));
    for (const g of mod.gotos) {
      if (g.routine !== r.name) continue;
      if (!labels.has(U(g.label))) out.push({ code: 'rapid.undefinedLabel', severity: 'error', span: g.span, message: `GOTO ${g.label}: ${r.name} has no label "${g.label}".` });
    }
  }

  // ---- LOCAL routines nobody in the module names ----
  const used = localRoutineUse(mod);
  for (const r of mod.routines) {
    if (!r.local) continue;
    if (used(r)) continue;
    out.push({ code: 'rapid.unusedLocalRoutine', severity: 'hint', span: r.nameSpan, message: `LOCAL ${r.kind} ${r.name} is not used in this module, and LOCAL makes it invisible to every other module.` });
  }
  return out;
}

/**
 * Is a LOCAL routine used? A LOCAL routine can only be reached from its own module, so the
 * module's text is all there is to look at: a call, a function call, a CONNECT ... WITH,
 * any identifier with its name - or its name inside a string, because late binding
 * (`%"Name"%`, `%"Prefix" + suffix%`, CallByVar) calls routines by string.
 */
function localRoutineUse(mod: RapidModule): (r: RapidRoutine) => boolean {
  const names = new Map<string, number>();
  const bump = (n: string | undefined) => { if (n) names.set(U(n), (names.get(U(n)) ?? 0) + 1); };
  for (const c of mod.calls) bump(c.name);
  for (const x of mod.refs) bump(x.name);
  const strings = mod.strings.map(s => U(s.text.replace(/^"|"$/g, '')));
  return (r: RapidRoutine) => {
    const k = U(r.name);
    if ((names.get(k) ?? 0) > 0) return true;
    // the whole name in a string, or a string that is its prefix (`CallByVar "Path_", n`)
    return strings.some(s => s.includes(k) || (s.length >= 3 && k.startsWith(s)));
  };
}

export interface RapidTaskOptions {
  /** modules visible to every task (installed `-Shared`; a backup keeps them under RAPID/TASK0) */
  shared?: RapidModule[];
  /** more routine names to accept, e.g. from a project setting */
  known?: Iterable<string>;
}

/**
 * Issues that need the whole task: calls resolved across every module of one RAPID/TASKn
 * folder (plus the shared modules). Returns the module-level issues too, per module, in
 * the order the modules were given.
 */
export function diagnoseTask(modules: RapidModule[], opts: RapidTaskOptions = {}): RapidIssue[][] {
  const shared = opts.shared ?? [];
  const global = new Set<string>();
  for (const m of [...modules, ...shared]) {
    for (const r of m.routines) if (!r.local) global.add(U(r.name));
  }
  for (const k of opts.known ?? []) global.add(U(k));
  const encrypted = [...modules, ...shared].filter(m => m.encrypted).length;

  return modules.map(m => {
    const out = diagnoseModule(m);
    if (m.encrypted) return out;
    const own = new Set(m.routines.map(r => U(r.name)));
    for (const c of m.calls) {
      if (c.kind !== 'proc' || !c.name) continue;
      const k = U(c.name);
      if (own.has(k) || global.has(k) || RAPID_INSTRUCTIONS.has(k)) continue;
      out.push({
        code: 'rapid.unknownRoutine',
        severity: encrypted ? 'hint' : 'warning',
        span: c.span,
        message: `${c.name} is not declared in this task and is not a known RAPID instruction.` +
          (encrypted ? ` The task has ${encrypted} encrypted module${encrypted === 1 ? '' : 's'} that may declare it.` : ' It may come from a RobotWare option.'),
      });
    }
    return out;
  });
}
