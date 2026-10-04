/**
 * Test a new build locally, without the debugger or the F5 preLaunchTask.
 *
 * `npm run dev` builds `dist/` and opens an Extension Development Host on a workspace:
 *   - the last workspace you passed (remembered in .vscode-test/dev-workspace.txt), else
 *   - a freshly copied test/fixtures-cell at .vscode-test/debug-cell.
 * `npm run dev:debug` does the same but launches with `--inspect-extensions=9229` (attach,
 * NOT break), so the host always runs and you can attach "Attach to Extension Host (127.0.0.1)".
 *
 * Usage:
 *   npm run dev                 # last workspace, or the generic debug cell
 *   npm run dev -- <folder>     # that folder, remembered for next time
 *   npm run dev:debug [-- <folder>]
 *   --clean                     # kill stale Extension Development Hosts first
 */
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const debug = argv.includes('--debug');
const clean = argv.includes('--clean');
const wait = argv.includes('--wait');
const explicit = argv.find((a) => !a.startsWith('--'));

const scratch = path.join(root, '.vscode-test', 'debug-cell');
const stateFile = path.join(root, '.vscode-test', 'dev-workspace.txt');

const isDir = (p) => !!p && fs.existsSync(p) && fs.statSync(p).isDirectory();

// ── 1. build ────────────────────────────────────────────────────────────────
console.log('[dev] building dist/ …');
const build = spawnSync(process.execPath, [path.join(root, 'esbuild.mjs')], { cwd: root, stdio: 'inherit' });
if (build.status !== 0) {
  console.error(`[dev] build failed (exit ${build.status ?? '?'}); not launching.`);
  process.exit(build.status ?? 1);
}

// ── 2. workspace: explicit → last used → generic debug cell ─────────────────
let workspace = explicit;
if (!workspace) {
  try {
    const last = fs.readFileSync(stateFile, 'utf8').trim();
    if (isDir(last)) workspace = last;
  } catch { /* no remembered workspace */ }
}
if (!workspace) {
  console.log('[dev] no workspace given or remembered — using the fixture cell');
  const prep = spawnSync(process.execPath, [path.join(root, 'scripts', 'prepare-debug-cell.mjs')], { cwd: root, stdio: 'inherit' });
  if (prep.status !== 0) process.exit(prep.status ?? 1);
  workspace = scratch;
}
workspace = path.resolve(workspace);
if (!isDir(workspace)) {
  console.error(`[dev] workspace not found: ${workspace}`);
  process.exit(1);
}
if (explicit) {
  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, workspace, 'utf8');
  } catch { /* best effort */ }
}

// ── 3. optionally clear stale dev hosts (they collide with ports/attaches) ──
if (clean) {
  // The dev-host extension/debug processes are `ms-vscode.pwa-extensionHost` / `pwa-chrome`
  // bootstrap-forks; a leftover one holds the previous session's inspector port.
  const ps = `Get-CimInstance Win32_Process -Filter "Name='Code.exe'" | Where-Object { $_.CommandLine -match 'pwa-extensionHost|pwa-chrome' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
  const shells = [
    'pwsh',
    'powershell',
    path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  ];
  for (const sh of shells) {
    const r = spawnSync(sh, ['-NoProfile', '-Command', ps], { stdio: 'ignore' });
    if (!r.error) { console.log('[dev] cleared stale extension-developer processes'); break; }
  }
}

// ── 4. find VS Code ─────────────────────────────────────────────────────────
function resolveCode() {
  const candidates = [
    path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Microsoft VS Code', 'Code.exe'),
    path.join(process.env.ProgramFiles ?? '', 'Microsoft VS Code', 'Code.exe'),
    path.join(process.env['ProgramFiles(x86)'] ?? '', 'Microsoft VS Code', 'Code.exe'),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  const where = spawnSync('where', ['code.cmd'], { encoding: 'utf8', shell: true });
  const hit = (where.stdout ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
  return hit && fs.existsSync(hit) ? hit : undefined;
}
const code = resolveCode();
if (!code) {
  console.error('[dev] could not find VS Code (looked for Code.exe and code.cmd on PATH).');
  process.exit(1);
}

// ── 5. launch the Extension Development Host ────────────────────────────────
const launchArgs = [`--extensionDevelopmentPath=${root}`, '--disable-workspace-trust'];
if (debug) launchArgs.push('--inspect-extensions=9229');
launchArgs.push(workspace);
console.log(`[dev] opening ${debug ? 'DEBUG ' : ''}Extension Development Host on ${workspace}`);
if (debug) {
  console.log('[dev]   now attach with "Attach to Extension Host (127.0.0.1)" (port 9229)');
}
const child = spawn(code, launchArgs, {
  cwd: root,
  detached: true,
  stdio: 'ignore',
  shell: /\.(cmd|bat)$/i.test(code),
});
child.unref();

// ── 6. for `--wait` (used as a preLaunchTask), block until the inspector answers ──
if (debug && wait) {
  const ready = await waitForInspector(9229, 30000);
  if (!ready) {
    console.error('[dev] the extension host inspector did not come up on 127.0.0.1:9229.');
    process.exit(1);
  }
  console.log('[dev] inspector ready on 127.0.0.1:9229 — attaching…');
}

function waitForInspector(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok) => { if (!settled) { settled = true; resolve(ok); } };
    const attempt = () => {
      const req = http.get({ host: '127.0.0.1', port, path: '/json/list', timeout: 1000 }, (res) => {
        res.resume();
        if (res.statusCode === 200) return done(true);
        retry();
      });
      req.on('error', () => retry());
      req.on('timeout', () => req.destroy());
    };
    const retry = () => {
      if (settled) return;
      if (Date.now() > deadline) return done(false);
      setTimeout(attempt, 400);
    };
    attempt();
  });
}
