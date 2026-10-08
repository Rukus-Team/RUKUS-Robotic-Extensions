/**
 * Live (read-only, on-demand) tier wiring: robot manager, fanuc:// file system,
 * Robots view, running-line marker, commands.
 *
 * Every command that touches the controller is something the user pressed. There is
 * no background poll unless auto-refresh is explicitly switched on for that robot.
 */
import * as vscode from 'vscode';
import * as path from 'node:path';
import type { Services } from '../services';
import { RobotManager, FETCH_UNITS, REGISTER_KINDS, WebServerUnreachableError } from './robotManager';
import { RobotFileSystem, FANUC_SCHEME, robotUri } from './fs';
import { globToRegExp } from './ftp';
import { RobotsTree, ageTicked } from './views';
import { openRobotForm } from './robotForm';
import { connectionHint } from './connectionHints';
import { openDashboard } from './dashboard';
import { openInRukus } from '../rukus/launch';
import { placeBackup, backupManifest, RUKUS_MANIFEST } from '../rukus/store';
import * as os from 'node:os';
import { FETCH_KINDS } from './types';
import { config, windowFolders, setWindowFolders, showRecoverableError } from '../util';
import { gated } from '../experimental';
import { brandForFile } from '../brand';
import type { FetchKind } from './types';

export function registerLive(ctx: vscode.ExtensionContext, s: Services): RobotManager {
  const robots = new RobotManager(ctx, s.output);
  const fs = new RobotFileSystem(robots);
  const tree = new RobotsTree(robots);
  const treeView = vscode.window.createTreeView('robotCode.robots', { treeDataProvider: tree, showCollapseAll: true });
  ctx.subscriptions.push(robots, treeView,
    vscode.workspace.registerFileSystemProvider(FANUC_SCHEME, fs, { isCaseSensitive: false, isReadonly: true }));
  // "1 of 2 live" on the section header
  const summarise = () => {
    const all = robots.list(), live = robots.connected().length, failed = all.filter(c => c.state === 'error').length;
    treeView.description = all.length ? `${live} of ${all.length} live${failed ? ` · ⚠ ${failed} failed` : ''}` : '';
  };
  ctx.subscriptions.push(robots.onDidChange(summarise));
  summarise();
  // hidden: the section header and rows, for the smoke test
  ctx.subscriptions.push(vscode.commands.registerCommand('robotCode.live._viewState', async () => {
    const rows: string[] = [];
    for (const n of await tree.getChildren()) { const it = tree.getTreeItem(n); rows.push(`${it.label}${it.description ? ` — ${it.description}` : ''}`); }
    return { description: treeView.description, rows };
  }));
  // A file that is ON a controller is read-only, and it should look it: its tab, its row under
  // Files and its Explorer entry (when the device is mounted) carry a colour and an "RO" badge,
  // so it is never mistaken for the editable copy of the same name in the workspace.
  const decoChanged = new vscode.EventEmitter<undefined>();
  ctx.subscriptions.push(decoChanged,
    vscode.window.registerFileDecorationProvider({
      onDidChangeFileDecorations: decoChanged.event,
      provideFileDecoration: uri => uri.scheme === FANUC_SCHEME && config<boolean>('live.markReadOnlyFiles', true)
        ? { badge: 'RO', color: new vscode.ThemeColor('robotCode.readOnlyFile'), tooltip: `On ${decodeURIComponent(uri.authority)} - read-only. Right-click > Download for an editable copy.` }
        : undefined,
    }),
    vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('robotCode.live.markReadOnlyFiles')) decoChanged.fire(undefined); }));

  // Ages ("12 s ago") are words about a clock, so they have to be redrawn as it moves. This
  // redraws them from what is already cached - it never reads the controller, and the smoke
  // test's zero-requests-while-idle check holds with it running. Only while something that
  // shows an age is on screen and a robot is connected.
  const ageTick = setInterval(() => {
    if (!robots.connected().length) return;
    if (treeView.visible) tree.refresh();
    ageTicked.fire();
  }, 5000);
  ctx.subscriptions.push(ageTicked, { dispose: () => clearInterval(ageTick) });

  // Connection heartbeat: `connect` proves the controller answered once; this keeps that claim
  // true while it is connected, so the status bar's connected glyph means *answering now* and
  // not *was connected once*. The same cheapest probe as connecting, and 0 turns it off (the
  // extension then never contacts the controller on its own).
  let heartbeatTimer: NodeJS.Timeout | undefined;
  const armHeartbeat = () => {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = undefined; }
    const secs = config<number>('live.heartbeatSeconds', 10);
    if (secs > 0) heartbeatTimer = setInterval(() => { if (robots.connected().length) void robots.heartbeat(); }, secs * 1000);
  };
  armHeartbeat();
  ctx.subscriptions.push(
    { dispose: () => { if (heartbeatTimer) clearInterval(heartbeatTimer); } },
    vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('robotCode.live.heartbeatSeconds')) armHeartbeat(); }),
  );

  const updateContext = () => void vscode.commands.executeCommand('setContext', 'robotCode.liveConnected', robots.connected().length > 0);
  ctx.subscriptions.push(robots.onDidChange(updateContext));
  updateContext();

  // Every robotCode.live.* command talks to a robot, so each waits behind the experimental
  // switch; the RUKUS hand-offs only start RUKUS, and the hidden _ ones are for the tests.
  const reg = (id: string, fn: (...a: any[]) => any) => ctx.subscriptions.push(vscode.commands.registerCommand(id,
    id.startsWith('robotCode.live.') && !id.startsWith('robotCode.live._') ? gated(fn) : fn));
  const nameOf = (node?: any): string | undefined => node?.c?.profile?.name ?? (typeof node === 'string' ? node : undefined);
  const pickRobot = async (name?: string, onlyConnected = false): Promise<string | undefined> => {
    if (typeof name === 'string' && robots.get(name)) return name;
    const list = (onlyConnected ? robots.connected() : robots.list());
    if (!list.length) { vscode.window.showInformationMessage(onlyConnected ? 'No robot is connected.' : 'No robots configured. Use "Robot Code: Add Robot…".'); return undefined; }
    if (list.length === 1) return list[0].profile.name;
    const pick = await vscode.window.showQuickPick(list.map(c => ({ label: c.profile.name, description: `${c.profile.host} · ${c.state}` })), { placeHolder: 'Robot' });
    return pick?.label;
  };

  /**
   * The one place that reads from a controller on purpose. Shows progress on the view,
   * reports what failed once, and leaves the tree to render the new age stamps.
   */
  const get = async (node: any, kinds: FetchKind[], what: string) => {
    const name = await pickRobot(nameOf(node), true);
    if (!name) return;
    const failed = await vscode.window.withProgress(
      { location: { viewId: 'robotCode.robots' }, title: `Reading ${what} from ${name}` },
      () => robots.fetch(name, kinds));
    if (failed.length) {
      const pick = await vscode.window.showWarningMessage(
        `${name}: could not read ${failed.map(k => FETCH_UNITS[k].file).join(', ')}.`, 'Open Output');
      if (pick === 'Open Output') s.output.show(true);
    }
  };

  /**
   * The one-shot pull when a robot connects.
   *
   * Registers, I/O and the file listing are what make the EDITOR work - hovers, inlay
   * values, completion, the device tree - so having them the moment you connect is worth
   * one read each. Position, program state and controller info stay on their buttons:
   * they are "what is the robot doing right now", they go stale the second they arrive,
   * and reading them on a timer is what this version removed.
   *
   * One shot each. Nothing here repeats.
   */
  const onConnectFetch = async (name: string) => {
    const want = config<string[]>('live.fetchOnConnect', ['registers', 'io', 'files']);
    const kinds: FetchKind[] = [];
    if (want.includes('registers')) kinds.push(...REGISTER_KINDS);
    if (want.includes('io')) kinds.push('io');
    if (want.includes('position')) kinds.push('position');
    if (want.includes('tasks')) kinds.push('tasks');
    if (want.includes('info')) kinds.push('info');

    if (kinds.length) {
      const failed = await vscode.window.withProgress(
        { location: { viewId: 'robotCode.robots' }, title: `Reading ${name}` },
        () => robots.fetch(name, kinds));
      if (failed.length) robots.log(name, `on connect, could not read ${failed.map(k => FETCH_UNITS[k].file).join(', ')}`);
    }
    if (want.includes('files')) await tree.loadFiles(name);
  };
  ctx.subscriptions.push(robots.onDidConnect(name => void onConnectFetch(name)));

  reg('robotCode.live.dashboard', async (node?: any) => { const name = await pickRobot(nameOf(node)); if (name) openDashboard(ctx, s, robots, name); });

  // a brand opens the form on its own tab: { brand: 'abb' }, optionally { name } to edit one
  reg('robotCode.live.addRobot', (arg?: any) => openRobotForm(ctx, s, robots, typeof arg?.name === 'string' ? arg.name : undefined, typeof arg?.brand === 'string' ? arg.brand : undefined));
  reg('robotCode.live.manageRobots', (node?: any) => openRobotForm(ctx, s, robots, nameOf(node)));

  reg('robotCode.live.removeRobot', async (node?: any) => {
    const name = await pickRobot(nameOf(node));
    if (!name) return;
    const ok = await vscode.window.showWarningMessage(`Remove robot profile "${name}"?`, { modal: true }, 'Remove');
    if (ok) { robots.disconnect(name); await robots.removeProfile(name); }
  });

  reg('robotCode.live.setPassword', async (node?: any) => {
    const name = await pickRobot(nameOf(node));
    if (!name) return;
    const pw = await vscode.window.showInputBox({ prompt: `FTP password for ${name}`, password: true });
    if (pw !== undefined) { await robots.setPassword(name, pw); vscode.window.setStatusBarMessage(`Password stored for ${name}`, 3000); }
  });

  reg('robotCode.live.connect', async (node?: any) => {
    const name = await pickRobot(nameOf(node));
    if (!name) return;
    try {
      await vscode.window.withProgress({ location: { viewId: 'robotCode.robots' }, title: `Connecting to ${name}` }, () => robots.connect(name));
      vscode.window.setStatusBarMessage(`$(plug) ${name} connected`, 5000);
    } catch (e: any) {
      if (e instanceof WebServerUnreachableError) {
        const pick = await vscode.window.showErrorMessage(
          `Could not connect to ${name}: the web server at ${e.host} is not answering, but FTP is. ` +
          `The controller's web server is likely stuck (often after an interrupted transfer). Reading over FTP goes around it.`,
          'Switch to FTP & Connect', 'Open Output');
        if (pick === 'Open Output') { s.output.show(true); return; }
        if (pick === 'Switch to FTP & Connect') {
          try {
            await robots.setUseFtp(name, true);
            await vscode.window.withProgress({ location: { viewId: 'robotCode.robots' }, title: `Connecting to ${name} over FTP` }, () => robots.connect(name));
            vscode.window.setStatusBarMessage(`$(plug) ${name} connected over FTP`, 5000);
          } catch (e2: any) {
            const next = await vscode.window.showErrorMessage(`Could not connect to ${name} over FTP: ${e2?.message ?? e2}`, 'Fix connection…');
            if (next === 'Fix connection…') openRobotForm(ctx, s, robots, name);
          }
        }
        return;
      }
      const why = String(e?.message ?? e);
      const hint = connectionHint(why, robots.get(name)?.profile ?? { useFtp: false });
      const pick = await vscode.window.showErrorMessage(`Could not connect to ${name}: ${why}.${hint ? ` ${hint}` : ''}`, 'Fix connection…', 'Open Output');
      if (pick === 'Open Output') s.output.show(true);
      if (pick === 'Fix connection…') openRobotForm(ctx, s, robots, name);
    }
  });
  reg('robotCode.live.disconnect', async (node?: any) => { const name = await pickRobot(nameOf(node), true); if (name) robots.disconnect(name); });
  // the status bar's click when the heartbeat found the robot not answering
  reg('robotCode.live.ping', async (name?: string) => {
    if (!name) return;
    await robots.ping(name);
    const c = robots.get(name);
    // Connected but silent over HTTP, while FTP answers: the controller's web server is wedged.
    // Offer to read over FTP rather than leaving a dead end (a wedged server recovers on reboot).
    if (!c || c.profile.useFtp || c.reachable !== false) return;
    if (!(await robots.ftpReachable(name))) return;
    const pick = await vscode.window.showWarningMessage(
      `${name} is connected but its web server is not answering; FTP is. Read this robot over FTP instead?`,
      'Switch to FTP', 'Not Now');
    if (pick === 'Switch to FTP') {
      await robots.setUseFtp(name, true);
      await robots.ping(name);
      vscode.window.setStatusBarMessage(`$(plug) ${name} reads over FTP now`, 5000);
    }
  });

  // ---- on-demand reads: one command per panel ----
  reg('robotCode.live.getInfo', (node?: any) => get(node, ['info'], 'controller info'));
  reg('robotCode.live.getPosition', (node?: any) => get(node, ['position'], 'current position'));
  reg('robotCode.live.getTasks', (node?: any) => get(node, ['tasks'], 'program state'));
  reg('robotCode.live.getRegisters', (node?: any) => get(node, REGISTER_KINDS, 'registers'));
  reg('robotCode.live.getIo', (node?: any) => get(node, ['io'], 'I/O state'));
  reg('robotCode.live.getAll', (node?: any) => get(node, FETCH_KINDS, 'everything'));

  /**
   * Lists the device. Its own command rather than a FetchKind because a listing is not
   * snapshot data - but it is still traffic, so it waits to be asked like everything else.
   */
  reg('robotCode.live.getFiles', async (node?: any) => {
    const name = await pickRobot(nameOf(node), true);
    if (!name) return;
    const error = await vscode.window.withProgress(
      { location: { viewId: 'robotCode.robots' }, title: `Listing ${robots.get(name)!.profile.device} on ${name}` },
      () => tree.loadFiles(name));
    if (error) robots.log(name, `listing failed: ${error}`);
  });

  /** inline icon on the Files header: programs only <-> every file; a setting, so it sticks */
  reg('robotCode.live.toggleFilesShow', async () => {
    const cfg = vscode.workspace.getConfiguration('robotCode');
    const next = cfg.get<string>('live.filesShow', 'programs') === 'programs' ? 'all' : 'programs';
    await cfg.update('live.filesShow', next, vscode.ConfigurationTarget.Global);
    tree.refresh();
  });

  /** inline refresh icon on a section header; the tree node carries which section it is */
  reg('robotCode.live.getSection', async (node?: any) => {
    if (node?.kind === 'files') { await vscode.commands.executeCommand('robotCode.live.getFiles', node); return; }
    const kinds: Partial<Record<string, FetchKind[]>> = { controller: ['info'], position: ['position'], tasks: ['tasks'], registers: REGISTER_KINDS, io: ['io'] };
    const wanted = kinds[node?.kind];
    if (!wanted) return;
    await get(node, wanted, node.kind);
  });

  /** re-read only what has already been read once; never pulls anything new */
  reg('robotCode.live.refresh', async (node?: any) => {
    const name = await pickRobot(nameOf(node), true);
    if (!name) return;
    const loaded = FETCH_KINDS.filter(k => k !== 'info' && robots.has(name, k));
    if (!loaded.length) {
      const pick = await vscode.window.showInformationMessage(`Nothing has been read from ${name} yet. Read everything now?`, 'Read everything', 'Cancel');
      if (pick === 'Read everything') await get(name, FETCH_KINDS, 'everything');
      return;
    }
    await vscode.window.withProgress({ location: { viewId: 'robotCode.robots' }, title: `Refreshing ${name}` }, () => robots.refresh(name));
    // Re-list only if it had been listed. Refresh means "the things I am looking at, again",
    // so it must not turn into the one command that quietly adds a request.
    if (tree.hasFiles(name)) await tree.loadFiles(name);
    fs.invalidate();
  });

  reg('robotCode.live.toggleAutoRefresh', async (node?: any) => {
    const name = await pickRobot(nameOf(node), true);
    if (!name) return;
    const c = robots.get(name)!;
    const on = !c.profile.autoRefresh;
    if (on) {
      const ok = await vscode.window.showWarningMessage(
        `Auto-refresh will re-read ${name} every ${(c.profile.pollIntervalMs / 1000).toFixed(1)} s for as long as VS Code is open. The controller generates each diagnostic file on request, so this is continuous load on the robot.`,
        { modal: true }, 'Turn on');
      if (ok !== 'Turn on') return;
    }
    await robots.setAutoRefresh(name, on);
    vscode.window.setStatusBarMessage(`${name}: auto-refresh ${on ? 'on' : 'off'}`, 3000);
  });

  reg('robotCode.live.focusView', () => vscode.commands.executeCommand('robotCode.robots.focus'));

  // ---- hand-off to RUKUS ----
  const rukusFor = (node: any, route: 'monitor' | 'alarms' | 'backup' | 'home') => async () => {
    const name = nameOf(node) ?? (await pickRobot(undefined));
    const c = name ? robots.get(name) : undefined;
    await openInRukus({ route, robot: c?.profile.name, host: c?.profile.host });
  };
  reg('robotCode.rukus.monitor', (node?: any) => rukusFor(node, 'monitor')());
  reg('robotCode.rukus.alarms', (node?: any) => rukusFor(node, 'alarms')());
  reg('robotCode.rukus.backup', (node?: any) => rukusFor(node, 'backup')());
  reg('robotCode.rukus.open', () => openInRukus({ route: 'home' }));

  reg('robotCode.live.openRobotFile', async (robotOrNode?: any, file?: string) => {
    const name = await pickRobot(nameOf(robotOrNode), true);
    if (!name) return;
    const c = robots.get(name)!;
    if (!file) {
      const files = await robots.listFiles(c.profile).catch(() => [] as { name: string }[]);
      const items = files.length ? files.map(f => ({ label: f.name })) : ['CURPOS.DG', 'PRGSTATE.DG', 'IOSTATE.DG', 'NUMREG.VA', 'POSREG.VA', 'ERRALL.LS', 'SUMMARY.DG', 'MEMORY.DG', 'VERSION.DG'].map(l => ({ label: l }));
      const pick = await vscode.window.showQuickPick(items, { placeHolder: `File on ${name} ${c.profile.device}`, matchOnDescription: true });
      if (!pick) return; file = pick.label;
    }
    fs.invalidate(robotUri(name, c.profile.device, file));
    const doc = await vscode.workspace.openTextDocument(robotUri(name, c.profile.device, file));
    await vscode.window.showTextDocument(doc, { preview: true });
  });

  /**
   * A file on a controller is read-only here, so the way to work on it is a local copy.
   * From a row of the Files section, from the tab or editor of an open `fanuc://` file, or
   * from the Explorer when the device is mounted as a folder. One read, of that one file.
   */
  reg('robotCode.live.downloadFile', async (arg?: any) => {
    const source: vscode.Uri | undefined =
      arg instanceof vscode.Uri ? arg
      : arg?.t === 'file' && !arg.f?.isDir ? robotUri(arg.c.profile.name, arg.c.profile.device, arg.f.name)
      : vscode.window.activeTextEditor?.document.uri;
    if (!source || source.scheme !== FANUC_SCHEME) { vscode.window.showInformationMessage('Download works on a file that is on a controller: right-click one under Files in the Controllers view, or open one first.'); return; }
    const fileName = source.path.split('/').pop() ?? 'file';
    const robot = decodeURIComponent(source.authority);
    const lastDir = ctx.workspaceState.get<string>('robotCode.live.downloadDir');
    const dir = lastDir ?? vscode.workspace.workspaceFolders?.find(f => f.uri.scheme === 'file')?.uri.fsPath;
    const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(dir ? path.join(dir, fileName) : fileName), title: `Download ${fileName} from ${robot}`, saveLabel: 'Download' });
    if (!target) return;
    try {
      fs.invalidate(source);   // the copy on the robot now, not the one opened a while ago
      const data = await vscode.workspace.fs.readFile(source);
      await vscode.workspace.fs.writeFile(target, data);
      await ctx.workspaceState.update('robotCode.live.downloadDir', path.dirname(target.fsPath));
      robots.log(robot, `downloaded ${fileName} (${data.byteLength} bytes) to ${target.fsPath}`);
    } catch (e: any) {
      void showRecoverableError(`Could not download ${fileName} from ${robot}: ${e?.message ?? e}`, s.output, () => vscode.commands.executeCommand('robotCode.live.downloadFile', arg));
      return;
    }
    const pick = await vscode.window.showInformationMessage(`${fileName} saved to ${target.fsPath} - an editable copy.`, 'Open the copy');
    if (pick) await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(target));
  });

  reg('robotCode.live.openTaskLine', async (robot: string, program: string, line: number, type: string) => {
    const info = s.index.get(program);
    let doc: vscode.TextDocument;
    if (info?.kind === 'binary') { vscode.window.showInformationMessage(`${program} is only in the backup as a compiled ${info.programType}; there is no source to open.`); return; }
    if (info) doc = await vscode.workspace.openTextDocument(info.uri);
    else if (type.toUpperCase() === 'TP') { const c = robots.get(robot)!; doc = await vscode.workspace.openTextDocument(robotUri(robot, c.profile.device, `${program.toUpperCase()}.LS`)); }
    else { vscode.window.showInformationMessage(`${program} is a ${type} program; KAREL source is not on the controller.`); return; }
    const ed = await vscode.window.showTextDocument(doc, { preview: true });
    {
      const l = brandForFile(doc.uri.path)?.programLine?.(doc.getText(), line);
      if (l !== undefined) { const pos = new vscode.Position(l, 0); ed.selection = new vscode.Selection(pos, pos); ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter); }
    }
  });

  reg('robotCode.live.compareWithRobot', async (uri?: vscode.Uri) => {
    const target = uri instanceof vscode.Uri ? uri : vscode.window.activeTextEditor?.document.uri;
    if (!target || !/\.ls$/i.test(target.path)) { vscode.window.showInformationMessage('Open a TP (.ls) program first.'); return; }
    const name = await pickRobot(undefined, true); if (!name) return;
    const c = robots.get(name)!;
    const doc = await vscode.workspace.openTextDocument(target);
    const prog = brandForFile(target.path)?.indexProgram(target.path, doc.getText())?.name ?? path.basename(target.fsPath).replace(/\.[^.]+$/, '');
    const remote = robotUri(name, c.profile.device, `${prog.toUpperCase()}.LS`);
    fs.invalidate(remote);
    try { await vscode.workspace.fs.stat(remote); } catch (e: any) { vscode.window.showWarningMessage(`${prog} is not on ${name}: ${e?.message ?? e}`); return; }
    await vscode.commands.executeCommand('vscode.diff', remote, target, `${prog}: ${name} ⟷ local`);
  });

  reg('robotCode.live.pullBackup', async (node?: any) => {
    const name = await pickRobot(nameOf(node), true); if (!name) return;
    const c = robots.get(name)!;
    // With RUKUS on the PC the backup is filed where RUKUS would file it (beta list 2, item 5):
    // <backups root>\<cluster>\<robot>\<batch>\ - the robot's own archive, named by RUKUS's
    // templates, with RUKUS's manifest inside so RUKUS reads it as one of its own. Never into
    // Latest, which is RUKUS's to rotate. Without RUKUS: a folder of the user's choosing.
    const rukus = s.rukus?.available ? s.rukus : undefined;
    const rukusCluster = rukus ? (rukus.current()?.cluster ?? rukus.clusterOfRobot(name)) : undefined;
    let picked: vscode.Uri[] | undefined;
    if (!rukusCluster) {
      const defaultDir = vscode.workspace.workspaceFolders?.[0]?.uri;
      picked = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, defaultUri: defaultDir, title: 'Folder to receive the backup (a dated sub-folder is created)' });
      if (!picked?.[0]) return;
    }
    const what = await vscode.window.showQuickPick([
      { label: 'Programs and data', description: '*.ls *.va *.dg — what the editor uses', pattern: '*.ls *.va *.dg' },
      { label: 'Programs only', description: '*.ls', pattern: '*.ls' },
      { label: 'Programs, source and data', description: '*.ls *.pc *.kl *.va *.dg', pattern: '*.ls *.pc *.kl *.va *.dg' },
      { label: 'Everything listed', description: '*.* — all files on the device', pattern: '*.*' },
      { label: 'Custom pattern…', description: 'e.g. *.ls *.io *.sv', pattern: '' },
    ], { placeHolder: 'What to download' });
    if (!what) return;
    let pattern = what.pattern;
    if (!pattern) {
      const typed = await vscode.window.showInputBox({ prompt: 'File patterns, space separated, as you would type them after mget', value: '*.ls *.va', validateInput: v => v.trim() ? undefined : 'At least one pattern' });
      if (!typed) return; pattern = typed;
    }
    const match = globToRegExp(pattern);
    const startedUtc = new Date();
    const backupType = pattern.trim() === '*.*' ? 'MD' : 'Filtered';   // RUKUS's two kinds
    const place = rukus && rukusCluster ? placeBackup(rukus.backupsRoot, rukus.settings, rukusCluster.name, name, backupType, startedUtc) : undefined;
    const stamp = startedUtc.toISOString().slice(0, 16).replace(/[-:T]/g, '').replace(/(\d{8})(\d{4})/, '$1_$2');
    const dest = place ? vscode.Uri.file(place.archiveFolder) : vscode.Uri.joinPath(picked![0], `${name}_${stamp}`);
    await vscode.workspace.fs.createDirectory(dest);
    let files: { name: string; isDir: boolean }[];
    try { files = (await robots.listFiles(c.profile)).filter(f => !f.isDir && match.test(f.name)); }
    catch (e: any) { void showRecoverableError(`Could not list ${c.profile.device} on ${name}: ${e?.message ?? e}. Set an FTP user for listing.`, s.output); return; }
    if (!files.length) { vscode.window.showInformationMessage(`Nothing on ${name} ${c.profile.device} matches ${pattern}.`); return; }
    let ok = 0, failed = 0;
    const failedNames: string[] = [];
    const started = Date.now();
    // One session for the lot - the mget shape. Per-file sessions were the whole reason a
    // backup crawled: a controller takes longer to accept a login than to send a file.
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Backing up ${name}`, cancellable: true }, async (progress, token) => {
      const writes: Thenable<void>[] = [];
      try {
        await robots.readBinaryMany(c.profile, files.map(f => f.name), c.profile.device, (fname, result, i) => {
          progress.report({ message: `${fname} (${i + 1}/${files.length})`, increment: 100 / files.length });
          if ('data' in result) { ok++; writes.push(vscode.workspace.fs.writeFile(vscode.Uri.joinPath(dest, fname.toLowerCase()), result.data).then(undefined, e => { ok--; failed++; failedNames.push(fname); robots.log(name, `backup: could not save ${fname}: ${e?.message ?? e}`); })); }
          else { failed++; failedNames.push(fname); robots.log(name, `backup: ${fname} failed: ${result.error}`); }
        }, () => token.isCancellationRequested);
      } catch (e: any) {
        robots.log(name, `backup: session ended early: ${e?.message ?? e}`);
        vscode.window.showWarningMessage(`The connection to ${name} dropped part-way through: ${e?.message ?? e}. ${ok} file(s) were saved.`);
      }
      await Promise.all(writes);
    });
    robots.log(name, `backup to ${dest.fsPath}: ${ok} files, ${failed} failed, ${pattern} over ${c.profile.useFtp ? 'FTP (one session)' : 'HTTP'} in ${((Date.now() - started) / 1000).toFixed(1)} s`);
    if (place && rukusCluster) {
      const manifest = backupManifest({
        robotName: name, robotIp: c.profile.host, clusterName: rukusCluster.name, batchName: place.batchName,
        startedUtc, finishedUtc: new Date(), backupType,
        filterExtensions: backupType === 'MD' ? [] : pattern.split(/\s+/).filter(Boolean).map(p => p.replace(/^\*/, '')),
        filesListed: files.length, filesDownloaded: ok, failedFiles: failedNames,
        rukusVersion: `Robot Code ${ctx.extension.packageJSON.version}`, machineName: os.hostname(), windowsUser: os.userInfo().username,
      });
      await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(dest, RUKUS_MANIFEST), Buffer.from(manifest, 'utf8'));
      robots.log(name, `backup filed in RUKUS's store for cluster ${rukusCluster.name} (${place.batchName}); manifest written`);
    }
    const add = await vscode.window.showInformationMessage(
      `Backup of ${name}: ${ok} files saved to ${dest.fsPath}${failed ? `, ${failed} failed (see Output)` : ''}.`,
      'Use as controller data', 'Open folder', 'Schedule in RUKUS');
    if (add === 'Use as controller data') {
      await setWindowFolders('data.backupFolders', [...windowFolders('data.backupFolders'), dest.fsPath]);
    }
    if (add === 'Open folder') await vscode.commands.executeCommand('revealFileInOS', dest);
    if (add === 'Schedule in RUKUS') await openInRukus({ route: 'backup', robot: name, host: c.profile.host, path: dest.fsPath });
  });

  reg('robotCode.live.openAsWorkspaceFolder', async (node?: any) => {
    const name = await pickRobot(nameOf(node), true); if (!name) return;
    const c = robots.get(name)!;
    vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders?.length ?? 0, 0, { uri: robotUri(name, c.profile.device), name: `${name} ${c.profile.device}` });
  });

  // hidden: state dump for tests / troubleshooting
  reg('robotCode.live._state', () => robots.list().map(c => ({
    name: c.profile.name, state: c.state, error: c.error, autoRefresh: c.profile.autoRefresh,
    info: c.snapshot?.info, numregs: c.snapshot?.numregs.size ?? 0, io: c.snapshot?.io.size ?? 0,
    tasks: c.snapshot?.tasks.map(t => ({ ...t })),
    fetched: c.snapshot ? Object.fromEntries(c.snapshot.fetchedAt) : {},
    traffic: { ...c.traffic },
    position: c.snapshot?.position, errors: c.snapshot ? Object.fromEntries(c.snapshot.errors) : {},
    live_R151: robots.liveValue('R', 151), live_DI25: robots.liveValue('DI', 25),
  })));

  return robots;
}
