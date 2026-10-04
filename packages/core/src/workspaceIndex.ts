/**
 * Index of every robot program reachable from the workspace plus any configured controller
 * backup folders. Which files are programs, and what is read out of each, is the business of
 * the brand that owns the file (see brand.ts); the index only keeps and groups the results. Several robots (or several dated backups of the
 * same robot) usually live side by side, so program names are NOT unique: lookups take a
 * "near" file and prefer the program in the same robot folder.
 */
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { config, windowFolders, isHiddenBackup, onDidChangeBackupLists } from './util';
import { programRank, type PartitionKind } from './robotContainers';
import { brandForFile, brandById, brands, programFileGlob, programFileRe, isBinaryProgramFile, isProgramLanguage, type ProgramFacts } from './brand';

export interface ProgramInfo extends ProgramFacts {
  uri: vscode.Uri;
  /** folder used to group programs of the same robot (set by the group resolver) */
  group: string;
  mtime: number;
  /** id of the brand that indexed this file ('fanuc', 'abb') */
  brand: string;
  /**
   * 'true' when this copy comes from a .robocode-robot snapshot rather than a working
   * folder. Reference copies resolve CALLs, callers and cross-references but are hidden
   * from the tree and lose to working copies of the same name in get().
   */
  reference?: boolean;
}

export class WorkspaceIndex implements vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;
  /** fire the change event and drop anything derived from the old contents */
  private changed() { this.findingsCache.clear(); this._onDidChange.fire(); }
  /** name → every program with that name (different robots / backups) */
  private readonly byName = new Map<string, ProgramInfo[]>();
  private readonly byUri = new Map<string, ProgramInfo>();
  private readonly disposables: vscode.Disposable[] = [];
  private refreshing: Promise<void> | undefined;
  private pendingUris = new Map<string, vscode.Uri>();
  private pendingTimer: NodeJS.Timeout | undefined;
  /** group key -> usage findings; dropped whenever the index changes */
  private readonly findingsCache = new Map<string, Map<string, string[]>>();
  /**
   * Maps a file to its robot-folder key. Set by Services to the DataStore's dataset folder;
   * falls back to the file's own directory.
   */
  groupResolver: (uri: vscode.Uri) => string = uri => path.dirname(uri.fsPath).toLowerCase();
  /**
   * Maps a file to the controller backup folder it sits in, or undefined when it is not
   * inside one. Set by Services to the DataStore's dataset folder. Distinct from the group
   * resolver, which always answers something - this one is allowed to say "no backup".
   */
  backupResolver: (uri: vscode.Uri) => string | undefined = () => undefined;
  /**
   * Partition classification for .robocode containers: 'working' files index normally,
   * 'reference' (snapshot) files index with the reference flag, 'excluded' files are
   * invisible to the index, 'unmanaged' (no marker) keeps today's behavior. Set by
   * Services from the ContainerIndex; the default answers 'unmanaged' everywhere, so
   * a workspace without markers behaves exactly as before.
   */
  partitionResolver: (uri: vscode.Uri) => PartitionKind = () => 'unmanaged';
  /**
   * Absolute snapshot directories to walk explicitly. `workspace.findFiles` does not always
   * reach inside `.robocode-robot` (a user `files.exclude`/`search.exclude`, an ignore file, or
   * the file cap), and a container's snapshot must still be indexed as reference copies. Set by
   * Services from the container markers.
   */
  snapshotRoots: () => string[] = () => [];

  /**
   * Folders indexed because a file in them was OPENED, not because they are in the
   * workspace or the backup list. Where the file is, is where its neighbours are.
   */
  private readonly adHocFolders = new Set<string>();

  constructor() {
    const watcher = vscode.workspace.createFileSystemWatcher(programFileGlob());
    this.disposables.push(watcher,
      watcher.onDidCreate(u => this.queue(u)),
      watcher.onDidChange(u => this.queue(u)),
      watcher.onDidDelete(u => { this.remove(u); this.changed(); }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.refresh()),
      onDidChangeBackupLists(() => void this.refresh()),
      vscode.workspace.onDidSaveTextDocument(d => {
        if (!isProgramLanguage(d.languageId)) return;
        // From the saved buffer at once, so the modified-vs-snapshot marker (status bar, tree,
        // lens) is right the moment the file is saved instead of waiting out the disk debounce.
        if (d.uri.scheme === 'file' && this.partitionResolver(d.uri) !== 'excluded') this.indexDocument(d);
        this.queue(d.uri);   // and confirm mtime / partition from disk
      }),
      vscode.workspace.onDidOpenTextDocument(d => void this.track(d)),
    );
  }

  /**
   * A program opened from somewhere the index does not cover is indexed from where it is:
   * a file off a controller (`fanuc://`) from its own text, so its calls are known and it
   * counts as a neighbour for the others opened from that robot; a local file outside the
   * workspace and the backup folders by indexing the folder it sits in.
   */
  async track(doc: vscode.TextDocument): Promise<void> {
    if (!isProgramLanguage(doc.languageId)) return;
    if (doc.uri.scheme === 'fanuc') { this.indexDocument(doc); return; }
    if (doc.uri.scheme !== 'file') return;   // untitled scratch copies, git views: not programs anywhere
    if (vscode.workspace.getWorkspaceFolder(doc.uri)) return;
    const dir = path.dirname(doc.uri.fsPath);
    const lower = dir.toLowerCase();
    if (windowFolders('data.backupFolders').some(b => lower.startsWith(b.replace(/[\\/]+$/, '').toLowerCase()))) return;
    await this.ensureFolder(dir);
  }

  /** index one open document from its text - no file system read, so a robot file costs nothing extra */
  indexDocument(doc: vscode.TextDocument): void {
    const info = indexText(doc.uri, doc.getText(), Date.now(), this.groupResolver(doc.uri));
    this.remove(doc.uri);
    if (!info) return;
    this.byUri.set(doc.uri.toString(), info);
    const arr = this.byName.get(info.name) ?? [];
    arr.push(info); this.byName.set(info.name, arr);
    this.changed();
  }

  /** index the programs of one folder (not its subfolders) that is not otherwise covered */
  async ensureFolder(dir: string): Promise<void> {
    const key = dir.toLowerCase();
    if (this.adHocFolders.has(key)) return;
    this.adHocFolders.add(key);
    let names: string[] = [];
    try { names = fs.readdirSync(dir).filter(n => programFileRe().test(n)); } catch { return; }
    // the same cap the full scan honours: opening one file out of a 5,000-program network
    // dump must not index the dump behind the user's back
    const room = Math.max(0, config<number>('data.maxFiles', 5000) - this.byUri.size);
    if (names.length > room) names = names.slice(0, room);
    for (let i = 0; i < names.length; i += 64) await Promise.all(names.slice(i, i + 64).map(n => this.indexUri(vscode.Uri.file(path.join(dir, n)))));
    this.changed();
  }

  dispose() { for (const d of this.disposables) d.dispose(); this._onDidChange.dispose(); }

  get programCount(): number { return this.byUri.size; }
  groupOf(uri: vscode.Uri): string { return this.groupResolver(uri); }

  /** Re-assign groups after datasets loaded (folders may have become known). */
  regroup() { for (const p of this.byUri.values()) p.group = this.groupResolver(p.uri); this.changed(); }

  /**
   * Program by name. With `near`, the copy in the same robot folder wins; within that a
   * working copy over a snapshot copy, then a source over a compiled binary; then a
   * workspace copy; then the newest. Returns undefined only if no program of that name
   * exists at all.
   */
  get(name: string, near?: vscode.Uri): ProgramInfo | undefined {
    const all = this.byName.get(name.toUpperCase());
    if (!all?.length) return undefined;
    const g = near ? this.groupOf(near) : undefined;
    const rank = (p: ProgramInfo) => programRank(p, g, isInWorkspace(p.uri));
    return [...all].sort((a, b) => rank(a) - rank(b) || b.mtime - a.mtime)[0];
  }
  /** every program with that name, across all robots */
  all(name: string): ProgramInfo[] { return this.byName.get(name.toUpperCase()) ?? []; }
  forUri(uri: vscode.Uri): ProgramInfo | undefined { return this.byUri.get(uri.toString()); }

  /**
   * One program per name per group. A working copy and its snapshot copy are the same
   * program; without this, callers/cross-reference would count both. Prefers the
   * non-reference copy, then the source over a binary, then the newest.
   */
  uniqueByName(programs: ProgramInfo[]): ProgramInfo[] {
    const byKey = new Map<string, ProgramInfo>();
    for (const p of programs) {
      const key = `${p.group}|${p.name}`;
      const prev = byKey.get(key);
      if (!prev) { byKey.set(key, p); continue; }
      const better =
        (prev.reference && !p.reference) ||
        (prev.reference === p.reference && prev.kind === 'binary' && p.kind !== 'binary') ||
        (prev.reference === p.reference && prev.kind === p.kind && p.mtime > prev.mtime);
      if (better) byKey.set(key, p);
    }
    return [...byKey.values()];
  }

  /** programs that CALL/RUN `name`; with `near`, only those in the same robot folder */
  callers(name: string, near?: vscode.Uri): ProgramInfo[] {
    const u = name.toUpperCase();
    const g = near ? this.groupOf(near) : undefined;
    return this.uniqueByName([...this.byUri.values()].filter(p => p.calls.includes(u) && (!g || p.group === g)));
  }

  /** Most common inline comment for a register / I/O point; scoped to the robot folder when `near` is given. */
  inlineComment(kind: string, index: number, near?: vscode.Uri): { comment: string; programs: number } | undefined {
    const key = `${kind}:${index}`;
    const g = near ? this.groupOf(near) : undefined;
    const tally = new Map<string, number>();
    for (const p of this.uniqueByName([...this.byUri.values()].filter(p => !g || p.group === g))) {
      const c = p.inlineComments.get(key);
      if (c) tally.set(c, (tally.get(c) ?? 0) + 1);
    }
    if (!tally.size) return undefined;
    const [comment, programs] = [...tally.entries()].sort((a, b) => b[1] - a[1])[0];
    return { comment, programs };
  }

  /** programs sorted by name; with `near`, only the same robot folder */
  list(near?: vscode.Uri): ProgramInfo[] {
    const g = near ? this.groupOf(near) : undefined;
    return [...this.byUri.values()].filter(p => !g || p.group === g).sort((a, b) => a.name.localeCompare(b.name) || a.group.localeCompare(b.group));
  }
  /**
   * Usage findings for the robot folder a file belongs to, keyed "KIND:index".
   *
   * Computed from the access maps gathered during indexing, so it costs one pass over
   * already-parsed data rather than re-reading the tree — and cached per group, because a
   * diagnostics run happens on every keystroke and this must not. The cache is dropped
   * whenever the index changes, which is the only time the answer can change.
   */
  findings(near?: vscode.Uri): Map<string, string[]> {
    const key = near ? this.groupOf(near) : '*';
    let hit = this.findingsCache.get(key);
    if (!hit) {
      hit = new Map();
      const programs = this.uniqueByName(this.list(near));
      for (const b of brands()) {
        if (!b.usageFindings) continue;
        for (const [k, v] of b.usageFindings(programs.filter(p => p.brand === b.id))) hit.set(k, [...(hit.get(k) ?? []), ...v]);
      }
      this.findingsCache.set(key, hit);
    }
    return hit;
  }

  /**
   * Every program in the same BACKUP as `near` - the whole tree, not just the folder.
   *
   * A register is one thing on one controller, so a change to it belongs to every program
   * that controller runs. The backup is the robot's dataset folder when the file is inside
   * one; failing that, the workspace folder holding it; failing that, its own directory.
   * Subfolders count: a backup that keeps its programs sorted into `PROGS/` and `MACROS/`
   * is still one backup.
   */
  backupOf(near: vscode.Uri): { folder: string; programs: ProgramInfo[] } {
    // a robot's device is its own backup: the programs opened off that robot
    if (near.scheme !== 'file') { const g = this.groupOf(near); return { folder: g, programs: [...this.byUri.values()].filter(p => p.group === g).sort((a, b) => a.name.localeCompare(b.name)) }; }
    const folder = this.backupResolver(near) ?? vscode.workspace.getWorkspaceFolder(near)?.uri.fsPath ?? path.dirname(near.fsPath);
    const root = folder.replace(/[\\/]+$/, '').toLowerCase();
    const programs = [...this.byUri.values()]
      .filter(p => { const f = p.uri.fsPath.toLowerCase(); return f.startsWith(root + path.sep) || f.startsWith(root + '/'); })
      .sort((a, b) => a.name.localeCompare(b.name));
    return { folder, programs };
  }

  /** programs grouped by robot folder key */
  groups(): Map<string, ProgramInfo[]> {
    const out = new Map<string, ProgramInfo[]>();
    for (const p of this.list()) { const arr = out.get(p.group) ?? []; arr.push(p); out.set(p.group, arr); }
    return out;
  }

  refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.doRefresh().finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }

  private queue(uri: vscode.Uri) {
    // A file that became 'excluded' (marker appeared, or was already there) must not be
    // indexed even if it was before - the watcher fires for it like any other.
    if (uri.scheme === 'file') {
      const kind = this.partitionResolver(uri);
      if (kind === 'excluded') { this.remove(uri); this.changed(); return; }
    }
    this.pendingUris.set(uri.toString(), uri);
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    this.pendingTimer = setTimeout(async () => {
      const uris = [...this.pendingUris.values()]; this.pendingUris.clear();
      for (const u of uris) await this.indexUri(u, u.scheme === 'file' && this.partitionResolver(u) === 'reference');
      this.changed();
    }, 400);
  }

  private remove(uri: vscode.Uri) {
    const info = this.byUri.get(uri.toString());
    if (!info) return;
    this.byUri.delete(uri.toString());
    const arr = this.byName.get(info.name);
    if (arr) { const i = arr.indexOf(info); if (i >= 0) arr.splice(i, 1); if (!arr.length) this.byName.delete(info.name); }
  }

  private async doRefresh() {
    this.byName.clear(); this.byUri.clear();
    const max = config<number>('data.maxFiles', 5000);
    const uris: vscode.Uri[] = [];
    const seen = new Set<string>();
    const add = (u: vscode.Uri) => {
      const key = u.scheme === 'file' ? u.fsPath.toLowerCase() : u.toString();
      if (seen.has(key) || uris.length >= max) return;
      seen.add(key);
      uris.push(u);
    };
    if (vscode.workspace.workspaceFolders?.length) {
      for (const u of await vscode.workspace.findFiles(programFileGlob(), '**/node_modules/**', max)) add(u);
    }
    for (const folder of windowFolders('data.backupFolders')) {
      for (const f of walk(folder, max - uris.length)) add(vscode.Uri.file(f));
    }
    // A container's snapshot is walked explicitly: the file search can miss `.robocode-robot`
    // (an exclude pattern, an ignore file, the file cap), and the reference copies are what
    // every working copy is compared against.
    for (const dir of this.snapshotRoots()) {
      for (const f of walk(dir, max - uris.length)) add(vscode.Uri.file(f));
    }
    // container partition: 'excluded' files (backups under a marker, container config)
    // never reach the index; 'reference' (snapshot) files index with their flag
    // a backup removed from the Backup panel takes its programs with it
    const visible = uris.filter(u => u.scheme !== 'file' || (this.partitionResolver(u) !== 'excluded' && !isHiddenBackup(path.dirname(u.fsPath))));
    // index in batches so a 2000-program tree does not open 2000 files at once
    for (let i = 0; i < visible.length; i += 64) await Promise.all(visible.slice(i, i + 64).map(u => this.indexUri(u, u.scheme === 'file' && this.partitionResolver(u) === 'reference')));
    // folders and robot files that were pulled in by opening something stay known
    const adHoc = [...this.adHocFolders]; this.adHocFolders.clear();
    for (const dir of adHoc) await this.ensureFolder(dir);
    for (const d of vscode.workspace.textDocuments) if (d.uri.scheme === 'fanuc') await this.track(d);
    this.changed();
    this.onRefreshed?.(this.rawTokenReport());
  }

  /** set by the extension: called after every full refresh with the backup-level findings */
  onRefreshed: ((report: string[]) => void) | undefined;

  /** one line per robot folder that has bracket arguments the parser could only guess at */
  rawTokenReport(): string[] {
    const out: string[] = [];
    for (const [group, programs] of this.groups()) {
      const hit = programs.filter(p => p.rawTokens > 0 && !p.reference);
      if (!hit.length) continue;
      const n = hit.reduce((s, p) => s + p.rawTokens, 0);
      out.push(`${path.basename(group) || group}: ${n} unrecognised bracket argument${n === 1 ? '' : 's'} in ${hit.length} program${hit.length === 1 ? '' : 's'} (${hit.slice(0, 5).map(p => p.name).join(', ')}${hit.length > 5 ? ', …' : ''}) - read as index + last segment; see the Problems panel when a file is open`);
    }
    return out;
  }

  private async indexUri(uri: vscode.Uri, reference = false) {
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      // A binary is indexed by name alone; its bytes are never read.
      const text = isBinaryProgram(uri) ? '' : Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('latin1');
      const info = indexText(uri, text, stat.mtime, this.groupResolver(uri), reference);
      this.remove(uri);
      if (!info) return;
      // The normalized text is only ever read to count lines against a snapshot copy, and only
      // a program under a robot marker has one. Everywhere else - a plain workspace, a backup
      // folder, a 2000-program network dump - keeping it doubled the index's memory for nothing.
      // The hash stays: it is 8 characters. A marker appearing later rescans, and keeps the text then.
      if (uri.scheme !== 'file' || this.partitionResolver(uri) === 'unmanaged') info.normText = undefined;
      this.byUri.set(uri.toString(), info);
      const arr = this.byName.get(info.name) ?? [];
      arr.push(info); this.byName.set(info.name, arr);
    } catch { /* unreadable, skip */ }
  }
}

function isInWorkspace(uri: vscode.Uri) { return vscode.workspace.getWorkspaceFolder(uri) !== undefined; }

/** a compiled program with no source to read (FANUC .pc / .tp): indexed by name, never read */
export function isBinaryProgram(uri: vscode.Uri | string): boolean {
  return isBinaryProgramFile(typeof uri === 'string' ? uri : uri.path);
}

/** Index one program's text through the brand that owns the file; undefined when no brand does, or it is not a program. */
export function indexText(uri: vscode.Uri, text: string, mtime: number, group: string, reference = false): ProgramInfo | undefined {
  const brand = brandForFile(uri.path);
  const facts = brand?.indexProgram(uri.path, text);
  if (!brand || !facts) return undefined;
  const info: ProgramInfo = { ...facts, uri, group, mtime, brand: brand.id };
  if (reference) info.reference = true;
  return info;
}

/** the brand record behind a program, for callers that need more than the facts */
export function brandOf(p: ProgramInfo) { return brandById(p.brand); }

export function walk(dir: string, limit: number, out: string[] = []): string[] {
  try {
    if (!fs.existsSync(dir)) return out;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (out.length >= limit) break;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, limit, out);
      else if (programFileRe().test(e.name)) out.push(p);
    }
  } catch { /* ignore */ }
  return out;
}
