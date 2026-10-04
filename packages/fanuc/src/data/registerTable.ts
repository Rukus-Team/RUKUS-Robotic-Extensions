import * as vscode from 'vscode';
import { FanucServices } from '../services';
import { escapeHtml } from '@core/util';
import { WEBVIEW_BASE_CSS, emptyState } from '@core/webviewStyle';
import { findUses } from '@core/views/findUses';
import type { Dataset } from './dataStore';
import { describePayload } from './vaParser';
import { isIdentityFrame } from './sysFrameParser';
import { fmtFrame } from '../tp/frameHover';
import type { Xyzwpr } from '../tp/frameMath';

let panel: vscode.WebviewPanel | undefined;
let current: string | undefined;

/** colour family per tab: registers get their own hue, inputs vs outputs differ */
function kindClass(id: string): string {
  if (id === 'R') return 'r'; if (id === 'PR') return 'pr'; if (id === 'SR') return 'sr'; if (id === 'MACRO') return 'macro'; if (id === 'PAYLOAD') return 'payload';
  if (id === 'F' || id === 'M') return 'flag';
  return /I$/.test(id) ? 'in' : 'out';
}
function valueClass(v: string): string {
  if (v === '' ) return '';
  if (/^\(uninit\)$/.test(v)) return 'v-dim';
  if (/ kg /.test(v)) return 'v-num';
  if (/^→/.test(v)) return 'v-prog';
  if (/^-?[\d.]+$/.test(v)) return v === '0' ? 'v-zero' : 'v-num';
  return 'v-str';
}

export function openRegisterTable(ctx: vscode.ExtensionContext, s: FanucServices) {
  if (!panel) {
    panel = vscode.window.createWebviewPanel('robotCode.registerTable', 'Registers & I/O', vscode.ViewColumn.Beside, { enableScripts: true, retainContextWhenHidden: true });
    panel.onDidDispose(() => { panel = undefined; });
    panel.webview.onDidReceiveMessage((m: { find?: { kind: string; index: number; folder: string }; copy?: string; robot?: string }) => {
      if (m.find) void findUses(m.find.kind, m.find.index, m.find.folder);
      if (m.copy) void vscode.env.clipboard.writeText(m.copy);
      if (m.robot !== undefined) { current = m.robot; if (panel) panel.webview.html = render(s); }
    });
    const sub = s.data.onDidChange(() => { if (panel) panel.webview.html = render(s); });
    panel.onDidDispose(() => sub.dispose());
    ctx.subscriptions.push(panel);
  }
  // default to the robot of the active editor
  const active = vscode.window.activeTextEditor?.document.uri;
  const ds = active ? s.data.dataset(active) : undefined;
  if (ds) current = ds.folder;
  panel.webview.html = render(s);
  panel.reveal();
}

function render(s: FanucServices): string {
  const all = s.data.datasets.filter(d => d.size > 0);
  const d: Dataset | undefined = all.find(x => x.folder === current) ?? all[0];
  if (d) current = d.folder;
  const tabs: Array<{ id: string; title: string; rows: Array<[string, string, string, string, number]> }> = [];
  if (d) {
    if (d.numregs.size) tabs.push({ id: 'R', title: `R (${d.numregs.size})`, rows: [...d.numregs.values()].map(r => [`R[${r.index}]`, r.comment, String(r.value), `R[${r.index}${r.comment ? `:${r.comment}` : ''}]`, r.index]) });
    const prs = [...d.posregs.values()].filter(r => r.group === 1).sort((a, b) => a.index - b.index);
    if (prs.length) tabs.push({ id: 'PR', title: `PR (${prs.length})`, rows: prs.map(r => [`PR[${r.index}]`, r.comment, r.kind === 'uninit' ? '(uninit)' : `${r.uf !== undefined ? `UF${r.uf} ` : ''}${r.ut !== undefined ? `UT${r.ut} ` : ''}${r.summary}`, `PR[${r.index}${r.comment ? `:${r.comment}` : ''}]`, r.index]) });
    if (d.strregs.size) tabs.push({ id: 'SR', title: `SR (${d.strregs.size})`, rows: [...d.strregs.values()].map(r => [`SR[${r.index}]`, r.comment, r.value, `SR[${r.index}${r.comment ? `:${r.comment}` : ''}]`, r.index]) });
    for (const [kind, arr] of d.ioByKind()) tabs.push({ id: kind, title: `${kind} (${arr.length})`, rows: arr.map(e => [`${kind}[${e.index}]`, e.comment, '', `${kind}[${e.index}:${e.comment}]`, e.index]) });
    if (d.macros.size) tabs.push({ id: 'MACRO', title: `Macros (${d.macros.size})`, rows: [...d.macros.values()].sort((a, b) => a.index - b.index).map(m => [`#${m.index}`, m.macroName, `→ ${m.progName}`, m.macroName, m.index]) });
    if (d.payloads.size) tabs.push({ id: 'PAYLOAD', title: `Payloads (${[...d.payloads.values()].filter(p => p.initialized).length})`, rows: [...d.payloads.values()].map(p => [`PAYLOAD[${p.index}]`, p.initialized ? p.comment : '(uninit)', p.initialized ? describePayload(p) : '', `PAYLOAD[${p.index}]`, p.index]) });
    // frames from sysframe.va: value column is X Y Z W P R; "selected" marks the one active at backup time
    const frameTab = (id: 'UF' | 'UT', table: Map<number, Xyzwpr>, active: number | undefined) => {
      if (!table.size) return;
      const set = [...table.entries()].filter(([i, f]) => !isIdentityFrame(f) || i === active);
      tabs.push({ id, title: `${id} (${set.length})`, rows: [...table.entries()].sort((a, b) => a[0] - b[0]).map(([i, f]) => [`${id === 'UF' ? 'UFRAME' : 'UTOOL'}[${i}]`, i === active ? 'selected' : isIdentityFrame(f) ? '(all zeros)' : '', fmtFrame(f), `${id === 'UF' ? 'UFRAME_NUM' : 'UTOOL_NUM'}=${i}`, i]) });
    };
    frameTab('UF', d.frames, d.activeFrame);
    frameTab('UT', d.tools, d.activeTool);
  }

  const robotSel = all.length > 1 ? `<select id="robot" title="Robot folder">${all.map(x => `<option value="${escapeHtml(x.folder)}" ${x === d ? 'selected' : ''}>${escapeHtml(x.label)}</option>`).join('')}</select>` : d ? `<span class="robot">${escapeHtml(d.label)}</span>` : '';
  const tabBtns = tabs.map((t, i) => `<button class="tab${i === 0 ? ' active' : ''}" role="tab" aria-selected="${i === 0}" aria-label="${escapeHtml(t.title)}" data-tab="${t.id}">${escapeHtml(t.title)}</button>`).join('');
  const tables = tabs.map((t, i) => `<table data-tab="${t.id}" ${i === 0 ? '' : 'hidden'}>
    <thead><tr><th>Item</th><th>Comment</th><th>Value</th><th></th></tr></thead>
    <tbody>${t.rows.map(([a, b, c, ins, idx]) => `<tr tabindex="-1" data-search="${escapeHtml((a + ' ' + b + ' ' + c).toLowerCase())}">
      <td class="mono k-${kindClass(t.id)}">${escapeHtml(a)}</td><td>${escapeHtml(b)}</td><td class="mono val ${valueClass(c)}">${escapeHtml(c)}</td>
      <td class="actions"><button title="Find uses in this robot's programs" aria-label="Find uses of ${escapeHtml(t.id)}[${idx}]" data-find="${escapeHtml(t.id)}" data-index="${idx}">⌕</button><button title="Copy ${escapeHtml(ins)}" aria-label="Copy ${escapeHtml(ins)}" data-copy="${escapeHtml(ins)}">⧉</button></td></tr>`).join('')}</tbody></table>`).join('');
  const sources = (d?.sources ?? []).map(x => `<li>${escapeHtml(x.kind)} — <code>${escapeHtml(x.file)}</code> (${x.entries})</li>`).join('');

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${WEBVIEW_BASE_CSS}
  body { padding: 10px 14px }
  .bar { display:flex; gap:6px; flex-wrap: wrap; align-items:center; margin-bottom: 4px; position: sticky; top: 0; background: var(--vscode-editor-background); padding: 6px 0; z-index: 2 }
  input { flex: 1 1 200px; min-width: 160px }
  .robot { font-weight: 600; padding: 4px 8px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); border-radius: 3px }
  .tab { padding: 4px 10px }
  .tab.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground) }
  .keys { font-size: 11px; color: var(--rc-muted); margin: 0 0 8px }
  th { padding: 6px 8px; position: sticky; top: 44px; background: var(--vscode-editor-background) }
  td { padding: 4px 8px }
  tr:hover td { background: var(--vscode-list-hoverBackground) }
  tr:focus td { background: var(--vscode-list-focusBackground, var(--vscode-list-hoverBackground)) }
  .val { color: var(--vscode-descriptionForeground) }
  .k-r { color: var(--vscode-charts-orange, #d19a66) } .k-pr { color: var(--vscode-charts-blue, #61afef) } .k-sr { color: var(--vscode-charts-green, #98c379) }
  .k-in { color: var(--vscode-charts-blue, #61afef) } .k-out { color: var(--vscode-charts-purple, #c678dd) } .k-flag { color: var(--vscode-charts-green, #98c379) } .k-macro { color: var(--vscode-charts-yellow, #f6c343) } .k-payload { color: var(--vscode-charts-red, #ff7b72) }
  .v-num { color: var(--vscode-charts-orange, #d19a66) } .v-zero { color: var(--vscode-descriptionForeground); opacity: .6 } .v-str { color: var(--vscode-charts-green, #98c379) } .v-dim { opacity: .5; font-style: italic } .v-prog { color: var(--vscode-charts-yellow, #f6c343) }
  .actions { white-space: nowrap; text-align: right } .actions button { background: transparent; border: 0; padding: 0 4px; color: var(--vscode-foreground); cursor: pointer; opacity: .5; font-size: 14px } .actions button:hover { opacity: 1 }
  ul { font-size: 11px; opacity: .7 }
</style></head><body>
${d ? `<div class="bar">${robotSel}<input id="q" type="search" placeholder="Filter by number, comment or value…" aria-label="Filter" autofocus><span role="tablist" aria-label="Register kinds">${tabBtns}</span></div>
<div class="keys">↓ from the filter into the list · ↑ ↓ Home End PgUp PgDn move · Enter copy · Shift+Enter find uses · Esc back to the filter · ← → on the tabs</div>${tables}`
  : emptyState('No controller data loaded', 'Add a backup folder to load register comments, frames, and macros.', '<a href="command:robotCode.data.addBackupFolder">Add Backup Folder</a>')}
<ul>${sources}</ul>
<script>
  const vscode = acquireVsCodeApi();
  const folder = ${JSON.stringify(d?.folder ?? '')};
  const q = document.getElementById('q');
  const tables = [...document.querySelectorAll('table')];
  const tabs = [...document.querySelectorAll('.tab')];
  let active = tabs[0]?.dataset.tab;
  function show() {
    const f = (q?.value || '').toLowerCase().trim();
    for (const t of tables) { const on = t.dataset.tab === active; t.hidden = !on; if (on) for (const r of t.tBodies[0].rows) r.hidden = f && !r.dataset.search.includes(f); }
  }
  function selectTab(b, focus) {
    active = b.dataset.tab;
    tabs.forEach(x => { const on = x === b; x.classList.toggle('active', on); x.setAttribute('aria-selected', String(on)); x.tabIndex = on ? 0 : -1; });
    show();
    if (focus) b.focus();
  }
  // keyboard: the visible rows of the active table are one list; one row at a time takes focus
  const rows = () => { const t = tables.find(x => x.dataset.tab === active); return t ? [...t.tBodies[0].rows].filter(r => !r.hidden) : []; };
  const focusRow = r => { if (r) { r.focus(); r.scrollIntoView({ block: 'nearest' }); } };
  q?.addEventListener('keydown', e => { if (e.key === 'ArrowDown') { e.preventDefault(); focusRow(rows()[0]); } });
  for (const t of tables) t.addEventListener('keydown', e => {
    const r = e.target.closest('tr'); if (!r || !r.parentElement || r.parentElement.tagName !== 'TBODY') return;
    const list = rows(), i = list.indexOf(r);
    const go = n => { e.preventDefault(); focusRow(list[Math.max(0, Math.min(list.length - 1, n))]); };
    if (e.key === 'ArrowDown') go(i + 1);
    else if (e.key === 'ArrowUp') { if (i <= 0) { e.preventDefault(); q?.focus(); } else go(i - 1); }
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(list.length - 1);
    else if (e.key === 'PageDown') go(i + 10);
    else if (e.key === 'PageUp') go(i - 10);
    else if (e.key === 'Escape') { e.preventDefault(); q?.focus(); }
    else if (e.key === 'Enter') { e.preventDefault(); r.querySelector(e.shiftKey ? 'button[data-find]' : 'button[data-copy]')?.click(); }
  });
  q?.addEventListener('input', show);
  tabs.forEach((b, i) => {
    b.tabIndex = i === 0 ? 0 : -1;
    b.addEventListener('click', () => selectTab(b, false));
    b.addEventListener('keydown', e => {
      const n = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : undefined;
      if (n === undefined) return;
      e.preventDefault(); selectTab(tabs[(n + tabs.length) % tabs.length], true);
    });
  });
  document.getElementById('robot')?.addEventListener('change', e => vscode.postMessage({ robot: e.target.value }));
  document.body.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.find) vscode.postMessage({ find: { kind: b.dataset.find, index: +b.dataset.index, folder } });
    if (b.dataset.copy) vscode.postMessage({ copy: b.dataset.copy });
  });
  show();
</script></body></html>`;
}
