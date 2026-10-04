// Live sync test against a REAL (virtual) controller - opt-in, never part of `npm test`/smoke.
// Builds a one-robot cell in the cache folder bound to <host>, then runs test/integrationLiveSync.js
// inside a downloaded VS Code. The test only writes its own program (RCPUSHT) and deletes it after.
//   node test/runLiveSync.mjs <host> [cacheDir]        e.g.  npm run smoke:live -- 127.0.0.2
import { downloadAndUnzipVSCode, runTests } from '@vscode/test-electron';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const host = process.argv[2];
if (!host) { console.error('usage: node test/runLiveSync.mjs <controller host> [cacheDir]'); process.exit(2); }
const cacheRoot = path.resolve(process.argv[3] ?? path.join(repo, '.vscode-test'));
const scratch = path.join(cacheRoot, 'live-sync');
const ws = path.join(scratch, 'cell');
fs.rmSync(ws, { recursive: true, force: true });
fs.mkdirSync(path.join(ws, '.robocode-cell'), { recursive: true });
// DEAD is TEST-NET-1 (192.0.2.1), which never answers - ROBOGUIDE answers on every 127.x address
fs.writeFileSync(path.join(ws, '.robocode-cell', 'cell.json'), JSON.stringify({ name: 'Live Cell', controllers: { LIVE: { host, device: 'MD:' }, DEAD: { host: '192.0.2.1', device: 'MD:' } } }, null, 2));
fs.mkdirSync(path.join(ws, 'live', '.robocode-robot'), { recursive: true });
fs.mkdirSync(path.join(ws, 'live', 'LS'), { recursive: true });
fs.writeFileSync(path.join(ws, 'live', '.robocode-robot', 'robot.json'), JSON.stringify({ name: 'LIVE', programs: ['LS'], controller: 'LIVE' }));
// a second robot bound to an address nothing answers on, for the unreachable-robot message
fs.mkdirSync(path.join(ws, 'dead', '.robocode-robot'), { recursive: true });
fs.writeFileSync(path.join(ws, 'dead', '.robocode-robot', 'robot.json'), JSON.stringify({ name: 'DEAD', controller: 'DEAD' }));

const user = path.join(scratch, 'user-data');
const exts = path.join(scratch, 'extensions');
fs.rmSync(user, { recursive: true, force: true });
fs.mkdirSync(path.join(user, 'User'), { recursive: true });
fs.writeFileSync(path.join(user, 'User', 'settings.json'), JSON.stringify({
  'workbench.startupEditor': 'none', 'security.workspace.trust.enabled': false, 'update.mode': 'none',
  'telemetry.telemetryLevel': 'off', 'window.restoreWindows': 'none',
  'robotCode.experimental.robotConnections': true,
  'robotCode.sync.promptOnOpen': false,
}));

const exe = await downloadAndUnzipVSCode({ version: 'stable', cachePath: path.join(cacheRoot, 'vscode') });
const out = path.join(scratch, 'results.json');
try { fs.unlinkSync(out); } catch { /* none */ }
const code = await runTests({
  vscodeExecutablePath: exe,
  extensionDevelopmentPath: repo,
  extensionTestsPath: path.join(repo, 'test', 'integrationLiveSync.js'),
  launchArgs: [ws, '--disable-extensions', '--disable-workspace-trust', '--user-data-dir', user, '--extensions-dir', exts],
  extensionTestsEnv: { ROBOT_CODE_TEST_OUT: out, ROBOT_CODE_LIVE_HOST: host, ...(process.env.ROBOT_CODE_SHOT_DIR ? { ROBOT_CODE_SHOT_DIR: path.resolve(process.env.ROBOT_CODE_SHOT_DIR) } : {}) },
}).catch(e => { console.error('runTests failed:', e?.message ?? e); return 1; });

if (fs.existsSync(out)) {
  const r = JSON.parse(fs.readFileSync(out, 'utf8'));
  for (const x of r) console.log((x.ok ? 'PASS' : 'FAIL').padEnd(5), x.name, x.detail && (!x.ok || x.note) ? '\n        => ' + x.detail : '');
  console.log(`${r.filter(x => !x.ok).length} failed of ${r.length}`);
} else console.log('no results file written');
process.exit(code);
