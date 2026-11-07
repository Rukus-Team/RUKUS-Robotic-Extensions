/**
 * The 2026-11-07 button test, batch B (UI): the robot form's layout, the ABB form's virtual
 * controller button and empty password, the walkthrough's first step, the download copy, Send File
 * to Robot, the ABB rows (controller name, read times, unreadable RAPID data), the RUKUS menu
 * items, the active-alarms line, the hover on a robot's own file, and the ABB right-click menu.
 * Synthetic: nothing here needs a backup or a controller. Wired in by test/run.ts: `run(check)`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { controllerLabel, shortRobotWare } from '@abb/live/identity';
import { formValuesForVc, FACTORY_PASSWORD, type VcEndpoint } from '@abb/live/vcDiscovery';
import { formatRapidData, unreadableHoverAt, UNREADABLE, type RapidDatum } from '@abb/live/rapidData';
import { activeAlarmsMessage } from '@core/live/parsers';
import { robotDisplayName, robotOriginNote } from '@core/live/robotFileOrigin';
import { sendFileRefusal } from '@fanuc/live/sendFile';
import type { AlarmEntry } from '@core/live/types';

type Check = (cond: unknown, msg: string) => void;
const repo = path.join(__dirname, '..');

/** The direct children of the element with `id` in an HTML string, as tag names with their text. */
function childrenOf(html: string, id: string): { tag: string; html: string }[] {
  const start = html.indexOf(`id="${id}"`);
  const open = html.indexOf('>', start) + 1;
  const VOID = /^(input|br|img|hr|meta)$/i;
  const out: { tag: string; html: string }[] = [];
  let depth = 0, childStart = -1, childTag = '';
  const re = /<(\/?)([a-zA-Z]+)[^>]*>/g;
  re.lastIndex = open;
  for (let m: RegExpExecArray | null; (m = re.exec(html));) {
    const [, close, tag] = m;
    if (close) {
      if (depth === 0) break;   // the grid's own closing tag
      depth--;
      if (depth === 0) out.push({ tag: childTag, html: html.slice(childStart, re.lastIndex) });
      continue;
    }
    if (depth === 0) { childStart = m.index; childTag = tag.toLowerCase(); }
    if (VOID.test(tag)) { if (depth === 0) out.push({ tag: childTag, html: m[0] }); }
    else depth++;
  }
  return out;
}

export function run(check: Check): void {
  // ---- #5: every label of the FANUC form sits beside its own field ----
  const form = fs.readFileSync(path.join(repo, 'packages', 'core', 'src', 'live', 'robotForm.ts'), 'utf8');
  const grid = childrenOf(form, 'fanucGrid');
  check(grid.length > 0 && grid.length % 2 === 0, `the FANUC grid has label/field pairs (${grid.length} children)`);
  check(grid.every((c, i) => (i % 2 === 0) === (c.tag === 'label')), `the FANUC grid alternates label, field: ${grid.map(c => c.tag).join(' ')}`);
  const pairOf = (label: string) => { const i = grid.findIndex(c => c.tag === 'label' && c.html.includes(label)); return i >= 0 ? grid[i + 1]?.html ?? '' : ''; };
  check(/id="ftpUser"/.test(pairOf('FTP user')), 'FTP user sits with the FTP user box');
  check(/id="ftpPass"/.test(pairOf('FTP password')), 'FTP password sits with the password box');
  check(/id="device"/.test(pairOf('Device')), 'Device sits with the device box');
  check(/id="auto"/.test(pairOf('Auto-connect')), 'Auto-connect sits with its checkbox');
  check(/id="httpPort"/.test(pairOf('Ports')) && /id="ftpPort"/.test(pairOf('Ports')), 'Ports holds both port boxes');
  // the other brands' grid is built label + one div per field
  check(/return '<label for="' \+ id \+ '">' \+ esc\(f\.label\) \+ '<\/label>' \+ input;/.test(form), 'the ABB grid is built as label + one field per row');

  // ---- #16: Find virtual controllers fills host/port; an empty password is the factory one ----
  const ep: VcEndpoint = { pid: 1, image: 'RobVC.exe', port: 57289, family: 'irc5', https: false, ctrlName: 'IRC5VC DESKTOP-9A0FNHB', systemName: 'irc6_testing', virtual: true };
  const v = formValuesForVc(ep, '');
  check(v.host === '127.0.0.1' && v.port === 57289 && v.family === 'irc5' && v.https === false && v.name === 'irc6_testing', `a found VC fills the form: ${JSON.stringify(v)}`);
  check(!('name' in formValuesForVc(ep, 'MY VC')), 'a name already typed is kept');
  check(FACTORY_PASSWORD === 'robotics', 'the factory password');
  const kind = fs.readFileSync(path.join(repo, 'packages', 'abb', 'src', 'live', 'connectionKind.ts'), 'utf8');
  check(!/Enter the password to test/.test(kind) && /\?\? FACTORY_PASSWORD;/.test(kind), 'Test does not refuse an empty password; it tries the factory one');
  check(/id: 'findVirtual'/.test(kind) && /runAction/.test(kind), 'the ABB form has a Find virtual controllers button');
  check(/kindActions/.test(form) && /case 'action':/.test(form), 'the form shows a brand\'s buttons and runs them');

  // ---- #18: a VC row shows the controller's system name, not the PC's ----
  check(controllerLabel({ ctrlName: 'IRC5VC DESKTOP-9A0FNHB', systemName: 'irc6_testing' }) === 'irc6_testing', 'a VC named after the PC shows its system name');
  check(controllerLabel({ ctrlName: 'OmniVC_1', systemName: 'Omni_sys', virtual: true }) === 'Omni_sys', 'a virtual controller shows its system name');
  check(controllerLabel({ ctrlName: 'IRC5-CELL2', systemName: 'CELL2_SYS', virtual: false }) === 'IRC5-CELL2', 'a real controller keeps its own name');
  check(controllerLabel({ ctrlName: 'IRC5VC DESKTOP-9A0FNHB', virtual: true }) === 'IRC5VC DESKTOP-9A0FNHB', 'no system name: the controller name still shows');
  check(shortRobotWare('6.16.01.00') === 'RW 6.16' && shortRobotWare(undefined) === undefined, 'the RobotWare version, short');

  // ---- #19: the readout rows say when they were read ----
  const view = fs.readFileSync(path.join(repo, 'packages', 'abb', 'src', 'live', 'view.ts'), 'utf8');
  check(/it\.description = at \? `read \$\{ago\(at\)\}` : 'click to read';/.test(view), 'a readout row says "read <time ago>" once read');
  check(/snapshot\.at\.set\(readoutKey\(which\), Date\.now\(\)\)/.test(view), 'opening a readout page records its time');

  // ---- #20: an unreadable RAPID value in plain words, the controller's answer on hover ----
  const err = 'HTTP 400 /rw/rapid/symbol/data/RAPID/T_ROB1/MainModule/clk1: Bad request (RWS return code -1073414146)';
  const data: RapidDatum[] = [
    { name: 'clk1', type: 'clock', storage: 'VAR', task: 'T_ROB1', module: 'MainModule', path: 'RAPID/T_ROB1/MainModule/clk1', error: err } as RapidDatum,
    { name: 'n1', type: 'num', storage: 'VAR', task: 'T_ROB1', module: 'MainModule', path: 'RAPID/T_ROB1/MainModule/n1', value: '3' } as RapidDatum,
  ];
  const page = formatRapidData('IRC5', data, new Date(0));
  const lines = page.split('\n');
  const row = lines.findIndex(l => l.includes('clk1') && l.endsWith(UNREADABLE));
  check(row > 0, 'the clock row shows "(not readable over RWS)"');
  check(!lines[row]?.includes('HTTP 400'), 'the row itself has no raw HTTP text');
  check(/clk1: HTTP 400/.test(page) && page.includes('-1073414146'), 'the controller\'s answer is under the table');
  const hover = unreadableHoverAt(page, row) ?? '';
  check(/Not readable over Robot Web Services/.test(hover) && hover.includes('-1073414146'), `hovering the row gives the detail: ${hover}`);
  check(unreadableHoverAt(page, lines.findIndex(l => l.includes(' n1 '))) === undefined, 'a readable row has no such hover');

  // ---- #7: the active alarms line ----
  check(activeAlarmsMessage('R1', []) === 'No active alarms on R1.', 'nothing active: "No active alarms on R1."');
  const alarm = { seq: 1, time: '', code: 'SRVO-001', message: 'SRVO-001 Operator panel E-stop', severity: 'SERVO' } as unknown as AlarmEntry;
  check(activeAlarmsMessage('R1', [alarm]) === '1 active alarm on R1: SRVO-001 Operator panel E-stop', 'one active alarm, in words');
  check(activeAlarmsMessage('R1', [alarm, alarm]).startsWith('2 active alarms on R1'), 'two active alarms');
  const sync = fs.readFileSync(path.join(repo, 'packages', 'core', 'src', 'syncCommands.ts'), 'utf8');
  check(!/No controller errors read from/.test(sync), 'the old wording is gone');

  // ---- #10 / #11 / #9: a robot's file by the robot's own name, and where it came from ----
  check(robotDisplayName('r1', ['R1', 'R2']) === 'R1', 'the lower-cased URI authority r1 is robot R1');
  check(robotDisplayName('S002R01', ['S002R01']) === 'S002R01' && robotDisplayName('ghost', ['R1']) === 'ghost', 'an exact name, or the authority when no profile matches');
  const note = robotOriginNote('R1', 'MD:', 'RKEDIT.LS', 1000, 13000);
  check(/R1/.test(note) && /MD:RKEDIT\.LS/.test(note) && /12 s ago/.test(note) && /live/.test(note) && !/not inside any robot backup folder/.test(note), `the hover says where the file came from: ${note}`);
  const live = fs.readFileSync(path.join(repo, 'packages', 'core', 'src', 'live', 'index.ts'), 'utf8');
  check(!/'Open the copy'/.test(live), 'the download opens the copy itself (no "Open the copy" button that did nothing)');
  check(/title: `Download \$\{fileName\} from \$\{robot\}`/.test(live) && /const robot = robotDisplayName\(/.test(live), 'the save dialog names the robot as its profile does');
  const providers = fs.readFileSync(path.join(repo, 'packages', 'fanuc', 'src', 'tp', 'providers.ts'), 'utf8');
  check(/if \(uri\.scheme === FANUC_SCHEME\)/.test(providers), 'the register hover tells a robot\'s file apart from a file in no backup');

  // ---- #13: Send File to Robot ----
  check(sendFileRefusal('MAIN.LS') === undefined && sendFileRefusal('main.ls') === undefined, 'a .ls can be sent');
  check(/source \(\.ls\)/.test(sendFileRefusal('MAIN.TP') ?? ''), 'a .tp: send the .ls instead');
  check(/ktrans/.test(sendFileRefusal('X.KL') ?? '') && /RAPID module/.test(sendFileRefusal('M.mod') ?? ''), 'KAREL and RAPID files say why not');
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
  const menus = pkg.contributes.menus as Record<string, { command?: string; submenu?: string; when?: string; group?: string }[]>;
  check(pkg.contributes.commands.some((c: { command: string; title: string }) => c.command === 'robotCode.live.sendFile' && c.title === 'Send File to Robot…'), 'the command is contributed');
  check(menus['editor/title'].some(m => m.command === 'robotCode.live.sendFile' && /fanuc-tp/.test(m.when ?? '')), 'a title-bar button on TP editors');
  check(menus['explorer/context'].some(m => m.command === 'robotCode.live.sendFile' && /\\\.ls/.test(m.when ?? '')), 'on the Explorer right-click of a .ls');
  check(menus.commandPalette.some(m => m.command === 'robotCode.live.sendFile'), 'in the Command Palette on a TP file');
  const editorCommands = fs.readFileSync(path.join(repo, 'packages', 'fanuc', 'src', 'live', 'editorCommands.ts'), 'utf8');
  check(/reg\('robotCode\.live\.sendFile'[\s\S]{0,400}executeCommand\('robotCode\.sync\.pushFile', target\)/.test(editorCommands), 'Send hands the file to Push: one upload path, one set of gates');

  // ---- #6: the RUKUS hand-offs only when RUKUS (or RUKUS Studio) is found ----
  for (const c of ['robotCode.rukus.monitor', 'robotCode.rukus.alarms', 'robotCode.rukus.backup']) {
    const m = menus['view/item/context'].filter(x => x.command === c);
    check(m.length > 0 && m.every(x => /robotCode\.rukusAvailable/.test(x.when ?? '')), `${c} hides when RUKUS is not found`);
  }

  // ---- #4: the walkthrough's first step ticks, and names the Cell view ----
  const robot = pkg.contributes.walkthroughs.find((w: { id: string }) => w.id === 'robotCode.robot');
  check(robot.description.length <= 90, `the walkthrough's intro is short enough not to be cut (${robot.description.length})`);
  const enable = robot.steps.find((s: { id: string }) => s.id === 'robotCode.walkthrough.robot.enable');
  check(enable.completionEvents.includes('onCommand:robotCode.experimental.enableRobotConnections'), 'the step ticks when its button is used');
  check(enable.completionEvents.includes('onContext:config.robotCode.experimental.robotConnections'), 'and when the switch is already on');
  check(/\*\*Cell\*\* view/.test(enable.description) && !/Controllers/.test(enable.description), 'the step names the Cell view');
  const md = fs.readFileSync(path.join(repo, 'media', 'walkthrough', 'robot-1-enable.md'), 'utf8');
  check(!/\*\*Controllers\*\* view/.test(md), 'the step\'s page names the Cell view');

  // ---- #21: the ABB right-click menu fits: reads first, writes in submenus ---- (rows of the Cell view since batch C)
  const connected = 'view == robotCode.cell && viewItem == abb-ctrl-connected';
  const top = menus['view/item/context'].filter(m => (m.when === connected || /viewItem =~ \/\^abb-ctrl-\//.test(m.when ?? '') && /view == robotCode.cell/.test(m.when ?? '')) && !(m.group ?? '').startsWith('inline'));
  check(top.length <= 12, `the connected ABB menu has ${top.length} entries (was 21)`);
  const writes = ['setSpeed', 'motorsOn', 'motorsOff', 'startRapid', 'resetProgramPointer', 'loadModule', 'setSignal', 'setRapidData', 'requestWriteAccess', 'releaseWriteAccess'].map(c => `robotCode.abb.${c}`);
  check(!top.some(m => writes.includes(m.command ?? '')), 'no controller write at the top level (Stop RAPID stays)');
  check(writes.every(c => (menus['robotCode.abb.controlMenu'] ?? []).concat(menus['robotCode.abb.writeMenu'] ?? []).some(m => m.command === c)), 'every write is in a submenu');
  const sorted = [...top].sort((a, b) => (a.group ?? '').localeCompare(b.group ?? '', 'en', { numeric: true }));
  check(sorted[0]?.command === 'robotCode.abb.openPage' && sorted.slice(1, 5).every(m => /refresh|show/.test(m.command ?? '')), `the reads come first: ${sorted.map(m => m.command ?? m.submenu).join(', ')}`);
}
