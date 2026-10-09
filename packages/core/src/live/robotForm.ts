/**
 * Robot connection form: one webview to add, edit, test and remove robot profiles.
 *
 * FANUC's fields are the form's own. Another brand (connectionKinds.ts) brings its fields and
 * its store, and the form shows a FANUC / <brand> selector: the list holds every brand's
 * controllers, each tagged, and "New controller" starts one of the selected brand.
 */
import * as vscode from 'vscode';
import type { Services } from '../services';
import { RobotManager } from './robotManager';
import type { RobotProfile } from './types';
import { WEBVIEW_BASE_CSS } from '../webviewStyle';
import { connectionHint } from './connectionHints';
import { parseControllerInfo } from './parsers';
import { connectionKind, connectionKinds, onDidChangeConnectionKinds, type ConnectionKind } from './connectionKinds';

let panel: vscode.WebviewPanel | undefined;

/** `brand` picks the selector ('fanuc' or a registered kind); `editName` selects that controller */
export function openRobotForm(ctx: vscode.ExtensionContext, s: Services, robots: RobotManager, editName?: string, brand?: string) {
  const state = (select?: { brand: string; name?: string }) => ({ type: 'profiles', brands: brandsForView(), profiles: profilesForView(robots), datasets: datasetSuggestions(s, robots), select });
  const initial = { brand: brand && connectionKind(brand) ? brand : 'fanuc', name: editName };
  if (!panel) {
    panel = vscode.window.createWebviewPanel('robotCode.robotForm', 'Robot Connections', vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
    panel.onDidDispose(() => { panel = undefined; });
    ctx.subscriptions.push(panel);
    const push = () => { if (panel) void panel.webview.postMessage(state()); };
    let kindSubs: vscode.Disposable[] = [];
    const watchKinds = () => { for (const d of kindSubs) d.dispose(); kindSubs = connectionKinds().map(k => k.onDidChange(push)); };
    watchKinds();
    const subs = [robots.onDidChange(push), onDidChangeConnectionKinds(() => { watchKinds(); push(); })];
    panel.onDidDispose(() => { for (const d of [...subs, ...kindSubs]) d.dispose(); });

    panel.webview.onDidReceiveMessage(async (m: any) => {
      try {
        const kind = m.brand && m.brand !== 'fanuc' ? connectionKind(m.brand) : undefined;
        if (m.brand && m.brand !== 'fanuc' && !kind) throw new Error(`${m.brand} controllers are not available (is that brand turned on?).`);
        if (kind) { await kindMessage(kind, m); return; }
        switch (m.type) {
          case 'ready': await panel!.webview.postMessage(state(initial)); break;
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
  if (editName || brand) void panel.webview.postMessage(state(initial));
}

/** a message about another brand's controller: that brand does the work */
async function kindMessage(kind: ConnectionKind, m: any) {
  const post = (x: unknown) => panel?.webview.postMessage(x);
  switch (m.type) {
    case 'test': {
      const r = await kind.test(m.profile ?? {}, m.password || undefined, m.originalName || undefined);
      await post({ type: 'kindTestResult', ...r });
      break;
    }
    case 'save': {
      const name = await kind.save(m.profile ?? {}, m.password || undefined, m.originalName || undefined);
      await post({ type: 'saved', brand: kind.id, name });
      if (m.connect) { try { await kind.connect(name); } catch (e: any) { await post({ type: 'error', text: `${name}: ${e?.message ?? e}` }); } }
      break;
    }
    case 'delete': {
      const ok = await vscode.window.showWarningMessage(`Remove ${kind.label} controller "${m.name}" and forget its password?`, { modal: true }, 'Remove');
      if (ok) await kind.remove(m.name);
      break;
    }
    case 'connect': try { await kind.connect(m.name); } catch (e: any) { await post({ type: 'error', text: `${m.name}: ${e?.message ?? e}` }); } break;
    case 'disconnect': await kind.disconnect(m.name); break;
  }
}

function brandsForView() {
  return [{ id: 'fanuc', label: 'FANUC' }, ...connectionKinds().map(k => ({ id: k.id, label: k.label, fields: k.fields(), defaults: k.defaults(), note: k.note }))];
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
  const fanuc = robots.list().map(c => ({ ...c.profile, brand: 'fanuc', state: c.state, error: c.error, info: c.snapshot?.info, detail: c.snapshot?.info?.version?.split(' ')[0] }));
  const others = connectionKinds().flatMap(k => k.list().map(r => ({ brand: k.id, name: r.name, host: r.host, state: r.state, detail: r.detail, profile: r.profile })));
  return [...fanuc, ...others];
}

/** robot names seen in backup folders but not yet configured → quick prefill chips */
function datasetSuggestions(s: Services, robots: RobotManager): string[] {
  const have = new Set([...robots.list().map(c => c.profile.name), ...connectionKinds().flatMap(k => k.list().map(r => r.name))].map(n => n.toUpperCase()));
  return [...new Set(s.data.datasets.map(d => d.name))].filter(n => !have.has(n.toUpperCase()) && !/^\d{4}-/.test(n)).sort();
}

function hintFor(err: string, p: RobotProfile): string {
  return connectionHint(err, p) ?? 'See the RUKUS Robotic Extensions output channel for the full log.';
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
  .brandsel { display: flex; gap: 0; margin: 0 0 14px; border: 1px solid var(--vscode-panel-border, #444); border-radius: 4px; overflow: hidden; width: max-content } .brandsel button { border-radius: 0; padding: 6px 18px; background: transparent; color: var(--vscode-foreground); font-weight: 600; letter-spacing: .03em } .brandsel button + button { border-left: 1px solid var(--vscode-panel-border, #444) } .brandsel button.on { background: var(--vscode-button-background); color: var(--vscode-button-foreground) }
  .tag { font-size: 10px; font-weight: 700; letter-spacing: .04em; padding: 1px 5px; border-radius: 3px; border: 1px solid currentColor; opacity: .8; flex: none } .tag.fanuc { color: var(--vscode-charts-yellow, #d7ba2f) } .tag.abb { color: var(--vscode-charts-red, #f14c4c) }
  .toast { position: fixed; bottom: 14px; right: 18px; background: var(--vscode-notifications-background); color: var(--vscode-notifications-foreground); border: 1px solid var(--vscode-notifications-border, #444); padding: 8px 12px; border-radius: 4px; display: none }
</style></head><body>
<h1>Robot connections</h1>
<div class="wrap">
  <div>
    <div class="list" id="list"></div>
    <button class="newbtn" id="new" aria-label="Add a new robot profile">＋ New robot</button>
    <div id="suggest"></div>
    <p class="help">Read-only, and on demand: the extension only reads from a controller when you press Get (or Connect, or open a file from it). Nothing is polled in the background unless you switch auto-refresh on. Passwords go to the Windows credential store, not to settings.</p>
  </div>
  <div class="card">
    <div class="brandsel" id="brandsel" role="tablist" aria-label="Controller brand"></div>
    <div class="grid" id="fanucGrid">
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
    <div class="grid" id="kindGrid" style="display:none"></div>
    <p class="help" id="kindNote" style="display:none"></p>
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
  // brand = the selector; current = name being edited in that brand, null = new
  let profiles = [], brands = [{ id: 'fanuc', label: 'FANUC' }], brand = 'fanuc', current = null;
  const fields = ['name','host','httpPort','ftpPort','ftpUser','device'];
  const kind = () => brands.find(b => b.id === brand);
  const isFanuc = () => brand === 'fanuc';
  const profileOf = (b, n) => profiles.find(p => p.brand === b && p.name === n);
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
    updateProto();
  }
  // another brand's fields, built from what it registered
  function buildKind() {
    const k = kind();
    $('kindGrid').innerHTML = (k.fields || []).map(f => {
      const id = 'k_' + f.key, help = f.help ? '<div class="help">' + esc(f.help) + '</div>' : '';
      let input;
      if (f.type === 'checkbox') input = '<div><label style="display:flex;gap:6px;align-items:center;cursor:pointer"><input type="checkbox" id="' + id + '"> ' + esc(f.placeholder || '') + '</label>' + help + '</div>';
      else if (f.type === 'select') input = '<div><select id="' + id + '">' + (f.options || []).map(o => '<option value="' + esc(o.value) + '">' + esc(o.label) + '</option>').join('') + '</select>' + help + '</div>';
      else input = '<div><input type="' + f.type + '" id="' + id + '" placeholder="' + esc(f.placeholder || '') + '" autocomplete="off">' + help + '</div>';
      return '<label for="' + id + '">' + esc(f.label) + '</label>' + input;
    }).join('');
    for (const f of k.fields || []) if (f.type === 'select') $('k_' + f.key).onchange = e => {
      const o = (f.options || []).find(x => x.value === e.target.value);
      if (o && o.sets) setKindValues(o.sets);
    };
    $('kindNote').textContent = k.note || ''; $('kindNote').style.display = k.note ? '' : 'none';
  }
  function setKindValues(v) {
    for (const f of kind().fields || []) {
      if (!(f.key in v) || f.type === 'password') continue;
      const el = $('k_' + f.key); if (!el) continue;
      if (f.type === 'checkbox') el.checked = !!v[f.key]; else el.value = v[f.key] ?? '';
    }
  }
  function fillKind(p) {
    buildKind();
    const k = kind(), v = p ? p.profile : (k.defaults || {});
    for (const f of k.fields || []) {
      const el = $('k_' + f.key);
      if (f.type === 'password') { el.value = ''; el.placeholder = p ? '(unchanged)' : (f.placeholder || ''); }
      else if (f.type === 'checkbox') el.checked = !!v[f.key];
      else el.value = v[f.key] ?? '';
    }
  }
  function readKind() {
    const profile = {}; let password;
    for (const f of kind().fields || []) {
      const el = $('k_' + f.key);
      if (f.type === 'password') password = el.value || undefined;
      else if (f.type === 'checkbox') profile[f.key] = el.checked;
      else if (f.type === 'number') { if (el.value.trim() !== '') profile[f.key] = +el.value; }
      else profile[f.key] = el.value.trim();
    }
    return { profile, password };
  }
  function renderBrands() {
    const el = $('brandsel');
    el.style.display = brands.length > 1 ? '' : 'none';
    el.innerHTML = brands.map(b => '<button role="tab" aria-selected="' + (b.id === brand) + '" data-b="' + esc(b.id) + '" class="' + (b.id === brand ? 'on' : '') + '">' + esc(b.label) + '</button>').join('');
    for (const btn of el.querySelectorAll('button')) btn.onclick = () => { if (btn.dataset.b !== brand) { brand = btn.dataset.b; current = null; show(null); renderList(); } };
  }
  // the form for p (null = a new controller) in the selected brand
  function show(p) {
    renderBrands();
    $('fanucGrid').style.display = isFanuc() ? '' : 'none'; $('kindGrid').style.display = isFanuc() ? 'none' : '';
    if (isFanuc()) { fill(p); $('kindNote').style.display = 'none'; } else fillKind(p);
    $('delete').style.display = p ? '' : 'none';
    $('toggle').style.display = p ? '' : 'none'; if (p) $('toggle').textContent = p.state === 'connected' ? 'Disconnect' : 'Connect';
    $('result').style.display = 'none';
  }
  function nameInput() { return isFanuc() ? $('name') : $('k_name'); }
  function updateProto() { const ftp = document.querySelector('input[name=proto]:checked').value === 'ftp'; for (const id of ['lUser','ftpUser','lPass','ftpPass']) $(id).style.opacity = ftp ? '1' : '.45'; }
  function renderList() {
    const tagged = brands.length > 1;
    $('list').innerHTML = profiles.map(p => '<div class="row' + (p.name === current && p.brand === brand ? ' active' : '') + '" data-b="' + esc(p.brand) + '" data-n="' + esc(p.name) + '"><span class="dot ' + p.state + '"></span>' + (tagged ? '<span class="tag ' + esc(p.brand) + '">' + esc((brands.find(b => b.id === p.brand) || {}).label || p.brand) + '</span>' : '') + '<span class="n">' + esc(p.name) + '</span><span class="h">' + esc(p.host) + (p.detail ? ' · ' + esc(p.detail) : '') + '</span></div>').join('') || '<div class="row muted">No controllers yet</div>';
    for (const r of document.querySelectorAll('.row[data-n]')) r.onclick = () => { brand = r.dataset.b; current = r.dataset.n; show(profileOf(brand, current)); renderList(); };
  }
  function esc(s) { return String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
  function toast(t) { const el = $('toast'); el.textContent = t; el.style.display = 'block'; setTimeout(() => el.style.display = 'none', 4000); }
  function send(type, extra) {
    if (isFanuc()) vscode.postMessage(Object.assign({ type, profile: read(), password: $('ftpPass').value || undefined, originalName: current }, extra));
    else { const k = readKind(); vscode.postMessage(Object.assign({ type, brand, profile: k.profile, password: k.password, originalName: current }, extra)); }
  }
  $('new').onclick = () => { current = null; show(null); renderList(); nameInput().focus(); };
  $('poll').oninput = () => $('pollLabel').textContent = ($('poll').value / 1000).toFixed(1) + ' s';
  for (const r of document.querySelectorAll('input[name=proto]')) r.onchange = updateProto;
  $('test').onclick = () => {
    $('test').disabled = true; $('test').textContent = 'Testing…';
    const res = $('result'); res.className = 'result'; res.style.display = 'block';
    res.innerHTML = '<span class="muted">Contacting ' + esc(isFanuc() ? $('host').value : ($('k_host') || {}).value) + '…</span>';
    send('test');
  };
  $('save').onclick = () => send('save', { connect: false });
  $('saveConnect').onclick = () => send('save', { connect: true });
  $('delete').onclick = () => current && vscode.postMessage({ type: 'delete', brand, name: current });
  $('toggle').onclick = () => { const p = profileOf(brand, current); if (p) vscode.postMessage({ type: p.state === 'connected' ? 'disconnect' : 'connect', brand, name: p.name }); };
  function testDone() { $('test').disabled = false; $('test').textContent = 'Test connection'; const res = $('result'); res.style.display = 'block'; return res; }
  window.addEventListener('message', e => {
    const m = e.data;
    if (m.type === 'profiles') {
      profiles = m.profiles;
      if (m.brands) brands = m.brands;
      if (!brands.some(b => b.id === brand)) { brand = 'fanuc'; current = null; show(null); }
      if (m.select) {
        brand = brands.some(b => b.id === m.select.brand) ? m.select.brand : 'fanuc';
        const p = m.select.name ? profileOf(brand, m.select.name) : undefined;
        current = p ? p.name : null; show(p || null);
      }
      else if (current && !profileOf(brand, current)) { current = null; show(null); }
      else if (current) { const p = profileOf(brand, current); $('toggle').textContent = p.state === 'connected' ? 'Disconnect' : 'Connect'; renderBrands(); }
      else renderBrands();
      renderList();
      $('suggest').innerHTML = m.datasets.length ? '<h2>Found in your backups</h2><div class="chips">' + m.datasets.map(n => '<span class="chip" data-n="' + esc(n) + '">' + esc(n) + '</span>').join('') + '</div><div class="help">Click a name to start a controller for it in the brand selected on the right, then enter its IP.</div>' : '';
      for (const c of document.querySelectorAll('.chip')) c.onclick = () => { current = null; show(null); nameInput().value = c.dataset.n; renderList(); (isFanuc() ? $('host') : $('k_host')).focus(); };
    }
    if (m.type === 'testResult') {
      const res = testDone();
      if (m.ok) {
        res.className = 'result ok';
        res.innerHTML = '<b>✓ Connected in ' + m.ms + ' ms</b>' + esc([m.info.application, m.info.version].filter(Boolean).join(' ')) + (m.info.fNumber ? ' · F# ' + esc(m.info.fNumber) : '') + (m.info.robotName ? ' · robot name <b style="display:inline">' + esc(m.info.robotName) + '</b>' : '') + '<div class="hint muted">Clock on controller: ' + esc(m.info.date ?? '?') + '</div>';
        if (!$('name').value && m.info.robotName) $('name').value = m.info.robotName;
      } else {
        res.className = 'result bad';
        res.innerHTML = '<b>✗ Could not connect (' + m.ms + ' ms)</b>' + esc(m.error) + '<div class="hint">' + esc(m.hint) + '</div>';
      }
    }
    if (m.type === 'kindTestResult') {
      const res = testDone();
      res.className = 'result ' + (m.ok ? 'ok' : 'bad');
      res.innerHTML = '<b>' + (m.ok ? '✓ Connected in ' : '✗ Could not connect (') + m.ms + ' ms' + (m.ok ? '' : ')') + '</b>' + esc(m.text) + (m.hint ? '<div class="hint">' + esc(m.hint) + '</div>' : '');
      if (m.ok && m.suggestedName && $('k_name') && !$('k_name').value) $('k_name').value = m.suggestedName;
    }
    if (m.type === 'saved') { brand = m.brand || 'fanuc'; current = m.name; toast('Saved ' + m.name); renderList(); }
    if (m.type === 'error') { toast(m.text); }
  });
  show(null); vscode.postMessage({ type: 'ready' });
</script></body></html>`;
}
