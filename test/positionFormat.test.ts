/**
 * Beta list 3, item 1: position values are written the controller's way - floats, three
 * decimals, right-aligned in a ten-character field. Wired in by test/run.ts:
 * `run(check, lsFiles)`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  controllerNumber, formatPositions, integerAxisValues, buildPositionBlock, planOffset, planSetAxes, parsePositionList, applyTeachEdits,
} from '@fanuc/tp/teach';

export function run(check: (cond: unknown, msg: string) => void, lsFiles: string[]): void {
  // ---- spelling, as seen in the reference backup ----
  const spell: [number, string][] = [[0, '0.000'], [-0, '-.000'], [200, '200.000'], [-0.098, '-.098'], [0.45, '.450'], [-1.898, '-1.898'], [7085.445, '7085.445'], [-174.1666, '-174.167']];
  for (const [v, want] of spell) check(controllerNumber(v) === want, `controllerNumber(${Object.is(v, -0) ? '-0' : v}) = ${JSON.stringify(controllerNumber(v))}, want ${want}`);

  // ---- a hand-typed block becomes the controller's ----
  const typed = [
    '/PROG  T', '/MN', '   1:  J P[1] 100% FINE ;', '   2:  L P[2] 500mm/sec FINE ;', '/POS',
    'P[1]{', '   GP1:', '\tUF : 0, UT : 1,',
    '\tJ1= 0 deg,\tJ2=  12.5 deg,\tJ3= -45 deg,',
    '\tJ4=  0.000 deg,\tJ5= -.5 deg,\tJ6= 200 deg',
    '};',
    'P[2]{', '   GP1:', "\tUF : 1, UT : 1,\t\tCONFIG : 'N U T, 0, 0, 0',",
    '\tX = 200  mm,\tY =   235.485  mm,\tZ = 1499.9171 mm,',
    '\tW = 0 deg,\tP =     -.098 deg,\tR =   -90.045 deg',
    '};', '/END', '',
  ].join('\r\n');
  const ints = integerAxisValues(typed);
  check(ints.map(i => `${i.axis}=${i.token}`).join(' ') === 'J1=0 J3=-45 J6=200 X=200 W=0', `integerAxisValues finds the bare integers: ${ints.map(i => `${i.axis}=${i.token}`).join(' ')}`);
  const out = applyTeachEdits(typed, formatPositions(typed)).split('\r\n');
  const want = [
    '\tJ1=     0.000 deg,\tJ2=    12.500 deg,\tJ3=   -45.000 deg,',
    '\tJ4=     0.000 deg,\tJ5=     -.500 deg,\tJ6=   200.000 deg',
    '\tX =   200.000  mm,\tY =   235.485  mm,\tZ = 1499.9171  mm,',
    '\tW =     0.000 deg,\tP =     -.098 deg,\tR =   -90.045 deg',
  ];
  const got = [out[8], out[9], out[14], out[15]];
  want.forEach((w, i) => check(got[i] === w, `formatPositions row ${i}:\n      got  ${JSON.stringify(got[i])}\n      want ${JSON.stringify(w)}`));
  check(out[7] === '\tUF : 0, UT : 1,' && out[13] === "\tUF : 1, UT : 1,\t\tCONFIG : 'N U T, 0, 0, 0',", 'formatPositions leaves UF/UT and CONFIG alone');
  check(integerAxisValues(out.join('\r\n')).length === 0, 'formatted text has no integer axis values left');
  check(formatPositions(out.join('\r\n')).length === 0, 'formatPositions is idempotent');

  // untaught rows are not axis cells and must survive untouched
  const untaught = ['/POS', 'P[3]{', '   GP1:', '\tUF : F, UT : F,', '\tX = ******** mm,\tY = ******** mm,\tZ = ******** mm,', '};', '/END'].join('\n');
  check(formatPositions(untaught).length === 0, 'formatPositions leaves untaught ******** rows alone');

  // ---- writing into an integer slot comes out in the controller's layout ----
  const off = planOffset(typed, 1, { J1: 5 });
  const offText = off && applyTeachEdits(typed, off.edits).split('\r\n')[8];
  check(offText === '\tJ1=     5.000 deg,\tJ2=  12.5 deg,\tJ3= -45 deg,', `offset into "J1= 0" writes 5.000 in the controller's field: ${JSON.stringify(offText)}`);

  // ---- beta list 4, item 8: add E1 to positions that lack it, set it where it is ----
  const added = planSetAxes(typed, 2, { E1: 0 });
  const addedText = added && applyTeachEdits(typed, added.edits).split('\r\n');
  check(!!addedText && addedText[15] === '\tW = 0 deg,\tP =     -.098 deg,\tR =   -90.045 deg,' && addedText[16] === '\tE1=     0.000  mm' && addedText[17] === '};',
    `planSetAxes adds E1 after the last axis row, in the controller's layout: ${JSON.stringify(addedText?.slice(15, 18))}`);
  const deg = planSetAxes(typed, 1, { E1: 90, E2: 0 }, { E1: 'deg', E2: 'deg' });
  const degText = deg && applyTeachEdits(typed, deg.edits).split('\r\n');
  check(!!degText && degText[10] === '\tE1=    90.000 deg,\tE2=     0.000 deg', `planSetAxes adds two rotary axes on one row: ${JSON.stringify(degText?.[10])}`);
  const twice = addedText && planSetAxes(addedText.join('\r\n'), 2, { E1: 0 });
  check(!!twice && twice.edits.length === 0, 'planSetAxes on a position that already has E1=0 changes nothing');
  const set = addedText && planSetAxes(addedText.join('\r\n'), 2, { E1: 250 });
  check(!!set && applyTeachEdits(addedText!.join('\r\n'), set.edits).split('\r\n')[16] === '\tE1=   250.000  mm', 'planSetAxes overwrites an E1 that is there');
  const jointX = planSetAxes(typed, 1, { X: 5 });
  check(!!jointX && jointX.edits.length === 0 && jointX.warnings.length === 1, 'planSetAxes will not add X to a joint position');
  check(JSON.stringify(parsePositionList('1-3, 7,9-10')) === '[1,2,3,7,9,10]' && parsePositionList('1-x') === undefined && parsePositionList('5-2') === undefined, 'parsePositionList reads "1-3, 7,9-10" and refuses nonsense');

  // ---- a new block is the controller's, whatever the file's first block looks like ----
  const jb = buildPositionBlock(typed, 9, { kind: 'joint', uf: 0, ut: 1, origin: 't', values: { J1: 0, J2: -1.898, J3: 200, J4: 0.45, J5: -0, J6: 85.159 } }).split('\r\n');
  check(jb[3] === '\tJ1=     0.000 deg,\tJ2=    -1.898 deg,\tJ3=   200.000 deg,' && jb[4] === '\tJ4=      .450 deg,\tJ5=     -.000 deg,\tJ6=    85.159 deg',
    `buildPositionBlock joint rows are the controller's:\n      ${JSON.stringify(jb[3])}\n      ${JSON.stringify(jb[4])}`);
  const cb = buildPositionBlock(typed, 9, { kind: 'cartesian', uf: 12, ut: 2, config: 'N U T, 0, 0, 0', origin: 't', values: { X: 261.855, Y: 235.485, Z: 1499.917, W: 175.511, P: -0.098, R: -90.045, E1: 7085.445 } }).split('\r\n');
  check(cb[3] === '\tX =   261.855  mm,\tY =   235.485  mm,\tZ =  1499.917  mm,' && cb[4] === '\tW =   175.511 deg,\tP =     -.098 deg,\tR =   -90.045 deg,' && cb[5] === '\tE1=  7085.445  mm',
    `buildPositionBlock cartesian rows are byte-identical to the controller's (alt123.ls):\n      ${cb.slice(3, 6).map(l => JSON.stringify(l)).join('\n      ')}`);

  // ---- the corpus: a file the controller wrote needs no formatting ----
  let files = 0, rows = 0;
  const bad: string[] = [];
  for (const f of lsFiles) {
    const text = fs.readFileSync(f, 'latin1');
    if (!/^\/POS\b/m.test(text)) continue;
    files++;
    const edits = formatPositions(text);
    rows += edits.length;
    for (const e of edits.slice(0, 1)) bad.push(`${path.basename(f)}:${e.line + 1} ${JSON.stringify(text.split(/\r?\n/)[e.line])} -> ${JSON.stringify(e.newText)}`);
  }
  // CI has no controller backups; only a local run must cover the corpus.
  if (!process.env.CI) check(files > 20, `position format corpus covered only ${files} files`);
  check(rows === 0, `formatPositions rewrote ${rows} controller-written row(s):\n    ${bad.slice(0, 6).join('\n    ')}`);
  console.log(`  position format: ${files} controller files, ${rows} row(s) changed by Format Document`);
}
