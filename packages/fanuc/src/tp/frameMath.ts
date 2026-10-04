/**
 * Rigid-body maths for taught positions. No kinematics anywhere in here.
 *
 * The distinction matters and is easy to blur: turning joint angles into a position needs
 * the robot's link geometry, which a backup does not contain. Re-expressing a CARTESIAN
 * position in a different user or tool frame needs only those two frames, and a controller
 * backup states both exactly (`sysframe.va`, `$MNUFRAME` / `$MNUTOOL`). So the first is
 * refused everywhere in this extension and the second is just arithmetic.
 *
 * **The rotation convention is measured, not assumed.** FANUC's W/P/R compose as
 * `Rz(R) · Ry(P) · Rx(W)` — fixed-axis X then Y then Z. That was established against real
 * controller data: `CURPOS.DG` reports one physical pose twice, in the active user frame and
 * in world, and `sysframe.va` gives that frame. Only this ordering reproduces world from
 * the pair, over every non-identity case in the backups (9/9 within 0.01 mm); the plausible
 * alternatives miss by up to 5.5 metres. `test/run.ts` keeps that check.
 */

export interface Xyzwpr { x: number; y: number; z: number; w: number; p: number; r: number }

/** A pose as rotation matrix + translation. Internal; callers work in XYZWPR. */
export interface Pose { R: number[][]; t: number[] }

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

function rotX(a: number): number[][] { const c = Math.cos(a), s = Math.sin(a); return [[1, 0, 0], [0, c, -s], [0, s, c]]; }
function rotY(a: number): number[][] { const c = Math.cos(a), s = Math.sin(a); return [[c, 0, s], [0, 1, 0], [-s, 0, c]]; }
function rotZ(a: number): number[][] { const c = Math.cos(a), s = Math.sin(a); return [[c, -s, 0], [s, c, 0], [0, 0, 1]]; }

function matMul(a: number[][], b: number[][]): number[][] {
  const o = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) { let s = 0; for (let k = 0; k < 3; k++) s += a[i][k] * b[k][j]; o[i][j] = s; }
  return o;
}
function matVec(m: number[][], v: number[]): number[] {
  return [0, 1, 2].map(i => m[i][0] * v[0] + m[i][1] * v[1] + m[i][2] * v[2]);
}
function transpose(m: number[][]): number[][] {
  return [[m[0][0], m[1][0], m[2][0]], [m[0][1], m[1][1], m[2][1]], [m[0][2], m[1][2], m[2][2]]];
}

/** XYZWPR → pose. */
export function toPose(v: Xyzwpr): Pose {
  return { R: matMul(matMul(rotZ(v.r * DEG), rotY(v.p * DEG)), rotX(v.w * DEG)), t: [v.x, v.y, v.z] };
}

/**
 * Pose → XYZWPR, inverting the same convention.
 *
 * At P = ±90° the X and Z rotations act on the same axis and W/R are not separable — the
 * controller has the same ambiguity. W is pinned to 0 there and the whole rotation is put
 * into R, which is the conventional resolution and keeps the result a valid pose rather
 * than producing NaN from a degenerate atan2.
 */
export function fromPose(pose: Pose): Xyzwpr {
  const R = pose.R;
  const sp = -R[2][0];
  const cp = Math.sqrt(R[0][0] * R[0][0] + R[1][0] * R[1][0]);
  let w: number, p: number, r: number;
  if (cp < 1e-9) {
    p = Math.asin(Math.max(-1, Math.min(1, sp)));
    w = 0;
    r = Math.atan2(-R[0][1], R[1][1]);
  } else {
    p = Math.atan2(sp, cp);
    r = Math.atan2(R[1][0], R[0][0]);
    w = Math.atan2(R[2][1], R[2][2]);
  }
  return {
    x: zeroish(pose.t[0]), y: zeroish(pose.t[1]), z: zeroish(pose.t[2]),
    w: zeroish(w * RAD), p: zeroish(p * RAD), r: zeroish(r * RAD),
  };
}

/**
 * Collapse a floating-point zero to a positive one.
 *
 * Matrix round-trips land on -1e-17 as readily as 0, and -0 renders as `-.000` where the
 * file holds `0.000`. That is a byte difference with no physical meaning, and it would make
 * converting a point to the frame it is already in report an edit — the one thing the
 * surgery guarantees it will not do. Only the sign is being fixed here; anything large
 * enough to matter at the three decimals a `.ls` stores is left exactly alone.
 */
function zeroish(v: number): number {
  return Math.abs(v) < 1e-9 ? 0 : v;
}

/** A ∘ B — apply B, then A. */
export function compose(a: Pose, b: Pose): Pose {
  return { R: matMul(a.R, b.R), t: matVec(a.R, b.t).map((x, i) => x + a.t[i]) };
}

/** The inverse transform. */
export function invert(pose: Pose): Pose {
  const Rt = transpose(pose.R);
  return { R: Rt, t: matVec(Rt, pose.t).map(x => -x) };
}

export const IDENTITY: Xyzwpr = { x: 0, y: 0, z: 0, w: 0, p: 0, r: 0 };

/**
 * The same physical point, expressed in a different user frame.
 *
 * `world = UF ∘ P`, so moving between frames is `P' = UF_to⁻¹ ∘ UF_from ∘ P`. Passing the
 * identity for either frame covers UF 0, which is world.
 */
export function convertUserFrame(point: Xyzwpr, from: Xyzwpr, to: Xyzwpr): Xyzwpr {
  return fromPose(compose(compose(invert(toPose(to)), toPose(from)), toPose(point)));
}

/**
 * The same physical *robot pose*, expressed for a different tool frame.
 *
 * A taught point places the TCP, and the TCP is defined by the tool: `flange = P ∘ UT⁻¹`.
 * Holding the flange still and changing the tool gives `P' = P ∘ UT_from⁻¹ ∘ UT_to`.
 *
 * Worth being clear about what this does and does not mean: it answers "where would I have
 * recorded this point if tool `to` had been active", i.e. the robot does not move. It is NOT
 * "keep the TCP where it is and swap tools" — that is a different question with a different
 * answer, and nothing here silently picks one for you.
 */
export function convertToolFrame(point: Xyzwpr, from: Xyzwpr, to: Xyzwpr): Xyzwpr {
  return fromPose(compose(compose(toPose(point), invert(toPose(from))), toPose(to)));
}

/** Which plane to reflect across — named by the two axes that lie in it. */
export type MirrorPlane = 'YZ' | 'XZ' | 'XY';

/**
 * Reflect a pose across a plane of the frame it is expressed in.
 *
 * Position is the easy half — the coordinate normal to the plane changes sign. Orientation
 * is not: a reflection has determinant −1, so applying it to a rotation gives something
 * that is no longer a rotation and cannot be written as W/P/R at all. Conjugating instead,
 * `R' = M · R · M`, multiplies the determinant by −1 twice and lands back on a proper
 * rotation, which is the mirrored tool orientation. (A 90° turn about Z mirrors to −90°,
 * which is the sanity check to hold in mind.)
 *
 * What this does NOT do is tell you the robot can get there. A mirrored pose frequently
 * needs a different arm configuration, and `CONFIG` is left exactly as it was because
 * working out the new one needs the kinematics this extension does not have. The caller
 * warns; nothing here guesses.
 */
export function mirror(point: Xyzwpr, plane: MirrorPlane): Xyzwpr {
  const m = plane === 'YZ' ? [-1, 1, 1] : plane === 'XZ' ? [1, -1, 1] : [1, 1, -1];
  const M = [[m[0], 0, 0], [0, m[1], 0], [0, 0, m[2]]];
  const pose = toPose(point);
  return fromPose({ R: matMul(matMul(M, pose.R), M), t: [pose.t[0] * m[0], pose.t[1] * m[1], pose.t[2] * m[2]] });
}

/**
 * Do two XYZWPR triples describe the same orientation?
 *
 * Compared as rotations, not as numbers, because W/P/R is not a unique encoding. At
 * P = ±90° the X and Z rotations act on the same axis, so `W -90, P 90, R 0` and
 * `W 0, P 90, R 90` are the same pose written two ways - and real programs contain exactly
 * that (a "HOME TEST" point taught at P = 90.000). Anything deciding whether to rewrite an
 * orientation has to ask this rather than compare the three numbers.
 */
export function sameOrientation(a: Xyzwpr, b: Xyzwpr, tol = 1e-6): boolean {
  const ra = toPose(a).R, rb = toPose(b).R;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) if (Math.abs(ra[i][j] - rb[i][j]) > tol) return false;
  return true;
}

/** Straight-line distance between two poses, for previews. */
export function distance(a: Xyzwpr, b: Xyzwpr): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/** Largest absolute difference across W/P/R, in degrees, folded to ±180. */
export function orientationDelta(a: Xyzwpr, b: Xyzwpr): number {
  const fold = (d: number) => { let x = ((d + 180) % 360 + 360) % 360 - 180; return Math.abs(x); };
  return Math.max(fold(a.w - b.w), fold(a.p - b.p), fold(a.r - b.r));
}
