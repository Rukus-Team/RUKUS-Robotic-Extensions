/**
 * The status bar items: the live robot (a glyph + its name, one cell) and the open file's sync
 * marker against its snapshot. Everything shown is already known - the connection, the last
 * CURPOS read, the backup folder, `symotn.va` - so drawing it costs the controller nothing and
 * it never lies about age: a reading is stamped with when it was read.
 *
 * The open file's state is a git-shaped symbol (✓ ↑ ↓ ↕ ?) in brackets, tinted by context:
 * synced (✓) and untracked (?) stay plain, any difference from the snapshot (↑ local, ↓ robot)
 * turns amber, and a true divergence (↕) turns red.
 */
import * as vscode from 'vscode';
import * as path from 'node:path';
import type { FanucServices } from '../services';
import { ageTicked } from '@core/live/views';
import { syncStateOf, comparedChanged } from '@core/snapshotSync';
import { snapshotStatus, syncRelation, syncColorToken, type SnapshotStatus, type SyncRelation } from '@core/containerCompare';

/** workspaceState key: the header template (customer spec) last inserted */
export const HEADER_TEMPLATE_KEY = 'robotCode.headerTemplate';
/** fired by whoever changes something the items show that has no event of its own */
export const contextChanged = new vscode.EventEmitter<void>();

function ago(at: number): string {
  const s = Math.round((Date.now() - at) / 1000);
  return s < 60 ? `${s} s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
}

/** The status marker's colour, one source of truth shared with the tree (containerCompare). */
function syncColor(rel: SyncRelation): vscode.ThemeColor | undefined {
  const token = syncColorToken(rel);
  return token ? new vscode.ThemeColor(token) : undefined;
}

export function registerContextStatus(ctx: vscode.ExtensionContext, s: FanucServices) {
  // Two items: the robot (glyph + name, one cell; only the glyph is meant to stand out) and the
  // open file's sync marker. Clicking the robot connects / reveals / opens the Controllers view.
  const conn = vscode.window.createStatusBarItem('robotCode.robot', vscode.StatusBarAlignment.Right, 91);
  const sync = vscode.window.createStatusBarItem('robotCode.sync', vscode.StatusBarAlignment.Right, 90);
  conn.name = 'Robot Code: robot';
  sync.name = 'Robot Code: sync';
  conn.command = 'robotCode.live.focusView';
  sync.command = 'robotCode.sync.compareFile';
  ctx.subscriptions.push(conn, sync, contextChanged);

  /** the open working file's state against its snapshot copy */
  const updateSync = () => {
    const ed = vscode.window.activeTextEditor;
    const uri = ed && ed.document.uri.scheme === 'file' ? ed.document.uri : undefined;
    const st = uri ? syncStateOf(s, uri) : undefined;
    // the conditional Revert (discard) tab button keys off this: only a saved difference counts
    void vscode.commands.executeCommand('setContext', 'robotCode.syncModified', st?.state === 'modified');
    // the editor tab's Push button: something to send (a local difference, or a program the
    // snapshot has never seen). Context menus are not gated by this.
    void vscode.commands.executeCommand('setContext', 'robotCode.syncPushable', st?.state === 'modified' || st?.state === 'not-in-snapshot');
    if (!ed || !uri || !st) { sync.hide(); return; }
    const name = path.basename(uri.fsPath).replace(/\.[^.]+$/, '').toUpperCase();
    const ext = path.extname(uri.fsPath).replace(/^\./, '').toUpperCase();
    const prefix = ext ? `[${ext}] ` : '';
    const age = st.ageMs !== undefined ? ago(st.ageMs) : 'never fetched';
    const info = s.index.forUri(uri);
    const ss = info ? snapshotStatus(s, info) : undefined;
    // for a data file (no index entry) fall back to the verbatim state syncStateOf already used
    const status: SnapshotStatus = ss
      ?? (st.state === 'not-in-snapshot' ? { state: 'missing', date: st.date }
        : st.state === 'compiled' ? { state: 'compiled', date: st.date }
          : st.state === 'same' ? { state: 'same', date: st.date }
            : { state: 'modified', date: st.date });
    const rel = syncRelation(status, st.robot);

    // What the file is, from the index, in plain words.
    const kind = !info ? 'Data file'
      : info.kind === 'karel' ? 'KAREL source'
        : info.kind === 'binary' ? (info.programType ?? 'Compiled program')
          : `TP program${info.programType ? ` (${info.programType})` : ''}`;
    const counts = !info || info.kind === 'binary' ? '' : ` · ${info.lineCount} lines · ${info.labels} labels · ${info.positions} positions`;
    const comment = info?.comment ? `\n\nProgram Comment: "${info.comment}"` : '';

    // The sync state and where it came from, in words (no symbol legend).
    const facts: string[] = [rel.words];
    if (rel.ahead !== undefined) facts.push(`${rel.ahead}${rel.approximate ? '+' : ''} line(s) in your copy are not in the snapshot yet.`);
    if (st.robot?.differs && rel.behind !== undefined) facts.push(`${rel.behind} line(s) on the controller differ from the snapshot${st.robot.metadataOnly ? ' (only the date or time changed)' : ''}.`);

    const robotLabel = st.marker.controller && st.marker.controller.toLowerCase() !== st.marker.name.toLowerCase()
      ? `${st.marker.name} (controller ${st.marker.controller})` : st.marker.name;
    const robotLine = st.robot
      ? `Controller: ${st.robot.differs ? `differs${st.robot.metadataOnly ? ' (only the date or time changed)' : ''}${st.robot.changed !== undefined ? ` by ${st.robot.changed} line(s)` : ''}` : 'identical'}${st.robot.at ? ` · compared ${ago(st.robot.at)}` : ''}`
      : 'Controller: not compared this session';

    sync.text = `${prefix}${name} (${rel.symbol}) ${age}`;
    sync.color = syncColor(rel);
    sync.tooltip = new vscode.MarkdownString(
      `**${prefix}${name}** — ${kind}${counts}${comment}\n\n` +
      `${facts.join('\n\n')}\n\n` +
      `Snapshot: ${st.date ? `taken ${st.date}` : 'no date recorded'} · last fetch ${st.ageMs !== undefined ? age : 'never'}\n` +
      `Robot: ${robotLabel}\n` +
      `${robotLine}\n\n` +
      `${vscode.workspace.asRelativePath(uri, false)}\n\n` +
      `Click to compare with the snapshot. Use the Snapshot view or the editor menu to fetch, pull or push.`);
    sync.show();
  };

  const update = () => {
    const ed = vscode.window.activeTextEditor;
    const robotFile = !!ed && /^fanuc-/.test(ed.document.languageId);
    const all = s.live?.list() ?? [];
    const live = s.live?.connected() ?? [];
    // The item follows the focused file's robot through its container marker, so it answers
    // "which robot is THIS program's" rather than "is any robot connected".
    const marker = ed && ed.document.uri.scheme === 'file' ? s.containers.markerOf(ed.document.uri.fsPath) : undefined;
    // drives the editor-tab `when` clauses: only a container working file has a robot to sync with
    void vscode.commands.executeCommand('setContext', 'robotCode.fileInContainer', !!marker);
    const wanted = marker ? (marker.controller ?? marker.name).toLowerCase() : undefined;
    const focused = wanted ? all.find(x => x.profile.name.toLowerCase() === wanted) : undefined;
    const c = focused?.state === 'connected' && focused.snapshot ? focused : live[0];
    if (!c && !focused && !marker && !robotFile) {
      conn.hide(); updateSync(); return;
    }

    const tips: string[] = [];
    if (focused) {
      tips.push(marker!.controller && marker!.controller.toLowerCase() === focused.profile.name.toLowerCase()
        ? `Focused file is bound to controller ${focused.profile.name}`
        : `Focused file is in ${marker!.name}'s container`);
    } else if (marker && wanted) {
      tips.push(`Focused file is in ${marker.name}'s container, but no controller profile matches "${marker.controller ?? marker.name}". Add one in the Controllers view.`);
    }

    const connect = (n: string): vscode.Command => ({ command: 'robotCode.live.connect', title: `Connect ${n}`, arguments: [n] });
    let glyph: string;
    let color: vscode.ThemeColor | undefined;
    let command: string | vscode.Command = 'robotCode.live.focusView';
    let displayName: string;
    if (focused) {
      displayName = focused.profile.name;
      if (focused.state === 'error') {
        glyph = '$(error)';
        color = new vscode.ThemeColor('errorForeground');
        command = connect(focused.profile.name);
        tips.unshift(`**${displayName}** — connection failed (${focused.profile.host})${focused.error ? `: ${focused.error}` : ''}. **Click to try again.**`);
      } else if (focused.state === 'connected' && focused.snapshot) {
        const ping = focused.pingedAt ? ` · checked ${ago(focused.pingedAt)}` : '';
        const run = (s.live?.activeTpTasks() ?? []).find(t => t.robot.toLowerCase() === displayName.toLowerCase());
        if (focused.reachable === false) {
          // the heartbeat got no answer: connected on paper, but the controller is not replying now
          glyph = '$(circle-slash)';
          color = new vscode.ThemeColor('errorForeground');
          command = { command: 'robotCode.live.ping', title: `Check ${focused.profile.name}`, arguments: [focused.profile.name] };
          tips.unshift(`**${displayName}** — connected but not answering (${focused.profile.host})${focused.error ? `: ${focused.error}` : ''}${ping}. **Click to check again.**`);
        } else if (run) {
          const cur = run.task.current!;
          const stale = run.age > 15000;
          glyph = `$(${stale ? 'history' : run.task.status === 'RUNNING' ? 'debug-start' : 'debug-pause'})`;
          color = new vscode.ThemeColor('charts.green');
          command = 'robotCode.live.revealRunning';
          tips.unshift(`**${displayName}** — task ${run.task.taskNo} ${run.task.name}: ${cur.program} line ${cur.line} · ${run.task.status} (read ${ago(Date.now() - run.age)}). Click to reveal the line.`);
        } else {
          glyph = '$(circle-filled)';
          color = new vscode.ThemeColor('charts.green');
          command = 'robotCode.live.focusView';
          tips.unshift(`**${displayName}** — connected (${focused.profile.host}) · ${focused.profile.useFtp ? `FTP ${focused.profile.ftpPort}` : `HTTP ${focused.profile.httpPort}`} · device ${focused.profile.device}${ping}${live.length > 1 ? ` (and ${live.length - 1} more connected)` : ''}. Click to open the Controllers view.`);
          const pos = focused.snapshot?.position;
          const posAt = focused.snapshot?.fetchedAt.get('position');
          if (pos && pos.frameNo !== undefined) tips.push(`Active UF/UT: UF ${pos.frameNo} / UT ${pos.toolNo ?? '?'} (CURPOS read ${posAt ? ago(posAt) : '?'})`);
          else tips.push('Active UF/UT: press Get on Position in the Controllers view');
          const ds = s.data.datasets.find(d => d.name.toUpperCase() === displayName.toUpperCase());
          if (ds?.activePayloadMass !== undefined) tips.push(`Active payload ${ds.activePayloadMass} kg (from the backup)`);
        }
      } else {
        glyph = '$(circle-outline)';
        color = new vscode.ThemeColor('disabledForeground');
        command = connect(focused.profile.name);
        tips.unshift(`**${displayName}** — not connected (${focused.profile.host}). **Click to connect.**`);
      }
    } else if (marker && wanted) {
      displayName = marker.name;
      glyph = '$(circle-outline)';
      color = new vscode.ThemeColor('disabledForeground');
      tips.unshift(`**${marker.name}** — no controller profile matches "${marker.controller ?? marker.name}". Click to open the Controllers view.`);
    } else {
      const failed = all.some(x => x.state === 'error');
      if (failed) { displayName = 'no robot'; glyph = '$(error)'; color = new vscode.ThemeColor('errorForeground'); }
      else if (live.length) { displayName = live[0].profile.name; glyph = '$(circle-filled)'; color = new vscode.ThemeColor('charts.green'); }
      else if (all.length) { displayName = 'no robot'; glyph = '$(circle-outline)'; color = new vscode.ThemeColor('disabledForeground'); }
      else { displayName = 'offline'; glyph = '$(circle-outline)'; color = new vscode.ThemeColor('disabledForeground'); }
      tips.unshift(failed ? 'A robot connection failed — see the Controllers view' : live.length ? `${live[0].profile.name} connected. Click to open the Controllers view.` : all.length ? 'No robot connected. Click to open the Controllers view.' : 'No robots configured. Click to open the Controllers view.');
    }

    // the snapshot the open file belongs to, else the connected robot's — tooltip only
    const ds = (ed && s.data.dataset(ed.document.uri))
      ?? (c ? s.data.datasets.find(d => d.name.toUpperCase() === c.profile.name.toUpperCase()) : undefined)
      ?? (s.data.datasets.length === 1 ? s.data.datasets[0] : undefined);
    if (ds) {
      // a snapshot dataset is literally a folder named "snapshot" - its date comes from
      // provenance, not from the folder name
      const snapMarker = s.containers.markers.find(m => m.snapshotDir.toLowerCase() === ds.folder.toLowerCase());
      if (snapMarker) {
        const prov = s.containers.snapshotInfo(snapMarker.root);
        const date = prov?.date.slice(0, 10);
        const updated = prov?.updatedAt ? ` · updated ${ago(Date.parse(prov.updatedAt))}` : '';
        tips.push(`Snapshot: ${ds.name}${date ? ` (taken ${date}${prov?.source.kind === 'robot' ? ` from robot ${prov.source.name}` : prov?.source.kind === 'backup' ? ' from a backup folder' : ''})` : ' (no provenance - re-snapshot to record it)'}${updated}`);
      }
    }

    conn.text = `${glyph} ${displayName}`;
    conn.color = color;
    conn.command = command;
    conn.tooltip = tips.join('\n') || 'Robot Code';
    conn.show();
    updateSync();
  };

  ctx.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(update),
    s.data.onDidChange(update),
    s.containers.onDidChange(update),
    s.index.onDidChange(update),
    vscode.workspace.onDidSaveTextDocument(d => { if (d.uri.scheme === 'file' && s.containers.markerOf(d.uri.fsPath)) update(); }),
    contextChanged.event(update),
    comparedChanged.event(update),
  );
  if (s.live) ctx.subscriptions.push(s.live.onDidChange(update), ageTicked.event(update));
  update();
}
