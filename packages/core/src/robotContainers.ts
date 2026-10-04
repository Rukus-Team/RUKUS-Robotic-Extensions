/**
 * Per-robot container types and helpers — pure, vscode-free.
 * This module imports only node builtins and the (equally pure) .va parser, so that test/run.ts
 * can import it directly without pulling in vscode (which fails outside the extension host).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { robotNameFromFolder, folderDate, ROBOT_FOLDER_PATTERNS } from './backupFolders';
import { looksLikeAnyBackup, isAnyBrandDataFile } from './brand';

// ── Constants ───────────────────────────────────────────────────────────────

export const ROBOT_DIR = '.robocode-robot';
export const CELL_DIR = '.robocode-cell';
export const SNAPSHOT_DIR = 'snapshot';
/** prior versions of snapshot files a fetch replaced (the sync reflog), inside .robocode-robot */
export const SNAPSHOT_HISTORY_DIR = 'snapshot-history';
export const ROBOT_JSON = 'robot.json';
export const CELL_JSON = 'cell.json';
export const SNAPSHOT_JSON = 'snapshot.json';

// ── Types ───────────────────────────────────────────────────────────────────

/** Raw content of a robot.json file. */
export interface RobotMarkerSpec {
  name?: string;
  programs?: string[];
  exclude?: string[];
  /** Name of a controller defined in the cell's cell.json controllers map. */
  controller?: string;
}

/** Connection details for a controller declared in cell.json. */
export interface CellControllerSpec {
  host: string;
  httpPort?: number;
  ftpPort?: number;
  ftpUser?: string;
  device?: string;
  useFtp?: boolean;
  autoConnect?: boolean;
  autoRefresh?: boolean;
  pollIntervalMs?: number;
}

/** A resolved, validated robot marker rooted at a specific absolute path. */
export interface RobotMarker {
  /** Absolute path to the robot folder (the folder containing .robocode-robot/). */
  root: string;
  /** Display name. Falls back to the folder's base name. */
  name: string;
  /** Absolute paths of declared working program folders, or undefined = all subdirs. */
  programDirs: string[] | undefined;
  /** Absolute paths of excluded folders (only used when programDirs is undefined). */
  excludeDirs: string[];
  /** Absolute path of the snapshot directory. */
  snapshotDir: string;
  /** Absolute path of the robot.json file. */
  markerPath: string;
  /** Name of the controller this robot binds to (from cell.json controllers map). */
  controller?: string;
}

/** Raw content of a cell.json file. */
export interface CellMarkerSpec {
  name?: string;
  controllers?: Record<string, CellControllerSpec>;
}

/** A resolved, validated cell marker. */
export interface CellMarker {
  /** Absolute path to the cell container dir. */
  root: string;
  /** Cell name. */
  name: string;
  /** Controller definitions from cell.json, keyed by name. */
  controllers: Record<string, CellControllerSpec>;
}

/** Content of snapshot.json (generated, never authored by hand). */
export interface SnapshotProvenance {
  date: string;
  source:
    | { kind: 'backup'; path: string }
    | { kind: 'robot'; name: string; host: string };
  fileCount: number;
  controller?: { name: string; version: string; fNumber: string };
  /** last time any part of the snapshot was updated (a full snapshot or a partial fetch) */
  updatedAt?: string;
  /**
   * Per-file fetch time, keyed by the file's path relative to the snapshot directory
   * (forward slashes, lower-cased). Written for every file when a snapshot is created
   * and updated on each partial fetch; absence falls back to the file's mtime.
   */
  files?: Record<string, string>;
}

/** Partition classification of a file path. */
export type PartitionKind = 'working' | 'reference' | 'excluded' | 'unmanaged';

// ── Parsing ─────────────────────────────────────────────────────────────────

/** Parse a robot.json file. Returns a RobotMarker or errors. */
export function parseRobotJson(
  text: string,
  rootAbs: string
): { marker?: RobotMarker; errors: string[] } {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text);
  } catch (e: unknown) {
    return { errors: [`Invalid JSON: ${e instanceof Error ? e.message : String(e)}`] };
  }
  const errors: string[] = [];
  const warnings: string[] = [];

  if (typeof raw !== 'object' || raw === null) {
    return { errors: ['robot.json root must be a JSON object'] };
  }

  // Unknown keys → warnings (don't fail, future-proof)
  for (const k of Object.keys(raw)) {
    if (!['name', 'programs', 'exclude', 'controller'].includes(k)) {
      warnings.push(`Unknown key "${k}" in robot.json (ignored)`);
    }
  }

  const name =
    typeof raw.name === 'string' && raw.name.trim()
      ? raw.name.trim()
      : path.basename(rootAbs);

  const snapshotDir = path.join(rootAbs, ROBOT_DIR, SNAPSHOT_DIR);

  let programDirs: string[] | undefined;
  if (Array.isArray(raw.programs)) {
    programDirs = [];
    for (const p of raw.programs) {
      if (typeof p !== 'string' || !p.trim()) {
        errors.push(`Invalid programs entry: ${JSON.stringify(p)}`);
        continue;
      }
      programDirs.push(path.resolve(rootAbs, p));
    }
  } else if (raw.programs !== undefined) {
    errors.push('"programs" must be an array of folder names');
  }

  const excludeDirs: string[] = [];
  if (Array.isArray(raw.exclude)) {
    for (const e of raw.exclude) {
      if (typeof e !== 'string' || !e.trim()) {
        errors.push(`Invalid exclude entry: ${JSON.stringify(e)}`);
        continue;
      }
      excludeDirs.push(path.resolve(rootAbs, e));
    }
  } else if (raw.exclude !== undefined) {
    errors.push('"exclude" must be an array of folder names');
  }

  let controller: string | undefined;
  if (raw.controller !== undefined) {
    if (typeof raw.controller === 'string' && raw.controller.trim()) {
      controller = raw.controller.trim();
    } else if (raw.controller !== undefined) {
      errors.push('"controller" must be a string (controller name from cell.json)');
    }
  }

  if (errors.length) return { errors };

  const markerPath = path.join(rootAbs, ROBOT_DIR, ROBOT_JSON);

  return {
    marker: { root: rootAbs, name, programDirs, excludeDirs, snapshotDir, markerPath, controller },
    errors: warnings.length ? warnings : [],
  };
}

/** Parse a cell.json file. */
export function parseCellJson(
  text: string,
  rootAbs: string
): { cell?: CellMarker; errors: string[] } {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text);
  } catch (e: unknown) {
    return { errors: [`Invalid JSON: ${e instanceof Error ? e.message : String(e)}`] };
  }
  if (typeof raw !== 'object' || raw === null) {
    return { errors: ['cell.json root must be a JSON object'] };
  }
  const errors: string[] = [];
  const name =
    typeof raw.name === 'string' && raw.name.trim()
      ? raw.name.trim()
      : path.basename(rootAbs);

  const controllers: Record<string, CellControllerSpec> = {};
  if (raw.controllers !== undefined) {
    if (typeof raw.controllers !== 'object' || raw.controllers === null || Array.isArray(raw.controllers)) {
      errors.push('"controllers" must be an object mapping controller names to connection details');
    } else {
      for (const [cname, cval] of Object.entries(raw.controllers as Record<string, unknown>)) {
        if (typeof cval !== 'object' || cval === null || Array.isArray(cval)) {
          errors.push(`Controller "${cname}" must be an object with connection details`);
          continue;
        }
        const c = cval as Record<string, unknown>;
        if (typeof c.host !== 'string' || !c.host.trim()) {
          errors.push(`Controller "${cname}" must have a "host" field (IP address)`);
          continue;
        }
        controllers[cname.trim()] = {
          host: c.host.trim(),
          httpPort: typeof c.httpPort === 'number' ? c.httpPort : undefined,
          ftpPort: typeof c.ftpPort === 'number' ? c.ftpPort : undefined,
          ftpUser: typeof c.ftpUser === 'string' ? c.ftpUser : undefined,
          device: typeof c.device === 'string' ? c.device : undefined,
          useFtp: typeof c.useFtp === 'boolean' ? c.useFtp : undefined,
          autoConnect: typeof c.autoConnect === 'boolean' ? c.autoConnect : undefined,
          autoRefresh: typeof c.autoRefresh === 'boolean' ? c.autoRefresh : undefined,
          pollIntervalMs: typeof c.pollIntervalMs === 'number' ? c.pollIntervalMs : undefined,
        };
      }
    }
  }

  if (errors.length) return { errors };
  return { cell: { root: rootAbs, name, controllers }, errors: [] };
}

// ── Path helpers ────────────────────────────────────────────────────────────

/** Normalize a path for case-insensitive prefix comparison (Windows). */
function norm(p: string): string {
  return path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
}

/** True when `child` is inside or equal to `parent` (case-insensitive, slash-insensitive). */
export function underPath(child: string, parent: string): boolean {
  const c = norm(child);
  const p = norm(parent);
  return c === p || c.startsWith(p + path.sep) || c.startsWith(p + '/');
}

/** Normalize and lowercase a path (for group keys). */
export function normGroup(p: string): string {
  return norm(p);
}

// ── Overlap detection ───────────────────────────────────────────────────────

/** Return warnings for any overlapping robot markers (nested or duplicate roots). */
export function markersWithOverlap(markers: RobotMarker[]): string[] {
  const warnings: string[] = [];
  const sorted = [...markers].sort((a, b) => norm(a.root).length - norm(b.root).length);
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      if (underPath(sorted[j].root, sorted[i].root)) {
        warnings.push(
          `"${sorted[i].name}" (${sorted[i].root}) contains "${sorted[j].name}" (${sorted[j].root}) — deeper marker "${sorted[j].name}" wins`
        );
      }
    }
  }
  return warnings;
}

// ── Classification ──────────────────────────────────────────────────────────

/** Find the deepest matching robot marker for a given path (longest root prefix wins). */
export function markerOf(fsPath: string, markers: readonly RobotMarker[]): RobotMarker | undefined {
  let best: RobotMarker | undefined;
  let bestLen = 0;
  for (const m of markers) {
    if (underPath(fsPath, m.root) && m.root.length > bestLen) {
      best = m;
      bestLen = m.root.length;
    }
  }
  return best;
}

/** Classify a file path within the workspace. */
export function classifyPath(
  fsPath: string,
  markers: readonly RobotMarker[]
): PartitionKind {
  const m = markerOf(fsPath, markers);
  if (!m) return 'unmanaged';

  const isUnderSnapshot = underPath(fsPath, m.snapshotDir);

  if (isUnderSnapshot) return 'reference';

  // Check if inside the .robocode-robot directory itself (config, gitignore, etc.)
  const isUnderMarkerDir = underPath(fsPath, path.join(m.root, ROBOT_DIR));
  if (isUnderMarkerDir) return 'excluded';

  // Check if inside an explicitly excluded folder
  for (const ex of m.excludeDirs) {
    if (underPath(fsPath, ex)) return 'excluded';
  }

  // If programDirs is defined, check membership
  if (m.programDirs) {
    for (const pd of m.programDirs) {
      if (underPath(fsPath, pd)) return 'working';
    }
    // Inside the marker root but not in any declared program folder or excluded dir
    return 'excluded';
  }

  // programDirs undefined = everything except .robocode-robot/ and excludes is working
  return 'working';
}

// ── Ranking (for get() in workspaceIndex) ───────────────────────────────────

/** Fields needed by the ranking comparator — pulled from ProgramInfo to keep this pure. */
export interface Rankable {
  group: string;
  kind: string;
  reference?: boolean;
  mtime: number;
}

/**
 * Rank one program for get() selection. Lower wins. Ties broken by mtime (newest first).
 * Ordering: same group → non-reference → non-binary → in-workspace.
 * A reference source still beats a working binary (the source is the one to open),
 * matching the pre-container "source over compiled" rule.
 */
export function programRank(
  p: Rankable,
  nearGroup: string | undefined,
  inWorkspace: boolean
): number {
  let r = 0;
  if (!nearGroup || p.group !== nearGroup) r += 40;
  if (p.reference) r += 5;
  if (p.kind === 'binary') r += 10;
  if (!inWorkspace) r += 2;
  return r;
}

/**
 * Build a ranking comparator for ProgramInfo selection.
 * Lower rank wins. Ties broken by mtime (newest first).
 *
 * Ordering: same group → non-reference → non-binary → in-workspace → newest.
 */
export function buildRankComparator(
  nearGroup: string | undefined,
  inWorkspace: (uri: string) => boolean
) {
  return (a: Rankable & { uri: string; inWorkspace?: boolean }, b: Rankable & { uri: string }): number => {
    const ra = programRank(a, nearGroup, a.inWorkspace ?? inWorkspace(a.uri));
    const rb = programRank(b, nearGroup, inWorkspace(b.uri));
    return ra - rb || b.mtime - a.mtime;
  };
}

// ── Text normalization (TP comparison) ──────────────────────────────────────

/**
 * Normalize a TP .ls file for comparison against another copy.
 * Strips line-number fields, blanks LINE_COUNT, normalizes whitespace and terminators.
 * Never written to disk — used only for the modified-vs-snapshot hash and line diff.
 */
export function normalizeTpForCompare(text: string): string {
  // 1. Normalize line endings + strip trailing whitespace globally
  let t = text.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '');

  // 2. Find /MN section bounds (simple scan, no parser)
  const lines = t.split('\n');
  let mnStart = -1;
  let mnEnd = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*\/MN\s*$/i.test(lines[i])) mnStart = i + 1;
    if (mnStart > 0 && /^\s*\/(?:POS|END)\s*$/i.test(lines[i])) {
      mnEnd = i;
      break;
    }
  }

  // 3. /MN lines: strip line-number field + terminator + trailing whitespace
  if (mnStart >= 0) {
    for (let i = mnStart; i < mnEnd; i++) {
      // User's Meld regex: strip leading whitespace + digits/spaces + colon + trailing whitespace
      lines[i] = lines[i].replace(/^\s*[\d ]+:\s*/, '');
      // Strip trailing ' ;' terminator
      lines[i] = lines[i].replace(/\s*;\s*$/, '');
    }
  }

  // 4. Blank LINE_COUNT value (normalize whitespace around =)
  t = lines.join('\n');
  t = t.replace(/^(\s*LINE_COUNT)\s*=\s*\d+\s*;?/m, '$1 = #');

  return t;
}

/**
 * Normalize a KAREL .kl file for comparison.
 * Only normalizes line endings and trailing whitespace (no line numbers in KAREL).
 */
export function normalizeKarelForCompare(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '');
}

/**
 * Normalize and hash in one pass: the caller keeps the normalized text (for synchronous
 * line-diff counts) and the hash (for the cheap =/≠ check).
 */
export function normalizeAndHash(text: string, kind: 'tp' | 'karel'): { norm: string; hash: string } {
  const norm = kind === 'tp' ? normalizeTpForCompare(text) : normalizeKarelForCompare(text);
  // Simple djb2
  let hash = 5381;
  for (let i = 0; i < norm.length; i++) {
    hash = ((hash << 5) + hash + norm.charCodeAt(i)) >>> 0;
  }
  return { norm, hash: hash.toString(16) };
}

/**
 * Compute a stable hash of normalized text for the =/≠ status.
 */
export function normalizedTextHash(text: string, kind: 'tp' | 'karel'): string {
  return normalizeAndHash(text, kind).hash;
}

// ── Line-diff count (LCS length, by Myers' greedy algorithm) ────────────────

/** Edits past this are not counted exactly - see lineDiffCount. */
export const LINE_DIFF_MAX_EDITS = 4000;

/**
 * Count the number of lines that differ between two normalized texts.
 * Returns { same, changed, added, deleted }, the same numbers the first version gave.
 *
 * That version filled an (n+1) x (m+1) table: exact, but a 3000-line program cost 60 ms and
 * 18 MB, an 8000-line one 380 ms and 128 MB - and this runs for every modified program on
 * every tree refresh. Programs that big are real (the reference backup has a 7200-line file).
 *
 * The LCS length is all that is needed, and LCS = (n + m - D) / 2 where D is the shortest edit
 * distance, which Myers' algorithm finds in O((n + m) * D) time and O(n + m) memory. A working
 * copy differs from its snapshot by a handful of lines, so D is tiny and the cost is close to
 * one pass over the file. The common head and tail are dropped first; that never changes the
 * LCS and usually leaves almost nothing to compare.
 *
 * Two files with nothing in common would make D as large as n + m and the time quadratic
 * again, so the search stops at `maxEdits`. Past that the count is an ESTIMATE from the lines
 * the two texts share regardless of order - never more than the true LCS allows, so the number
 * of differing lines is a floor - and `approximate` is set so the caller can say "4000+".
 */
export function lineDiffCount(
  a: string,
  b: string,
  maxEdits = LINE_DIFF_MAX_EDITS
): { same: number; changed: number; added: number; deleted: number; approximate?: boolean } {
  const la = a.split('\n');
  const lb = b.split('\n');
  const n = la.length;
  const m = lb.length;

  let head = 0;
  while (head < n && head < m && la[head] === lb[head]) head++;
  let tail = 0;
  while (tail < n - head && tail < m - head && la[n - 1 - tail] === lb[m - 1 - tail]) tail++;

  const mid = lcsLength(la.slice(head, n - tail), lb.slice(head, m - tail), maxEdits);
  const lcs = head + tail + mid.lcs;
  const same = lcs;
  const changed = Math.min(n, m) - lcs; // lines that exist in both but differ
  const added = m - lcs - changed;
  const deleted = n - lcs - changed;
  return mid.approximate ? { same, changed, added, deleted, approximate: true } : { same, changed, added, deleted };
}

/** LCS length of two line lists: exact while the edit distance stays within `maxEdits`. */
function lcsLength(A: string[], B: string[], maxEdits: number): { lcs: number; approximate?: boolean } {
  const N = A.length, M = B.length;
  if (N === 0 || M === 0) return { lcs: 0 };
  const max = Math.min(N + M, Math.max(0, maxEdits));
  const off = max + 1;
  const V = new Int32Array(2 * max + 3);   // V[off + k] = furthest x reached on diagonal k
  for (let D = 0; D <= max; D++) {
    for (let k = -D; k <= D; k += 2) {
      let x = k === -D || (k !== D && V[off + k - 1] < V[off + k + 1]) ? V[off + k + 1] : V[off + k - 1] + 1;
      let y = x - k;
      while (x < N && y < M && A[x] === B[y]) { x++; y++; }
      V[off + k] = x;
      if (x >= N && y >= M) return { lcs: (N + M - D) / 2 };
    }
  }
  // Too different to be worth the exact answer: the lines they share, order ignored.
  const counts = new Map<string, number>();
  for (const l of A) counts.set(l, (counts.get(l) ?? 0) + 1);
  let shared = 0;
  for (const l of B) { const c = counts.get(l) ?? 0; if (c > 0) { shared++; counts.set(l, c - 1); } }
  return { lcs: shared, approximate: true };
}

// ── Snapshot helpers (node:fs only) ─────────────────────────────────────────

/**
 * Write snapshot.json to the container root.
 */
export function writeProvenance(
  containerRoot: string,
  prov: SnapshotProvenance
): void {
  const p = path.join(containerRoot, ROBOT_DIR, SNAPSHOT_JSON);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(prov, null, 2) + '\n', 'utf8');
  // the snapshot changed, so any cached snapshot-program lookup may be stale
  clearSnapshotProgramCache();
}

/**
 * Read snapshot.json from the container root.
 */
export function readProvenance(containerRoot: string): SnapshotProvenance | undefined {
  const p = path.join(containerRoot, ROBOT_DIR, SNAPSHOT_JSON);
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as SnapshotProvenance;
  } catch {
    return undefined;
  }
}

/**
 * Replace the snapshot directory with a fully-built temporary one (the pull path writes
 * its files into the temp dir, then swaps).
 *
 * The old snapshot is MOVED ASIDE, not deleted, until the new one is in place. Deleting first
 * meant that a rename that then failed - a file in the folder open in an editor, a virus
 * scanner holding a handle, which on Windows is an ordinary day - left the robot with no
 * snapshot at all. Now a failed swap puts the old one back and throws; the old one is only
 * removed once the new one has its name. If that last removal fails the leftover is a
 * `snapshot.old-*` folder inside .robocode-robot, which is excluded and gitignored.
 */
export function swapSnapshot(tmpDir: string, snapshotDir: string): void {
  const aside = `${snapshotDir}.old-${Date.now()}`;
  const had = fs.existsSync(snapshotDir);
  if (had) fs.renameSync(snapshotDir, aside);
  try {
    fs.renameSync(tmpDir, snapshotDir);
  } catch (e) {
    if (had) { try { fs.renameSync(aside, snapshotDir); } catch { /* the old one is still on disk, under `aside` */ } }
    throw e;
  }
  if (had) { try { fs.rmSync(aside, { recursive: true, force: true }); } catch { /* best effort */ } }
}

/**
 * copySnapshot without blocking: one file at a time through fs.promises, so the extension
 * host keeps answering and a progress notification actually moves. A full controller backup
 * is thousands of files and tens of MB; the synchronous copy froze VS Code for its duration,
 * with the spinner it had just put up standing still. Same temp-dir swap, same guarantee:
 * if the copy fails the old snapshot is untouched.
 */
export async function copySnapshotAsync(
  srcDir: string,
  snapshotDir: string,
  onFile?: (count: number, name: string) => void
): Promise<number> {
  const tmpDir = snapshotDir + '.tmp-' + Date.now();
  let count = 0;
  const walk = async (src: string, dest: string): Promise<void> => {
    await fs.promises.mkdir(dest, { recursive: true });
    for (const entry of await fs.promises.readdir(src, { withFileTypes: true })) {
      const s = path.join(src, entry.name), d = path.join(dest, entry.name);
      if (entry.isDirectory()) await walk(s, d);
      else { await fs.promises.copyFile(s, d); onFile?.(++count, entry.name); }
    }
  };
  try {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
    await walk(srcDir, tmpDir);
    swapSnapshot(tmpDir, snapshotDir);
  } catch (e) {
    try { await fs.promises.rm(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
    throw e;
  }
  return count;
}

/**
 * Wholesale copy a source directory into the snapshot directory using a temp-dir swap.
 * Atomic: if the copy fails, the old snapshot is untouched.
 */
export function copySnapshot(srcDir: string, snapshotDir: string): number {
  const tmpDir = snapshotDir + '.tmp-' + Date.now();
  let count = 0;
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    copyDirRecursive(srcDir, tmpDir, () => count++);
    swapSnapshot(tmpDir, snapshotDir);
  } catch (e) {
    // Clean up temp on failure
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
    throw e;
  }
  return count;
}

function copyDirRecursive(
  src: string,
  dest: string,
  onFile: () => void
): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(s, d, onFile);
    } else {
      fs.copyFileSync(s, d);
      onFile();
    }
  }
}

// ── Snapshot files: finding, writing, history and per-file age ───────────────

/** A file inside a snapshot directory, with the metadata the tree shows. */
export interface SnapshotFileEntry {
  /** path relative to the snapshot directory, forward slashes, original case */
  rel: string;
  abs: string;
  size: number;
  /** last-modified time in ms - the fallback when snapshot.json has no entry for the file */
  mtime: number;
}

/** Normalise a snapshot-relative path for use as a snapshot.json `files` key. */
export function snapshotRelKey(rel: string): string {
  return rel.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
}

/**
 * The upper-cased file names of the entries at or under a snapshot directory prefix, for
 * scoping a folder fetch to what that directory holds. Empty entries yield nothing.
 */
export function snapshotNamesUnder(entries: ReadonlyArray<{ rel: string }>, prefix: string): string[] {
  const trimmed = prefix.replace(/^\/+|\/+$/g, '');
  const p = trimmed ? trimmed.toLowerCase() + '/' : '';
  return [...new Set(entries.filter(e => e.rel.toLowerCase().startsWith(p)).map(e => path.basename(e.rel).toUpperCase()))];
}

/**
 * True when a snapshot's `updatedAt` is within `bufferMs` of `now` - i.e. it was fetched
 * recently enough that fetching again would be noise. A future timestamp (clock skew) counts
 * as fresh; a missing or unparseable one does NOT (the caller may still fetch).
 */
export function snapshotFetchedWithin(updatedAt: string | undefined, bufferMs: number, now = Date.now()): boolean {
  if (!updatedAt) return false;
  const t = Date.parse(updatedAt);
  return Number.isFinite(t) && now - t < bufferMs;
}

/** Find a snapshot file by relative path, case-insensitively; falls back to a bounded search by name. */
export function findSnapshotFile(snapshotDir: string, relPath: string): string | undefined {
  const direct = resolveCaseInsensitive(snapshotDir, relPath);
  if (direct) return direct;
  return searchSnapshotByName(snapshotDir, path.basename(relPath));
}

function resolveCaseInsensitive(root: string, relPath: string): string | undefined {
  let cur = root;
  for (const part of relPath.split(/[\\/]/).filter(Boolean)) {
    let entries: string[];
    try { entries = fs.readdirSync(cur); } catch { return undefined; }
    const want = part.toLowerCase();
    const hit = entries.find(e => e.toLowerCase() === want);
    if (!hit) return undefined;
    cur = path.join(cur, hit);
  }
  return cur === root ? undefined : cur;
}

function searchSnapshotByName(dir: string, name: string, depth = 0): string | undefined {
  if (depth > 6) return undefined;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return undefined; }
  const want = name.toLowerCase();
  const fileHit = entries.find(e => e.isFile() && e.name.toLowerCase() === want);
  if (fileHit) return path.join(dir, fileHit.name);
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const hit = searchSnapshotByName(path.join(dir, e.name), name, depth + 1);
    if (hit) return hit;
  }
  return undefined;
}

/** Read a snapshot file verbatim (latin1), or undefined when it is not there. */
export function readSnapshotFile(snapshotDir: string, relPath: string): string | undefined {
  const p = findSnapshotFile(snapshotDir, relPath);
  if (!p) return undefined;
  try { return fs.readFileSync(p, 'latin1'); } catch { return undefined; }
}

/**
 * Path of a program's snapshot copy, tried by name + extension (`.ls`, `.kl`, `.tp`, `.pc`).
 * Cached because the snapshot tree asks this for every row on every refresh; the cache is
 * dropped whenever a snapshot's provenance is written, which is the only time it can change.
 */
export function findSnapshotProgram(snapshotDir: string, name: string): string | undefined {
  const key = `${norm(snapshotDir)}|${name.toLowerCase()}`;
  const hit = snapshotProgramCache.get(key);
  if (hit !== undefined) return hit ?? undefined;
  let found: string | undefined;
  for (const ext of ['.ls', '.kl', '.tp', '.pc']) {
    found = findSnapshotFile(snapshotDir, name + ext);
    if (found) break;
  }
  if (snapshotProgramCache.size >= 4000) snapshotProgramCache.clear();
  snapshotProgramCache.set(key, found ?? null);
  return found;
}

/**
 * Path of a program's editable SOURCE copy in a snapshot (`.ls`, `.kl`), or undefined. The
 * compare reads this, never a compiled `.tp`/`.pc`, whose bytes are not text.
 */
export function findSnapshotSource(snapshotDir: string, name: string): string | undefined {
  for (const ext of ['.ls', '.kl']) {
    const found = findSnapshotFile(snapshotDir, name + ext);
    if (found) return found;
  }
  return undefined;
}
const snapshotProgramCache = new Map<string, string | null>();
/** path -> normalized text, keyed by mtime so a re-fetch invalidates it */
const snapshotReadCache = new Map<string, { mtime: number; value: { hash: string; norm: string } }>();

/** Drop the snapshot-program lookup/read caches. Called when provenance is (re)written. */
export function clearSnapshotProgramCache(): void {
  snapshotProgramCache.clear();
  snapshotReadCache.clear();
}

/**
 * Read a program's snapshot SOURCE copy and normalize/hash it (never a compiled `.tp`/`.pc`,
 * whose bytes are not text). This is the compare that needs NO index entry: the reference copy
 * may not have been indexed (hidden/excluded from the file search, past the file cap, or not
 * rescanned yet), but if the source byte is on disk it is the snapshot. `kind` picks the normalizer.
 */
export function readSnapshotProgram(snapshotDir: string, name: string, kind: 'tp' | 'karel'): { path: string; textHash: string; normText: string } | undefined {
  const p = findSnapshotSource(snapshotDir, name);
  if (!p) return undefined;
  let mtime = 0;
  try { mtime = fs.statSync(p).mtimeMs; } catch { return undefined; }
  const hit = snapshotReadCache.get(p);
  if (hit && hit.mtime === mtime) return { path: p, textHash: hit.value.hash, normText: hit.value.norm };
  let text: string;
  try { text = fs.readFileSync(p, 'latin1'); } catch { return undefined; }
  const nh = normalizeAndHash(text, kind);
  if (snapshotReadCache.size >= 2000) snapshotReadCache.clear();
  snapshotReadCache.set(p, { mtime, value: nh });
  return { path: p, textHash: nh.hash, normText: nh.norm };
}

/**
 * Write one file into the snapshot directory, preserving the case of an existing file of the
 * same name. Written to a temp file and renamed into place so a half-written file is never
 * left behind. Returns the snapshot-relative path actually written.
 */
export function writeSnapshotFile(snapshotDir: string, relPath: string, data: Uint8Array | string): string {
  const existing = findSnapshotFile(snapshotDir, relPath);
  const target = existing ?? path.join(snapshotDir, relPath.split(/[\\/]/).filter(Boolean).join(path.sep));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${Date.now()}`;
  fs.writeFileSync(tmp, data as any);
  try { fs.renameSync(tmp, target); }
  catch { fs.copyFileSync(tmp, target); try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ } }
  return path.relative(snapshotDir, target).replace(/\\/g, '/');
}

/** A compact timestamp for a history folder: `20260924_143012`. */
export function historyStamp(at: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}_${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}`;
}

/**
 * Keep the snapshot's copy of one file before a fetch replaces it: copy it into
 * `.robocode-robot/snapshot-history/<stamp>/<relpath>`. The reflog that makes a captured
 * pendant edit recoverable even after the next push. No-op when the file is not there.
 */
export function pushSnapshotFileToHistory(robotRoot: string, snapshotDir: string, relPath: string, stamp = historyStamp()): string | undefined {
  const src = findSnapshotFile(snapshotDir, relPath);
  if (!src) return undefined;
  const rel = path.relative(snapshotDir, src);
  const dest = path.join(robotRoot, ROBOT_DIR, SNAPSHOT_HISTORY_DIR, stamp, rel);
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    return dest;
  } catch { return undefined; }
}

/** Prune the snapshot history to the newest `keep` stamp folders (0 = keep everything). */
export function pruneSnapshotHistory(robotRoot: string, keep: number): void {
  if (keep <= 0) return;
  const dir = path.join(robotRoot, ROBOT_DIR, SNAPSHOT_HISTORY_DIR);
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  const stamps = entries.filter(e => e.isDirectory()).map(e => e.name).sort();
  for (const old of stamps.slice(0, Math.max(0, stamps.length - keep))) {
    try { fs.rmSync(path.join(dir, old), { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

/** One version of a file kept in the snapshot history (the reflog). */
export interface SnapshotHistoryEntry {
  /** the history folder's stamp, `20260924_143012` */
  stamp: string;
  /** absolute path of the kept copy */
  abs: string;
}

/**
 * Every version of one file in `.robocode-robot/snapshot-history/`, newest stamp first.
 * `rel` is the snapshot-relative path; `fallbackName` matches a version filed under a flat name.
 */
export function listSnapshotHistory(robotRoot: string, rel: string, fallbackName?: string): SnapshotHistoryEntry[] {
  const root = path.join(robotRoot, ROBOT_DIR, SNAPSHOT_HISTORY_DIR);
  let stamps: string[];
  try { stamps = fs.readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort().reverse(); } catch { return []; }
  const out: SnapshotHistoryEntry[] = [];
  for (const stamp of stamps) {
    const dir = path.join(root, stamp);
    const hit = resolveHistoryIn(dir, rel) ?? (fallbackName ? resolveHistoryIn(dir, fallbackName) : undefined);
    if (hit) out.push({ stamp, abs: hit });
  }
  return out;
}

function resolveHistoryIn(dir: string, rel: string): string | undefined {
  const direct = path.join(dir, rel.split(/[\\/]/).join(path.sep));
  if (fs.existsSync(direct)) return direct;
  const parts = rel.split(/[\\/]/).filter(Boolean);
  let cur = dir;
  for (const part of parts) {
    let list: string[] = [];
    try { list = fs.readdirSync(cur); } catch { return undefined; }
    const hit = list.find(n => n.toLowerCase() === part.toLowerCase());
    if (!hit) return undefined;
    cur = path.join(cur, hit);
  }
  return fs.existsSync(cur) ? cur : undefined;
}

/** Every file in a snapshot directory, recursively, bounded. */
export function listSnapshotFiles(snapshotDir: string, limit = 5000): SnapshotFileEntry[] {
  const out: SnapshotFileEntry[] = [];
  const walk = (dir: string) => {
    if (out.length >= limit) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= limit) return;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) { walk(abs); continue; }
      if (!e.isFile()) continue;
      let size = 0, mtime = 0;
      try { const st = fs.statSync(abs); size = st.size; mtime = st.mtimeMs; } catch { /* unreadable */ }
      out.push({ rel: path.relative(snapshotDir, abs).replace(/\\/g, '/'), abs, size, mtime });
    }
  };
  walk(snapshotDir);
  return out;
}

/** The `files` map written into snapshot.json: every snapshot file, stamped now. */
export function snapshotFileTimes(snapshotDir: string, at: string = new Date().toISOString()): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of listSnapshotFiles(snapshotDir)) out[snapshotRelKey(f.rel)] = at;
  return out;
}

/** The age of one snapshot file: its recorded fetch time, else the file's mtime. */
export function snapshotFileAge(prov: SnapshotProvenance | undefined, relPath: string, mtimeMs: number): number {
  const iso = prov?.files?.[snapshotRelKey(relPath)];
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : mtimeMs;
}

/** A data or I/O file the snapshot fetch can pull on its own (no programs). */
export function isSnapshotDataFile(name: string): boolean {
  // which files count as data is the brand's call (FANUC: .va / .io / iostate.dg ...)
  return isAnyBrandDataFile(name.toLowerCase());
}

/** A program (source or compiled) the snapshot fetch can pull on its own. */
export function isSnapshotProgramFile(name: string): boolean {
  return /\.(ls|kl|tp|pc)$/i.test(name);
}

/** The editable ASCII source of a program: TP `.ls` or KAREL `.kl`. Only these are compared as text. */
export function isSourceProgram(name: string): boolean {
  return /\.(ls|kl)$/i.test(name);
}

/** A compiled program with no editable text: TP `.tp` or KAREL `.pc`. Never diffed or normalized. */
export function isCompiledProgram(name: string): boolean {
  return /\.(tp|pc)$/i.test(name);
}

/**
 * The other representation of a program: `NAME.LS ↔ NAME.TP`, `NAME.KL ↔ NAME.PC`, so a fetch
 * of either keeps the pair together in the snapshot. Undefined for anything that is not a program.
 */
export function pairedProgramName(fileName: string): string | undefined {
  const m = /^(.+)\.(ls|kl|tp|pc)$/i.exec(fileName);
  if (!m) return undefined;
  const ext = m[2].toUpperCase();
  const pair = ext === 'LS' ? 'TP' : ext === 'TP' ? 'LS' : ext === 'KL' ? 'PC' : 'KL';
  return `${m[1]}.${pair}`;
}

// ── Verbatim comparison (the push gate) ─────────────────────────────────────
//
// Strictly NOT normalised: line numbers, terminators and metadata all count. Only line
// endings are folded, because CRLF vs LF is a transport artefact, not a change.

/** Fold line endings only - nothing else is stripped. */
export function eolNormalize(s: string): string {
  return s.replace(/\r\n?/g, '\n');
}

export interface VerbatimDiff {
  /** the two texts are the same once line endings are folded */
  same: boolean;
  changed: number;
  added: number;
  deleted: number;
  approximate?: boolean;
  /** every differing line looks like metadata (DATE / TIME / LINE_COUNT) */
  metadataOnly?: boolean;
}

/** Compare two texts verbatim (line endings folded). The push gate uses this. */
export function verbatimCompare(a: string, b: string): VerbatimDiff {
  const na = eolNormalize(a), nb = eolNormalize(b);
  if (na === nb) return { same: true, changed: 0, added: 0, deleted: 0 };
  const d = lineDiffCount(na, nb);
  return { same: false, changed: d.changed, added: d.added, deleted: d.deleted, approximate: d.approximate, metadataOnly: metadataOnlyDiff(na, nb) };
}

/** True when every line that differs looks like a DATE / TIME / LINE_COUNT style field. */
export function metadataOnlyDiff(a: string, b: string): boolean {
  const la = a.split('\n'), lb = b.split('\n');
  if (la.length !== lb.length) return false;
  let differing = 0;
  for (let i = 0; i < la.length; i++) {
    if (la[i] === lb[i]) continue;
    differing++;
    if (!isMetadataLine(la[i]) && !isMetadataLine(lb[i])) return false;
  }
  return differing > 0;
}

function isMetadataLine(s: string): boolean {
  return /\bLINE_COUNT\b/i.test(s)
    || /\bDATE\b|\bTIME\b/i.test(s)
    || /\b\d{2}-[A-Z]{3}-\d{2}\b/.test(s)
    || /\b\d{4}-\d{2}-\d{2}\b/.test(s)
    || /\b\d{1,2}:\d{2}(:\d{2})?\b/.test(s);
}

/**
 * Blank the fields a controller rewrites on its own every time it takes a program: the
 * CREATE/MODIFIED stamps and the derived sizes. The line stays, only its value is `#`, so a
 * genuine edit to one of those lines still counts as a difference.
 */
export function stripTpMetadata(text: string): string {
  return text
    .replace(/^(\s*(?:LINE_COUNT|PROG_SIZE|MEMORY_SIZE)\s*=\s*)[^;\r\n]*/gim, '$1#')
    .replace(/^(\s*(?:CREATE|MODIFIED)\s*=\s*)[^;\r\n]*/gim, '$1#');
}

/**
 * Compare the text that was pushed with the copy the controller read back. Normalized like the
 * W↔S compare, but the metadata the controller always rewrites is also ignored - so a clean
 * upload does not read as "differs (2 lines)" just because the DATE moved. `metadataOnly`
 * separates "same program, new stamps" from real text the controller changed.
 */
export function roundTripCompare(a: string, b: string, kind: 'tp' | 'karel'): { equal: boolean; metadataOnly: boolean } {
  const na = normalizeAndHash(a, kind).norm;
  const nb = normalizeAndHash(b, kind).norm;
  if (na === nb) return { equal: true, metadataOnly: false };
  if (kind === 'tp') {
    let sa = stripTpMetadata(na), sb = stripTpMetadata(nb);
    // V9.40 controllers add `LOCAL_REGISTERS = 0,0,0;` to a program sent without it: a line only
    // one side has is the controller's default, not a change (the same line on both sides still compares)
    const local = /^\s*LOCAL_REGISTERS\s*=[^\n]*\n?/gim;
    const has = (x: string) => /^\s*LOCAL_REGISTERS\s*=/im.test(x);
    if (has(sa) !== has(sb)) { sa = sa.replace(local, ''); sb = sb.replace(local, ''); }
    if (sa === sb) return { equal: true, metadataOnly: true };
  }
  return { equal: false, metadataOnly: false };
}

/** What the container's .gitignore keeps out of git - see writeRobotGitignore. */
export const ROBOT_GITIGNORE_LINES: readonly string[] = ['snapshot/', SNAPSHOT_JSON, 'snapshot.tmp-*/', 'snapshot.old-*/', `${SNAPSHOT_HISTORY_DIR}/`];

/**
 * Write the .gitignore inside .robocode-robot/: the snapshot, and everything that only makes
 * sense beside it.
 *
 * snapshot.json goes with snapshot/. It used to be committed while the snapshot was not, which
 * is wrong twice: a colleague who clones sees "snapshot 2026-09-15" for a snapshot they do not
 * have, and the file records where it was taken from - an absolute path on one person's PC, or
 * the robot's name and IP address. The temp and moved-aside folders a snapshot leaves behind
 * when it is interrupted are listed too.
 *
 * An existing .gitignore is never rewritten - it may carry the user's own lines - but lines
 * missing from it are appended, so a container made before this list grew picks them up.
 */
export function writeRobotGitignore(containerRoot: string): void {
  const p = path.join(containerRoot, ROBOT_DIR, '.gitignore');
  const dir = path.dirname(p);
  if (!fs.existsSync(p)) {
    fs.mkdirSync(dir, { recursive: true });
    hideDir(dir);
    fs.writeFileSync(p, ROBOT_GITIGNORE_LINES.join('\n') + '\n', 'utf8');
    return;
  }
  const text = fs.readFileSync(p, 'utf8');
  const have = new Set(text.split(/\r?\n/).map(l => l.trim()));
  const missing = ROBOT_GITIGNORE_LINES.filter(l => !have.has(l));
  if (missing.length) fs.writeFileSync(p, text + (text === '' || text.endsWith('\n') ? '' : '\n') + missing.join('\n') + '\n', 'utf8');
}

/**
 * Create a robot.json file from a marker spec.
 */
export function writeRobotJson(containerRoot: string, spec: RobotMarkerSpec): void {
  const p = path.join(containerRoot, ROBOT_DIR, ROBOT_JSON);
  const dir = path.dirname(p);
  fs.mkdirSync(dir, { recursive: true });
  hideDir(dir);
  fs.writeFileSync(p, JSON.stringify(spec, null, 2) + '\n', 'utf8');
}

/**
 * Create a cell.json file.
 */
export function writeCellJson(
  containerRoot: string,
  name: string,
  controllers?: Record<string, CellControllerSpec>
): void {
  const p = path.join(containerRoot, CELL_DIR, CELL_JSON);
  const dir = path.dirname(p);
  fs.mkdirSync(dir, { recursive: true });
  hideDir(dir);
  const content: Record<string, unknown> = { name };
  if (controllers && Object.keys(controllers).length) content.controllers = controllers;
  fs.writeFileSync(p, JSON.stringify(content, null, 2) + '\n', 'utf8');
}

/**
 * Add or update a controller in an existing cell.json file.
 * If cell.json doesn't exist, creates it with just the controller.
 */
export function upsertCellController(
  cellRoot: string,
  name: string,
  spec: CellControllerSpec
): void {
  const p = path.join(cellRoot, CELL_DIR, CELL_JSON);
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch { /* file doesn't exist or invalid — start fresh */ }
  if (typeof raw !== 'object' || raw === null) raw = {};
  const controllers = (typeof raw.controllers === 'object' && raw.controllers !== null && !Array.isArray(raw.controllers))
    ? raw.controllers as Record<string, unknown>
    : {};
  controllers[name] = spec;
  raw.controllers = controllers;
  const dir = path.dirname(p);
  fs.mkdirSync(dir, { recursive: true });
  hideDir(dir);
  fs.writeFileSync(p, JSON.stringify(raw, null, 2) + '\n', 'utf8');
}

/**
 * Remove a controller from a cell.json file.
 * If the file doesn't exist or doesn't have that controller, no-op.
 */
export function removeCellController(
  cellRoot: string,
  name: string
): void {
  const p = path.join(cellRoot, CELL_DIR, CELL_JSON);
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch { return; }
  if (typeof raw !== 'object' || raw === null) return;
  const controllers = raw.controllers as Record<string, unknown> | undefined;
  if (!controllers || typeof controllers !== 'object') return;
  delete controllers[name];
  fs.writeFileSync(p, JSON.stringify(raw, null, 2) + '\n', 'utf8');
}

/**
 * Set the hidden attribute on a directory (Windows only).
 * On Unix, dot-prefixed directories are hidden by convention in file explorers.
 */
function hideDir(dir: string): void {
  if (process.platform === 'win32') {
    try { require('child_process').execSync(`attrib +h "${dir}"`, { stdio: 'ignore' }); } catch { /* best effort */ }
  }
}

// ── Backup folders: recognising them, and finding a robot's ────────────────────────────────
//
// A container sits in a WORKING tree; RUKUS keeps a BACKUP STORE somewhere else:
//     <root>\<cluster>\Latest\<robot folder>\      the newest backup of each robot
//     <root>\<cluster>\<robot name>\<batch>\       that robot's older backups, one per run
//     <root>\<cluster>\.incoming\                  a download in progress - never complete
// with <robot folder> named from a template - "S002R01_(MD)_260912" (Sam's preset) or
// "S002R01_MD_2026-09-12" (Rodrigo's) - and <batch> a stamp, "2026-09-12_14-30". The two trees
// never collide, but people do keep dated backups inside a robot folder, and do make a
// container inside a backup tree, so both helpers below have to know these names.

/** folder names that are scaffolding, never a backup to offer and never programs to index */
const NEVER_DESCEND = new Set(['node_modules', '.git', '.incoming', ROBOT_DIR.toLowerCase(), CELL_DIR.toLowerCase(), '.vscode', '.vscode-test']);

/**
 * True when a folder NAME says "backup", whatever is inside: the words people use, RUKUS's
 * own folders (Latest, .incoming), a bare date or date-time stamp (a RUKUS batch), and a robot
 * backup folder in either naming preset. Used to decide what the Initialize Robot Container
 * wizard leaves UNticked - it only ever sets a default the user can change, so it leans towards
 * calling a dated folder a backup: indexing a backup as editable programs is the mistake the
 * whole feature exists to prevent, a working folder left unticked is one click.
 */
export function looksLikeBackupFolderName(name: string): boolean {
  const n = name.trim();
  if (/^(backups?|archives?|archived|old|1_MD|latest|\.incoming)$/i.test(n)) return true;
  // the template RUKUS is set to, when its settings have been read (a bare `{RobotName}` matches
  // any name at all and is not a backup tell, so a pattern with nothing but the robot is skipped)
  if (ROBOT_FOLDER_PATTERNS.some(re => re.source !== '^(?<robot>.+?)$' && re.test(n))) return true;
  if (/^\d{4}-\d{2}-\d{2}(?:[ _T-]\d{2}[-.:]?\d{2}(?:[-.:]?\d{2})?)?$/.test(n)) return true;      // 2026-09-12, 2026-09-12_14-30
  if (/^\d{8}(?:[ _-]\d{4,6})?$/.test(n) || /^\d{6}$/.test(n)) return true;                        // 20260912, 20260912_1430, 260912
  if (/_\([A-Za-z]+\)_\d{6,8}$/.test(n)) return true;                                              // S002R01_(MD)_260912
  if (/_(?:MD|IMG|Filtered)_(?:\d{4}-\d{2}-\d{2}|\d{6,8})$/i.test(n)) return true;                  // S002R01_MD_2026-09-12
  if (/_(?:full|backup|bak)(?:_|$)/i.test(n)) return true;                                         // S002R01_full_260823
  return /_\d{6}$/.test(n) || /_\d{4}-\d{2}-\d{2}$/.test(n);                                       // anything_260912, anything_2026-09-12
}

/**
 * True when a folder HOLDS a controller backup at its top level - which files say so is each
 * brand's call (FANUC: the .va dumps and system files; see the brand's looksLikeBackup).
 * Working program folders hold only program sources.
 */
export function folderHoldsBackup(dir: string): boolean {
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return false; }
  return looksLikeAnyBackup(new Set(names.map(n => n.toLowerCase())));
}

/**
 * Should the wizard leave this subfolder of a robot folder unticked? Its name says backup, or
 * it holds one, or - RUKUS's <robot name>\<batch>\ shape - it has no programs of its own and
 * its subfolders are backups.
 */
export function isBackupLikeDir(dir: string): boolean {
  if (looksLikeBackupFolderName(path.basename(dir)) || folderHoldsBackup(dir)) return true;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return false; }
  if (entries.some(e => e.isFile() && /\.(ls|kl)$/i.test(e.name))) return false;
  const subs = entries.filter(e => e.isDirectory() && !NEVER_DESCEND.has(e.name.toLowerCase()));
  return subs.length > 0 && subs.every(e => looksLikeBackupFolderName(e.name) || folderHoldsBackup(path.join(dir, e.name)));
}

/** One backup of a robot that "Snapshot from Backup Folder" can offer without a Browse dialog. */
export interface BackupCandidate {
  dir: string;
  /** under a folder called Latest: RUKUS's "the current backup of this robot" */
  latest: boolean;
  /** yy-mm-dd from the folder name (or the batch folder above it), when there is one */
  date?: string;
  mtime: number;
}

/**
 * The backups of one robot under `roots`, best first: RUKUS's Latest, then newest by the date in
 * the name, then by modification time.
 *
 * RUKUS keeps a robot's CURRENT backup in <cluster>\Latest\<robot folder> - beside the robot's own
 * archive folder, not in it - so a container cannot find "my robot's current backup" by looking
 * at itself; that was the gap. A folder is this robot's when it holds a backup and either its
 * name reads as the robot ("S002R01_(MD)_260912" -> S002R01, by robotNameFromFolder), or it is a
 * batch folder directly under a folder named for the robot (<robot name>\2026-09-12_14-30).
 * `names` takes several spellings - robot.json's name and the folder's own - compared without
 * case. A backup folder is never descended into, .incoming never entered, and the walk is
 * bounded in depth and count: this runs when a command is pressed.
 */
export function findBackupCandidates(roots: readonly string[], names: readonly string[], maxDepth = 5, limit = 60): BackupCandidate[] {
  const want = new Set(names.map(n => n.trim().toLowerCase()).filter(Boolean));
  const out: BackupCandidate[] = [];
  const seen = new Set<string>();
  let visited = 0;
  const walk = (dir: string, depth: number, underLatest: boolean, parentName: string, parentDate: string | undefined) => {
    const key = path.resolve(dir).toLowerCase();
    if (seen.has(key) || visited++ > 4000 || out.length >= limit) return;
    seen.add(key);
    const base = path.basename(dir);
    if (folderHoldsBackup(dir)) {
      const byName = want.has(robotNameFromFolder(base).toLowerCase());
      const byParent = want.has(parentName.toLowerCase());
      if (byName || byParent) {
        let mtime = 0;
        try { mtime = fs.statSync(dir).mtimeMs; } catch { /* unreadable: sorts last */ }
        out.push({ dir, latest: underLatest, date: folderDate(base) ?? parentDate, mtime });
      }
      return;
    }
    if (depth >= maxDepth) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory() || NEVER_DESCEND.has(e.name.toLowerCase())) continue;
      walk(path.join(dir, e.name), depth + 1, underLatest || /^latest$/i.test(e.name), base, folderDate(base));
    }
  };
  for (const r of roots) walk(r, 0, /(^|[\\/])latest([\\/]|$)/i.test(r), path.basename(path.dirname(r)), undefined);
  return out.sort((a, b) => Number(b.latest) - Number(a.latest) || (b.date ?? '').localeCompare(a.date ?? '') || b.mtime - a.mtime);
}

// ---------------------------------------------------------------------------------------
// Ordering robot folders the way a backup store reads: the current backup first
// ---------------------------------------------------------------------------------------

export interface BackupRank {
  /** the folder is RUKUS's Latest copy (it, or a folder above it, is called Latest) */
  latest: boolean;
  /** `YY-MM-DD` read from the folder's own name, or from the batch folder above it */
  date?: string;
}

/**
 * Where a robot folder stands in a backup store: under `Latest`, or dated. The date is the
 * folder's own (`S002R01_(MD)_260912`, `S002R01_MD_2026-09-12`) or, failing that, the batch
 * folder above it (`2026-08-23_02-50\S002R01_(MD)_260823` - both carry it; an older layout
 * only the batch does).
 */
export function backupRank(dir: string): BackupRank {
  const parts = dir.replace(/[\\/]+$/, '').split(/[\\/]/);
  const latest = parts.some(p => /^latest$/i.test(p));
  const date = folderDate(parts[parts.length - 1] ?? '') ?? (parts.length > 1 ? folderDate(parts[parts.length - 2]) : undefined);
  return { latest, date };
}

/**
 * Sort order for robot folders in the sidebar (beta list 2, item 2): RUKUS's Latest first,
 * then newest date first, then - folders with no date in their name at all - by name. Two
 * folders with the same rank return 0 so the caller can break the tie by label.
 */
export function compareBackupDirs(a: string, b: string): number {
  const ra = backupRank(a), rb = backupRank(b);
  if (ra.latest !== rb.latest) return ra.latest ? -1 : 1;
  if (ra.date !== rb.date) {
    if (!ra.date) return 1;
    if (!rb.date) return -1;
    return rb.date.localeCompare(ra.date);
  }
  return 0;
}
