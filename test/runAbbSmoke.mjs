// ABB smoke: VS Code with robotCode.abb.enabled on, one real IRC5 backup from the abb-reference
// corpus as the workspace (opened read-only; the corpus is never copied into this repo).
//   node test/runAbbSmoke.mjs [cacheDir]       (npm run smoke:abb)
// Skips, with a note, when the corpus is not on this PC.
import { downloadAndUnzipVSCode, runTests } from '@vscode/test-electron';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startMockRws, findRwsCrawl } from './mockRws.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const corpus = process.env.RAPID_CORPUS ?? path.join(path.dirname(repo), 'abb-reference', 'backups', 'Backup_09_16_2023_Before');
if (!fs.existsSync(corpus)) { console.log(`ABB smoke skipped: no corpus at ${corpus} (set RAPID_CORPUS)`); process.exit(0); }
// the first backup with program modules in some task
const ws = fs.readdirSync(corpus).map(n => path.join(corpus, n))
  .find(b => fs.existsSync(path.join(b, 'RAPID')) && fs.readdirSync(path.join(b, 'RAPID')).some(t => { const p = path.join(b, 'RAPID', t, 'PROGMOD'); return fs.existsSync(p) && fs.readdirSync(p).some(f => /\.mod$/i.test(f)); }));
if (!ws) { console.log('ABB smoke skipped: no backup with program modules'); process.exit(0); }
console.log('workspace:', ws);

// a mock IRC5 answering from the real RWS crawl, for the ABB Controllers checks
const crawl = findRwsCrawl(repo);
const mock = crawl ? await startMockRws(crawl, 0, { user: 'Default User', password: 'robotics' }) : undefined;
console.log(mock ? `mock IRC5 on 127.0.0.1:${mock.port} answering from ${path.basename(crawl)}` : 'no RWS crawl found; ABB Controllers checks skipped');

const cacheRoot = path.resolve(process.argv[2] ?? path.join(repo, '.vscode-test'));
const scratch = path.join(cacheRoot, 'abb-smoke');
const user = path.join(scratch, 'user-data'), exts = path.join(scratch, 'extensions');
fs.mkdirSync(path.join(user, 'User'), { recursive: true });
// real controllers, opt-in: ROBOT_CODE_ABB_LIVE="OMNI=127.0.0.1:5466:omnicore,IRC5=127.0.0.1:80:irc5"
// (RobotStudio VCs; factory password "robotics"). Reads, a module, and one Back Up and Download each.
// ROBOT_CODE_ABB_LIVE_ACTIONS=1 also runs the Actions on them: THE ROBOT MOVES; every setting is put back.
const live = (process.env.ROBOT_CODE_ABB_LIVE ?? '').split(',').map(s => s.trim()).filter(Boolean).map(s => {
  const [name, rest] = s.split('=');
  const [host, port, family] = rest.split(':');
  return { name, host, port: Number(port), ...(family === 'omnicore' ? { family, https: true } : {}) };
});
if (live.length) console.log('live controllers:', live.map(l => `${l.name} ${l.host}:${l.port} ${l.family ?? 'irc5'}`).join(', '));
fs.writeFileSync(path.join(user, 'User', 'settings.json'), JSON.stringify({
  'workbench.startupEditor': 'none', 'security.workspace.trust.enabled': false, 'update.mode': 'none',
  'telemetry.telemetryLevel': 'off', 'window.restoreWindows': 'none',
  // robotCode.abb.enabled is NOT set: ABB has to load by itself because the workspace holds ABB backups
  'robotCode.abb.controllers': [...(mock ? [{ name: 'MOCK', host: '127.0.0.1', port: mock.port }, { name: 'BADPW', host: '127.0.0.1', port: mock.port }] : []), ...live],
  // the corpus is real controller data: never let the test write anything into it
  'files.readonlyInclude': { '**': true },
}));

const exe = await downloadAndUnzipVSCode({ version: 'stable', cachePath: path.join(cacheRoot, 'vscode') });
const out = path.join(scratch, 'results.json');
try { fs.unlinkSync(out); } catch { /* none */ }
const code = await runTests({
  vscodeExecutablePath: exe,
  extensionDevelopmentPath: repo,
  extensionTestsPath: path.join(repo, 'test', 'integrationAbb.js'),
  launchArgs: [ws, '--disable-extensions', '--disable-workspace-trust', '--user-data-dir', user, '--extensions-dir', exts],
  extensionTestsEnv: { ROBOT_CODE_TEST_OUT: out, ...(mock ? { ROBOT_CODE_ABB_MOCK: 'MOCK' } : {}), ...(live.length ? { ROBOT_CODE_ABB_LIVE_NAMES: live.map(l => `${l.name}:${l.family ?? 'irc5'}`).join(',') } : {}), ...(live.length && process.env.ROBOT_CODE_ABB_LIVE_ACTIONS === '1' ? { ROBOT_CODE_ABB_LIVE_ACTIONS: '1' } : {}) },
}).catch(e => { console.error('runTests failed:', e?.message ?? e); return 1; });

if (fs.existsSync(out)) {
  const r = JSON.parse(fs.readFileSync(out, 'utf8'));
  if (mock) {
    // what the controller saw, from its side
    r.push({ name: 'controller side: nothing reached the controller but reads, calculations and the backup the test asked for', ok: mock.stats.actions === 0, detail: `${mock.stats.actions} refused` });
    r.push({ name: 'controller side: every session was given back (logout)', ok: mock.stats.sessionsOpen() === 0, detail: `${mock.stats.sessionsOpen()} still open after ${mock.stats.logins} logins, ${mock.stats.requests} requests` });
    await mock.close();
  }
  for (const x of r) console.log((x.ok ? 'PASS' : 'FAIL').padEnd(5), x.name, x.ok ? (x.detail ? `  (${x.detail})` : '') : '\n        => ' + x.detail);
  console.log(`${r.filter(x => !x.ok).length} failed of ${r.length}`);
} else console.log('no results file written');
process.exit(code);
