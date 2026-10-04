/**
 * `sysframe.va` — the controller's user and tool frame tables.
 *
 * This is the file that makes frame conversion possible without guessing: `$MNUFRAME[1,n]`
 * and `$MNUTOOL[1,n]` state each frame exactly as the controller holds it, so converting a
 * taught point between frames is arithmetic rather than inference. See `tp/frameMath.ts`.
 *
 * Shape, from a real V9.40 backup:
 *
 *     [*SYSTEM*]$MNUFRAME  Storage: SHADOW  Access: RW  : ARRAY[1,15] OF POSITION
 *         [1,1] =
 *       Group: 1   Config: N D B, 0, 0, 0
 *       X:     0.000   Y:     0.000   Z:     0.000
 *       W:     0.000   P:     0.000   R:     0.000
 *
 * The index is `[group,frame]`; only group 1 is read, matching every other reader here.
 */
import type { Xyzwpr } from '../tp/frameMath';

export interface FrameTable {
  /** frame number → transform; a frame the controller never set reads as all zeros */
  frames: Map<number, Xyzwpr>;
  tools: Map<number, Xyzwpr>;
  /** `$MNUFRAMENUM[1]` / `$MNUTOOLNUM[1]`: the frames selected when the backup was taken */
  activeFrame?: number;
  activeTool?: number;
}

/** a frame the controller has never set up reads as all zeros; UF 0 / UT 0 are the identity by definition */
export function isIdentityFrame(f: Xyzwpr | undefined): boolean {
  return !f || (f.x === 0 && f.y === 0 && f.z === 0 && f.w === 0 && f.p === 0 && f.r === 0);
}

const RE_ACTIVE = /^\s*\[1\]\s*=\s*(\d+)/;

const RE_VAR = /^\[\*SYSTEM\*\]\$([A-Z0-9_]+)/;
const RE_INDEX = /^\s*\[(\d+),(\d+)\]\s*=/;
const RE_XYZ = /^\s*X:\s*(-?[\d.]+)\s+Y:\s*(-?[\d.]+)\s+Z:\s*(-?[\d.]+)/;
const RE_WPR = /^\s*W:\s*(-?[\d.]+)\s+P:\s*(-?[\d.]+)\s+R:\s*(-?[\d.]+)/;

export function parseSysFrames(text: string): FrameTable {
  const out: FrameTable = { frames: new Map(), tools: new Map() };
  if (!/\$MNUFRAME|\$MNUTOOL/.test(text)) return out;

  let target: Map<number, Xyzwpr> | undefined;
  let active: 'activeFrame' | 'activeTool' | undefined;
  let index: number | undefined;
  let pending: Partial<Xyzwpr> | undefined;

  for (const line of text.split(/\r?\n/)) {
    const v = RE_VAR.exec(line);
    if (v) {
      // A new system variable ends whatever was being read; $MNUFRAMENUM must not be
      // mistaken for $MNUFRAME, hence the exact match.
      target = v[1] === 'MNUFRAME' ? out.frames : v[1] === 'MNUTOOL' ? out.tools : undefined;
      active = v[1] === 'MNUFRAMENUM' ? 'activeFrame' : v[1] === 'MNUTOOLNUM' ? 'activeTool' : undefined;
      index = undefined; pending = undefined;
      continue;
    }
    if (active) { const a = RE_ACTIVE.exec(line); if (a) { out[active] = parseInt(a[1], 10); active = undefined; } continue; }
    if (!target) continue;

    const ix = RE_INDEX.exec(line);
    if (ix) {
      index = parseInt(ix[1], 10) === 1 ? parseInt(ix[2], 10) : undefined;   // group 1 only
      pending = index === undefined ? undefined : { x: 0, y: 0, z: 0, w: 0, p: 0, r: 0 };
      continue;
    }
    if (index === undefined || !pending) continue;

    const xyz = RE_XYZ.exec(line);
    if (xyz) { pending.x = parseFloat(xyz[1]); pending.y = parseFloat(xyz[2]); pending.z = parseFloat(xyz[3]); continue; }

    const wpr = RE_WPR.exec(line);
    if (wpr) {
      pending.w = parseFloat(wpr[1]); pending.p = parseFloat(wpr[2]); pending.r = parseFloat(wpr[3]);
      target.set(index, pending as Xyzwpr);
      index = undefined; pending = undefined;
    }
  }
  return out;
}

/** UF 0 and UT 0 mean "no frame" — world, and the faceplate. Both are the identity. */
export function frameOrIdentity(table: Map<number, Xyzwpr> | undefined, index: number | undefined): Xyzwpr | undefined {
  if (index === undefined) return undefined;
  if (index === 0) return { x: 0, y: 0, z: 0, w: 0, p: 0, r: 0 };
  return table?.get(index);
}
