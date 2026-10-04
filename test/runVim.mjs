// Robot Code next to the Vim extension (issue #19): installs vscodevim.vim into a profile of its own
// (the regular smoke runs stay Vim-free), then runs test/integrationVim.js - a keyboard-shortcut
// clash report and auto-renumber driven by real Vim keystrokes (o, dd, p, ., u).
//   node test/runVim.mjs [cacheDir]        (default .vscode-test; the VS Code build is shared)
import { downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath, runTests } from '@vscode/test-electron';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const cacheDir = path.resolve(process.argv[2] ?? path.join(repo, '.vscode-test'));
const userDataDir = path.join(cacheDir, 'vim-user-data');
const extensionsDir = path.join(cacheDir, 'vim-extensions');
fs.mkdirSync(path.join(userDataDir, 'User'), { recursive: true });
// Vim keeps its registers here and fails to start without the folder
fs.mkdirSync(path.join(userDataDir, 'User', 'globalStorage', 'vscodevim.vim'), { recursive: true });
fs.writeFileSync(path.join(userDataDir, 'User', 'settings.json'), JSON.stringify({
  'workbench.startupEditor': 'none', 'window.restoreWindows': 'none', 'security.workspace.trust.enabled': false,
  'update.mode': 'none', 'telemetry.telemetryLevel': 'off', 'extensions.ignoreRecommendations': true,
  'robotCode.tp.autoRenumber': true,
  // Vim's own undo history does not know about edits other extensions make (the renumber), so u
  // only took the renumber back and it came straight back again; VS Code's undo treats the edit and
  // the renumber as one step. This is the setting docs/KEYBOARD-AND-VIM.md recommends (#19).
  'vim.normalModeKeyBindingsNonRecursive': [{ before: ['u'], commands: ['undo'] }, { before: ['<C-r>'], commands: ['redo'] }],
}, null, 2));

const vscodeExecutablePath = await downloadAndUnzipVSCode({ version: 'stable', cachePath: path.join(cacheDir, 'vscode') });
if (!fs.existsSync(extensionsDir) || !fs.readdirSync(extensionsDir).some(d => /^vscodevim\.vim-/i.test(d))) {
  // Only the CLI itself: the helper's own --extensions-dir/--user-data-dir are the REGULAR smoke
  // profile's. On Windows it is a .cmd, which needs a shell - so every path is quoted.
  const [cli] = resolveCliArgsFromVSCodeExecutablePath(vscodeExecutablePath);
  const q = s => `"${s}"`;
  const r = spawnSync(`${q(cli)} --extensions-dir ${q(extensionsDir)} --user-data-dir ${q(userDataDir)} --install-extension vscodevim.vim`, { encoding: 'utf8', shell: true });
  console.log((r.stdout || '') + (r.stderr || ''));
  if (r.status !== 0) { console.error('could not install vscodevim.vim'); process.exit(1); }
}

// a scratch workspace with one TP program; the test edits it
const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-vim-'));
fs.writeFileSync(path.join(ws, 'VIMTEST.LS'), ['/PROG  VIMTEST', '/ATTR', 'OWNER\t\t= MNEDITOR;', 'LINE_COUNT\t= 4;', '/MN',
  '   1:  R[1]=1 ;', '   2:  R[2]=2 ;', '   3:  R[3]=3 ;', '   4:  R[4]=4 ;', '/POS', '/END', ''].join('\r\n'));

const out = path.join(cacheDir, 'vim.json');
try { fs.unlinkSync(out); } catch { /* none */ }
const code = await runTests({
  vscodeExecutablePath,
  extensionDevelopmentPath: repo,
  extensionTestsPath: path.join(here, 'integrationVim.js'),
  launchArgs: [ws, '--disable-workspace-trust', '--user-data-dir', userDataDir, '--extensions-dir', extensionsDir],
  extensionTestsEnv: { ROBOT_CODE_TEST_OUT: out, ROBOT_CODE_VIM_FILE: path.join(ws, 'VIMTEST.LS') },
}).catch(e => { console.error('runTests failed:', e?.message ?? e); return 1; });
fs.rmSync(ws, { recursive: true, force: true });
if (fs.existsSync(out)) {
  const r = JSON.parse(fs.readFileSync(out, 'utf8'));
  for (const x of r) console.log((x.ok ? 'PASS' : x.info ? 'INFO' : 'FAIL').padEnd(5), x.name, x.detail ? '=> ' + x.detail : '');
  console.log(`${r.filter(x => !x.ok && !x.info).length} failed of ${r.filter(x => !x.info).length}`);
} else console.log('no results file written');
process.exit(code);
