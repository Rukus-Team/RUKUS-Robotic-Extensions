/**
 * The snapshot sync operations behind `robotCode.sync.*`, git-shaped:
 *
 *   working folders = working tree · snapshot/ = index (last known robot state)
 *   robot = remote · backups = remote history
 *
 * The snapshot only ever advances FROM the robot (fetch). The working copy is only ever
 * overwritten by an explicit pull/restore. A push never overwrites robot changes the
 * snapshot has not seen (see the verbatim gate in `live/editorCommands.ts`).
 *
 * Everything here is intentionally vscode-light: reading/writing files on disk through
 * `robotContainers`, and talking to a controller through the `RobotManager`.
 */
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Services } from './services';
import type { RobotConnection } from './live/robotManager';
import type { ProgramInfo } from './workspaceIndex';
import { config } from './util';
import { brandForFile } from './brand';
import {
  readSnapshotFile, writeSnapshotFile, pushSnapshotFileToHistory,
  pruneSnapshotHistory, listSnapshotFiles, snapshotRelKey, readProvenance, writeProvenance,
  verbatimCompare, readSnapshotProgram, roundTripCompare, findSnapshotProgram, isCompiledProgram,
  pairedProgramName, type VerbatimDiff, type RobotMarker, type SnapshotProvenance,
} from './robotContainers';
import { snapshotRefFor } from './containerCompare';

// ── state of the open file against its snapshot ─────────────────────────────

export type SyncStateName = 'same' | 'modified' | 'not-in-snapshot' | 'compiled' | 'no-container';

export interface SyncState {
  marker: RobotMarker;
  /** what the working copy is against the snapshot, normalised (line numbers ignored) */
  state: SyncStateName;
  /** snapshot date, YYYY-MM-DD */
  date?: string;
  /** when the snapshot copy of this file was fetched, ms */
  ageMs?: number;
  /** normalized differing lines (modified only) */
  lines?: number;
  approximate?: boolean;
  /** last time the robot's copy was compared verbatim, if it has been */
  robot?: { at: number; differs: boolean; metadataOnly?: boolean; changed?: number };
}

export { noteRobotCompare, robotCompareOf, clearRobotCompare } from './robotCompare';
import { noteRobotCompare, robotCompareOf, clearRobotCompare } from './robotCompare';

/**
 * The per-container serialisation lives in `syncLock` (pure, unit-tested); re-exported here so
 * the sync surfaces share one queue with the push path.
 */
export { withSyncLock, withContainerLock, pullAfterPushDecision } from './syncLock';
export type { PullAfterPush, PullDecision } from './syncLock';
import { pullAfterPushDecision, type PullAfterPush, type PullDecision } from './syncLock';

/** Fired when a robot↔snapshot compare is recorded, so the Sync view can refresh. */
export const comparedChanged = new vscode.EventEmitter<void>();

/** The marker covering an open document, when it is a working file in a container. */
export function markerForDocument(s: Services, doc: vscode.TextDocument): RobotMarker | undefined {
  if (doc.uri.scheme !== 'file') return undefined;
  if (s.containers.classify(doc.uri.fsPath) !== 'working') return undefined;
  return s.containers.markerOf(doc.uri.fsPath);
}

/**
 * The working file's state against its snapshot copy, for the status bar and CodeLens.
 * Uses the index's normalized status when the file is an indexed program; for a data file
 * it falls back to a verbatim compare of the snapshot copy with the working copy.
 */
export function syncStateOf(s: Services, uri: vscode.Uri): SyncState | undefined {
  const marker = uri.scheme === 'file' ? s.containers.markerOf(uri.fsPath) : undefined;
  if (!marker || s.containers.classify(uri.fsPath) !== 'working') return undefined;
  const info = s.index.forUri(uri);
  const date = s.containers.snapshotInfo(marker.root)?.date.slice(0, 10);
  const robot = robotCompareOf(uri.fsPath);

  if (info) {
    // a compiled working copy has no text to compare; byte compare is on demand
    if (isCompiledProgram(info.uri.fsPath)) return { marker, state: 'compiled', date, robot };
    const ref = snapshotRefFor(s.index.all(info.name), info);
    if (ref && ref.textHash !== undefined) {
      const ageMs = snapshotCopyAge(s, marker, ref.uri.fsPath);
      if (info.textHash === undefined || ref.textHash === info.textHash) {
        return { marker, state: 'same', date, ageMs, robot };
      }
      // the line count itself is done by containerCompare.snapshotStatus at the call sites that
      // already have the normalized texts; here we only need the state and the age
      return { marker, state: 'modified', date, ageMs, robot };
    }
    // not indexed, or the only reference is a compiled binary: read the snapshot SOURCE copy
    // from disk (never a compiled .tp/.pc) so a container still reads correctly when the
    // reference copy was never indexed (see readSnapshotProgram)
    const disk = readSnapshotProgram(marker.snapshotDir, info.name, info.kind === 'karel' ? 'karel' : 'tp');
    if (!disk) {
      // a compiled copy still means the program is known, just not comparable as text
      return findSnapshotProgram(marker.snapshotDir, info.name)
        ? { marker, state: 'compiled', date, robot }
        : { marker, state: 'not-in-snapshot', date, robot };
    }
    const ageMs = snapshotCopyAge(s, marker, disk.path);
    if (info.textHash === undefined || disk.textHash === info.textHash) return { marker, state: 'same', date, ageMs, robot };
    return { marker, state: 'modified', date, ageMs, robot };
  }

  // a data file: no index entry, so compare verbatim against the snapshot copy
  const rel = path.relative(marker.snapshotDir, uri.fsPath);
  const snap = readSnapshotFile(marker.snapshotDir, rel);
  if (snap === undefined) return { marker, state: 'not-in-snapshot', date, robot };
  let working = '';
  try { working = fs.readFileSync(uri.fsPath, 'latin1'); } catch { /* unreadable */ }
  const ageMs = snapshotCopyAge(s, marker, uri.fsPath);
  return { marker, state: snap === working ? 'same' : 'modified', date, ageMs, robot };
}

function snapshotCopyAge(s: Services, marker: RobotMarker, abs: string): number | undefined {
  const rel = path.relative(marker.snapshotDir, abs);
  const prov = s.containers.snapshotInfo(marker.root);
  const iso = prov?.files?.[snapshotRelKey(rel)];
  const t = iso ? Date.parse(iso) : NaN;
  if (Number.isFinite(t)) return t;
  try { return fs.statSync(abs).mtimeMs; } catch { return undefined; }
}

// ── resolving what a sync command acts on ───────────────────────────────────

export interface SyncTarget {
  marker: RobotMarker;
  /** the file's name on the device, upper-cased (FANUC style) */
  fileName: string;
  /** the snapshot-relative path when known (a tree row), else undefined */
  relPath?: string;
  /** the matching working file, if there is one */
  working?: ProgramInfo;
  /** the open document for the working file, if it is open */
  doc?: vscode.TextDocument;
}

/** The program name from a document: its /PROG name, else its file stem. */
export function fileNameForUri(_s: Services, uri: vscode.Uri): string {
  const ext = path.extname(uri.fsPath);
  const stem = path.basename(uri.fsPath, ext);
  // A TP program is stored on the controller under its /PROG name; the brand reads that name
  // (core does not parse programs itself).
  const brand = brandForFile(uri.fsPath);
  if (brand) {
    try {
      const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
      const facts = doc ? brand.indexProgram(uri.fsPath, doc.getText()) : undefined;
      if (facts?.kind === 'tp' && facts.name) return `${facts.name.toUpperCase()}${ext.toUpperCase()}`;
    } catch { /* fall through to the file name */ }
  }
  return (stem + ext).toUpperCase();
}

/** The working program of the same name in a marker's group, if any. */
export function workingFileFor(s: Services, marker: RobotMarker, fileName: string): ProgramInfo | undefined {
  const stem = path.basename(fileName).replace(/\.[^.]+$/, '').toUpperCase();
  const group = marker.root.toLowerCase();
  return s.index.list().find(p => p.group === group && !p.reference && p.name === stem);
}

/** Build a sync target from a document (editor context). */
export function targetFromUri(s: Services, uri: vscode.Uri): SyncTarget | undefined {
  const marker = uri.scheme === 'file' ? s.containers.markerOf(uri.fsPath) : undefined;
  if (!marker) return undefined;
  const fileName = fileNameForUri(s, uri);
  const working = workingFileFor(s, marker, fileName);
  const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
  return { marker, fileName, working, doc };
}

// ── writing into the snapshot ───────────────────────────────────────────────

/**
 * Write one file into the snapshot directory, keep the copy it replaces in the history,
 * and record the fetch time. This is the ONLY way snapshot files advance.
 */
export function recordSnapshotFile(s: Services, marker: RobotMarker, name: string, data: Uint8Array | string, at = new Date()): string {
  pushSnapshotFileToHistory(marker.root, marker.snapshotDir, name);
  const rel = writeSnapshotFile(marker.snapshotDir, name, data);
  const prov = readProvenance(marker.root) ?? defaultProvenance(marker, at);
  prov.files = prov.files ?? {};
  prov.files[snapshotRelKey(rel)] = at.toISOString();
  prov.updatedAt = at.toISOString();
  prov.fileCount = listSnapshotFiles(marker.snapshotDir).length;
  writeProvenance(marker.root, prov);
  pruneSnapshotHistory(marker.root, config<number>('containers.snapshotHistory', 50));
  return rel;
}

/** Stretch the snapshot history for every file the fetch is about to replace. */
export function recordSnapshotHistory(s: Services, marker: RobotMarker, names: string[]): void {
  for (const n of names) pushSnapshotFileToHistory(marker.root, marker.snapshotDir, n);
  pruneSnapshotHistory(marker.root, config<number>('containers.snapshotHistory', 50));
}

/** The snapshot's copy of a file, as text (latin1), or undefined. */
export function snapshotCopy(s: Services, marker: RobotMarker, name: string): string | undefined {
  return readSnapshotFile(marker.snapshotDir, name);
}

// ── fetching from the robot ─────────────────────────────────────────────────

export interface FetchOutcome {
  ok: number;
  failed: number;
  changed: number;
  /** device file names that failed, for the log */
  errors: string[];
}

/** Live progress for a multi-file fetch, so a folder read can show a bar and a file name. */
export interface FetchProgress {
  /** called after each file lands (or fails), 1-based `done` out of `total` */
  onFile?: (done: number, total: number, name: string) => void;
  /** stop reading further files (a cancelled progress bar); files already read are kept */
  isCancelled?: () => boolean;
  /** aborts the request in flight too, so a cancel closes our side promptly instead of leaving it hanging */
  signal?: AbortSignal;
}

/**
 * Pull the listed files from the controller into the snapshot, in place. A file that is the
 * same as the snapshot's copy is not written and does not touch the history; a changed one
 * is archived first. Returns what happened.
 */
export async function fetchFilesFromRobot(s: Services, marker: RobotMarker, conn: RobotConnection, deviceNames: string[], progress?: FetchProgress): Promise<FetchOutcome> {
  const live = s.live;
  if (!live) return { ok: 0, failed: 0, changed: 0, errors: ['no robot connection'] };
  const profile = conn.profile;
  const at = new Date();
  const out: FetchOutcome = { ok: 0, failed: 0, changed: 0, errors: [] };
  const archive = new Map<string, Uint8Array>();
  let done = 0;
  await live.readBinaryMany(profile, deviceNames, profile.device, (name, result) => {
    done++;
    if (!('data' in result)) { out.failed++; out.errors.push(`${name}: ${result.error}`); progress?.onFile?.(done, deviceNames.length, name); return; }
    const before = readSnapshotFile(marker.snapshotDir, name);
    const after = Buffer.from(result.data).toString('latin1');
    if (before !== undefined && before !== after) out.changed++;
    archive.set(name, result.data);
    out.ok++;
    progress?.onFile?.(done, deviceNames.length, name);
  }, progress?.isCancelled, progress?.signal);
  // write once, off the callback, so the history copy is of the pre-fetch file
  for (const [name, data] of archive) {
    pushSnapshotFileToHistory(marker.root, marker.snapshotDir, name);
    writeSnapshotFile(marker.snapshotDir, name, data);
    const prov = readProvenance(marker.root) ?? defaultProvenance(marker, at);
    prov.files = prov.files ?? {};
    prov.files[snapshotRelKey(name)] = at.toISOString();
    prov.updatedAt = at.toISOString();
    writeProvenance(marker.root, prov);
  }
  if (archive.size) {
    const prov = readProvenance(marker.root)!;
    prov.fileCount = listSnapshotFiles(marker.snapshotDir).length;
    writeProvenance(marker.root, prov);
    pruneSnapshotHistory(marker.root, config<number>('containers.snapshotHistory', 50));
  }
  return out;
}

/**
 * Single-file fetches in flight, keyed by container + device + file. A second fetch of the same
 * file (the Pull that follows a Fetch, say) reuses the read instead of asking the controller
 * again, so the robot is read once and both callers see the same result.
 */
const inFlightFetches = new Map<string, Promise<{ ok: boolean; changed: boolean; error?: string }>>();

/**
 * Read one file from the controller into the snapshot, and its paired representation too: a
 * fetch of `NAME.LS` also pulls `NAME.TP` (and `NAME.KL` ↔ `NAME.PC`), whichever one was asked
 * for, so the source and the compiled copy stay together in the snapshot. The partner is
 * best-effort: a controller that does not have it simply leaves the pair one-sided. Concurrent
 * fetches of the same file share the one read.
 */
export function fetchFileFromRobot(s: Services, marker: RobotMarker, conn: RobotConnection, fileName: string): Promise<{ ok: boolean; changed: boolean; error?: string }> {
  const key = `${marker.root.toLowerCase()}|${conn.profile.device.toLowerCase()}|${fileName.toUpperCase()}`;
  const existing = inFlightFetches.get(key);
  if (existing) return existing;
  const run = doFetchFileFromRobot(s, marker, conn, fileName).finally(() => inFlightFetches.delete(key));
  inFlightFetches.set(key, run);
  return run;
}

async function doFetchFileFromRobot(s: Services, marker: RobotMarker, conn: RobotConnection, fileName: string): Promise<{ ok: boolean; changed: boolean; error?: string }> {
  const live = s.live;
  if (!live) return { ok: false, changed: false, error: 'no robot connection' };
  let data: Uint8Array;
  try {
    data = await live.readBinary(conn.profile, fileName, conn.profile.device);
  } catch (e: unknown) {
    return { ok: false, changed: false, error: e instanceof Error ? e.message : String(e) };
  }
  const before = readSnapshotFile(marker.snapshotDir, fileName);
  const after = Buffer.from(data).toString('latin1');
  recordSnapshotFile(s, marker, fileName, data);
  // keep the pair: also record the compiled/source partner when the controller has it
  const partner = pairedProgramName(fileName);
  if (partner) {
    try {
      const pdata = await live.readBinary(conn.profile, partner, conn.profile.device);
      recordSnapshotFile(s, marker, partner, pdata);
    } catch { /* no partner on the controller: a source without its compiled copy, or vice versa */ }
  }
  return { ok: true, changed: before !== after };
}

function defaultProvenance(marker: RobotMarker, at: Date): SnapshotProvenance {
  return { date: at.toISOString(), source: { kind: 'robot', name: marker.name, host: '' }, fileCount: 0 };
}

// ── overwriting the working copy (pull / revert) ────────────────────────────

/**
 * Replace the working file with the given text in one undoable step: through the editor when
 * the file is open, else written straight to disk and the editor reloaded if it appears.
 */
export async function writeWorkingCopy(uri: vscode.Uri, text: string, eol: '\n' | '\r\n', opts: { preserveFocus?: boolean } = {}): Promise<void> {
  const open = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
  const normalised = text.replace(/\r\n?/g, eol);
  if (open) {
    const editor = await vscode.window.showTextDocument(open, { preserveFocus: !!opts.preserveFocus });
    const whole = new vscode.Range(0, 0, open.lineCount, 0);
    await editor.edit(b => b.replace(whole, normalised));
    await open.save();
    return;
  }
  const eolForFile = text.includes('\r\n') ? '\r\n' : eol;
  await vscode.workspace.fs.writeFile(uri, Buffer.from(text.replace(/\r\n?/g, eolForFile), 'latin1'));
}

/** Revert the working copy from the snapshot. Returns false when the snapshot has no copy. */
export async function revertFromSnapshot(s: Services, marker: RobotMarker, fileName: string, uri: vscode.Uri): Promise<boolean> {
  const snap = snapshotCopy(s, marker, fileName);
  if (snap === undefined) return false;
  await writeWorkingCopy(uri, snap, '\n');
  clearRobotCompare(uri.fsPath);
  await Promise.all([s.data.refresh(), s.index.refresh()]);
  return true;
}

// ── the push gate (verbatim) and post-push verification ─────────────────────

export type PushGate =
  | { kind: 'ok'; robotText: string }
  | { kind: 'no-snapshot'; robotText: string }
  | { kind: 'conflict'; robotText: string; diff: VerbatimDiff }
  /** the robot has no program of that name: nothing there to overwrite */
  | { kind: 'not-on-robot' }
  | { kind: 'error'; error: string };

/**
 * Read the robot's current copy and compare it to the snapshot **verbatim**. Anything that
 * differs - including metadata - is a conflict: someone changed the program since the last
 * fetch, and pushing now would overwrite a change the snapshot has never seen.
 */
export async function checkPushGate(s: Services, marker: RobotMarker, conn: RobotConnection, fileName: string, workingPath?: string): Promise<PushGate> {
  const live = s.live;
  if (!live) return { kind: 'error', error: 'no robot connection' };
  const snap = snapshotCopy(s, marker, fileName);
  let robotText: string;
  try {
    robotText = await live.readText(conn.profile, fileName, conn.profile.device);
  } catch (e: unknown) {
    // A read can fail because the program is not there (a brand-new program) or because the
    // robot did not answer. Only a listing that answers and does not name the file proves the
    // first; anything else holds the push, as before.
    try {
      const files = await live.listFiles(conn.profile, conn.profile.device);
      if (files.length && !files.some(f => !f.isDir && f.name.toUpperCase() === fileName.toUpperCase())) return { kind: 'not-on-robot' };
    } catch { /* the listing failed too: report the read error */ }
    return { kind: 'error', error: e instanceof Error ? e.message : String(e) };
  }
  if (snap === undefined) return { kind: 'no-snapshot', robotText };
  const diff = verbatimCompare(robotText, snap);
  noteRobotCompare(workingPath ?? marker.root, { differs: !diff.same, metadataOnly: diff.metadataOnly, changed: diff.changed + diff.added + diff.deleted });
  comparedChanged.fire();
  return diff.same ? { kind: 'ok', robotText } : { kind: 'conflict', robotText, diff };
}

/** Capture the robot's copy into the snapshot (the "Update Snapshot from Robot" answer to a conflict). */
export function captureRobotCopy(s: Services, marker: RobotMarker, fileName: string, robotText: string): void {
  recordSnapshotFile(s, marker, fileName, robotText);
}

export interface CompletePushOptions {
  /** pull policy (`containers.pullAfterPush`); only an explicit push may pull */
  pull?: PullAfterPush;
  /** true for Upload Program, false for a live-edit save */
  explicit?: boolean;
  workingPath?: string;
  preserveFocus?: boolean;
  /** phase messages while verifying and syncing, for the push progress */
  onPhase?: (message: string) => void;
}

export interface CompletePushResult {
  ok: boolean;
  /** the round trip only differed on metadata (DATE/MODIFIED etc.) - treated as identical */
  identical: boolean;
  metadataOnly: boolean;
  /** the normalized text still differs, metadata aside: a real change worth reporting */
  normalizedDiffers: boolean;
  pulled: boolean;
  decision: PullDecision;
  /** the controller's copy, as read back (present when the read succeeded) */
  robotText?: string;
  verdict: string;
}

/**
 * After a successful push, read the program back and make the snapshot exactly what the
 * controller now holds. The round trip is verified with the metadata-insensitive compare, so a
 * controller that only re-stamped DATE/MODIFIED is not reported as a change. Depending on the pull
 * policy, the read-back is also written into the working file, so workspace = snapshot = robot and
 * a post-push "compare with snapshot" has nothing to show.
 */
export async function completePush(s: Services, marker: RobotMarker, conn: RobotConnection, fileName: string, sentText: string, opts: CompletePushOptions = {}): Promise<CompletePushResult> {
  const live = s.live;
  if (!live) return { ok: false, identical: false, metadataOnly: false, normalizedDiffers: false, pulled: false, decision: 'off', verdict: 'no robot connection' };
  try {
    opts.onPhase?.("Verifying the controller's copy");
    const back = await live.readText(conn.profile, fileName, conn.profile.device);
    // The snapshot only ever advances from the robot: whatever the controller holds now IS it.
    recordSnapshotFile(s, marker, fileName, back);
    // Keep the pair: the controller just compiled the pushed .LS into a fresh .TP, so pull that
    // into the snapshot too (best-effort) rather than leave the compiled copy stale.
    const partner = pairedProgramName(fileName);
    if (partner) {
      try {
        const pdata = await live.readBinary(conn.profile, partner, conn.profile.device);
        recordSnapshotFile(s, marker, partner, pdata);
      } catch { /* no compiled partner on the controller */ }
    }
    const kind = /\.kl$/i.test(fileName) ? 'karel' : 'tp';
    const cmp = roundTripCompare(back, sentText, kind);
    const d = verbatimCompare(back, sentText);
    // normalized equality, metadata-insensitive: the same view "Compare with Snapshot" shows, so
    // a metadata-only round trip is not reported as a difference worth a warning
    const normalizedDiffers = !cmp.equal;
    const decision = pullAfterPushDecision(!!opts.explicit, opts.pull ?? 'never', cmp.equal);
    let pulled = false;
    if (decision === 'overwrite' && opts.workingPath) {
      opts.onPhase?.('Syncing the working copy');
      try { await writeWorkingCopy(vscode.Uri.file(opts.workingPath), back, '\n', { preserveFocus: opts.preserveFocus }); pulled = true; }
      catch { /* the snapshot still advanced; the working copy is left as it was */ }
    }
    // Snapshot = read-back, so the robot matches the snapshot by definition.
    noteRobotCompare(opts.workingPath ?? marker.root, { differs: false });
    comparedChanged.fire();
    const verdict = cmp.equal
      ? (cmp.metadataOnly ? 'read back identical (metadata refreshed)' : 'read back identical')
      : `read back differs (${d.changed + d.added + d.deleted} line(s))`;
    return { ok: true, identical: cmp.equal, metadataOnly: cmp.metadataOnly, normalizedDiffers, pulled, decision, robotText: back, verdict };
  } catch (e: unknown) {
    return { ok: false, identical: false, metadataOnly: false, normalizedDiffers: false, pulled: false, decision: 'off', verdict: `could not read it back: ${e instanceof Error ? e.message : String(e)}` };
  }
}
