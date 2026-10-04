/**
 * Regressions from the 26.9.1 smoke pass (GitHub issue #5). Every case here is synthetic
 * on purpose: none of it needs reference-backup, so none of it can be skipped silently.
 * Wired in by test/run.ts: `run(check)`.
 */
import { parseTp } from '@fanuc/tp/parser';
import { diffPositions, positionDiffMarkdown, angleDelta } from '@fanuc/tools/positionDiff';
import { findUnusedPrograms } from '@fanuc/tools/unusedPrograms';
import { buildProgramText, attrComment } from '@fanuc/tp/programTemplates';
import { convertUserFrame, toPose, IDENTITY, type Xyzwpr } from '@fanuc/tp/frameMath';

const cart = (w: number, o: { cmt?: string; cfg?: string } = {}) => `/PROG  T
/ATTR
/MN
   1:J P[1] 100% FINE ;
/POS
P[1${o.cmt ? `:"${o.cmt}"` : ''}]{
   GP1:
	UF : 1, UT : 1,		CONFIG : '${o.cfg ?? 'N U T, 0, 0, 0'}',
	X =   100.000  mm,	Y =   200.000  mm,	Z =   300.000  mm,
	W =  ${w.toFixed(3)} deg,	P =     0.000 deg,	R =    90.000 deg
};
/END
`;

const joint = (j4: number) => `/PROG  T
/ATTR
/MN
   1:J P[1] 100% FINE ;
/POS
P[1]{
   GP1:
	UF : 1, UT : 1,
	J1=     0.000 deg,	J2=     0.000 deg,	J3=     0.000 deg,
	J4=  ${j4.toFixed(3)} deg,	J5=     0.000 deg,	J6=     0.000 deg
};
/END
`;

export function run(check: (cond: unknown, msg: string) => void): void {
  // ---- 1. W/P/R wrap at +-180 ----
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;
  check(near(angleDelta(179.99, -179.99), 0.02), `angleDelta 179.99 -> -179.99 is +0.02 (${angleDelta(179.99, -179.99)})`);
  check(near(angleDelta(-179.99, 179.99), -0.02), `angleDelta -179.99 -> 179.99 is -0.02 (${angleDelta(-179.99, 179.99)})`);
  check(angleDelta(10, 20) === 10 && angleDelta(20, 10) === -10, 'angleDelta leaves an ordinary difference alone');
  check(angleDelta(0, 180) === 180 && angleDelta(0, -180) === 180 && angleDelta(180, -180) === 0, 'angleDelta: a half turn is +180 either way, 180 and -180 are one angle');
  check(near(angleDelta(175, -175), 10), `angleDelta 175 -> -175 is +10, the short way (${angleDelta(175, -175)})`);

  const wrap = diffPositions(parseTp(cart(179.99)), parseTp(cart(-179.99)))[0];
  const wAxis = wrap?.groups[0]?.axes.find(a => a.axis === 'W');
  // 0.02 deg is past the 0.01 deg tolerance, so it IS reported - as 0.02, not as 359.98
  check(wrap && wAxis && near(wAxis.delta!, 0.02), `position diff: W 179.990 -> -179.990 is 0.02 deg, not -359.98 (dW=${wAxis?.delta})`);
  const tiny = diffPositions(parseTp(cart(179.998)), parseTp(cart(-179.998)))[0];
  check(tiny && !tiny.moved, `position diff: W 179.998 -> -179.998 is 0.004 deg, inside tolerance, not a move (moved=${tiny?.moved})`);
  const real = diffPositions(parseTp(cart(175)), parseTp(cart(-175)))[0];
  const rAxis = real?.groups[0]?.axes.find(a => a.axis === 'W');
  check(real?.moved && rAxis && near(rAxis.delta!, 10), `position diff: W 175 -> -175 IS a move, of 10 deg (moved=${real?.moved}, dW=${rAxis?.delta})`);
  const jt = diffPositions(parseTp(joint(179.99)), parseTp(joint(-179.99)))[0];
  const j4 = jt?.groups[0]?.axes.find(a => a.axis === 'J4');
  check(jt?.kind[0] === 'joint' && jt.moved && j4 && near(j4.delta!, -359.98), `position diff: a JOINT axis is real travel and is never wrapped (kind=${jt?.kind[0]}, dJ4=${j4?.delta})`);

  // ---- 2. CONFIG whitespace ----
  const cfgSame = diffPositions(parseTp(cart(10)), parseTp(cart(10, { cfg: 'N U T,0,0,0' })))[0];
  check(cfgSame && !cfgSame.configChanged && !cfgSame.moved, 'position diff: CONFIG differing only in spacing is the same configuration');
  const cfgDiff = diffPositions(parseTp(cart(10)), parseTp(cart(10, { cfg: 'F U T, 0, 0, 0' })))[0];
  check(cfgDiff?.configChanged, 'position diff: N -> F is still a config change');

  // ---- 3. a pipe in a position comment ----
  const md = positionDiffMarkdown(diffPositions(parseTp(cart(10, { cmt: 'A|B' })), parseTp(cart(20, { cmt: 'A|B' }))), 'a', 'b');
  const cells = (l: string) => l.split(/(?<!\\)\|/).length;
  const head = md.split('\n').find(l => l.startsWith('| P | Change'))!, row = md.split('\n').find(l => l.startsWith('| P[1'))!;
  check(head && row && cells(head) === cells(row) && row.includes('A\\|B'), `position diff: a | in a comment is escaped, the row keeps ${cells(head ?? '')} cells (${cells(row ?? '')})`);

  // ---- 4. a self-call is not a caller ----
  const rep = findUnusedPrograms([
    { name: 'LOOPER', kind: 'tp', calls: ['LOOPER'], macros: [] },
    { name: 'SELFMAC', kind: 'tp', calls: [], macros: ['Do Self'] },
    { name: 'CALLER', kind: 'tp', calls: ['HELPER'], macros: [] },
    { name: 'HELPER', kind: 'tp', calls: ['HELPER'], macros: [] },
  ], [{ macroName: 'Do Self', progName: 'SELFMAC' }]);
  const names = rep.unused.map(u => u.name);
  check(names.includes('LOOPER'), `never called: a program only it calls itself is listed (${names.join(',')})`);
  check(!names.includes('HELPER'), 'never called: a recursive program that something ELSE calls is still used');
  check(names.includes('CALLER'), 'never called: the ordinary case still works');
  check(rep.entryPoints.some(e => e.name === 'SELFMAC'), 'never called: a macro-table target stays an entry point even when it runs its own macro');

  // ---- 5. a quote in the program comment ----
  check(attrComment('say "hi" there long text') === "say 'hi' there l" && attrComment('plain') === 'plain', `attrComment: no double quote, 16 characters (${attrComment('say "hi" there long text')})`);
  const txt = buildProgramText({ name: 'abc', comment: 'say "hi"', group: '1,*,*,*,*', headerLines: [], bodyLines: [], date: '26-09-19', time: '10:00:00' });
  const cLine = txt.split('\n').find(l => l.startsWith('COMMENT'))!;
  check((cLine.match(/"/g) ?? []).length === 2, `new program: the COMMENT attribute has exactly its two quotes (${cLine})`);
  const readBack = parseTp(txt).header.attrs.get('COMMENT')?.value.replace(/^"|"$/g, '');
  check(readBack === "say 'hi'", `new program: the comment reads back whole (${readBack})`);

  // ---- 6. the frame convention, pinned ----
  //
  // The measurement (world == UF o P on real CURPOS readings) needs controller data that is
  // not always on the machine running this. This is the backstop that IS always here: the
  // same composition done longhand with R = Rz(R) . Ry(P) . Rx(W), and the numbers it gave
  // on the day it was checked against nine real readings. If frameMath is ever "simplified"
  // to another ordering, this fails even with no backup in sight.
  const rad = (d: number) => d * Math.PI / 180;
  const mul = (A: number[][], B: number[][]) => A.map(r => B[0].map((_, j) => r.reduce((s, v, k) => s + v * B[k][j], 0)));
  const Rx = (a: number) => [[1, 0, 0], [0, Math.cos(a), -Math.sin(a)], [0, Math.sin(a), Math.cos(a)]];
  const Ry = (a: number) => [[Math.cos(a), 0, Math.sin(a)], [0, 1, 0], [-Math.sin(a), 0, Math.cos(a)]];
  const Rz = (a: number) => [[Math.cos(a), -Math.sin(a), 0], [Math.sin(a), Math.cos(a), 0], [0, 0, 1]];
  const zyx = (v: Xyzwpr) => mul(mul(Rz(rad(v.r)), Ry(rad(v.p))), Rx(rad(v.w)));
  const xyz = (v: Xyzwpr) => mul(mul(Rx(rad(v.w)), Ry(rad(v.p))), Rz(rad(v.r)));
  const at = (R: number[][], v: Xyzwpr, f: Xyzwpr) => [0, 1, 2].map(i => R[i][0] * v.x + R[i][1] * v.y + R[i][2] * v.z + [f.x, f.y, f.z][i]);

  const uf: Xyzwpr = { x: 500, y: -200, z: 300, w: 10, p: 20, r: 30 };
  const pt: Xyzwpr = { x: 100, y: 50, z: 25, w: -15, p: 40, r: 75 };
  const got = convertUserFrame(pt, uf, IDENTITY);
  const want = at(zyx(uf), pt, uf);
  const errT = Math.hypot(got.x - want[0], got.y - want[1], got.z - want[2]);
  check(errT < 1e-9, `frames pin: user frame -> world translation matches Rz.Ry.Rx longhand (${errT.toExponential(2)} mm out)`);
  const wantR = mul(zyx(uf), zyx(pt)), gotR = toPose(got).R;
  const errR = Math.max(...wantR.flatMap((r, i) => r.map((v, j) => Math.abs(v - gotR[i][j]))));
  check(errR < 1e-9, `frames pin: world orientation matches Rz.Ry.Rx longhand (${errR.toExponential(2)})`);
  // the numbers themselves, so a change to BOTH this longhand and frameMath still shows
  check(Math.abs(got.x - PIN.x) < 1e-6 && Math.abs(got.y - PIN.y) < 1e-6 && Math.abs(got.z - PIN.z) < 1e-6, `frames pin: world XYZ is ${PIN.x}, ${PIN.y}, ${PIN.z} (${got.x.toFixed(6)}, ${got.y.toFixed(6)}, ${got.z.toFixed(6)})`);
  check(Math.abs(got.w - PIN.w) < 1e-6 && Math.abs(got.p - PIN.p) < 1e-6 && Math.abs(got.r - PIN.r) < 1e-6, `frames pin: world WPR is ${PIN.w}, ${PIN.p}, ${PIN.r} (${got.w.toFixed(6)}, ${got.p.toFixed(6)}, ${got.r.toFixed(6)})`);
  // and the pin must be able to tell orderings apart, or it pins nothing
  const other = at(xyz(uf), pt, uf);
  const apart = Math.hypot(other[0] - want[0], other[1] - want[1], other[2] - want[2]);
  check(apart > 10, `frames pin: the Rx.Ry.Rz ordering lands ${apart.toFixed(1)} mm away on this case, so the pin discriminates`);

  // ---- 6b. the convention, MEASURED: real readings kept here so they are never missing ----
  //
  // Read over HTTP from ROBOGUIDE virtual controllers on 2026-09-19 (CURPOS.DG + SYSFRAME.VA).
  // CURPOS.DG states one physical pose twice - in the active user frame and in world - and
  // SYSFRAME.VA states that frame, so world MUST equal UF o P. Three more robots in the same
  // cell sat in an identity frame and are left out: an identity frame proves nothing.
  // Tolerances are the controller's own display rounding (0.01 mm / 0.01 deg per number).
  for (const m of MEASURED) {
    const w = convertUserFrame(m.user, m.frame, IDENTITY);
    const err = Math.hypot(w.x - m.world.x, w.y - m.world.y, w.z - m.world.z);
    check(err < 0.05, `frames measured: ${m.robot} UF${m.uf} user -> world is ${err.toFixed(4)} mm out`);
    const dOri = Math.max(Math.abs(angleDelta(m.world.w, w.w)), Math.abs(angleDelta(m.world.p, w.p)), Math.abs(angleDelta(m.world.r, w.r)));
    check(dOri < 0.02, `frames measured: ${m.robot} UF${m.uf} world W/P/R within display rounding (${dOri.toFixed(4)} deg)`);
    // the same reading under the other ordering, as matrices so no angle extraction is involved
    const diff = (A: number[][], B: number[][]) => Math.max(...A.flatMap((r, i) => r.map((v, j) => Math.abs(v - B[i][j]))));
    const right = diff(mul(zyx(m.frame), zyx(m.user)), zyx(m.world)), wrong = diff(mul(xyz(m.frame), xyz(m.user)), xyz(m.world));
    check(right < 1e-3 && wrong > 50 * right && wrong > 0.01, `frames measured: ${m.robot} fits Rz.Ry.Rx (${right.toExponential(1)}) and not Rx.Ry.Rz (${wrong.toExponential(1)})`);
  }
  console.log(`  frames: convention measured against ${MEASURED.length} recorded real non-identity reading(s) (issue5.test.ts)`);
}

const MEASURED: Array<{ robot: string; uf: number; frame: Xyzwpr; user: Xyzwpr; world: Xyzwpr }> = [
  { robot: 'S002R07', uf: 2, frame: { x: 1527.037, y: -539.356, z: 338.88, w: -0.005, p: -0.346, r: -90.11 }, user: { x: -49.44, y: 189.97, z: 880.88, w: 19.49, p: 0.34, r: 0.11 }, world: { x: 1717.21, y: -484.96, z: 1219.43, w: 19.48, p: 0, r: -90 } },
  { robot: 'S002R03', uf: 11, frame: { x: 7120, y: -1290, z: -1310, w: 0, p: 0, r: -90 }, user: { x: -3037.16, y: 1220.75, z: 2089.4, w: 164.33, p: 65.14, r: 88.73 }, world: { x: 8340.75, y: 1747.16, z: 779.4, w: 164.33, p: 65.14, r: -1.27 } },
];

/** convertUserFrame(pt, uf, IDENTITY) for the case above, as computed with Rz(R).Ry(P).Rx(W) */
const PIN = { x: 568.794345, y: -108.436455, z: 297.092196, w: 11.31733, p: 32.814223, r: 119.062589 };
