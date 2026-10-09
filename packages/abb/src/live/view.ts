/**
 * The "ABB Controllers" sidebar section and its commands, plus the program/motion pointer
 * marks in RAPID editors.
 *
 *   IRC5-CELL2           192.168.125.1 · connected · Motors Off · Auto · 100% · RAPID Stopped (Continuous)
 *     Controller         6700-805115 · RobotWare 6.16.01.00
 *     T_ROB1             motion task · stopped
 *       Program pointer  STYLE_35L › MOV_R01_Pick_35L · line 77       click: open it
 *       Motion pointer   MAIN_MODULE › HomeRobot · line 259
 *       Modules          9
 *         MAIN_MODULE    program module                             click: read it (read-only)
 *     SC_CBC             semistatic · running
 *     Position           read 12 s ago
 *       Joints           -0.00 · -34.59 · 27.72 · -0.00 · 91.87 · 0.00
 *       TCP              X 949.17 · Y -0.02 · Z 1274.27 · cf -1,-1,0,0
 *
 * Reading happens on Connect and Get only (see controllers.ts), and a module's source when it is
 * opened. A module opened from here is the controller's text, read-only, at
 * `abb-rws:/<controller>/<task>/<module>.mod`; its line numbers are the pointers' line numbers.
 *
 * "Convert Target on Controller" turns the jointtarget or robtarget under the cursor into the
 * other with the controller's own kinematics (tool0, base frame).
 */
import * as vscode from 'vscode';
import * as path from 'node:path';
import type { Services } from '@core/services';
import { icon } from '@core/views/typeStyle';
import { viewDeclared } from '@core/util';
import { registerConnectionKind } from '@core/live/connectionKinds';
import { ctrlStateLabel, opModeLabel, execStateLabel, runModeLabel, taskTypeLabel } from './names';
import { controllerLabel } from './identity';
import { discoverVirtualControllers, matchEndpoint, MANUAL_STEPS, type VcEndpoint } from './vcDiscovery';
import { searchAbbControllers, sourceLabel, type AbbFound } from './search';
import { abbRobotType, groupAbbOptions } from './optionDocs';
import { sortData, formatRapidData, oneLine, type RapidDatum } from './rapidData';
import { SERVICE_PORT_IP } from './network';
import { chooseScanScope, scopeSummary, withScanProgress } from '@core/live/scanPrompt';
import { eventMarkdown, parseEventCode } from './eventCatalog';
import { AbbControllers, ago, type AbbConnection, type AbbProfile } from './controllers';
import type { RwsPointer, RwsModuleInfo, RwsEvent, RwsSignal } from '../rws/client';
import { defaultBackupName, validBackupName } from './backup';
import { abbConnectionKind } from './connectionKind';
import { openAbbPage } from './dashboard';
import { registerAbbActions } from './actions';
import { targetLiteralAt, formatRobtarget, formatJointtarget, declaredName, rapidNum } from './targets';

const SCHEME = 'abb-rws';
/** abb-rws:/<controller>/<task>/<module>.mod|.sys */
export function moduleUri(ctrl: string, task: string, module: string, type?: string): vscode.Uri {
  return vscode.Uri.from({ scheme: SCHEME, path: `/${encodeURIComponent(ctrl)}/${encodeURIComponent(task)}/${encodeURIComponent(module)}.${type === 'SysMod' ? 'sys' : 'mod'}` });
}
function parseModuleUri(uri: vscode.Uri): { ctrl: string; task: string; module: string } | undefined {
  const m = /^\/([^/]+)\/([^/]+)\/([^/]+)\.(?:mod|sys)$/.exec(uri.path);
  return m ? { ctrl: decodeURIComponent(m[1]), task: decodeURIComponent(m[2]), module: decodeURIComponent(m[3]) } : undefined;
}

type Node =
  | { type: 'ctrl'; c: AbbConnection }
  | { type: 'info'; c: AbbConnection }
  | { type: 'task'; c: AbbConnection; task: string }
  | { type: 'pointer'; c: AbbConnection; task: string; which: 'program' | 'motion'; p: RwsPointer }
  | { type: 'modules'; c: AbbConnection; task: string; list: RwsModuleInfo[] }
  | { type: 'module'; c: AbbConnection; task: string; m: RwsModuleInfo }
  | { type: 'position'; c: AbbConnection }
  | { type: 'readout'; c: AbbConnection; which: Readout }
  | { type: 'data'; c: AbbConnection; task: string }
  | { type: 'datum'; c: AbbConnection; d: RapidDatum }
  | { type: 'row'; label: string; description: string; tooltip?: string };

/** abb-info:/<controller>/eventlog.log | signals.txt | data.txt - read-only documents read when opened */
const INFO = 'abb-info';
type Readout = 'eventlog' | 'signals' | 'data';
const INFO_FILE: Record<Readout, string> = { eventlog: 'eventlog.log', signals: 'signals.txt', data: 'data.txt' };
const infoUri = (ctrl: string, which: Readout) => vscode.Uri.from({ scheme: INFO, path: `/${encodeURIComponent(ctrl)}/${INFO_FILE[which]}` });

/** Read every data declaration of `tasks` and its value; values one by one on the controller's queue. */
async function readRapidData(ctrls: AbbControllers, ctrl: string, tasks: string[]): Promise<RapidDatum[]> {
  return ctrls.calc(ctrl, 'RAPID data', async c => {
    const out: RapidDatum[] = [];
    for (const task of tasks) {
      for (const d of await c.searchData(task)) {
        try { out.push({ ...d, value: await c.dataValue(d.path) }); } catch (e: any) { out.push({ ...d, error: e?.message ?? String(e) }); }
      }
    }
    return out;
  });
}

const f2 = (n: number) => (Math.abs(n) < 0.005 ? '0.00' : n.toFixed(2));

class AbbTree implements vscode.TreeDataProvider<Node> {
  private readonly _onDidChange = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this._onDidChange.event;
  constructor(private readonly ctrls: AbbControllers) { ctrls.onDidChange(() => this._onDidChange.fire(undefined)); }
  refresh() { this._onDidChange.fire(undefined); }

  getChildren(el?: Node): Node[] | Promise<Node[]> {
    if (el?.type === 'data') {
      // read when expanded: a controller can hold thousands of data, and each value is a request
      return readRapidData(this.ctrls, el.c.profile.name, [el.task]).then(
        list => list.length ? sortData(list).map(d => ({ type: 'datum' as const, c: el.c, d })) : [{ type: 'row' as const, label: 'No data', description: `${el.task} declares none` }],
        e => [{ type: 'row' as const, label: 'Could not read', description: e?.message ?? String(e) }]);
    }
    if (!el) return this.ctrls.list().map(c => ({ type: 'ctrl', c }));
    if (el.type === 'ctrl') {
      if (el.c.state !== 'connected') return [];
      const s = el.c.snapshot;
      return [
        { type: 'info', c: el.c },
        ...(s.tasks ?? []).map(t => ({ type: 'task' as const, c: el.c, task: t.name })),
        { type: 'position', c: el.c },
        { type: 'readout', c: el.c, which: 'eventlog' },
        { type: 'readout', c: el.c, which: 'signals' },
        { type: 'readout', c: el.c, which: 'data' },
      ];
    }
    if (el.type === 'task') {
      const p = el.c.snapshot.pointers?.get(el.task);
      const mods = el.c.snapshot.modules?.get(el.task);
      return [
        ...(p?.program ? [{ type: 'pointer' as const, c: el.c, task: el.task, which: 'program' as const, p: p.program }] : []),
        ...(p?.motion ? [{ type: 'pointer' as const, c: el.c, task: el.task, which: 'motion' as const, p: p.motion }] : []),
        ...(mods?.length ? [{ type: 'modules' as const, c: el.c, task: el.task, list: mods }] : []),
        { type: 'data' as const, c: el.c, task: el.task },
      ];
    }
    if (el.type === 'modules') {
      // program modules first, then system modules, each by name
      const rank = (m: RwsModuleInfo) => (m.type === 'SysMod' ? 1 : 0);
      return [...el.list].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name)).map(m => ({ type: 'module' as const, c: el.c, task: el.task, m }));
    }
    if (el.type === 'position') {
      const s = el.c.snapshot;
      if (!s.joints && !s.tcp) return [{ type: 'row', label: 'Not read', description: 'press Get' }];
      const out: Node[] = [];
      if (s.joints) out.push({ type: 'row', label: 'Joints', description: s.joints.robax.map(f2).join(' · '), tooltip: `rax_1..rax_6 (degrees), read ${ago(s.at.get('position'))}` });
      if (s.tcp) out.push({ type: 'row', label: 'TCP', description: `X ${f2(s.tcp.trans[0])} · Y ${f2(s.tcp.trans[1])} · Z ${f2(s.tcp.trans[2])} · cf ${s.tcp.robconf.join(',')}`, tooltip: `In the current tool and work object, read ${ago(s.at.get('position'))}\nq ${s.tcp.rot.map(v => v.toFixed(5)).join(', ')}` });
      return out;
    }
    return [];
  }

  getTreeItem(el: Node): vscode.TreeItem {
    if (el.type === 'ctrl') {
      const c = el.c, s = c.snapshot;
      const it = new vscode.TreeItem(c.profile.name, c.state === 'connected' ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
      const lost = c.state === 'connected' && c.reachable === false;
      // the controller by its own name first: many share 192.168.125.1, so the address alone says little
      const who = c.state === 'connected' ? this.ctrls.identityOf(c) : undefined;
      const known = who ? controllerLabel(who) : this.ctrls.expected(c)?.name;
      const bits = [known && known !== c.profile.name ? known : '', `${c.profile.host}${c.profile.port ? `:${c.profile.port}` : ''}`, c.profile.family === 'omnicore' ? 'OmniCore' : '', who?.virtual ? 'virtual' : '', lost ? 'not answering' : c.state];
      if (c.state === 'connected' && s.panel) bits.push(ctrlStateLabel(s.panel.ctrlState) ?? '', opModeLabel(s.panel.opMode) ?? '', s.panel.speedRatio !== undefined ? `${s.panel.speedRatio}%` : '');
      if (c.state === 'connected' && s.execution?.state) bits.push(`RAPID ${execStateLabel(s.execution.state)}${s.execution.cycle ? ` (${runModeLabel(s.execution.cycle)})` : ''}`);
      if (c.state === 'connected' && s.access) bits.push((s.access.free ? 'write access free' : `write access: ${this.ctrls.holdsAccess(c.profile.name) ? 'this PC' : s.access.holder}`) + (s.access.externalControl === false ? ' · remote access off' : ''));
      it.description = bits.filter(Boolean).join(' · ');
      it.tooltip = (c.error ? `${c.profile.name}: ${c.error}` : `${c.profile.name} - ${c.profile.user ?? 'Default User'}@${c.profile.host}${s.at.get('state') ? `\nstate read ${ago(s.at.get('state'))}` : ''}`)
        + (who ? `\nController ${who.ctrlName ?? '?'}${who.ctrlId ? ` (id ${who.ctrlId})` : ''} · system ${who.systemName ?? '?'}${who.systemId ? ` (id ${who.systemId})` : ''} · ${who.virtual === true ? 'virtual controller' : who.virtual === false ? 'real controller' : 'virtual or real: not said'}`
          : this.ctrls.expected(c)?.id ? `\nFor controller ${this.ctrls.expected(c)!.name ?? '?'} (system id ${this.ctrls.expected(c)!.id}); another one at this address is refused` : '')
        + (c.rukusCluster ? `\nFrom RUKUS cluster ${c.rukusCluster} - edited in RUKUS` : '')
        + (s.access ? `\nWrite access: ${s.access.summary}${s.access.domains ? ` (RAPID ${s.access.domains.rapid}, configuration ${s.access.domains.cfg}, motion ${s.access.domains.motion})` : ''}` : '');
      // red whenever the connection failed or stopped answering, as on the FANUC rows
      it.iconPath = lost ? icon('error', 'charts.red') : c.state === 'connected' ? icon('plug', 'charts.green') : c.state === 'error' ? icon('error', 'charts.red') : c.state === 'connecting' ? icon('loading~spin') : icon('debug-disconnect');
      it.contextValue = `abb-ctrl-${c.state}`;
      it.command = { command: 'robotCode.abb.openPage', title: 'Open controller page', arguments: [c.profile.name] };
      return it;
    }
    if (el.type === 'info') {
      const sys = el.c.snapshot.system;
      const it = new vscode.TreeItem('Controller', vscode.TreeItemCollapsibleState.None);
      it.description = [sys?.name, sys ? abbRobotType(sys.options) : undefined, sys?.robotWareName ? `RobotWare ${sys.robotWareName}` : undefined].filter(Boolean).join(' · ');
      const robot = sys ? abbRobotType(sys.options) : undefined;
      it.tooltip = sys ? `${sys.name}${robot ? ` · ${robot}` : ''}\nRobotWare ${sys.robotWareName} (${sys.robotWare})\nsystem ${sys.sysid ?? '?'}\nstarted ${sys.started ?? '?'}${groupAbbOptions(sys.options).map(g => `\n\n${g.title}:\n${g.items.map(x => x.text).join('\n')}`).join('')}` : undefined;
      it.iconPath = icon('server');
      return it;
    }
    if (el.type === 'task') {
      const t = el.c.snapshot.tasks?.find(x => x.name === el.task);
      const has = el.c.snapshot.pointers?.get(el.task);
      const it = new vscode.TreeItem(el.task, has?.program || has?.motion ? vscode.TreeItemCollapsibleState.Expanded
        : el.c.snapshot.modules?.get(el.task)?.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
      const type = taskTypeLabel(t?.type);
      it.description = [t?.motion ? 'motion task' : type, execStateLabel(t?.execState), t?.active === false ? 'inactive' : undefined].filter(Boolean).join(' · ');
      it.tooltip = `Task ${el.task}: type ${type}, task state ${t?.taskState}, execution ${execStateLabel(t?.execState)}; read ${ago(el.c.snapshot.at.get('tasks'))}`;
      it.iconPath = icon(t?.motion ? 'robot' : 'server-process', t?.execState === 'star' ? 'charts.green' : undefined);
      return it;
    }
    if (el.type === 'pointer') {
      const p = el.p;
      const it = new vscode.TreeItem(el.which === 'program' ? 'Program pointer' : 'Motion pointer', vscode.TreeItemCollapsibleState.None);
      it.description = `${p.module} › ${p.routine}${p.begin ? ` · line ${p.begin.line}` : ''}`;
      it.tooltip = `${el.which === 'program' ? 'Where RAPID execution is' : 'The move the robot is on'} in ${el.task}, read ${ago(el.c.snapshot.at.get('tasks'))}.\nClick to open ${p.module} at that line: the workspace copy, or the controller's own text when the workspace has none.`;
      it.iconPath = icon(el.which === 'program' ? 'debug-stackframe' : 'debug-stackframe-focused', el.which === 'program' ? 'charts.yellow' : 'charts.purple');
      it.command = { command: 'robotCode.abb.openPointer', title: 'Open', arguments: [p, el.c.profile.name, el.task] };
      return it;
    }
    if (el.type === 'modules') {
      const it = new vscode.TreeItem('Modules', vscode.TreeItemCollapsibleState.Collapsed);
      it.description = String(el.list.length);
      it.tooltip = `Modules loaded in ${el.task}, read ${ago(el.c.snapshot.at.get('tasks'))}. Click one to read its source from the controller.`;
      it.iconPath = icon('files');
      return it;
    }
    if (el.type === 'module') {
      const it = new vscode.TreeItem(el.m.name, vscode.TreeItemCollapsibleState.None);
      it.description = el.m.type === 'SysMod' ? 'system module' : el.m.type === 'ProgMod' ? 'program module' : el.m.type;
      it.tooltip = `${el.task}/${el.m.name}: click to read its source from ${el.c.profile.name} (one read; the editor is read-only).`;
      it.iconPath = icon(el.m.type === 'SysMod' ? 'file-binary' : 'file-code');
      it.command = { command: 'robotCode.abb.openModule', title: 'Open', arguments: [el.c.profile.name, el.task, el.m.name, el.m.type] };
      it.contextValue = 'abb-module';
      return it;
    }
    if (el.type === 'position') {
      const it = new vscode.TreeItem('Position', vscode.TreeItemCollapsibleState.Expanded);
      it.description = el.c.snapshot.at.get('position') ? `read ${ago(el.c.snapshot.at.get('position'))}` : 'not read';
      it.iconPath = icon('location');
      return it;
    }
    if (el.type === 'readout') {
      const r = READOUT[el.which];
      const it = new vscode.TreeItem(r.label, vscode.TreeItemCollapsibleState.None);
      it.description = 'click to read';
      it.tooltip = r.tooltip;
      it.iconPath = icon(r.icon);
      it.command = { command: r.command, title: 'Open', arguments: [el.c.profile.name] };
      return it;
    }
    if (el.type === 'data') {
      const it = new vscode.TreeItem('Data', vscode.TreeItemCollapsibleState.Collapsed);
      it.description = 'expand to read';
      it.tooltip = `Every VAR, PERS and CONST declared in ${el.task} (bool, num, dnum, string, robtarget, tooldata...) with its value, read from the controller when expanded. Get on the controller reads it again.`;
      it.iconPath = icon('symbol-variable');
      return it;
    }
    if (el.type === 'datum') {
      const d = el.d;
      const it = new vscode.TreeItem(d.name, vscode.TreeItemCollapsibleState.None);
      it.description = `${d.type}${d.dims ? `{${d.dims}}` : ''} = ${d.error ? '(not read)' : oneLine(d.value ?? '')}`;
      it.tooltip = new vscode.MarkdownString().appendCodeblock(`${d.local ? 'LOCAL ' : ''}${d.storage} ${d.type} ${d.name}${d.dims ? `{${d.dims}}` : ''} := ${d.value ?? '?'};`, 'abb-rapid')
        .appendMarkdown(`\n\n${d.module ? `module \`${d.module}\` · ` : ''}task \`${d.task}\`${d.error ? `\n\nNot read: ${d.error}` : ''}`);
      it.iconPath = icon(d.storage === 'CONST' ? 'symbol-constant' : d.storage === 'PERS' ? 'symbol-field' : 'symbol-variable');
      it.contextValue = 'abb-datum';
      return it;
    }
    const it = new vscode.TreeItem(el.label, vscode.TreeItemCollapsibleState.None);
    it.description = el.description; it.tooltip = el.tooltip;
    return it;
  }
}

const EVENT_TYPE: Record<number, string> = { 1: 'info   ', 2: 'WARNING', 3: 'ERROR  ' };

/** The event log as a plain text page, newest first: one line per message, its text indented under it. */
export function formatEventLog(ctrl: string, events: RwsEvent[]): string {
  const out = [`${ctrl} - event log, newest first (${events.length} messages, read ${new Date().toLocaleString()})`, ''];
  for (const e of events) {
    out.push(`${e.time.replace(' T ', ' ')}  ${EVENT_TYPE[e.type] ?? `type ${e.type}`}  ${e.code}  ${e.title}`);
    for (const [label, text] of [['', e.description], ['Causes: ', e.causes], ['Consequences: ', e.consequences], ['Actions: ', e.actions]] as const) {
      const t = (text ?? '').replace(/\s+/g, ' ').trim();
      if (t) out.push(`      ${label}${t}`);
    }
  }
  if (!events.length) out.push('(no messages)');
  return out.join('\n') + '\n';
}

/** The I/O signals as a table, digital outputs and inputs first, each by name. */
export function formatSignals(ctrl: string, signals: RwsSignal[]): string {
  const rank = (t: string) => ['DO', 'DI', 'GO', 'GI', 'AO', 'AI'].indexOf(t) + 1 || 9;
  const list = [...signals].sort((a, b) => rank(a.type) - rank(b.type) || a.name.localeCompare(b.name));
  const w = Math.max(4, ...list.map(s => s.name.length));
  const out = [`${ctrl} - ${list.length} I/O signals (read ${new Date().toLocaleString()})`, '', `${'Name'.padEnd(w)}  Type  Value  Path`];
  for (const s of list) out.push(`${s.name.padEnd(w)}  ${s.type.padEnd(4)}  ${s.value.padEnd(5)}  ${s.path}${s.state && s.state !== 'not simulated' ? `  (${s.state})` : ''}`);
  return out.join('\n') + '\n';
}

const READOUT: Record<Readout, { label: string; tooltip: string; icon: string; command: string }> = {
  eventlog: { label: 'Event log', icon: 'output', command: 'robotCode.abb.showEventLog', tooltip: 'The newest messages of the common event log (every category), read from the controller when opened (read-only).' },
  signals: { label: 'I/O signals', icon: 'symbol-event', command: 'robotCode.abb.showSignals', tooltip: 'Every I/O signal with its value, read from the controller when opened (read-only).' },
  data: { label: 'RAPID data', icon: 'symbol-variable', command: 'robotCode.abb.showRapidData', tooltip: 'Every VAR, PERS and CONST of every task (bool, num, dnum, string, robtarget...) with its value, read from the controller when opened (read-only).' },
};

/** The module in the workspace index with this name (RAPID names are case-insensitive), preferring a working copy. */
function findModule(s: Services, name: string): vscode.Uri | undefined {
  const hit = s.index.list().filter(p => p.brand === 'abb' && p.name === name.toUpperCase()).sort((a, b) => +!!a.reference - +!!b.reference)[0];
  return hit?.uri;
}

export function registerAbbControllers(ctx: vscode.ExtensionContext, s: Services): AbbControllers {
  const ctrls = new AbbControllers(ctx.secrets, s.output, ctx.globalState);
  const tree = new AbbTree(ctrls);
  const view = viewDeclared(ctx, 'robotCode.abbControllers') ? vscode.window.createTreeView('robotCode.abbControllers', { treeDataProvider: tree }) : undefined;
  const reg = (id: string, fn: (...a: any[]) => any) => ctx.subscriptions.push(vscode.commands.registerCommand(id, fn));
  const nameOf = async (node?: any, only?: (c: AbbConnection) => boolean): Promise<string | undefined> => {
    if (typeof node === 'string') return node;
    if (node?.c?.profile?.name) return node.c.profile.name;
    const list = ctrls.list().filter(c => !only || only(c));
    if (list.length === 1) return list[0].profile.name;
    return (await vscode.window.showQuickPick(list.map(c => ({ label: c.profile.name, description: `${c.profile.host} · ${c.state}` })), { placeHolder: 'ABB controller' }))?.label;
  };
  const show = (e: unknown) => void vscode.window.showErrorMessage(`ABB: ${(e as any)?.message ?? e}`);

  ctx.subscriptions.push(ctrls, ...(view ? [view] : []));

  // ABB's tab of the Robot Connections form (the FANUC / ABB selector)
  ctx.subscriptions.push(registerConnectionKind(abbConnectionKind(ctrls)));
  reg('robotCode.abb.addController', () => vscode.commands.executeCommand('robotCode.live.addRobot', { brand: 'abb' }));
  reg('robotCode.abb.editController', async (node?: any) => {
    const name = await nameOf(node); if (!name) return;
    await vscode.commands.executeCommand('robotCode.live.addRobot', { brand: 'abb', name });
  });

  /**
   * An event code -> title, cause, consequence, remedy (eventCatalog.ts): from what controllers'
   * event logs said, kept on this PC. `code` is for tests and scripts; it returns the Markdown.
   */
  reg('robotCode.abb.lookupEvent', async (code?: number | string) => {
    const sel = vscode.window.activeTextEditor?.document.getText(vscode.window.activeTextEditor.selection);
    let n = code !== undefined ? parseEventCode(String(code)) : undefined;
    if (n === undefined) {
      const typed = await vscode.window.showInputBox({ title: 'ABB event code', prompt: 'The 5- or 6-digit number from the event log or the FlexPendant, e.g. 50204', value: sel && parseEventCode(sel) !== undefined ? String(parseEventCode(sel)) : undefined, validateInput: v => (parseEventCode(v) === undefined ? 'A 5- or 6-digit event number' : undefined) });
      if (typed === undefined) return;
      n = parseEventCode(typed)!;
    }
    const md = eventMarkdown(ctrls.eventCatalog(), n);
    if (code === undefined) {
      const doc = await vscode.workspace.openTextDocument({ content: md, language: 'markdown' });
      await vscode.commands.executeCommand('markdown.showPreview', doc.uri).then(undefined, () => vscode.window.showTextDocument(doc));
    }
    return md;
  });

  // a code in the event log page: its title, cause and remedy on hover
  ctx.subscriptions.push(vscode.languages.registerHoverProvider({ scheme: INFO }, {
    provideHover(doc, pos) {
      const r = doc.getWordRangeAtPosition(pos, /\b\d{5,6}\b/);
      if (!r) return undefined;
      return new vscode.Hover(new vscode.MarkdownString(eventMarkdown(ctrls.eventCatalog(), Number(doc.getText(r)))), r);
    },
  }));

  /** The profile takes whichever controller answers on its next Connect (one set in the profile itself stays). */
  reg('robotCode.abb.forgetIdentity', async (node?: any) => {
    const name = await nameOf(node); if (!name) return;
    const c = ctrls.get(name);
    if (c?.profile.controllerId || c?.profile.controllerName) { vscode.window.showInformationMessage(`${name} names its controller in settings (controllerName / controllerId): change it there.`); return; }
    await ctrls.forgetIdentity(name);
    vscode.window.showInformationMessage(`${name}: the next Connect takes whichever controller answers at ${c?.profile.host ?? 'its address'}, and remembers it.`);
  });

  reg('robotCode.abb.removeController', async (node?: any) => {
    const name = await nameOf(node); if (!name) return;
    const fromRukus = ctrls.clusterOf(name);
    if (fromRukus) { vscode.window.showInformationMessage(`${name} comes from RUKUS cluster ${fromRukus}. Remove it in RUKUS; it leaves this list on the next sync.`); return; }
    const ok = await vscode.window.showWarningMessage(`Remove ${name} and forget its password?`, { modal: true }, 'Remove');
    if (!ok) return;
    await ctrls.disconnect(name); await ctrls.forgetPassword(name);
    const cfg = vscode.workspace.getConfiguration('robotCode');
    const inspect = cfg.inspect<AbbProfile[]>('abb.controllers');
    for (const [target, value] of [[vscode.ConfigurationTarget.Workspace, inspect?.workspaceValue], [vscode.ConfigurationTarget.Global, inspect?.globalValue]] as const) {
      if (value?.some(p => p.name === name)) await cfg.update('abb.controllers', value.filter(p => p.name !== name), target);
    }
  });

  /** Connect: log in, read identity, then the view's contents. `password` is for tests and scripts; it is stored like one typed in. */
  reg('robotCode.abb.connect', async (node?: any, password?: string) => {
    const name = await nameOf(node, c => c.state !== 'connected'); if (!name) return;
    if (typeof password === 'string') await ctrls.setPassword(name, password);
    if (!(await ctrls.hasPassword(name))) {
      const pw = await vscode.window.showInputBox({ title: `Password for ${name}`, prompt: 'Kept in VS Code\'s secret storage. The factory default is robotics.', password: true });
      if (pw === undefined) return;
      await ctrls.setPassword(name, pw);
    }
    try { await ctrls.connect(name); await ctrls.refresh(name); }
    catch (e: any) {
      // a virtual controller on this PC moved to a new port: offer to find it
      const c = ctrls.get(name);
      if (c && /^(127\.|localhost$)/.test(c.profile.host) && /ECONNREFUSED|did not answer/i.test(e?.message ?? '')) {
        const pick = await vscode.window.showErrorMessage(`ABB: ${e?.message ?? e}`, { detail: 'A RobotStudio virtual controller listens on a new port each time it starts.' }, 'Find Virtual Controller');
        if (pick) await vscode.commands.executeCommand('robotCode.abb.findVirtualControllers', name);
      } else show(e);
    }
  });

  /**
   * Find the RobotStudio virtual controllers running on this PC (vcDiscovery.ts) and point a profile
   * at the right one by controller name - its port changes at every start. With a profile: that
   * profile's controller. Without: every one found, to update or add a profile.
   */
  reg('robotCode.abb.findVirtualControllers', async (node?: any) => {
    const name = node === undefined ? undefined : await nameOf(node);
    const c = name ? ctrls.get(name) : undefined;
    const manual = async (why: string) => {
      if (await vscode.window.showInformationMessage(why, 'Show the Manual Steps') === 'Show the Manual Steps') {
        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ content: MANUAL_STEPS, language: 'plaintext' }));
      }
    };
    let found: VcEndpoint[];
    try {
      const password = name ? await ctrls.getPassword(name) : undefined;
      found = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Looking for RobotStudio virtual controllers…' },
        () => discoverVirtualControllers({ user: c?.profile.user, password }));
    } catch (e: any) { await manual(`Could not look for virtual controllers: ${e?.message ?? e}.`); return; }
    if (!found.length) { await manual('No RobotStudio virtual controller (vrchost64 / RobVC) with Robot Web Services is running on this PC.'); return; }
    const save = async (target: string, ep: VcEndpoint) => {
      const cfg = vscode.workspace.getConfiguration('robotCode');
      const inspect = cfg.inspect<AbbProfile[]>('abb.controllers');
      for (const [where, value] of [[vscode.ConfigurationTarget.Workspace, inspect?.workspaceValue], [vscode.ConfigurationTarget.Global, inspect?.globalValue]] as const) {
        if (!value?.some(p => p.name === target)) continue;
        await cfg.update('abb.controllers', value.map(p => (p.name === target ? { ...p, host: '127.0.0.1', port: ep.port, family: ep.family, https: ep.https } : p)), where);
        return true;
      }
      return false;
    };
    const label = (ep: VcEndpoint) => ep.ctrlName ?? ep.systemName ?? `${ep.image} (PID ${ep.pid})`;
    if (c) {
      if (ctrls.clusterOf(c.profile.name)) { vscode.window.showInformationMessage(`${c.profile.name} comes from RUKUS: change its port there. Found: ${found.map(e => `${label(e)} on ${e.port}`).join(', ')}.`); return; }
      const want = ctrls.expected(c) ?? { name: c.profile.name };
      let ep = matchEndpoint(found, want);
      if (!ep) {
        const pick = await vscode.window.showQuickPick(found.map(e => ({ label: label(e), description: `port ${e.port} · ${e.family === 'omnicore' ? 'OmniCore' : 'IRC5'}${e.error ? ` · ${e.error}` : ''}`, e })),
          { title: `None is named ${want.name ?? c.profile.name}: which one is ${c.profile.name}?` });
        if (!pick) return;
        ep = pick.e;
      }
      if (await save(c.profile.name, ep)) {
        vscode.window.showInformationMessage(`${c.profile.name}: ${label(ep)} is on port ${ep.port} now.`, 'Connect').then(go => { if (go) void vscode.commands.executeCommand('robotCode.abb.connect', c.profile.name); });
      }
      return;
    }
    const pick = await vscode.window.showQuickPick(found.map(e => ({ label: label(e), description: `127.0.0.1:${e.port} · ${e.family === 'omnicore' ? 'OmniCore' : 'IRC5'}${e.systemName && e.systemName !== e.ctrlName ? ` · system ${e.systemName}` : ''}`, detail: e.error, e })),
      { title: `${found.length} virtual controller${found.length === 1 ? '' : 's'} running on this PC` });
    if (!pick) return;
    const ep = pick.e;
    const owner = ctrls.list().find(x => matchEndpoint([ep], ctrls.expected(x) ?? { name: x.profile.name }));
    if (owner && await save(owner.profile.name, ep)) { vscode.window.showInformationMessage(`${owner.profile.name}: port ${ep.port}.`); return; }
    const cfg = vscode.workspace.getConfiguration('robotCode');
    const profile: AbbProfile = { name: label(ep), host: '127.0.0.1', port: ep.port, ...(ep.family === 'omnicore' ? { family: 'omnicore' as const } : {}), ...(ep.https ? { https: true } : {}), ...(ep.ctrlName ? { controllerName: ep.ctrlName } : {}), ...(ep.systemId ? { controllerId: ep.systemId } : {}) };
    await cfg.update('abb.controllers', [...cfg.get<AbbProfile[]>('abb.controllers', []), profile], vscode.workspace.workspaceFolders ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage(`Added ${profile.name} (127.0.0.1:${ep.port}).`);
  });
  /**
   * Search for ABB controllers (search.ts): virtual controllers on this PC, the service port
   * address 192.168.125.1, wired networks, and WiFi when the user says yes. Pick one to add it,
   * or to point the profile that is for it at its address.
   */
  reg('robotCode.abb.searchControllers', async () => {
    const scope = await chooseScanScope('ABB'); if (!scope) return;
    const found = await withScanProgress('Searching for ABB controllers…', (token, progress) =>
      searchAbbControllers({ adapters: scope.adapters, wifi: scope.wifi, signal: token, progress }));
    if (!found.length) {
      vscode.window.showInformationMessage(`No ABB controller answered Robot Web Services on ${scopeSummary(scope)} or ${SERVICE_PORT_IP}.`,
        { detail: 'A real IRC5 answers on its WAN port only with the PC Interface option (616-1); on the service port it always answers. A RobotStudio virtual controller has to be running.' });
      return;
    }
    const label = (f: AbbFound) => f.ctrlName ?? f.systemName ?? f.host;
    const known = (f: AbbFound) => ctrls.list().find(x => x.profile.host === f.host && (x.profile.port ?? (x.profile.https ? 443 : 80)) === f.port)
      ?? ctrls.list().find(x => !!matchEndpoint([{ ...f, pid: 0, image: '' }], ctrls.expected(x) ?? { name: x.profile.name }));
    const pick = await vscode.window.showQuickPick(found.map(f => {
      const owner = known(f);
      return {
        label: label(f),
        description: `${f.host}:${f.port} · ${f.family === 'omnicore' ? 'OmniCore' : 'IRC5'}${f.virtual ? ' · virtual' : ''} · ${sourceLabel(f.source)}`,
        detail: owner ? `already added as ${owner.profile.name}` : f.error ? `could not log in with the factory login: ${f.error}` : undefined,
        f, owner,
      };
    }), { title: `${found.length} ABB controller${found.length === 1 ? '' : 's'} found - pick one to add it` });
    if (!pick) return;
    const f = pick.f;
    const patch = { host: f.host, port: f.port, family: f.family, https: f.https };
    const cfg = vscode.workspace.getConfiguration('robotCode');
    if (pick.owner) {
      const name = pick.owner.profile.name;
      if (ctrls.clusterOf(name)) { vscode.window.showInformationMessage(`${name} comes from RUKUS: change its address there (${f.host}:${f.port}).`); return; }
      const inspect = cfg.inspect<AbbProfile[]>('abb.controllers');
      for (const [where, value] of [[vscode.ConfigurationTarget.Workspace, inspect?.workspaceValue], [vscode.ConfigurationTarget.Global, inspect?.globalValue]] as const) {
        if (!value?.some(p => p.name === name)) continue;
        await cfg.update('abb.controllers', value.map(p => (p.name === name ? { ...p, ...patch } : p)), where);
        break;
      }
      vscode.window.showInformationMessage(`${name}: ${f.host}:${f.port}.`, 'Connect').then(go => { if (go) void vscode.commands.executeCommand('robotCode.abb.connect', name); });
      return;
    }
    const taken = new Set(ctrls.list().map(x => x.profile.name));
    let name = label(f);
    for (let i = 2; taken.has(name); i++) name = `${label(f)} (${i})`;
    const profile: AbbProfile = {
      name, host: f.host,
      ...(f.port !== (f.https ? 443 : 80) ? { port: f.port } : {}),
      ...(f.family === 'omnicore' ? { family: 'omnicore' as const } : {}), ...(f.https ? { https: true } : {}),
      ...(f.ctrlName ? { controllerName: f.ctrlName } : {}), ...(f.systemId ? { controllerId: f.systemId } : {}),
    };
    await cfg.update('abb.controllers', [...cfg.get<AbbProfile[]>('abb.controllers', []), profile], vscode.workspace.workspaceFolders ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage(`Added ${name} (${f.host}:${f.port}).${f.error ? ' Set its login with Edit Connection before connecting.' : ''}`, 'Connect').then(go => { if (go) void vscode.commands.executeCommand('robotCode.abb.connect', name); });
  });
  reg('robotCode.abb.refresh', async (node?: any) => {
    const name = await nameOf(node, c => c.state === 'connected'); if (!name) return;
    try { await ctrls.refresh(name); } catch (e) { show(e); }
  });
  reg('robotCode.abb.disconnect', async (node?: any) => {
    const name = await nameOf(node, c => c.state === 'connected'); if (!name) return;
    await ctrls.disconnect(name);
  });
  // ---- event log and I/O signals: read-only documents, read from the controller each time they are opened ----
  const onDidChangeInfo = new vscode.EventEmitter<vscode.Uri>();
  ctx.subscriptions.push(onDidChangeInfo, vscode.workspace.registerTextDocumentContentProvider(INFO, {
    onDidChange: onDidChangeInfo.event,
    provideTextDocumentContent: async uri => {
      const m = /^\/([^/]+)\/(eventlog\.log|signals\.txt|data\.txt)$/.exec(uri.path);
      if (!m) return '';
      const ctrl = decodeURIComponent(m[1]);
      try {
        if (m[2] === 'eventlog.log') {
          const events = await ctrls.calc(ctrl, 'event log', c => c.eventLog(0, 100));
          await ctrls.rememberEvents(ctrl, events);   // the codes, for ABB: Look Up Event Code
          return formatEventLog(ctrl, events);
        }
        if (m[2] === 'data.txt') {
          const tasks = ctrls.get(ctrl)?.snapshot.tasks?.map(t => t.name) ?? (await ctrls.calc(ctrl, 'tasks', c => c.tasks())).map(t => t.name);
          return formatRapidData(ctrl, await readRapidData(ctrls, ctrl, tasks));
        }
        return formatSignals(ctrl, await ctrls.calc(ctrl, 'signals', c => c.signals()));
      } catch (e: any) { return `Could not read from ${ctrl}: ${e?.message ?? e}\n`; }
    },
  }));
  const showInfo = async (which: Readout, node?: any) => {
    const name = await nameOf(node, c => c.state === 'connected'); if (!name) return;
    const uri = infoUri(name, which);
    onDidChangeInfo.fire(uri);   // read again when it is already open
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: false });
  };
  reg('robotCode.abb.openPage', async (node?: any) => { const name = await nameOf(node); if (name) openAbbPage(ctx, ctrls, name); });
  reg('robotCode.abb.showEventLog', (node?: any) => showInfo('eventlog', node));
  reg('robotCode.abb.showSignals', (node?: any) => showInfo('signals', node));
  reg('robotCode.abb.showRapidData', (node?: any) => showInfo('data', node));

  // the controller's module text, read when a module is opened and again when it is opened while open
  const onDidChangeModule = new vscode.EventEmitter<vscode.Uri>();
  ctx.subscriptions.push(onDidChangeModule, vscode.workspace.registerTextDocumentContentProvider(SCHEME, {
    onDidChange: onDidChangeModule.event,
    provideTextDocumentContent: async uri => {
      const at = parseModuleUri(uri);
      if (!at) return '';
      try { return (await ctrls.moduleText(at.ctrl, at.task, at.module)).text; } catch (e: any) {
        show(e);
        return `! ${at.task}/${at.module} could not be read from ${at.ctrl}: ${e?.message ?? e}\n`;
      }
    },
  }));
  const openModule = async (ctrl: string, task: string, module: string, type?: string, preview = true) => {
    const uri = moduleUri(ctrl, task, module, type);
    if (vscode.workspace.textDocuments.some(d => d.uri.toString() === uri.toString())) onDidChangeModule.fire(uri);
    let doc = await vscode.workspace.openTextDocument(uri);
    if (doc.languageId !== 'abb-rapid') doc = await vscode.languages.setTextDocumentLanguage(doc, 'abb-rapid');
    return vscode.window.showTextDocument(doc, { preview });
  };
  reg('robotCode.abb.openModule', async (ctrl: string, task: string, module: string, type?: string) => {
    try { await openModule(ctrl, task, module, type); } catch (e) { show(e); }
  });

  reg('robotCode.abb.openPointer', async (p: RwsPointer, ctrl?: string, task?: string) => {
    const uri = findModule(s, p.module);
    const live = ctrl && task && ctrls.get(ctrl)?.state === 'connected';
    if (!uri && !live) { vscode.window.showInformationMessage(`${p.module} is not in the workspace. Open the backup or folder that holds it to jump to ${p.routine}.`); return; }
    // the workspace copy when there is one (it is what gets edited); otherwise the controller's own text
    const type = live ? ctrls.get(ctrl!)?.snapshot.modules?.get(task!)?.find(m => m.name.toUpperCase() === p.module.toUpperCase())?.type : undefined;
    const ed = uri ? await vscode.window.showTextDocument(uri, { preview: true }) : await openModule(ctrl!, task!, p.module, type);
    if (p.begin) {
      const a = new vscode.Position(p.begin.line - 1, Math.max(0, p.begin.col - 1));
      const b = p.end && p.end.line === p.begin.line ? new vscode.Position(p.end.line - 1, p.end.col) : a;
      ed.selection = new vscode.Selection(a, b); ed.revealRange(new vscode.Range(a, b), vscode.TextEditorRevealType.InCenter);
    }
  });
  /**
   * The jointtarget or robtarget under the cursor, converted by the controller. The answer is for
   * tool0 in the base frame: a robtarget taught in another tool or work object is not converted
   * as that tool/wobj (the pick says so). Nothing is written to the controller; the result goes to
   * the clipboard or a new declaration under the line, as the user picks.
   */
  reg('robotCode.abb.convertTarget', async (ctrlArg?: string) => {
    const ed = vscode.window.activeTextEditor;
    if (!ed || ed.document.languageId !== 'abb-rapid') return;
    const doc = ed.document;
    const lit = targetLiteralAt(doc.getText(), doc.offsetAt(ed.selection.active));
    if (!lit) { vscode.window.showInformationMessage('Put the cursor in a jointtarget [[j1..j6],[ext]] or robtarget [[x,y,z],[q1..q4],[cf1,cf4,cf6,cfx],[ext]] value.'); return; }
    const name = await nameOf(ctrlArg, c => c.state === 'connected'); if (!name) return;
    const line = doc.lineAt(doc.positionAt(lit.start).line);
    const declared = declaredName(line.text);
    const frame = 'tool0, base frame (wobj0)';
    type Pick = vscode.QuickPickItem & { value?: string; decl?: string };
    let items: Pick[];
    let title: string;
    try {
      if (lit.kind === 'joints') {
        const pose = await ctrls.calc(name, 'CalcPoseFromJoints', (c, mu) => c.poseFromJoints(lit.robax, { mechUnit: mu }));
        const value = formatRobtarget(pose, lit.extax);
        title = `robtarget for these joints on ${name} - ${frame}`;
        items = [{ label: value, description: `cf ${pose.robconf.join(',')}`, value, decl: `CONST robtarget ${declared ? `${declared}_p` : 'pConverted'} := ${value};` }];
      } else {
        const pose = { trans: lit.trans, rot: lit.rot, robconf: lit.robconf };
        const near = ctrls.get(name)?.snapshot.joints?.robax ?? [0, 0, 0, 0, 0, 0];
        const all = await ctrls.calc(name, 'AllJointSolutions', (c, mu) => c.allJointSolutions(pose, { mechUnit: mu }));
        if (!all.length) throw new Error('the controller found no joint solution for this robtarget');
        const same = (a: number[], b: number[]) => a.every((v, i) => v === b[i]);
        const dist = (j: number[]) => Math.max(...j.map((v, i) => Math.abs(v - near[i])));
        title = `jointtargets for this robtarget on ${name} - ${frame}`;
        items = all.sort((a, b) => +!same(a.robconf, lit.robconf) - +!same(b.robconf, lit.robconf) || dist(a.joints) - dist(b.joints)).map(sol => {
          const value = formatJointtarget(sol.joints, lit.extax);
          return {
            label: value, value,
            description: `cf ${sol.robconf.join(',')}${same(sol.robconf, lit.robconf) ? ' · the configuration this robtarget names' : ''}`,
            detail: `largest joint move from ${ctrls.get(name)?.snapshot.joints ? 'the robot now' : 'zero'}: ${rapidNum(dist(sol.joints), 1)}°`,
            decl: `CONST jointtarget ${declared ? `${declared}_j` : 'jConverted'} := ${value};`,
          };
        });
      }
    } catch (e) { show(e); return; }
    const pick = await vscode.window.showQuickPick(items, { title, placeHolder: 'Pick a value, then copy it or insert it as a declaration', matchOnDescription: true });
    if (!pick?.value) return;
    const how = await vscode.window.showQuickPick([{ label: 'Copy', id: 'copy' }, { label: 'Insert declaration below', description: pick.decl, id: 'insert' }], { title: 'Use the converted value' });
    if (how?.id === 'copy') { await vscode.env.clipboard.writeText(pick.value); vscode.window.setStatusBarMessage('$(check) Converted value copied', 3000); }
    if (how?.id === 'insert' && pick.decl) {
      const indent = /^\s*/.exec(line.text)?.[0] ?? '';
      await ed.edit(b => b.insert(line.range.end, `\n${indent}${pick.decl}`));
    }
  });

  /**
   * Back Up and Download: the FlexPendant's Backup (into $BACKUP/<name> on the controller), then
   * every file of it to a folder on this PC. The one write this section makes, so it is confirmed
   * every time. `opts` is for tests and scripts: given, nothing is asked.
   */
  reg('robotCode.abb.backup', async (node?: any, opts?: { name?: string; folder?: string; remove?: boolean }) => {
    const name = await nameOf(node, c => c.state === 'connected'); if (!name) return;
    const c = ctrls.get(name)!;
    const LAST = 'robotCode.abb.backupFolder';
    let backupName = opts?.name, folder = opts?.folder, remove = opts?.remove ?? false;
    if (!opts) {
      backupName = await vscode.window.showInputBox({
        title: `Back up ${name} (1/2): backup name`, value: defaultBackupName(c.snapshot.system?.name),
        prompt: `The folder the controller writes under $BACKUP, and the folder it is downloaded as.`,
        validateInput: v => (validBackupName(v) ? undefined : 'Letters, digits, _ - and . only (no spaces), up to 64 characters'),
      });
      if (!backupName) return;
      const last = ctx.globalState.get<string>(LAST);
      const picked = await vscode.window.showOpenDialog({
        title: `Back up ${name} (2/2): download into which folder?`, canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: 'Download Here',
        defaultUri: last ? vscode.Uri.file(last) : vscode.workspace.workspaceFolders?.[0]?.uri,
      });
      if (!picked?.[0]) return;
      folder = picked[0].fsPath;
      const keep = 'Back Up (keep a copy on the controller)', drop = 'Back Up, then remove it from the controller';
      const ok = await vscode.window.showWarningMessage(`Take a backup of ${name}?`, {
        modal: true,
        detail: `The controller writes ${backupName} under $BACKUP, as a backup from the FlexPendant does; RAPID keeps running and nothing else on the controller changes. Then it is downloaded to ${path.join(folder, backupName)}.\n\n"Remove" deletes only that backup folder from the controller once it is on this PC.`,
      }, keep, drop);
      if (!ok) return;
      remove = ok === drop;
      await ctx.globalState.update(LAST, folder);
    }
    if (!backupName || !folder) return;
    try {
      const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Backing up ${name}`, cancellable: false }, async p => {
        let lastDone = 0;
        return ctrls.backup(name, backupName!, folder!, {
          remove,
          progress: (msg, done, total) => {
            const inc = total && done !== undefined ? ((done - lastDone) / total) * 100 : undefined;
            if (done !== undefined) lastDone = done;
            p.report({ message: total ? `${msg} (${Math.min((done ?? 0) + 1, total)} of ${total})` : msg, increment: inc });
          },
        });
      });
      const where = vscode.Uri.file(r.local);
      const inWorkspace = !!vscode.workspace.getWorkspaceFolder(where);
      const reveal = 'Reveal in File Explorer', add = 'Add to Workspace';
      const next = opts ? undefined : await vscode.window.showInformationMessage(
        `Backup ${backupName}: ${r.files} files (${(r.bytes / 1024).toFixed(0)} KB) downloaded to ${r.local}${r.removed ? ', removed from the controller' : ''}.${inWorkspace ? ' It is in the workspace, so the RAPID view lists it.' : ''}`,
        reveal, ...(inWorkspace ? [] : [add]));
      if (next === reveal) void vscode.commands.executeCommand('revealFileInOS', where);
      if (next === add) vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders?.length ?? 0, 0, { uri: where });
      return r;
    } catch (e) { show(e); return undefined; }
  });

  // hidden: what the section shows, for the smoke test
  reg('robotCode.abb._state', async () => {
    const lines: string[] = [];
    const walk = async (n: Node | undefined, depth: number) => {
      // RAPID data is read only when expanded: the state listing leaves it closed
      if (n?.type === 'data') return;
      for (const k of await tree.getChildren(n)) {
        const it = tree.getTreeItem(k);
        lines.push(`${'  '.repeat(depth)}${typeof it.label === 'string' ? it.label : it.label?.label ?? ''}${it.description ? ` — ${it.description}` : ''}`);
        await walk(k, depth + 1);
      }
    };
    await walk(undefined, 0);
    return { lines, requests: ctrls.list().map(c => ({ name: c.profile.name, requests: c.client?.requests ?? 0, state: c.state })) };
  });

  // hidden: a RAPID value and who holds write access, for the smoke test of the actions
  reg('robotCode.abb._symbol', (name: string, task: string, data: string, module?: string) => ctrls.calc(name, `read ${task}/${data}`, c => c.symbol(task, data, module)));
  reg('robotCode.abb._holdsAccess', (name: string) => ctrls.holdsAccess(name));
  reg('robotCode.abb._signals', (name: string) => ctrls.calc(name, 'signals', c => c.signals()));
  registerAbbActions(ctx, ctrls, nameOf);
  registerPointerMarks(ctx, ctrls);
  const updateContext = () => void vscode.commands.executeCommand('setContext', 'robotCode.abbConnected', ctrls.connected().length > 0);
  ctx.subscriptions.push(ctrls.onDidChange(updateContext));
  updateContext();
  return ctrls;
}

/**
 * Program and motion pointer marks in open RAPID editors, from the last read. A mark carries
 * its age in the hover: it says where the pointer WAS when Get was pressed.
 */
function registerPointerMarks(ctx: vscode.ExtensionContext, ctrls: AbbControllers) {
  const prog = vscode.window.createTextEditorDecorationType({
    isWholeLine: true, backgroundColor: new vscode.ThemeColor('editor.stackFrameHighlightBackground'),
    overviewRulerColor: new vscode.ThemeColor('charts.yellow'), overviewRulerLane: vscode.OverviewRulerLane.Left,
    after: { margin: '0 0 0 2em', color: new vscode.ThemeColor('descriptionForeground') },
  });
  const motion = vscode.window.createTextEditorDecorationType({
    isWholeLine: true, backgroundColor: new vscode.ThemeColor('editor.focusedStackFrameHighlightBackground'),
    overviewRulerColor: new vscode.ThemeColor('charts.purple'), overviewRulerLane: vscode.OverviewRulerLane.Left,
    after: { margin: '0 0 0 2em', color: new vscode.ThemeColor('descriptionForeground') },
  });
  const moduleNameOf = (doc: vscode.TextDocument) => /^\s*MODULE\s+(\w+)/im.exec(doc.getText())?.[1]?.toUpperCase() ?? path.basename(doc.uri.fsPath, path.extname(doc.uri.fsPath)).toUpperCase();
  const apply = () => {
    for (const ed of vscode.window.visibleTextEditors) {
      if (ed.document.languageId !== 'abb-rapid') continue;
      const mod = moduleNameOf(ed.document);
      const p: vscode.DecorationOptions[] = [], m: vscode.DecorationOptions[] = [];
      for (const c of ctrls.connected()) {
        const at = c.snapshot.at.get('tasks');
        for (const [task, ptr] of c.snapshot.pointers ?? []) {
          for (const [which, arr] of [['program', p], ['motion', m]] as const) {
            const x = ptr[which];
            if (!x?.begin || x.module.toUpperCase() !== mod || x.begin.line - 1 >= ed.document.lineCount) continue;
            arr.push({
              range: new vscode.Range(x.begin.line - 1, 0, x.begin.line - 1, 0),
              hoverMessage: new vscode.MarkdownString(`**${which === 'program' ? 'Program' : 'Motion'} pointer** of ${task} on ${c.profile.name}, ${ago(at)}. Press Get to read it again.`),
              renderOptions: { after: { contentText: `◀ ${which === 'program' ? 'PP' : 'MP'} ${c.profile.name}/${task} · ${ago(at)}` } },
            });
          }
        }
      }
      ed.setDecorations(prog, p); ed.setDecorations(motion, m);
    }
  };
  ctx.subscriptions.push(prog, motion, ctrls.onDidChange(apply), vscode.window.onDidChangeVisibleTextEditors(apply));
  apply();
}
