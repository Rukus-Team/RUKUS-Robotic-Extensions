/**
 * Position diff: two copies of a program (two backups, or a backup and the robot's copy)
 * compared point by point. Pure - no vscode - so the corpus test can pin it.
 *
 * The rules match `positionDistance` in tp/teach.ts: a distance is only stated for two
 * cartesian points in the SAME user frame (different frames are different spaces, and a
 * number comparing them would be fiction); joint points get per-axis deltas and no
 * distance. Tolerance is the resolution a `.ls` stores (3 decimals), rounded up.
 */
import type { TpProgram, TpPosition, TpPosGroup } from '../tp/parser';

export interface PositionDiffTolerance { mm: number; deg: number }
export const DEFAULT_TOLERANCE: PositionDiffTolerance = { mm: 0.01, deg: 0.01 };

export interface AxisDelta { axis: string; a?: number; b?: number; delta?: number; unit: string; moved: boolean }

export interface PositionDiffRow {
  index: number;
  comment?: string;
  /** frames of the point in A and B (group 1) */
  uf?: [number | undefined, number | undefined];
  ut?: [number | undefined, number | undefined];
  kind: [TpPosGroup['kind'] | undefined, TpPosGroup['kind'] | undefined];
  /** per-group axis deltas; one entry per motion group present in either */
  groups: Array<{ group: number; axes: AxisDelta[]; distance?: number }>;
  /** any axis beyond tolerance, or the representation changed */
  moved: boolean;
  onlyIn?: 'a' | 'b';
  frameChanged: boolean;
  configChanged: boolean;
  kindChanged: boolean;
  untaught: [boolean, boolean];
  /** cartesian distance of group 1 (same UF only) */
  distance?: number;
}

const CART = ['X', 'Y', 'Z', 'W', 'P', 'R'];

/**
 * The shortest signed rotation from a to b, in (-180, 180]. The controller reports W/P/R in
 * that range, so a tool pointing near straight back reads 179.99 one day and -179.99 the
 * next: a 0.02 degree touch-up, not a 360 degree move. ONLY for the orientation of a
 * cartesian point - a joint value or an extended axis is real travel and is never wrapped.
 */
export function angleDelta(a: number, b: number): number {
  const d = (((b - a) + 180) % 360 + 360) % 360 - 180;
  return d === -180 ? 180 : d;
}

/** CONFIG compared as the controller means it: 'N U T, 0, 0, 0' and 'N U T,0,0,0' are one configuration */
function normConfig(c: string | undefined): string { return (c ?? '').replace(/\s+/g, '').toUpperCase(); }

export function diffPositions(a: TpProgram, b: TpProgram, tol: PositionDiffTolerance = DEFAULT_TOLERANCE): PositionDiffRow[] {
  const ma = new Map(a.positions.map(p => [p.index, p])), mb = new Map(b.positions.map(p => [p.index, p]));
  const out: PositionDiffRow[] = [];
  for (const i of [...new Set([...ma.keys(), ...mb.keys()])].sort((x, y) => x - y)) {
    const pa = ma.get(i), pb = mb.get(i);
    out.push(diffOne(i, pa, pb, tol));
  }
  return out;
}

function diffOne(index: number, pa: TpPosition | undefined, pb: TpPosition | undefined, tol: PositionDiffTolerance): PositionDiffRow {
  const ga = pa?.groups[0], gb = pb?.groups[0];
  const row: PositionDiffRow = {
    index,
    comment: pb?.comment ?? pa?.comment,
    uf: [ga?.uf, gb?.uf], ut: [ga?.ut, gb?.ut],
    kind: [ga?.kind, gb?.kind],
    groups: [],
    moved: false,
    onlyIn: pa && pb ? undefined : pa ? 'a' : 'b',
    frameChanged: !!(pa && pb) && (ga?.uf !== gb?.uf || ga?.ut !== gb?.ut),
    configChanged: !!(pa && pb) && normConfig(ga?.config) !== normConfig(gb?.config),
    kindChanged: !!(pa && pb) && !!ga && !!gb && ga.kind !== gb.kind,
    untaught: [!!ga?.untaught, !!gb?.untaught],
  };
  if (!pa || !pb) return row;

  const groupNos = [...new Set([...pa.groups.map(g => g.group), ...pb.groups.map(g => g.group)])].sort((x, y) => x - y);
  for (const gn of groupNos) {
    const xa = pa.groups.find(g => g.group === gn), xb = pb.groups.find(g => g.group === gn);
    const axes: AxisDelta[] = [];
    const names = axisOrder(xa, xb);
    for (const axis of names) {
      const va = xa?.values[axis], vb = xb?.values[axis];
      const unit = vb?.unit || va?.unit || (/^[WPR]$|^J\d/.test(axis) ? 'deg' : 'mm');
      // orientation of a cartesian point wraps at +-180; nothing else does
      const wraps = /^[WPR]$/.test(axis) && xa?.kind === 'cartesian' && xb?.kind === 'cartesian';
      const delta = va !== undefined && vb !== undefined ? (wraps ? angleDelta(va.value, vb.value) : vb.value - va.value) : undefined;
      const limit = /deg/i.test(unit) ? tol.deg : tol.mm;
      const moved = delta === undefined ? va !== undefined || vb !== undefined : Math.abs(delta) > limit;
      axes.push({ axis, a: va?.value, b: vb?.value, delta, unit, moved });
    }
    let distance: number | undefined;
    if (xa && xb && xa.kind === 'cartesian' && xb.kind === 'cartesian' && xa.uf === xb.uf) {
      const d = ['X', 'Y', 'Z'].map(k => axes.find(x => x.axis === k)?.delta);
      if (d.every(x => x !== undefined)) distance = Math.hypot(...(d as number[]));
    }
    row.groups.push({ group: gn, axes, distance });
    if (gn === 1) row.distance = distance;
  }
  row.moved = row.kindChanged || row.groups.some(g => g.axes.some(x => x.moved));
  return row;
}

/** X Y Z W P R (or J1..Jn) first, then the extended axes present in either side */
function axisOrder(a?: TpPosGroup, b?: TpPosGroup): string[] {
  const kind = b?.kind ?? a?.kind ?? 'unknown';
  const all = new Set([...Object.keys(a?.values ?? {}), ...Object.keys(b?.values ?? {})]);
  const head = kind === 'joint' ? [...all].filter(k => /^J\d+$/.test(k)).sort((x, y) => parseInt(x.slice(1), 10) - parseInt(y.slice(1), 10)) : CART.filter(k => all.has(k));
  const rest = [...all].filter(k => !head.includes(k)).sort();
  return [...head, ...rest];
}

function f(n: number | undefined, tolIsDeg = false): string {
  if (n === undefined) return '—';
  return Math.abs(n) < 0.0005 ? '0' : n.toFixed(tolIsDeg ? 3 : 3);
}

/** Markdown: moved / added / removed rows first, unchanged after; one line of totals on top. */
export function positionDiffMarkdown(rows: PositionDiffRow[], labelA: string, labelB: string): string {
  const changed = rows.filter(r => r.moved || r.onlyIn || r.frameChanged || r.configChanged);
  const same = rows.filter(r => !changed.includes(r));
  const moved = rows.filter(r => r.moved).length, added = rows.filter(r => r.onlyIn === 'b').length, removed = rows.filter(r => r.onlyIn === 'a').length;
  const reframed = rows.filter(r => r.frameChanged && !r.moved).length;
  const out: string[] = [
    `# Positions: ${labelA} → ${labelB}`, '',
    `- A: \`${labelA}\``, `- B: \`${labelB}\``, '',
    `**${rows.length} positions · ${moved} moved · ${added} only in B · ${removed} only in A · ${reframed} reframed without moving · ${same.length} unchanged**`, '',
  ];
  const table = (list: PositionDiffRow[], title: string) => {
    if (!list.length) return;
    out.push(`## ${title}`, '', '| P | Change | Frame | ΔX / J1 | ΔY / J2 | ΔZ / J3 | ΔW / J4 | ΔP / J5 | ΔR / J6 | Other | Distance |', '|---|---|---|---|---|---|---|---|---|---|---|');
    for (const r of list) {
      const g = r.groups[0];
      const main = g ? g.axes.slice(0, 6) : [];
      const cells = [0, 1, 2, 3, 4, 5].map(k => { const x = main[k]; return x ? (x.moved ? `**${f(x.delta)}**` : f(x.delta)) : '—'; });
      const other = g ? g.axes.slice(6).filter(x => x.moved).map(x => `${x.axis} ${f(x.delta)}`).join(' ') : '';
      const extraGroups = r.groups.slice(1).filter(x => x.axes.some(y => y.moved)).map(x => `GP${x.group} moved`).join(' ');
      const change = r.onlyIn === 'a' ? 'only in A' : r.onlyIn === 'b' ? 'only in B'
        : [r.kindChanged ? `${r.kind[0]} → ${r.kind[1]}` : '', r.moved && !r.kindChanged ? 'moved' : '', r.frameChanged ? 'reframed' : '', r.configChanged ? 'config' : '', r.untaught[0] !== r.untaught[1] ? (r.untaught[1] ? 'now untaught' : 'now taught') : ''].filter(Boolean).join(', ') || 'same';
      const frame = r.frameChanged ? `UF${r.uf?.[0] ?? '?'}/UT${r.ut?.[0] ?? '?'} → UF${r.uf?.[1] ?? '?'}/UT${r.ut?.[1] ?? '?'}` : `UF${r.uf?.[1] ?? r.uf?.[0] ?? '?'}/UT${r.ut?.[1] ?? r.ut?.[0] ?? '?'}`;
      out.push(`| P[${r.index}${r.comment ? `:${r.comment.replace(/\|/g, '\\|')}` : ''}] | ${change} | ${frame} | ${cells.join(' | ')} | ${[other, extraGroups].filter(Boolean).join(' · ')} | ${r.distance !== undefined ? f(r.distance) + ' mm' : r.kind[1] === 'joint' || r.kind[0] === 'joint' ? 'joint' : r.frameChanged ? 'n/a (frames differ)' : '—'} |`);
    }
    out.push('');
  };
  table(changed, 'Changed');
  table(same, 'Unchanged');
  out.push('_Deltas are B − A; W, P and R of a cartesian point are the shortest rotation, so 179.99 → −179.99 is 0.02°. Bold = beyond tolerance. A distance is only given for two cartesian points in the same user frame; joint points are compared axis by axis._');
  return out.join('\n');
}
