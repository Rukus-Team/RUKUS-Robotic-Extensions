// Downloads a VS Code build into the given cache folder (independent of the installed VS Code)
// and runs test/integration.js inside it against the given workspace.
//   node test/runIntegration.mjs <workspace> <cacheDir> [shotDir] [karelSample]
import { downloadAndUnzipVSCode, runTests } from '@vscode/test-electron';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startMockRobot } from './mockRobot.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
let [workspace, cacheDir, shotDir, karelSample] = process.argv.slice(2);
// Absolute, always: these are handed to a VS Code process whose cwd is its own install
// folder, so a relative path here lands somewhere nobody can find it.
if (cacheDir) cacheDir = path.resolve(cacheDir);
if (shotDir) shotDir = path.resolve(shotDir);
if (!workspace || !cacheDir) { console.error('usage: node test/runIntegration.mjs <workspace> <cacheDir> [shotDir] [karelSample]'); process.exit(2); }

// Mock controller serving the first backup folder found under the workspace
const findBackup = dir => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) { if (fs.existsSync(path.join(p, 'curpos.dg'))) return p; const r = findBackup(p); if (r) return r; } } return undefined; };
const backupDir = findBackup(path.resolve(workspace));
const MOCK_HTTP = 18080, MOCK_FTP = 18021;
const mock = backupDir ? startMockRobot(backupDir, MOCK_HTTP, MOCK_FTP, { runningProgram: 'ENTERZON', runningLine: 44 }) : undefined;
console.log(mock ? `mock robot on http://127.0.0.1:${MOCK_HTTP}/MD/ serving ${backupDir}` : 'no backup folder with curpos.dg found; live checks will be skipped');

fs.mkdirSync(cacheDir, { recursive: true });
const userDataDir = path.join(cacheDir, 'user-data');
const extensionsDir = path.join(cacheDir, 'extensions');
fs.mkdirSync(path.join(userDataDir, 'User'), { recursive: true });
fs.writeFileSync(path.join(userDataDir, 'User', 'settings.json'), JSON.stringify({
  'workbench.colorTheme': 'Robot Code Dark',
  'workbench.startupEditor': 'none',
  'window.newWindowDimensions': 'maximized',
  'window.restoreWindows': 'none',
  'security.workspace.trust.enabled': false,
  'update.mode': 'none',
  'telemetry.telemetryLevel': 'off',
  'extensions.ignoreRecommendations': true,
  'editor.inlayHints.enabled': 'on',
  'editor.fontSize': 15,
  'window.zoomLevel': 0.5,
  'editor.minimap.enabled': false,
  'workbench.tips.enabled': false,
  // the live tier is behind the experimental switch (26.99.1); the smoke drives it against the mock
  'robotCode.experimental.robotConnections': true,
  'robotCode.robots': mock ? [{ name: 'MOCK', host: '127.0.0.1', httpPort: MOCK_HTTP, ftpPort: MOCK_FTP, device: 'MD:', pollIntervalMs: 1000, autoConnect: true }] : [],
  // Pinned rather than left to the shipped default: the traffic checks are about what
  // connecting costs, so the test has to state what it asked for.
  'robotCode.live.fetchOnConnect': ['registers', 'io', 'files'],
  // The heartbeat is a timer that contacts the controller on its own; the "no requests while
  // idle" check below is about the extension not doing that, so it has to be off here.
  'robotCode.live.heartbeatSeconds': 0,
  // the fetch-on-open prompt would connect a controller on every open() in the test
  'robotCode.sync.promptOnOpen': false,
}, null, 2));

const vscodeExecutablePath = await downloadAndUnzipVSCode({ version: 'stable', cachePath: path.join(cacheDir, 'vscode') });
console.log('VS Code:', vscodeExecutablePath);

const out = path.join(cacheDir, 'integration.json');
try { fs.unlinkSync(out); } catch { /* none */ }
const code = await runTests({
  vscodeExecutablePath,
  extensionDevelopmentPath: repo,
  extensionTestsPath: path.join(here, 'integration.js'),
  launchArgs: [workspace, '--disable-extensions', '--disable-workspace-trust', '--user-data-dir', userDataDir, '--extensions-dir', extensionsDir],
  extensionTestsEnv: { ROBOT_CODE_TEST_OUT: out, ...(shotDir ? { ROBOT_CODE_SHOT_DIR: shotDir } : {}), ...(karelSample ? { ROBOT_CODE_KAREL_SAMPLE: karelSample } : {}), ...(mock ? { ROBOT_CODE_MOCK_ROBOT: 'MOCK' } : {}) },
}).catch(e => { console.error('runTests failed:', e?.message ?? e); return 1; });
if (mock) await mock.close();

if (fs.existsSync(out)) {
  const r = JSON.parse(fs.readFileSync(out, 'utf8'));
  for (const x of r) console.log((x.ok ? 'PASS' : 'FAIL').padEnd(5), x.name, x.ok ? '' : '=> ' + x.detail);
  console.log(`${r.filter(x => !x.ok).length} failed of ${r.length}`);
} else console.log('no results file written');
process.exit(code);
