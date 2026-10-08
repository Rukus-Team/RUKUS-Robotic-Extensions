/**
 * Which declaration a RAPID name means, and every place that names it - for references,
 * rename, highlights, "N references" lenses and the call graph. Pure: modules in, spans out.
 *
 * RAPID's scoping, innermost first:
 *   - labels live in their routine, in a namespace of their own (GOTO / label:)
 *   - a routine's parameters and data hide everything outside the routine
 *   - LOCAL module data / routines / records are seen only in their module, and hide globals there
 *   - everything else is global to the task, the shared (TASK0) modules included
 * A name declared nowhere (an instruction, tool0, an option's routine) is "unknown": it can be
 * looked up, never renamed.
 */
import type { Span } from '@core/span';
import { routineAt, type RapidModule } from './parser';

const U = (s: string) => s.toUpperCase();

export type RapidSymbolScope =
  | { kind: 'routine'; module: number; routine: string }
  | { kind: 'module'; module: number }
  | { kind: 'global' };

export type RapidSymbolWhat = 'routine' | 'data' | 'record' | 'alias' | 'param' | 'label' | 'unknown';

export interface RapidSymbol {
  /** upper-cased name */
  upper: string;
  /** as written at the declaration (or where it was found, when unknown) */
  name: string;
  what: RapidSymbolWhat;
  scope: RapidSymbolScope;
  /** where it is declared; undefined for unknown names */
  decl?: { module: number; span: Span };
}

export type RapidOccurrenceKind = 'decl' | 'ref' | 'call' | 'goto' | 'type' | 'trap';

export interface RapidOccurrence { module: number; span: Span; kind: RapidOccurrenceKind; write?: boolean }

interface RawOcc { span: Span; upper: string; routine?: string; kind: RapidOccurrenceKind; label: boolean; write?: boolean; what?: RapidSymbolWhat; local?: boolean }

const rawCache = new WeakMap<RapidModule, RawOcc[]>();

/** every name occurrence in one module, declarations included, de-duplicated by position */
function rawOccurrences(mod: RapidModule): RawOcc[] {
  const hit = rawCache.get(mod);
  if (hit) return hit;
  const out: RawOcc[] = [];
  const seen = new Set<string>();
  const add = (o: RawOcc) => {
    if (!o.span || o.span.len <= 0) return;
    const k = `${o.span.line}:${o.span.col}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push(o);
  };
  if (!mod.encrypted) {
    for (const r of mod.routines) {
      add({ span: r.nameSpan, upper: U(r.name), kind: 'decl', label: false, what: 'routine', local: r.local });
      for (const p of r.params) add({ span: p.nameSpan, upper: U(p.name), routine: r.name, kind: 'decl', label: false, what: 'param' });
      for (const d of r.data) add({ span: d.nameSpan, upper: U(d.name), routine: r.name, kind: 'decl', label: false, what: 'data' });
      for (const l of r.labels) add({ span: l.span, upper: U(l.name), routine: r.name, kind: 'decl', label: true, what: 'label' });
    }
    for (const d of mod.data) add({ span: d.nameSpan, upper: U(d.name), kind: 'decl', label: false, what: 'data', local: d.scope === 'LOCAL' });
    for (const r of mod.records) if (r.name) add({ span: r.nameSpan, upper: U(r.name), kind: 'decl', label: false, what: 'record', local: r.local });
    for (const a of mod.aliases) add({ span: a.nameSpan, upper: U(a.name), kind: 'decl', label: false, what: 'alias', local: a.local });
    // a record or alias used as a data type
    for (const d of [...mod.data, ...mod.routines.flatMap(r => r.data)]) add({ span: d.typeSpan, upper: U(d.type), routine: d.routine, kind: 'type', label: false });
    for (const c of mod.calls) if (c.name) add({ span: c.span, upper: U(c.name), routine: c.routine, kind: 'call', label: false });
    for (const g of mod.gotos) add({ span: g.span, upper: U(g.label), routine: g.routine, kind: 'goto', label: true });
    for (const c of mod.connects) add({ span: c.trapSpan, upper: U(c.trap), routine: c.routine, kind: 'trap', label: false });
    for (const r of mod.refs) add({ span: r.span, upper: U(r.name), routine: r.routine, kind: 'ref', label: false, write: r.write });
  }
  out.sort((a, b) => a.span.line - b.span.line || a.span.col - b.span.col);
  rawCache.set(mod, out);
  return out;
}

/** names a routine declares itself (parameters and data) - they hide every outer name in it */
function routineLocals(mod: RapidModule, routine: string | undefined): Set<string> {
  if (!routine) return new Set();
  const r = mod.routines.find(x => U(x.name) === U(routine));
  return new Set(r ? [...r.params.map(p => U(p.name)), ...r.data.map(d => U(d.name))] : []);
}

/** module-level declaration of a name, if the module has one */
function moduleDecl(mod: RapidModule, upper: string): RawOcc | undefined {
  return rawOccurrences(mod).find(o => o.kind === 'decl' && !o.routine && !o.label && o.upper === upper);
}

/** The symbol a name at (line, col) of modules[own] means; undefined when no name is there. */
export function rapidSymbolAt(modules: readonly RapidModule[], own: number, line: number, col: number): RapidSymbol | undefined {
  const mod = modules[own];
  const o = rawOccurrences(mod).find(x => x.span.line === line && col >= x.span.col && col <= x.span.col + x.span.len);
  if (!o) return undefined;
  const name = mod.lines[o.span.line]?.substr(o.span.col, o.span.len) ?? o.upper;
  return resolveName(modules, own, o.upper, o.routine ?? routineAt(mod, line)?.name, o.label, name);
}

/** Resolve a name as seen from a routine (or module level) of modules[own]. */
export function resolveName(modules: readonly RapidModule[], own: number, upper: string, routine: string | undefined, label: boolean, written = upper): RapidSymbol {
  const mod = modules[own];
  if (label) {
    const d = routine ? rawOccurrences(mod).find(x => x.label && x.kind === 'decl' && x.upper === upper && U(x.routine ?? '') === U(routine)) : undefined;
    return { upper, name: d ? textOf(mod, d.span) : written, what: 'label', scope: { kind: 'routine', module: own, routine: routine ?? '' }, decl: d && { module: own, span: d.span } };
  }
  if (routine && routineLocals(mod, routine).has(upper)) {
    const d = rawOccurrences(mod).find(x => x.kind === 'decl' && !x.label && x.upper === upper && U(x.routine ?? '') === U(routine))!;
    return { upper, name: textOf(mod, d.span), what: d.what ?? 'data', scope: { kind: 'routine', module: own, routine }, decl: { module: own, span: d.span } };
  }
  const here = moduleDecl(mod, upper);
  if (here) return { upper, name: textOf(mod, here.span), what: here.what ?? 'data', scope: here.local ? { kind: 'module', module: own } : { kind: 'global' }, decl: { module: own, span: here.span } };
  for (let i = 0; i < modules.length; i++) {
    if (i === own) continue;
    const d = moduleDecl(modules[i], upper);
    if (d && !d.local) return { upper, name: textOf(modules[i], d.span), what: d.what ?? 'data', scope: { kind: 'global' }, decl: { module: i, span: d.span } };
  }
  return { upper, name: written, what: 'unknown', scope: { kind: 'global' } };
}

const textOf = (mod: RapidModule, s: Span) => mod.lines[s.line]?.substr(s.col, s.len) ?? '';

/** Every occurrence of a symbol across the modules, declaration included, in module then text order. */
export function rapidOccurrences(modules: readonly RapidModule[], sym: RapidSymbol): RapidOccurrence[] {
  const out: RapidOccurrence[] = [];
  const take = (i: number, o: RawOcc) => out.push({ module: i, span: o.span, kind: o.kind, write: o.write });
  const sc = sym.scope;
  if (sc.kind === 'routine') {
    for (const o of rawOccurrences(modules[sc.module])) {
      if (o.upper === sym.upper && o.label === (sym.what === 'label') && U(o.routine ?? '') === U(sc.routine)) take(sc.module, o);
    }
    return out;
  }
  const visible = sc.kind === 'module' ? [sc.module] : modules.map((_, i) => i);
  for (const i of visible) {
    const mod = modules[i];
    // a module with its own LOCAL of this name does not see the global one
    if (sc.kind === 'global' && i !== sym.decl?.module) { const d = moduleDecl(mod, sym.upper); if (d?.local) continue; }
    const shadowed = new Map<string, boolean>();
    for (const o of rawOccurrences(mod)) {
      if (o.upper !== sym.upper || o.label) continue;
      if (o.kind === 'decl' && o.routine) continue;          // a routine's own declaration of the name is another symbol
      if (o.kind === 'decl' && sym.decl && !(i === sym.decl.module && o.span.line === sym.decl.span.line && o.span.col === sym.decl.span.col)) continue;
      if (o.routine) {
        const k = U(o.routine);
        if (!shadowed.has(k)) shadowed.set(k, routineLocals(mod, o.routine).has(sym.upper));
        if (shadowed.get(k)) continue;
      }
      take(i, o);
    }
  }
  return out;
}

/** The symbol a module-level declaration (a routine's name, say) stands for. */
export function rapidDeclSymbol(modules: readonly RapidModule[], module: number, span: Span): RapidSymbol | undefined {
  return rapidSymbolAt(modules, module, span.line, span.col);
}

export interface RapidCallEdge { from: { module: number; routine: string }; to: { module: number; routine: string } | { unknown: string }; line: number }

/** Every call made from a routine body, resolved to the routine it reaches (or unknown: an instruction, an option). */
export function rapidCallsFrom(modules: readonly RapidModule[], module: number, routine: string): RapidCallEdge[] {
  const mod = modules[module];
  const out: RapidCallEdge[] = [];
  const seen = new Set<string>();
  for (const c of mod.calls) {
    if (!c.name || U(c.routine ?? '') !== U(routine)) continue;
    const sym = resolveName(modules, module, U(c.name), c.routine, false, c.name);
    const key = sym.decl ? `${sym.decl.module}:${sym.upper}` : `?${sym.upper}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (sym.what === 'routine' && sym.decl) out.push({ from: { module, routine }, to: { module: sym.decl.module, routine: sym.name }, line: c.line });
    else if (sym.what === 'unknown') out.push({ from: { module, routine }, to: { unknown: c.name }, line: c.line });
  }
  return out;
}

export const RAPID_NAME = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
