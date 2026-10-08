/**
 * The RAPID reference: every instruction, function and data type of RobotWare 6 with its
 * syntax and arguments, generated from ABB's manual by scripts/import-rapid-manual.mjs into
 * reference.json. Pure, so the tests can use it.
 */
import data from './reference.json';

export interface RapidRefArg {
  name: string;
  type?: string;
  optional?: boolean;
  /** an argument with no value (`\Conc`) */
  switch?: boolean;
  /** arguments with the same number are alternatives (`\V | \T`) */
  alt?: number;
  desc?: string;
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
}

const entries = ((data as unknown as { entries: RapidRefEntry[] }).entries ?? []);
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
  const out = [`**${e.name}** _(${e.kind}${e.returns ? ` → ${e.returns}` : ''}${e.option ? ` · option ${e.option}` : ''})_`, '```rapid', e.syntax, '```', e.summary];
  if (e.args?.length) {
    out.push('', ...e.args.map(a => `- \`${a.optional ? '[' : ''}${a.switch || a.optional ? '\\' : ''}${a.name}${a.optional ? ']' : ''}\`${a.type ? ` *${a.type}*` : ''}${a.desc ? ` - ${a.desc}` : ''}`));
  }
  if (e.components?.length) out.push('', ...e.components.map(c => `- \`${c.name}\`${c.type ? ` *${c.type}*` : ''}${c.desc ? ` - ${c.desc}` : ''}`));
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
