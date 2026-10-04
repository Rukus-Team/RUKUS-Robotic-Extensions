// Puts robot-code-<version>.vsix where it is kept: a GitHub release on this repo, and the
// RUKUS repo on GitLab, which bundles it as Assets/VSCode/robot-code.vsix (LFS).
//
// The .vsix is deliberately not in THIS repo's history (see .gitignore): each one is
// ~650 KB and every version would sit there forever. GitHub keeps one per version as a
// release asset, traceable to its tag; RUKUS carries the current one because RUKUS is what
// installs it, and its git history is the record of which version each RUKUS build shipped.
//
//   node scripts/release.mjs                    the version in package.json, from HEAD
//   node scripts/release.mjs --version 0.12.3   an older build whose .vsix is still here (GitHub only makes sense)
//   node scripts/release.mjs --ref <commit>     where the tag goes when it cannot be inferred
//   node scripts/release.mjs --github-only | --rukus-only
//   node scripts/release.mjs --rukus <path>     the RUKUS checkout (default: ../Robotic Utility Kit)
//   node scripts/release.mjs --push-rukus       also push the RUKUS branch (default: commit only)
//   node scripts/release.mjs --dry-run          print every command, run none
//
// Needs `gh`, logged in. The GitHub project is read off the git remotes.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdtempSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as os from 'node:os';
import * as path from 'node:path';
import { compareIds, highestId, decodeId, restampDate } from './version-id.mjs';

const repo =path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const dryRun = flag('--dry-run');
const wantGitHub = !flag('--rukus-only');
const wantRukus = !flag('--github-only');
const rukusDir = path.resolve(repo, opt('--rukus') ?? path.join('..', 'Robotic Utility Kit'));

function fail(msg) { console.error(`release: ${msg}`); process.exit(1); }
function git(cwd, ...a) { return execFileSync('git', a, { cwd, encoding: 'utf8' }).trim(); }
function tryGit(cwd, ...a) { const r = spawnSync('git', a, { cwd, encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : undefined; }
function show(cmd, a) { return `${cmd} ${a.map(x => /[\s"#]/.test(x) ? JSON.stringify(x) : x).join(' ')}`; }
function run(cmd, a, { cwd = repo, quiet = false } = {}) {
  console.log(`> ${show(cmd, a)}${cwd !== repo ? `   (in ${cwd})` : ''}`);
  if (dryRun) return { status: 0, stdout: '' };
  const r = spawnSync(cmd, a, { cwd, encoding: 'utf8', stdio: quiet ? 'pipe' : ['ignore', 'inherit', 'inherit'] });
  if (r.error) fail(`${cmd} could not be started: ${r.error.message}`);
  return r;
}
function ok(cmd, a, o) { const r = run(cmd, a, o); if (r.status !== 0) fail(`${cmd} exited ${r.status}`); }
function exists(cmd, a, o = {}) { return run(cmd, a, { ...o, quiet: true }).status === 0; }

const pkg = JSON.parse(readFileSync(path.join(repo, 'package.json'), 'utf8'));
const version = opt('--version') ?? pkg.version;
const tag = `v${version}`;
const vsix = path.join(repo, `${pkg.name}-${version}.vsix`);
if (!existsSync(vsix)) fail(`${path.basename(vsix)} is not here - run "npm run package" first (or pick a version whose .vsix still exists).`);

// ---- GitHub project, off the remotes ---------------------------------------------------
let github;
for (const line of git(repo, 'remote', '-v').split('\n')) {
  const m = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/.exec(line);
  const p = m && /github\.com[/:]([^\s]+?)(?:\.git)?\/?$/.exec(m[2]);
  if (p && !github) github = { remote: m[1], project: p[1] };
}
if (wantGitHub && !github) fail('no remote on github.com');

// ---- the commit the tag points at ------------------------------------------------------
let ref = tryGit(repo, 'rev-parse', '--verify', '-q', `refs/tags/${tag}^{commit}`);
const tagExisted = !!ref;
if (wantGitHub && !ref) {
  ref = opt('--ref');
  if (!ref && version === pkg.version) {
    if (git(repo, 'status', '--porcelain')) fail('working tree is not clean - commit first, the tag has to name what was packaged');
    ref = 'HEAD';
  }
  if (!ref) ref = tryGit(repo, 'log', '--format=%H', '-n', '1', '--fixed-strings', '--grep', `${version}:`);
  if (!ref) fail(`cannot tell which commit is ${version} - pass --ref <commit>`);
  ref = git(repo, 'rev-parse', '--verify', `${ref}^{commit}`);
  // The commit really must carry this version, or the tag lies.
  const pkgAt = JSON.parse(git(repo, 'show', `${ref}:package.json`));
  if (pkgAt.version !== version) fail(`${ref.slice(0, 7)} has package.json version ${pkgAt.version}, not ${version}`);
}

// ---- the number must go UP -------------------------------------------------------------
// RUKUS only installs the extension it bundles when that one is NEWER than the one on the PC.
// A version id (YY.MT.DDIII, docs/VERSIONING.md) is ordered by month, then change type, then
// the day the work STARTED, then issue number - not by the day it ships - so work that started
// early and ships late comes out LOWER than something already released, and nothing would ever
// install it. A release (YY.M9.N) is above every working build of its month. Compared here
// against every released tag, numbers as numbers. Re-releasing a tag that already exists
// (a replaced asset, an older build by --version) is not a new number and is let through.
if (!tagExisted) {
  try { git(repo, 'fetch', '--tags', '--quiet'); } catch { /* offline: compare with the tags that are here */ }
  const released = (tryGit(repo, 'tag', '--list', 'v*') ?? '').split(/\r?\n/).filter(Boolean);
  const top = highestId(released);
  if (top && compareIds(version, top) <= 0) {
    const mine = decodeId(version);
    if (mine.ok && mine.form === 'release') {
      fail(`${version} is not higher than ${top}, which is already released. A release takes the next number of its month:\n    node scripts/version-id.mjs --release\n  then package and release that.`);
    }
    // the earliest date that actually lands above `top` - today is not always enough: two ids
    // with the same start day are ordered by issue number, and a release blocks its whole month
    const when = restampDate(mine.ok ? mine.issue : 0, top, new Date(), mine.ok ? mine.type : undefined);
    const iso = `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, '0')}-${String(when.getDate()).padStart(2, '0')}`;
    const isToday = when.toDateString() === new Date().toDateString();
    const topD = decodeId(top);
    const why = topD.ok && topD.form === 'release' ? `${top} is a release, and a release is above every working build of its month`
      : `a version id is ordered by month, change type, the day the work started, then issue number, so this happens when work that\n  started earlier (or the same day, with a lower issue number, or with a lower type) ships later`;
    fail(`${version} is not higher than ${top}, which is already released - RUKUS would never install it over that one.\n` +
      `  ${why}.\n` +
      `  Re-stamp it with ${isToday ? "today's date" : `${iso} - today is not enough`}, then package and release that:\n` +
      `    node scripts/version-id.mjs --start ${iso}${mine.ok && mine.type ? ` --type ${mine.type}` : ''}\n` +
      `  docs/VERSIONING.md, "When the release script says the version is not higher".`);
  }
  console.log(top ? `order check: ${version} is above ${top}, the highest released tag` : 'order check: no released tag to compare with');
}

// ---- notes from CHANGELOG.md -----------------------------------------------------------
const changelog = readFileSync(path.join(repo, 'CHANGELOG.md'), 'utf8').split(/\r?\n/);
let title = `Robot Code ${version}`;
let body = [];
{
  const start = changelog.findIndex(l => l.startsWith(`## ${version} `) || l === `## ${version}`);
  if (start >= 0) {
    const head = /^## \S+(?: - \S+)?(?: - (.+))?$/.exec(changelog[start]);
    if (head?.[1]) title += ` - ${head[1]}`;
    let end = changelog.findIndex((l, i) => i > start && l.startsWith('## '));
    if (end < 0) end = changelog.length;
    body = changelog.slice(start + 1, end);
    while (body.length && !body[0].trim()) body.shift();
    while (body.length && !body[body.length - 1].trim()) body.pop();
  } else {
    console.warn(`release: CHANGELOG.md has no "## ${version}" section - the release will just say so`);
    body = [`Build ${version}. No changelog entry.`];
  }
}
body.push('', `Install: \`code --install-extension ${path.basename(vsix)} --force\``);

console.log(`\n${title}\n  asset ${path.basename(vsix)}${wantGitHub ? `\n  tag ${tag} -> ${ref.slice(0, 7)}${tagExisted ? ' (existing tag)' : ''}` : ''}\n`);

// ---- GitHub: tag, push, release --------------------------------------------------------
if (wantGitHub) {
  if (!tagExisted) ok('git', ['tag', '-a', tag, '-m', title, ref]);
  ok('git', ['push', github.remote, 'main', `refs/tags/${tag}`]);
  const R = ['-R', github.project];
  if (exists('gh', ['release', 'view', tag, ...R])) {
    console.log(`GitHub release ${tag} exists - replacing the asset`);
    ok('gh', ['release', 'upload', tag, vsix, '--clobber', ...R]);
  } else {
    const notesFile = path.join(mkdtempSync(path.join(os.tmpdir(), 'robot-code-release-')), 'notes.md');
    writeFileSync(notesFile, body.join('\n') + '\n');
    ok('gh', ['release', 'create', tag, vsix, '--title', title, '--notes-file', notesFile, '--verify-tag', ...R]);
  }
}

// ---- RUKUS on GitLab: bundle and commit, by name ---------------------------------------
// `git add` names the one file on purpose. The RUKUS working tree usually holds an
// untracked 200 MB installer in Installer/Output/, and `git add -A` there once took it along.
if (wantRukus) {
  const target = path.join(rukusDir, 'Assets', 'VSCode', 'robot-code.vsix');
  if (!existsSync(path.join(rukusDir, '.git')) || !existsSync(path.dirname(target))) fail(`${rukusDir} is not the RUKUS checkout (no .git or no Assets/VSCode) - pass --rukus <path> or --github-only`);
  const rel = 'Assets/VSCode/robot-code.vsix';
  const same = existsSync(target) && readFileSync(target).equals(readFileSync(vsix));
  if (same && !tryGit(rukusDir, 'status', '--porcelain', '--', rel)) {
    console.log(`RUKUS already carries this exact ${path.basename(vsix)} (${rel}, committed) - nothing to do there.`);
  } else {
    if (tryGit(rukusDir, 'status', '--porcelain', '--', rel) && !same) fail(`${rel} in RUKUS has uncommitted changes that are not this build - sort that out first`);
    console.log(`> copy ${path.basename(vsix)} -> ${target}`);
    if (!dryRun) copyFileSync(vsix, target);
    ok('git', ['add', '--', rel], { cwd: rukusDir });
    if (tryGit(rukusDir, 'diff', '--cached', '--quiet', '--', rel) !== undefined) {
      console.log('RUKUS: staged file is identical to HEAD - nothing to commit.');
    } else {
      ok('git', ['commit', '-m', `Bundle Robot Code extension ${version}`, '--', rel], { cwd: rukusDir });
    }
    const branch = tryGit(rukusDir, 'branch', '--show-current') ?? '?';
    if (flag('--push-rukus')) ok('git', ['push', 'origin', branch], { cwd: rukusDir });
    else console.log(`RUKUS: committed on ${branch}, not pushed (add --push-rukus, or push it with the rest of that branch).`);
  }
}

console.log(`\nDone.${wantGitHub ? ` ${tag} is on GitHub with the .vsix attached.` : ''}${wantRukus ? ' RUKUS carries the .vsix in Assets/VSCode.' : ''}`);
