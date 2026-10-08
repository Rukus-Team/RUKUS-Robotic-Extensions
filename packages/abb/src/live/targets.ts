/**
 * RAPID jointtarget and robtarget values in source text, for converting one into the other with
 * the controller's kinematics. Pure, no VS Code.
 *
 *   jointtarget  [[j1,j2,j3,j4,j5,j6],[e1,...,e6]]
 *   robtarget    [[x,y,z],[q1,q2,q3,q4],[cf1,cf4,cf6,cfx],[e1,...,e6]]
 */

export type TargetLiteral =
  | { kind: 'joints'; robax: number[]; extax: number[]; start: number; end: number }
  | { kind: 'pose'; trans: [number, number, number]; rot: [number, number, number, number]; robconf: [number, number, number, number]; extax: number[]; start: number; end: number };

type Nested = number | Nested[];

/** `[[1,2],[3]]` -> nested arrays; undefined unless it is only numbers and brackets. RAPID writes 9E+09, 9E9, .5 and +1. */
function parseNested(src: string): Nested[] | undefined {
  const json = src.replace(/\s+/g, '').replace(/(^|[[,])\+/g, '$1').replace(/(^|[[,])(-?)\./g, (_, a, sign) => `${a}${sign}0.`);
  if (!/^[\d.eE+\-,[\]]+$/.test(json)) return undefined;
  try { const v = JSON.parse(json); return Array.isArray(v) ? v : undefined; } catch { return undefined; }
}

const nums = (v: Nested | undefined, n: number): number[] | undefined =>
  Array.isArray(v) && v.length === n && v.every(x => typeof x === 'number') ? (v as number[]) : undefined;

/**
 * The jointtarget or robtarget value around `offset`: the outermost [...] of the statement the
 * cursor is in that contains it. Strings and `!` comments are skipped.
 */
export function targetLiteralAt(text: string, offset: number): TargetLiteral | undefined {
  // the statement: from the ; before the cursor to the ; after it
  const from = text.lastIndexOf(';', offset - 1) + 1;
  const semi = text.indexOf(';', offset);
  const to = semi < 0 ? text.length : semi;
  let depth = 0, open = -1, inStr = false, inComment = false;
  for (let i = from; i < to; i++) {
    const ch = text[i];
    if (inComment) { if (ch === '\n') inComment = false; continue; }
    if (inStr) { if (ch === '"') inStr = false; continue; }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '!') { inComment = true; continue; }
    if (ch === '[') { if (depth++ === 0) open = i; continue; }
    if (ch === ']' && depth > 0 && --depth === 0) {
      const end = i + 1;
      if (open <= offset && offset <= end) return shape(text.slice(open, end), open, end);
    }
  }
  return undefined;
}

function shape(src: string, start: number, end: number): TargetLiteral | undefined {
  const v = parseNested(src);
  if (!v) return undefined;
  if (v.length === 2) {
    const robax = nums(v[0], 6), extax = nums(v[1], 6);
    if (robax && extax) return { kind: 'joints', robax, extax, start, end };
  }
  if (v.length === 4) {
    const t = nums(v[0], 3), q = nums(v[1], 4), cf = nums(v[2], 4), e = nums(v[3], 6);
    if (t && q && cf && e) return { kind: 'pose', trans: t as [number, number, number], rot: q as [number, number, number, number], robconf: cf as [number, number, number, number], extax: e, start, end };
  }
  return undefined;
}

/** A number as RobotStudio writes it: trimmed, `9E+09` for an unused axis. */
export function rapidNum(v: number, decimals: number): string {
  if (Math.abs(v) >= 8.9e9) return '9E+09';
  const s = v.toFixed(decimals).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
  return s === '-0' ? '0' : s;
}

const extax = (e: number[]) => `[${e.map(v => rapidNum(v, 2)).join(',')}]`;

export function formatRobtarget(p: { trans: number[]; rot: number[]; robconf: number[] }, ext: number[]): string {
  return `[[${p.trans.map(v => rapidNum(v, 2)).join(',')}],[${p.rot.map(v => rapidNum(v, 6)).join(',')}],[${p.robconf.map(v => rapidNum(v, 0)).join(',')}],${extax(ext)}]`;
}

export function formatJointtarget(robax: number[], ext: number[]): string {
  return `[[${robax.map(v => rapidNum(v, 4)).join(',')}],${extax(ext)}]`;
}

/** `CONST jointtarget jHome := [...]` -> 'jHome': the declared name, to name the converted twin after. */
export function declaredName(lineText: string): string | undefined {
  return /^\s*(?:LOCAL\s+|TASK\s+)?(?:CONST|PERS|VAR)\s+(?:jointtarget|robtarget)\s+(\w+)/i.exec(lineText)?.[1];
}
