/**
 * Modified-vs-snapshot comparison, shared by the tree rows, the CodeLens and the diff
 * command. Works over ProgramInfo fields computed at index time (textHash / normText),
 * so it is synchronous and costs no file reads.
 */
import type { Services } from './services';
import type { ProgramInfo } from './workspaceIndex';
import type { RobotCompare } from './robotCompare';
import { lineDiffCount, readSnapshotProgram, findSnapshotProgram, isCompiledProgram } from './robotContainers';

/** The git-shaped marker for a snapshot status (the amber gets applied by the caller). */
export const MODIFIED_COLOR = 'charts.orange';
/** Diverged - working and robot both moved since the snapshot (the sync item turns red). */
export const DIVERGED_COLOR = 'errorForeground';

export interface SnapshotStatus {
  /**
   * 'compiled' means there is no editable source on one side to compare as text: either the
   * working copy itself is a compiled `.tp`/`.pc`, or the snapshot holds only a compiled copy.
   * A byte compare for a compiled copy is on demand (the compare command), never here.
   */
  state: 'same' | 'modified' | 'missing' | 'compiled';
  /** when the snapshot was taken, YYYY-MM-DD */
  date?: string;
  /** how many lines differ (modified only, when both normalized texts are known) */
  lines?: number;
  /** the two copies are too different to count exactly: `lines` is a floor, shown as "4000+" */
  approximate?: boolean;
}

/**
 * Line counts already worked out, by the pair of text hashes. snapshotStatus runs for every
 * row of two trees on every refresh, and for the lens, and a program's count cannot change
 * until one of the two texts does - which changes its hash. Bounded: cleared when it fills.
 */
const counted = new Map<string, { lines: number; approximate?: boolean }>();
const COUNTED_MAX = 2000;

/**
 * The reference (snapshot) copy a working program is compared against: a reference of the
 * same name and group, preferring the same kind. A snapshot folder can hold both a `.ls`
 * source and a compiled `.tp`/`.pc` of the same program; a binary indexes with no text hash,
 * and letting it win made every edit (including a scaffolded blank line) read as 'same'.
 * Returns undefined when only a binary is present, so the caller reads the source from disk.
 */
export function snapshotRefFor(programs: ProgramInfo[], info: ProgramInfo): ProgramInfo | undefined {
  const refs = programs.filter(p => p.reference && p.group === info.group);
  return refs.find(p => p.kind === info.kind) ?? refs.find(p => p.kind !== 'binary');
}

/**
 * Status of a working program against its snapshot copy. undefined when no
 * .robocode-robot marker covers the program (nothing to compare against).
 * Comparison is over the normalized text (line numbers, terminators and LINE_COUNT
 * ignored), so a renumber-only change reads as 'same'.
 */
export function snapshotStatus(s: Services, info: ProgramInfo): SnapshotStatus | undefined {
  const marker = s.containers.markerOf(info.uri.fsPath);
  if (!marker) return undefined;
  const date = s.containers.snapshotInfo(marker.root)?.date.slice(0, 10);
  // A compiled working copy has no text to compare; its byte compare is on demand.
  if (isCompiledProgram(info.uri.fsPath)) return { state: 'compiled', date };
  const ref = snapshotRefFor(s.index.all(info.name), info);
  let refHash = ref?.textHash;
  let refNorm = ref?.normText;
  if (refHash === undefined) {
    // The snapshot copy may not be in the index at all (excluded from the file search, past
    // the file cap, or not rescanned yet), or the only reference found is a compiled binary
    // with no text. Only a source copy counts here (readSnapshotProgram never reads a binary).
    const disk = readSnapshotProgram(marker.snapshotDir, info.name, info.kind === 'karel' ? 'karel' : 'tp');
    if (disk) { refHash = disk.textHash; refNorm = disk.normText; }
  }
  if (refHash === undefined) {
    // No editable source anywhere: a compiled copy still means the program is known.
    return findSnapshotProgram(marker.snapshotDir, info.name) ? { state: 'compiled', date } : { state: 'missing', date };
  }
  if (info.textHash === undefined || refHash === info.textHash) return { state: 'same', date };
  const key = `${info.textHash}|${refHash}`;
  let hit = counted.get(key);
  if (!hit && info.normText !== undefined && refNorm !== undefined) {
    const d = lineDiffCount(info.normText, refNorm);
    hit = { lines: d.changed + d.added + d.deleted, approximate: d.approximate };
    if (counted.size >= COUNTED_MAX) counted.clear();
    counted.set(key, hit);
  }
  return { state: 'modified', date, lines: hit?.lines, approximate: hit?.approximate };
}

/** the description text for a snapshot status */
export function snapshotStatusText(st: SnapshotStatus): string {
  if (st.state === 'same') return `= snapshot${st.date ? ` ${st.date}` : ''}`;
  if (st.state === 'missing') return 'not in snapshot';
  if (st.state === 'compiled') return 'compiled only';
  return `≠ snapshot${st.lines !== undefined ? ` · ${st.lines}${st.approximate ? '+' : ''} line${st.lines === 1 && !st.approximate ? '' : 's'}` : ''}`;
}

export interface SyncRelation {
  /** git-shaped marker for a quick glance: ✓ ↑n ↓n ↕ ? */
  symbol: string;
  /** the same thing in words, for a tooltip */
  words: string;
  /** lines the working copy is ahead of the snapshot, when the count is known */
  ahead?: number;
  /** the ahead count is a floor ("4000+") */
  approximate?: boolean;
  /** lines the robot differs by, when it has been compared and differs */
  behind?: number;
  /** true when the working copy differs from the snapshot - the marker that gets the amber */
  modified: boolean;
}

/**
 * The one place the git-shaped sync marker is derived, so the status bar and the tree rows
 * agree. `W` = working copy, `S` = snapshot, `R` = robot: ✓ synced, ↑ local ahead (to push),
 * ↓ robot ahead (fetch), ↕ diverged, ? untracked (no snapshot copy).
 */
export function syncRelation(st: SnapshotStatus | undefined, rc: RobotCompare | undefined): SyncRelation {
  if (!st) return { symbol: '?', words: 'This file is not in a robot container', modified: false };
  if (st.state === 'missing') return { symbol: '?', words: 'Not in the snapshot yet - no copy has been fetched for this file', modified: false };
  // a compiled copy has no text: same source/compiled compare only, on demand
  if (st.state === 'compiled') return { symbol: '?', words: 'Only a compiled copy - there is nothing to compare line by line', modified: false };
  const wEqS = st.state === 'same';
  const ahead = wEqS ? undefined : st.lines;
  const robotKnown = !!rc;
  const sEqR = robotKnown && !rc!.differs;
  const behind = robotKnown && rc!.differs ? rc!.changed : undefined;
  if (!robotKnown) {
    return {
      symbol: wEqS ? '✓' : `↑${ahead ?? ''}`,
      words: wEqS ? 'Your copy matches the snapshot (the controller has not been compared)' : 'Your copy has changes that are not in the snapshot',
      ahead, approximate: st.approximate, modified: !wEqS,
    };
  }
  if (wEqS && sEqR) return { symbol: '✓', words: 'Your copy, the snapshot and the controller all match', modified: false };
  if (!wEqS && sEqR) return { symbol: `↑${ahead ?? ''}`, words: 'You have changes to push; the controller still matches the snapshot', ahead, modified: true };
  if (wEqS && !sEqR) return { symbol: `↓${behind ?? ''}`, words: 'The controller changed since the snapshot; fetch to update', behind, modified: false };
  return { symbol: '↕', words: 'Both your copy and the controller changed since the snapshot', ahead, behind, modified: true };
}

/**
 * The theme token for a sync marker, or undefined to leave it uncoloured. Synced (✓) and
 * untracked (?) carry no colour; any difference from the snapshot is amber (↑ local, ↓ robot);
 * a true divergence (↕) is red. Pure, so the status bar and any other surface share it.
 */
export function syncColorToken(rel: SyncRelation): string | undefined {
  if (rel.symbol === '↕') return DIVERGED_COLOR;
  if (rel.symbol.startsWith('↑') || rel.symbol.startsWith('↓')) return MODIFIED_COLOR;
  return undefined;
}
