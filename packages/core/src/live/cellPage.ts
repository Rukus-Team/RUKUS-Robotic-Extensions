/**
 * The Cell page: one webview for the whole cell - its controllers, its robots, the settings that
 * make sync and writes possible, and the RUKUS link. It is the GUI counterpart to editing
 * `.robocode-cell/cell.json` and `.robocode-robot/robot.json` by hand.
 *
 * The page never talks to a controller; it reads the containers and posts commands. Writes go
 * through the same helpers the wizards use (`writeRobotJson`, `upsertCellController`, …), so a
 * change here is indistinguishable from one made anywhere else.
 *
 * The HTML is set once. Everything after that is a `state` message the page renders client-side:
 * re-setting `webview.html` on every update reloads the page, which makes every control
 * unclickable (the DOM under the cursor is replaced while the cursor is over it).
 */
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Services } from '../services';
import { config } from '../util';
import { withCsp } from '../webviewStyle';
import {
  CELL_DIR, underPath, upsertCellController, removeCellController,
  ROBOT_DIR, ROBOT_JSON, type RobotMarker,
} from '../robotContainers';

interface RobotRow {
  root: string;
  name: string;
  brand?: string;
  controller?: string;
  programs: string;
  snapshot?: string;
}

interface ControllerRow { name: string; host: string; device: string; protocol: string }

type Brand = 'fanuc' | 'abb' | 'mixed';
interface Toggle { key: string; label: string; note: string; value: boolean; scope: 'workspace' | 'machine'; /** which robot brand it belongs to; absent = both */ brands?: ('fanuc' | 'abb')[] }

interface PageState {
  name: string;
  root: string;
  brand?: Brand;
  linked?: string;
  warnings: string[];
  robots: RobotRow[];
  controllers: ControllerRow[];
  toggles: Toggle[];
  rukus: { available: boolean; enabled: boolean; clusters: string[] };
}

let panel: vscode.WebviewPanel | undefined;
let panelRoot: string | undefined;

const same = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

export function registerCellPage(ctx: vscode.ExtensionContext, s: Services): void {
  ctx.subscriptions.push(vscode.commands.registerCommand('robotCode.cell.open', (arg?: string | vscode.Uri) => openCellPage(s, arg)));
}

export function openCellPage(s: Services, arg?: string | vscode.Uri): void {
  const root = resolveCellRoot(s, arg);
  if (!root) {
    void vscode.window.showInformationMessage('No cell container in this workspace.', 'Initialize Cell Container…')
      .then(pick => { if (pick) void vscode.commands.executeCommand('robotCode.containers.initCell'); });
    return;
  }
  if (panel && panelRoot && same(panelRoot, root)) { panel.reveal(); return; }
  panel?.dispose();
  panelRoot = root;
  const cell = s.containers.cells.find(c => same(c.root, root));
  panel = vscode.window.createWebviewPanel('robotCode.cellPage', cell?.name ?? 'Cell', vscode.ViewColumn.Active, {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [],
  });
  const post = () => { if (panel && panelRoot) void panel.webview.postMessage({ type: 'state', state: state(s, panelRoot) }); };
  panel.onDidDispose(() => { panel = undefined; panelRoot = undefined; });
  panel.webview.onDidReceiveMessage(async (m: any) => {
    const rootNow = panelRoot;
    if (!rootNow) return;
    switch (m?.type) {
      case 'ready': post(); break;
      case 'refresh': post(); break;
      case 'setting':
        await vscode.workspace.getConfiguration('robotCode').update(m.key, !!m.value, m.scope === 'machine' ? vscode.ConfigurationTarget.Global : vscode.ConfigurationTarget.Workspace);
        post();
        break;
      case 'initCell': await vscode.commands.executeCommand('robotCode.containers.initCell'); post(); break;
      case 'initRobot': await vscode.commands.executeCommand('robotCode.containers.initRobot'); await s.containers.refresh(); post(); break;
      case 'editRobot': await editRobot(s, rootNow, m.root); await s.containers.refresh(); post(); break;
      case 'removeRobot': await removeRobot(s, rootNow, m.root); await s.containers.refresh(); post(); break;
      case 'snapshot': {
        const marker = s.containers.markers.find(x => same(x.root, m.root));
        if (marker) await vscode.commands.executeCommand('robotCode.data.snapshotFromBackup', { marker });
        post();
        break;
      }
      case 'reveal': await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(m.path)); break;
      case 'addController': await editController(s, rootNow); post(); break;
      case 'removeController': await removeController(s, rootNow, m.name); post(); break;
      case 'link': await linkCell(s, rootNow); post(); break;
      case 'unlink': await s.rukus?.unlinkCell(rootNow); post(); break;
    }
  });
  panel.webview.html = withCsp(html(), panel.webview.cspSource);
}

function resolveCellRoot(s: Services, arg?: string | vscode.Uri): string | undefined {
  const cells = s.containers.cells;
  if (!cells.length) return undefined;
  let target: string | undefined;
  if (typeof arg === 'string') target = arg;
  else if (arg instanceof vscode.Uri) target = arg.fsPath;
  if (target) {
    const p = path.resolve(target);
    const root = path.basename(p).toLowerCase() === CELL_DIR ? path.dirname(p) : p;
    const hit = cells.find(c => same(c.root, root));
    if (hit) return hit.root;
  }
  return cells[0].root;
}

function state(s: Services, root: string): PageState {
  const cell = s.containers.cells.find(c => same(c.root, root));
  const markers = s.containers.markers.filter(m => underPath(m.root, root));
  const brand = cellBrandOf(cell, markers);
  const toggles: Toggle[] = [
    { key: 'experimental.robotConnections', label: 'Robot connections (experimental)', note: 'The Cell view, reading a controller, teaching and pushing.', value: config<boolean>('experimental.robotConnections', false), scope: 'workspace' },
    { key: 'live.upload', label: 'Allow Push to Robot', note: 'Push (Ctrl+Alt+Shift+U) is the one write; it always asks first and is refused if the robot changed since the snapshot.', value: config<boolean>('live.upload', false), scope: 'workspace', brands: ['fanuc'] },
    { key: 'containers.guardUpload', label: 'Refuse a push the snapshot has not seen', note: 'Compares the robot\'s copy to the snapshot verbatim before writing.', value: config<boolean>('containers.guardUpload', true), scope: 'workspace' },
    { key: 'containers.gitAware', label: 'Mention uncommitted git changes before a push', note: 'Offers Source Control when the program is not committed in your own repo.', value: config<boolean>('containers.gitAware', false), scope: 'workspace' },
    { key: 'containers.gitignoreSnapshot', label: 'Keep the snapshot out of git', note: 'Adds snapshot/ to the robot container\'s .gitignore.', value: config<boolean>('containers.gitignoreSnapshot', true), scope: 'workspace' },
    { key: 'containers.pullCompiledAfterSourcePush', label: 'Pull compiled .TP/.PC after a source sync', note: 'When a source .LS/.KL is uploaded, fetched or pulled, also read the compiled copy into the snapshot. Off skips that extra (often slow) transfer when you only want the source; a later full fetch refreshes it.', value: config<boolean>('containers.pullCompiledAfterSourcePush', true), scope: 'workspace', brands: ['fanuc'] },
  ];
  return {
    name: cell?.name ?? path.basename(root),
    root,
    brand,
    linked: cell?.rukus?.cluster,
    warnings: [...s.containers.warnings],
    robots: markers.map(markerRow),
    controllers: Object.entries(cell?.controllers ?? {}).map(([name, c]) => ({
      name,
      host: c.host,
      device: c.device ?? 'MD:',
      protocol: c.useFtp ? `FTP ${c.ftpPort ?? 21}` : `HTTP ${c.httpPort ?? 80}`,
    })),
    // A brand-only setting is hidden on a cell that is entirely the other brand; a mixed or
    // unknown cell shows both, since either robot may need it.
    toggles: toggles.filter(t => !t.brands || !brand || brand === 'mixed' || t.brands.includes(brand)),
    rukus: {
      available: !!s.rukus?.available,
      enabled: config<boolean>('rukus.enabled', true),
      clusters: s.rukus?.clusters.map(c => c.name) ?? [],
    },
  };
}

/** The cell's brand: what it declares, else what its robot containers declare. */
function cellBrandOf(cell: { brand?: Brand } | undefined, markers: RobotMarker[]): Brand | undefined {
  if (cell?.brand) return cell.brand;
  const brands = new Set(markers.map(m => m.brand).filter((b): b is 'fanuc' | 'abb' => !!b));
  if (brands.size === 1) return [...brands][0];
  if (brands.size > 1) return 'mixed';
  return undefined;
}

function markerRow(m: RobotMarker): RobotRow {
  let snapshot: string | undefined;
  try {
    const p = path.join(m.root, ROBOT_DIR, 'snapshot.json');
    if (fs.existsSync(p)) snapshot = (JSON.parse(fs.readFileSync(p, 'utf8')) as { date?: string }).date;
  } catch { /* no snapshot */ }
  return {
    root: m.root,
    name: m.name,
    brand: m.brand,
    controller: m.controller,
    programs: m.programDirs?.length ? m.programDirs.map(d => path.relative(m.root, d)).join(', ') : '(all folders)',
    snapshot,
  };
}

async function editRobot(s: Services, cellRoot: string, robotRoot: string): Promise<void> {
  const marker = s.containers.markers.find(m => same(m.root, robotRoot));
  if (!marker) return;
  const cell = s.containers.cells.find(c => same(c.root, cellRoot));
  const name = await vscode.window.showInputBox({ prompt: 'Robot name (matches the cluster/controller name)', value: marker.name });
  if (name === undefined) return;
  const names = Object.keys(cell?.controllers ?? {});
  const controllerPick = await vscode.window.showQuickPick(
    [{ label: 'None', description: 'no controller binding', value: undefined as string | undefined }, ...names.map(n => ({ label: n, value: n as string | undefined }))],
    { placeHolder: 'Controller this robot belongs to' });
  if (controllerPick === undefined) return;
  const brandPick = await vscode.window.showQuickPick(
    [{ label: 'FANUC', value: 'fanuc' as const }, { label: 'ABB', value: 'abb' as const }],
    { placeHolder: 'Robot brand' });
  if (brandPick === undefined) return;
  const programs = await vscode.window.showInputBox({
    prompt: 'Working folders, comma-separated (empty = every sub-folder)',
    value: (marker.programDirs ?? []).map(d => path.relative(marker.root, d)).join(', '),
  });
  if (programs === undefined) return;
  // Read the raw file and change only the fields this form owns, so `exclude` and any future
  // key written by a newer build survive an edit here.
  const file = path.join(marker.root, ROBOT_DIR, ROBOT_JSON);
  let raw: Record<string, unknown> = {};
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* rebuild below */ }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) raw = {};
  raw.name = name.trim() || marker.name;
  raw.brand = brandPick.value;
  if (controllerPick.value) raw.controller = controllerPick.value; else delete raw.controller;
  const list = programs.split(',').map(x => x.trim()).filter(Boolean);
  if (list.length) raw.programs = list; else delete raw.programs;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(raw, null, 2) + '\n', 'utf8');
}

async function removeRobot(s: Services, cellRoot: string, robotRoot: string): Promise<void> {
  const marker = s.containers.markers.find(m => same(m.root, robotRoot));
  if (!marker || !underPath(marker.root, cellRoot)) return;
  const go = await vscode.window.showWarningMessage(
    `Remove the robot container for ${marker.name}?`,
    { modal: true, detail: 'This deletes .robocode-robot/ (robot.json, the snapshot and the history). The program files are not touched.' },
    'Remove');
  if (go !== 'Remove') return;
  fs.rmSync(path.join(marker.root, ROBOT_DIR), { recursive: true, force: true });
}

async function editController(s: Services, cellRoot: string): Promise<void> {
  const cell = s.containers.cells.find(c => same(c.root, cellRoot));
  const name = await vscode.window.showInputBox({ prompt: 'Controller name', value: '' });
  if (name === undefined || !name.trim()) return;
  const host = await vscode.window.showInputBox({ prompt: 'Controller IP address or hostname', value: cell?.controllers[name.trim()]?.host ?? '' });
  if (host === undefined || !host.trim()) return;
  const device = await vscode.window.showInputBox({ prompt: 'Device on the controller', value: cell?.controllers[name.trim()]?.device ?? 'MD:' });
  if (device === undefined) return;
  const protocol = await vscode.window.showQuickPick(
    [{ label: 'HTTP (no login needed)', value: false }, { label: 'FTP (requires user/password)', value: true }],
    { placeHolder: 'Connection protocol' });
  if (protocol === undefined) return;
  upsertCellController(cellRoot, name.trim(), { host: host.trim(), device: device.trim() || 'MD:', useFtp: protocol.value });
  await s.containers.refresh();
}

async function removeController(s: Services, cellRoot: string, name: string): Promise<void> {
  if (!name) return;
  const go = await vscode.window.showWarningMessage(`Remove controller "${name}" from the cell?`, { modal: true }, 'Remove');
  if (go !== 'Remove') return;
  removeCellController(cellRoot, name);
  await s.containers.refresh();
}

async function linkCell(s: Services, cellRoot: string): Promise<void> {
  if (!s.rukus?.available) { void vscode.window.showInformationMessage('RUKUS was not found on this PC.'); return; }
  const pick = await vscode.window.showQuickPick(
    s.rukus.clusters.map(c => ({ label: c.name, description: `${c.robots.length} robot(s)` })),
    { placeHolder: 'Link this cell to which RUKUS cluster?' });
  if (pick) await s.rukus.linkCell(cellRoot, pick.label);
}

// ── HTML: a static shell; `state` messages redraw it ────────────────────────

function html(): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 12px 18px; }
  h1 { font-size: 1.35em; margin: 0 0 2px; }
  h2 { font-size: 1.02em; margin: 20px 0 8px; color: var(--vscode-foreground); }
  .sub { color: var(--vscode-descriptionForeground); font-size: 0.92em; }
  .badge { font-size: 0.78em; padding: 1px 6px; border: 1px solid var(--vscode-panel-border); border-radius: 8px; color: var(--vscode-descriptionForeground); }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--vscode-panel-border); vertical-align: top; }
  th { font-weight: 600; font-size: 0.88em; color: var(--vscode-descriptionForeground); }
  .actions { white-space: nowrap; text-align: right; }
  .actions button { margin-left: 4px; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 3px 9px; border-radius: 2px; cursor: pointer; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.danger { background: transparent; color: var(--vscode-errorForeground); border: 1px solid var(--vscode-panel-border); }
  .toggle { display: flex; gap: 8px; align-items: flex-start; padding: 6px 0; border-bottom: 1px solid var(--vscode-panel-border); }
  .toggle input { margin-top: 3px; }
  .toggle span:nth-child(2) { flex: 1; display: flex; flex-direction: column; }
  .toggle em { font-style: normal; color: var(--vscode-descriptionForeground); font-size: 0.9em; }
  .warn { color: var(--vscode-errorForeground); }
  .toolbar { display: flex; gap: 6px; margin: 14px 0; }
  code { background: var(--vscode-textCodeBlock-background); padding: 0 3px; border-radius: 2px; }
</style></head><body>
<div id="app"></div>
<script>
  const vscode = acquireVsCodeApi();
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let state = null;
  window.addEventListener('message', e => { if (e.data && e.data.type === 'state') { state = e.data.state; render(); } });
  document.addEventListener('click', e => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    vscode.postMessage({ type: el.dataset.action, root: el.dataset.root, name: el.dataset.name, path: el.dataset.root });
  });
  document.addEventListener('change', e => {
    const el = e.target;
    if (el && el.matches && el.matches('input[type=checkbox][data-key]')) {
      vscode.postMessage({ type: 'setting', key: el.dataset.key, scope: el.dataset.scope, value: el.checked });
    }
  });
  function render() {
    if (!state) return;
    const s = state;
    let h = '<h1>' + esc(s.name) + '</h1><div class="sub">' + esc(s.root) + (s.brand ? ' · ' + esc(s.brand) + ' cell' : '') + '</div>';
    if (s.warnings && s.warnings.length) h += '<p class="warn">' + s.warnings.map(esc).join('<br>') + '</p>';
    h += '<div class="toolbar"><button data-action="initRobot">Initialize Robot Container…</button><button data-action="initCell">Initialize Cell Container…</button><button data-action="refresh">Refresh</button></div>';
    h += '<h2>Robots</h2>';
    if (s.robots.length) {
      h += '<table><thead><tr><th>Robot</th><th>Brand</th><th>Controller</th><th>Working folders</th><th>Snapshot</th><th></th></tr></thead><tbody>';
      for (const r of s.robots) {
        h += '<tr><td><strong>' + esc(r.name) + '</strong><div class="sub">' + esc(r.root) + '</div></td>'
          + '<td>' + (esc(r.brand) || '<span class="sub">detect</span>') + '</td>'
          + '<td>' + (esc(r.controller) || '<span class="sub">—</span>') + '</td>'
          + '<td class="sub">' + esc(r.programs) + '</td>'
          + '<td class="sub">' + (r.snapshot ? 'snapshot ' + esc(String(r.snapshot).slice(0, 10)) : 'no snapshot') + '</td>'
          + '<td class="actions"><button data-action="snapshot" data-root="' + esc(r.root) + '">Snapshot</button>'
          + '<button data-action="editRobot" data-root="' + esc(r.root) + '">Edit</button>'
          + '<button class="danger" data-action="removeRobot" data-root="' + esc(r.root) + '">Remove</button></td></tr>';
      }
      h += '</tbody></table>';
    } else h += '<p class="sub">No robot containers in this cell yet.</p>';
    h += '<h2>Controllers</h2>';
    if (s.controllers.length) {
      h += '<table><thead><tr><th>Name</th><th>Host</th><th>Connection</th><th></th></tr></thead><tbody>';
      for (const c of s.controllers) {
        h += '<tr><td><strong>' + esc(c.name) + '</strong></td><td>' + esc(c.host) + '</td>'
          + '<td class="sub">' + esc(c.device) + ' · ' + esc(c.protocol) + '</td>'
          + '<td class="actions"><button class="danger" data-action="removeController" data-name="' + esc(c.name) + '">Remove</button></td></tr>';
      }
      h += '</tbody></table>';
    } else h += '<p class="sub">No controllers defined in cell.json.</p>';
    h += '<p class="actions"><button data-action="addController">Add / edit controller…</button></p>';
    h += '<h2>Settings</h2>';
    for (const t of s.toggles) {
      h += '<label class="toggle"><input type="checkbox" data-key="' + esc(t.key) + '" data-scope="' + t.scope + '"' + (t.value ? ' checked' : '') + '>'
        + '<span><strong>' + esc(t.label) + '</strong><em>' + esc(t.note) + '</em></span>'
        + '<span class="badge">' + (t.scope === 'machine' ? 'machine' : 'workspace') + '</span></label>';
    }
    h += '<h2>RUKUS</h2>';
    if (!s.rukus.available) h += '<p class="sub">RUKUS was not found on this PC.</p>';
    else if (!s.rukus.enabled) h += '<p class="sub">RUKUS integration is off (<code>robotCode.rukus.enabled</code>).</p>';
    else if (s.linked) h += '<p>Linked to <strong>' + esc(s.linked) + '</strong>.</p><p class="actions"><button data-action="link">Relink…</button><button class="danger" data-action="unlink">Unlink</button></p>';
    else h += '<p class="sub">This cell is not linked to a RUKUS cluster.</p><p class="actions"><button data-action="link">Link to a cluster…</button></p>';
    document.getElementById('app').innerHTML = h;
  }
  vscode.postMessage({ type: 'ready' });
</script>
</body></html>`;
}
