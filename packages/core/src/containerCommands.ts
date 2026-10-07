/**
 * Container commands: initialize cell / robot containers, snapshot from a backup folder
 * or a live robot, and the normalized working-vs-snapshot diff.
 */
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Services } from './services';
import { config, windowFolders, showRecoverableError } from './util';
import { snapshotStatus, snapshotRefFor } from './containerCompare';
import { parseControllerInfo } from './live/parsers';
import { globToRegExp } from './live/ftp';
import { folderDate } from '@core/backupFolders';
import { gated } from './experimental';
import { markerBoundRobot, profileNamed } from './robotBinding';
import {
  copySnapshotAsync, swapSnapshot, writeProvenance, writeRobotJson, writeCellJson, writeRobotGitignore,
  normalizeTpForCompare, normalizeKarelForCompare, snapshotFileTimes,
  isBackupLikeDir, findBackupCandidates, isCompiledProgram, findSnapshotFile, readSnapshotProgram,
  ROBOT_DIR, ROBOT_JSON, CELL_DIR, CELL_JSON,
  type RobotMarker, type RobotMarkerSpec, type CellControllerSpec,
} from './robotContainers';

/** the scheme that serves a file's normalized text for the working-vs-snapshot diff */
const NORM_SCHEME = 'robocode-norm';

function normUriOf(real: vscode.Uri): vscode.Uri {
  return vscode.Uri.from({ scheme: NORM_SCHEME, path: '/normalized', query: `src=${encodeURIComponent(real.toString())}` });
}

function realUriOf(uri: vscode.Uri): vscode.Uri | undefined {
  const src = /(?:^|&)src=([^&]+)/.exec(uri.query)?.[1];
  return src ? vscode.Uri.parse(decodeURIComponent(src)) : undefined;
}

/**
 * A container whose .gitignore already exists was set up to keep the snapshot out of git. The
 * list of what that means has grown (snapshot.json, the temp and moved-aside folders), so every
 * snapshot brings an existing file up to date. It never CREATES one: no .gitignore means the
 * user chose to commit snapshots.
 */
function keepGitignoreCurrent(robotRoot: string) {
  try { if (fs.existsSync(path.join(robotRoot, ROBOT_DIR, '.gitignore'))) writeRobotGitignore(robotRoot); } catch { /* never worth failing a snapshot over */ }
}

export function registerContainerCommands(ctx: vscode.ExtensionContext, s: Services) {
  const reg = (id: string, fn: (...a: any[]) => any) => ctx.subscriptions.push(vscode.commands.registerCommand(id, fn));

  /** every robot marker, or pick one when there are several */
  const pickMarker = async (marker?: RobotMarker): Promise<RobotMarker | undefined> => {
    if (marker) return marker;
    const markers = s.containers.markers;
    if (!markers.length) {
      vscode.window.showInformationMessage('No robot containers in this workspace. Run "Robot Code: Initialize Robot Container…" first.');
      return undefined;
    }
    if (markers.length === 1) return markers[0];
    const pick = await vscode.window.showQuickPick(
      markers.map(m => ({ label: m.name, description: vscode.workspace.asRelativePath(m.root, false), marker: m })),
      { placeHolder: 'Robot' }
    );
    return pick?.marker;
  };

  /** refresh everything the snapshot feeds (markers unchanged: data + index) */
  const refreshAfterSnapshot = async () => {
    await s.containers.refresh();
    await Promise.all([s.data.refresh(), s.index.refresh()]);
  };

  // ── Initialize Cell ────────────────────────────────────────────────────────
  reg('robotCode.containers.initCell', async () => {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) { vscode.window.showInformationMessage('Open a workspace folder first.'); return; }
    const root = folders.length === 1
      ? folders[0].uri
      : (await vscode.window.showQuickPick(folders.map(f => ({ label: f.name, description: f.uri.fsPath, uri: f.uri })), { placeHolder: 'Which folder is the cell root?' }))?.uri;
    if (!root) return;
    const dir = path.join(root.fsPath, CELL_DIR);
    const existing = path.join(dir, CELL_JSON);
    if (fs.existsSync(existing)) {
      const over = await vscode.window.showWarningMessage(`${CELL_DIR}/${CELL_JSON} already exists.`, { modal: true }, 'Overwrite');
      if (over !== 'Overwrite') return;
    }
    const name = await vscode.window.showInputBox({ prompt: 'Cell name (shown in views; conventions can be added to cell.json later)', value: path.basename(root.fsPath) });
    if (name === undefined) return;

    // Optional: add controller definitions
    const controllers: Record<string, CellControllerSpec> = {};
    let addMore = true;
    while (addMore) {
      const addCtrl = await vscode.window.showQuickPick([
        { label: 'Done', description: 'Finish cell setup', value: false },
        { label: 'Add controller…', description: 'Define a robot controller connection', value: true },
      ], { placeHolder: controllers.length ? `Added ${controllers.length} controller(s) — add more?` : 'Add robot controller connections to cell.json?' });
      if (!addCtrl || !addCtrl.value) { addMore = false; break; }

      const ctrlName = await vscode.window.showInputBox({
        prompt: 'Controller name (robot.json references this name)',
        validateInput: v => v.trim() ? (controllers[v.trim()] ? 'Name already used' : undefined) : 'A name is required',
      });
      if (ctrlName === undefined) continue;

      const host = await vscode.window.showInputBox({
        prompt: 'Controller IP address or hostname',
        validateInput: v => v.trim() ? undefined : 'Host is required',
      });
      if (host === undefined) continue;

      const useFtp = await vscode.window.showQuickPick([
        { label: 'HTTP (no login needed, recommended)', value: false },
        { label: 'FTP (requires user/password)', value: true },
      ], { placeHolder: 'Connection protocol' });
      if (useFtp === undefined) continue;

      const device = await vscode.window.showInputBox({ prompt: 'Device path', value: 'MD:' });
      if (device === undefined) continue;

      const spec: CellControllerSpec = { host: host.trim(), useFtp: useFtp.value, device: device.trim() || 'MD:' };
      controllers[ctrlName.trim()] = spec;
      vscode.window.setStatusBarMessage(`Robot Code: controller "${ctrlName.trim()}" added to cell`, 3000);
    }

    const cellName = name.trim() || path.basename(root.fsPath);
    writeCellJson(root.fsPath, cellName, Object.keys(controllers).length ? controllers : undefined);
    await s.containers.refresh();
    vscode.window.setStatusBarMessage(`Robot Code: cell container created for ${cellName}`, 5000);
    // The cell is a RUKUS cluster in waiting (beta list 4, item 3): sent now when RUKUS is
    // here and the user wants it, otherwise remembered and offered once RUKUS turns up.
    if (s.rukus?.available) {
      const send = await vscode.window.showInformationMessage(`Also create ${cellName} as a cluster in RUKUS?`, 'Create in RUKUS', 'Not now');
      if (send) await s.rukus.sendCell({ root: root.fsPath, name: cellName, controllers }, false);
      else s.rukus.rememberPending(root.fsPath);
    } else s.rukus?.rememberPending(root.fsPath);
  });

  // ── Initialize Robot Container (wizard) ────────────────────────────────────
  reg('robotCode.containers.initRobot', async () => {
    const picked = await vscode.window.showOpenDialog({
      canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
      defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
      title: 'Select the robot folder - its working program folders live inside it',
    });
    if (!picked?.[0]) return;
    const root = picked[0].fsPath;
    if (!vscode.workspace.getWorkspaceFolder(vscode.Uri.file(root))) {
      vscode.window.showWarningMessage('That folder is outside the workspace. Robot containers are only discovered inside workspace folders.');
      return;
    }
    const existing = path.join(root, ROBOT_DIR, ROBOT_JSON);
    if (fs.existsSync(existing)) {
      const over = await vscode.window.showWarningMessage(`${ROBOT_DIR}/${ROBOT_JSON} already exists here.`, { modal: true }, 'Overwrite');
      if (over !== 'Overwrite') return;
    }

    const name = await vscode.window.showInputBox({
      prompt: 'Robot name (matches the live robot profile name for connections)',
      value: path.basename(root),
      validateInput: v => v.trim() ? undefined : 'A name is required',
    });
    if (name === undefined) return;

    // working program folders: the subfolders that hold the editable programs
    let subdirs: string[] = [];
    try {
      subdirs = fs.readdirSync(root, { withFileTypes: true })
        .filter(e => e.isDirectory() && e.name !== ROBOT_DIR && e.name !== CELL_DIR && !e.name.startsWith('.'))
        .map(e => e.name);
    } catch { /* unreadable, allow without programs list */ }
    let programs: string[] | undefined;
    if (subdirs.length) {
      // Backup-looking folders start unchecked; everything else is working by default. "Looks like
      // a backup" is the name (backups, 1_MD, RUKUS's Latest and its date-stamped batches, a robot
      // backup folder in either RUKUS naming preset) OR the contents (it holds a controller backup,
      // or nothing but folders that do). It used to be three literal names, so a container made
      // inside a RUKUS tree came up with every dated backup ticked as editable programs.
      const picks = await vscode.window.showQuickPick(
        subdirs.map(n => {
          const backup = isBackupLikeDir(path.join(root, n));
          return { label: n, picked: !backup, description: backup ? 'looks like a backup - left out' : undefined };
        }),
        { canPickMany: true, placeHolder: 'Working program folders (the editable set - backups are left unticked)' }
      );
      if (!picks) return;
      // The items that come back ARE the ticked ones. Filtering them by `picked` again tested each
      // item's INITIAL state, so a folder the user ticked by hand was silently dropped.
      programs = picks.map(p => p.label);
    }

    // Controller binding: if cell.json defines controllers, offer to bind
    const cellDefs = s.containers.controllerDefs();
    const cellDefNames = Object.keys(cellDefs);
    let controller: string | undefined;
    if (cellDefNames.length) {
      const ctrlPick = await vscode.window.showQuickPick(
        [
          { label: 'None', description: 'No controller binding (can add later)', value: undefined },
          ...cellDefNames.map(n => ({
            label: n,
            description: `${cellDefs[n].host}`,
            value: n,
          })),
        ],
        { placeHolder: `Bind this robot to a controller from cell.json (found ${cellDefNames.length})` }
      );
      if (ctrlPick === undefined) return; // user cancelled
      controller = ctrlPick.value;
    }

    // git hygiene: a full snapshot is tens of MB of regenerable data
    const giDefault = config<boolean>('containers.gitignoreSnapshot', true);
    const gi = await vscode.window.showQuickPick([
      { label: giDefault ? 'Yes — ignore snapshot/ in git (recommended)' : 'Yes — ignore snapshot/ in git', value: true },
      { label: 'No — snapshots are committed to git', value: false },
      { label: `Always ${giDefault ? 'ignore' : 'commit'}, don't ask again`, value: giDefault, remember: true },
    ], { placeHolder: 'Keep the snapshot out of git?' });
    if (!gi) return;
    if (gi.remember) {
      const cfg = vscode.workspace.getConfiguration('robotCode');
      await cfg.update('containers.gitignoreSnapshot', gi.value, vscode.workspace.workspaceFolders ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global);
    }

    const spec: RobotMarkerSpec = { name: name.trim() };
    if (programs) spec.programs = programs;
    if (controller) spec.controller = controller;
    writeRobotJson(root, spec);
    if (gi.value) writeRobotGitignore(root);
    await s.containers.refresh();

    const first = await vscode.window.showInformationMessage(
      `Robot container "${spec.name}" created${programs ? ` with ${programs.length} working folder${programs.length === 1 ? '' : 's'}` : ''}.`,
      'Snapshot from Backup…', 'Snapshot from Robot…', 'Later'
    );
    const created = s.containers.markers.find(m => path.resolve(m.root) === path.resolve(root));
    if (first === 'Snapshot from Backup…') await vscode.commands.executeCommand('robotCode.data.snapshotFromBackup', { marker: created });
    if (first === 'Snapshot from Robot…') await vscode.commands.executeCommand('robotCode.data.snapshotFromRobot', { marker: created });
  });

  // ── Snapshot from Backup ───────────────────────────────────────────────────
  reg('robotCode.data.snapshotFromBackup', async (node?: { marker?: RobotMarker }) => {
    const marker = await pickMarker(node?.marker);
    if (!marker) return;
    // This robot's backups, found rather than browsed for. RUKUS keeps a robot's CURRENT backup in
    // <cluster>\Latest\<robot folder> - beside the robot's archive folder, not inside it - so it
    // is looked for everywhere the extension already knows about: the workspace, the folders
    // under robotCode.data.backupFolders, and the robot folder's own dated archives. Matched on
    // robot.json's name and on the folder's own name. Browse is always there.
    const roots = [...(vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath), ...windowFolders('data.backupFolders'), marker.root];
    const found = findBackupCandidates(roots, [marker.name, path.basename(marker.root), marker.controller ?? ''])
      .filter(c => path.resolve(c.dir).toLowerCase() !== path.resolve(marker.snapshotDir).toLowerCase());
    let srcDir: string | undefined;
    // In a RUKUS cluster workspace the robot's Latest backup is known, so it is offered outright
    // (the list is one click further away, for another backup).
    const latest = s.rukus?.latestOf(marker.name) ?? s.rukus?.latestOf(path.basename(marker.root));
    if (latest && path.resolve(latest).toLowerCase() !== path.resolve(marker.snapshotDir).toLowerCase()) {
      const date = folderDate(latest);
      const pick = await vscode.window.showInformationMessage(`Snapshot ${marker.name} from RUKUS's Latest backup, ${path.basename(latest)}${date ? ` (${date})` : ''}?`, { modal: true, detail: latest }, 'Use Latest', 'Choose another…');
      if (!pick) return;
      if (pick === 'Use Latest') srcDir = latest;
    }
    if (!srcDir && found.length) {
      const BROWSE = 'Browse…';
      const pick = await vscode.window.showQuickPick(
        [
          ...found.slice(0, 30).map(c => ({
            label: `${c.latest ? '$(star-full) ' : ''}${path.basename(c.dir)}`,
            description: [c.latest ? 'Latest' : '', c.date ?? ''].filter(Boolean).join(' · '),
            detail: c.dir,
            dir: c.dir as string | undefined,
          })),
          { label: BROWSE, description: 'pick another folder', detail: undefined as string | undefined, dir: undefined as string | undefined },
        ],
        { placeHolder: `Backup of ${marker.name} to snapshot - ${found.length} found, newest first`, matchOnDescription: true, matchOnDetail: true }
      );
      if (!pick) return;
      srcDir = pick.dir;
    }
    if (!srcDir) {
      const src = await vscode.window.showOpenDialog({
        canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
        title: 'Backup folder to snapshot (a full controller backup: .va files, programs, everything)',
      });
      if (!src?.[0]) return;
      srcDir = src[0].fsPath;
    }
    // sanity: a backup folder has programs or .va data in it
    let entries: string[] = [];
    try { entries = fs.readdirSync(srcDir); } catch { /* the copy will fail with a real error */ }
    if (entries.length && !entries.some(n => /\.(ls|kl|pc|tp|va|sv|dg|dt|io|vr)$/i.test(n))) {
      const go = await vscode.window.showWarningMessage(
        `"${path.basename(srcDir)}" does not look like a controller backup (no programs or data files at its top level).`,
        { modal: true }, 'Snapshot it anyway'
      );
      if (go !== 'Snapshot it anyway') return;
    }
    try {
      // the async copy: the synchronous one froze the extension host for the whole backup, with
      // this very notification standing still on screen
      const count = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Snapshotting ${marker.name}`, cancellable: false },
        progress => copySnapshotAsync(srcDir, marker.snapshotDir, (n, name) => { if (n % 25 === 0 || n === 1) progress.report({ message: `${n} files — ${name}` }); })
      );
      keepGitignoreCurrent(marker.root);
      const now = new Date().toISOString();
      writeProvenance(marker.root, {
        date: now,
        updatedAt: now,
        source: { kind: 'backup', path: srcDir },
        fileCount: count,
        files: snapshotFileTimes(marker.snapshotDir, now),
      });
      await refreshAfterSnapshot();
      vscode.window.setStatusBarMessage(`Robot Code: ${marker.name} snapshot — ${count} files from ${path.basename(srcDir)}`, 5000);
    } catch (e: unknown) {
      void showRecoverableError(`Snapshot failed: ${e instanceof Error ? e.message : String(e)}`, s.output, () => vscode.commands.executeCommand('robotCode.data.snapshotFromBackup', node));
    }
  });

  // ── Snapshot from Robot (heavy: overwrite the whole snapshot from the controller) ──
  //
  // The heavyweight counterpart to an incremental Fetch: it lists everything on the controller,
  // replaces the container's snapshot wholesale and records the controller's own metadata
  // (F number, version, host). It is tied to the controller, so it is offered on the Controllers
  // tree and the robot page, not on the Snapshot view.
  reg('robotCode.data.snapshotFromRobot', gated(async (arg?: unknown) => {
    const node = arg as { marker?: RobotMarker; c?: { profile?: { name?: string } } } | undefined;
    const explicit = typeof arg === 'string' ? arg : node?.c?.profile?.name;
    let marker = node?.marker;
    if (!marker && explicit) {
      const bound = s.containers.markers.filter(m => markerBoundRobot(m).name.toLowerCase() === explicit.toLowerCase());
      if (bound.length === 1) marker = bound[0];
      else if (bound.length > 1) {
        const pick = await vscode.window.showQuickPick(
          bound.map(m => ({ label: m.name, description: vscode.workspace.asRelativePath(m.root, false), marker: m })),
          { placeHolder: `Snapshot ${explicit} into which robot container?` });
        if (!pick) return;
        marker = pick.marker;
      } else {
        const pick = await vscode.window.showInformationMessage(
          `No robot container is bound to "${explicit}". Create one to hold its snapshot?`,
          'Initialize Robot Container…', 'Cancel');
        if (pick) await vscode.commands.executeCommand('robotCode.containers.initRobot');
        return;
      }
    }
    if (!marker) marker = await pickMarker(undefined);
    if (!marker) return;

    const live = s.live;
    if (!live) { vscode.window.showInformationMessage('No robot is connected. Connect a robot first (Controllers view).'); return; }
    const connected = live.connected();
    if (!connected.length) { vscode.window.showInformationMessage('No robot is connected. Connect a robot first (Controllers view).'); return; }
    // Read from the controller the caller named, else the container's own binding, else ask.
    const want = explicit ?? markerBoundRobot(marker).name;
    let chosen = profileNamed(connected, want);
    if (!chosen) chosen = connected.length === 1 ? connected[0]
      : (await vscode.window.showQuickPick(connected.map(c => ({ label: c.profile.name, description: `${c.profile.host} · ${c.state}`, c })), { placeHolder: `Robot to snapshot into ${marker.name}` }))?.c;
    if (!chosen) return;
    const profile = chosen.profile;

    const tmpDir = marker.snapshotDir + '.tmp-' + Date.now();
    let ok = 0, failed = 0;
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.mkdirSync(tmpDir, { recursive: true });
      const matchAll = globToRegExp('*.*');  // a complete, verbatim backup
      let files: { name: string; isDir: boolean }[];
      try { files = (await live.listFiles(profile)).filter(f => !f.isDir && matchAll.test(f.name)); }
      catch (e: unknown) {
        void showRecoverableError(`Could not list ${profile.device} on ${profile.name}: ${e instanceof Error ? e.message : String(e)}`, s.output, () => vscode.commands.executeCommand('robotCode.data.snapshotFromRobot', node));
        return;
      }
      if (!files.length) { vscode.window.showInformationMessage(`Nothing on ${profile.name} ${profile.device} to snapshot.`); return; }
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Snapshotting ${marker.name} from ${profile.name}`, cancellable: true }, async (progress, token) => {
        const writes: Thenable<void>[] = [];
        await live.readBinaryMany(profile, files.map(f => f.name), profile.device, (fname, result, i) => {
          progress.report({ message: `${fname} (${i + 1}/${files.length})`, increment: 100 / files.length });
          if ('data' in result) {
            ok++;
            writes.push(vscode.workspace.fs.writeFile(vscode.Uri.file(path.join(tmpDir, fname.toLowerCase())), result.data).then(undefined, e => { ok--; failed++; live.log(profile.name, `snapshot: could not save ${fname}: ${e instanceof Error ? e.message : String(e)}`); }));
          } else { failed++; live.log(profile.name, `snapshot: ${fname} failed: ${result.error}`); }
        }, () => token.isCancellationRequested);
        await Promise.all(writes);
      });
      if (!ok) { void showRecoverableError(`Snapshot of ${profile.name} produced no files.`, s.output, () => vscode.commands.executeCommand('robotCode.data.snapshotFromRobot', node)); return; }

      // controller info for the provenance, from the files just pulled
      const read = (n: string) => { try { return fs.readFileSync(path.join(tmpDir, n), 'latin1'); } catch { return ''; } };
      const info = parseControllerInfo(read('version.dg') + read('errall.ls') + read('curpos.dg'));
      swapSnapshot(tmpDir, marker.snapshotDir);
      keepGitignoreCurrent(marker.root);
      const now = new Date().toISOString();
      writeProvenance(marker.root, {
        date: now,
        updatedAt: now,
        source: { kind: 'robot', name: profile.name, host: profile.host },
        fileCount: ok,
        files: snapshotFileTimes(marker.snapshotDir, now),
        controller: info.fNumber || info.version || info.robotName
          ? { name: info.robotName ?? profile.name, version: info.version ?? '', fNumber: info.fNumber ?? '' }
          : undefined,
      });
      await refreshAfterSnapshot();
      live.log(profile.name, `snapshot into ${marker.name}: ${ok} files, ${failed} failed`);
      vscode.window.setStatusBarMessage(`Robot Code: ${marker.name} snapshot — ${ok} files from ${profile.name}${failed ? `, ${failed} failed (see Output)` : ''}`, 5000);
    } catch (e: unknown) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
      void showRecoverableError(`Snapshot from ${profile.name} failed: ${e instanceof Error ? e.message : String(e)}`, s.output, () => vscode.commands.executeCommand('robotCode.data.snapshotFromRobot', node));
    }
  }));

  // ── Diff working copy against snapshot (normalized) ────────────────────────
  reg('robotCode.containers.diffWithSnapshot', async (uri?: vscode.Uri) => {
    const target = uri
      ?? (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri.scheme === 'file' ? vscode.window.activeTextEditor.document.uri : undefined);
    if (!target) { vscode.window.showInformationMessage('Open a working program file first.'); return; }
    const info = s.index.forUri(target);
    if (!info) { vscode.window.showInformationMessage('That file is not indexed as a program.'); return; }
    const marker = s.containers.markerOf(target.fsPath);
    if (!marker) { vscode.window.showInformationMessage('That file is not in a robot container working folder.'); return; }
    // A compiled working copy has no text to diff. Byte-compare it with the SAME-extension
    // snapshot copy on demand and report a boolean - never a text diff, never a source.
    if (isCompiledProgram(target.fsPath)) {
      const snapPath = findSnapshotFile(marker.snapshotDir, path.basename(target.fsPath));
      if (!snapPath) { vscode.window.showInformationMessage(`${path.basename(target.fsPath)}: the snapshot has no compiled copy to compare against.`); return; }
      let identical = false;
      try { identical = fs.readFileSync(snapPath).equals(fs.readFileSync(target.fsPath)); } catch { /* unreadable */ }
      vscode.window.showInformationMessage(`${path.basename(target.fsPath)}: compiled copy is ${identical ? 'identical to' : 'different from'} the snapshot (byte compare - no line diff for a binary).`);
      return;
    }
    // Source vs source only: the snapshot reference must be an editable `.ls`/`.kl`, never a
    // compiled `.tp`/`.pc` (whose bytes are not text and must never be normalized or diffed).
    const ref = snapshotRefFor(s.index.all(info.name), info);
    let refUri = ref?.uri;
    if (!refUri) {
      // the source copy may not be indexed (hidden/excluded, past the cap); it is still the snapshot
      const disk = readSnapshotProgram(marker.snapshotDir, info.name, info.kind === 'karel' ? 'karel' : 'tp');
      if (disk) refUri = vscode.Uri.file(disk.path);
    }
    if (!refUri) {
      const compiledOnly = s.index.all(info.name).some(p => p.reference && p.group === info.group && p.kind === 'binary');
      vscode.window.showInformationMessage(compiledOnly
        ? `${info.name}: ${marker.name}'s snapshot has only a compiled copy - there is no source to diff.`
        : `No copy of ${info.name} in ${marker.name}'s snapshot. Run "Snapshot from Backup…" or "Snapshot from Robot…".`);
      return;
    }
    const st = snapshotStatus(s, info);
    // Always open the diff, identical or not: a deliberate "compare" should show the two panes
    // (and the "no changes" state) rather than a toast the user has to dismiss.
    // vscode.diff takes (original, modified): the snapshot is what the robot HAS, the working copy
    // is what was changed since. The other way round, a line added in the working copy reads as a
    // deletion, and the whole diff says the opposite of what happened.
    const title = `${info.name}: snapshot${st?.date ? ` ${st.date}` : ''} ↔ working (line numbers ignored)`;
    await vscode.commands.executeCommand('vscode.diff', normUriOf(refUri), normUriOf(target), title);
  });

  // ── the normalized-content provider behind the diff ────────────────────────
  ctx.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(NORM_SCHEME, {
    provideTextDocumentContent(uri: vscode.Uri): vscode.ProviderResult<string> {
      const real = realUriOf(uri);
      if (!real) return '';
      // a compiled program is not text: refuse rather than latin1-normalize its bytes
      if (isCompiledProgram(real.fsPath)) return '(compiled program — no text to compare)';
      return vscode.workspace.fs.readFile(real).then(buf => {
        const text = Buffer.from(buf).toString('latin1');
        return /\.ls$/i.test(real.fsPath) ? normalizeTpForCompare(text) : normalizeKarelForCompare(text);
      }, () => `could not read ${real.fsPath}`);
    },
  }));
}
