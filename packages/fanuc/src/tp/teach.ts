/**
 * Teaching a taught position from a measured one — the text surgery, with no VS Code
 * and no controller anywhere in it.
 *
 * Two rules shape everything here.
 *
 * **Only changed numbers are rewritten.** A `/POS` block is not re-emitted from parsed
 * values; each axis token is replaced in place, and an axis whose value did not change
 * is not touched at all. That is what makes the operation safe on a file we did not
 * write: FANUC's own formatting is not even self-consistent (the same backup contains
 * `Z =     0.000` and `P =      .000` in one block), so any re-emitter would rewrite
 * bytes nobody asked it to. Feeding a position back its own values must produce zero
 * edits, and the corpus test asserts exactly that over every position in every backup.
 *
 * **A reading that does not match the point is refused, not massaged.** `CURPOS.DG`
 * reports the *active* user and tool frame; the point in the program carries its own
 * `UF`/`UT`. When they differ the numbers are in different spaces and the result looks
 * completely valid afterwards, which is the worst possible failure. Those cases come
 * back as `blockers` and the caller must not apply them without the user saying so.
 */
import type { CurrentPosition } from '@core/live/types';
import { convertUserFrame, convertToolFrame, sameOrientation, mirror, type Xyzwpr, type MirrorPlane } from './frameMath';

/** A measured position, ready to be written into a `/POS` block. */
export interface TeachSource {
  kind: 'cartesian' | 'joint';
  uf?: number;
  ut?: number;
  /** arm configuration string, e.g. "N U T, 0, 0, 0" — cartesian only */
  config?: string;
  /** X Y Z W P R and/or J1..Jn, plus E1..En for extended axes */
  values: Record<string, number>;
  /** where the reading came from, for the confirmation and the log line */
  origin: string;
}

export interface TeachTextEdit { line: number; col: number; len: number; newText: string }

export interface AxisChange {
  axis: string;
  from: number;
  to: number;
  delta: number;
  /** mm / deg, as the file labels it */
  unit: string;
}

export interface TeachTarget {
  index: number;
  group: number;
  line: number;
  endLine: number;
  kind: 'cartesian' | 'joint' | 'unknown';
  uf?: number;
  ut?: number;
  config?: string;
  axes: string[];
}

export interface TeachPlan {
  target: TeachTarget;
  edits: TeachTextEdit[];
  changes: AxisChange[];
  /** CONFIG rewritten because the arm configuration itself moved */
  configChange?: { from: string; to: string };
  /** problems that make the result silently wrong — do not apply without an override */
  blockers: string[];
  /** worth saying, but the result is still meaningful */
  warnings: string[];
}

export interface TeachOptions {
  /** motion group to teach; defaults to the first group in the block */
  group?: number;
  /**
   * Rewrite the point's UF/UT to the frames the reading was taken in. Only ever set
   * from an explicit user choice — it changes what the point *means*, not just where
   * it is.
   */
  retargetFrames?: boolean;
}

const RE_POS_START = /^P\[(\d+)(?::"([^"]*)")?\]\s*\{/;
const RE_POS_GROUP = /^\s*GP(\d+):/;
const RE_POS_END = /^\s*\}\s*;/;
const RE_UFUT = /\bUF\s*:\s*(\d+)\s*,\s*UT\s*:\s*(\d+)/;
const RE_CONFIG = /\bCONFIG\s*:\s*'([^']*)'/;
/** axis, separator, pad, number — the pad is part of the replaced span so the column is kept */
const RE_AXIS = /\b(J\d+|E\d+|[XYZWPR])([ \t]*[:=])([ \t]*)(-?[0-9]*\.?[0-9]+)/g;

/** One axis value as it sits in the file: where it is, and exactly how it is written. */
interface AxisSlot { line: number; col: number; len: number; token: string; unit: string }

interface Scan {
  target: TeachTarget;
  slots: Map<string, AxisSlot>;
  ufutSpan?: { line: number; col: number; len: number };
  cfgSpan?: { line: number; col: number; len: number };
}

/**
 * Locate one position block and read its frames, configuration and axis values, keeping
 * the exact span and spelling of every number so it can be replaced without disturbing
 * anything around it. Shared by teaching and offsetting - the only difference between
 * those is where the new numbers come from.
 */
function scanPosition(text: string, index: number, group?: number): Scan | undefined {
  const lines = text.split(/\r?\n/);
  const block = findBlock(lines, index);
  if (!block) return undefined;
  const g = pickGroup(lines, block, group);
  if (!g) return undefined;

  const target: TeachTarget = { index, group: g.group, line: block.start, endLine: block.end, kind: 'unknown', axes: [] };
  const out: Scan = { target, slots: new Map() };

  // frames and configuration, from the group's header lines
  for (let ln = g.start; ln <= g.end; ln++) {
    const raw = lines[ln];
    const ufut = RE_UFUT.exec(raw);
    if (ufut && target.uf === undefined) {
      target.uf = parseInt(ufut[1], 10);
      target.ut = parseInt(ufut[2], 10);
      out.ufutSpan = { line: ln, col: ufut.index, len: ufut[0].length };
    }
    const cfg = RE_CONFIG.exec(raw);
    if (cfg && target.config === undefined) {
      target.config = cfg[1];
      out.cfgSpan = { line: ln, col: cfg.index + cfg[0].indexOf("'") + 1, len: cfg[1].length };
    }
  }

  // the axis values
  for (let ln = g.start; ln <= g.end; ln++) {
    const raw = lines[ln];
    // UF/UT and CONFIG live on their own line and carry no axis values; skipping them
    // keeps the axis regex away from the letters inside a config string.
    if (RE_UFUT.test(raw) || RE_CONFIG.test(raw)) continue;
    RE_AXIS.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = RE_AXIS.exec(raw))) {
      const axis = m[1];
      if (out.slots.has(axis)) continue;
      const padStart = m.index + m[1].length + m[2].length;
      const unit = /^([ \t]*)(mm|deg|inch)/.exec(raw.slice(padStart + m[3].length + m[4].length))?.[2] ?? '';
      out.slots.set(axis, { line: ln, col: padStart, len: m[3].length + m[4].length, token: m[4], unit });
      if (/^J\d/.test(axis)) target.kind = 'joint';
      else if (/^[XYZWPR]$/.test(axis)) target.kind = 'cartesian';
    }
  }
  target.axes = [...out.slots.keys()];
  return out;
}

/**
 * Write `value` into an axis slot, or nothing at all when it renders to the bytes that
 * are already there. "Nothing at all" is the important half: an unchanged axis must not
 * produce an edit, or teaching a point its own values back would rewrite the file.
 */
function editFor(axis: string, slot: AxisSlot, value: number): { edit: TeachTextEdit; change: AxisChange } | undefined {
  // A value written as a bare integer ("J1= 0 deg") was typed by hand; the controller never
  // writes one. Anything written back into such a slot comes out the controller's way:
  // three decimals, right-aligned in the controller's field.
  const integer = !slot.token.includes('.');
  const style = styleOf(slot.token);
  const rendered = integer ? controllerNumber(value) : fanucNumber(value, style.decimals, style.leadingZero);
  if (rendered === slot.token) return undefined;

  // Same number, spelled differently. FANUC writes zero as `.000`, `0.000` AND `-.000`, and
  // which one comes out depends on the token a value passed through on the way here - so a
  // conversion to another frame and back could rewrite `-.000` to `.000`. The value did not
  // change, therefore the bytes must not either; that is the promise this module is built
  // on, and it cannot hold only for values that are easy to compare.
  if (parseFloat(rendered) === parseFloat(slot.token)) return undefined;

  const from = parseFloat(slot.token);
  return {
    edit: { line: slot.line, col: slot.col, len: slot.len, newText: rendered.padStart(integer ? Math.max(slot.len, CONTROLLER_WIDTH) : slot.len) },
    change: { axis, from, to: parseFloat(rendered), delta: parseFloat(rendered) - from, unit: slot.unit },
  };
}

/**
 * Build the edits that would teach `P[index]` from `source`, without applying them.
 *
 * Returns undefined when the program has no such position — a caller wanting to *add*
 * one wants {@link buildPositionBlock} instead.
 */
export function planTeach(text: string, index: number, source: TeachSource, opts: TeachOptions = {}): TeachPlan | undefined {
  const scan = scanPosition(text, index, opts.group);
  if (!scan) return undefined;
  const { target, slots: seen, ufutSpan, cfgSpan } = scan;

  const edits: TeachTextEdit[] = [];
  const changes: AxisChange[] = [];
  const blockers: string[] = [];
  const warnings: string[] = [];
  let configChange: TeachPlan['configChange'];

  if (!seen.size) {
    blockers.push(`P[${index}] has no axis values to teach — it is an empty or untaught position.`);
    return { target, edits, changes, blockers, warnings };
  }

  // ---- refusals ----
  if (target.kind !== 'unknown' && target.kind !== source.kind) {
    blockers.push(
      target.kind === 'joint'
        ? `P[${index}] is stored as joint angles but the reading is cartesian. Converting between them needs the robot's kinematics, which this extension does not have.`
        : `P[${index}] is stored as XYZWPR but the reading is joint angles. Converting between them needs the robot's kinematics, which this extension does not have.`);
  }
  if (!opts.retargetFrames) {
    if (source.uf !== undefined && target.uf !== undefined && source.uf !== target.uf) {
      blockers.push(`The reading was taken in user frame ${source.uf}; P[${index}] is taught in UF ${target.uf}. The numbers are in different spaces, so teaching would move the point somewhere it has never been.`);
    }
    if (source.ut !== undefined && target.ut !== undefined && source.ut !== target.ut) {
      blockers.push(`The reading was taken with tool frame ${source.ut}; P[${index}] is taught with UT ${target.ut}. A different TCP means a different point.`);
    }
  }

  // An extended axis in the file that the reading does not carry would be left at its old
  // value while everything else moves — a point the robot has never been at.
  const missing = [...seen.keys()].filter(a => source.values[a] === undefined);
  if (missing.length) {
    blockers.push(`The reading has no value for ${missing.join(', ')}, which P[${index}] stores. Teaching would leave ${missing.length === 1 ? 'that axis' : 'those axes'} at the old value.`);
  }
  const extra = Object.keys(source.values).filter(a => !seen.has(a));
  if (extra.length) warnings.push(`The reading also carries ${extra.join(', ')}, which P[${index}] has no slot for; ${extra.length === 1 ? 'it is' : 'they are'} dropped.`);

  // ---- the edits ----
  for (const [axis, at] of seen) {
    const next = source.values[axis];
    if (next === undefined) continue;
    const e = editFor(axis, at, next);
    if (!e) continue;                                  // unchanged to the file's precision
    edits.push(e.edit); changes.push(e.change);
  }

  // The arm configuration is part of where the robot actually is: a point reached with a
  // flipped wrist is a different pose at the same XYZWPR. Record it as it was measured.
  if (cfgSpan && source.config !== undefined && target.config !== undefined && normalizeConfig(source.config) !== normalizeConfig(target.config)) {
    edits.push({ ...cfgSpan, newText: source.config });
    configChange = { from: target.config, to: source.config };
  }

  if (opts.retargetFrames && ufutSpan && source.uf !== undefined && source.ut !== undefined && (source.uf !== target.uf || source.ut !== target.ut)) {
    edits.push({ ...ufutSpan, newText: `UF : ${source.uf}, UT : ${source.ut}` });
    warnings.push(`P[${index}] retargeted from UF ${target.uf}/UT ${target.ut} to UF ${source.uf}/UT ${source.ut}.`);
  }

  edits.sort((a, b) => a.line - b.line || a.col - b.col);
  return { target, edits, changes, configChange, blockers, warnings };
}

/**
 * Rewrite a position block in the OTHER representation - cartesian to joint or back.
 *
 * This is the one edit here that is not surgery: the axis names change, so there is
 * nothing to replace in place and the block is re-emitted from the reading, in the file's
 * house style. Everything else about it is deliberately narrow. The reading must already
 * BE in the wanted representation (a controller reports both, so no conversion happens
 * here and none is needed), the block must be a single motion group (a second group would
 * be silently lost by a re-emit, so it is refused), and the name on the block is kept.
 */
export function planRewriteBlock(text: string, index: number, source: TeachSource): { line: number; endLine: number; newText: string; comment?: string; blockers: string[] } | undefined {
  const lines = text.split(/\r?\n/);
  const block = findBlock(lines, index);
  if (!block) return undefined;
  const blockers: string[] = [];
  const groups = lines.slice(block.start + 1, block.end).filter(l => RE_POS_GROUP.test(l)).length;
  if (groups > 1) blockers.push(`P[${index}] carries ${groups} motion groups. Rewriting it as ${source.kind === 'joint' ? 'joint angles' : 'XYZWPR'} would keep only the first, so it is refused.`);
  const wanted = source.kind === 'joint' ? /^J\d+$/ : /^[XYZWPR]$/;
  if (!Object.keys(source.values).some(a => wanted.test(a))) blockers.push(`The reading carries no ${source.kind === 'joint' ? 'joint angles' : 'XYZWPR'} to write.`);
  const comment = RE_POS_START.exec(lines[block.start])?.[2];
  return { line: block.start, endLine: block.end, newText: buildPositionBlock(text, index, source, comment), comment, blockers };
}

/**
 * Shift one taught position by a per-axis delta, without applying anything.
 *
 * **The offset is applied in the frame the point is already taught in.** Adding 3 to `X`
 * moves it 3 mm along its own `UF`'s X axis, not the world's — expressing a world offset
 * in a user frame needs that frame's transform, which is not in a `.ls` file and is not
 * guessed here. A caller offsetting a mixed-frame selection has to say so; `target.uf`
 * is reported for exactly that reason.
 *
 * The same in-place, only-what-changed surgery as {@link planTeach}, so an offset of zero
 * produces no edits and the formatting of every untouched axis is preserved byte for byte.
 */
export function planOffset(text: string, index: number, deltas: Record<string, number>, opts: TeachOptions = {}): TeachPlan | undefined {
  const scan = scanPosition(text, index, opts.group);
  if (!scan) return undefined;
  const { target, slots } = scan;

  const edits: TeachTextEdit[] = [];
  const changes: AxisChange[] = [];
  const blockers: string[] = [];
  const warnings: string[] = [];

  if (!slots.size) {
    blockers.push(`P[${index}] has no axis values to offset — it is an empty or untaught position.`);
    return { target, edits, changes, blockers, warnings };
  }

  const wanted = Object.keys(deltas).filter(a => deltas[a] !== 0);
  const cartesianAsk = wanted.some(a => /^[XYZWPR]$/.test(a));
  const jointAsk = wanted.some(a => /^J\d+$/.test(a));

  // Shifting XYZ on a joint-taught point would need the kinematics to turn angles into a
  // position and back. Refusing is the only honest answer; the alternative is a point
  // that looks fine and is not where anyone meant.
  if (cartesianAsk && target.kind === 'joint') {
    blockers.push(`P[${index}] is stored as joint angles, so an X/Y/Z offset cannot be applied to it. That conversion needs the robot's kinematics, which this extension does not have.`);
  }
  if (jointAsk && target.kind === 'cartesian') {
    blockers.push(`P[${index}] is stored as XYZWPR, so a joint-angle offset cannot be applied to it.`);
  }

  const absent = wanted.filter(a => !slots.has(a));
  if (absent.length) warnings.push(`P[${index}] has no ${absent.join(', ')} to offset; ${absent.length === 1 ? 'that axis was' : 'those axes were'} skipped.`);

  if (!blockers.length) {
    for (const axis of wanted) {
      const slot = slots.get(axis);
      if (!slot) continue;
      const e = editFor(axis, slot, parseFloat(slot.token) + deltas[axis]);
      if (!e) continue;
      edits.push(e.edit); changes.push(e.change);
    }
    edits.sort((a, b) => a.line - b.line || a.col - b.col);
  }
  return { target, edits, changes, blockers, warnings };
}

/** "1-9, 12, 15-20" → [1..9, 12, 15..20]; undefined when any part is not a number or range */
export function parsePositionList(input: string): number[] | undefined {
  const out = new Set<number>();
  const parts = input.split(/[,;\s]+/).filter(Boolean);
  if (!parts.length) return undefined;
  for (const part of parts) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!m) return undefined;
    const a = parseInt(m[1], 10), b = m[2] ? parseInt(m[2], 10) : a;
    if (b < a || b - a > 10000) return undefined;
    for (let i = a; i <= b; i++) out.add(i);
  }
  return [...out].sort((x, y) => x - y);
}

/**
 * Set axis values on a taught position, and ADD extended axes it does not have yet
 * (beta list 4, item 8: "add E1: 0.0 to P[1]-P[9]").
 *
 * An axis the position already has is overwritten with the same only-what-changed edit as
 * {@link planOffset}. A missing `E1`..`E3` is appended in the controller's layout - after the
 * last axis row, which gains the `,` the controller puts there - in the unit given for it
 * (`mm` for a linear rail, `deg` for a rotary axis). A missing X..R or J axis is not added:
 * that would change what kind of position it is, so it is reported and skipped.
 */
export function planSetAxes(text: string, index: number, values: Record<string, number>, units: Record<string, 'mm' | 'deg'> = {}, opts: TeachOptions = {}): TeachPlan | undefined {
  const scan = scanPosition(text, index, opts.group);
  if (!scan) return undefined;
  const { target, slots } = scan;
  const edits: TeachTextEdit[] = [];
  const changes: AxisChange[] = [];
  const blockers: string[] = [];
  const warnings: string[] = [];

  if (!slots.size) {
    blockers.push(`P[${index}] has no axis values — it is an empty or untaught position.`);
    return { target, edits, changes, blockers, warnings };
  }

  const missingE: string[] = [];
  for (const [axis, value] of Object.entries(values)) {
    const slot = slots.get(axis);
    if (slot) {
      const e = editFor(axis, slot, value);
      if (e) { edits.push(e.edit); changes.push(e.change); }
    } else if (/^E\d+$/.test(axis)) missingE.push(axis);
    else warnings.push(`P[${index}] has no ${axis}; it is a ${target.kind} position, so ${axis} was not added.`);
  }

  if (missingE.length) {
    const lines = text.split(/\r?\n/);
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const lastLine = Math.max(...[...slots.values()].map(sl => sl.line));
    const raw = lines[lastLine];
    const trimmed = raw.replace(/[ \t]+$/, '');
    const cells = missingE.sort((a, b) => parseInt(a.slice(1), 10) - parseInt(b.slice(1), 10))
      .map(axis => `\t${controllerCell(axis, controllerNumber(values[axis]), units[axis] ?? 'mm')}`);
    // the controller writes the extended axes on their own row, three to a row
    const rows: string[] = [];
    for (let i = 0; i < cells.length; i += 3) rows.push(cells.slice(i, i + 3).join(','));
    edits.push({ line: lastLine, col: trimmed.length, len: raw.length - trimmed.length, newText: `${trimmed.endsWith(',') ? '' : ','}${eol}${rows.join(`,${eol}`)}` });
    // an added axis had nothing before it: from 0, so the change still reads as a number
    for (const axis of missingE) changes.push({ axis, from: 0, to: values[axis], delta: values[axis], unit: units[axis] ?? 'mm' });
    edits.sort((a, b) => a.line - b.line || a.col - b.col);
  }
  return { target, edits, changes, blockers, warnings };
}

/**
 * Re-express one taught position in a different user and/or tool frame.
 *
 * The point does not move in the cell — the same physical place is written down against a
 * different reference. This is arithmetic, not kinematics: the frames come from the robot's
 * own `sysframe.va`, so nothing is inferred. See {@link convertUserFrame} for what the tool
 * conversion does and does not mean.
 *
 * `UF`/`UT` on the block are rewritten to match, because the numbers would otherwise be
 * labelled with the frame they are no longer in — which is the same silent wrongness the
 * teach guards exist to prevent.
 */
export function planFrameShift(
  text: string,
  index: number,
  spec: {
    /** frame the point is taught in now, and the one to express it in */
    fromUf?: Xyzwpr; toUf?: Xyzwpr; toUfNumber?: number;
    fromUt?: Xyzwpr; toUt?: Xyzwpr; toUtNumber?: number;
  },
  opts: TeachOptions = {},
): TeachPlan | undefined {
  const scan = scanPosition(text, index, opts.group);
  if (!scan) return undefined;
  const { target, slots, ufutSpan } = scan;

  const edits: TeachTextEdit[] = [];
  const changes: AxisChange[] = [];
  const blockers: string[] = [];
  const warnings: string[] = [];

  if (target.kind === 'joint') {
    blockers.push(`P[${index}] is stored as joint angles. Joint angles are not expressed in a user frame, so there is nothing to convert — and turning them into a position would need the robot's kinematics, which a backup does not contain.`);
    return { target, edits, changes, blockers, warnings };
  }
  if (!['X', 'Y', 'Z', 'W', 'P', 'R'].every(a => slots.has(a))) {
    blockers.push(`P[${index}] does not carry a full XYZWPR, so it cannot be converted.`);
    return { target, edits, changes, blockers, warnings };
  }

  const current: Xyzwpr = {
    x: parseFloat(slots.get('X')!.token), y: parseFloat(slots.get('Y')!.token), z: parseFloat(slots.get('Z')!.token),
    w: parseFloat(slots.get('W')!.token), p: parseFloat(slots.get('P')!.token), r: parseFloat(slots.get('R')!.token),
  };

  let moved = current;
  if (spec.toUf && spec.fromUf) moved = convertUserFrame(moved, spec.fromUf, spec.toUf);
  if (spec.toUt && spec.fromUt) moved = convertToolFrame(moved, spec.fromUt, spec.toUt);

  // W/P/R is not a unique encoding of an orientation: at P = ±90° the X and Z rotations act
  // on the same axis, so re-deriving the angles can return a different spelling of the
  // identical pose. Rewriting those would show up as a moved point in a backup diff while
  // the robot goes to exactly the same place, so the orientation is compared AS A ROTATION
  // and left alone when it has not actually turned.
  const turned = !sameOrientation(current, moved);
  const axes: Array<readonly [string, number]> = [['X', moved.x], ['Y', moved.y], ['Z', moved.z]];
  if (turned) axes.push(['W', moved.w], ['P', moved.p], ['R', moved.r]);
  else warnings.push(`The orientation is unchanged by this conversion; only the position is rewritten.`);

  for (const [axis, value] of axes) {
    const slot = slots.get(axis)!;
    const e = editFor(axis, slot, value);
    if (!e) continue;
    edits.push(e.edit); changes.push(e.change);
  }

  // The frame labels have to follow the numbers.
  const newUf = spec.toUfNumber ?? target.uf;
  const newUt = spec.toUtNumber ?? target.ut;
  if (ufutSpan && newUf !== undefined && newUt !== undefined && (newUf !== target.uf || newUt !== target.ut)) {
    edits.push({ ...ufutSpan, newText: `UF : ${newUf}, UT : ${newUt}` });
  }

  // An extended axis is a rail position, not part of the wrist pose; a frame change does
  // not move it, and pretending otherwise would be inventing data.
  const ext = [...slots.keys()].filter(a => /^E\d+$/.test(a));
  if (ext.length) warnings.push(`${ext.join(', ')} ${ext.length === 1 ? 'is an extended axis and is' : 'are extended axes and are'} left unchanged — a frame change does not move the rail.`);

  edits.sort((a, b) => a.line - b.line || a.col - b.col);
  return { target, edits, changes, blockers, warnings };
}

/**
 * Reflect a taught position across a plane.
 *
 * The plane belongs to a frame: mirroring "across XZ" means across the XZ plane of either
 * the point's own user frame or some other one, and `via` carries the pair of frames needed
 * to go there and back when it is not the point's own. That matters — mirroring a cell
 * across ITS centreline is a different operation from mirroring across the robot's world
 * plane, and which one was meant is the caller's to say.
 *
 * `CONFIG` is never touched. A mirrored pose often needs a different arm configuration and
 * working that out needs kinematics, so this reports the risk rather than inventing an answer.
 */
export function planMirror(
  text: string,
  index: number,
  plane: MirrorPlane,
  via?: { from: Xyzwpr; to: Xyzwpr },
  opts: TeachOptions = {},
): TeachPlan | undefined {
  const scan = scanPosition(text, index, opts.group);
  if (!scan) return undefined;
  const { target, slots } = scan;

  const edits: TeachTextEdit[] = [];
  const changes: AxisChange[] = [];
  const blockers: string[] = [];
  const warnings: string[] = [];

  if (target.kind === 'joint') {
    blockers.push(`P[${index}] is stored as joint angles, which describe the arm rather than a place, so there is no plane to reflect it across. Mirroring it would need the robot's kinematics.`);
    return { target, edits, changes, blockers, warnings };
  }
  if (!['X', 'Y', 'Z', 'W', 'P', 'R'].every(a => slots.has(a))) {
    blockers.push(`P[${index}] does not carry a full XYZWPR, so it cannot be mirrored.`);
    return { target, edits, changes, blockers, warnings };
  }

  const current: Xyzwpr = {
    x: parseFloat(slots.get('X')!.token), y: parseFloat(slots.get('Y')!.token), z: parseFloat(slots.get('Z')!.token),
    w: parseFloat(slots.get('W')!.token), p: parseFloat(slots.get('P')!.token), r: parseFloat(slots.get('R')!.token),
  };

  // Into the mirroring frame, reflect, and back again.
  let moved = via ? convertUserFrame(current, via.from, via.to) : current;
  moved = mirror(moved, plane);
  if (via) moved = convertUserFrame(moved, via.to, via.from);

  const turned = !sameOrientation(current, moved);
  const axes: Array<readonly [string, number]> = [['X', moved.x], ['Y', moved.y], ['Z', moved.z]];
  if (turned) axes.push(['W', moved.w], ['P', moved.p], ['R', moved.r]);

  for (const [axis, value] of axes) {
    const e = editFor(axis, slots.get(axis)!, value);
    if (!e) continue;
    edits.push(e.edit); changes.push(e.change);
  }

  if (target.config) {
    warnings.push(`CONFIG is left as '${target.config}'. A mirrored pose often needs a different arm configuration, and working out which one needs the robot's kinematics — check it on the pendant before running.`);
  }
  const ext = [...slots.keys()].filter(a => /^E\d+$/.test(a));
  if (ext.length) warnings.push(`${ext.join(', ')} left unchanged — a rail position is not reflected by this.`);

  edits.sort((a, b) => a.line - b.line || a.col - b.col);
  return { target, edits, changes, blockers, warnings };
}

/**
 * Change which frame a position CLAIMS to be in, without touching its numbers.
 *
 * The opposite of {@link planFrameShift}, and the difference is the whole point: converting
 * keeps the point where it is and rewrites the numbers, whereas relabelling keeps the
 * numbers and therefore **moves the point** — by however far apart the two frames are. That
 * is occasionally exactly what is wanted (a point taught against the wrong frame by mistake,
 * where the numbers are right and the label is wrong) and is otherwise a good way to send a
 * robot somewhere unexpected, so the caller has to say it out loud.
 */
export function planRelabelFrames(
  text: string,
  index: number,
  uf: number | undefined,
  ut: number | undefined,
  opts: TeachOptions = {},
): TeachPlan | undefined {
  const scan = scanPosition(text, index, opts.group);
  if (!scan) return undefined;
  const { target, ufutSpan } = scan;

  const blockers: string[] = [];
  const warnings: string[] = [];
  if (!ufutSpan || target.uf === undefined || target.ut === undefined) {
    blockers.push(`P[${index}] does not carry a UF/UT line to relabel.`);
    return { target, edits: [], changes: [], blockers, warnings };
  }

  const newUf = uf ?? target.uf;
  const newUt = ut ?? target.ut;
  if (newUf === target.uf && newUt === target.ut) {
    return { target, edits: [], changes: [], blockers, warnings };
  }
  return {
    target,
    edits: [{ ...ufutSpan, newText: `UF : ${newUf}, UT : ${newUt}` }],
    changes: [],
    blockers,
    warnings: [`P[${index}] keeps its numbers and changes frame ${target.uf}/${target.ut} → ${newUf}/${newUt}, so the point now refers to a DIFFERENT place in the cell.`],
  };
}

/**
 * Read an offset typed by a human.
 *
 * Accepts `X=3 Y=-1.5`, `X3 Y-1.5`, `x 3, y -1.5` and a bare `3 0 -1.5` meaning X Y Z,
 * because people type all of those and none of them is ambiguous. Returns undefined for
 * anything it cannot read rather than guessing — a misread offset moves a robot.
 */
export function parseAxisOffsets(input: string): Record<string, number> | undefined {
  const s = input.trim();
  if (!s) return undefined;

  // bare numbers = X Y Z, in that order, up to three of them
  if (/^[-+0-9., \t]+$/.test(s)) {
    const nums = s.split(/[\s,]+/).filter(Boolean).map(Number);
    if (!nums.length || nums.length > 3 || nums.some(n => !Number.isFinite(n))) return undefined;
    const out: Record<string, number> = {};
    ['X', 'Y', 'Z'].forEach((a, i) => { if (i < nums.length) out[a] = nums[i]; });
    return out;
  }

  const out: Record<string, number> = {};
  const re = /\b(J\d+|E\d+|[XYZWPR])\s*=?\s*(-?\+?[0-9]*\.?[0-9]+)/gi;
  let m: RegExpExecArray | null;
  let consumed = 0;
  while ((m = re.exec(s))) {
    const v = Number(m[2]);
    if (!Number.isFinite(v)) return undefined;
    out[m[1].toUpperCase()] = v;
    consumed += m[0].length;
  }
  if (!Object.keys(out).length) return undefined;
  // Anything substantial left over means it was not understood the way it was meant.
  if (s.replace(/[\s,;]/g, '').length - consumed > 2) return undefined;
  return out;
}

/** Straight-line distance between two taught positions, or undefined if not comparable. */
export function positionDistance(text: string, a: number, b: number, group?: number): number | undefined {
  const sa = scanPosition(text, a, group), sb = scanPosition(text, b, group);
  if (!sa || !sb) return undefined;
  if (sa.target.kind !== 'cartesian' || sb.target.kind !== 'cartesian') return undefined;
  // Different frames means different spaces; a number comparing them would be fiction.
  if (sa.target.uf !== sb.target.uf) return undefined;
  const v = (s: Scan, k: string) => { const t = s.slots.get(k); return t ? parseFloat(t.token) : undefined; };
  const d = ['X', 'Y', 'Z'].map(k => { const x = v(sa, k), y = v(sb, k); return x === undefined || y === undefined ? undefined : x - y; });
  if (d.some(x => x === undefined)) return undefined;
  return Math.hypot(...(d as number[]));
}

/** Apply a plan's edits to text — used by the tests; the editor applies them itself. */
export function applyTeachEdits(text: string, edits: TeachTextEdit[]): string {
  // Offsets into the ORIGINAL string, rather than splitting into lines and rejoining.
  // Real backups contain MIXED line endings - alt123.ls has 79 CRLF and 2 lone LF - so a
  // split/join would rewrite the terminator of every line in the file, including the ones
  // no edit went near. Byte-exactness is the whole promise here; it cannot stop at the
  // characters this happens to be replacing.
  const lineStart: number[] = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStart.push(i + 1);

  const absolute = edits
    .map(e => ({ at: (lineStart[e.line] ?? 0) + e.col, len: e.len, newText: e.newText }))
    .sort((a, b) => b.at - a.at);   // right to left, so earlier offsets stay valid

  let out = text;
  for (const e of absolute) out = out.slice(0, e.at) + e.newText + out.slice(e.at + e.len);
  return out;
}

/**
 * A {@link TeachSource} from a `CURPOS.DG` reading.
 *
 * `want` comes from what the target position stores, so a joint-taught point is compared
 * against joint angles and a cartesian one against XYZWPR — never a conversion. For
 * cartesian, UF 0 means world frame, which the controller reports as its own section.
 */
export function sourceFromCurrentPosition(pos: CurrentPosition, want: 'cartesian' | 'joint', targetUf?: number): TeachSource | undefined {
  const origin = `robot current position${pos.timestamp ? ` (${pos.timestamp})` : ''}`;
  if (want === 'joint') {
    if (!pos.joint?.joints.length) return undefined;
    const values: Record<string, number> = {};
    pos.joint.joints.forEach((v, i) => { if (v !== undefined) values[`J${i + 1}`] = v; });
    pos.joint.ext.forEach((v, i) => { if (v !== undefined) values[`E${i + 1}`] = v; });
    // Joint angles are frame-independent, so no UF is claimed; the tool still matters for
    // nothing here, but reporting it lets the caller show what was active.
    return { kind: 'joint', ut: pos.toolNo, values, origin };
  }
  const world = targetUf === 0;
  const cart = world ? pos.world : pos.userFrame;
  if (!cart) return undefined;
  const values: Record<string, number> = { X: cart.x, Y: cart.y, Z: cart.z, W: cart.w, P: cart.p, R: cart.r };
  cart.ext.forEach((v, i) => { if (v !== undefined) values[`E${i + 1}`] = v; });
  return { kind: 'cartesian', uf: world ? 0 : pos.frameNo, ut: pos.toolNo, config: cart.config, values, origin };
}

/** A {@link TeachSource} from a position register, for teaching with no robot connected. */
export function sourceFromPosRegValues(
  reg: { index: number; uf?: number; ut?: number; config?: string; kind: string; values: Record<string, number> },
): TeachSource | undefined {
  if (!Object.keys(reg.values).length) return undefined;
  const kind = reg.kind === 'joint' ? 'joint' : 'cartesian';
  return { kind, uf: reg.uf, ut: reg.ut, config: reg.config, values: { ...reg.values }, origin: `PR[${reg.index}]` };
}

/**
 * Text for a new `/POS` block, laid out exactly as the controller writes one: every value
 * a float with three decimals, right-aligned in a ten-character field.
 *
 * Until beta list 3 the style was copied off the first block in the file, which meant a
 * file whose first block had been typed by hand ("J1= 0 deg") passed that on to every
 * block the extension added. The controller's layout is the only one that is never wrong.
 */
export function buildPositionBlock(text: string, index: number, source: TeachSource, comment?: string): string {
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  const out: string[] = [`P[${index}${comment ? `:"${comment}"` : ''}]{`, `   GP1:`];

  const cart = source.kind === 'cartesian';
  const ufut = `\tUF : ${source.uf ?? 0}, UT : ${source.ut ?? 1},`;
  out.push(cart && source.config ? `${ufut}\t\tCONFIG : '${source.config}',` : `${ufut}\t`);

  const axes = cart ? ['X', 'Y', 'Z', 'W', 'P', 'R'] : Object.keys(source.values).filter(a => /^J\d+$/.test(a)).sort(byAxisNumber);
  const ext = Object.keys(source.values).filter(a => /^E\d+$/.test(a)).sort(byAxisNumber);
  const unitOf = (a: string) => (/^E\d/.test(a) || /^[XYZ]$/.test(a) ? 'mm' : 'deg');
  const cell = (a: string) => controllerCell(a, controllerNumber(source.values[a]), unitOf(a));

  for (let i = 0; i < axes.length; i += 3) {
    const row = axes.slice(i, i + 3).map(cell).join(',\t');
    out.push(`\t${row}${i + 3 < axes.length || ext.length ? ',' : ''}`);
  }
  for (let i = 0; i < ext.length; i += 3) {
    const row = ext.slice(i, i + 3).map(cell).join(',\t');
    out.push(`\t${row}${i + 3 < ext.length ? ',' : ''}`);
  }
  out.push('};');
  return out.join(nl);
}

/** The line index of `/POS` and of `/END`, for inserting a new block. */
export function posSectionBounds(text: string): { pos: number; end: number } | undefined {
  const lines = text.split(/\r?\n/);
  const pos = lines.findIndex(l => /^\/POS\b/.test(l));
  const end = lines.findIndex(l => /^\/END\b/.test(l));
  if (pos < 0 || end < 0 || end < pos) return undefined;
  return { pos, end };
}

/** Lowest position number not already taught, so recording never lands on a used point. */
export function nextFreePositionIndex(used: number[]): number {
  const set = new Set(used);
  let n = 1;
  while (set.has(n)) n++;
  return n;
}

// ---------------------------------------------------------------- number formatting

interface NumStyle { decimals: number; leadingZero: boolean }

/**
 * Read a number's formatting off the token it is replacing.
 *
 * Deriving the style per token rather than picking one is what lets an unchanged value
 * render back to the identical bytes: the corpus has `.000`, `0.000` and `0.00` in it,
 * sometimes inside one block, and none of those is "wrong".
 */
function styleOf(token: string): NumStyle {
  const dot = token.indexOf('.');
  return { decimals: dot < 0 ? 0 : token.length - dot - 1, leadingZero: /^-?0\./.test(token) };
}

/**
 * FANUC writes `-.098`, not `-0.098` — except where it writes `0.000`, hence the flag.
 * A small negative rounds to `-0.000` and stays that way (the corpus has `-.000` in it):
 * it says the axis is a hair below zero, which is true and is what the pendant recorded.
 */
function fanucNumber(v: number, decimals: number, leadingZero: boolean): string {
  // toFixed throws away the sign of negative zero, and `-.000` is a real token in these
  // files: parsing one and rendering it back has to give the same bytes, or every such
  // axis would look like a change.
  const s = Object.is(v, -0) ? `-${(0).toFixed(decimals)}` : v.toFixed(decimals);
  return leadingZero ? s : s.replace(/^(-?)0\./, '$1.');
}

function normalizeConfig(c: string): string { return c.replace(/\s+/g, ' ').trim().toUpperCase(); }

function byAxisNumber(a: string, b: string): number { return parseInt(a.slice(1), 10) - parseInt(b.slice(1), 10); }

// ---------------------------------------------------------------- block scanning

function findBlock(lines: string[], index: number): { start: number; end: number } | undefined {
  let inPos = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (/^\/POS\b/.test(raw)) { inPos = true; continue; }
    if (/^\/END\b/.test(raw)) break;
    if (!inPos) continue;
    const start = RE_POS_START.exec(raw);
    if (!start || parseInt(start[1], 10) !== index) continue;
    for (let j = i + 1; j < lines.length; j++) {
      if (RE_POS_END.test(lines[j])) return { start: i, end: j };
      if (RE_POS_START.test(lines[j]) || /^\/END\b/.test(lines[j])) break;   // unterminated
    }
    return undefined;
  }
  return undefined;
}

function pickGroup(lines: string[], block: { start: number; end: number }, want?: number): { group: number; start: number; end: number } | undefined {
  const groups: { group: number; start: number; end: number }[] = [];
  for (let i = block.start + 1; i < block.end; i++) {
    const g = RE_POS_GROUP.exec(lines[i]);
    if (g) {
      if (groups.length) groups[groups.length - 1].end = i - 1;
      groups.push({ group: parseInt(g[1], 10), start: i + 1, end: block.end - 1 });
    }
  }
  // A block with no GP line is a single-group block whose values start right away.
  if (!groups.length) return { group: 1, start: block.start + 1, end: block.end - 1 };
  return want === undefined ? groups[0] : groups.find(g => g.group === want);
}

// ---------------------------------------------------------------- the controller's layout

/** The controller writes every axis value with three decimals... */
export const CONTROLLER_DECIMALS = 3;
/** ...right-aligned in a ten-character field after the `=`: `J1=    -1.898 deg`, `X =   261.855  mm`. */
export const CONTROLLER_WIDTH = 10;

/**
 * A value spelled the way the controller spells it. Checked against the reference backup:
 * zero is `0.000`, a hair below zero is `-.000`, and every other value under one drops the
 * leading zero (`-.098`, `.450`).
 */
export function controllerNumber(v: number, decimals = CONTROLLER_DECIMALS): string {
  if (v === 0 && !Object.is(v, -0)) return (0).toFixed(decimals);
  return fanucNumber(v, decimals, false);
}

/**
 * One `axis = value unit` cell: `X =` for the cartesian letters, `J1=` / `E1=` for numbered
 * axes, the value in the controller's field, then ` deg` or `  mm` so the units line up.
 */
function controllerCell(axis: string, value: string, unit: string): string {
  const label = /^[XYZWPR]$/.test(axis) ? `${axis} =` : `${axis}=`;
  return `${label}${value.padStart(CONTROLLER_WIDTH)} ${unit === 'deg' ? 'deg' : ` ${unit}`}`;
}

/** A `/POS` row made of nothing but axis cells, e.g. `\tJ1= 0 deg,\tJ2=  12.5 deg,` */
const RE_AXIS_ROW = /^[ \t]*(?:(?:J\d+|E\d+|[XYZWPR])[ \t]*=[ \t]*-?[0-9]*\.?[0-9]+[ \t]*(?:mm|deg|inch)[ \t]*(?:,[ \t]*|$))+$/;
const RE_AXIS_CELL = /(J\d+|E\d+|[XYZWPR])[ \t]*=[ \t]*(-?[0-9]*\.?[0-9]+)[ \t]*(mm|deg|inch)/g;

/** Every axis value in `/POS` written as a bare integer, which the controller never does. */
export function integerAxisValues(text: string): { line: number; col: number; len: number; axis: string; token: string }[] {
  const out: { line: number; col: number; len: number; axis: string; token: string }[] = [];
  forEachPosRow(text, (raw, line) => {
    RE_AXIS.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = RE_AXIS.exec(raw))) {
      if (m[4].includes('.')) continue;
      out.push({ line, col: m.index + m[1].length + m[2].length + m[3].length, len: m[4].length, axis: m[1], token: m[4] });
    }
  });
  return out;
}

/**
 * Lay the `/POS` section out the way the controller writes it, one whole-line edit per row
 * that differs. Only rows made entirely of axis cells are touched: UF/UT, CONFIG, `GP1:`,
 * untaught `********` rows and anything unusual are left exactly as they are.
 *
 * A value that already has three or more decimals keeps its exact spelling (`.000`,
 * `0.000` and `-.000` all occur in real backups and all mean what they say); one with
 * fewer gains decimals and is never rounded. So a file the controller wrote produces no
 * edits at all - the corpus test holds that.
 */
export function formatPositions(text: string): TeachTextEdit[] {
  const edits: TeachTextEdit[] = [];
  forEachPosRow(text, (raw, line) => {
    if (!RE_AXIS_ROW.test(raw)) return;
    const cells: string[] = [];
    RE_AXIS_CELL.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = RE_AXIS_CELL.exec(raw))) {
      const [, axis, token, unit] = m;
      const dot = token.indexOf('.');
      const decimals = dot < 0 ? 0 : token.length - dot - 1;
      const value = decimals >= CONTROLLER_DECIMALS ? token : controllerNumber(parseFloat(token));
      cells.push(controllerCell(axis, value, unit));
    }
    const next = `\t${cells.join(',\t')}${/,[ \t]*$/.test(raw) ? ',' : ''}`;
    if (next !== raw) edits.push({ line, col: 0, len: raw.length, newText: next });
  });
  return edits;
}

function forEachPosRow(text: string, fn: (raw: string, line: number) => void): void {
  const lines = text.split(/\r?\n/);
  let inPos = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (/^\/POS\b/.test(raw)) { inPos = true; continue; }
    if (/^\/END\b/.test(raw)) break;
    if (!inPos || RE_UFUT.test(raw) || RE_CONFIG.test(raw) || RE_POS_START.test(raw) || RE_POS_GROUP.test(raw)) continue;
    fn(raw, i);
  }
}
