/**
 * The RAPID reference: every instruction, function and data type of RobotWare 6 with its
 * syntax and arguments, generated from ABB's manual by scripts/import-rapid-manual.mjs into
 * reference.json, plus what RobotWare 8 (OmniCore) adds, from scripts/import-rapid-rw8.mjs:
 * reference-rw8.json (new entries, new arguments, other options) and manual-names.json (which
 * manual lists which name, for the "RobotWare 6 only" / "RobotWare 8 only" notes), plus the RAPID of options
 * documented only in their own application manuals, from scripts/import-rapid-options.mjs: reference-options.json
 * (Externally Guided Motion, SoftMove, Force Control: signatures, predefined values, and which manual lists which
 * name, for the "RobotWare 6 (IRC5) only" / "OmniCore only" notes). Pure, so the tests can use it.
 */
import data from './reference.json';
import rw8 from './reference-rw8.json';
import manual from './manual-names.json';
import options from './reference-options.json';

export interface RapidRefArg {
  name: string;
  type?: string;
  optional?: boolean;
  /** an argument with no value (`\Conc`) */
  switch?: boolean;
  /** arguments with the same number are alternatives (`\V | \T`) */
  alt?: number;
  desc?: string;
  /** '8': only RobotWare 8 has this argument; 'omnicore': only an OmniCore option manual lists it */
  rw?: '8' | 'omnicore';
}

export interface RapidRefEntry {
  name: string;
  kind: 'instruction' | 'function' | 'type';
  summary: string;
  syntax: string;
  args?: RapidRefArg[];
  returns?: string;
  components?: { name: string; type?: string; desc?: string }[];
  option?: string;
  /** the option RobotWare 8 files it under when that differs ('RobotWare Base': RW8 has it in the base system) */
  option8?: string;
  /** the RobotWare 8 return type when it differs */
  returns8?: string;
  /**
   * '6' / '8': only that RobotWare's manual lists it (unset: both, or neither manual). For an option entry
   * (reference-options.json): '6' when only the option's RobotWare 6 (IRC5) manual lists it, 'omnicore' when only its
   * OmniCore manuals do.
   */
  rw?: '6' | '8' | 'omnicore';
  /** the constants RobotWare predefines for this (alias) type, e.g. EGM_STOP_HOLD for egmstopmode */
  predefined?: string[];
}

/** reference-options.json: the option entries, and per application manual the names it lists */
interface OptionsFile {
  manuals: Record<string, { source: string; rw: '6' | 'omnicore'; entries: [RapidRefEntry['kind'], string, string][] }>;
  entries: RapidRefEntry[];
}
const optionsFile = options as unknown as OptionsFile;

/** reference-rw8.json: a whole new entry (it has a summary), or additions to an entry of reference.json */
interface Rw8Entry {
  name: string; kind: RapidRefEntry['kind']; summary?: string; syntax?: string; args?: RapidRefArg[]; returns?: string;
  components?: RapidRefEntry['components']; option?: string; fixKind?: boolean;
  addArgs?: (RapidRefArg & { after?: string })[]; option8?: string; returns8?: string;
}

const U = (s: string) => s.toUpperCase();
const manualNames = manual as unknown as { rw6: { entries: string[][] }; rw8: { entries: string[][] } };
const listed = (rw: { entries: string[][] }) => new Set(rw.entries.map(e => U(e[1])));
const in6 = listed(manualNames.rw6), in8 = listed(manualNames.rw8);

/** reference.json with RobotWare 8's additions merged in, in name order */
function merge(): RapidRefEntry[] {
  const base = ((data as unknown as { entries: RapidRefEntry[] }).entries ?? []).map(e => ({ ...e }));
  const extra = (rw8 as unknown as { entries: Rw8Entry[] }).entries ?? [];
  // the RW6 import filed a few functions as instructions (StrFormat, GetTorqueMargin): RW6.16 and RW8 agree on the kind
  const fixed = new Set(extra.filter(x => x.fixKind).map(x => U(x.name)));
  const out = base.filter(e => !fixed.has(U(e.name)));
  const at = new Map(out.map(e => [`${e.kind}:${U(e.name)}`, e]));
  for (const x of extra) {
    const was = at.get(`${x.kind}:${U(x.name)}`);
    if (!was) {
      if (x.summary === undefined) continue;
      const e: RapidRefEntry = { name: x.name, kind: x.kind, summary: x.summary, syntax: x.syntax ?? x.name };
      if (x.args) e.args = x.args;
      if (x.returns) e.returns = x.returns;
      if (x.components) e.components = x.components;
      if (x.option) e.option = x.option;
      out.push(e);
      at.set(`${x.kind}:${U(x.name)}`, e);
      continue;
    }
    if (x.addArgs?.length) {
      const args = [...(was.args ?? [])];
      for (const { after, ...arg } of x.addArgs) {
        const i = after ? args.findIndex(b => U(b.name) === U(after)) : -1;
        args.splice(i >= 0 ? i + 1 : args.length, 0, { ...arg, rw: '8' });
      }
      was.args = args;
    }
    if (x.option8) was.option8 = x.option8;
    if (x.returns8) was.returns8 = x.returns8;
  }
  for (const e of out) {
    const n = U(e.name);
    if (in6.has(n) && !in8.has(n)) e.rw = '6';
    else if (in8.has(n) && !in6.has(n)) e.rw = '8';
  }
  // the options' own manuals (EGM, SoftMove, Force Control): entries RobotWare's manuals do not have
  const optIn = (rw: '6' | 'omnicore') => new Set(Object.values(optionsFile.manuals).filter(m => m.rw === rw).flatMap(m => m.entries.map(x => `${x[0]}:${U(x[1])}`)));
  const opt6 = optIn('6'), optO = optIn('omnicore');
  for (const x of optionsFile.entries ?? []) {
    const key = `${x.kind}:${U(x.name)}`;
    if (at.has(key)) continue;
    const e: RapidRefEntry = { ...x };
    if (opt6.has(key) && !optO.has(key)) e.rw = '6';
    else if (optO.has(key) && !opt6.has(key)) e.rw = 'omnicore';
    out.push(e);
    at.set(key, e);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) || a.kind.localeCompare(b.kind));
}

/** Which RobotWare manuals list a name: 'both', only '6', only '8', or undefined (neither: an option manual we lack, SpotWare). */
export function rapidManualRw(name: string): '6' | '8' | 'both' | undefined {
  const n = U(name);
  return in6.has(n) && in8.has(n) ? 'both' : in6.has(n) ? '6' : in8.has(n) ? '8' : undefined;
}

/**
 * Every name of this kind the options' application manuals list (EGM, SoftMove, Force Control), or one manual's
 * ('egm6', 'egm7', 'css6', 'css7', 'fc6', 'fc7', 'fcgofa'), spelled as there.
 */
export function rapidOptionManualNames(kind: RapidRefEntry['kind'], manualKey?: string): string[] {
  const seen = new Map<string, string>();
  for (const [key, m] of Object.entries(optionsFile.manuals)) {
    if (manualKey && manualKey !== key) continue;
    for (const [k, n] of m.entries) if (k === kind && !seen.has(U(n))) seen.set(U(n), n);
  }
  return [...seen.values()];
}

/** The keys of the options' application manuals (egm6, egm7, css6, ...). */
export const RAPID_OPTION_MANUALS: readonly string[] = Object.keys(optionsFile.manuals);

/** Every name of this kind either manual lists (or the one given), spelled as there; identifiers only, not `:=` or `Compact IF`. */
export function rapidManualNames(kind: RapidRefEntry['kind'], rw?: '6' | '8'): string[] {
  const seen = new Map<string, string>();
  for (const [v, list] of [['6', manualNames.rw6.entries], ['8', manualNames.rw8.entries]] as const) {
    if (rw && rw !== v) continue;
    for (const [k, n] of list) if (k === kind && /^[A-Za-z_]\w*$/.test(n) && !seen.has(U(n))) seen.set(U(n), n);
  }
  return [...seen.values()];
}

const entries = merge();
const byName = new Map<string, RapidRefEntry>();
// an instruction and a function may share a name (e.g. both exist for some I/O); keep both reachable
const byKind = new Map<string, RapidRefEntry>();
for (const e of entries) {
  byKind.set(`${e.kind}:${e.name.toUpperCase()}`, e);
  if (!byName.has(e.name.toUpperCase())) byName.set(e.name.toUpperCase(), e);
}

export const RAPID_REFERENCE_SOURCE: string = (data as unknown as { source?: string }).source ?? '';

export function rapidRef(name: string, kind?: RapidRefEntry['kind']): RapidRefEntry | undefined {
  return kind ? byKind.get(`${kind}:${name.toUpperCase()}`) : byName.get(name.toUpperCase());
}

export function rapidRefEntries(kind?: RapidRefEntry['kind']): RapidRefEntry[] {
  return kind ? entries.filter(e => e.kind === kind) : entries;
}

/** The required (positional) arguments, in order: what the commas count. */
export function positionalArgs(e: RapidRefEntry): RapidRefArg[] {
  return (e.args ?? []).filter(a => !a.optional);
}

/** A snippet body for an instruction with its required arguments as placeholders: `MoveL ${1:ToPoint}, ${2:Speed}, ...;` */
export function instructionSnippet(e: RapidRefEntry): string {
  const req = positionalArgs(e);
  return req.length ? `${e.name} ${req.map((a, i) => `\${${i + 1}:${a.name}}`).join(', ')};` : `${e.name};`;
}

/** The hover text for an entry: syntax, what it is for, its arguments. */
export function rapidRefMarkdown(e: RapidRefEntry): string {
  const ret = e.returns ? ` → ${e.returns}${e.returns8 ? ` (RW8: ${e.returns8})` : ''}` : '';
  const opt = `${e.option ? ` · option ${e.option}` : ''}${e.option8 ? ` · RW8: ${e.option8}` : ''}`;
  const rw = e.rw === '6' ? ' · RobotWare 6 (IRC5) only' : e.rw === '8' ? ' · RobotWare 8 (OmniCore) only' : e.rw === 'omnicore' ? ' · OmniCore only' : '';
  const out = [`**${e.name}** _(${e.kind}${ret}${opt}${rw})_`, '```rapid', e.syntax, '```', e.summary];
  if (e.args?.length) {
    out.push('', ...e.args.map(a => `- \`${a.optional ? '[' : ''}${a.switch || a.optional ? '\\' : ''}${a.name}${a.optional ? ']' : ''}\`${a.type ? ` *${a.type}*` : ''}${a.rw === '8' ? ' _(RobotWare 8)_' : a.rw === 'omnicore' ? ' _(OmniCore)_' : ''}${a.desc ? ` - ${a.desc}` : ''}`));
  }
  if (e.components?.length) out.push('', ...e.components.map(c => `- \`${c.name}\`${c.type ? ` *${c.type}*` : ''}${c.desc ? ` - ${c.desc}` : ''}`));
  if (e.predefined?.length) out.push('', `Predefined: ${e.predefined.map(p => `\`${p}\``).join(', ')}`);
  return out.join('\n');
}

/** The data RobotWare predefines, by type - offered when an argument of that type is being typed. */
export const PREDEFINED: Record<string, string[]> = {
  speeddata: ['v5', 'v10', 'v20', 'v30', 'v40', 'v50', 'v60', 'v80', 'v100', 'v150', 'v200', 'v300', 'v400', 'v500', 'v600', 'v800', 'v1000', 'v1500', 'v2000', 'v2500', 'v3000', 'v4000', 'v5000', 'v6000', 'v7000', 'vmax'],
  zonedata: ['fine', 'z0', 'z1', 'z5', 'z10', 'z15', 'z20', 'z30', 'z40', 'z50', 'z60', 'z80', 'z100', 'z150', 'z200'],
  tooldata: ['tool0'],
  wobjdata: ['wobj0'],
  loaddata: ['load0'],
  bool: ['TRUE', 'FALSE'],
  // the options' alias types (egmstopmode, css_soft_dir, fcplane ...), from reference-options.json
  ...Object.fromEntries((optionsFile.entries ?? []).filter(e => e.predefined?.length).map(e => [e.name.toLowerCase(), e.predefined!])),
};

/**
 * Where the cursor is in a call, from the text of the statement up to the cursor:
 * the callee, which positional argument (by top-level commas), and the optional argument
 * being written (`\WObj:=`), if any. Undefined when the text is not inside a call.
 *
 *   'MoveL p10, v1'          -> { name: 'MoveL', index: 1 }
 *   'MoveL p10, v100\V:=5'   -> { name: 'MoveL', index: 1, optional: 'V' }
 *   'x := Offs(p10, 0, '     -> { name: 'Offs', index: 2, paren: true }
 */
export function callContext(text: string): { name: string; index: number; optional?: string; paren?: boolean } | undefined {
  // blank out strings and comments so their commas and brackets do not count
  const t = text.replace(/"(?:[^"]|"")*"?/g, m => ' '.repeat(m.length)).replace(/!.*$/gm, m => ' '.repeat(m.length));
  // the innermost open "(" preceded by a name is a function call
  let depth = 0;
  for (let i = t.length - 1; i >= 0; i--) {
    const c = t[i];
    if (c === ')' || c === ']') depth++;
    else if (c === '[') { if (depth) depth--; }
    else if (c === '(') {
      if (depth) { depth--; continue; }
      const m = /([A-Za-z_]\w*)\s*$/.exec(t.slice(0, i));
      if (!m) return undefined;
      const inner = t.slice(i + 1);
      return { name: m[1], index: topLevelCommas(inner), optional: optionalAt(inner), paren: true };
    }
  }
  // otherwise a procedure call: the statement's first word
  const stmt = t.slice(Math.max(t.lastIndexOf(';') + 1, 0));
  const m = /^\s*(?:[A-Za-z_]\w*\s*:(?!=)\s*)?([A-Za-z_]\w*)(\s|\\|$)/.exec(stmt);
  if (!m || /^(IF|ELSEIF|WHILE|FOR|TEST|CASE|RETURN|ELSE|THEN|DO)$/i.test(m[1])) return undefined;
  const rest = stmt.slice(m.index + m[0].length - (m[2] === '\\' ? 1 : 0));
  if (!m[2] && !rest) return undefined;
  if (/:=/.test(stmt.replace(/\\\w+\s*:=/g, ''))) return undefined;   // an assignment, not a call
  // `MoveL \Conc, p10, ...`: an optional argument before the first positional one has a comma of its own
  const positional = rest.replace(/^\s*(?:\\\w+(?:\s*:=[^,]*)?\s*,\s*)+/, '');
  return { name: m[1], index: topLevelCommas(positional), optional: optionalAt(rest) };
}

function topLevelCommas(s: string): number {
  let depth = 0, n = 0;
  for (const c of s) { if (c === '(' || c === '[') depth++; else if (c === ')' || c === ']') depth = Math.max(0, depth - 1); else if (c === ',' && !depth) n++; }
  return n;
}

/** `\WObj:=w` or `\Conc` being written at the end of the text: that optional argument's name */
function optionalAt(s: string): string | undefined {
  const last = s.slice(s.lastIndexOf(',') + 1);
  const m = /\\([A-Za-z_]\w*)(\s*:=[^\\]*)?\s*$/.exec(last);
  return m?.[1];
}
