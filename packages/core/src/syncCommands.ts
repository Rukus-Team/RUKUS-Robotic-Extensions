/**
 * `robotCode.sync.*` - the git-shaped snapshot commands that do NOT write to the robot.
 *
 * Fetch = update the snapshot from the robot. Pull = fetch then overwrite the working copy.
 * Revert = restore the working copy from the snapshot. Compare = read-only diff. History =
 * the reflog of a snapshot file. Push lives in `live/editorCommands.ts`, because it is the
 * one write and shares the guarded send path.
 */
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Services } from './services';
import type { RobotConnection, RobotManager } from './live/robotManager';
import type { RobotMarker } from './robotContainers';
import { markerBoundRobot, profileNamed } from './robotBinding';
import { snapshotStatus } from './containerCompare';
import {
  isSnapshotDataFile, isSnapshotProgramFile, findSnapshotFile, listSnapshotHistory, verbatimCompare, isCompiledProgram, snapshotNamesUnder, snapshotFetchedWithin,
} from './robotContainers';
import {
  fetchFilesFromRobot, fetchFileFromRobot, revertFromSnapshot, withContainerLock,
  writeWorkingCopy, workingFileFor, targetFromUri, snapshotCopy, fileNameForUri, noteRobotCompare,
  comparedChanged, syncStateOf, markerForDocument, type FetchOutcome,
} from './snapshotSync';
import { parseAlarms } from './live/parsers';
import type { AlarmEntry } from './live/types';
import { config, showRecoverableError } from './util';
import { gated, robotConnectionsEnabled } from './experimental';

/** A node from the SnapshotTree, or a plain resource. */
interface SyncNode {
  type?: string;
  marker?: RobotMarker;
  entry?: { rel: string; abs: string };
  scope?: 'programs' | 'data' | 'files';
  programs?: { uri: vscode.Uri }[];
  /** a Programs/PC tree row */
  info?: { uri: vscode.Uri };
  /** a robot-folder row's group key (the marker root for a container) */
  group?: string;
  /** a snapshot directory row: the prefix under the snapshot dir and its listing */
  prefix?: string;
  entries?: Array<{ rel: string; abs: string }>;
}

export function registerSyncCommands(ctx: vscode.ExtensionContext, s: Services): void {
  const reg = (id: string, fn: (...a: any[]) => any) => ctx.subscriptions.push(vscode.commands.registerCommand(id, fn));

  reg('robotCode.sync.fetchFile', gated((arg?: unknown) => fetchFileCommand(s, arg)));
  reg('robotCode.sync.pullFile', gated((arg?: unknown) => pullFileCommand(s, arg)));
  reg('robotCode.sync.compareFile', (arg?: unknown) => compareFileCommand(s, arg));
  reg('robotCode.sync.diffOpen', (arg?: unknown) => diffOpenCommand(s, arg));
  reg('robotCode.sync.revertFile', (arg?: unknown) => revertFileCommand(s, arg));
  reg('robotCode.sync.pullToWorking', (arg?: unknown) => pullToWorkingCommand(s, arg));
  reg('robotCode.sync.history', (arg?: unknown) => historyCommand(s, arg));
  // Fetch… - incremental, and the user picks what to advance (the heavy overwrite is on the robot)
  reg('robotCode.sync.fetch', gated((arg?: unknown) => fetchChooseCommand(s, arg)));
  // right-click a folder: fetch (snapshot only) or pull (fetch + overwrite) everything under it
  reg('robotCode.sync.fetchFolder', gated((arg?: unknown) => folderCommand(s, arg, false)));
  reg('robotCode.sync.pullFolder', gated((arg?: unknown) => folderCommand(s, arg, true)));
  reg('robotCode.sync.fetchCompareAll', gated((arg?: unknown) => fetchCompareAllCommand(s, arg)));
  reg('robotCode.sync.errors', gated((arg?: unknown) => errorsCommand(s, arg)));
  // hidden: the open file's sync state, so the smoke test can assert the snapshot is recognized.
  // Carries the normalized line count too (which syncStateOf itself does not compute).
  reg('robotCode.sync._state', () => {
    const ed = vscode.window.activeTextEditor;
    if (!ed) return undefined;
    const st = syncStateOf(s, ed.document.uri);
    if (!st) return undefined;
    const info = s.index.forUri(ed.document.uri);
    const ss = info ? snapshotStatus(s, info) : undefined;
    return { state: st.state, ageMs: st.ageMs, date: st.date, lines: ss?.lines ?? st.lines, robot: st.robot };
  });
}

// ── target + robot resolution ───────────────────────────────────────────────

interface Resolved {
  marker: RobotMarker;
  fileName?: string;
  relPath?: string;
  workingUri?: vscode.Uri;
}

/** The resource a command acts on: a Uri, the first of a multi-select array, or the active editor. */
function argUri(arg?: unknown): vscode.Uri | undefined {
  if (arg instanceof vscode.Uri) return arg;
  if (Array.isArray(arg)) {
    const u = arg.find((x): x is vscode.Uri => x instanceof vscode.Uri);
    if (u) return u;
  }
  return vscode.window.activeTextEditor?.document.uri;
}

function markerOf(s: Services, arg?: unknown): RobotMarker | undefined {
  const node = arg as SyncNode | undefined;
  if (node?.marker) return node.marker;
  if (node?.info?.uri?.scheme === 'file') return s.containers.markerOf(node.info.uri.fsPath);
  if (node?.group) {
    const g = node.group.toLowerCase();
    const byGroup = s.containers.markers.find(m => m.root.toLowerCase() === g);
    if (byGroup) return byGroup;
  }
  const uri = argUri(arg);
  if (uri && uri.scheme === 'file') return s.containers.markerOf(uri.fsPath);
  return undefined;
}

/** The file a command acts on: from a snapshot row, a program row, or the active working file. */
function resolve(s: Services, arg?: unknown): Resolved | undefined {
  const node = arg as SyncNode | undefined;
  if (node?.marker && node.entry) {
    const fileName = path.basename(node.entry.rel).toUpperCase();
    const working = workingFileFor(s, node.marker, fileName);
    return { marker: node.marker, fileName, relPath: node.entry.rel, workingUri: working?.uri };
  }
  const uri = node?.info?.uri ?? argUri(arg);
  if (!uri || uri.scheme !== 'file') return undefined;
  const t = targetFromUri(s, uri);
  if (!t) return undefined;
  return { marker: t.marker, fileName: t.fileName, workingUri: uri, relPath: undefined };
}

/** A marker for a whole-snapshot command: from the node, or the only one, or a pick. */
async function resolveMarker(s: Services, arg?: unknown): Promise<RobotMarker | undefined> {
  const direct = markerOf(s, arg);
  if (direct) return direct;
  const markers = s.containers.markers;
  if (!markers.length) {
    const pick = await vscode.window.showInformationMessage('No robot containers in this workspace.', 'Initialize Robot Container…');
    if (pick) await vscode.commands.executeCommand('robotCode.containers.initRobot');
    return undefined;
  }
  if (markers.length === 1) return markers[0];
  const pick = await vscode.window.showQuickPick(markers.map(m => ({ label: m.name, description: vscode.workspace.asRelativePath(m.root, false), marker: m })), { placeHolder: 'Which robot?' });
  return pick?.marker;
}

/**
 * The robot a container's file is bound to, connected if it can be. A declared `controller`
 * is authoritative: when no profile of that name exists the action is refused rather than
 * aimed at another robot - pushing to the wrong controller is worse than not pushing. Only a
 * container that names no known robot falls back to asking.
 */
async function robotForMarker(s: Services, marker: RobotMarker): Promise<RobotConnection | undefined> {
  const robots = s.live;
  if (!robots) return undefined;
  const bound = markerBoundRobot(marker);
  const match = profileNamed(robots.list(), bound.name);
  if (match) return ensureConnected(s, robots, match.profile.name);
  if (bound.pinned) {
    const pick = await vscode.window.showWarningMessage(
      `${marker.name} is bound to controller "${bound.name}", but no robot profile of that name exists. Add it in the Controllers view.`,
      'Open Controllers');
    if (pick) await vscode.commands.executeCommand('robotCode.live.focusView');
    return undefined;
  }
  return pickRobot(s, robots, `"${marker.name}" matches no robot profile. Read from which robot?`);
}

/** Connect a configured robot if it is not already, and return it only when the link is up. */
async function ensureConnected(s: Services, robots: RobotManager, name: string): Promise<RobotConnection | undefined> {
  const c = robots.get(name);
  if (c?.state === 'connected') return c;
  await vscode.commands.executeCommand('robotCode.live.connect', name);
  const after = robots.get(name);
  return after?.state === 'connected' ? after : undefined;
}

/** The fallback picker, for a file in no container (or one that names no known robot). */
async function pickRobot(s: Services, robots: RobotManager, placeHolder: string): Promise<RobotConnection | undefined> {
  const all = robots.list();
  if (!all.length) { vscode.window.showInformationMessage('No robots configured. Add one in the Controllers view.'); return undefined; }
  const isConnected = (name: string) => robots.get(name)?.state === 'connected';
  const pick = await vscode.window.showQuickPick(
    all.map(c => ({
      label: isConnected(c.profile.name) ? `$(check) ${c.profile.name}` : `$(plug) Connect to ${c.profile.name}`,
      description: `${c.profile.host} · ${c.state}`,
      name: c.profile.name,
    })).sort((a, b) => Number(isConnected(b.name)) - Number(isConnected(a.name))),
    { placeHolder });
  if (!pick) return undefined;
  return ensureConnected(s, robots, pick.name);
}

async function refreshAfterSync(s: Services): Promise<void> {
  await Promise.all([s.data.refresh(), s.index.refresh()]);
}

// ── fetch ───────────────────────────────────────────────────────────────────

async function fetchFileCommand(s: Services, arg?: unknown): Promise<void> {
  const target = resolve(s, arg);
  if (!target?.fileName) { vscode.window.showInformationMessage('Open a working program or data file, or pick a snapshot file.'); return; }
  const conn = await robotForMarker(s, target.marker);
  if (!conn) return;
  const res = await withContainerLock(target.marker, () => vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Fetching ${target.fileName} from ${conn.profile.name}` },
    () => fetchFileFromRobot(s, target.marker, conn, target.fileName!)));
  if (!res.ok) { vscode.window.showWarningMessage(`Could not fetch ${target.fileName} from ${conn.profile.name}: ${res.error ?? 'not on the controller'}`); return; }
  await refreshAfterSync(s);
  vscode.window.setStatusBarMessage(`$(cloud-download) Snapshot: ${target.fileName} fetched${res.changed ? ' (changed)' : ''} · just now`, 6000);
}

async function fetchMatching(s: Services, marker: RobotMarker, conn: RobotConnection, test: (name: string) => boolean, what: string): Promise<void> {
  const live = s.live;
  if (!live) return;
  let listing;
  try {
    listing = await live.listFiles(conn.profile);
  } catch (e: unknown) {
    vscode.window.showWarningMessage(`Could not list ${conn.profile.device} on ${conn.profile.name}: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  const names = listing.filter(f => !f.isDir && test(f.name)).map(f => f.name);
  if (!names.length) { vscode.window.showInformationMessage(`Nothing to fetch (${what}) from ${conn.profile.name}.`); return; }
  const outcome = await withContainerLock(marker, () => live.withTransfer(conn.profile.name, () => vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Fetching ${what} from ${conn.profile.name}`, cancellable: true },
    (progress, token) => {
      const ac = new AbortController();
      token.onCancellationRequested(() => ac.abort());
      progress.report({ message: `0/${names.length}` });
      return fetchFilesFromRobot(s, marker, conn, names, {
        onFile: (done, total, name) => progress.report({ increment: 100 / total, message: `${done}/${total} · ${name}` }),
        isCancelled: () => token.isCancellationRequested,
        signal: ac.signal,
      });
    })));
  await refreshAfterSync(s);
  reportOutcome(s, marker, conn, outcome, what);
}

/**
 * Fetch - incremental: update the snapshot from the controller, never the working copy. The
 * user picks what to advance from a multi-select (TP/KAREL source, compiled, data, I/O); the
 * heavyweight, controller-tied overwrite is `robotCode.data.snapshotFromRobot`, on the
 * Controllers side. Every category ticked (the default) is "everything listed".
 */
async function fetchChooseCommand(s: Services, arg?: unknown): Promise<void> {
  const marker = await resolveMarker(s, arg);
  if (!marker) return;
  const conn = await robotForMarker(s, marker);
  if (!conn) return;
  const picks = await vscode.window.showQuickPick(
    FETCH_CHOICES.map(c => ({ label: c.label, description: c.description, picked: true, test: c.test })),
    { canPickMany: true, placeHolder: `What to fetch from ${conn.profile.name} into ${marker.name}'s snapshot`, matchOnDescription: true });
  if (!picks?.length) return;
  const tests = picks.map(p => p.test);
  const what = picks.length === FETCH_CHOICES.length ? 'everything listed' : picks.map(p => p.label).join(', ');
  await fetchMatching(s, marker, conn, n => tests.some(t => t(n)), what);
}

/** What a Fetch… choice matches on the controller's own listing. */
export interface FetchChoice { label: string; description: string; test: (name: string) => boolean }

export const FETCH_CHOICES: readonly FetchChoice[] = [
  { label: 'TP programs', description: '.ls - editable TP source', test: n => /\.ls$/i.test(n) },
  { label: 'KAREL programs', description: '.kl - editable KAREL source', test: n => /\.kl$/i.test(n) },
  { label: 'Compiled programs', description: '.tp / .pc - controller bytecode', test: n => /\.(tp|pc)$/i.test(n) },
  { label: 'Register & position data', description: '.va - registers, positions, macros, frames', test: n => /\.va$/i.test(n) },
  { label: 'I/O', description: '.io and IOSTATE.DG - I/O configuration and state', test: n => /\.io$/i.test(n) || n.toLowerCase() === 'iostate.dg' },
];

function reportOutcome(s: Services, marker: RobotMarker, conn: RobotConnection, outcome: FetchOutcome, what: string): void {
  const bits = [`${outcome.ok} file${outcome.ok === 1 ? '' : 's'}`];
  if (outcome.changed) bits.push(`${outcome.changed} changed`);
  if (outcome.failed) bits.push(`${outcome.failed} failed`);
  vscode.window.setStatusBarMessage(`$(cloud-download) Snapshot ${marker.name}: ${what} fetched · ${bits.join(' · ')}`, 8000);
  s.output.appendLine(`[Robot Code] snapshot fetch ${marker.name} (${conn.profile.name}): ${bits.join(', ')}${outcome.errors.length ? `\n  ${outcome.errors.join('\n  ')}` : ''}`);
  if (outcome.failed) void vscode.window.showWarningMessage(`${outcome.failed} file(s) could not be fetched from ${conn.profile.name}. See the Robot Code output.`, 'Open Output').then(p => { if (p) s.output.show(true); });
}

// ── folder-scoped fetch / pull (right-click a folder) ───────────────────────

/** Where a folder action is scoped: an explicit directory, a set of names, or a scope. */
interface FolderScope {
  marker: RobotMarker;
  dir?: string;
  names?: string[];
  scope?: 'programs' | 'data' | 'all';
  label: string;
}

/** The upper-cased file names of the snapshot entries under a directory prefix. */
function entryNamesUnder(entries: Array<{ rel: string }>, prefix: string): string[] {
  return snapshotNamesUnder(entries, prefix);
}

/** The folder a command was invoked on: a real Uri, or a tree node that stands for one. */
function resolveFolderScope(s: Services, arg?: unknown): FolderScope | undefined {
  const node = arg as SyncNode | undefined;
  if (node?.marker) {
    if (node.type === 'dir' && node.prefix !== undefined) return { marker: node.marker, names: entryNamesUnder(node.entries ?? [], node.prefix), label: path.basename(node.prefix) || node.marker.name };
    if (node.type === 'scope' && node.scope) return { marker: node.marker, scope: node.scope === 'programs' ? 'programs' : node.scope === 'data' ? 'data' : 'all', label: node.scope === 'programs' ? 'Programs' : node.scope === 'data' ? 'Data & I/O' : 'All files' };
    return { marker: node.marker, dir: node.marker.root, label: node.marker.name };
  }
  // a Programs / PC tree robot folder: { type: 'robot', group, programs }
  if (node?.type === 'robot' && node.group) {
    const marker = s.containers.markerOf(node.group);
    if (marker) return { marker, dir: node.group, label: path.basename(node.group) || node.group };
  }
  const uri = argUri(arg);
  if (uri && uri.scheme === 'file') {
    const marker = s.containers.markerOf(uri.fsPath);
    if (marker) return { marker, dir: uri.fsPath, label: path.basename(uri.fsPath) || uri.fsPath };
  }
  return undefined;
}

/** The working program/data files at or under a directory, keyed by upper-cased file name. */
function localFilesUnder(s: Services, marker: RobotMarker, dir?: string): { names: Set<string>; paths: Map<string, string> } {
  const names = new Set<string>(), paths = new Map<string, string>();
  const walk = (d: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const fp = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name === '.robocode-robot' || e.name === '.git' || e.name === 'node_modules') continue; walk(fp); continue; }
      if (!e.isFile() || !(isSnapshotProgramFile(e.name) || isSnapshotDataFile(e.name))) continue;
      if (s.containers.classify(fp) !== 'working') continue;
      const key = e.name.toUpperCase();
      names.add(key);
      if (!paths.has(key)) paths.set(key, fp);
    }
  };
  if (dir) walk(dir);
  else for (const d of (marker.programDirs?.length ? marker.programDirs : [marker.root])) walk(d);
  return { names, paths };
}

/**
 * Fetch - and, with `pull`, overwrite - every file at or under a folder. The controller's own
 * listing decides the names, so a file the robot does not have is never invented and an explicit
 * folder never reaches beyond it. A pull records the robot copy in the snapshot first, then writes
 * it over the working file (undoable while the file is open).
 */
async function folderCommand(s: Services, arg: unknown, pull: boolean): Promise<void> {
  const scope = resolveFolderScope(s, arg);
  if (!scope) { vscode.window.showInformationMessage('Right-click a folder inside a robot container.'); return; }
  const conn = await robotForMarker(s, scope.marker);
  if (!conn) return;
  const live = s.live;
  if (!live) return;
  let listing;
  try { listing = await live.listFiles(conn.profile); }
  catch (e: unknown) { vscode.window.showWarningMessage(`Could not list ${conn.profile.device} on ${conn.profile.name}: ${e instanceof Error ? e.message : String(e)}`); return; }
  const files = listing.filter(f => !f.isDir);
  const local = localFilesUnder(s, scope.marker, scope.scope ? undefined : scope.dir);
  let names: string[];
  if (scope.scope) {
    const predicate = scope.scope === 'programs' ? isSnapshotProgramFile : scope.scope === 'data' ? isSnapshotDataFile : () => true;
    names = files.filter(f => predicate(f.name)).map(f => f.name);
  } else if (scope.names) {
    const want = new Set(scope.names);
    names = files.filter(f => want.has(f.name.toUpperCase())).map(f => f.name);
  } else {
    names = files.filter(f => local.names.has(f.name.toUpperCase())).map(f => f.name);
  }
  if (!names.length) { vscode.window.showInformationMessage(`Nothing to ${pull ? 'pull' : 'fetch'} under ${scope.label} from ${conn.profile.name}.`); return; }
  if (pull) {
    const count = names.filter(n => local.paths.has(n.toUpperCase()) && !isCompiledProgram(n)).length;
    const ok = await vscode.window.showWarningMessage(
      `Pull ${count} file(s) under "${scope.label}" from ${conn.profile.name}?`,
      { modal: true, detail: 'The snapshot is updated first, then your working files are replaced by the controller copies. An open file can be undone with Ctrl+Z; git restores the rest.' },
      'Pull');
    if (ok !== 'Pull') return;
  }
  const verb = pull ? 'Pulling' : 'Fetching';
  const { outcome, pulled } = await withContainerLock(scope.marker, () => live.withTransfer(conn.profile.name, async () => {
    const out = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `${verb} ${scope.label} from ${conn.profile.name}`, cancellable: true },
      (progress, token) => {
        const ac = new AbortController();
        token.onCancellationRequested(() => ac.abort());
        progress.report({ message: `0/${names.length}` });
        return fetchFilesFromRobot(s, scope.marker, conn, names, {
          onFile: (done, total, name) => progress.report({ increment: 100 / total, message: `${done}/${total} · ${name}` }),
          isCancelled: () => token.isCancellationRequested,
          signal: ac.signal,
        });
      });
    let written = 0;
    if (pull) {
      const targets = names.filter(n => !isCompiledProgram(n) && local.paths.has(n.toUpperCase()));
      if (targets.length) await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Writing ${targets.length} file(s) under "${scope.label}"`, cancellable: true },
        async (progress, token) => {
          for (const name of targets) {
            if (token.isCancellationRequested) break;
            const dest = local.paths.get(name.toUpperCase());
            if (dest === undefined) continue;
            const snap = snapshotCopy(s, scope.marker, name);
            if (snap === undefined) continue;
            try { await writeWorkingCopy(vscode.Uri.file(dest), snap, '\n'); written++; } catch { /* the snapshot still advanced */ }
            progress.report({ increment: 100 / targets.length, message: `${written}/${targets.length} · ${name}` });
          }
        });
    }
    return { outcome: out, pulled: written };
  }));
  await refreshAfterSync(s);
  const bits = [`${outcome.ok} file${outcome.ok === 1 ? '' : 's'} fetched`];
  if (outcome.changed) bits.push(`${outcome.changed} changed`);
  if (pull) bits.push(`${pulled} written`);
  if (outcome.failed) bits.push(`${outcome.failed} failed`);
  vscode.window.setStatusBarMessage(`$(cloud-download) ${scope.label} · ${bits.join(' · ')} · ${conn.profile.name}`, 8000);
  s.output.appendLine(`[Robot Code] ${pull ? 'pull' : 'fetch'} ${scope.label} from ${conn.profile.name}: ${bits.join(', ')}${outcome.errors.length ? `\n  ${outcome.errors.join('\n  ')}` : ''}`);
  if (outcome.failed) void vscode.window.showWarningMessage(`${outcome.failed} file(s) could not be read from ${conn.profile.name}. See the Robot Code output.`, 'Open Output').then(p => { if (p) s.output.show(true); });
}

/**
 * The Sync view's one deliberate action: read every working program of a robot off the
 * controller and compare it to the snapshot verbatim. It only records the result (in the
 * per-file robot compare map) - it does not write the snapshot, so nothing changes on disk.
 * Fetching is what makes the robot side known; the view says "not compared" until then.
 */
async function fetchCompareAllCommand(s: Services, arg?: unknown): Promise<void> {
  const marker = await resolveMarker(s, arg);
  if (!marker) return;
  const conn = await robotForMarker(s, marker);
  if (!conn) return;
  const live = s.live;
  if (!live) return;
  const group = marker.root.toLowerCase();
  const working = s.index.list()
    .filter(p => p.group === group && !p.reference && isSnapshotProgramFile(path.basename(p.uri.fsPath)))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (!working.length) { vscode.window.showInformationMessage(`No working programs for ${marker.name} to compare.`); return; }
  const byName = new Map(working.map(p => [fileNameForUri(s, p.uri), p]));
  let compared = 0, differs = 0, failed = 0;
  await withContainerLock(marker, () => live.withTransfer(conn.profile.name, () => vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Comparing ${working.length} programs with ${conn.profile.name}`, cancellable: true },
    (progress, token) => {
      const ac = new AbortController();
      token.onCancellationRequested(() => ac.abort());
      return new Promise<void>(resolve => {
        void live.readBinaryMany(conn.profile, [...byName.keys()], conn.profile.device, (name, result) => {
        const info = byName.get(name);
        if (!info) return;
        if (!('data' in result)) { failed++; return; }
        const snap = snapshotCopy(s, marker, name);
        if (snap === undefined) return;
        const robotText = Buffer.from(result.data).toString('latin1');
        // representation-matched: a `.ls` is compared as source text, a compiled `.tp`/`.pc`
        // only byte-for-byte (a boolean) - never a source against its compiled copy
        const d = isCompiledProgram(name)
          ? { same: robotText === snap, changed: 0, added: 0, deleted: 0, metadataOnly: false }
          : verbatimCompare(robotText, snap);
        compared++;
        if (!d.same) differs++;
        noteRobotCompare(info.uri.fsPath, { differs: !d.same, metadataOnly: d.metadataOnly, changed: d.changed + d.added + d.deleted });
        progress.report({ message: `${compared}/${byName.size}` });
      }, () => token.isCancellationRequested, ac.signal).then(() => resolve(), () => resolve());
      });
    })));
  comparedChanged.fire();
  const bits = [`${compared} compared`, differs ? `${differs} differ` : 'all match'];
  if (failed) bits.push(`${failed} failed`);
  vscode.window.setStatusBarMessage(`$(sync) ${marker.name}: ${bits.join(' · ')}`, 8000);
  if (failed) void vscode.window.showWarningMessage(`${failed} program(s) could not be read from ${conn.profile.name}. See the Robot Code output.`, 'Open Output').then(p => { if (p) s.output.show(true); });
}

// ── pull / revert ───────────────────────────────────────────────────────────

async function pullFileCommand(s: Services, arg?: unknown): Promise<void> {
  const target = resolve(s, arg);
  if (!target?.fileName) { vscode.window.showInformationMessage('Open a working program or data file, or pick a snapshot file.'); return; }
  const uri = target.workingUri ?? argUri(arg);
  if (!uri || uri.scheme !== 'file') { vscode.window.showInformationMessage('There is no working copy of that file to overwrite.'); return; }
  const conn = await robotForMarker(s, target.marker);
  if (!conn) return;
  const ok = await withContainerLock(target.marker, async () => {
    const res = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Pulling ${target.fileName} from ${conn.profile.name}` },
      () => fetchFileFromRobot(s, target.marker, conn, target.fileName!));
    if (!res.ok) { vscode.window.showWarningMessage(`Could not read ${target.fileName} from ${conn.profile.name}: ${res.error ?? 'not on the controller'}`); return false; }
    const snap = snapshotCopy(s, target.marker, target.fileName!);
    if (snap === undefined) { vscode.window.showWarningMessage(`The snapshot has no copy of ${target.fileName}.`); return false; }
    await writeWorkingCopy(uri, snap, '\n');
    return true;
  });
  if (!ok) return;
  await refreshAfterSync(s);
  vscode.window.setStatusBarMessage(`$(arrow-down) ${path.basename(uri.fsPath)} replaced with the snapshot copy from ${conn.profile.name} · Ctrl+Z undoes it`, 8000);
}

async function revertFileCommand(s: Services, arg?: unknown): Promise<void> {
  const target = resolve(s, arg);
  if (!target?.fileName) return;
  const uri = target.workingUri ?? argUri(arg);
  if (!uri || uri.scheme !== 'file') { vscode.window.showInformationMessage('There is no working copy to revert.'); return; }
  const snap = snapshotCopy(s, target.marker, target.fileName);
  if (snap === undefined) { vscode.window.showInformationMessage(`The snapshot has no copy of ${target.fileName}.`); return; }
  const ok = await vscode.window.showWarningMessage(`Revert ${path.basename(uri.fsPath)} from the snapshot?`, { modal: true, detail: 'Your working changes are replaced by the snapshot copy. Ctrl+Z (or git) restores them.' }, 'Revert');
  if (ok !== 'Revert') return;
  await withContainerLock(target.marker, () => revertFromSnapshot(s, target.marker, target.fileName!, uri));
  vscode.window.setStatusBarMessage(`$(discard) ${path.basename(uri.fsPath)} reverted from the snapshot`, 6000);
}

// ── pull a snapshot-only file into the working folders ──────────────────────

/**
 * The working path a snapshot file should be copied into: the marker's one program folder, a
 * pick when there are several, or the robot root when none are declared. Returns undefined when
 * the user cancels or a file of that name is already there (offering to open it).
 */
async function chooseWorkingDest(marker: RobotMarker, fileName: string): Promise<string | undefined> {
  const dirs = marker.programDirs?.length ? marker.programDirs : [marker.root];
  let destDir: string;
  if (dirs.length === 1) destDir = dirs[0];
  else {
    const pick = await vscode.window.showQuickPick(
      dirs.map(d => ({ label: path.basename(d) || d, description: vscode.workspace.asRelativePath(d, false), dir: d })),
      { placeHolder: `Pull ${fileName} into which working folder?` });
    if (!pick) return undefined;
    destDir = pick.dir;
  }
  const dest = path.join(destDir, fileName);
  if (fs.existsSync(dest)) {
    const pick = await vscode.window.showInformationMessage(`${path.basename(dest)} is already in ${path.basename(destDir)}.`, 'Open It');
    if (pick === 'Open It') { suppressSyncPrompt(vscode.Uri.file(dest)); await vscode.window.showTextDocument(vscode.Uri.file(dest), { preview: true }); }
    return undefined;
  }
  return dest;
}

/**
 * Bring a file that exists only in the snapshot into a working folder: the snapshot copy is
 * copied out (never moved or edited), so the index stays authoritative. Refuses to overwrite a
 * working file of the same name - it offers to open that one instead.
 */
async function pullToWorkingCommand(s: Services, arg?: unknown): Promise<void> {
  const target = resolve(s, arg);
  if (!target?.marker) { vscode.window.showInformationMessage('Pick a snapshot file first.'); return; }
  const marker = target.marker;
  const src = findSnapshotFile(marker.snapshotDir, target.relPath ?? target.fileName ?? '');
  if (!src) { vscode.window.showWarningMessage(`The snapshot has no copy of ${target.fileName ?? 'that file'}.`); return; }
  const dest = await chooseWorkingDest(marker, path.basename(src));
  if (!dest) return;
  try {
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    await fs.promises.copyFile(src, dest);
  } catch (e: unknown) {
    void showRecoverableError(`Could not pull ${path.basename(src)} into the working folders: ${e instanceof Error ? e.message : String(e)}`, s.output, () => pullToWorkingCommand(s, arg));
    return;
  }
  await refreshAfterSync(s);
  suppressSyncPrompt(vscode.Uri.file(dest));
  await vscode.window.showTextDocument(vscode.Uri.file(dest), { preview: false });
  vscode.window.setStatusBarMessage(`$(cloud-download) ${path.basename(dest)} pulled from the snapshot into ${path.basename(path.dirname(dest))}`, 6000);
}

// ── compare ─────────────────────────────────────────────────────────────────

/**
 * Compare the working copy against the snapshot (normalized for programs, verbatim for data).
 * If the file's own robot is connected, offer to bring the snapshot up to date first, so the
 * diff is against what the controller holds now. Never blocks: with no robot, it compares
 * against the snapshot already on disk.
 */
async function compareFileCommand(s: Services, arg?: unknown): Promise<void> {
  const target = resolve(s, arg);
  if (!target?.fileName) { vscode.window.showInformationMessage('Open a working program or data file, or pick a snapshot file.'); return; }
  const uri = target.workingUri ?? argUri(arg);
  if (!uri || uri.scheme !== 'file') { vscode.window.showInformationMessage('There is no working copy of that file to compare.'); return; }
  const conn = connectedRobotFor(s, target.marker);
  if (conn) {
    const pick = await vscode.window.showInformationMessage(
      `Update the snapshot of ${target.fileName} from ${conn.profile.name} before comparing?`,
      'Update & Compare', 'Compare Only');
    if (!pick) return;
    if (pick === 'Update & Compare') {
      const res = await withContainerLock(target.marker, () => vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Fetching ${target.fileName} from ${conn.profile.name}` },
        () => fetchFileFromRobot(s, target.marker, conn, target.fileName!)));
      if (!res.ok) vscode.window.showWarningMessage(`Could not read ${target.fileName} from ${conn.profile.name}: ${res.error ?? 'not on the controller'}. Comparing against the current snapshot.`);
      else await refreshAfterSync(s);
    }
  }
  await vscode.commands.executeCommand('robotCode.sync.diffOpen', uri);
}

/** The already-connected robot a marker's container is bound to, if any (never connects). */
function connectedRobotFor(s: Services, marker: RobotMarker): RobotConnection | undefined {
  const names = [marker.controller, marker.name].filter((x): x is string => !!x).map(x => x.toLowerCase());
  return s.live?.connected().find(c => names.includes(c.profile.name.toLowerCase()));
}

/**
 * The status bar's click: open the snapshot diff for whatever is open, indexed program (the
 * normalized diff) or data file (verbatim). `containers.diffWithSnapshot` only understands
 * indexed programs, so a data file used to answer "not indexed as a program" on click.
 */
async function diffOpenCommand(s: Services, arg?: unknown): Promise<void> {
  const node = arg as SyncNode | undefined;
  const uri = node?.info?.uri ?? argUri(arg);
  if (!uri || uri.scheme !== 'file') { vscode.window.showInformationMessage('Open a working file first.'); return; }
  if (s.index.forUri(uri)) { await vscode.commands.executeCommand('robotCode.containers.diffWithSnapshot', uri); return; }
  const marker = s.containers.markerOf(uri.fsPath);
  if (!marker) { vscode.window.showInformationMessage('That file is not in a robot container.'); return; }
  const rel = path.relative(marker.snapshotDir, uri.fsPath);
  const snap = findSnapshotFile(marker.snapshotDir, rel);
  if (!snap) { vscode.window.showInformationMessage(`The snapshot has no copy of ${path.basename(uri.fsPath)}.`); return; }
  await vscode.commands.executeCommand('vscode.diff', vscode.Uri.file(snap), uri, `${path.basename(uri.fsPath)}: snapshot ⟷ working`);
}

// ── history ─────────────────────────────────────────────────────────────────

async function historyCommand(s: Services, arg?: unknown): Promise<void> {
  const target = resolve(s, arg);
  if (!target?.fileName) return;
  const fileName = target.fileName;
  const entries = listSnapshotHistory(target.marker.root, target.relPath ?? fileName, fileName);
  if (!entries.length) { vscode.window.showInformationMessage(`No snapshot history for ${fileName} yet.`); return; }
  const pick = await vscode.window.showQuickPick(
    entries.map(e => {
      let detail = '';
      try { const st = fs.statSync(e.abs); detail = `${st.size} B · ${new Date(st.mtimeMs).toLocaleString()}`; } catch { /* unreadable */ }
      return { label: e.stamp, description: path.basename(e.abs), detail, abs: e.abs };
    }),
    { placeHolder: `Snapshot history of ${fileName} — newest first`, matchOnDescription: true, matchOnDetail: true });
  if (!pick) return;
  const action = await vscode.window.showQuickPick(
    [
      { label: '$(diff) Diff against the working copy', value: 'diff' },
      { label: '$(go-to-file) Open this version', value: 'open' },
      { label: '$(discard) Restore into the working copy…', value: 'restore' },
    ],
    { placeHolder: `${fileName} @ ${pick.label}` });
  if (!action) return;
  if (action.value === 'open') { await vscode.window.showTextDocument(vscode.Uri.file(pick.abs), { preview: true }); return; }
  if (action.value === 'diff') {
    if (!target.workingUri) { vscode.window.showInformationMessage(`There is no working copy of ${fileName} to diff against.`); return; }
    await vscode.commands.executeCommand('vscode.diff', vscode.Uri.file(pick.abs), target.workingUri, `${fileName}: history ${pick.label} ⟷ working`);
    return;
  }
  const ok = await vscode.window.showWarningMessage(
    `Restore ${fileName} from the snapshot history @ ${pick.label}?`,
    { modal: true, detail: 'The working copy is replaced by that version. Ctrl+Z (or git) restores it.' },
    'Restore');
  if (ok !== 'Restore') return;
  if (target.workingUri) {
    await writeWorkingCopy(target.workingUri, fs.readFileSync(pick.abs, 'latin1'), '\n');
  } else {
    const dest = await chooseWorkingDest(target.marker, fileName);
    if (!dest) return;
    try {
      await fs.promises.mkdir(path.dirname(dest), { recursive: true });
      await fs.promises.copyFile(pick.abs, dest);
    } catch (e: unknown) {
      void showRecoverableError(`Could not restore ${fileName}: ${e instanceof Error ? e.message : String(e)}`, s.output, () => historyCommand(s, arg));
      return;
    }
    suppressSyncPrompt(vscode.Uri.file(dest));
    await vscode.window.showTextDocument(vscode.Uri.file(dest), { preview: false });
  }
  await refreshAfterSync(s);
  vscode.window.setStatusBarMessage(`$(history) ${fileName} restored from snapshot history @ ${pick.label} · Ctrl+Z undoes it`, 8000);
}

// ── controller errors (also used by a failed push) ──────────────────────────

/**
 * Read the controller's current errors over HTTP: ERRCURR.LS first, ERRALL.LS as a fallback.
 * Only meaningful while the extension can read the device; returns [] when it cannot.
 */
export async function fetchControllerErrors(s: Services, conn: RobotConnection): Promise<AlarmEntry[]> {
  const live = s.live;
  if (!live) return [];
  for (const file of ['ERRCURR.LS', 'ERRALL.LS']) {
    try {
      const text = await live.readText(conn.profile, file);
      const alarms = parseAlarms(text);
      if (alarms.length) return alarms.slice(-8).reverse();
    } catch { /* try the next file */ }
  }
  return [];
}

async function errorsCommand(s: Services, arg?: unknown): Promise<void> {
  const marker = markerOf(s, arg);
  const conn = marker ? await robotForMarker(s, marker) : (s.live?.connected()[0]);
  if (!conn) { vscode.window.showInformationMessage('Connect a robot first.'); return; }
  const alarms = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: `Reading errors from ${conn.profile.name}` },
    () => fetchControllerErrors(s, conn));
  if (!alarms.length) { vscode.window.showInformationMessage(`No controller errors read from ${conn.profile.name}.`); return; }
  s.output.appendLine(`[Robot Code] ${conn.profile.name} errors:\n  ${alarms.map(a => `${a.time} ${a.code ?? ''} ${a.message}`).join('\n  ')}`);
  const pick = await vscode.window.showWarningMessage(`${alarms.length} controller error(s) on ${conn.profile.name}: ${alarms[0].message}`, 'Open Output', 'Error Watcher in RUKUS');
  if (pick === 'Open Output') s.output.show(true);
  if (pick === 'Error Watcher in RUKUS') await vscode.commands.executeCommand('robotCode.rukus.alarms', conn.profile.name);
}

// ── fetch-on-open prompt ────────────────────────────────────────────────────

/** Files already offered this session: a prompt is a nudge, not a nag. */
const promptedOnOpen = new Set<string>();

/** Do not offer a fetch when the container's snapshot was taken this recently (5 minutes). */
const OPEN_PROMPT_BUFFER_MS = 5 * 60 * 1000;

/** Stop the open-prompt firing for a file we are about to open ourselves. */
export function suppressSyncPrompt(uri: vscode.Uri): void { promptedOnOpen.add(uri.toString()); }

/**
 * Offer to fetch a program from its controller when it is opened. The file's bound robot is
 * connected first - that is the point, it is the robot the program belongs to - and the fetch
 * only advances the snapshot; the working copy is never touched. Silenced per file per session
 * (so alt-tabbing does not re-ask) and by `robotCode.sync.promptOnOpen`.
 */
export function registerSyncOnOpen(ctx: vscode.ExtensionContext, s: Services): void {
  const offer = async (): Promise<void> => {
    const ed = vscode.window.activeTextEditor;
    if (!ed || ed.document.uri.scheme !== 'file') return;
    // the working side of a diff is not an "opening" - never prompt while diffing
    if (vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputTextDiff) return;
    if (!robotConnectionsEnabled() || !config<boolean>('sync.promptOnOpen', true)) return;
    const marker = markerForDocument(s, ed.document);
    if (!marker) return;
    const info = s.index.forUri(ed.document.uri);
    if (!info || info.reference) return;   // programs only, and never a snapshot copy
    // a container fetched in the last few minutes is fresh enough; do not nag on every open
    if (snapshotFetchedWithin(s.containers.snapshotInfo(marker.root)?.updatedAt, OPEN_PROMPT_BUFFER_MS)) return;
    const key = ed.document.uri.toString();
    if (promptedOnOpen.has(key)) return;
    const robots = s.live;
    if (!robots) return;
    const match = profileNamed(robots.list(), markerBoundRobot(marker).name);
    if (!match) return;   // nothing configured for this container: stay quiet
    promptedOnOpen.add(key);
    const conn = await ensureConnected(s, robots, match.profile.name);
    if (!conn) return;    // could not reach it - do not turn a missing robot into a modal
    const name = info.name;
    const pick = await vscode.window.showInformationMessage(
      `Fetch the newest copy of ${name} from ${conn.profile.name}?`,
      'Fetch', 'Not Now', "Don't Ask Again");
    if (pick === "Don't Ask Again") { await vscode.workspace.getConfiguration('robotCode').update('sync.promptOnOpen', false, vscode.ConfigurationTarget.Global); return; }
    if (pick !== 'Fetch') return;
    const res = await withContainerLock(marker, () => vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Fetching ${name} from ${conn.profile.name}` },
      () => fetchFileFromRobot(s, marker, conn, fileNameForUri(s, ed.document.uri))));
    if (!res.ok) { vscode.window.showWarningMessage(`Could not fetch ${name} from ${conn.profile.name}: ${res.error ?? 'not on the controller'}`); return; }
    await refreshAfterSync(s);
    vscode.window.setStatusBarMessage(`$(cloud-download) Snapshot: ${name} fetched${res.changed ? ' (changed)' : ''} from ${conn.profile.name}`, 6000);
  };
  ctx.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(() => { void offer(); }));
}
