/**
 * Regressions from Sam's beta list 6 (2026-10-08). Synthetic, like betaIssues.test.ts:
 * nothing here needs reference-backup, so nothing can be skipped silently.
 * Wired in by test/run.ts: `run(check)`, and `await runLive(check)` for the ABB status watch,
 * which runs against an in-process stand-in controller.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import type { Socket } from 'node:net';
import { RwsClient } from '@abb/rws/client';
import { acceptKey, encodeFrame, decodeFrames } from '@abb/rws/websocket';
import { StatusWatch, parseStateEvent, stateResources, type StatusUpdate } from '@abb/live/liveStatus';
import { isNoAnswer } from '@core/live/connectionHints';
import { identityMismatch, expectationOf, controllerLabel } from '@abb/live/identity';
import { parseTasklist, parseNetstatListening, probeRws, discoverVirtualControllers, matchEndpoint, MANUAL_STEPS } from '@abb/live/vcDiscovery';
import { cfgInstances, ipSettings, reachability, wirelessEnabled } from '@abb/live/network';
import { describeOption, optionPanelHtml } from '@core/live/optionInfo';
import { FANUC_OPTION_DOCS, fanucCodeNote } from '@fanuc/live/optionDocs';
import { ABB_OPTION_DOCS, abbCodeNote, splitAbbOption } from '@abb/live/optionDocs';
import { rememberEvents, eventMarkdown, eventDomain, parseEventCode, type EventCatalog } from '@abb/live/eventCatalog';
import { FEATURES, PROFILES, profileWrites, profileOf, modeOf, valueOf } from '@core/features';
import { parseRwsPage } from '@abb/rws/xhtml';
import { parseRwsJson } from '@abb/rws/hal';
// @ts-ignore - plain ESM test helper, bundled by esbuild
import { startMockRws } from './mockRws.mjs';
import { parseKarel, findLabel } from '@fanuc/karel/parser';
import { parseEioSignals, backupSignals, signalFits } from '@abb/signals';
import { runModeLabel, opModeLabel, ctrlStateLabel, execStateLabel, taskTypeLabel } from '@abb/live/names';

export function run(check: (cond: unknown, msg: string) => void): void {
  // ---- #1: KAREL GO TO label → its `label::` line ----
  {
    const prog = parseKarel([
      'PROGRAM gt',            // 0
      'ROUTINE r1',            // 1
      'BEGIN',                 // 2
      '  retry::',             // 3
      '  GOTO retry',          // 4
      'END r1',                // 5
      'BEGIN',                 // 6
      '  GO TO retry -- main', // 7
      '  retry :: -- here',    // 8
      '  GO TO done',          // 9
      'END gt',                // 10
    ].join('\n'));
    const inR1 = findLabel(prog, 'RETRY', 4);
    check(inR1?.line === 3 && inR1.col === 2 && inR1.len === 5, `GOTO in a routine jumps to its own label: ${JSON.stringify(inR1)}`);
    const inMain = findLabel(prog, 'RETRY', 7);
    check(inMain?.line === 8, `GO TO in the main body jumps to the main body's label, not the routine's: ${JSON.stringify(inMain)}`);
    check(findLabel(prog, 'DONE', 9) === undefined, 'an undeclared label has no definition');
  }

  // ---- #2: RAPID completion offers the I/O signals of the backup / controller ----
  {
    const eio = [
      'EIO:CFG_1.0:6:1::',
      '#',
      'EIO_DEVICE:',
      '      -Name "d651" -VendorName "ABB Robotics"',
      '#',
      'EIO_SIGNAL:',
      '',
      '      -Name "DI_Grip_Open_X" -SignalType "DI" -Device "d651" -DeviceMap "0"',
      '      -Name "DO_Grip_Close" -SignalType "DO" -Device "d651" -DeviceMap "0" \\',
      '            -Label "close the gripper"',
      '      -Name "GO_Prog" -SignalType "GO" -Device "d651" -DeviceMap "8-15"',
      '      -Name "x_cross" -SignalType "XX"',
      '#',
      'EIO_CROSS:',
      '      -Name "c1" -Res "DO_Grip_Close" -Act1 "DI_Grip_Open_X"',
    ].join('\r\n');
    const sig = parseEioSignals(eio);
    check(sig.map(x => `${x.name}:${x.type}`).join(' ') === 'DI_Grip_Open_X:DI DO_Grip_Close:DO GO_Prog:GO',
      `EIO_SIGNAL entries only, continuation lines joined: ${JSON.stringify(sig)}`);
    check(sig[1].label === 'close the gripper' && sig[0].device === 'd651', 'label and device kept');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-eio-'));
    fs.mkdirSync(path.join(root, 'SYSPAR'));
    fs.writeFileSync(path.join(root, 'SYSPAR', 'EIO.cfg'), eio);
    check(backupSignals(root).length === 3, 'a backup root reads its SYSPAR/EIO.cfg');
    fs.rmSync(root, { recursive: true, force: true });
    check(signalFits('DO', 'signaldo') && !signalFits('DI', 'signaldo'), 'SetDO takes output signals only');
    check(signalFits('DI', 'dionum') && !signalFits('GI', 'dionum') && signalFits('GI', 'num'), 'digital signals as 0/1, groups as numbers');
    const prov = fs.readFileSync(path.join(__dirname, '..', 'packages', 'abb', 'src', 'rapid', 'providers.ts'), 'utf8');
    check(/if \(!atStart\) for \(const x of signalsHere\(\)\)/.test(prov), 'after IF / WHILE (no call context) the general list includes the signals');
  }

  // ---- #3: every shipped theme colours every scope the RAPID grammar emits ----
  // (the generated themes were built before the RAPID rules reached the base themes; run
  // scripts/make-themes.mjs after changing a base theme)
  {
    const root = path.join(__dirname, '..');
    const grammar = fs.readFileSync(path.join(root, 'syntaxes', 'rapid.tmLanguage.json'), 'utf8');
    const scopes = [...new Set([...grammar.matchAll(/"name"\s*:\s*"([^"]+\.rapid)"/g)].map(m => m[1]))];
    check(scopes.length > 20, `the RAPID grammar's scopes were found: ${scopes.length}`);
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    for (const t of pkg.contributes.themes as { label: string; path: string }[]) {
      const theme = JSON.parse(fs.readFileSync(path.join(root, t.path), 'utf8'));
      const sels: string[] = (theme.tokenColors ?? []).flatMap((r: { scope?: string | string[] }) => ([] as string[]).concat(r.scope ?? []).flatMap(s => s.split(',').map(x => x.trim().split(' ').pop()!)));
      const miss = scopes.filter(sc => !sels.some(s => sc === s || sc.startsWith(s + '.')));
      check(!miss.length, `${t.label} colours every RAPID scope: missing ${miss.join(', ')}`);
    }
  }

  // ---- #4: the ABB State card is laid out like the FANUC Running card ----
  {
    const page = fs.readFileSync(path.join(__dirname, '..', 'packages', 'abb', 'src', 'live', 'dashboard.ts'), 'utf8');
    const card = /<div class="card run">[\s\S]*?<div class="card act">/.exec(page)?.[0] ?? '';
    check(card && !/style="/.test(card), 'the State card has no inline styles');
    check(/<div class="big">/.test(card) && /<div class="kv state">/.test(card) && /<div class="wa">/.test(card),
      'State card: the execution state big, label / value rows, then the write-access buttons on their own row');
  }

  // ---- #5: ABB nomenclature: the FlexPendant's words, not the RWS tokens ----
  {
    check(runModeLabel('once') === 'Single Cycle' && runModeLabel('forever') === 'Continuous', 'run mode: Single Cycle / Continuous');
    check(opModeLabel('AUTO') === 'Auto' && opModeLabel('MANR') === 'Manual' && opModeLabel('manf') === 'Manual Full Speed', 'operating mode');
    check(ctrlStateLabel('motoron') === 'Motors On' && ctrlStateLabel('guardstop') === 'Guard Stop', 'controller state');
    check(execStateLabel('star') === 'Running' && execStateLabel('stopped') === 'Stopped' && taskTypeLabel('semi') === 'Semistatic', 'execution state, task type');
    check(runModeLabel('something_new') === 'something_new' && runModeLabel(undefined) === undefined, 'an unknown token is shown as it came');
    const live = path.join(__dirname, '..', 'packages', 'abb', 'src', 'live');
    for (const f of ['actions.ts', 'view.ts', 'dashboard.ts']) {
      const src = fs.readFileSync(path.join(live, f), 'utf8');
      check(!/label: 'Once'|'motors on'|'motors off'|=== 'star' \? 'running'/.test(src), `${f} shows no raw RWS tokens as labels`);
    }
  }
}

/** A server frame: unmasked, as a server sends it. */
const serverFrame = (opcode: number, text: string) => {
  const p = Buffer.from(text, 'utf8');
  const head = p.length < 126 ? Buffer.from([0x80 | opcode, p.length]) : Buffer.from([0x80 | opcode, 126, p.length >> 8, p.length & 0xff]);
  return Buffer.concat([head, p]);
};
const page = (cls: string, fields: Record<string, string>) =>
  `<html><body><div class="state"><ul><li class="${cls}" title="x">${Object.entries(fields).map(([k, v]) => `<span class="${k}">${v}</span>`).join('')}</li></ul></div></body></html>`;
const event = (cls: string, span: string, v: string) =>
  `<?xml version="1.0" encoding="utf-8"?><html><body><div class="state"><a href="subscription/7" rel="group"></a><ul><li class="${cls}" title="${span}"><a href="/rw/x" rel="self"></a><span class="${span}">${v}</span></li></ul></div></body></html>`;
const until = async (cond: () => boolean, ms = 3000) => { const end = Date.now() + ms; while (!cond() && Date.now() < end) await new Promise(r => setTimeout(r, 20)); return cond(); };

export async function runLive(check: (cond: unknown, msg: string) => void): Promise<void> {
  // ---- #6: the pieces ----
  {
    const ev = parseStateEvent(event('pnl-ctrlstate-ev', 'ctrlstate', 'motoron') + event('rap-ctrlexecstate-ev', 'ctrlexecstate', 'running'));
    check(ev.ctrlState === 'motoron' && ev.execState === 'running' && ev.opMode === undefined, `an event message: ${JSON.stringify(ev)}`);
    check(parseStateEvent(event('pnl-ctrlstate-ev', 'ctrl-state', 'guardstop')).ctrlState === 'guardstop', 'RWS 2.0 spelling');
    check(stateResources(false)[0] === '/rw/panel/ctrlstate' && stateResources(true)[0] === '/rw/panel/ctrl-state', 'resources per dialect');
    const big = 'x'.repeat(70_000);
    const back = decodeFrames(encodeFrame(0x1, Buffer.from(big)));
    check(back.frames.length === 1 && back.frames[0].payload.toString() === big && back.frames[0].fin, 'a masked 64-bit-length frame decodes to what was sent');
    const half = encodeFrame(0x1, Buffer.from('hello'));
    check(decodeFrames(half.subarray(0, half.length - 1)).frames.length === 0, 'a partial frame waits for the rest');
    check(acceptKey('dGhlIHNhbXBsZSBub25jZQ==') === 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=', 'the RFC 6455 handshake example');
    check(isNoAnswer(Object.assign(new Error('x'), { code: 'ECONNREFUSED' })) && isNoAnswer(new Error('192.168.1.5 did not answer within 5 s')) && !isNoAnswer(new Error('HTTP 404')),
      'no answer vs an error answer');
    // every brand's row and page turn red when connected but not answering
    const src = (...p: string[]) => fs.readFileSync(path.join(__dirname, '..', 'packages', ...p), 'utf8');
    check(/const lost = state === 'connected' && el\.c\.reachable === false/.test(src('core', 'src', 'live', 'views.ts')), 'FANUC row: not answering is red');
    check(/const lost = c\.state === 'connected' && c\.reachable === false/.test(src('abb', 'src', 'live', 'view.ts')), 'ABB row: not answering is red');
    for (const p of [['core', 'src', 'live', 'dashboard.ts'], ['abb', 'src', 'live', 'dashboard.ts']]) {
      check(/st\.state === 'connected' && st\.reachable === false \? 'error'/.test(src(...p)), `${p[0]} page: the dot is red when not answering`);
    }
  }

  // ---- #6: events first, a dropped socket is red at once, polling brings it back, resubscribes ----
  const seen = { subscribe: [] as string[], deletes: [] as string[], upgrades: [] as { protocol?: string; cookie?: string; path?: string }[], gets: 0 };
  let down = false;
  const sockets = new Set<Socket>();
  let ws: Socket | undefined;
  const server = http.createServer((req, res) => {
    if (down) { req.socket.destroy(); return; }
    const body: Buffer[] = [];
    req.on('data', d => body.push(d));
    req.on('end', () => {
      const send = (status: number, text = '', headers: Record<string, string> = {}) => { res.writeHead(status, { 'Set-Cookie': '-http-session-=s1; Path=/', ...headers }); res.end(text); };
      if (req.method === 'POST' && req.url === '/subscription') { seen.subscribe.push(Buffer.concat(body).toString()); return send(201, '', { Location: 'ws://192.168.125.1:80/poll/7' }); }
      if (req.method === 'DELETE') { seen.deletes.push(req.url ?? ''); return send(200); }
      seen.gets++;
      if (req.url === '/rw/panel/ctrlstate') return send(200, page('pnl-ctrlstate', { ctrlstate: 'motoroff' }));
      if (req.url === '/rw/panel/opmode') return send(200, page('pnl-opmode', { opmode: 'MANR' }));
      if (req.url === '/rw/panel/speedratio') return send(200, page('pnl-speedratio', { speedratio: '50' }));
      if (req.url === '/rw/rapid/execution') return send(200, page('rap-execution', { ctrlexecstate: 'stopped', cycle: 'once' }));
      send(404);
    });
  });
  server.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  server.on('upgrade', (req, socket: Socket) => {
    seen.upgrades.push({ protocol: req.headers['sec-websocket-protocol'] as string, cookie: req.headers.cookie, path: req.url });
    socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${acceptKey(req.headers['sec-websocket-key'] as string)}`, `Sec-WebSocket-Protocol: ${req.headers['sec-websocket-protocol']}`, '', ''].join('\r\n'));
    ws = socket;
    socket.on('data', () => undefined);
    socket.on('error', () => undefined);
    setTimeout(() => { if (!socket.destroyed) socket.write(serverFrame(0x1, event('pnl-ctrlstate-ev', 'ctrlstate', 'motoron'))); }, 20);
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const client = new RwsClient({ host: '127.0.0.1', port, user: 'Default User', password: 'robotics', timeoutMs: 500 });
  const updates: { u: StatusUpdate; via: string }[] = [];
  const reach: boolean[] = [];
  const watch = new StatusWatch(client, { update: (u, via) => updates.push({ u, via }), reachable: ok => reach.push(ok) }, { pollMs: 80, resubscribeMs: 300, pingMs: 0 });
  try {
    await client.system().catch(() => undefined);   // a session cookie, as connect leaves one
    seen.gets = 0;
    await watch.start();
    check(watch.mode === 'events', `subscribed: ${watch.mode}`);
    check(/resources=1&1=%2Frw%2Fpanel%2Fctrlstate&1-p=1/.test(seen.subscribe[0] ?? '') && /resources=3&3=%2Frw%2Frapid%2Fexecution%3Bctrlexecstate/.test(seen.subscribe[0] ?? ''),
      `the subscription names the three state resources: ${seen.subscribe[0]}`);
    check(seen.upgrades[0]?.path === '/poll/7' && seen.upgrades[0]?.protocol === 'robapi2_subscription' && /-http-session-=s1/.test(seen.upgrades[0]?.cookie ?? ''),
      `the event socket goes to this host with the Location's path, the RWS 1.0 protocol and the session cookie: ${JSON.stringify(seen.upgrades[0])}`);
    check(await until(() => updates.some(x => x.via === 'events' && x.u.ctrlState === 'motoron')), `an event updates the state: ${JSON.stringify(updates)}`);
    check(seen.gets === 0, `nothing is polled while events come: ${seen.gets} GETs`);

    ws?.destroy();
    check(await until(() => reach.includes(false)), 'a dropped event socket is "not reachable" at once (red)');
    check(await until(() => updates.some(x => x.via === 'polling' && x.u.ctrlState === 'motoroff' && x.u.cycle === 'once')), 'then polling takes over');
    check(await until(() => reach.lastIndexOf(true) > reach.indexOf(false)), 'a poll that answers is reachable again');
    check(await until(() => watch.mode === 'events' && seen.upgrades.length === 2, 3000), `polling gets the event socket back: ${watch.mode}, ${seen.upgrades.length} upgrades`);

    down = true; ws?.destroy(); for (const s of sockets) s.destroy();
    const n = reach.length;
    check(await until(() => reach.slice(n).includes(false) && watch.mode === 'polling'), 'controller gone: red, and it stays polling');
    await new Promise(r => setTimeout(r, 300));
    const gone = reach.slice(n);
    check(!gone.slice(gone.indexOf(false)).includes(true), `no poll pretends it answered: ${gone.join(',')}`);
    down = false;
    check(await until(() => reach.slice(n).lastIndexOf(true) > reach.slice(n).indexOf(false)), 'back when the controller answers again');
  } finally {
    await watch.stop();
    check(watch.mode === 'stopped', 'stopped');
    check(seen.deletes.includes('/subscription/7'), `stop ends the subscription group: ${seen.deletes.join(' ')}`);
    await client.logout().catch(() => undefined);
    for (const s of sockets) s.destroy();
    await new Promise<void>(r => server.close(() => r()));
  }

  // ---- #6 against the RWS 1.0 mock (Digest login, session cookie): idle on events, no write sent ----
  {
    const crawl = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-crawl-'));
    fs.writeFileSync(path.join(crawl, 'rw_system.html'), page('sys-system-li', { name: 'MOCK' }));
    const mock = await startMockRws(crawl, 0);
    const cl = new RwsClient({ host: '127.0.0.1', port: mock.port, user: 'Default User', password: 'robotics' });
    const w = new StatusWatch(cl, { update: () => undefined, reachable: () => undefined }, { pingMs: 0 });
    try {
      await cl.system();
      await w.start();
      const n = cl.requests;
      await new Promise(r => setTimeout(r, 300));
      check(w.mode === 'events' && cl.requests === n, `mock: the event socket opens with the Digest session's cookie, and nothing is polled: ${w.mode}, ${cl.requests - n} requests`);
    } finally {
      await w.stop();
      await cl.logout();
      check(mock.stats.subscriptions === 1 && mock.stats.unsubscriptions === 1 && mock.stats.actions === 0 && mock.stats.sessionsOpen() === 0,
        `mock: one subscription, ended; no write; session given back: ${JSON.stringify({ ...mock.stats, sessionsOpen: mock.stats.sessionsOpen() })}`);
      await mock.close();
      fs.rmSync(crawl, { recursive: true, force: true });
    }
  }
}

/** #7: the public README has no Building section (beta users install the .vsix; they do not build). */
export function runDocs(check: (cond: unknown, msg: string) => void): void {
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  check(!/^##\s+Building\b/m.test(readme) && !/^npm (install|run package|run install-local)/m.test(readme), 'README: no Building section, no build commands');
}

/** #8: OmniCore writes go through on a virtual controller only (until a real one is validated). */
export function runWriteGate(check: (cond: unknown, msg: string) => void): void {
  const src = fs.readFileSync(path.join(__dirname, '..', 'packages', 'abb', 'src', 'live', 'controllers.ts'), 'utf8');
  check(/if \(c\.snapshot\.identity\?\.virtual === true\) return undefined;/.test(src) && /abb\.allowRealOmniCoreWrites/.test(src), 'a virtual OmniCore may be written; a real one only with the setting');
  check(/const blocked = what === 'RAPID stop' \? undefined : this\.writeBlocked\(name\);/.test(src), 'every control action passes the gate, except Stop RAPID');
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const setting = pkg.contributes.configuration.properties?.['robotCode.abb.allowRealOmniCoreWrites'] ?? (pkg.contributes.configuration as { properties: Record<string, { default: unknown; scope: string }> }[]).map(x => x.properties?.['robotCode.abb.allowRealOmniCoreWrites']).find(Boolean);
  check(setting?.default === false && setting?.scope === 'machine', `the setting is off by default and machine-scoped (a workspace cannot turn it on): ${JSON.stringify(setting)}`);
}

/** #9: ABB controllers are told apart by their own name and system id, not by the address. */
export async function runIdentity(check: (cond: unknown, msg: string) => void): Promise<void> {
  const a = { ctrlName: 'IRC5-CELL2', systemName: 'CELL2_SYS', systemId: '{AAAA1111-0000-0000-0000-000000000001}', virtual: false };
  const b = { ctrlName: 'IRC5-CELL3', systemName: 'CELL3_SYS', systemId: '{BBBB2222-0000-0000-0000-000000000002}', virtual: false };
  check(identityMismatch('Cell 2', '192.168.125.1', undefined, a) === undefined, 'nothing expected yet: any controller is taken (and remembered)');
  const exp = expectationOf(a);
  check(exp.name === 'IRC5-CELL2' && exp.id === a.systemId, `what is remembered: ${JSON.stringify(exp)}`);
  check(identityMismatch('Cell 2', '192.168.125.1', exp, a) === undefined, 'the same controller again: fine');
  check(identityMismatch('Cell 2', '192.168.125.1', exp, { ...a, ctrlName: 'RENAMED' }) === undefined, 'renamed, same system id: still the same controller');
  check(identityMismatch('Cell 2', '192.168.125.1', { id: 'aaaa1111-0000-0000-0000-000000000001' }, a) === undefined, 'ids compare without braces and case');
  const wrong = identityMismatch('Cell 2', '192.168.125.1', exp, b) ?? '';
  check(/192\.168\.125\.1 is IRC5-CELL3 .*not IRC5-CELL2/.test(wrong) && /Forget Controller Identity/.test(wrong), `another robot on the same service port address is refused, in words: ${wrong}`);
  check(identityMismatch('VC', '127.0.0.1', { name: 'VC_A' }, { ctrlName: 'VC_B' }) !== undefined && identityMismatch('VC', '127.0.0.1', { name: 'vc_a' }, { ctrlName: 'VC_A' }) === undefined, 'with no id on either side, the name decides');
  check(controllerLabel(a) === 'IRC5-CELL2' && controllerLabel({ systemName: 'S' }) === 'S', 'the label: the controller name, else the system name');

  // /ctrl/identity read in both dialects
  const srv = http.createServer((req, res) => {
    if (req.url === '/ctrl/identity' && /hal\+json/.test(req.headers.accept ?? '')) { res.writeHead(200, { 'Content-Type': 'application/hal+json;v=2.0' }); res.end('{ "state": [ { "_type": "ctrl-identity-info", "_title": "identity", "ctrl-name": "OmniVC_1", "ctrl-type": "VIRTUAL_CONTROLLER", "ctrl-id": "1234-5678" } ]}'); }
    else if (req.url === '/ctrl/identity') { res.writeHead(200); res.end(page('ctrl-identity-info', { 'ctrl-name': 'IRC5-CELL2', 'ctrl-type': 'Real Controller', 'ctrl-id': '14-21985' })); }
    else { res.writeHead(404); res.end(); }
  });
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as { port: number }).port;
  try {
    const v = await new RwsClient({ host: '127.0.0.1', port, family: 'omnicore', https: false, user: 'Default User', password: 'robotics' }).identity();
    check(v.name === 'OmniVC_1' && v.virtual === true && v.id === '1234-5678', `RWS 2.0 identity: ${JSON.stringify(v)}`);
    const r = await new RwsClient({ host: '127.0.0.1', port, user: 'Default User', password: 'robotics' }).identity();
    check(r.name === 'IRC5-CELL2' && r.virtual === false, `RWS 1.0 identity, a real controller: ${JSON.stringify(r)}`);
  } finally { await new Promise<void>(r => srv.close(() => r())); }
}

/** #10: virtual controllers found by process, port and RWS probe, matched by controller name. */
export async function runVcDiscovery(check: (cond: unknown, msg: string) => void): Promise<void> {
  const tasks = [
    '"System Idle Process","0","Services","0","8 K"',
    '"RobotStudio.exe","4100","Console","1","812,004 K"',
    '"vrchost64.exe","5208","Console","1","402,112 K"',
    '"RobVC.exe","6012","Console","1","120,500 K"',
    '"notepad.exe","7000","Console","1","9,000 K"',
  ].join('\r\n');
  const procs = parseTasklist(tasks);
  check(procs.map(p => `${p.image}:${p.pid}:${p.family}`).join(' ') === 'vrchost64.exe:5208:omnicore RobVC.exe:6012:irc5', `the VC processes: ${JSON.stringify(procs)}`);
  const net = [
    'Active Connections', '',
    '  Proto  Local Address          Foreign Address        State           PID',
    '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1012',
    '  TCP    127.0.0.1:5466         0.0.0.0:0              LISTENING       5208',
    '  TCP    127.0.0.1:5467         0.0.0.0:0              LISTENING       5208',
    '  TCP    127.0.0.1:5466         127.0.0.1:50122        ESTABLISHED     5208',
    '  TCP    [::]:80                [::]:0                 LISTENING       6012',
    '  TCP    127.0.0.1:5466         0.0.0.0:0              LISTENING       5208',
  ].join('\r\n');
  const ports = parseNetstatListening(net, new Set([5208, 6012]));
  check(ports.get(5208)?.join(',') === '5466,5467' && ports.get(6012)?.join(',') === '80' && !ports.has(1012), `listening ports per VC, once each, IPv6 too: ${JSON.stringify([...ports])}`);

  // a stand-in OmniCore VC on a free port (RWS 2.0 over HTTP here), and a port that is not RWS
  const vc = http.createServer((req, res) => {
    if (req.headers.authorization !== `Basic ${Buffer.from('Default User:robotics').toString('base64')}`) { res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="validusers@robapi.abb"' }); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'application/hal+json;v=2.0', 'Set-Cookie': '-http-session-=v1; path=/' });
    if (req.url === '/rw/system') res.end('{ "state": [ { "_type": "sys-system", "_title": "system", "name": "OmniSys", "sysid": "{CCCC3333-0000-0000-0000-000000000003}", "major": "8", "rwversionname": "8.2.1" } ]}');
    else if (req.url === '/ctrl/identity') res.end('{ "state": [ { "_type": "ctrl-identity-info", "_title": "identity", "ctrl-name": "OmniVC_Cell4", "ctrl-type": "VIRTUAL_CONTROLLER" } ]}');
    else res.end('{}');
  });
  const other = http.createServer((_req, res) => { res.writeHead(200); res.end('hello'); });
  await new Promise<void>(r => vc.listen(0, '127.0.0.1', r));
  await new Promise<void>(r => other.listen(0, '127.0.0.1', r));
  const vcPort = (vc.address() as { port: number }).port, otherPort = (other.address() as { port: number }).port;
  try {
    const p = await probeRws('127.0.0.1', vcPort, 1000);
    check(p?.family === 'omnicore' && p.https === false, `the probe recognises RWS by its 401: ${JSON.stringify(p)}`);
    check(await probeRws('127.0.0.1', otherPort, 1000) === undefined, 'a port that is not RWS is passed over');
    const t0 = Date.now();
    const dead = await probeRws('127.0.0.1', 1, 1000);
    check(dead === undefined && Date.now() - t0 < 2500, `a closed port costs no more than the timeout: ${Date.now() - t0} ms`);
    const found = await discoverVirtualControllers({
      tasklist: async () => '"vrchost64.exe","5208","Console","1","1 K"',
      netstat: async () => `  TCP    127.0.0.1:${otherPort}  0.0.0.0:0  LISTENING  5208\r\n  TCP    127.0.0.1:${vcPort}  0.0.0.0:0  LISTENING  5208`,
    });
    check(found.length === 1 && found[0].port === vcPort && found[0].ctrlName === 'OmniVC_Cell4' && found[0].systemId === '{CCCC3333-0000-0000-0000-000000000003}' && found[0].virtual === true,
      `discovery: the RWS port of the VC process, with its name and id: ${JSON.stringify(found)}`);
    check(matchEndpoint(found, { name: 'omnivc_cell4' })?.port === vcPort && matchEndpoint(found, { id: 'cccc3333-0000-0000-0000-000000000003' })?.port === vcPort && matchEndpoint(found, { name: 'Other' }) === undefined,
      'matched by controller name or system id, not by port');
    check((await discoverVirtualControllers({ tasklist: async () => '"notepad.exe","1","Console","1","1 K"', netstat: async () => '' })).length === 0, 'no VC running: nothing found');
    check(/tasklist/.test(MANUAL_STEPS) && /netstat -ano/.test(MANUAL_STEPS), 'the manual steps say the same');
  } finally {
    await new Promise<void>(r => vc.close(() => r()));
    await new Promise<void>(r => other.close(() => r()));
  }
}

/** #11: reachable without the service port? From IP_SETTING, the wireless gateway and the options. */
export function runNetwork(check: (cond: unknown, msg: string) => void): void {
  const xhtml = parseRwsPage('<html><body><div class="state"><ul>'
    + '<li class="cfg-dt-instance-li" title="WAN_IP"><a href="instances/WAN_IP" rel="self"></a><ul>'
    + '<li class="cfg-ia-t" title="Address"><span class="value">10.20.30.40</span></li>'
    + '<li class="cfg-ia-t" title="Mask"><span class="value">255.255.255.0</span></li>'
    + '<li class="cfg-ia-t" title="Interface"><span class="value">WAN</span></li></ul></li>'
    + '<li class="cfg-dt-instance-li" title="LAN3_IP"><ul>'
    + '<li class="cfg-ia-t" title="Address"><span class="value">192.168.125.1</span></li>'
    + '<li class="cfg-ia-t" title="Interface"><span class="value">LAN3</span></li></ul></li>'
    + '</ul></div></body></html>');
  const inst = cfgInstances(xhtml);
  check(inst.length === 2 && inst[0].name === 'WAN_IP' && inst[0].attrs.Address === '10.20.30.40' && inst[1].attrs.Interface === 'LAN3', `RWS 1.0 instances with their attributes: ${JSON.stringify(inst)}`);
  const hal = parseRwsJson('{ "_embedded": { "resources": [ { "_type": "cfg-dt-instance-li", "_title": "MGMT", "attrib": [ { "_type": "cfg-ia-t", "_title": "Interface", "value": "WAN" }, { "_type": "cfg-ia-t", "_title": "DHCP", "value": "true" } ] } ] } }');
  const hi = cfgInstances(hal);
  check(hi.length === 1 && hi[0].attrs.Interface === 'WAN' && hi[0].attrs.DHCP === 'true', `RWS 2.0 instances: ${JSON.stringify(hi)}`);

  const ports = ipSettings(inst);
  const irc5No616 = reachability('irc5', ports, undefined, ['RobotWare Base', 'English']);
  check(irc5No616.serviceOnly && /616-1/.test(irc5No616.verdict), `IRC5 without PC Interface: service port only: ${irc5No616.verdict}`);
  const irc5 = reachability('irc5', ports, undefined, ['616-1 PC Interface']);
  check(!irc5.serviceOnly && irc5.ip === '10.20.30.40' && irc5.via === 'WAN', `IRC5 with 616-1 and a WAN address: that address: ${JSON.stringify(irc5)}`);
  check(irc5.notes.some(n => /LAN3: 192\.168\.125\.1/.test(n)), 'each port is listed');
  const omniDhcp = reachability('omnicore', ipSettings(hi), undefined, []);
  check(!omniDhcp.serviceOnly && omniDhcp.via === 'DHCP' && !omniDhcp.ip, `OmniCore on DHCP: reachable, the address from the network: ${omniDhcp.verdict}`);
  const none = reachability('omnicore', [{ name: 'X', port: 'WAN', address: '0.0.0.0', dhcp: false }], false, []);
  check(none.serviceOnly, `no usable address: service port only: ${none.verdict}`);
  const wifi = reachability('omnicore', [], wirelessEnabled([{ name: 'gw', attrs: { Enabled: 'true' } }]), []);
  check(!wifi.serviceOnly && wifi.via === 'wireless', `a wireless gateway: ${wifi.verdict}`);
  check(wirelessEnabled([{ name: 'gw', attrs: { Enabled: 'false' } }]) === false && wirelessEnabled([]) === undefined, 'wireless: off, or not configured');
}

/** #12: option hover (short) and panel (full), for FANUC and ABB. */
export function runOptionInfo(check: (cond: unknown, msg: string) => void): void {
  const karel = describeOption('FANUC', FANUC_OPTION_DOCS, 'R632', 'KAREL', fanucCodeNote);
  check(karel.known && karel.title === 'KAREL' && /\.PC/.test(karel.short) && karel.full.length >= 2, `FANUC R632: ${JSON.stringify(karel)}`);
  check(describeOption('FANUC', FANUC_OPTION_DOCS, 'R641', 'PC Interface', fanucCodeNote).title === 'PC Interface', 'FANUC PC Interface');
  const odd = describeOption('FANUC', FANUC_OPTION_DOCS, 'R999', 'Something New', fanucCodeNote);
  check(!odd.known && /no explanation/.test(odd.short) && /R-code: a software option/.test(odd.full[0]), `an unknown FANUC option still says what its code is: ${JSON.stringify(odd)}`);
  const pci = splitAbbOption('616-1 PC Interface');
  check(pci.code === '616-1' && pci.name === 'PC Interface' && splitAbbOption('English').code === '', 'ABB order number split from the name');
  const abb = describeOption('ABB', ABB_OPTION_DOCS, pci.code, pci.name, abbCodeNote);
  check(abb.known && /service port/.test(abb.short) && abb.full.some(p => /192\.168\.125\.1/.test(p)), `ABB 616-1: ${JSON.stringify(abb)}`);
  check(describeOption('ABB', ABB_OPTION_DOCS, '', 'Multitasking', abbCodeNote).title === 'Multitasking', 'ABB option without a number, by name');
  check(/order number/.test(describeOption('ABB', ABB_OPTION_DOCS, '1234-5', 'Unheard Of', abbCodeNote).full[0]), 'an unknown ABB option: what its number is');
  const html = optionPanelHtml({ ...odd, name: '<script>x</script>' });
  check(!/<script>x/.test(html) && /default-src 'none'/.test(html), 'the panel escapes what it shows and runs no script');
  const fanucView = fs.readFileSync(path.join(__dirname, '..', 'packages', 'fanuc', 'src', 'live', 'optionsView.ts'), 'utf8');
  const abbPage = fs.readFileSync(path.join(__dirname, '..', 'packages', 'abb', 'src', 'live', 'dashboard.ts'), 'utf8');
  check(/title="\$\{escapeHtml\(describeOption\(/.test(fanucView) && /vscode\.postMessage\(\{ info: Number\(r\.dataset\.i\) \}\)/.test(fanucView), 'FANUC options list: hover title and click');
  check(/data-opt="/.test(abbPage) && /type: 'optionInfo', index:/.test(abbPage), 'ABB option chips: hover title and click');
}

/** #13: an ABB event code -> title, cause, remedy, from what controllers' event logs said. */
export function runEventCatalog(check: (cond: unknown, msg: string) => void): void {
  const cat: EventCatalog = {};
  const n = rememberEvents(cat, [
    { code: 50204, type: 3, time: 't1', title: 'Motion supervision', description: 'Motion supervision triggered for axis 2 on ROB_1.', causes: 'The robot  hit something,\n or the load is wrong.', consequences: 'The robot stops.', actions: 'Check for collisions. Check the load data.' },
    { code: 10002, type: 1, time: 't2', title: 'Program pointer has been reset' },
  ], 'CELL2', '2026-10-08T10:00:00Z');
  check(n === 2 && cat['50204'].causes === 'The robot hit something, or the load is wrong.', `remembered, whitespace tidied: ${JSON.stringify(cat['50204'])}`);
  rememberEvents(cat, [{ code: 50204, type: 3, time: 't3', title: 'Motion supervision' }], 'CELL3');
  check(cat['50204'].actions === 'Check for collisions. Check the load data.' && cat['50204'].seenOn.join(',') === 'CELL2,CELL3', 'a later message without the texts keeps them; where it was seen grows');
  const md = eventMarkdown(cat, 50204);
  check(/\*\*50204 Motion supervision\*\*/.test(md) && /Motion domain · error · seen on CELL2, CELL3/.test(md) &&/\*\*Cause:\*\* The robot hit something/.test(md) && /\*\*Remedy:\*\* Check for collisions/.test(md),
    `title, cause and remedy: ${md}`);
  check(eventDomain(50204).name === 'Motion' && eventDomain(10002).name === 'Operational' && eventDomain(71058).name === 'I/O & Communication' && eventDomain(110001).name === 'Process', 'the event domain from the code');
  const unknown = eventMarkdown(cat, 40223);
  check(/40223.*Program \(RAPID\) event/.test(unknown) && /not known here/.test(unknown), `an unseen code: its domain, and how to fill it in: ${unknown}`);
  check(parseEventCode('Event 50204 Motion') === 50204 && parseEventCode('  E 110001 ') === 110001 && parseEventCode('1234') === undefined, 'a code out of text');
}

/** #14: features On / Off / Auto, profiles All / FANUC only / ABB only / Auto / Custom. */
export function runFeatureProfiles(check: (cond: unknown, msg: string) => void): void {
  const w = (id: Parameters<typeof profileWrites>[0]) => Object.fromEntries(profileWrites(id).map(x => [x.setting, x.value]));
  check(JSON.stringify(w('fanucOnly')) === JSON.stringify({ 'fanuc.enabled': true, 'abb.enabled': false, 'views.brands': 'fanuc' }), `FANUC only: ${JSON.stringify(w('fanucOnly'))}`);
  check(JSON.stringify(w('abbOnly')) === JSON.stringify({ 'fanuc.enabled': false, 'abb.enabled': true, 'views.brands': 'abb' }), 'ABB only');
  check(JSON.stringify(w('all')) === JSON.stringify({ 'fanuc.enabled': true, 'abb.enabled': true, 'views.brands': 'both' }), 'All');
  const auto = profileWrites('auto');
  check(auto.length === 3 && auto.every(x => x.value === undefined), 'Auto removes the brand settings, so the workspace decides again');
  check(profileWrites('custom').length === 0, 'Custom writes nothing by itself');
  check(modeOf(undefined) === 'auto' && modeOf(true) === 'on' && modeOf(false) === 'off' && valueOf('auto') === undefined && valueOf('off') === false, 'On / Off / Auto to and from a setting');
  check(profileOf({ 'fanuc.enabled': true, 'abb.enabled': false }) === 'fanucOnly' && profileOf({}) === 'auto' && profileOf({ 'fanuc.enabled': true }) === 'custom', 'what the settings amount to');
  check(FEATURES.every(f => f.setting && f.label) && FEATURES.some(f => f.id === 'robotConnections'), 'every feature names the setting it is');
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const props = Object.assign({}, ...([] as { properties?: Record<string, unknown> }[]).concat(pkg.contributes.configuration).map(c => c.properties ?? {}));
  check(FEATURES.every(f => `robotCode.${f.setting}` in props), `every feature setting exists in package.json: ${FEATURES.filter(f => !(`robotCode.${f.setting}` in props)).map(f => f.setting).join(', ')}`);
  const prof = props['robotCode.featureProfile'] as { enum: string[]; default: string } | undefined;
  check(prof?.default === 'auto' && PROFILES.every(p => prof.enum.includes(p.id)), 'robotCode.featureProfile lists every profile');
}
