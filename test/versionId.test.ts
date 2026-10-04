/**
 * Version ids, second form (2026-09-22): YY.MT.DDIII for a working build, YY.M9.N for a
 * release - one shape for RUKUS and the extension. Making, reading and ordering them. Pure,
 * no git, no disk. Wired in by test/run.ts: `run(check)`. The walkthrough is docs/VERSIONING.md.
 */
import { makeId, makeReleaseId, decodeId, compareIds, highestId, restampDate, nextReleaseNumber, typeFromBranch, typeFromWord, TYPE_NAMES } from '../scripts/version-id.mjs';

export function run(check: (cond: unknown, msg: string) => void): void {
  const d = (y: number, m: number, day: number) => new Date(y, m - 1, day);
  const throws = (f: () => unknown) => { try { f(); return false; } catch { return true; } };

  // ---- making ----
  check(makeId(10, d(2026, 9, 21), 1) === '26.91.21010', `issue #10, feature, started 21 Sep 2026 is 26.91.21010 (${makeId(10, d(2026, 9, 21), 1)})`);
  check(makeId(26, d(2026, 9, 13), 1) === '26.91.13026', `RUKUS's #26 is 26.91.13026 - the same shape (${makeId(26, d(2026, 9, 13), 1)})`);
  check(makeId(5, d(2026, 9, 19), 2) === '26.92.19005', `a bug fix: type 2 as the last digit of the second number (${makeId(5, d(2026, 9, 19), 2)})`);
  check(makeId(26, d(2026, 10, 5), 1) === '26.101.5026', `October: month 10 and type 1 give 101; a single-digit day has no leading zero (${makeId(26, d(2026, 10, 5), 1)})`);
  check(makeId(999, d(2026, 12, 31), 4) === '26.124.31999', `the largest: 124 and 31999, both inside Windows' 16 bits (${makeId(999, d(2026, 12, 31), 4)})`);
  check(makeReleaseId(2026, 9, 1) === '26.99.1' && makeReleaseId(2026, 10, 2) === '26.109.2' && makeReleaseId(2027, 1, 1) === '27.19.1', `releases: 26.99.1, 26.109.2, 27.19.1 (${makeReleaseId(2026, 9, 1)} ${makeReleaseId(2026, 10, 2)} ${makeReleaseId(2027, 1, 1)})`);
  check(throws(() => makeId(1000, d(2026, 9, 1), 1)), 'issue #1000 does not fit three digits and is refused');
  check(throws(() => makeId(0, d(2026, 9, 1), 1)) && throws(() => makeId(5, new Date('nope'), 1)), 'issue 0 and a non-date are refused');
  check(throws(() => makeId(5, d(2026, 9, 1), 7)) && throws(() => makeId(5, d(2026, 9, 1), 9)) && throws(() => makeId(5, d(2026, 9, 1), undefined as any)), 'a type not in the table, the release type, and no type at all are refused for a working build');
  check(throws(() => makeReleaseId(2026, 13, 1)) && throws(() => makeReleaseId(2026, 9, 0)), 'a release needs a real month and a number from 1');
  // every id this can make is valid semver, and every part fits 16 bits (RUKUS's cap)
  const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
  let bad = 0;
  for (const month of [1, 9, 10, 12]) for (const day of [1, 5, 9, 10, 28, 31]) for (const issue of [1, 9, 26, 100, 999]) for (const type of [1, 2, 3, 4]) {
    const id = makeId(issue, d(2026, month, day), type);
    if (!semver.test(id) || id.split('.').some(p => +p > 65535)) bad++;
  }
  for (const month of [1, 9, 12]) for (const n of [1, 9, 42, 999]) { const id = makeReleaseId(2026, month, n); if (!semver.test(id) || id.split('.').some(p => +p > 65535)) bad++; }
  check(bad === 0, `every id is valid semver and every part is under 65536 (${bad} were not)`);
  check(!semver.test('26.9.0102614'), 'the shape first proposed, 26.9.0102614, is NOT valid semver');
  check(typeFromBranch('fix/#5-smoke-findings') === 2 && typeFromBranch('feature/robocode-containers') === 1 && typeFromBranch('refact/#3-ux-qol') === 3 && typeFromBranch('docs/x') === 4 && typeFromBranch('Push/#26-x') === undefined, 'the type from the branch prefix, the same table as RUKUS\'s tool');
  check(typeFromWord('bug') === 2 && typeFromWord('3') === 3 && typeFromWord('release') === 9 && typeFromWord('nope') === undefined && typeFromWord('7') === undefined, 'the type from a word or a number');
  check(TYPE_NAMES[9] === 'release' && Object.keys(TYPE_NAMES).join(',') === '1,2,3,4,9', 'the type table: 1-4 and 9 for a release');

  // ---- reading ----
  const a = decodeId('26.91.21010');
  check(a.ok && a.form === 'work' && a.day === 21 && a.issue === 10 && a.month === 9 && a.year === 2026 && a.type === 1 && a.typeName === 'feature' && a.started === '21 September 2026', `decode 26.91.21010: ${JSON.stringify(a)}`);
  const b = decodeId('v26.101.5026');
  check(b.ok && b.form === 'work' && b.month === 10 && b.type === 1 && b.day === 5 && b.issue === 26, `decode v26.101.5026 (three-digit second number: month 10, type 1): ${JSON.stringify(b)}`);
  const r = decodeId('26.99.2');
  check(r.ok && r.form === 'release' && r.month === 9 && r.release === 2 && r.type === 9 && /release 2 of September 2026/.test(r.text), `decode a release: ${JSON.stringify(r)}`);
  const r2 = decodeId('26.109.1');
  check(r2.ok && r2.form === 'release' && r2.month === 10 && r2.release === 1, `decode 26.109.1: October's first release: ${JSON.stringify(r2)}`);
  const f1 = decodeId('26.9.19005'), f2 = decodeId('26.9.13026.1');
  check(f1.ok && f1.form === 'first' && f1.day === 19 && f1.issue === 5 && f1.type === undefined && f2.ok && f2.form === 'first' && f2.type === 1 && f2.typeName === 'feature', `the first form (YY.M.DDIII, and RUKUS's .T) still reads: ${JSON.stringify(f1)} ${JSON.stringify(f2)}`);
  const old = decodeId('26.9.1');
  check(!old.ok && /older YY\.M\.N/.test(old.why), `26.9.1 is recognised as the build-counter form: ${JSON.stringify(old)}`);
  check(!decodeId('0.12.16').ok && !decodeId('banana').ok && !decodeId('26.135.19005').ok && !decodeId('26.99.1001').ok && !decodeId('26.91.500').ok, '0.12.16, a non-version, month 13, a release number over 999 and a third number under 1001 are not ids');
  let rt = 0;
  for (const month of [1, 3, 10, 12]) for (const day of [1, 9, 17, 31]) for (const issue of [1, 42, 999]) for (const type of [1, 2, 3, 4]) { const x = decodeId(makeId(issue, d(2026, month, day), type)); if (!(x.ok && x.form === 'work' && x.day === day && x.issue === issue && x.month === month && x.type === type)) rt++; }
  check(rt === 0, `make -> decode gives back the same month, day, issue and type (${rt} did not)`);

  // ---- ordering: numbers as numbers, the way RUKUS compares ----
  const older = (x: string, y: string) => compareIds(x, y) < 0 && compareIds(y, x) > 0;
  check(older('26.9.21010', '26.91.21010') && older('26.9.13026.1', '26.91.13026') && older('26.9.1', '26.91.21010') && older('0.12.16', '26.91.21010'), 'every new id is newer than the first form, than 26.9.1 and than 0.12.16 - the builds already installed');
  check(older('26.91.18001', '26.91.19005'), 'same month and type: a later start day is newer');
  check(older('26.91.19005', '26.91.19007'), 'same start day: the higher issue number is newer');
  check(older('26.91.31999', '26.92.1001'), 'same month: a higher type is newer whatever the day (the type hazard, accepted)');
  check(older('26.91.21010', '26.99.1') && older('26.94.31999', '26.99.1'), 'a release is above every working build of its month');
  check(older('26.99.1', '26.99.2'), 'the second release of a month is above the first');
  check(older('26.99.2', '26.101.1001') && older('26.99.9', '26.109.1'), 'next month\'s first working build, and next month\'s release, are above this month\'s release');
  check(older('26.124.31999', '27.11.1001') && older('26.129.3', '27.11.1001'), 'a new year beats December\'s highest');
  check(older('26.91.5026', '26.91.13026'), 'day 5 (5026) is older than day 13 (13026) though it has fewer digits');
  check(compareIds('v26.91.21010', '26.91.21010') === 0 && compareIds('26.91.21010', '26.91.21010.0') === 0, 'a leading v and a missing fourth number do not make two versions differ');
  check(older('26.91.13026', '26.91.19005'), 'an id orders by start day, not ship day - the hazard release.mjs guards');
  check(highestId(['v0.12.16', 'v26.9.1', 'v26.9.19007', 'not-a-version', 'v26.91.21010', 'v26.91.18001']) === 'v26.91.21010', `highestId picks by number (${highestId(['v0.12.16', 'v26.9.1', 'v26.9.19007', 'not-a-version', 'v26.91.21010', 'v26.91.18001'])})`);
  check(highestId([]) === undefined && highestId(['latest']) === undefined, 'highestId of nothing usable is undefined');
  check(nextReleaseNumber(2026, 9, ['v26.99.1', 'v26.99.2', 'v26.91.21010', 'v26.109.1']) === 3 && nextReleaseNumber(2026, 10, ['v26.99.2']) === 1 && nextReleaseNumber(2026, 9, []) === 1, 'the next release number of a month comes from the released tags');

  // ---- re-stamping: the earliest start date that lands ABOVE what is already released ----
  const iso = (x: Date) => `${x.getFullYear()}-${x.getMonth() + 1}-${x.getDate()}`;
  check(iso(restampDate(1, '26.91.19005', d(2026, 9, 25), 1)) === '2026-9-25', 'the usual case: what is released started days ago, so today works');
  check(iso(restampDate(5, 'v26.91.19007', d(2026, 9, 19), 1)) === '2026-9-20', `#5 cannot follow #7 on the 19th - same day, lower issue number - so it is the 20th (${iso(restampDate(5, 'v26.91.19007', d(2026, 9, 19), 1))})`);
  check(iso(restampDate(9, 'v26.91.19007', d(2026, 9, 19), 1)) === '2026-9-19', 'a HIGHER issue number can share the day');
  check(iso(restampDate(5, '26.91.30007', d(2026, 9, 30), 1)) === '2026-10-1', 'the day after the 30th of September is the 1st of October');
  check(iso(restampDate(5, '26.99.1', d(2026, 9, 25), 1)) === '2026-10-1', 'nothing in September gets past September\'s release: the 1st of October');
  check(iso(restampDate(5, '26.92.19007', d(2026, 9, 25), 1)) === '2026-10-1' && iso(restampDate(5, '26.91.19007', d(2026, 9, 25), 2)) === '2026-9-25', 'a lower type is below the released one all month; a higher type is above it today');
  check(iso(restampDate(5, '26.9.1', d(2026, 9, 19), 1)) === '2026-9-19' && iso(restampDate(5, '26.9.19005.2', d(2026, 9, 19), 1)) === '2026-9-19', 'above the older forms, today is always enough');
  let miss = 0;
  const cases: Array<[number, string, Date, number]> = [[5, 'v26.91.19007', d(2026, 9, 19), 1], [9, 'v26.91.19007', d(2026, 9, 19), 1], [1, '26.91.19005', d(2026, 9, 25), 1], [5, '26.91.30007', d(2026, 9, 30), 1], [5, '26.124.31999', d(2026, 12, 31), 4], [5, '26.9.1', d(2026, 9, 19), 1], [7, '26.91.25003', d(2026, 9, 20), 1], [5, '26.99.1', d(2026, 9, 25), 1], [5, '26.92.19007', d(2026, 9, 25), 1], [5, '26.91.19007', d(2026, 9, 25), 2]];
  for (const [issue, top, today, type] of cases) if (!(compareIds(makeId(issue, restampDate(issue, top, today, type), type), top) > 0)) miss++;
  check(miss === 0, `the date restampDate gives always lands above the released id (${miss} of ${cases.length} did not)`);
}
