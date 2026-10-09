/**
 * The ABB controller page: the FANUC robot page's look (core/live/dashboard.ts) with an ABB
 * controller's contents - state, RAPID tasks and their pointers, the controller and its options,
 * position, the loaded modules, I/O signals and the event log.
 *
 * Like the FANUC page it does not poll: every card is read when its Get is pressed (Read all reads
 * state, tasks and position, as Connect does), and each card shows how old its reading is.
 *
 * The Actions card and the write access buttons run the robotCode.abb.* commands of actions.ts;
 * each asks before it changes the controller (Stop does not ask).
 */
import * as vscode from 'vscode';
import { WEBVIEW_BASE_CSS } from '@core/webviewStyle';
import { ROBOT_PAGE_CSS } from '@core/live/dashboard';
import type { AbbControllers, AbbConnection } from './controllers';
import { ABB_ACTIONS } from './actions';
import { describeOption } from '@core/live/optionInfo';
import { showOptionPanel } from '@core/live/optionPanel';
import { ABB_OPTION_DOCS, abbCodeNote, splitAbbOption } from './optionDocs';

const abbOptionInfo = (text: string) => { const o = splitAbbOption(text); return describeOption('ABB', ABB_OPTION_DOCS, o.code, o.name, abbCodeNote); };
import { ctrlStateLabel, opModeLabel, execStateLabel, execStateClass, runModeLabel, taskTypeLabel } from './names';

const panels = new Map<string, vscode.WebviewPanel>();

export function openAbbPage(ctx: vscode.ExtensionContext, ctrls: AbbControllers, name: string): void {
  let panel = panels.get(name);
  if (!panel) {
    panel = vscode.window.createWebviewPanel('robotCode.abbPage', name, vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
    panels.set(name, panel);
    panel.onDidDispose(() => panels.delete(name));
    ctx.subscriptions.push(panel);
    panel.webview.html = html(name);
    const push = () => { const c = ctrls.get(name); if (panel && c) void panel.webview.postMessage({ type: 'state', state: { ...serialize(c), mine: ctrls.holdsAccess(name) } }); };
    const sub = ctrls.onDidChange(n => { if (!n || n === name) push(); });
    panel.onDidDispose(() => sub.dispose());
    const read = async (fn: () => Promise<unknown>) => { try { await fn(); } catch (e: any) { void vscode.window.showErrorMessage(`ABB ${name}: ${e?.message ?? e}`); } };
    panel.webview.onDidReceiveMessage(async (m: any) => {
      switch (m.type) {
        case 'ready': push(); break;
        case 'connect': await vscode.commands.executeCommand('robotCode.abb.connect', name); break;
        case 'disconnect': await vscode.commands.executeCommand('robotCode.abb.disconnect', name); break;
        case 'getAll': await read(() => ctrls.refresh(name)); break;
        case 'getState': await read(() => ctrls.refresh(name, ['state'])); break;
        case 'getTasks': await read(() => ctrls.refresh(name, ['tasks'])); break;
        case 'getPosition': await read(() => ctrls.refresh(name, ['position'])); break;
        case 'getSignals': await read(() => ctrls.readExtra(name, 'signals')); break;
        case 'getEvents': await read(() => ctrls.readExtra(name, 'events')); break;
        case 'getNetwork': await read(() => ctrls.readExtra(name, 'network')); break;
        case 'edit': await vscode.commands.executeCommand('robotCode.abb.editController', name); break;
        case 'backup': await vscode.commands.executeCommand('robotCode.abb.backup', name); break;
        case 'eventPage': await vscode.commands.executeCommand('robotCode.abb.showEventLog', name); break;
        case 'signalPage': await vscode.commands.executeCommand('robotCode.abb.showSignals', name); break;
        case 'optionInfo': { const o = ctrls.get(name)?.snapshot.system?.options[m.index]; if (o) showOptionPanel(abbOptionInfo(o)); break; }
        case 'module': await vscode.commands.executeCommand('robotCode.abb.openModule', name, m.task, m.module, m.moduleType); break;
        case 'action': {
          const id = `robotCode.abb.${m.cmd}`;
          if ((ABB_ACTIONS as readonly string[]).includes(id)) await vscode.commands.executeCommand(id, name);
          break;
        }
        case 'pointer': {
          const p = ctrls.get(name)?.snapshot.pointers?.get(m.task)?.[m.which as 'program' | 'motion'];
          if (p) await vscode.commands.executeCommand('robotCode.abb.openPointer', p, name, m.task);
          break;
        }
      }
    });
  }
  panel.reveal();
}

function serialize(c: AbbConnection) {
  const s = c.snapshot;
  const at = (k: string) => s.at.get(k);
  return {
    name: c.profile.name, host: c.profile.host, port: c.profile.port, family: c.profile.family === 'omnicore' ? 'OmniCore' : 'IRC5',
    state: c.state, error: c.error, rukus: c.rukusCluster,
    /** false: connected but not answering now (the dot turns red) */
    reachable: c.reachable ?? null,
    /** where the status comes from: controller events, or polling while they are not to be had */
    liveVia: c.watch?.mode ?? null,
    fetched: { system: at('system'), state: at('state'), tasks: at('tasks'), position: at('position'), signals: at('signals'), events: at('events'), network: at('network') },
    /** network.ts: the ports' addresses and whether the controller answers off the service port */
    network: s.network ?? null,
    system: s.system ?? null,
    /** each option's one-line explanation, for its hover (optionDocs.ts) */
    optionShort: (s.system?.options ?? []).map(o => abbOptionInfo(o).short),
    /** /ctrl/identity: the controller's own name, id, virtual or real */
    identity: s.identity ?? null,
    panel: s.panel ?? null,
    access: s.access ?? null,
    /** this session holds write access (the page sets it from AbbControllers.holdsAccess) */
    mine: false,
    execution: s.execution ?? null,
    /** what the page shows for the raw RWS values: the FlexPendant's words (names.ts) */
    labels: { ctrlState: ctrlStateLabel(s.panel?.ctrlState), opMode: opModeLabel(s.panel?.opMode), exec: execStateLabel(s.execution?.state), cycle: runModeLabel(s.execution?.cycle) },
    tasks: (s.tasks ?? []).map(t => ({ ...t, typeLabel: taskTypeLabel(t.type), execLabel: execStateLabel(t.execState), execClass: execStateClass(t.execState), pointers: s.pointers?.get(t.name) ?? {}, modules: s.modules?.get(t.name) ?? [] })),
    joints: s.joints ?? null,
    tcp: s.tcp ?? null,
    signals: s.signals ?? [],
    events: (s.events ?? []).slice(0, 40),
  };
}

function html(name: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${WEBVIEW_BASE_CSS}
${ROBOT_PAGE_CSS}
  .pill.motoron, .pill.running, .pill.AUTO { background: var(--ok) } .pill.motoroff, .pill.stopped { background: var(--muted) } .pill.guardstop, .pill.emergencystop, .pill.emergencystopreset { background: var(--bad) } .pill.MANR, .pill.MANF { background: var(--warn); color: #222 }
  .pill.t3 { background: var(--bad) } .pill.t2 { background: var(--warn); color: #222 } .pill.t1 { background: var(--blue) }
  .pill.free { background: var(--ok) } .pill.held { background: var(--warn); color: #222 }
  .card.act { border-top-color: var(--warn) } .card.act h2 .ic { background: var(--warn) }
  .chip.opt { cursor: pointer } .chip.opt:hover { border-color: var(--vscode-focusBorder) }
  .card.net { border-top-color: var(--blue) } .card.net h2 .ic { background: var(--blue) }
  .acts { display: flex; flex-direction: column; gap: 8px } .acts .row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px } .acts .row .k { color: var(--muted); font-size: 12px; min-width: 64px }
  button.danger { border-color: var(--bad) } .wa { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px }
  .kv { display: grid; grid-template-columns: max-content 1fr; gap: 4px 12px; font-size: 12.5px; align-items: center } .kv .k { color: var(--muted) } .kv.state { margin-top: 10px; gap: 6px 12px }
</style></head><body>
<div class="head">
  <h1><span class="dot" id="dot"></span><span id="name">${name}</span></h1>
  <div class="sub" id="sub">…</div>
  <div class="spacer"></div>
  <div class="btns">
    <button class="primary" id="toggle" aria-label="Connect to or disconnect from the controller">Connect</button>
    <button id="getAll" title="Read state, tasks and position once" aria-label="Read state, tasks and position from the controller once">Read all</button>
    <button id="edit" title="Connection settings" aria-label="Edit connection settings">Edit…</button>
    <button id="backup" title="Take a backup on the controller and download it" aria-label="Back up and download">Back up…</button>
    <button id="eventPage" title="The whole event log as a page" aria-label="Open the event log page">Event log</button>
    <button id="signalPage" title="Every I/O signal as a page" aria-label="Open the I/O signals page">I/O signals</button>
  </div>
</div>
<div id="body"><div class="rc-empty" role="status"><b>Not connected</b><p>Press Connect to start.</p></div></div>
<script>
  const vscode = acquireVsCodeApi();
  const folded = new Set((vscode.getState() || {}).folded || []);
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  let st = null, ioQuery = '', ioType = '', optQuery = '';
  for (const id of ['getAll', 'edit', 'backup', 'eventPage', 'signalPage']) $(id).onclick = () => vscode.postMessage({ type: id });
  $('toggle').onclick = () => vscode.postMessage({ type: st && st.state === 'connected' ? 'disconnect' : 'connect' });
  const fmt = n => (Math.round(n * 100) / 100).toFixed(2);
  const ago = at => { const s = Math.round((Date.now() - at) / 1000); return s < 60 ? s + ' s ago' : s < 3600 ? Math.round(s / 60) + ' min ago' : Math.round(s / 3600) + ' h ago'; };
  const stamp = k => { const at = st.fetched[k]; if (!at) return ''; return '<span class="age' + (Date.now() - at > 60000 ? ' stale' : '') + '" data-at="' + at + '">' + ago(at) + '</span>'; };
  setInterval(() => { for (const el of document.querySelectorAll('.age[data-at]')) { const at = +el.dataset.at; el.textContent = ago(at); el.classList.toggle('stale', Date.now() - at > 60000); } }, 5000);
  const act = (cmd, label, title, cls) => '<button' + (cls ? ' class="' + cls + '"' : '') + ' data-act="' + cmd + '" title="' + esc(title) + '">' + esc(label) + '</button>';
  const getBtn = (what, label) => '<button class="get" data-get="' + what + '" aria-label="Read ' + what + ' from the controller">' + (label || 'Get') + '</button>';
  const unread = (what, text) => '<div class="unread">' + esc(text) + '<br>' + getBtn(what, 'Read it now') + '</div>';
  const ptr = (t, which) => { const p = t.pointers[which]; return p ? '<a href="#" data-ptr="' + which + '" data-task="' + esc(t.name) + '" class="prog">' + esc(p.module) + ' › ' + esc(p.routine) + (p.begin ? ' · line ' + p.begin.line : '') + '</a>' : '<span class="muted">-</span>'; };
  function render() {
    if (!st) return;
    $('dot').className = 'dot ' + (st.state === 'connected' && st.reachable === false ? 'error' : st.state);
    // the controller by its own name and id first: the address is 192.168.125.1 on every service port
    $('sub').innerHTML = (st.identity && st.identity.name ? '<b>' + esc(st.identity.name) + '</b>' + (st.identity.virtual ? ' (virtual)' : st.identity.virtual === false ? ' (real)' : '') + ' · ' : '')
      + '<b>' + esc(st.host) + (st.port ? ':' + st.port : '') + '</b> · ' + st.family
      + (st.system ? ' · system <b>' + esc(st.system.name) + '</b>' + (st.system.sysid ? ' <span class="muted" title="system id">' + esc(st.system.sysid) + '</span>' : '') + ' · RobotWare ' + esc(st.system.robotWareName ?? st.system.robotWare ?? '') : '')
      + (st.rukus ? ' · RUKUS ' + esc(st.rukus) : '')
      + (st.state === 'connected' ? ' · status ' + (st.reachable === false ? '<span class="err">not answering</span>' : st.liveVia === 'events' ? 'live' : st.liveVia === 'polling' ? 'polled' : '') : '')
      + (st.error ? ' · <span class="err">' + esc(st.error) + '</span>' : '');
    $('toggle').textContent = st.state === 'connected' ? 'Disconnect' : st.state === 'connecting' ? 'Connecting…' : 'Connect';
    $('toggle').disabled = st.state === 'connecting';
    for (const id of ['getAll', 'backup', 'eventPage', 'signalPage']) $(id).disabled = st.state !== 'connected';
    if (st.state !== 'connected') { $('body').innerHTML = '<div class="rc-empty" role="status"><b>' + (st.state === 'connecting' ? 'Connecting…' : st.state === 'error' ? 'Connection problem' : 'Not connected') + '</b><p>' + esc(st.error ?? 'Press Connect to start.') + '</p></div>'; return; }
    const p = st.panel, ex = st.execution;
    const q = ioQuery.toLowerCase();
    const types = [...new Set(st.signals.map(x => x.type))].sort();
    const io = st.signals.filter(x => (!ioType || x.type === ioType) && (!q || x.name.toLowerCase().includes(q) || x.path.toLowerCase().includes(q)));
    const ioShown = (q || ioType ? io : io.filter(x => x.value !== '0' && x.value !== '')).slice(0, 200);
    const oq = optQuery.toLowerCase();
    const opts = (st.system?.options ?? []).map((o, i) => ({ o, i })).filter(x => !oq || x.o.toLowerCase().includes(oq));
    const mods = st.tasks.flatMap(t => t.modules.map(m => ({ ...m, task: t.name }))).sort((a, b) => (a.type === 'SysMod') - (b.type === 'SysMod') || a.task.localeCompare(b.task) || a.name.localeCompare(b.name));
    $('body').innerHTML = \`
      <div class="grid">
        <div class="card run"><h2><span class="ic"></span>State<span class="n">\${stamp('state')} \${getBtn('getState')}</span></h2>\${!p ? unread('getState', 'Controller state has not been read.') :
          '<div class="big"><span class="pill ' + esc(ex?.state) + '">' + esc(st.labels.exec ?? '?') + '</span><small>RAPID</small></div>'
          + '<div class="kv state">'
          + '<span class="k">Controller</span><span><span class="pill ' + esc(p.ctrlState) + '">' + esc(st.labels.ctrlState ?? '?') + '</span></span>'
          + '<span class="k">Operating mode</span><span><span class="pill ' + esc(p.opMode) + '">' + esc(st.labels.opMode ?? '?') + '</span></span>'
          + '<span class="k">Speed override</span><span class="mono">' + esc(p.speedRatio) + ' %</span>'
          + '<span class="k">Run mode</span><span>' + esc(st.labels.cycle ?? '?') + '</span>'
          + (st.access ? '<span class="k">Write access</span><span><span class="pill ' + (st.access.free ? 'free' : 'held') + '" title="' + esc(st.access.domains ? 'RAPID ' + st.access.domains.rapid + ' · configuration ' + st.access.domains.cfg + ' · motion ' + st.access.domains.motion : (st.access.holderId ? 'control station ' + st.access.holderId : '')) + '">' + esc(st.mine ? 'this PC' : st.access.free ? 'free' : st.access.holder) + '</span> <span class="muted">' + esc(st.mine ? 'held by this PC' : st.access.free ? 'nobody holds it' : 'held by ' + st.access.holder) + '</span></span>' : '')
          + '</div>'
          + (st.access ? '<div class="wa"><button class="get" data-act="requestWriteAccess"' + (st.mine ? ' disabled' : '') + ' title="Ask for write access for this PC (confirmed first)">Request write access</button><button class="get" data-act="releaseWriteAccess"' + (st.mine || !st.access.free ? '' : ' disabled') + ' title="Give write access back (confirmed first)">Release</button></div>'
            + (st.access.externalControl === false ? '<div class="note">Remote access is <b>off</b>: this PC cannot ask for write access. On the FlexPendant open Write Access and turn on Remote Access (long-press the hard button with the speech-bubble icon, or the E-Device button).</div>' : '') : '')}</div>
        <div class="card act"><h2><span class="ic"></span>Actions<span class="n">\${p ? 'speed ' + esc(p.speedRatio) + '%' : ''}</span></h2><div class="acts">
          <div class="row"><span class="k">Speed</span>\${act('setSpeed', 'Speed…', 'Set the speed override (5-100%)')}</div>
          <div class="row"><span class="k">Motors</span>\${act('motorsOn', 'Motors On', 'Turn the motors on (Auto mode)')}\${act('motorsOff', 'Motors Off', 'Turn the motors off')}</div>
          <div class="row"><span class="k">RAPID</span>\${act('startRapid', 'Start…', 'Start RAPID in Single Cycle or Continuous run mode - the robot moves', 'danger')}\${act('stopRapid', 'Stop', 'Stop RAPID now (no question asked)')}\${act('resetProgramPointer', 'PP to Main', 'Program pointer to main, every task')}</div>
          <div class="row"><span class="k">Modules</span>\${act('loadModule', 'Load module…', 'Upload the open editor or a file to $HOME and load it into a task')}\${act('unloadModule', 'Unload module…', 'Unload a module from a task')}</div>
          <div class="row"><span class="k">Data</span>\${act('setSignal', 'Set output signal…', 'Set a digital (or group / analog) output')}\${act('setRapidData', 'Write RAPID data…', 'Write the value of a RAPID VAR or PERS')}</div>
          </div><div class="note">Each action asks before it changes the controller; Stop does not.\${st.family === 'OmniCore' && !st.mine ? ' An OmniCore takes changes only from the control station that holds write access: Request it on the State card first.' : ''}</div></div>
        <div class="card opt"><h2><span class="ic"></span>Controller<span class="n">\${(st.system?.options ?? []).length ? st.system.options.length + ' options ' : ''}\${stamp('system')}</span></h2>\${!st.system ? '<div class="empty">Not read</div>' :
          '<div class="kv"><span class="k">System</span><span class="mono">' + esc(st.system.name) + '</span><span class="k">RobotWare</span><span>' + esc(st.system.robotWare) + '</span><span class="k">System id</span><span class="mono">' + esc(st.system.sysid ?? '') + '</span><span class="k">Started</span><span>' + esc((st.system.started ?? '').replace(' T ', ' ')) + '</span></div>'
          + '<div class="tools" style="margin-top:10px"><input type="search" id="oq" placeholder="Search options…" value="' + esc(optQuery) + '"></div><div class="chips">' + (opts.map(x => '<span class="chip opt" tabindex="0" role="button" data-opt="' + x.i + '" title="' + esc((st.optionShort[x.i] ?? '') + ' Click for more.') + '"><span class="c" style="max-width:none">' + esc(x.o) + '</span></span>').join('') || '<div class="empty">No options' + (oq ? ' matching' : '') + '</div>') + '</div>'}</div>
        <div class="card net"><h2><span class="ic"></span>Network<span class="n">\${stamp('network')} \${getBtn('getNetwork')}</span></h2>\${!st.network ? unread('getNetwork', 'Whether this controller can be reached without the service port has not been read.') :
          '<div class="big"><span class="pill ' + (st.network.reach.serviceOnly ? 'held' : 'free') + '">' + (st.network.reach.serviceOnly ? 'service port only' : 'off the service port') + '</span>' + (st.network.reach.ip ? '<small class="mono">' + esc(st.network.reach.ip) + '</small>' : '') + '</div>'
          + '<div style="margin-top:8px">' + esc(st.network.reach.verdict) + '</div>'
          + '<div class="kv state">' + st.network.ports.map(p => '<span class="k">' + esc(p.port ?? p.name) + '</span><span class="mono">' + esc(p.dhcp ? 'DHCP' : p.address ?? 'no address') + (p.mask ? ' / ' + esc(p.mask) : '') + '</span>').join('')
          + (st.network.wireless !== undefined ? '<span class="k">Wireless</span><span>' + (st.network.wireless ? 'gateway enabled' : 'off') + '</span>' : '') + '</div>'}</div>
        <div class="card wide tsk"><h2><span class="ic"></span>RAPID tasks<span class="n">\${st.tasks.length || ''} \${stamp('tasks')} \${getBtn('getTasks')}</span></h2>\${!st.fetched.tasks ? unread('getTasks', 'Tasks have not been read.') :
          '<div class="rc-scroll"><table><thead><tr><th>Task</th><th>Type</th><th>Execution</th><th>Program pointer</th><th>Motion pointer</th></tr></thead><tbody>' + st.tasks.map(t => '<tr><td class="mono">' + esc(t.name) + (t.motion ? ' <span class="pill RUNNING" title="motion task">motion</span>' : '') + '</td><td class="muted">' + esc(t.typeLabel ?? '') + (t.active === false ? ' · inactive' : '') + '</td><td><span class="pill ' + esc(t.execClass) + '">' + esc(t.execLabel ?? '?') + '</span></td><td>' + ptr(t, 'program') + '</td><td>' + ptr(t, 'motion') + '</td></tr>').join('') + '</tbody></table></div>'}</div>
        <div class="card wide pos"><h2><span class="ic"></span>Position<span class="n">\${stamp('position')} \${getBtn('getPosition')}</span></h2>\${!st.joints && !st.tcp ? unread('getPosition', 'Position has not been read.') :
          (st.tcp ? '<div class="poslabel">TCP (current tool and work object) · cf ' + st.tcp.robconf.join(', ') + '</div><div class="axes">' + ['X', 'Y', 'Z'].map((l, i) => '<div class="ax xyz"><div class="l">' + l + ' mm</div><div class="v">' + fmt(st.tcp.trans[i]) + '</div></div>').join('') + st.tcp.rot.map((v, i) => '<div class="ax wpr"><div class="l">q' + (i + 1) + '</div><div class="v">' + v.toFixed(5) + '</div></div>').join('') + '</div>' : '')
          + (st.joints ? '<div class="poslabel">Joints (deg)</div><div class="axes">' + st.joints.robax.map((j, i) => '<div class="ax j"><div class="l">J' + (i + 1) + '</div><div class="v">' + fmt(j) + '</div></div>').join('') + st.joints.extax.filter(e => Math.abs(e) < 8.9e9).map((e, i) => '<div class="ax e"><div class="l">E' + (i + 1) + '</div><div class="v">' + fmt(e) + '</div></div>').join('') + '</div>' : '')}</div>
        <div class="card wide reg"><h2><span class="ic"></span>Modules<span class="n">\${mods.length || ''} \${stamp('tasks')} \${getBtn('getTasks')}</span></h2>\${!st.fetched.tasks ? unread('getTasks', 'Modules have not been read.') : mods.length ?
          '<div class="rc-scroll"><table><thead><tr><th>Module</th><th>Task</th><th>Kind</th></tr></thead><tbody>' + mods.map(m => '<tr class="click" data-mod="' + esc(m.name) + '" data-task="' + esc(m.task) + '" data-type="' + esc(m.type) + '"><td class="mono">' + esc(m.name) + '</td><td class="muted">' + esc(m.task) + '</td><td class="muted">' + (m.type === 'SysMod' ? 'system module' : m.type === 'ProgMod' ? 'program module' : esc(m.type)) + '</td></tr>').join('') + '</tbody></table></div><div class="note">Click a module to read its source from the controller (read-only).</div>' : '<div class="empty">No modules loaded</div>'}</div>
        <div class="card wide io"><h2><span class="ic"></span>I/O signals<span class="n">\${st.signals.length ? st.signals.length + ' signals ' : ''}\${stamp('signals')} \${getBtn('getSignals')}</span></h2>\${!st.fetched.signals ? unread('getSignals', 'I/O signals have not been read.') :
          '<div class="tools"><input type="search" id="ioq" placeholder="Search name or network/device…" value="' + esc(ioQuery) + '"><select id="iot"><option value="">All types</option>' + types.map(t => '<option' + (t === ioType ? ' selected' : '') + '>' + t + '</option>').join('') + '</select><span class="muted">' + (q || ioType ? io.length + ' match' + (io.length === 1 ? '' : 'es') : 'showing signals that are set - search to see others') + '</span></div><div class="chips">' + (ioShown.map(x => '<span class="chip ' + (x.value !== '0' && x.value !== '' ? 'on' : '') + (x.state && x.state !== 'not simulated' ? ' sim' : '') + '" title="' + esc(x.path + ' = ' + x.value + (x.state ? ' (' + x.state + ')' : '')) + '"><span class="led"></span><span class="k">' + esc(x.type) + '</span><span class="c" style="max-width:220px">' + esc(x.name) + '</span>' + (x.type === 'DI' || x.type === 'DO' ? '' : '<span class="mono">' + esc(x.value) + '</span>') + '</span>').join('') || '<div class="empty">Nothing set' + (q ? ' matching' : '') + '</div>') + '</div>'}</div>
        <div class="card wide err"><h2><span class="ic"></span>Event log<span class="n">\${stamp('events')} \${getBtn('getEvents')}</span></h2>\${!st.fetched.events ? unread('getEvents', 'The event log has not been read.') : st.events.length ?
          '<div class="rc-scroll"><table><thead><tr><th>Time</th><th></th><th class="num">Code</th><th>Message</th></tr></thead><tbody>' + st.events.map(e => '<tr title="' + esc([e.description, e.causes && 'Causes: ' + e.causes, e.actions && 'Actions: ' + e.actions].filter(Boolean).join('\\n')) + '"><td class="muted" style="white-space:nowrap">' + esc(e.time.replace(' T ', ' ')) + '</td><td><span class="pill t' + e.type + '">' + (e.type === 3 ? 'error' : e.type === 2 ? 'warning' : 'info') + '</span></td><td class="num">' + e.code + '</td><td>' + esc(e.title) + '</td></tr>').join('') + '</tbody></table></div><div class="note">Newest first. Hover a message for its description; Event log above opens the whole log.</div>' : '<div class="empty">No messages</div>'}</div>
      </div>
      <div class="note">Nothing on this page reads the controller by itself. Each card is read when you press its Get; the age beside it counts up from then.</div>\`;
    const ioq = $('ioq'); if (ioq) ioq.oninput = e => { ioQuery = e.target.value; render(); const el = $('ioq'); el.focus(); el.setSelectionRange(el.value.length, el.value.length); };
    const iot = $('iot'); if (iot) iot.onchange = e => { ioType = e.target.value; render(); };
    const oq2 = $('oq'); if (oq2) oq2.oninput = e => { optQuery = e.target.value; render(); const el = $('oq'); el.focus(); el.setSelectionRange(el.value.length, el.value.length); };
    for (const b of document.querySelectorAll('[data-get]')) b.onclick = () => vscode.postMessage({ type: b.dataset.get });
    for (const b of document.querySelectorAll('[data-act]')) b.onclick = () => vscode.postMessage({ type: 'action', cmd: b.dataset.act });
    // an option: hover for the short explanation, click (or Enter) for the whole one in a panel
    for (const b of document.querySelectorAll('[data-opt]')) { b.onclick = () => vscode.postMessage({ type: 'optionInfo', index: Number(b.dataset.opt) }); b.onkeydown = e => { if (e.key === 'Enter') b.onclick(); }; }
    for (const a of document.querySelectorAll('[data-ptr]')) a.onclick = e => { e.preventDefault(); vscode.postMessage({ type: 'pointer', which: a.dataset.ptr, task: a.dataset.task }); };
    for (const r of document.querySelectorAll('tr[data-mod]')) r.onclick = () => vscode.postMessage({ type: 'module', module: r.dataset.mod, task: r.dataset.task, moduleType: r.dataset.type });
    for (const card of document.querySelectorAll('.card')) {
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

/** for tests: what the page is sent */
export const abbPageState = serialize;
export const abbPageHtml = html;
