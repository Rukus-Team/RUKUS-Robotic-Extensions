/**
 * Regressions from Sam's beta list 7 (2026-10-09). Synthetic, like betaList6.test.ts: nothing here
 * needs reference-backup or a controller. Wired in by test/run.ts: `run(check)` and
 * `await runAsync(check)`.
 *
 *   1. controller search (ABB and FANUC): this PC, the default addresses, wired networks, WiFi only on a yes
 *   2. program data: ABB RAPID data off a controller; FANUC user alarms (UALM)
 *   3. KAREL flowchart, as TP has
 *   4. ABB "options" sorted into what is an option and what is the robot, hardware, the system
 */
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { parseNetshWlan, listAdapters, subnetHosts, planScan, scan, tcpOpen, type Adapter } from '@core/live/netScan';
import { parseFanucHomepage } from '@core/live/fanucSearch';
import { abbTargets, searchAbbControllers, ABB_DEFAULT_HOSTS } from '@abb/live/search';
import { dataSymbolsOf } from '@abb/rws/client';
import { parseRwsPage } from '@abb/rws/xhtml';
import { parseRwsJson } from '@abb/rws/hal';
import { sortData, formatRapidData, type RapidDatum } from '@abb/live/rapidData';
import { parseUserAlarms, ualmSeverityName, KNOWN_VA_FILES } from '@fanuc/data/vaParser';
import { parseKarel } from '@fanuc/karel/parser';
import { buildKarelFlow, karelFlowScopes, scopeAt, statements } from '@fanuc/karel/flow';
import { flowToMermaid } from '@fanuc/tp/flow';
import { classifyAbbOption, groupAbbOptions, abbRobotType } from '@abb/live/optionDocs';

const WIRED: Adapter = { name: 'Ethernet', address: '192.168.125.50', netmask: '255.255.255.0', kind: 'wired' };
const WIFI: Adapter = { name: 'Wi-Fi', address: '10.0.0.241', netmask: '255.255.255.0', kind: 'wifi' };

export function run(check: (cond: unknown, msg: string) => void): void {
  // ---- #1 search: which adapters, which addresses ----
  {
    check(JSON.stringify(parseNetshWlan('\r\nThere is 1 interface on the system:\r\n\r\n    Name                   : Wi-Fi 2\r\n    Description            : Intel(R) Wi-Fi 6\r\n    State                  : connected\r\n')) === '["Wi-Fi 2"]', 'beta7 #1: netsh wlan names the WiFi adapter');
    const ad = listAdapters({
      'Ethernet': [{ address: '192.168.125.50', netmask: '255.255.255.0', family: 'IPv4', mac: '', internal: false, cidr: null }, { address: 'fe80::1', netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', mac: '', internal: false, cidr: null, scopeid: 1 }],
      'Wi-Fi 2': [{ address: '10.0.0.241', netmask: '255.255.255.0', family: 'IPv4', mac: '', internal: false, cidr: null }],
      'WLAN-Stick': [{ address: '10.1.0.5', netmask: '255.255.255.0', family: 'IPv4', mac: '', internal: false, cidr: null }],
      'vEthernet (WSL)': [{ address: '172.20.0.1', netmask: '255.255.240.0', family: 'IPv4', mac: '', internal: false, cidr: null }],
      'Loopback Pseudo-Interface 1': [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', mac: '', internal: true, cidr: null }],
      'Ethernet 3': [{ address: '169.254.10.2', netmask: '255.255.0.0', family: 'IPv4', mac: '', internal: false, cidr: null }],
    }, ['Wi-Fi 2']);
    check(ad.length === 3 && ad[0].kind === 'wired' && ad[1].kind === 'wifi' && ad[2].kind === 'wifi', `beta7 #1: wired + WiFi (by netsh and by name); virtual, loopback and no-DHCP adapters left out (${JSON.stringify(ad)})`);
    const hosts = subnetHosts('192.168.125.50', '255.255.255.0');
    check(hosts.length === 253 && hosts[0] === '192.168.125.1' && hosts.at(-1) === '192.168.125.254' && !hosts.includes('192.168.125.50'), 'beta7 #1: a /24 is 253 hosts, not the PC itself, network or broadcast');
    check(subnetHosts('10.4.7.9', '255.255.0.0').length === 253 && subnetHosts('10.4.7.9', '255.255.0.0')[0] === '10.4.7.1', 'beta7 #1: a /16 is searched as the /24 around the PC only');
    check(subnetHosts('10.0.0.5', '255.255.255.252').length === 1 && subnetHosts('10.0.0.5', '255.255.255.255').length === 0, 'beta7 #1: small subnets');

    const noWifi = abbTargets([WIRED, WIFI], false);
    const withWifi = abbTargets([WIRED, WIFI], true);
    check(ABB_DEFAULT_HOSTS[0] === '192.168.125.1' && noWifi[0].host === '192.168.125.1' && noWifi[0].source === 'default' && noWifi.filter(t => t.host === '192.168.125.1').length === 2, 'beta7 #1: ABB tries the service port 192.168.125.1 (80 and 443) first, once even though it is on the wired subnet too');
    check(!noWifi.some(t => t.host.startsWith('10.0.0.')) && withWifi.some(t => t.host === '10.0.0.1' && t.source === 'wifi'), 'beta7 #1: WiFi subnets only when the user said yes');
    check(noWifi.some(t => t.host === '192.168.125.2' && t.port === 443 && t.source === 'wired'), 'beta7 #1: the wired subnet on both RWS ports');
    const fanuc = planScan({ local: ['127.0.0.1', '127.0.0.2'], adapters: [WIFI], wifi: false, ports: [80] });
    check(fanuc.length === 2 && fanuc.every(t => t.source === 'local'), 'beta7 #1: FANUC searches loopback (ROBOGUIDE) even with only WiFi and no yes');

    check(JSON.stringify(parseFanucHomepage('<title>ROBOT Homepage</title><link href="/frs/robothp.css"><h1>ROBOT<br>Homepage</h1>\n<br>\n        Hostname: PSNGRSTLD<br>\n        Robot No: F363347<br>')) === '{"hostname":"PSNGRSTLD","robotNo":"F363347"}', 'beta7 #1: FANUC home page names host and F number');
    check(parseFanucHomepage('<html><title>RobotStudio</title></html>') === undefined && parseFanucHomepage('<title> PSNGRSTLD (robot) Homepage </title><script>window.location.href = "../FRSU/OLDHP.STM"</script>') !== undefined, 'beta7 #1: other web servers are not FANUC; an older FANUC page still is');
  }

  // ---- #2 program data ----
  {
    const xhtml = parseRwsPage(`<?xml version="1.0"?><html><head><title>rapid</title><base href="http://127.0.0.1:80/rw/rapid/"/></head><body><div class="state"><a href="symbols?action=search-symbols" rel="self"></a><ul>
      <li class="rap-sympropmod-li" title="RAPID/T_ROB1/user"><span class="symburl">RAPID/T_ROB1/user</span><span class="name">user</span><span class="symtyp">mod</span></li>
      <li class="rap-sympropvar-li" title="RAPID/T_ROB1/user/reg1"><span class="symburl">RAPID/T_ROB1/user/reg1</span><span class="name">reg1</span><span class="symtyp">var</span><span class="dattyp">num</span><span class="ndim">0</span><span class="local">false</span></li>
      <li class="rap-sympropvar-li" title="RAPID/T_ROB1/Main/flags"><span class="symburl">RAPID/T_ROB1/Main/flags</span><span class="name">flags</span><span class="symtyp">var</span><span class="dattyp">bool</span><span class="ndim">1</span><span class="dim">8</span><span class="local">true</span></li>
      <li class="rap-sympropconstant-li" title="RAPID/T_ROB1/Main/maxCount"><span class="symburl">RAPID/T_ROB1/Main/maxCount</span><span class="name">maxCount</span><span class="symtyp">con</span><span class="dattyp">dnum</span><span class="ndim">0</span></li>
      <li class="rap-symproproutine-li" title="RAPID/T_ROB1/Main/main"><span class="symburl">RAPID/T_ROB1/Main/main</span><span class="name">main</span><span class="symtyp">prc</span></li>
    </ul></div></body></html>`);
    const d1 = dataSymbolsOf(xhtml, 'T_ROB1');
    check(d1.length === 3 && d1[0].path === 'T_ROB1/user/reg1' && d1[0].storage === 'VAR' && d1[0].type === 'num' && d1[0].module === 'user', `beta7 #2: RWS 1.0 symbol search -> data only, with path, kind and type (${JSON.stringify(d1)})`);
    check(d1[1].dims === '8' && d1[1].local && d1[2].storage === 'CONST', 'beta7 #2: an array keeps its size; LOCAL and CONST come through');
    const hal = parseRwsJson('{ "_links" : { "base" : { "href" : "https://127.0.0.1:5466/rw/rapid/" }, "self" : { "href" : "symbols/search" } }, "_embedded" : { "resources" : [ { "_links" : { "self" : { "href" : "symbol/RAPID/T_ROB1/BASE/properties" } }, "_type" : "rap-sympropmod-li", "_title" : "RAPID/T_ROB1/BASE", "symburl" : "RAPID/T_ROB1/BASE", "name" : "BASE", "symtyp" : "mod" }, { "_links" : { "self" : { "href" : "symbol/RAPID/T_ROB1/BASE/tool0/properties" } }, "_type" : "rap-symproppers-li", "_title" : "RAPID/T_ROB1/BASE/tool0", "symburl" : "RAPID/T_ROB1/BASE/tool0", "name" : "tool0", "symtyp" : "per", "dattyp" : "tooldata", "ndim" : "0", "dim" : "", "local" : "false" }, { "_type" : "rap-symproppers-li", "_title" : "RAPID/T_ROB1/count", "symburl" : "RAPID/T_ROB1/count", "name" : "count", "symtyp" : "per", "dattyp" : "num", "ndim" : "0" } ] } }');
    const d2 = dataSymbolsOf(hal, 'T_ROB1');
    check(d2.length === 2 && d2[0].storage === 'PERS' && d2[0].type === 'tooldata' && d2[1].module === undefined && d2[1].path === 'T_ROB1/count', `beta7 #2: RWS 2.0 symbol search; task-global data has no module (${JSON.stringify(d2)})`);
    const rows: RapidDatum[] = [
      { ...d2[0], value: '[TRUE,[[0,0,0],[1,0,0,0]],[0.001,[0,0,0.001],[1,0,0,0],0,0,0]]' },
      { ...d1[0], value: '42' }, { ...d1[1], value: '[TRUE,FALSE,FALSE,FALSE,FALSE,FALSE,FALSE,FALSE]' }, { ...d1[2], error: 'HTTP 400' },
    ];
    check(sortData(rows).map(r => r.type).join(',') === 'bool,num,dnum,tooldata', 'beta7 #2: bool, num, dnum first, then the structured types');
    const table = formatRapidData('IRC5', rows, new Date(0));
    check(/IRC5 - 4 RAPID data/.test(table) && /T_ROB1\s+user\s+VAR\s+num\s+reg1\s+42/.test(table) && /bool\{8\}\s+flags/.test(table) && /\(not read: HTTP 400\)/.test(table) && /\(task\)|BASE/.test(table), 'beta7 #2: the RAPID data table');

    const va = [
      '[*SYSTEM*]$MAXUALRMNUM  Storage: CMOS  Access: RW  : INTEGER = 4',
      '',
      '[*SYSTEM*]$UALRM_MSG  Storage: CMOS  Access: RW  : ARRAY[4] OF STRING[29]',
      "  [1] = 'Program sel err'",
      "  [2] = 'GRPR I/F ENB, TCH GRPR DIS'",
      '  [3] = Uninitialized',
      "  [4] = ''",
      '',
      '[*SYSTEM*]$UALRM_SEV  Storage: CMOS  Access: RW  : ARRAY[4] OF BYTE',
      '  [1] = 11',
      '  [2] = 0',
      '  [3] = 0',
      '  [4] = 6',
      '',
      '[*SYSTEM*]$UI_CONFIG  Storage: CMOS  Access: RW  : INTEGER = 0',
    ].join('\r\n');
    const ua = parseUserAlarms(va);
    check(ua.length === 2 && ua[0].message === 'Program sel err' && ua[0].severity === 11 && ua[1].message === 'GRPR I/F ENB, TCH GRPR DIS' && ua[1].severity === 0, `beta7 #2: user alarms with a message, their severity (${JSON.stringify(ua)})`);
    check(ualmSeverityName(11) === 'ABORT.L' && ualmSeverityName(0) === 'WARN' && ualmSeverityName(43) === 'ABORT.G' && ualmSeverityName(99) === 'severity 99', 'beta7 #2: severity names');
    check(parseUserAlarms('[*SYSTEM*]$UI_CONFIG  Storage: CMOS').length === 0 && (KNOWN_VA_FILES as readonly string[]).includes('system.va'), 'beta7 #2: no user alarms -> none; system.va is read from backups');
  }

  // ---- #3 KAREL flowchart ----
  {
    const src = [
      'PROGRAM flowt',              // 0
      'VAR i, n : INTEGER',          // 1
      'ROUTINE helper(x : INTEGER)', // 2
      'BEGIN',                       // 3
      '  IF x > 0 THEN',             // 4
      '    n = x',                   // 5
      '  ELSE',                      // 6
      '    n = 0 ; RETURN',          // 7
      '  ENDIF',                     // 8
      'END helper',                  // 9
      'BEGIN',                       // 10
      '  retry::',                   // 11
      "  IF UNINIT(n) THEN n = 1 ; ENDIF -- one line",  // 12
      '  SELECT n OF',               // 13
      '    CASE(1): helper(1)',      // 14
      '    CASE(2,3):',              // 15
      '      n = 4',                 // 16
      '    ELSE:',                   // 17
      '      GO TO retry',           // 18
      '  ENDSELECT',                 // 19
      '  FOR i = 1 TO 3 DO',         // 20
      '    WRITE(i, CR)',            // 21
      '  ENDFOR',                    // 22
      '  REPEAT',                    // 23
      '    n = n - 1',               // 24
      '  UNTIL (n <= 0) OR',         // 25
      '        (i > 9)',             // 26
      'END flowt',                   // 27
    ];
    const prog = parseKarel(src.join('\n'));
    const scopes = karelFlowScopes(prog);
    check(scopes.length === 2 && scopes[0].name.toUpperCase() === 'HELPER' && scopes[0].begin === 3 && !scopes[1].routine, `beta7 #3: a routine and the main body (${JSON.stringify(scopes)})`);
    check(scopeAt(scopes, 2)?.name.toUpperCase() === 'HELPER' && scopeAt(scopes, 18)?.routine === false, 'beta7 #3: the scope under the cursor, header lines included');
    const st = statements(src, scopes[1]).map(s => s.code);
    check(st.includes('IF UNINIT(n) THEN') && st.includes('n = 1') && st.includes('ENDIF') && st.includes('retry::'), `beta7 #3: a one-line IF ... ; ENDIF is three statements (${JSON.stringify(st)})`);
    check(st.some(s => /^UNTIL \(n <= 0\) OR \(i > 9\)$/.test(s)), 'beta7 #3: a condition over two lines is one statement');
    const g = buildKarelFlow(prog, scopes[1]);
    const kinds = g.nodes.map(n => n.kind);
    check(kinds[0] === 'entry' && kinds.at(-1) === 'end' && kinds.filter(k => k === 'branch').length === 3 && kinds.filter(k => k === 'loop').length === 2 && kinds.includes('label'), `beta7 #3: IF, SELECT, UNTIL branches; FOR and REPEAT loops; a label (${kinds.join(',')})`);
    const cases = g.edges.filter(e => e.kind === 'case').map(e => e.label);
    check(cases.join('|') === '1|2,3|ELSE', `beta7 #3: one edge per CASE and the ELSE (${cases.join('|')})`);
    const jump = g.edges.find(e => e.kind === 'jump');
    check(jump && g.nodes[jump.to].kind === 'label' && jump.back && g.unresolved.length === 0, 'beta7 #3: GO TO retry goes back to retry::');
    check(g.edges.some(e => e.kind === 'loop' && e.back && g.nodes[e.to].title.startsWith('FOR')) && g.edges.some(e => e.kind === 'false' && e.back && g.nodes[e.to].title === 'REPEAT'), 'beta7 #3: loops have their back edges');
    check(g.nodes.some(n => n.lines.some(l => l.kind === 'call' && /helper/.test(l.text))), 'beta7 #3: a call of the program\'s own routine is marked as a call');
    const h = buildKarelFlow(prog, scopes[0]);
    check(h.edges.filter(e => g.nodes.length && h.nodes[e.to].kind === 'end').length === 2, 'beta7 #3: RETURN and the end of the IF both reach END');
    const md = flowToMermaid(g, 'flowt');
    check(md.startsWith('flowchart TD') && /-->\|.*\| B\d+/.test(md), 'beta7 #3: Copy as Mermaid works for KAREL');
  }

  // ---- #4 ABB options ----
  {
    const irc5 = ['RobotWare Base', 'English', 'Drive System IRB 7600/8700/5500', 'ADU-790A in position X3', 'Axis Calibration', 'IRB 7600-150/3.5', '616-1 PC Interface', '623-1 Multitasking', 'Pendelum Calibration', 'Service Info System'];
    check(abbRobotType(irc5) === 'IRB 7600-150/3.5', 'beta7 #4: the robot type comes out of the option list');
    check(classifyAbbOption('IRB 7600-150/3.5') === 'robot' && classifyAbbOption('IRB 7600 Base') === 'robot' && classifyAbbOption('Robots Base') === 'robot', 'beta7 #4: the robot is not an option');
    check(classifyAbbOption('Drive System IRB 7600/8700/5500') === 'hardware' && classifyAbbOption('ADU-790A in position X3') === 'hardware' && classifyAbbOption('Axis Calibration') === 'hardware' && classifyAbbOption('E8 (High Power)') === 'hardware', 'beta7 #4: drive system, drive units, calibration are hardware (the drive system names a robot but is not one)');
    check(classifyAbbOption('RobotWare Base') === 'system' && classifyAbbOption('RobotControl Base') === 'system' && classifyAbbOption('English') === 'system', 'beta7 #4: base and language are the system');
    check(classifyAbbOption('616-1 PC Interface') === 'option' && classifyAbbOption('735-8 Keyless Mode Switch, 2 modes') === 'option' && classifyAbbOption('3043-11 SafeMove Standard') === 'option', 'beta7 #4: order-numbered entries are options');
    check(classifyAbbOption('PSWIDGETS') === 'other', 'beta7 #4: an unknown add-in is other');
    const groups = groupAbbOptions(irc5);
    check(groups.map(x => x.kind).join(',') === 'option,robot,hardware,system' && groups[0].items.length === 2 && groups[0].items[0].index === 6, `beta7 #4: grouped in order, indexes kept for the option panel (${groups.map(x => `${x.kind}:${x.items.length}`).join(' ')})`);
  }
}

export async function runAsync(check: (cond: unknown, msg: string) => void): Promise<void> {
  // the scan: only open ports are probed, cancel stops it, findings come back in target order
  {
    const targets = planScan({ local: [], defaults: ['a', 'b', 'c', 'd'], ports: [80] });
    const probed: string[] = [];
    const found = await scan(targets, { open: async h => h !== 'b', probe: async t => { probed.push(t.host); return t.host === 'c' ? undefined : { ok: t.host }; }, concurrency: 2 });
    check(found.map(f => f.ok).join() === 'a,d' && !probed.includes('b'), `beta7 #1: a closed port is never probed (${JSON.stringify(found)})`);
    const stop = { isCancellationRequested: false };
    let n = 0;
    await scan(planScan({ local: [], defaults: Array.from({ length: 50 }, (_, i) => `h${i}`), ports: [80] }), { open: async () => { if (++n === 3) stop.isCancellationRequested = true; return false; }, probe: async () => undefined, concurrency: 1, signal: stop });
    check(n === 3, `beta7 #1: cancel stops the search (${n} tried)`);
  }
  // tcpOpen against a real listener and a closed port
  {
    const srv = http.createServer((_q, r) => r.end('x'));
    await new Promise<void>(r => srv.listen(0, '127.0.0.1', () => r()));
    const port = (srv.address() as AddressInfo).port;
    const open = await tcpOpen('127.0.0.1', port, 1000);
    await new Promise<void>(r => srv.close(() => r()));
    const closed = await tcpOpen('127.0.0.1', port, 1000);
    check(open && !closed, 'beta7 #1: TCP connect check');
  }
  // ABB search: virtual controllers first; the same controller on 80 and 443 listed once
  {
    const found = await searchAbbControllers({
      adapters: [], wifi: false,
      findVirtual: async () => [{ host: '127.0.0.1', port: 14568, family: 'irc5', https: false, source: 'local', ctrlName: 'VC' }],
      open: async () => false,
    });
    check(found.length === 1 && found[0].port === 14568 && found[0].source === 'local', 'beta7 #1: ABB search keeps the virtual controllers; nothing on the network answered');
  }
}
