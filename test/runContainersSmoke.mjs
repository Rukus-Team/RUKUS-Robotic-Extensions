// Containers smoke test launcher: copies test/fixtures-cell into the cache folder (so snapshots and
// robot.json edits never touch the fixtures), adds a program to the excluded backups folder, and
// runs test/integrationContainers.js
// inside a downloaded VS Code.   node test/runContainersSmoke.mjs [cacheDir]
import { downloadAndUnzipVSCode, runTests } from '@vscode/test-electron';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { execSync } from 'node:child_process';

import { fileURLToPath } from 'node:url';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cacheRoot = path.resolve(process.argv[2] ?? path.join(repo, '.vscode-test'));
const scratch = path.join(cacheRoot, 'containers-smoke');
fs.mkdirSync(scratch, { recursive: true });
const ws = path.join(scratch, 'cell');
fs.rmSync(ws, { recursive: true, force: true });
fs.cpSync(path.join(repo, 'test', 'fixtures-cell'), ws, { recursive: true });
// a program inside the excluded backups folder: it must never be indexed
fs.copyFileSync(path.join(ws, 'robotA', 'LS', 'PROGA.LS'), path.join(ws, 'robotA', 'backups', 'OLDCOPY.LS'));
// The wizard marks .robocode-robot hidden on Windows (writeRobotJson -> hideDir). fs.cpSync does
// not preserve that, so reproduce it: a container the wizard made must behave the same here.
if (process.platform === 'win32') {
  for (const r of ['robotA', 'robotB']) {
    const d = path.join(ws, r, '.robocode-robot');
    if (fs.existsSync(d)) { try { execSync(`attrib +h "${d}"`); } catch { /* best effort */ } }
  }
}

const cache = cacheRoot;
const user = path.join(scratch, 'user-data');
const exts = path.join(scratch, 'extensions');
fs.mkdirSync(path.join(user, 'User'), { recursive: true });
fs.writeFileSync(path.join(user, 'User', 'settings.json'), JSON.stringify({
  'workbench.startupEditor': 'none', 'security.workspace.trust.enabled': false, 'update.mode': 'none',
  'telemetry.telemetryLevel': 'off', 'window.restoreWindows': 'none',
  // the fetch-on-open prompt would try to connect a controller on every open() in the test
  'robotCode.sync.promptOnOpen': false,
}));

const exe = await downloadAndUnzipVSCode({ version: 'stable', cachePath: path.join(cache, 'vscode') });
const out = path.join(scratch, 'results.json');
try { fs.unlinkSync(out); } catch { /* none */ }
const code = await runTests({
  vscodeExecutablePath: exe,
  extensionDevelopmentPath: repo,
  extensionTestsPath: path.join(repo, 'test', 'integrationContainers.js'),
  launchArgs: [ws, '--disable-extensions', '--disable-workspace-trust', '--user-data-dir', user, '--extensions-dir', exts],
  extensionTestsEnv: { ROBOT_CODE_TEST_OUT: out },
}).catch(e => { console.error('runTests failed:', e?.message ?? e); return 1; });

if (fs.existsSync(out)) {
  const r = JSON.parse(fs.readFileSync(out, 'utf8'));
  for (const x of r) console.log((x.ok ? 'PASS' : 'FAIL').padEnd(5), x.name, x.ok ? '' : '\n        => ' + x.detail);
  console.log(`${r.filter(x => !x.ok).length} failed of ${r.length}`);
} else console.log('no results file written');
process.exit(code);
