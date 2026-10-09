/**
 * Robots tree.
 *
 * Every data section starts EMPTY with a "Get" action on it. Nothing under a robot
 * reads from the controller until it is clicked, and each section says how old its
 * data is, so a stale number never passes for a live one. Live monitoring and alarm
 * history are RUKUS's job - the nodes for those hand off instead of fetching.
 *
 * The shape of the tree is: the robot row carries the connection state (colour and
 * words), and under it three separated groups - what is read from the controller, the
 * file device, and the hand-offs to RUKUS. A section that has not been read is dimmed,
 * one that has is dated, one that is older than `live.staleAfterSeconds` turns orange.
 */
import * as vscode from 'vscode';
import type { RobotManager, RobotConnection } from './robotManager';
import { REGISTER_KINDS } from './robotManager';
import { fmtCart, fmtJoints } from './parsers';
import { robotUri } from './fs';
import type { RemoteFile, FetchKind } from './types';
import { config } from '../util';
import { filesToShow } from './fileFilter';

type SectionKind = 'controller' | 'position' | 'tasks' | 'registers' | 'io' | 'files' | 'rukus' | 'errors';

type Node =
  | { t: 'group'; label: string; scope: 'workspace' | 'user' }
  | { t: 'robot'; c: RobotConnection }
  | { t: 'info'; c: RobotConnection; label: string; desc?: string; icon: string; color?: string; tooltip?: string; cmd?: vscode.Command }
  | { t: 'sep'; label: string; tooltip?: string }
  | { t: 'section'; c: RobotConnection; kind: SectionKind }
  | { t: 'task'; c: RobotConnection; i: number }
  | { t: 'file'; c: RobotConnection; f: RemoteFile }
  | { t: 'text'; label: string; desc?: string; icon?: string; color?: string; tooltip?: string; cmd?: vscode.Command };

/** which fetch units each section needs, and the command its Get button runs */
const SECTION_FETCH: Partial<Record<SectionKind, { kinds: FetchKind[]; cmd: string }>> = {
  controller: { kinds: ['info'], cmd: 'robotCode.live.getInfo' },
  position: { kinds: ['position'], cmd: 'robotCode.live.getPosition' },
  tasks: { kinds: ['tasks'], cmd: 'robotCode.live.getTasks' },
  registers: { kinds: REGISTER_KINDS, cmd: 'robotCode.live.getRegisters' },
  io: { kinds: ['io'], cmd: 'robotCode.live.getIo' },
};

/**
 * Files is gated too, and it is worth saying why it is not in the table above.
 *
 * A directory listing is not snapshot data - it has no FetchKind and does not live in
 * LiveSnapshot - but it IS a request to the controller, and on an R-30iB it is four of
 * them (the INDEX_*.HTM pages). Expanding a tree node used to fire that silently, which
 * is the exact behaviour this version exists to remove. So it gets the same treatment
 * from its own little cache: nothing until somebody presses Get.
 */
const FILES_CMD = 'robotCode.live.getFiles';

const SECTION_LABEL: Record<SectionKind, string> = { controller: 'Info', position: 'Position', tasks: 'Tasks', registers: 'Registers', io: 'I/O', files: 'Files', rukus: 'In RUKUS', errors: 'Read errors' };
const SECTION_ICON: Record<SectionKind, string> = { controller: 'server', position: 'location', tasks: 'list-tree', registers: 'symbol-number', io: 'circuit-board', files: 'folder', rukus: 'rocket', errors: 'warning' };

/** the one place the state → colour mapping lives */
const STATE_COLOR = { connected: 'testing.iconPassed', connecting: 'charts.yellow', error: 'errorForeground', disconnected: 'disabledForeground' } as const;

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** "3 s ago" / "4 min ago", so nobody mistakes a snapshot for a live reading */
function ago(at: number): string {
  const s = Math.round((Date.now() - at) / 1000);
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return `${Math.round(s / 3600)} h ago`;
}

/**
 * Fired every few seconds while a robot is connected, so anything that prints an age can
 * print it again. A redraw from cached data - nothing that listens may read the controller.
 */
export const ageTicked = new vscode.EventEmitter<void>();

function icon(id: string, color?: string): vscode.ThemeIcon {
  return color ? new vscode.ThemeIcon(id, new vscode.ThemeColor(color)) : new vscode.ThemeIcon(id);
}

export class RobotsTree implements vscode.TreeDataProvider<Node> {
  private readonly _onDidChange = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this._onDidChange.event;
  private fileCache = new Map<string, { at: number; files: RemoteFile[]; error?: string }>();
  constructor(private robots: RobotManager) {
    robots.onDidChange(() => this._onDidChange.fire(undefined));
  }

  /** forget the listing so the Files panel goes back to "not read yet" */
  refreshFiles(robot: string) { this.fileCache.delete(robot); this.robots.setFiles(robot, undefined); this._onDidChange.fire(undefined); }
  /** redraw from what is cached - no read */
  refresh() { this._onDidChange.fire(undefined); }

  /** has this robot's device been listed at all? */
  hasFiles(robot: string) { return this.fileCache.has(robot); }

  /**
   * Lists the device, on purpose, because somebody pressed Get. The failure is cached
   * alongside the success: a controller that hides directory listings would otherwise be
   * re-asked every single time the node is drawn.
   */
  async loadFiles(robot: string): Promise<string | undefined> {
    const c = this.robots.get(robot);
    if (!c || c.state !== 'connected') return 'not connected';
    try {
      const files = await this.robots.listFiles(c.profile);
      this.fileCache.set(robot, { at: Date.now(), files });
      this.robots.setFiles(robot, files);   // so CALLs in files opened off this robot can resolve
      this._onDidChange.fire(undefined);
      return undefined;
    } catch (e: any) {
      const error = e?.message ?? String(e);
      this.fileCache.set(robot, { at: Date.now(), files: [], error });
      this.robots.setFiles(robot, undefined);
      this._onDidChange.fire(undefined);
      return error;
    }
  }

  async getChildren(el?: Node): Promise<Node[]> {
    if (!el) {
      const list = this.robots.list();
      const workspace = list.filter(c => c.source === 'workspace');
      const user = list.filter(c => c.source === 'user');
      const out: Node[] = [];
      if (workspace.length) {
        if (user.length) out.push({ t: 'group', label: 'Workspace', scope: 'workspace' });
        out.push(...workspace.map(c => ({ t: 'robot' as const, c })));
      }
      if (user.length) {
        if (workspace.length) out.push({ t: 'group', label: 'User Settings', scope: 'user' });
        out.push(...user.map(c => ({ t: 'robot' as const, c })));
      }
      return out;
    }
    if (el.t === 'robot') {
      const c = el.c;
      const p = c.profile;
      // Not connected: one row that says what to do, not five empty panels.
      if (c.state === 'connecting') return [{ t: 'info', c, label: 'Connecting…', desc: p.host, icon: 'sync~spin', color: STATE_COLOR.connecting }];
      if (c.state === 'error') return [
        { t: 'info', c, label: 'Connection failed', desc: c.error, icon: 'error', color: STATE_COLOR.error, tooltip: `${c.error ?? ''}\n\nClick to try again.`, cmd: { command: 'robotCode.live.connect', title: '', arguments: [p.name] } },
        { t: 'info', c, label: 'Fix connection…', desc: `${p.host}${p.useFtp ? ` · FTP ${p.ftpPort}` : ` · HTTP ${p.httpPort}`}`, icon: 'tools', cmd: { command: 'robotCode.live.manageRobots', title: '', arguments: [p.name] } },
      ];
      if (c.state !== 'connected' || !c.snapshot) return [
        { t: 'info', c, label: 'Connect', desc: `${p.host}${p.useFtp ? ` · FTP ${p.ftpPort}` : ` · HTTP ${p.httpPort}`}`, icon: 'plug', color: 'charts.blue', tooltip: 'Opens the connection. Nothing is read until you press Get on a panel.', cmd: { command: 'robotCode.live.connect', title: '', arguments: [p.name] } },
      ];

      const out: Node[] = [];
      out.push({ t: 'sep', label: 'Controller', tooltip: 'Read from the controller when you ask, one file per panel. Dim = not read yet.' });
      out.push({ t: 'section', c, kind: 'controller' });
      out.push({ t: 'section', c, kind: 'position' });
      out.push({ t: 'section', c, kind: 'tasks' });
      out.push({ t: 'section', c, kind: 'registers' });
      out.push({ t: 'section', c, kind: 'io' });
      if (c.snapshot.errors.size) out.push({ t: 'section', c, kind: 'errors' });
      out.push({ t: 'sep', label: 'Device', tooltip: `Programs and data files on ${p.device}.` });
      out.push({ t: 'section', c, kind: 'files' });
      out.push({ t: 'sep', label: 'RUKUS', tooltip: 'Cell management lives in RUKUS; these open the real screens there.' });
      out.push({ t: 'section', c, kind: 'rukus' });
      // What we have actually cost this robot. Last, and quiet, but present: the point
      // of the whole on-demand rework is that this number stays small, and a claim like
      // that is worth being able to check rather than take on trust.
      const tr = c.traffic;
      out.push({
        t: 'info', c, label: 'Traffic', icon: 'pulse', color: 'descriptionForeground',
        desc: tr.requests === 0 ? 'nothing read' : `${tr.requests} request${tr.requests === 1 ? '' : 's'} · ${fmtBytes(tr.bytes)}`,
        tooltip: tr.lastAt === undefined
          ? 'This extension has not asked this controller for anything yet.'
          : `${tr.requests} request${tr.requests === 1 ? '' : 's'} and ${fmtBytes(tr.bytes)} since VS Code started.\nLast: ${tr.lastWhat}, ${ago(tr.lastAt)}.\n\nCounted at the transport, so everything the extension reads appears here.`,
      });
      return out;
    }
    if (el.t === 'section') {
      const c = el.c;
      const s = c.snapshot!;
      const fetchInfo = SECTION_FETCH[el.kind];
      // Not fetched yet: one row that says so and does the fetch when clicked.
      if (fetchInfo && !fetchInfo.kinds.some(k => s.fetchedAt.has(k))) {
        return [{
          t: 'text', label: `Read from ${c.profile.name}`, desc: fetchInfo.kinds.length === 1 ? 'one file' : `${fetchInfo.kinds.length} files`,
          icon: 'cloud-download', color: 'charts.blue',
          tooltip: `Reads ${fetchInfo.kinds.length === 1 ? 'one file' : `${fetchInfo.kinds.length} files`} from ${c.profile.name}. Nothing is read from the controller until you ask.`,
          cmd: { command: fetchInfo.cmd, title: 'Get', arguments: [c.profile.name] },
        }];
      }
      if (el.kind === 'files' && !this.fileCache.has(c.profile.name)) {
        return [{
          t: 'text', label: `List ${c.profile.device}`, desc: 'on request',
          icon: 'cloud-download', color: 'charts.blue',
          tooltip: `Lists ${c.profile.device} on ${c.profile.name}. On an R-30iB that is four index pages, so it waits to be asked like everything else.`,
          cmd: { command: FILES_CMD, title: 'Get', arguments: [c.profile.name] },
        }];
      }
      switch (el.kind) {
        case 'controller': {
          const out: Node[] = [];
          const i = s.info;
          out.push({ t: 'text', label: [i.application, i.version].filter(Boolean).join(' ') || 'Controller', desc: i.fNumber ? `F#${i.fNumber}` : '', icon: 'server', tooltip: `${i.robotName ?? ''}\n${i.date ?? ''}`.trim() });
          if (i.robotName) out.push({ t: 'text', label: 'Robot name', desc: i.robotName, icon: 'tag' });
          return out;
        }
        case 'position': {
          const pos = s.position;
          if (!pos) return [{ t: 'text', label: 'No position data in CURPOS.DG', icon: 'question' }];
          const out: Node[] = [];
          if (pos.userFrame) out.push({ t: 'text', label: `UF ${pos.frameNo ?? '?'} / UT ${pos.toolNo ?? '?'}`, desc: fmtCart(pos.userFrame), icon: 'location', tooltip: `User frame position\n${fmtCart(pos.userFrame)}\nCFG ${pos.userFrame.config ?? ''}` });
          if (pos.world) out.push({ t: 'text', label: 'World', desc: fmtCart(pos.world), icon: 'globe', tooltip: `World position\n${fmtCart(pos.world)}\nCFG ${pos.world.config ?? ''}` });
          if (pos.joint) out.push({ t: 'text', label: 'Joints', desc: fmtJoints(pos.joint.joints) + (pos.joint.ext.length ? '  E' + pos.joint.ext.map((e, i) => `${i + 1} ${e.toFixed(2)}`).join(' E') : ''), icon: 'settings', tooltip: fmtJoints(pos.joint.joints) });
          return out;
        }
        case 'tasks': return s.tasks.length ? s.tasks.map((_, i) => ({ t: 'task', c, i })) : [{ t: 'text', label: 'No tasks reported', icon: 'question' }];
        case 'registers': return [
          { t: 'text', label: 'R', desc: `${s.numregs.size} numeric`, icon: 'symbol-number', color: 'charts.orange', cmd: { command: 'robotCode.data.openRegisterTable', title: '' } },
          { t: 'text', label: 'PR', desc: `${s.posregs.size} position`, icon: 'location', color: 'charts.blue', cmd: { command: 'robotCode.data.openRegisterTable', title: '' } },
          { t: 'text', label: 'SR', desc: `${s.strregs.size} string`, icon: 'symbol-string', color: 'charts.green', cmd: { command: 'robotCode.data.openRegisterTable', title: '' } },
        ];
        case 'io': {
          const on = [...s.io.values()].filter(x => x.value === 'ON' || (typeof x.value === 'number' && x.value !== 0));
          return [
            { t: 'text', label: `${on.length} ON`, desc: `of ${s.io.size} points`, icon: 'circle-filled', color: 'testing.iconPassed', cmd: { command: 'robotCode.data.openRegisterTable', title: '' } },
            ...on.slice(0, 40).map((x): Node => ({ t: 'text', label: `${x.kind}[${x.index}]`, desc: `${x.value}${x.simulated ? ' (SIM)' : ''}  ${x.comment}`, icon: x.simulated ? 'warning' : 'circle-filled', color: x.simulated ? 'charts.yellow' : 'testing.iconPassed', tooltip: `${x.kind}[${x.index}] ${x.comment}${x.simulated ? '\nSIMULATED' : ''}` })),
          ];
        }
        case 'errors': return [...s.errors.entries()].map(([k, e]) => ({ t: 'text', label: k, desc: e, icon: 'warning', color: 'charts.red' }));
        case 'rukus': return [
          { t: 'text', label: 'Live monitor', desc: 'opens RUKUS', icon: 'pulse', color: 'charts.purple', tooltip: 'RUKUS keeps a live view of position, I/O and program state without VS Code holding the connection open.', cmd: { command: 'robotCode.rukus.monitor', title: '', arguments: [c.profile.name] } },
          { t: 'text', label: 'Alarm history', desc: 'opens RUKUS', icon: 'bell', color: 'charts.purple', tooltip: 'Alarm log with history, filtering and trends lives in RUKUS.', cmd: { command: 'robotCode.rukus.alarms', title: '', arguments: [c.profile.name] } },
          { t: 'text', label: 'Scheduled backups', desc: 'opens RUKUS', icon: 'calendar', color: 'charts.purple', tooltip: 'RUKUS backs this robot up on a schedule, keeps the dated history and compares versions.', cmd: { command: 'robotCode.rukus.backup', title: '', arguments: [c.profile.name] } },
        ];
        case 'files': {
          // Always from the cache: the listing is only ever refreshed by an explicit Get,
          // never by the tree redrawing itself.
          const hit = this.fileCache.get(c.profile.name)!;
          if (hit.error) {
            return [{ t: 'text', label: 'Listing failed', desc: hit.error, icon: 'warning', color: 'charts.red', tooltip: 'The web server may hide directory listings. Set an FTP user on the profile to list over FTP.' }];
          }
          const interesting = filesToShow(hit.files, config<string>('live.filesShow', 'programs'));
          return interesting.length ? interesting.map(f => ({ t: 'file', c, f })) : [{ t: 'text', label: config<string>('live.filesShow', 'programs') === 'programs' ? 'No TP programs on the device' : 'No program or data files', icon: 'question' }];
        }
      }
    }
    return [];
  }

  getTreeItem(el: Node): vscode.TreeItem {
    switch (el.t) {
      case 'group': {
        const it = new vscode.TreeItem(el.label, vscode.TreeItemCollapsibleState.None);
        it.iconPath = icon(el.scope === 'workspace' ? 'folder' : 'account', 'descriptionForeground');
        it.contextValue = `scope-${el.scope}`;
        it.description = el.scope === 'workspace' ? 'from .robocode-cell' : 'from user settings';
        return it;
      }
      case 'robot': {
        const it = new vscode.TreeItem(el.c.profile.name, vscode.TreeItemCollapsibleState.Collapsed);
        const p = el.c.profile;
        const s = el.c.snapshot;
        const run = s?.fetchedAt.has('tasks') ? s.tasks.find(t => t.status === 'RUNNING' && t.current) : undefined;
        const state = el.c.state;
        // connected on paper, but the heartbeat (or a read) got no answer: red, like a failed connect
        const lost = state === 'connected' && el.c.reachable === false;
        // The card line: model when it has been read, the IP always, then what the robot is
        // doing - or, when the connection failed, WHY, right here where it can be read.
        const model = [s?.info.application, s?.info.version].filter(Boolean).join(' ');
        it.description = lost ? `${p.host} · not answering${el.c.error ? `: ${el.c.error}` : ''}`
          : state === 'connected'
          ? [model, p.host, run ? `▶ ${run.current!.program} ${run.current!.line}` : `connected${p.autoRefresh ? ' · auto-refresh' : ''}`].filter(Boolean).join(' · ')
          : state === 'connecting' ? `${p.host} · connecting…`
          : state === 'error' ? `${p.host} · ${el.c.error ?? 'connection failed'}`
          : `${p.host} · not connected`;
        // a status dot, coloured by state, with the state also in words above
        it.iconPath = lost ? icon('error', STATE_COLOR.error) : icon(state === 'connecting' ? 'sync~spin' : state === 'error' ? 'error' : 'circle-filled', STATE_COLOR[state]);
        (it as any).filterText = `${p.name} ${p.host} ${state}`;
        it.contextValue = state === 'connected' ? (p.autoRefresh ? 'robot-connected-auto' : 'robot-connected') : 'robot-disconnected';
        it.tooltip = new vscode.MarkdownString(
          `**${p.name}** — ${p.host} · **${lost ? 'not answering' : state}**${el.c.error ? `\n\n${el.c.error}` : ''}\n\n` +
          `HTTP ${p.httpPort} · FTP ${p.ftpPort} · device ${p.device}\n\n` +
          `Auto-refresh **${p.autoRefresh ? `on, every ${(p.pollIntervalMs / 1000).toFixed(1)} s` : 'off'}** — otherwise the controller is only read when you press Get.\n\n` +
          `Click to open the robot page.`);
        it.command = { command: 'robotCode.live.dashboard', title: 'Open robot page', arguments: [p.name] };
        return it;
      }
      case 'sep': {
        // A heading row, not a node: no icon, no command, dim text. Groups what follows.
        const it = new vscode.TreeItem('', vscode.TreeItemCollapsibleState.None);
        it.description = `── ${el.label.toUpperCase()} ──`;
        it.contextValue = 'separator';
        if (el.tooltip) it.tooltip = el.tooltip;
        return it;
      }
      case 'info': case 'text': {
        const it = new vscode.TreeItem(el.label, vscode.TreeItemCollapsibleState.None);
        it.description = el.desc; if (el.icon) it.iconPath = icon(el.icon, el.color); if (el.tooltip) it.tooltip = el.tooltip; if (el.cmd) it.command = el.cmd;
        return it;
      }
      case 'section': {
        const s = el.c.snapshot!;
        const fetchInfo = SECTION_FETCH[el.kind];
        // Age of the freshest unit behind this section, or undefined if never read.
        // Files keeps its own timestamp - it is a listing, not a snapshot unit.
        const at = el.kind === 'files'
          ? this.fileCache.get(el.c.profile.name)?.at
          : fetchInfo ? fetchInfo.kinds.map(k => s.fetchedAt.get(k)).filter((x): x is number => x !== undefined).sort((a, b) => b - a)[0] : undefined;
        const counts: Record<SectionKind, string> = {
          controller: s.info.fNumber ? `F#${s.info.fNumber}` : '',
          position: s.position ? `G${s.position.group}` : '',
          tasks: `${s.tasks.filter(t => t.status === 'RUNNING').length} running · ${s.tasks.length} total`,
          registers: `${s.numregs.size} R · ${s.posregs.size} PR · ${s.strregs.size} SR`,
          io: `${s.io.size} points`,
          files: `${el.c.profile.device}${config<string>('live.filesShow', 'programs') === 'programs' ? ' · programs' : ' · all files'}`,
          rukus: '',
          errors: `${s.errors.size}`,
        };
        const gated = fetchInfo !== undefined || el.kind === 'files';
        const it = new vscode.TreeItem(SECTION_LABEL[el.kind], el.kind === 'files' || el.kind === 'io' ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded);
        // Colour says freshness: dim until read, plain when fresh, orange once it is old
        // enough that a number in it should not be trusted without another Get.
        const staleAfter = config<number>('live.staleAfterSeconds', 60) * 1000;
        const stale = at !== undefined && staleAfter > 0 && Date.now() - at > staleAfter;
        const color = el.kind === 'errors' ? 'charts.red' : el.kind === 'rukus' ? 'charts.purple' : gated && at === undefined ? 'disabledForeground' : stale ? 'charts.orange' : undefined;
        it.iconPath = icon(SECTION_ICON[el.kind], color);
        it.description = at !== undefined ? `${counts[el.kind]}${counts[el.kind] ? ' · ' : ''}${ago(at)}` : gated ? `${counts[el.kind] ? counts[el.kind] + ' · ' : ''}not read yet` : counts[el.kind];
        // contextValue drives the inline Get / Refresh icon in package.json
        it.contextValue = gated && at !== undefined ? `section-${el.kind}-loaded` : `section-${el.kind}`;
        it.tooltip = at !== undefined
          ? `Read ${ago(at)}${stale ? ' — older than the stale limit, read it again before trusting it' : ''}. Press the refresh icon to read it again.`
          : gated ? 'Not read yet. Nothing is read from the controller until you ask.' : undefined;
        return it;
      }
      case 'task': {
        const t = el.c.snapshot!.tasks[el.i];
        const it = new vscode.TreeItem(`${t.taskNo}  ${t.name}`, vscode.TreeItemCollapsibleState.None);
        it.description = t.current ? `${t.status} · ${t.current.program} line ${t.current.line} (${t.current.type})` : t.status;
        const running = t.status === 'RUNNING', paused = t.status === 'PAUSED' || t.status === 'PAUSING';
        it.iconPath = icon(running ? 'debug-start' : paused ? 'debug-pause' : 'debug-stop', running ? 'testing.iconPassed' : paused ? 'charts.yellow' : 'disabledForeground');
        it.tooltip = t.stack.map(f => `${f.depth ?? ''} ${f.routine ?? ''} → ${f.program} line ${f.line} (${f.type})`).join('\n') || t.status;
        if (t.current) it.command = { command: 'robotCode.live.openTaskLine', title: 'Open', arguments: [el.c.profile.name, t.current.program, t.current.line, t.current.type] };
        return it;
      }
      case 'file': {
        const it = new vscode.TreeItem(el.f.name, el.f.isDir ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
        it.description = el.f.size !== undefined ? fmtBytes(el.f.size) : '';
        it.resourceUri = robotUri(el.c.profile.name, el.c.profile.device, el.f.isDir ? undefined : el.f.name);
        it.iconPath = el.f.isDir ? vscode.ThemeIcon.Folder : vscode.ThemeIcon.File;
        it.contextValue = 'robot-file';
        if (!el.f.isDir) it.command = { command: 'robotCode.live.openRobotFile', title: 'Open', arguments: [el.c.profile.name, el.f.name] };
        return it;
      }
    }
  }
}
