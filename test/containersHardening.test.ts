/**
 * The containers hardening pass (2026-09-19): the line count that does not melt on a big
 * program, the snapshot swap that cannot lose the old snapshot, the copy that does not block,
 * and the .gitignore that keeps the provenance file with the snapshot it describes.
 * Pure + a temp folder; no VS Code. Wired in by test/run.ts: `await run(check)`.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  lineDiffCount, swapSnapshot, copySnapshotAsync, writeRobotGitignore,
  ROBOT_DIR, ROBOT_GITIGNORE_LINES, normalizeTpForCompare,
} from '@core/robotContainers';
import { parseNumReg } from '@fanuc/data/vaParser';

/** the first implementation, kept here as the reference: a full (n+1) x (m+1) LCS table */
function referenceCount(a: string, b: string) {
  const la = a.split('\n'), lb = b.split('\n'), n = la.length, m = lb.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) dp[i][j] = la[i - 1] === lb[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
  const lcs = dp[n][m], changed = Math.min(n, m) - lcs;
  return { same: lcs, changed, added: m - lcs - changed, deleted: n - lcs - changed };
}

export async function run(check: (cond: unknown, msg: string) => void): Promise<void> {
  // ---- 1. the line count: same numbers as before, on anything ----
  let seed = 12345;
  const rnd = (k: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % k; };
  let differ = 0, cases = 0, firstBad = '';
  for (let t = 0; t < 400; t++) {
    // small alphabets on purpose: repeated lines are where an LCS shortcut goes wrong
    const alphabet = 2 + rnd(6);
    const mk = (len: number) => Array.from({ length: len }, () => 'L' + rnd(alphabet)).join('\n');
    const a = mk(rnd(40)), b = rnd(3) === 0 ? a : mk(rnd(40));
    const want = referenceCount(a, b), got = lineDiffCount(a, b);
    cases++;
    if (want.same !== got.same || want.changed !== got.changed || want.added !== got.added || want.deleted !== got.deleted || got.approximate) { differ++; firstBad ||= JSON.stringify({ a, b, want, got }); }
  }
  check(differ === 0, `lineDiffCount: identical to the full LCS table on ${cases} random pairs (${differ} differed${firstBad ? ': ' + firstBad.slice(0, 300) : ''})`);
  // edits derived from a base, the real shape: a few lines changed in a long file
  let derived = 0;
  for (let t = 0; t < 60; t++) {
    const base = Array.from({ length: 200 + rnd(200) }, (_, i) => `  ${i}: R[${rnd(50)}]=${rnd(9)} ;`);
    const edited = [...base];
    for (let e = 0; e < 1 + rnd(6); e++) { const at = rnd(edited.length); const op = rnd(3); if (op === 0) edited.splice(at, 1); else if (op === 1) edited.splice(at, 0, `NEW${e}`); else edited[at] = `CHG${e}`; }
    const want = referenceCount(base.join('\n'), edited.join('\n')), got = lineDiffCount(base.join('\n'), edited.join('\n'));
    if (JSON.stringify(want) !== JSON.stringify(got)) derived++;
  }
  check(derived === 0, `lineDiffCount: identical on 60 long files with a few edits each (${derived} differed)`);
  check(JSON.stringify(lineDiffCount('', '')) === JSON.stringify(referenceCount('', '')) && JSON.stringify(lineDiffCount('a', '')) === JSON.stringify(referenceCount('a', '')) && JSON.stringify(lineDiffCount('', 'a\nb')) === JSON.stringify(referenceCount('', 'a\nb')), 'lineDiffCount: empty texts');

  // ---- and it is fast where the table was not ----
  const big = Array.from({ length: 8000 }, (_, i) => `${String(i + 1).padStart(4)}:  L P[${i}] 500mm/sec CNT100 ;`);
  const bigEdited = [...big]; bigEdited.splice(4000, 0, '   :  R[1]=1 ;'); bigEdited[7000] = '   :  WAIT 1.00(sec) ;';
  const t0 = performance.now();
  const d8 = lineDiffCount(normalizeTpForCompare(big.join('\n')), normalizeTpForCompare(bigEdited.join('\n')));
  const ms = performance.now() - t0;
  check(d8.added + d8.changed + d8.deleted === 2 && !d8.approximate, `lineDiffCount: an 8000-line program with two edits counts 2 (${JSON.stringify(d8)})`);
  check(ms < 100, `lineDiffCount: ... in ${ms.toFixed(1)} ms - the table took about 380 ms and 128 MB for this`);
  // nothing in common: the search gives up and says so, instead of going quadratic
  const x = Array.from({ length: 6000 }, (_, i) => `x${i}`).join('\n'), y = Array.from({ length: 6000 }, (_, i) => `y${i}`).join('\n');
  const t1 = performance.now(); const far = lineDiffCount(x, y); const ms2 = performance.now() - t1;
  check(far.approximate === true && far.same === 0 && far.changed === 6000, `lineDiffCount: two unrelated 6000-line texts are marked approximate (${JSON.stringify(far)})`);
  check(ms2 < 1500, `lineDiffCount: ... and stop at the edit cap in ${ms2.toFixed(0)} ms rather than running to 12000 edits`);
  const capped = lineDiffCount('a\nb\nc\nd\ne\nf', 'p\nq\nr\ns\nt\nu', 3);
  check(capped.approximate === true, 'lineDiffCount: the cap is a parameter, and crossing it sets approximate');

  // ---- the fixture cell's register files are in the controller's real format ----
  // They used to be bare "[1] = 100" lines with no $NUMREG header, which parseNumReg skips
  // entirely: every test that leaned on them was reading an empty dataset.
  const cell = path.resolve(__dirname, '..', 'test', 'fixtures-cell', 'robotA');
  const snapReg = parseNumReg(fs.readFileSync(path.join(cell, ROBOT_DIR, 'snapshot', 'numreg.va'), 'latin1'));
  const backReg = parseNumReg(fs.readFileSync(path.join(cell, 'backups', 'numreg.va'), 'latin1'));
  check(snapReg.length === 2 && snapReg[0].value === 100 && snapReg[0].comment === 'FROM SNAPSHOT', `fixture: the snapshot's numreg.va parses (${JSON.stringify(snapReg)})`);
  check(backReg.length === 2 && backReg[0].value === 999 && backReg[0].comment === 'FROM BACKUP', `fixture: the backup's numreg.va parses, and says something different (${JSON.stringify(backReg)})`);

  // ---- 2. the swap cannot lose the old snapshot ----
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'robocode-harden-'));
  try {
    const snap = path.join(tmp, 'snapshot');
    fs.mkdirSync(snap); fs.writeFileSync(path.join(snap, 'old.txt'), 'OLD');
    const fresh = path.join(tmp, 'snapshot.tmp-1'); fs.mkdirSync(fresh); fs.writeFileSync(path.join(fresh, 'new.txt'), 'NEW');
    swapSnapshot(fresh, snap);
    check(fs.existsSync(path.join(snap, 'new.txt')) && !fs.existsSync(path.join(snap, 'old.txt')) && !fs.existsSync(fresh), 'swapSnapshot: the new snapshot is in place, the temp folder is gone');
    check(!fs.readdirSync(tmp).some(n => n.startsWith('snapshot.old-')), `swapSnapshot: nothing is left moved aside (${fs.readdirSync(tmp).join(', ')})`);
    // the failure that used to cost the snapshot: the new folder cannot be renamed into place
    let threw = false;
    try { swapSnapshot(path.join(tmp, 'does-not-exist'), snap); } catch { threw = true; }
    check(threw, 'swapSnapshot: a swap that cannot complete throws');
    check(fs.existsSync(path.join(snap, 'new.txt')), `swapSnapshot: ... and the snapshot that was there is STILL there (${fs.existsSync(snap) ? fs.readdirSync(snap).join(', ') : 'snapshot folder gone'})`);
    check(!fs.readdirSync(tmp).some(n => n.startsWith('snapshot.old-')), 'swapSnapshot: ... put back under its own name, not left as snapshot.old-*');
    // first snapshot ever: nothing to move aside
    const first = path.join(tmp, 'first'); const firstTmp = path.join(tmp, 'first.tmp'); fs.mkdirSync(firstTmp); fs.writeFileSync(path.join(firstTmp, 'a'), '1');
    swapSnapshot(firstTmp, first);
    check(fs.existsSync(path.join(first, 'a')), 'swapSnapshot: works when there is no snapshot yet');

    // ---- 3. the copy that does not block ----
    const src = path.join(tmp, 'backup'); fs.mkdirSync(path.join(src, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(src, 'a.ls'), 'A'); fs.writeFileSync(path.join(src, 'numreg.va'), 'V'); fs.writeFileSync(path.join(src, 'sub', 'b.kl'), 'B');
    const dest = path.join(tmp, 'robot', ROBOT_DIR, 'snapshot'); fs.mkdirSync(dest, { recursive: true }); fs.writeFileSync(path.join(dest, 'previous.txt'), 'P');
    const seen: string[] = [];
    let ticked = false; const timer = setInterval(() => { ticked = true; }, 0);
    const n = await copySnapshotAsync(src, dest, (count, name) => seen.push(`${count}:${name}`));
    clearInterval(timer);
    check(n === 3 && seen.length === 3 && seen[2].startsWith('3:'), `copySnapshotAsync: 3 files, progress reported for each (${seen.join(' ')})`);
    check(fs.readFileSync(path.join(dest, 'sub', 'b.kl'), 'utf8') === 'B' && !fs.existsSync(path.join(dest, 'previous.txt')), 'copySnapshotAsync: nested files copied, the previous snapshot replaced wholesale');
    check(ticked, 'copySnapshotAsync: the event loop ran during the copy - a timer fired, so VS Code would have stayed responsive');
    let failed = false;
    try { await copySnapshotAsync(path.join(tmp, 'no-such-backup'), dest); } catch { failed = true; }
    check(failed && fs.existsSync(path.join(dest, 'a.ls')), 'copySnapshotAsync: a failed copy throws and leaves the old snapshot untouched');
    check(!fs.readdirSync(path.dirname(dest)).some(x => x.startsWith('snapshot.tmp-')), `copySnapshotAsync: ... and cleans up its temp folder (${fs.readdirSync(path.dirname(dest)).join(', ')})`);

    // ---- 4. the .gitignore ----
    const robot = path.join(tmp, 'robotG');
    writeRobotGitignore(robot);
    const gi = path.join(robot, ROBOT_DIR, '.gitignore');
    const lines = () => fs.readFileSync(gi, 'utf8').split(/\r?\n/).filter(Boolean);
    check(ROBOT_GITIGNORE_LINES.every(l => lines().includes(l)) && lines().includes('snapshot.json'), `.gitignore: a new one keeps snapshot.json out WITH the snapshot it describes - it names a local path or the robot's address (${lines().join(' | ')})`);
    // a container made before the list grew, with a line of the user's own
    fs.writeFileSync(gi, 'snapshot/\n# mine\nnotes.txt');
    writeRobotGitignore(robot);
    check(lines().includes('notes.txt') && lines().includes('# mine') && lines().includes('snapshot.json') && lines().filter(l => l === 'snapshot/').length === 1, `.gitignore: an existing one keeps the user's lines and gains the missing ones, nothing doubled (${lines().join(' | ')})`);
    const before = fs.readFileSync(gi, 'utf8'); writeRobotGitignore(robot);
    check(fs.readFileSync(gi, 'utf8') === before, '.gitignore: running it again changes nothing');
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}
