/**
 * Program header templates: the block of `!` comment lines a customer spec wants at the
 * top of every program. Each plant has its own shape, so the shapes live in settings
 * (`robotCode.tp.headerTemplates`) and the defaults here are starting points to edit,
 * not FANUC or customer canon.
 *
 * Pure: a template plus a set of values in, comment lines plus the names still missing out.
 */

export interface HeaderTemplate { name: string; lines: string[] }

/** `${NAME}` placeholders; the ones this module can fill by itself are listed in AUTO_FIELDS */
const RE_FIELD = /\$\{([A-Z_][A-Z0-9_]*)\}/g;

/** filled from the program and the clock; anything else is asked for */
export const AUTO_FIELDS = ['PROGRAM', 'COMMENT', 'DATE', 'TIME', 'USER', 'ROBOT', 'RULE'] as const;

/** the pendant shows this many characters of a comment line */
export const COMMENT_WIDTH = 32;

/**
 * How far a `!comment` line's text runs past `limit`, as offsets into `body` (the line's
 * text from the `!`, without the ` ;`): `{ from, to }` of the part that does not fit, or
 * undefined when it fits. The `!` is not counted. An extended `--eg` comment has no such
 * limit - it is what a long comment is supposed to be - and a `//` remark never reaches
 * the pendant, so neither is measured.
 */
export function commentOverrun(body: string, limit = COMMENT_WIDTH): { from: number; to: number } | undefined {
  if (limit <= 0 || !body.startsWith('!')) return undefined;
  const text = body.replace(/\s*;\s*$/, '');
  return text.length - 1 > limit ? { from: 1 + limit, to: text.length } : undefined;
}

export const DEFAULT_HEADER_TEMPLATES: HeaderTemplate[] = [
  {
    // The shape every program in the Ford GVOSS Robot Programming Guide (FANUC, 2024-10)
    // opens with: a 32-star banner, what the program does, a blank comment, then a NOTE
    // naming the motion groups it drives, and the banner again. No author/date/rev lines.
    name: 'Ford (GVOSS)',
    lines: [
      '********************************',
      '${DESCRIPTION}',
      '',
      ' NOTE: This program has',
      ' ${GROUPS} motion',
      '********************************',
    ],
  },
  {
    name: 'GM',
    lines: [
      '--------------------------------',
      '${PROGRAM}',
      '${DESCRIPTION}',
      '--------------------------------',
      'CELL: ${CELL}  ROBOT: ${ROBOT}',
      'BY: ${AUTHOR} ON ${DATE}',
      'REV ${REV}: ${CHANGE}',
      '--------------------------------',
    ],
  },
  {
    name: 'Stellantis',
    lines: [
      '================================',
      'PROG: ${PROGRAM}',
      'FUNC: ${DESCRIPTION}',
      'LINE: ${LINE}  STN: ${STATION}',
      'ROBOT: ${ROBOT}',
      'AUTH: ${AUTHOR}  ${DATE}',
      '================================',
    ],
  },
  {
    name: 'Generic',
    lines: [
      '${RULE}',
      '${PROGRAM} - ${DESCRIPTION}',
      '${AUTHOR} ${DATE}',
      '${RULE}',
    ],
  },
];

/** every placeholder a template uses, in order of first appearance */
export function headerFields(t: HeaderTemplate): string[] {
  const out: string[] = [];
  for (const line of t.lines) for (const m of line.matchAll(RE_FIELD)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

/** the placeholders a template needs that are not filled automatically */
export function headerPrompts(t: HeaderTemplate): string[] {
  return headerFields(t).filter(f => !(AUTO_FIELDS as readonly string[]).includes(f));
}

/**
 * Fill a template. `values` maps placeholder → text; a placeholder with no value is left
 * as written (so the user sees exactly what was not answered) and reported in `missing`.
 * Every line is returned WITHOUT the leading `!` - the caller writes it in the house style.
 */
export function expandHeader(t: HeaderTemplate, values: Record<string, string | undefined>): { lines: string[]; missing: string[]; tooLong: number[] } {
  const missing: string[] = [];
  const lines = t.lines.map(line => line.replace(RE_FIELD, (all, name: string) => {
    const v = values[name];
    if (v === undefined) { if (!missing.includes(name)) missing.push(name); return all; }
    return v;
  }));
  const tooLong = lines.map((l, i) => (l.length > COMMENT_WIDTH ? i : -1)).filter(i => i >= 0);
  return { lines, missing, tooLong };
}

/** yy-mm-dd, as the /ATTR block writes it */
export function fanucDate(d = new Date()): string {
  return `${String(d.getFullYear()).slice(2)}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function fanucTime(d = new Date()): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

/** a rule line the full width of a pendant comment, drawn with the template's own first character when it is one */
export function ruleLine(t: HeaderTemplate): string {
  const first = t.lines.find(l => /^([-*=_#])\1{3,}$/.test(l))?.[0] ?? '-';
  return first.repeat(COMMENT_WIDTH);
}
