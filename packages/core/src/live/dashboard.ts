/**
 * The robot page: one webview per robot - status, running task, position, tasks, I/O
 * and registers.
 *
 * IT DOES NOT POLL, and that is the whole difference from the 0.5.x version of this file.
 * That one pushed state on a 1 s setInterval on top of a 2 s controller poll, so simply
 * leaving the page open kept a robot generating .DG files forever. Now every card is a
 * Get button, each card says how old its reading is, and the page redraws only when the
 * snapshot actually changes. Auto-refresh is still available, per robot, off by default.
 *
 * Alarm history is not here: it lives in RUKUS, and the button says so.
 */
import * as vscode from 'vscode';
import type { Services } from '../services';
import type { RobotManager, RobotConnection } from './robotManager';
import { fmtCart } from './parsers';
import { openRobotForm } from './robotForm';
import { findUses } from '../views/findUses';
import { config } from '../util';
import { WEBVIEW_BASE_CSS, LIST_LIMIT_JS } from '../webviewStyle';

const panels = new Map<string, vscode.WebviewPanel>();

export function openDashboard(ctx: vscode.ExtensionContext, s: Services, robots: RobotManager, name: string) {
  let panel = panels.get(name);
  if (!panel) {
    panel = vscode.window.createWebviewPanel('robotCode.dashboard', `${name}`, vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
    panels.set(name, panel);
    panel.onDidDispose(() => panels.delete(name));
    ctx.subscriptions.push(panel);
    panel.webview.html = html(name);

    const push = () => { const c = robots.get(name); if (panel && c) void panel.webview.postMessage({ type: 'state', state: serialize(c) }); };

    // Only when something actually changed. No timer: the ages on the page are recomputed
    // in the webview from the timestamps it already has, which costs the robot nothing.
    const sub = robots.onDidChange(n => { if (!n || n === name) push(); });
    panel.onDidDispose(() => sub.dispose());

    panel.webview.onDidReceiveMessage(async (m: any) => {
      switch (m.type) {
        case 'ready': push(); break;
        case 'connect': await vscode.commands.executeCommand('robotCode.live.connect', name); break;
        case 'disconnect': robots.disconnect(name); break;
        case 'refresh': await vscode.commands.executeCommand('robotCode.live.refresh', name); break;
        case 'getAll': await vscode.commands.executeCommand('robotCode.live.getAll', name); break;
        case 'getPosition': await vscode.commands.executeCommand('robotCode.live.getPosition', name); break;
        case 'getTasks': await vscode.commands.executeCommand('robotCode.live.getTasks', name); break;
        case 'getRegisters': await vscode.commands.executeCommand('robotCode.live.getRegisters', name); break;
        case 'getIo': await vscode.commands.executeCommand('robotCode.live.getIo', name); break;
        case 'getInfo': await vscode.commands.executeCommand('robotCode.live.getInfo', name); break;
        case 'toggleAuto': await vscode.commands.executeCommand('robotCode.live.toggleAutoRefresh', name); break;
        case 'edit': openRobotForm(ctx, s, robots, name); break;
        case 'backup': await vscode.commands.executeCommand('robotCode.live.pullBackup', name); break;
        case 'snapshot': await vscode.commands.executeCommand('robotCode.data.snapshotFromRobot', name); break;
        case 'compare': await vscode.commands.executeCommand('robotCode.live.compareWithRobot'); break;
        case 'openFile': await vscode.commands.executeCommand('robotCode.live.openRobotFile', name, m.file); break;
        case 'registers': await vscode.commands.executeCommand('robotCode.data.openRegisterTable'); break;
        case 'taskLine': await vscode.commands.executeCommand('robotCode.live.openTaskLine', name, m.program, m.line, m.kind); break;
        case 'findUses': await findUses(m.kind, m.index); break;
        case 'revealRunning': await vscode.commands.executeCommand('robotCode.live.revealRunning'); break;
        case 'rukusMonitor': await vscode.commands.executeCommand('robotCode.rukus.monitor', name); break;
        case 'rukusAlarms': await vscode.commands.executeCommand('robotCode.rukus.alarms', name); break;
        // the option list is read by the brand (FANUC: MD:ORDERFIL.DAT); the page only shows it
        case 'getOptions': await vscode.commands.executeCommand('robotCode.live.getOptions', name).then(undefined, () => undefined); break;
        case 'showOptions': await vscode.commands.executeCommand('robotCode.live.showOptions', name).then(undefined, () => undefined); break;
      }
    });
  }
  panel.reveal();
}

function serialize(c: RobotConnection) {
  const s = c.snapshot;
  const p = c.profile;
  const at = (k: string) => s?.fetchedAt.get(k as any);
  return {
    name: p.name, host: p.host, port: p.useFtp ? p.ftpPort : p.httpPort, proto: p.useFtp ? 'FTP' : 'HTTP',
    poll: p.pollIntervalMs, autoRefresh: p.autoRefresh,
    state: c.state, error: c.error,
    staleMs: Math.max(5, config<number>('live.staleAfterSeconds', 60)) * 1000,
    traffic: { ...c.traffic },
    // per-card timestamps, so each card can say how old it is and which are unread
    fetched: {
      info: at('info'), position: at('position'), tasks: at('tasks'),
      numregs: at('numregs'), io: at('io'), strregs: at('strregs'), posregs: at('posregs'),
      options: s?.optionsAt,
    },
    options: s?.options?.length ?? 0,
    optionHighlights: s?.optionHighlights ?? [],
    info: s?.info ?? {},
    position: s?.position ? { ...s.position, ufText: s.position.userFrame ? fmtCart(s.position.userFrame) : undefined, worldText: s.position.world ? fmtCart(s.position.world) : undefined } : undefined,
    tasks: s?.tasks ?? [],
    io: s ? [...s.io.values()].map(x => ({ k: x.kind, i: x.index, v: x.value, s: x.simulated, c: x.comment })) : [],
    regs: s ? [...s.numregs.entries()].map(([i, r]) => ({ i, v: r.value, c: r.comment })).filter(r => r.c || (r.v !== 0 && r.v !== '0')) : [],
    strregs: s ? [...s.strregs.entries()].map(([i, r]) => ({ i, v: r.value, c: r.comment })).filter(r => r.c || r.v) : [],
    posregs: s ? [...s.posregs.entries()].map(([i, r]) => ({ i, c: r.comment, k: r.kind, t: r.summary })).filter(r => r.c || r.k !== 'uninit') : [],
    errors: s ? [...s.errors.entries()] : [],
  };
}

/** the robot page's look, shared by every brand's controller page */
export const ROBOT_PAGE_CSS = `  :root { --ok: var(--vscode-testing-iconPassed, #3fb950); --bad: var(--vscode-testing-iconFailed, #f14c4c); --warn: var(--vscode-charts-yellow, #f6c343); --blue: var(--vscode-charts-blue, #61afef); --purple: var(--vscode-charts-purple, #c678dd); --orange: var(--vscode-charts-orange, #d19a66); --green: var(--vscode-charts-green, #98c379); --muted: var(--vscode-descriptionForeground); --line: var(--vscode-panel-border, #444); --card: var(--vscode-editorWidget-background) }
  body { padding: 0 18px 24px }
  .head { position: sticky; top: 0; z-index: 3; background: var(--vscode-editor-background); padding: 14px 0 10px; border-bottom: 1px solid var(--line); display: flex; align-items: center; gap: 14px; flex-wrap: wrap }
  .head h1 { font-size: 20px; margin: 0; display: flex; align-items: center; gap: 10px; color: var(--warn) } .dot { width: 12px; height: 12px; border-radius: 50%; background: var(--muted); box-shadow: 0 0 0 3px color-mix(in srgb, var(--muted) 25%, transparent) } .dot.connected { background: var(--ok); box-shadow: 0 0 0 3px color-mix(in srgb, var(--ok) 25%, transparent) } .dot.error { background: var(--bad) } .dot.connecting { background: var(--warn) }
  .head .sub { color: var(--muted); font-size: 12px } .head .sub b { color: var(--vscode-foreground); font-weight: 600 }
  .spacer { flex: 1 } .btns { display: flex; gap: 6px; flex-wrap: wrap }
  button { border-radius: 4px }
  button.get { padding: 2px 9px; font-size: 11px; border-radius: 10px }
  button.on { background: var(--ok); color: #04260d }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 14px; margin-top: 14px }
  .card { background: var(--card); border: 1px solid var(--line); border-top: 3px solid var(--muted); border-radius: 8px; padding: 12px 14px; min-width: 0 } .card.run { border-top-color: var(--ok) } .card.pos { border-top-color: var(--blue) } .card.tsk { border-top-color: var(--purple) } .card.io { border-top-color: var(--green) } .card.reg { border-top-color: var(--orange) } .card.err { border-top-color: var(--bad) } .card.ruk { border-top-color: var(--warn) }
  .card h2 .ic { width: 8px; height: 8px; border-radius: 2px; display: inline-block; background: var(--muted) } .card.run h2 .ic { background: var(--ok) } .card.pos h2 .ic { background: var(--blue) } .card.tsk h2 .ic { background: var(--purple) } .card.io h2 .ic { background: var(--green) } .card.reg h2 .ic { background: var(--orange) } .card.ruk h2 .ic { background: var(--warn) }
  .card h2 { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin: 0 0 10px; display: flex; align-items: center; gap: 8px } .card h2 .n { margin-left: auto; font-weight: 600; color: var(--vscode-foreground); text-transform: none; letter-spacing: 0; display: flex; align-items: center; gap: 8px }
  .card h2.fold { cursor: pointer; user-select: none } .card h2.fold:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px }
  .card h2 .chev { display: inline-block; width: 10px; transition: transform .12s; opacity: .7 } .card.folded h2 .chev { transform: rotate(-90deg) }
  .card.folded > :not(h2) { display: none } .card.folded h2 { margin: 0 }
  .card.wide { grid-column: 1 / -1 }
  .age { font-weight: 400; color: var(--muted); font-size: 11px } .age.stale { color: var(--warn) }
  .unread { color: var(--muted); padding: 18px 0; text-align: center } .unread button { margin-top: 8px }
  .big { font-size: 22px; font-weight: 600; font-family: var(--vscode-editor-font-family, monospace) } .big small { font-size: 12px; color: var(--muted); font-family: var(--vscode-font-family); font-weight: 400; margin-left: 8px }
  .pill { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; background: var(--muted); color: #fff } .pill.RUNNING { background: var(--ok) } .pill.PAUSED, .pill.PAUSING { background: var(--warn) } .pill.ABORTED, .pill.ABORTING { background: var(--muted) }
  table { width: 100%; border-collapse: collapse; font-size: 12.5px } th { text-align: left; color: var(--muted); font-weight: 600; padding: 4px 6px; border-bottom: 1px solid var(--line) } td { padding: 4px 6px; border-bottom: 1px solid color-mix(in srgb, var(--line) 50%, transparent); vertical-align: top } tr:last-child td { border-bottom: 0 } tr.click { cursor: pointer } tr.click:hover td { background: var(--vscode-list-hoverBackground) }
  .mono { font-family: var(--vscode-editor-font-family, monospace) } .num { text-align: right; font-family: var(--vscode-editor-font-family, monospace); color: var(--orange) } .muted { color: var(--muted) } .prog { color: var(--warn); font-family: var(--vscode-editor-font-family, monospace) }
  .axes { display: grid; grid-template-columns: repeat(auto-fit, minmax(96px, 1fr)); gap: 6px } .ax { background: var(--vscode-editor-background); border-radius: 6px; padding: 6px 8px; text-align: center; min-width: 0; border-left: 3px solid var(--muted) } .ax .l { font-size: 10px; color: var(--muted); font-weight: 600; letter-spacing: .04em } .ax .v { font-family: var(--vscode-editor-font-family, monospace); font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis } .ax.xyz { border-left-color: var(--blue) } .ax.xyz .v { color: var(--blue) } .ax.wpr { border-left-color: var(--purple) } .ax.wpr .v { color: var(--purple) } .ax.j { border-left-color: var(--orange) } .ax.j .v { color: var(--orange) } .ax.e { border-left-color: var(--green) } .ax.e .v { color: var(--green) }
  .poslabel { font-size: 11px; color: var(--muted); margin: 10px 0 4px; text-transform: uppercase; letter-spacing: .05em }
  .tools { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; flex-wrap: wrap } input[type=search], select { padding: 5px 8px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); border-radius: 4px } input[type=search] { flex: 1; min-width: 160px }
  .card.opt { border-top-color: var(--purple) } .card.opt h2 .ic { background: var(--purple) }
  .optl { display: flex; flex-direction: column; gap: 7px } .optrow { display: flex; gap: 8px; align-items: baseline; font-size: 12.5px } .optrow .muted { font-size: 11px }
  .mark { width: 12px; flex: none; text-align: center; font-weight: 700 } .mark.ok { color: var(--ok) } .mark.no { color: var(--bad) } .mark.fact { color: var(--muted) }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; max-height: 320px; overflow: auto } .chip { display: inline-flex; align-items: center; gap: 6px; padding: 3px 8px 3px 6px; border-radius: 14px; background: var(--vscode-editor-background); border: 1px solid var(--line); font-size: 11.5px; cursor: pointer; white-space: nowrap } .chip:hover { border-color: var(--vscode-focusBorder) } .chip .led { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); flex: none } .chip.on .led { background: var(--ok); box-shadow: 0 0 6px var(--ok) } .chip.sim .led { outline: 2px dashed var(--warn) } .chip .k { font-family: var(--vscode-editor-font-family, monospace); color: var(--blue) } .chip.on .k { color: var(--green) } .chip .c { max-width: 160px; overflow: hidden; text-overflow: ellipsis }
  .empty { color: var(--muted); padding: 10px 0 } .err { color: var(--bad) }
  .note { color: var(--muted); font-size: 11.5px; margin-top: 10px }
`;

function html(name: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${WEBVIEW_BASE_CSS}
${ROBOT_PAGE_CSS}</style></head><body>
<div class="head">
  <h1><span class="dot" id="dot"></span><span id="name">${name}</span></h1>
  <div class="sub" id="sub">…</div>
  <div class="spacer"></div>
  <div class="btns">
    <button class="primary" id="toggle" aria-label="Connect to or disconnect from the robot">Connect</button>
    <button id="refresh" title="Re-read only the cards that already have data" aria-label="Refresh the cards that already have data">Refresh</button>
    <button id="getAll" title="Read every panel from the controller, once" aria-label="Read all panels from the controller once">Read all</button>
    <button id="toggleAuto" title="Keep re-reading what is already loaded" aria-label="Toggle automatic re-reading">Auto</button>
    <button id="edit" title="Connection settings" aria-label="Edit connection settings">Edit…</button>
    <button id="backup" title="Download programs and data to a folder" aria-label="Back up programs and data to a folder">Backup…</button>
    <button id="snapshot" title="Overwrite the robot container's snapshot from this controller, with its metadata" aria-label="Snapshot from the robot">Snapshot…</button>
    <button id="compare" title="Diff the open program against the robot's copy" aria-label="Compare the open program with the robot">Compare…</button>
    <button id="openFile" title="Open a file from the controller" aria-label="Open a file from the controller">Open file…</button>
  </div>
</div>
<div id="body"><div class="rc-empty" role="status"><b>Not connected</b><p>Press Connect to start.</p></div></div>
<script>
  const vscode = acquireVsCodeApi();
  const folded = new Set((vscode.getState() || {}).folded || []);
${LIST_LIMIT_JS}
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  let st = null, ioQuery = '', ioKind = '', regQuery = '';
  for (const id of ['refresh','edit','backup','snapshot','openFile','getAll','toggleAuto','compare']) $(id).onclick = () => vscode.postMessage({ type: id });
  $('toggle').onclick = () => vscode.postMessage({ type: st && st.state === 'connected' ? 'disconnect' : 'connect' });
  const fmt = n => (Math.round(n * 100) / 100).toFixed(2);
  const ago = at => { const s = Math.round((Date.now() - at) / 1000); return s < 60 ? s + ' s ago' : s < 3600 ? Math.round(s / 60) + ' min ago' : Math.round(s / 3600) + ' h ago'; };
  const bytes = n => n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' kB' : (n / 1048576).toFixed(1) + ' MB';
  // Every card header carries the age of its own reading, and an unread card says so
  // rather than showing an empty table that looks like "the robot has nothing".
  const stamp = k => { const at = st.fetched[k]; if (!at) return ''; const old = Date.now() - at > st.staleMs; return '<span class="age' + (old ? ' stale' : '') + '" data-at="' + at + '">' + ago(at) + '</span>'; };
  // The ages count up by themselves. Only their text is touched - no re-render (a search box
  // keeps its focus) and no message to the extension, so nothing is read from the robot.
  setInterval(() => { if (!st) return; for (const el of document.querySelectorAll('.age[data-at]')) { const at = +el.dataset.at; el.textContent = ago(at); el.classList.toggle('stale', Date.now() - at > st.staleMs); } }, 5000);
  const getBtn = (what, label) => '<button class="get" data-get="' + what + '" aria-label="Read ' + what + ' from the robot">' + (label || 'Get') + '</button>';
  const unread = (what, text) => '<div class="unread">' + esc(text) + '<br>' + getBtn(what, 'Read it now') + '</div>';
  function render() {
    if (!st) return;
    $('dot').className = 'dot ' + st.state;
    $('sub').innerHTML = '<b>' + esc(st.host) + '</b> · ' + st.proto + ' ' + st.port
      + (st.info.application ? ' · <b>' + esc(st.info.application) + '</b> ' + esc(st.info.version ?? '') : '')
      + (st.info.fNumber ? ' · F# ' + esc(st.info.fNumber) : '')
      + (st.traffic && st.traffic.requests ? ' · <span title="What this extension has asked of the controller since VS Code started">' + st.traffic.requests + ' request' + (st.traffic.requests === 1 ? '' : 's') + ', ' + bytes(st.traffic.bytes) + '</span>' : '')
      + (st.error ? ' · <span class="err">' + esc(st.error) + '</span>' : '');
    $('toggle').textContent = st.state === 'connected' ? 'Disconnect' : st.state === 'connecting' ? 'Connecting…' : 'Connect';
    $('toggle').disabled = st.state === 'connecting';
    for (const id of ['refresh','backup','snapshot','openFile','getAll','toggleAuto','compare']) $(id).disabled = st.state !== 'connected';
    $('toggleAuto').textContent = st.autoRefresh ? 'Auto ' + (st.poll / 1000).toFixed(0) + 's' : 'Auto off';
    $('toggleAuto').className = st.autoRefresh ? 'on' : '';
    if (st.state !== 'connected') { $('body').innerHTML = '<div class="rc-empty" role="status"><b>' + (st.state === 'connecting' ? 'Connecting…' : st.state === 'error' ? 'Connection problem' : 'Not connected') + '</b><p>' + esc(st.error ?? 'Press Connect to start.') + '</p></div>'; return; }
    const running = st.tasks.filter(t => (t.status === 'RUNNING' || t.status === 'PAUSED' || t.status === 'PAUSING') && t.current);
    const pos = st.position;
    const kinds = [...new Set(st.io.map(x => x.k))].sort();
    const q = ioQuery.toLowerCase();
    const io = st.io.filter(x => (!ioKind || x.k === ioKind) && (!q || (x.k + '[' + x.i + ']').toLowerCase().includes(q) || x.c.toLowerCase().includes(q)));
    const ioList = q || ioKind ? io : io.filter(x => x.v === 'ON' || typeof x.v === 'number' && x.v !== 0);
    const ioShown = rcSlice('io', ioList, 100);
    const rq = regQuery.toLowerCase();
    const regList = st.regs.filter(r => !rq || ('r[' + r.i + ']').includes(rq) || r.c.toLowerCase().includes(rq));
    const regs = rcSlice('reg', regList, 50);
    const tasks = rcSlice('tsk', st.tasks, 50);
    $('body').innerHTML = \`
      <div class="grid">
        <div class="card run"><h2><span class="ic"></span>Running<span class="n">\${stamp('tasks')} \${getBtn('getTasks')}</span></h2>\${!st.fetched.tasks ? unread('getTasks', 'Program state has not been read.') : running.length ? running.map(t => '<div class="big"><span class="pill ' + t.status + '">' + t.status + '</span> <span class="prog" style="margin-left:8px">' + esc(t.current.program) + '</span><small>line ' + t.current.line + ' · task ' + t.taskNo + '</small></div><div class="muted" style="margin-top:6px">' + t.stack.map(f => esc(f.program) + ':' + f.line).join(' → ') + '</div><button style="margin-top:10px" data-reveal>Show line in editor</button>').join('') : '<div class="big muted">Idle</div><div class="muted">No TP program was running when this was read.</div>'}</div>
        <div class="card opt"><h2><span class="ic"></span>Options<span class="n">\${st.fetched.options ? st.options + ' installed ' : ''}\${stamp('options')} \${getBtn('getOptions')}</span></h2>\${!st.fetched.options ? unread('getOptions', 'The option list has not been read.') : '<div class="optl">' + st.optionHighlights.map(h => '<div class="optrow"><span class="mark ' + (h.ok === true ? 'ok" aria-label="installed">✓' : h.ok === false ? 'no" aria-label="missing">✗' : 'fact" aria-hidden="true">•') + '</span><span><b>' + esc(h.label) + '</b><br><span class="muted">' + esc(h.detail) + '</span></span></div>').join('') + '</div><div style="margin-top:10px"><button data-opts aria-label="Show every option on this controller">All options…</button></div>'}</div>
        <div class="card ruk"><h2><span class="ic"></span>In RUKUS</h2><div class="muted">A live view and the alarm history belong in RUKUS, which can hold the connection open without this editor doing it.</div><div style="margin-top:10px;display:flex;gap:6px;flex-wrap:wrap"><button data-ruk="rukusMonitor" aria-label="Open the live monitor in RUKUS">Live monitor</button><button data-ruk="rukusAlarms" aria-label="Open the alarm history in RUKUS">Alarm history</button></div></div>
        <div class="card wide pos"><h2><span class="ic"></span>Position <span class="n">\${pos ? 'Group ' + pos.group + (pos.frameNo !== undefined ? ' · UF ' + pos.frameNo + ' · UT ' + pos.toolNo : '') : ''} \${stamp('position')} \${getBtn('getPosition')}</span></h2>\${!st.fetched.position ? unread('getPosition', 'Current position has not been read.') : ''}\${pos && pos.userFrame ? '<div class="poslabel">Cartesian (user frame ' + (pos.frameNo ?? '?') + ')' + (pos.userFrame.config ? ' · CFG ' + esc(pos.userFrame.config) : '') + '</div><div class="axes">' + '<div class="ax xyz"><div class="l">X mm</div><div class="v">' + fmt(pos.userFrame.x) + '</div></div>' + '<div class="ax xyz"><div class="l">Y mm</div><div class="v">' + fmt(pos.userFrame.y) + '</div></div>' + '<div class="ax xyz"><div class="l">Z mm</div><div class="v">' + fmt(pos.userFrame.z) + '</div></div>' + '<div class="ax wpr"><div class="l">W deg</div><div class="v">' + fmt(pos.userFrame.w) + '</div></div>' + '<div class="ax wpr"><div class="l">P deg</div><div class="v">' + fmt(pos.userFrame.p) + '</div></div>' + '<div class="ax wpr"><div class="l">R deg</div><div class="v">' + fmt(pos.userFrame.r) + '</div></div>' + pos.userFrame.ext.map((e, i) => '<div class="ax e"><div class="l">E' + (i + 1) + '</div><div class="v">' + fmt(e) + '</div></div>').join('') + '</div>' : ''}\${pos && pos.joint ? '<div class="poslabel">Joints (deg)</div><div class="axes">' + pos.joint.joints.map((j, i) => '<div class="ax j"><div class="l">J' + (i + 1) + '</div><div class="v">' + fmt(j) + '</div></div>').join('') + pos.joint.ext.map((e, i) => '<div class="ax e"><div class="l">EXT' + (i + 1) + '</div><div class="v">' + fmt(e) + '</div></div>').join('') + '</div>' : ''}\${st.fetched.position && !pos ? '<div class="empty">No position data in CURPOS.DG</div>' : ''}</div>
        <div class="card wide tsk"><h2><span class="ic"></span>Tasks <span class="n">\${st.tasks.length || ''} \${stamp('tasks')} \${getBtn('getTasks')}</span></h2>\${!st.fetched.tasks ? unread('getTasks', 'Program state has not been read.') : st.tasks.length ? '<div class="rc-scroll"><table><thead><tr><th>#</th><th>Task</th><th>Status</th><th>Program</th><th class="num">Line</th><th>Type</th></tr></thead><tbody>' + tasks.map(t => '<tr class="' + (t.current ? 'click' : '') + '" data-prog="' + esc(t.current?.program ?? '') + '" data-line="' + (t.current?.line ?? '') + '" data-kind="' + esc(t.current?.type ?? '') + '"><td class="num">' + t.taskNo + '</td><td class="mono">' + esc(t.name) + '</td><td><span class="pill ' + t.status + '">' + t.status + '</span></td><td class="prog">' + esc(t.current?.program ?? '') + '</td><td class="num">' + (t.current?.line ?? '') + '</td><td class="muted">' + esc(t.current?.type ?? '') + '</td></tr>').join('') + '</tbody></table></div>' + rcLimitBar('tsk', tasks.length, st.tasks.length, 50) : '<div class="empty">No tasks reported</div>'}</div>
        <div class="card wide io"><h2><span class="ic"></span>I/O <span class="n">\${st.io.length ? st.io.length + ' points' : ''} \${stamp('io')} \${getBtn('getIo')}</span></h2>\${!st.fetched.io ? unread('getIo', 'I/O state has not been read.') : '<div class="tools"><input type="search" id="ioq" placeholder="Search comment or DI[25]…" value="' + esc(ioQuery) + '"><select id="iok"><option value="">All kinds</option>' + kinds.map(k => '<option' + (k === ioKind ? ' selected' : '') + '>' + k + '</option>').join('') + '</select><span class="muted">' + (q || ioKind ? io.length + ' match' + (io.length === 1 ? '' : 'es') : 'showing points that were ON — search to see others') + '</span></div><div class="chips">' + (ioShown.map(x => '<span class="chip ' + (x.v === 'ON' || (typeof x.v === 'number' && x.v !== 0) ? 'on' : '') + (x.s ? ' sim' : '') + '" data-k="' + x.k + '" data-i="' + x.i + '" title="' + esc(x.k + '[' + x.i + '] ' + x.c + (x.s ? ' (simulated)' : '')) + '"><span class="led"></span><span class="k">' + x.k + '[' + x.i + ']</span>' + (typeof x.v === 'number' ? '<span class="mono">' + x.v + '</span>' : '') + '<span class="c">' + esc(x.c) + '</span></span>').join('') || '<div class="empty">Nothing ON' + (q ? ' matching' : '') + '</div>') + '</div>' + rcLimitBar('io', ioShown.length, ioList.length, 100)}</div>
        <div class="card wide reg"><h2><span class="ic"></span>Registers <span class="n">\${st.fetched.numregs ? st.regs.length + ' R · ' + st.posregs.length + ' PR · ' + st.strregs.length + ' SR' : ''} \${stamp('numregs')} \${getBtn('getRegisters')}</span></h2>\${!st.fetched.numregs ? unread('getRegisters', 'Register values have not been read.') : '<div class="tools"><input type="search" id="rq" placeholder="Search R comment or R[15]…" value="' + esc(regQuery) + '"><button class="get" data-table>Open the full table</button></div><div class="rc-scroll"><table><thead><tr><th>Register</th><th>Comment</th><th class="num">Value</th></tr></thead><tbody>' + (regs.map(r => '<tr class="click" data-reg="' + r.i + '"><td class="mono" style="color:var(--orange)">R[' + r.i + ']</td><td>' + esc(r.c) + '</td><td class="num">' + esc(r.v) + '</td></tr>').join('') || '<tr><td colspan="3" class="empty">No matches</td></tr>') + '</tbody></table></div>' + rcLimitBar('reg', regs.length, regList.length, 50)}</div>
        \${st.errors.length ? '<div class="card wide err"><h2 class="err">Could not read</h2>' + st.errors.map(([f, e]) => '<div><span class="mono">' + esc(f) + '</span> — ' + esc(e) + '</div>').join('') + '</div>' : ''}
      </div>
      <div class="note">Nothing on this page reads the robot by itself. Each card is read when you press its Get; the age beside it counts up from then.</div>\`;
    const ioq = $('ioq'); if (ioq) { ioq.oninput = e => { ioQuery = e.target.value; render(); const el = $('ioq'); el.focus(); el.setSelectionRange(el.value.length, el.value.length); }; }
    const iok = $('iok'); if (iok) iok.onchange = e => { ioKind = e.target.value; render(); };
    const rq2 = $('rq'); if (rq2) rq2.oninput = e => { regQuery = e.target.value; render(); const el = $('rq'); el.focus(); el.setSelectionRange(el.value.length, el.value.length); };
    for (const b of document.querySelectorAll('[data-reveal]')) b.onclick = () => vscode.postMessage({ type: 'revealRunning' });
    for (const b of document.querySelectorAll('[data-get]')) b.onclick = () => vscode.postMessage({ type: b.dataset.get });
    for (const b of document.querySelectorAll('[data-ruk]')) b.onclick = () => vscode.postMessage({ type: b.dataset.ruk });
    for (const b of document.querySelectorAll('[data-opts]')) b.onclick = () => vscode.postMessage({ type: 'showOptions' });
    for (const b of document.querySelectorAll('[data-table]')) b.onclick = () => vscode.postMessage({ type: 'registers' });
    for (const r of document.querySelectorAll('tr[data-prog]')) r.onclick = () => r.dataset.prog && vscode.postMessage({ type: 'taskLine', program: r.dataset.prog, line: +r.dataset.line, kind: r.dataset.kind });
    for (const c of document.querySelectorAll('.chip')) c.onclick = () => vscode.postMessage({ type: 'findUses', kind: c.dataset.k, index: +c.dataset.i });
    for (const r of document.querySelectorAll('tr[data-reg]')) r.onclick = () => vscode.postMessage({ type: 'findUses', kind: 'R', index: +r.dataset.reg });
    rcWireLimits(render);
    // A card folds away and opens again from its title (issue #3, 3c); the choice survives a redraw
    // and the panel being hidden. Buttons in the title still do their own thing.
    for (const card of document.querySelectorAll('.card:not(.err)')) {
      const id = [...card.classList].find(c => c !== 'card' && c !== 'wide' && c !== 'folded');
      const h = card.querySelector('h2');
      if (!id || !h) continue;
      if (!h.querySelector('.chev')) h.insertAdjacentHTML('afterbegin', '<span class="chev" aria-hidden="true">▾</span>');
      h.classList.add('fold'); h.tabIndex = 0; h.setAttribute('role', 'button');
      const apply = () => { const f = folded.has(id); card.classList.toggle('folded', f); h.setAttribute('aria-expanded', String(!f)); };
      const toggle = () => { folded.has(id) ? folded.delete(id) : folded.add(id); vscode.setState({ ...(vscode.getState() || {}), folded: [...folded] }); apply(); };
      h.onclick = e => { if (!e.target.closest('button, a, input, select')) toggle(); };
      h.onkeydown = e => { if ((e.key === 'Enter' || e.key === ' ') && e.target === h) { e.preventDefault(); toggle(); } };
      apply();
    }
  }
  window.addEventListener('message', e => { if (e.data.type === 'state') { st = e.data.state; render(); } });
  vscode.postMessage({ type: 'ready' });
</script></body></html>`;
}
