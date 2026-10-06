/**
 * What software options a controller has - the extension's version of RUKUS's "Installed
 * Options" in Robot Info. Read from MD:ORDERFIL.DAT (live), or from the orderfil.dat in a backup
 * folder (offline). Two surfaces:
 *   - robotCode.live.getOptions  - the robot page's Options card (a few highlights + a count)
 *   - robotCode.live.showOptions - every option, with a filter, Copy and Refresh
 */
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { FanucServices } from '../services';
import type { RobotManager } from '@core/live/robotManager';
import { escapeHtml } from '@core/util';
import { gated } from '@core/experimental';
import { boundRobot, profileNamed } from '@core/robotBinding';
import { WEBVIEW_BASE_CSS, LIST_LIMIT_JS, emptyState } from '@core/webviewStyle';
import { ORDER_FILE, readControllerOptions, parseOrderFile, optionHighlights, type ControllerOption } from './controllerOptions';

interface Source { title: string; where: string; options: ControllerOption[] }

export function registerOptionsView(ctx: vscode.ExtensionContext, s: FanucServices, robots: RobotManager) {
  const reg = (id: string, fn: (...a: any[]) => any) => ctx.subscriptions.push(vscode.commands.registerCommand(id, fn));
  const nameOf = (node?: any): string | undefined => node?.c?.profile?.name ?? (typeof node === 'string' ? node : undefined);

  // the robot page's card: read once, keep on the snapshot
  reg('robotCode.live.getOptions', gated(async (node?: any) => {
    const name = nameOf(node) ?? (await pickConnected(robots));
    const c = name ? robots.get(name) : undefined;
    if (!c || c.state !== 'connected') { if (name) vscode.window.showWarningMessage(`${name} is not connected.`); return; }
    const options = await readControllerOptions(robots, c.profile, true);
    if (!options) { vscode.window.showWarningMessage(`${name} did not report its options (${ORDER_FILE} on MD: could not be read).`); return; }
    robots.setOptions(c.profile.name, options, optionHighlights(options));
  }));

  // every option: from a connected robot, or offline from a backup folder's orderfil.dat
  reg('robotCode.live.showOptions', async (node?: any) => {
    const src = await chooseSource(s, robots, nameOf(node));
    if (src) openPanel(ctx, robots, src);
  });

  // The robot being edited: read its options when its file comes to the front, so the CALL list
  // (tp/providers) knows which FANUC programs it has. A file from a robot (fanuc://) or in a
  // container bound to one; only a connected robot is asked, and not again within a minute.
  // A file in a backup folder needs nothing here - the CALL list reads that folder's orderfil.dat.
  const readAt = new Map<string, number>();
  const readActive = async () => {
    const doc = vscode.window.activeTextEditor?.document;
    if (!doc || (doc.languageId !== 'fanuc-tp' && doc.languageId !== 'fanuc-karel')) return;
    const bound = boundRobot(s, doc.uri);
    const c = bound ? profileNamed(robots.list(), bound.name) : undefined;
    if (!c || c.state !== 'connected') return;
    const key = c.profile.name.toUpperCase();
    if (Date.now() - (readAt.get(key) ?? 0) < 60_000) return;
    readAt.set(key, Date.now());
    const options = await readControllerOptions(robots, c.profile, true);
    if (options) robots.setOptions(c.profile.name, options, optionHighlights(options));
    else readAt.delete(key);   // not read: ask again next time rather than wait out the minute
  };
  ctx.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => void readActive()),
    // a robot that connects while its file is open
    robots.onDidChange(name => { if (name && robots.get(name)?.state === 'connected' && !readAt.has(name.toUpperCase())) void readActive(); }),
  );
  void readActive();
}

async function pickConnected(robots: RobotManager): Promise<string | undefined> {
  const names = robots.connected().map(c => c.profile.name);
  return names.length <= 1 ? names[0] : vscode.window.showQuickPick(names, { title: 'Controller options', placeHolder: 'Which robot?' });
}

/** orderfil.dat in a backup folder, any case */
function backupOrderFile(folder: string): string | undefined {
  try { const f = fs.readdirSync(folder).find(n => n.toLowerCase() === ORDER_FILE.toLowerCase()); return f ? path.join(folder, f) : undefined; } catch { return undefined; }
}

async function chooseSource(s: FanucServices, robots: RobotManager, name?: string): Promise<Source | undefined> {
  const live = async (n: string): Promise<Source | undefined> => {
    const c = robots.get(n);
    const options = c ? await readControllerOptions(robots, c.profile, true) : undefined;
    if (!options) { vscode.window.showWarningMessage(`${n} did not report its options (${ORDER_FILE} on MD: could not be read).`); return undefined; }
    robots.setOptions(n, options, optionHighlights(options));
    return { title: n, where: `read from ${n} (${c!.profile.host}) · MD:${ORDER_FILE}`, options };
  };
  if (name && robots.get(name)?.state === 'connected') return live(name);
  const items: Array<vscode.QuickPickItem & { run: () => Promise<Source | undefined> }> = [];
  for (const c of robots.connected()) items.push({ label: `$(plug) ${c.profile.name}`, description: `${c.profile.host} · live`, run: () => live(c.profile.name) });
  for (const d of s.data.datasets) {
    const f = backupOrderFile(d.folder);
    if (f) items.push({ label: `$(archive) ${d.label}`, description: 'backup folder', detail: d.folder, run: async () => ({ title: d.label, where: `from the backup ${f}`, options: parseOrderFile(fs.readFileSync(f, 'latin1')) }) });
  }
  if (!items.length) { vscode.window.showInformationMessage(`No connected robot and no backup folder with ${ORDER_FILE.toLowerCase()} to read the options from.`); return undefined; }
  const pick = items.length === 1 ? items[0] : await vscode.window.showQuickPick(items, { title: 'Controller options', placeHolder: 'Read the options of…', matchOnDetail: true });
  return pick?.run();
}

const panels = new Map<string, vscode.WebviewPanel>();
function openPanel(ctx: vscode.ExtensionContext, robots: RobotManager, src: Source) {
  let panel = panels.get(src.title);
  if (panel) panel.reveal();
  else {
    panel = vscode.window.createWebviewPanel('robotCode.controllerOptions', `Options: ${src.title}`, vscode.ViewColumn.Active, { enableScripts: true });
    panels.set(src.title, panel);
    panel.onDidDispose(() => panels.delete(src.title), null, ctx.subscriptions);
    panel.webview.onDidReceiveMessage(async (m: { copy?: string; refresh?: boolean }) => {
      if (m.copy !== undefined) { await vscode.env.clipboard.writeText(m.copy); vscode.window.setStatusBarMessage(`$(copy) ${m.copy.split('\n').length} option(s) copied`, 3000); }
      if (m.refresh) {
        const c = robots.get(src.title);
        const fresh = c?.state === 'connected' ? await readControllerOptions(robots, c.profile, true) : undefined;
        if (fresh) { src.options = fresh; robots.setOptions(src.title, fresh, optionHighlights(fresh)); panel!.webview.html = render(src); }
        else vscode.window.showWarningMessage(`${src.title} is not connected, so the list was not read again.`);
      }
    }, null, ctx.subscriptions);
  }
  panel.webview.html = render(src);
}

function render(src: Source): string {
  const hl = optionHighlights(src.options);
  const live = src.where.startsWith('read from');
  const rows = src.options.map(o => `<tr tabindex="-1" data-search="${escapeHtml((o.code + ' ' + o.name).toLowerCase())}"><td class="mono code">${escapeHtml(o.code)}</td><td>${escapeHtml(o.name)}</td></tr>`).join('');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${WEBVIEW_BASE_CSS}
  body { padding: 12px 16px }
  h1 { font-size: 16px; margin: 0 0 2px } .where { color: var(--rc-muted); font-size: 11.5px; margin-bottom: 12px }
  .hl { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 8px; margin-bottom: 14px }
  .h { border: 1px solid var(--rc-line); border-left: 3px solid var(--rc-muted); border-radius: 4px; padding: 6px 10px; font-size: 12.5px }
  .h.ok { border-left-color: var(--rc-ok) } .h.no { border-left-color: var(--rc-bad) } .h small { display: block; color: var(--rc-muted); font-size: 11px; margin-top: 2px }
  .bar { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; position: sticky; top: 0; background: var(--vscode-editor-background); padding: 6px 0; z-index: 2 }
  .bar input { flex: 1 1 220px } .count { color: var(--rc-muted); font-size: 11.5px }
  th { position: sticky; top: 0; background: var(--vscode-editor-background) } .rc-scroll { max-height: calc(100vh - 230px); min-height: 160px } td.code { width: 90px; color: var(--rc-purple) }
  tr:hover td { background: var(--vscode-list-hoverBackground) } tr:focus td { background: var(--vscode-list-focusBackground, var(--vscode-list-hoverBackground)) }
</style></head><body>
<h1>${escapeHtml(src.title)} — ${src.options.length} option${src.options.length === 1 ? '' : 's'}</h1>
<div class="where">${escapeHtml(src.where)}</div>
<div class="hl">${hl.map(h => `<div class="h ${h.ok === true ? 'ok' : h.ok === false ? 'no' : ''}"><b>${h.ok === true ? '✓ ' : h.ok === false ? '✗ ' : ''}${escapeHtml(h.label)}</b><small>${escapeHtml(h.detail)}</small></div>`).join('')}</div>
${src.options.length ? `<div class="bar"><input id="q" type="search" placeholder="Filter by code or name (R632, KAREL…)" aria-label="Filter options" autofocus>
<span class="count" id="count"></span><button id="copy" title="Copy the options shown, one per line">Copy</button>${live ? '<button id="refresh" title="Read the list from the robot again">Refresh</button>' : ''}</div>
<div class="rc-scroll"><table><thead><tr><th>Code</th><th>Option</th></tr></thead><tbody>${rows}</tbody></table></div><div id="lim"></div>`
  : emptyState('No options listed', `${ORDER_FILE} had no option lines.`)}
<script>
  const vscode = acquireVsCodeApi();
${LIST_LIMIT_JS}
  const q = document.getElementById('q'), count = document.getElementById('count');
  const all = [...document.querySelectorAll('tbody tr')];
  const visible = () => all.filter(r => !r.hidden);
  // the filter picks the matches; the picker (10 / 50 / 100 / 250 / All) caps how many are drawn
  function show() {
    const f = (q?.value || '').toLowerCase().trim();
    const matches = all.filter(r => !f || r.dataset.search.includes(f));
    const drawn = new Set(rcSlice('opt', matches, 100));
    for (const r of all) r.hidden = !drawn.has(r);
    if (count) count.textContent = matches.length + ' of ' + all.length + (f ? ' match' : '');
    const lim = document.getElementById('lim');
    if (lim) { lim.innerHTML = rcLimitBar('opt', drawn.size, matches.length, 100); rcWireLimits(show); }
  }
  q?.addEventListener('input', show);
  q?.addEventListener('keydown', e => { if (e.key === 'ArrowDown') { e.preventDefault(); visible()[0]?.focus(); } });
  document.querySelector('tbody')?.addEventListener('keydown', e => {
    const list = visible(), i = list.indexOf(e.target.closest('tr'));
    const go = n => { e.preventDefault(); const r = list[Math.max(0, Math.min(list.length - 1, n))]; r?.focus(); r?.scrollIntoView({ block: 'nearest' }); };
    if (e.key === 'ArrowDown') go(i + 1);
    else if (e.key === 'ArrowUp') { if (i <= 0) { e.preventDefault(); q?.focus(); } else go(i - 1); }
    else if (e.key === 'Home') go(0); else if (e.key === 'End') go(list.length - 1);
    else if (e.key === 'Escape') { e.preventDefault(); q?.focus(); }
  });
  document.getElementById('copy')?.addEventListener('click', () => vscode.postMessage({ copy: visible().map(r => r.cells[0].textContent + '\\t' + r.cells[1].textContent).join('\\n') }));
  document.getElementById('refresh')?.addEventListener('click', () => vscode.postMessage({ refresh: true }));
  show();
</script></body></html>`;
}
