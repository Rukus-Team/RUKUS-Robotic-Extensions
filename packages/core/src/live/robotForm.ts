/**
 * Robot connection form: one webview to add, edit, test and remove robot profiles.
 */
import * as vscode from 'vscode';
import type { Services } from '../services';
import { RobotManager } from './robotManager';
import type { RobotProfile } from './types';
import { WEBVIEW_BASE_CSS } from '../webviewStyle';
import { connectionHint } from './connectionHints';
import { parseControllerInfo } from './parsers';

let panel: vscode.WebviewPanel | undefined;

export function openRobotForm(ctx: vscode.ExtensionContext, s: Services, robots: RobotManager, editName?: string) {
  if (!panel) {
    panel = vscode.window.createWebviewPanel('robotCode.robotForm', 'Robot Connections', vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
    panel.onDidDispose(() => { panel = undefined; });
    ctx.subscriptions.push(panel);
    const sub = robots.onDidChange(() => { if (panel) void panel.webview.postMessage({ type: 'profiles', profiles: profilesForView(robots), datasets: datasetSuggestions(s, robots) }); });
    panel.onDidDispose(() => sub.dispose());

    panel.webview.onDidReceiveMessage(async (m: any) => {
      try {
        switch (m.type) {
          case 'ready': await panel!.webview.postMessage({ type: 'profiles', profiles: profilesForView(robots), datasets: datasetSuggestions(s, robots), select: editName }); break;
          case 'test': {
            const p = toProfile(m.profile);
            const started = Date.now();
            try {
              if (m.password) await robots.setPassword(p.name || '__test__', m.password);
              const text = await robots.readText({ ...p, name: m.password ? (p.name || '__test__') : p.name }, 'CURPOS.DG');
              const info = parseControllerInfo(text);
              let robotName: string | undefined;
              try { robotName = parseControllerInfo(await robots.readText(p, 'ERRALL.LS')).robotName; } catch { /* optional */ }
              await panel!.webview.postMessage({ type: 'testResult', ok: true, ms: Date.now() - started, info: { ...info, robotName } });
            } catch (e: any) {
              await panel!.webview.postMessage({ type: 'testResult', ok: false, ms: Date.now() - started, error: e?.message ?? String(e), hint: hintFor(e?.message ?? '', p) });
            }
            break;
          }
          case 'save': {
            const p = toProfile(m.profile);
            if (!p.name || !p.host) { await panel!.webview.postMessage({ type: 'error', text: 'Name and IP address are required.' }); break; }
            if (m.originalName && m.originalName !== p.name) { robots.disconnect(m.originalName); await robots.removeProfile(m.originalName); }
            await robots.addProfile(p);
            if (m.password) await robots.setPassword(p.name, m.password);
            robots.log(p.name, `profile saved (${p.host}, ${p.useFtp ? 'FTP' : 'HTTP'})`);
            await panel!.webview.postMessage({ type: 'saved', name: p.name });
            if (m.connect) await vscode.commands.executeCommand('robotCode.live.connect', p.name);
            break;
          }
          case 'delete': {
            const ok = await vscode.window.showWarningMessage(`Remove robot "${m.name}"?`, { modal: true }, 'Remove');
            if (ok) { robots.disconnect(m.name); await robots.removeProfile(m.name); }
            break;
          }
          case 'connect': await vscode.commands.executeCommand('robotCode.live.connect', m.name); break;
          case 'disconnect': robots.disconnect(m.name); break;
        }
      } catch (e: any) { await panel!.webview.postMessage({ type: 'error', text: e?.message ?? String(e) }); }
    });
  }
  panel.webview.html = html();
  panel.reveal();
  if (editName) void panel.webview.postMessage({ type: 'profiles', profiles: profilesForView(robots), datasets: datasetSuggestions(s, robots), select: editName });
}

function toProfile(p: any): RobotProfile {
  return {
    name: String(p.name ?? '').trim(), host: String(p.host ?? '').trim(),
    httpPort: Number(p.httpPort) || 80, ftpPort: Number(p.ftpPort) || 21, ftpUser: String(p.ftpUser ?? ''),
    device: String(p.device || 'MD:'), useFtp: !!p.useFtp, pollIntervalMs: Math.max(1000, Number(p.pollIntervalMs) || 5000),
    autoConnect: !!p.autoConnect, autoRefresh: !!p.autoRefresh,
  };
}

function profilesForView(robots: RobotManager) {
  return robots.list().map(c => ({ ...c.profile, state: c.state, error: c.error, info: c.snapshot?.info }));
}

/** robot names seen in backup folders but not yet configured → quick prefill chips */
function datasetSuggestions(s: Services, robots: RobotManager): string[] {
  const have = new Set(robots.list().map(c => c.profile.name.toUpperCase()));
  return [...new Set(s.data.datasets.map(d => d.name))].filter(n => !have.has(n.toUpperCase()) && !/^\d{4}-/.test(n)).sort();
}

function hintFor(err: string, p: RobotProfile): string {
  return connectionHint(err, p) ?? 'See the Robot Code output channel for the full log.';
}

function html(): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${WEBVIEW_BASE_CSS}
  body { padding: 14px 18px }
  h1 { font-size: 16px; margin: 0 0 12px } h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .05em; opacity: .75; margin: 16px 0 8px }
  .wrap { display: grid; grid-template-columns: 260px 1fr; gap: 20px; align-items: start } @media (max-width: 760px) { .wrap { grid-template-columns: 1fr } }
  .list { border: 1px solid var(--vscode-panel-border, #444); border-radius: 6px; overflow: hidden }
  .row { display: flex; align-items: center; gap: 8px; padding: 8px 10px; cursor: pointer; border-bottom: 1px solid var(--vscode-editorWidget-border, #333) } .row:last-child { border-bottom: 0 }
  .row:hover { background: var(--vscode-list-hoverBackground) } .row.active { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground) }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--vscode-disabledForeground); flex: none } .dot.connected { background: var(--vscode-testing-iconPassed, #3fb950) } .dot.error { background: var(--vscode-testing-iconFailed, #f14c4c) } .dot.connecting { background: var(--vscode-charts-yellow, #f6c343) }
  .row .n { font-weight: 600 } .row .h { opacity: .6; font-size: 11px; margin-left: auto }
  .newbtn { width: 100%; padding: 8px; margin-top: 8px }
  .card { border: 1px solid var(--vscode-panel-border, #444); border-radius: 6px; padding: 14px 16px }
  .grid { display: grid; grid-template-columns: 140px 1fr; gap: 10px 12px; align-items: center } label { opacity: .85 }
  input[type=text], input[type=password], input[type=number], select { width: 100%; box-sizing: border-box; padding: 6px 8px }
  .inline { display: flex; gap: 8px; align-items: center } .inline input[type=number] { width: 90px }
  button { padding: 6px 12px } button.danger { color: var(--vscode-errorForeground) }
  .actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 14px; align-items: center }
  .result { margin-top: 12px; padding: 10px 12px; border-radius: 4px; border: 1px solid var(--vscode-panel-border, #444); display: none } .result.ok { border-color: var(--vscode-testing-iconPassed, #3fb950) } .result.bad { border-color: var(--vscode-testing-iconFailed, #f14c4c) } .result b { display: block; margin-bottom: 4px } .muted { opacity: .7 } .hint { margin-top: 6px; opacity: .85 }
  .chips { display: flex; gap: 6px; flex-wrap: wrap; margin: 6px 0 2px } .chip { padding: 3px 9px; border-radius: 12px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); cursor: pointer; font-size: 12px } .chip:hover { filter: brightness(1.15) }
  .help { font-size: 12px; opacity: .7; margin-top: 4px } .proto { display: flex; gap: 14px } .proto label { display: flex; gap: 6px; align-items: center; cursor: pointer }
  .toast { position: fixed; bottom: 14px; right: 18px; background: var(--vscode-notifications-background); color: var(--vscode-notifications-foreground); border: 1px solid var(--vscode-notifications-border, #444); padding: 8px 12px; border-radius: 4px; display: none }
</style></head><body>
<h1>Robot connections</h1>
<div class="wrap">
  <div>
    <div class="list" id="list"></div>
    <button class="newbtn" id="new" aria-label="Add a new robot profile">＋ New robot</button>
    <div id="suggest"></div>
    <p class="help">Read-only, and on demand: the extension only reads a file from the controller when you press Get on a panel. Nothing is polled in the background unless you switch auto-refresh on below. Passwords go to the Windows credential store, not to settings.</p>
  </div>
  <div class="card">
    <div class="grid">
      <label>Robot name</label><input type="text" id="name" placeholder="S002R01" maxlength="32">
      <label>IP address</label><input type="text" id="host" placeholder="192.168.0.10">
      <label>Read files over</label><div class="proto"><label><input type="radio" name="proto" value="http" checked> Web server (HTTP) — no login</label><label><input type="radio" name="proto" value="ftp"> FTP — needs user/password</label></div>
      <label>Ports</label><div class="inline">HTTP <input type="number" id="httpPort" value="80" min="1" max="65535"> FTP <input type="number" id="ftpPort" value="21" min="1" max="65535"></div>
      <label id="lUser">FTP user</label><input type="text" id="ftpUser" placeholder="anonymous">
      <label id="lPass">FTP password</label><input type="password" id="ftpPass" placeholder="(unchanged)" autocomplete="off">
      <label>Device</label><input type="text" id="device" value="MD:">
      <label>Auto-connect</label><div><label style="display:flex;gap:6px;align-items:center;cursor:pointer"><input type="checkbox" id="auto"> connect when VS Code opens</label><div class="help">Connecting only checks that the controller answers; it reads no data.</div></div>
      <label>Auto-refresh</label><div><label style="display:flex;gap:6px;align-items:center;cursor:pointer"><input type="checkbox" id="autoRefresh"> keep re-reading what I have opened</label><div class="help">Off by default. The controller generates each diagnostic file on request, so this is continuous load on the robot for as long as VS Code is open.</div></div>
      <label>Refresh every</label><div class="inline"><input type="range" id="poll" min="1000" max="30000" step="500" value="5000" style="flex:1"><span id="pollLabel">5.0 s</span></div>
    </div>
    <div class="actions">
      <button id="test" aria-label="Test the connection to this robot">Test connection</button>
      <button class="primary" id="save" aria-label="Save this robot profile">Save</button>
      <button class="primary" id="saveConnect" aria-label="Save this robot profile and connect">Save &amp; connect</button>
      <span style="flex:1"></span>
      <button id="toggle" style="display:none" aria-label="Connect or disconnect this robot"></button>
      <button class="danger" id="delete" style="display:none" aria-label="Remove this robot profile">Remove</button>
    </div>
    <div class="result" id="result"></div>
  </div>
</div>
<div class="toast" id="toast"></div>
<script>
  const vscode = acquireVsCodeApi();
  const $ = id => document.getElementById(id);
  let profiles = [], current = null; // current = name being edited, null = new
  const fields = ['name','host','httpPort','ftpPort','ftpUser','device'];
  function read() {
    const p = {}; for (const f of fields) p[f] = $(f).value;
    p.useFtp = document.querySelector('input[name=proto]:checked').value === 'ftp';
    p.pollIntervalMs = +$('poll').value; p.autoConnect = $('auto').checked; p.autoRefresh = $('autoRefresh').checked;
    return p;
  }
  function fill(p) {
    for (const f of fields) $(f).value = p?.[f] ?? (f === 'httpPort' ? 80 : f === 'ftpPort' ? 21 : f === 'device' ? 'MD:' : '');
    document.querySelector('input[name=proto][value=' + (p?.useFtp ? 'ftp' : 'http') + ']').checked = true;
    $('poll').value = p?.pollIntervalMs ?? 5000; $('pollLabel').textContent = ((p?.pollIntervalMs ?? 5000) / 1000).toFixed(1) + ' s';
    $('auto').checked = !!p?.autoConnect; $('autoRefresh').checked = !!p?.autoRefresh; $('ftpPass').value = ''; $('ftpPass').placeholder = p ? '(unchanged)' : '';
    $('delete').style.display = p ? '' : 'none';
    $('toggle').style.display = p ? '' : 'none'; if (p) $('toggle').textContent = p.state === 'connected' ? 'Disconnect' : 'Connect';
    $('result').style.display = 'none'; updateProto();
  }
  function updateProto() { const ftp = document.querySelector('input[name=proto]:checked').value === 'ftp'; for (const id of ['lUser','ftpUser','lPass','ftpPass']) $(id).style.opacity = ftp ? '1' : '.45'; }
  function renderList() {
    $('list').innerHTML = profiles.map(p => '<div class="row' + (p.name === current ? ' active' : '') + '" data-n="' + esc(p.name) + '"><span class="dot ' + p.state + '"></span><span class="n">' + esc(p.name) + '</span><span class="h">' + esc(p.host) + (p.info?.version ? ' · ' + esc(p.info.version.split(' ')[0]) : '') + '</span></div>').join('') || '<div class="row muted">No robots yet</div>';
    for (const r of document.querySelectorAll('.row[data-n]')) r.onclick = () => { current = r.dataset.n; fill(profiles.find(p => p.name === current)); renderList(); };
  }
  function esc(s) { return String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
  function toast(t) { const el = $('toast'); el.textContent = t; el.style.display = 'block'; setTimeout(() => el.style.display = 'none', 2500); }
  $('new').onclick = () => { current = null; fill(null); renderList(); $('name').focus(); };
  $('poll').oninput = () => $('pollLabel').textContent = ($('poll').value / 1000).toFixed(1) + ' s';
  for (const r of document.querySelectorAll('input[name=proto]')) r.onchange = updateProto;
  $('test').onclick = () => { $('test').disabled = true; $('test').textContent = 'Testing…'; const res = $('result'); res.className = 'result'; res.style.display = 'block'; res.innerHTML = '<span class="muted">Contacting ' + esc($('host').value) + '…</span>'; vscode.postMessage({ type: 'test', profile: read(), password: $('ftpPass').value || undefined }); };
  $('save').onclick = () => vscode.postMessage({ type: 'save', profile: read(), password: $('ftpPass').value || undefined, originalName: current, connect: false });
  $('saveConnect').onclick = () => vscode.postMessage({ type: 'save', profile: read(), password: $('ftpPass').value || undefined, originalName: current, connect: true });
  $('delete').onclick = () => current && vscode.postMessage({ type: 'delete', name: current });
  $('toggle').onclick = () => { const p = profiles.find(x => x.name === current); if (p) vscode.postMessage({ type: p.state === 'connected' ? 'disconnect' : 'connect', name: p.name }); };
  window.addEventListener('message', e => {
    const m = e.data;
    if (m.type === 'profiles') {
      profiles = m.profiles;
      if (m.select && profiles.some(p => p.name === m.select)) { current = m.select; fill(profiles.find(p => p.name === current)); }
      else if (current && !profiles.some(p => p.name === current)) { current = null; fill(null); }
      else if (current) { const p = profiles.find(x => x.name === current); $('toggle').textContent = p.state === 'connected' ? 'Disconnect' : 'Connect'; }
      renderList();
      $('suggest').innerHTML = m.datasets.length ? '<h2>Found in your backups</h2><div class="chips">' + m.datasets.map(n => '<span class="chip" data-n="' + esc(n) + '">' + esc(n) + '</span>').join('') + '</div><div class="help">Click a name to start a profile for it, then enter its IP.</div>' : '';
      for (const c of document.querySelectorAll('.chip')) c.onclick = () => { current = null; fill(null); $('name').value = c.dataset.n; renderList(); $('host').focus(); };
    }
    if (m.type === 'testResult') {
      $('test').disabled = false; $('test').textContent = 'Test connection';
      const res = $('result'); res.style.display = 'block';
      if (m.ok) {
        res.className = 'result ok';
        res.innerHTML = '<b>✓ Connected in ' + m.ms + ' ms</b>' + esc([m.info.application, m.info.version].filter(Boolean).join(' ')) + (m.info.fNumber ? ' · F# ' + esc(m.info.fNumber) : '') + (m.info.robotName ? ' · robot name <b style="display:inline">' + esc(m.info.robotName) + '</b>' : '') + '<div class="hint muted">Clock on controller: ' + esc(m.info.date ?? '?') + '</div>';
        if (!$('name').value && m.info.robotName) $('name').value = m.info.robotName;
      } else {
        res.className = 'result bad';
        res.innerHTML = '<b>✗ Could not connect (' + m.ms + ' ms)</b>' + esc(m.error) + '<div class="hint">' + esc(m.hint) + '</div>';
      }
    }
    if (m.type === 'saved') { current = m.name; toast('Saved ' + m.name); }
    if (m.type === 'error') { toast(m.text); }
  });
  fill(null); vscode.postMessage({ type: 'ready' });
</script></body></html>`;
}
