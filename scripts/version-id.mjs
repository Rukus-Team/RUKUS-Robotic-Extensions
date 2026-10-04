// Version ids, second form (since 2026-09-22). One shape for RUKUS and this extension: three
// numbers, every one under 65536, and two kinds of build that live on the same number line:
//
//   a working build     YY . MT . DDIII        26.91.21010
//                        |    |    +---------- DDIII  start day 21, issue #010 (split off the LAST THREE digits)
//                        |    +--------------- MT     month 9, type 1 (the LAST digit is the type, the rest the month)
//                        +-------------------- YY     2026
//
//   a release           YY . M9 . N            26.99.1
//                                              September's first release; 26.99.2 the second
//
// Change types: 1 feature, 2 bug fix, 3 maintenance, 4 docs, and 9 for a release. A release's
// type digit is 9 so that it sorts ABOVE every working build of its month (26.99 > 26.91..94),
// and next month's working builds sort above it (26.101 > 26.99). Updaters only offer a higher
// number; this is what makes them offer the release to someone on a dev build, and the next
// month's dev build to someone on the release.
//
// The first form (2026-09-19 to 09-22) was YY.M.DDIII with RUKUS carrying the type as a fourth
// number (26.9.21010 / 26.9.13026.1). `--decode` still reads those, and the older YY.M.N build
// counter (26.9.1) and 0.x before it. The shape first proposed, 26.9.0102614, is not valid
// semver (leading zero) and 102614 is over 65535; year.type.issue+day sorts by type, not date,
// and a release written as .0 would sit below every dev build - see docs/VERSIONING.md.
//
//   node scripts/version-id.mjs                       the id for the branch you are on, written to package.json
//   node scripts/version-id.mjs --show                print it, write nothing
//   node scripts/version-id.mjs --type bug            the change type (else from the branch prefix: feature/ fix/ refact/ docs/ ...)
//   node scripts/version-id.mjs --issue 5 --start 2026-09-19    say it yourself (either one alone overrides just that)
//   node scripts/version-id.mjs --release             this month's next release id (from the released tags), written
//   node scripts/version-id.mjs --release 2           release number 2 of this month
//   node scripts/version-id.mjs --decode 26.91.21010  read one back in words
//
// The issue comes from the #NN in the branch name (fix/#5-smoke-findings). The start date is
// the date of the first commit on this branch that main does not have. The walkthrough is
// docs/VERSIONING.md. scripts/release.mjs refuses a version that is not higher than every
// released tag, since a working build's order follows its START day, not its ship day.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as path from 'node:path';

export const TYPE_NAMES = { 1: 'feature', 2: 'bug fix', 3: 'maintenance', 4: 'docs', 9: 'release' };
export const RELEASE_TYPE = 9;
/** what a branch prefix means, the same table as Tools\version-id.ps1 in the RUKUS repo */
export const TYPE_WORDS = {
  feature: 1, feat: 1,
  bug: 2, bugfix: 2, fix: 2, hotfix: 2,
  maintenance: 3, maint: 3, refactor: 3, refact: 3, chore: 3, build: 3, ci: 3, tools: 3,
  docs: 4, doc: 4,
  release: 9,
};
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** the id of a working build: issue, the date its work started, the change type (1-4) */
export function makeId(issue, start, type) {
  if (!Number.isInteger(issue) || issue < 1) throw new Error(`issue ${issue} is not an issue number`);
  if (issue > 999) throw new Error(`issue #${issue} does not fit the three digits the id has for it`);
  if (!(start instanceof Date) || Number.isNaN(start.getTime())) throw new Error('the start date is not a date');
  if (!TYPE_NAMES[type] || type === RELEASE_TYPE) throw new Error(`change type ${type} is not one of: ${Object.entries(TYPE_NAMES).filter(([k]) => +k !== RELEASE_TYPE).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  return `${start.getFullYear() % 100}.${start.getMonth() + 1}${type}.${start.getDate() * 1000 + issue}`;
}

/** the id of a release: the n-th release of that month (1, 2, ...) */
export function makeReleaseId(year, month, n) {
  if (!Number.isInteger(year) || year < 2026 || !Number.isInteger(month) || month < 1 || month > 12) throw new Error('a release id needs a year and a month');
  if (!Number.isInteger(n) || n < 1 || n > 999) throw new Error(`release number ${n} is not 1..999`);
  return `${year % 100}.${month}${RELEASE_TYPE}.${n}`;
}

/** the type word for a branch name's prefix (`fix/#5-x` -> 2), or undefined */
export function typeFromBranch(branch) {
  const prefix = String(branch ?? '').split(/[/\-_#]/)[0].toLowerCase();
  return TYPE_WORDS[prefix];
}

/** the type: a number or a word from the table; undefined when it is neither */
export function typeFromWord(word) {
  const w = String(word ?? '').trim().toLowerCase();
  if (/^\d+$/.test(w)) return TYPE_NAMES[+w] ? +w : undefined;
  return TYPE_WORDS[w];
}

/**
 * What an id says, or why it is not one. Reads the current form (working build and release),
 * the first form (YY.M.DDIII, with or without RUKUS's fourth number) and the older ones.
 */
export function decodeId(text) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:\.(\d+))?$/.exec(String(text).trim());
  if (!m) return { ok: false, why: `'${text}' is not a version id - expected YY.MT.DDIII (26.91.21010) or a release YY.M9.N (26.99.1)` };
  const [yy, second, third] = [+m[1], +m[2], +m[3]];
  const fourth = m[4] === undefined ? undefined : +m[4];
  const year = 2000 + yy;
  if (yy < 26) return { ok: false, why: 'from before date versions (0.x)' };
  // the current form: the second number is month and type run together (two or three digits)
  if (second >= 11 && fourth === undefined) {
    const type = second % 10, month = Math.floor(second / 10);
    if (month >= 1 && month <= 12) {
      if (type === RELEASE_TYPE) {
        if (third >= 1 && third <= 999) return { ok: true, form: 'release', year, month, release: third, type, typeName: TYPE_NAMES[type], text: `release ${third} of ${MONTHS[month - 1]} ${year}` };
        return { ok: false, why: `${text} reads as a release of ${MONTHS[month - 1]} ${year}, but ${third} is not a release number (1..999)` };
      }
      if (TYPE_NAMES[type]) {
        const day = Math.floor(third / 1000), issue = third % 1000;
        if (day >= 1 && day <= 31 && issue >= 1) return { ok: true, form: 'work', year, month, day, issue, type, typeName: TYPE_NAMES[type], started: `${day} ${MONTHS[month - 1]} ${year}`, text: `${TYPE_NAMES[type]}, issue #${issue}, started ${day} ${MONTHS[month - 1]} ${year}` };
        return { ok: false, why: `${text}: the third number should be day*1000+issue (1001..31999)` };
      }
    }
  }
  // the first form, 2026-09-19 to 09-22: YY.M.DDIII, RUKUS's with .T
  if (second >= 1 && second <= 12) {
    const day = Math.floor(third / 1000), issue = third % 1000;
    if (day >= 1 && day <= 31 && issue >= 1) {
      return { ok: true, form: 'first', year, month: second, day, issue, type: fourth, typeName: fourth === undefined ? undefined : (TYPE_NAMES[fourth] ?? 'unknown type'), started: `${day} ${MONTHS[second - 1]} ${year}`, text: `first form (YY.M.DDIII): issue #${issue}, started ${day} ${MONTHS[second - 1]} ${year}${fourth !== undefined ? `, ${TYPE_NAMES[fourth] ?? 'unknown type'}` : ''}` };
    }
    if (third < 1000) return { ok: false, why: `the older YY.M.N form: build ${third} of ${MONTHS[second - 1]} ${year}` };
  }
  return { ok: false, why: `${text} is not in the YY.MT.DDIII or YY.M9.N form` };
}

/** negative when a is older; numbers as numbers, a missing part is 0 - the way RUKUS compares */
export function compareIds(a, b) {
  const parts = v => String(v).trim().replace(/^v/i, '').split(/[-+]/)[0].split('.').map(n => parseInt(n, 10) || 0);
  const pa = parts(a), pb = parts(b);
  for (let i = 0; i < 4; i++) { const d = (pa[i] ?? 0) - (pb[i] ?? 0); if (d) return d; }
  return 0;
}

/** the highest of a list of versions or tags; undefined for an empty list */
export function highestId(list) {
  return list.filter(t => /^v?\d+(\.\d+){0,3}([-+].*)?$/.test(String(t).trim())).reduce((best, t) => (best === undefined || compareIds(t, best) > 0 ? t : best), undefined);
}

/** the next release number for `year`/`month` given the tags already released (1 when none) */
export function nextReleaseNumber(year, month, released) {
  let n = 0;
  for (const t of released) { const d = decodeId(t); if (d.ok && d.form === 'release' && d.year === year && d.month === month && d.release > n) n = d.release; }
  return n + 1;
}

/**
 * The earliest start date that puts a working build of `issue` and `type` ABOVE the released
 * id `top`: today, unless `top` started today or later. Same month and type: two ids with the
 * same start day are ordered by issue number, so the same day only works for a HIGHER issue
 * number - otherwise the day after. A release of this month (26.99.n) is above every working
 * build of it, so the only way past it is NEXT month's first day. A lower type than `top`'s in
 * the same month is below it whatever the day - also next month.
 */
export function restampDate(issue, top, today = new Date(), type) {
  let when = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const d = decodeId(top);
  if (!d.ok || d.form === 'first') return when;   // every second-form id is above the first form and the older ones
  if (d.form === 'release') { const need = new Date(d.year, d.month, 1); return need > when ? need : when; }   // the 1st of the month after
  if (d.form === 'work' && type !== undefined && type !== d.type) {
    if (type > d.type) return when;                              // a higher type sorts above whatever the day
    const need = new Date(d.year, d.month, 1); return need > when ? need : when;
  }
  const need = new Date(d.year, d.month - 1, d.day + (issue > d.issue ? 0 : 1));   // Date rolls a day 32 into the next month
  if (need > when) when = need;
  return when;
}

// ---- command line ---------------------------------------------------------------------------
const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const args = process.argv.slice(2);
  const opt = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const has = name => args.includes(name);
  const fail = msg => { console.error(`version-id: ${msg}`); process.exit(1); };
  const git = (...a) => { try { return execFileSync('git', a, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };

  const toDecode = opt('--decode');
  if (toDecode) {
    const d = decodeId(toDecode);
    if (!d.ok) { console.log(`${toDecode}: ${d.why}`); process.exit(0); }
    if (d.form === 'release') console.log(`\n  ${toDecode}\n    ${d.text}\n`);
    else console.log(`\n  ${toDecode}${d.form === 'first' ? '   (first form, before 2026-09-22)' : ''}\n    started ${d.started}\n    issue   #${d.issue}\n    type    ${d.type === undefined ? '(none in this form)' : `${d.type} ${d.typeName}`}\n`);
    process.exit(0);
  }

  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  let id, lines;

  if (has('--release')) {
    const now = new Date();
    const given = opt('--release');
    let n;
    if (given && /^\d+$/.test(given)) n = parseInt(given, 10);
    else {
      try { git('fetch', '--tags', '--quiet'); } catch { /* offline: the tags that are here */ }
      n = nextReleaseNumber(now.getFullYear(), now.getMonth() + 1, git('tag', '--list', 'v*').split(/\r?\n/).filter(Boolean));
    }
    try { id = makeReleaseId(now.getFullYear(), now.getMonth() + 1, n); } catch (e) { fail(e.message); }
    lines = [`release  ${n} of ${MONTHS[now.getMonth()]} ${now.getFullYear()}${given ? '' : '   (the released tags say the last one was ' + (n - 1) + ')'}`];
  } else {
    let issue = opt('--issue') ? parseInt(opt('--issue'), 10) : parseInt(/#(\d+)/.exec(branch)?.[1] ?? '', 10);
    if (!Number.isInteger(issue)) fail(`no issue number - the branch '${branch}' has no #NN in its name, so pass --issue <number>. Every version belongs to an issue.`);
    const typeList = Object.entries(TYPE_NAMES).filter(([k]) => +k !== RELEASE_TYPE).map(([k, v]) => `${v} (${k})`).join(', ');
    let type;
    if (opt('--type')) { type = typeFromWord(opt('--type')); if (type === undefined || type === RELEASE_TYPE) fail(`'${opt('--type')}' is not a change type. Use one of: ${typeList}${type === RELEASE_TYPE ? ' - for a release use --release' : ''}.`); }
    else { type = typeFromBranch(branch); if (type === undefined || type === RELEASE_TYPE) fail(`cannot tell the change type from the branch name '${branch}'. Pass --type: ${typeList}.`); }

    let start, from;
    if (opt('--start')) {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(opt('--start'));
      if (!m) fail(`'${opt('--start')}' is not a date - use yyyy-mm-dd, like 2026-09-19`);
      start = new Date(+m[1], +m[2] - 1, +m[3]); from = 'given';
      if (start.getMonth() !== +m[2] - 1) fail(`'${opt('--start')}' is not a real date`);
    } else {
      const base = opt('--base') ?? 'origin/main';
      const first = git('log', '--reverse', '--format=%ad', '--date=short', `${base}..HEAD`).split(/\r?\n/)[0];
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(first);
      if (m) { start = new Date(+m[1], +m[2] - 1, +m[3]); from = `the first commit on '${branch}' that ${base} does not have`; }
      else { const n = new Date(); start = new Date(n.getFullYear(), n.getMonth(), n.getDate()); from = 'today - this branch has no commits of its own yet'; }
    }
    try { id = makeId(issue, start, type); } catch (e) { fail(e.message); }
    const iso = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`;
    lines = [`started  ${iso}   (${from})`, `issue    #${issue}`, `type     ${type} ${TYPE_NAMES[type]}`];
  }

  console.log(`\n  ${id}\n${lines.map(l => `    ${l}`).join('\n')}\n`);
  if (has('--show')) process.exit(0);

  const pkgPath = path.join(repo, 'package.json');
  const raw = readFileSync(pkgPath, 'utf8');
  const was = JSON.parse(raw).version;
  if (was === id) { console.log(`  package.json is already ${id}\n`); process.exit(0); }
  // replace the one line, so the file keeps its formatting and line endings
  const next = raw.replace(/("version"\s*:\s*")[^"]+(")/, `$1${id}$2`);
  if (next === raw) fail('could not find the "version" line in package.json');
  writeFileSync(pkgPath, next);
  console.log(`  package.json: ${was} -> ${id}\n  Next: a "## ${id} - <date> - <title>" section in CHANGELOG.md, then npm run package.\n`);
}
