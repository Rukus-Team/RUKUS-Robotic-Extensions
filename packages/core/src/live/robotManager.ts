/**
 * Robot profiles, connections and the ON-DEMAND fetch model.
 *
 * Read-only: nothing here writes to a robot. And nothing here reads from a robot
 * unless somebody asked for that specific piece of data. A FANUC controller
 * GENERATES each .DG diagnostic file at the moment it is requested, so a background
 * poll is real work for the robot, forever, for data nobody is looking at. Connecting
 * therefore costs one static page, and every panel stays empty until its Get button
 * is pressed. Auto-refresh exists but is off by default and, when on, only re-fetches
 * the units that already have data.
 */
import * as vscode from 'vscode';
import { robotConnectionsEnabled } from '../experimental';
import { httpGet, httpGetText, httpGetBinary, httpList } from './http';
import { ftpGetText, ftpList, FtpClient } from './ftp';
import { robotUri } from './fs';
import { parseControllerInfo, parseCurPos, parsePrgState, parseIoState } from './parsers';
import { isNoAnswer } from './connectionHints';
import { FETCH_KINDS } from './types';
import type { RobotProfile, LiveSnapshot, ConnectionState, RemoteFile, FetchKind, ControllerOptionEntry, OptionHighlight } from './types';
import type { CellControllerSpec } from '../robotContainers';
import { upsertCellController, removeCellController } from '../robotContainers';

/**
 * What this extension has asked of one controller since VS Code started.
 *
 * Kept because "does this bog the robot down?" should be answerable rather than
 * believed. Every read goes through readText / readBinary / listFiles, so a request
 * that is not counted here is a request that bypassed the transport - which is exactly
 * the bug this would be watching for.
 */
export interface RobotTraffic {
  /** requests issued, including the connect probe and failed ones */
  requests: number;
  /** bytes received, as counted by the transport */
  bytes: number;
  /** when the last request was issued, or undefined if none yet */
  lastAt?: number;
  /** what the last request asked for, for the tooltip */
  lastWhat?: string;
}

export interface RobotConnection {
  profile: RobotProfile;
  source: 'workspace' | 'user';
  state: ConnectionState;
  error?: string;
  snapshot?: LiveSnapshot;
  timer?: NodeJS.Timeout;
  busy: boolean;
  traffic: RobotTraffic;
  /** last heartbeat result: true = the controller answered, false = it did not; undefined = not checked yet */
  reachable?: boolean;
  /** when the last heartbeat ran, ms */
  pingedAt?: number;
}

/**
 * Thrown by `connect` when an HTTP profile's web server accepts the TCP connection but never
 * answers - a FANUC controller's HTTP server can wedge like this after a transfer is cut
 * mid-flight - while FTP on the same controller does answer. The command layer turns it into an
 * offer to read over FTP instead.
 */
export class WebServerUnreachableError extends Error {
  constructor(public readonly robot: string, public readonly host: string, public readonly cause?: string) {
    super(`the web server at ${host} is not answering`);
    this.name = 'WebServerUnreachableError';
  }
}

/** The fetch kinds whose file is a register dump, read by the brand's own parser. */
export type RegisterFetchKind = 'numregs' | 'strregs' | 'posregs';

/**
 * Readers for the register dumps, installed by the brand that talks to this controller
 * (FANUC: NUMREG.VA, STRREG.VA, POSREG.VA). Core fetches the file; the brand reads it. Until
 * the live layer becomes a per-brand connector (monorepo phase 4) this is the one seam.
 */
export const registerReaders: Partial<Record<RegisterFetchKind, (snap: LiveSnapshot, text: string) => void>> = {};

/**
 * One fetch unit = one Get button = one file off the controller.
 *
 * `fallback` is only used when the primary 404s. Every unit also fills in whatever
 * controller info the file header happens to carry, because that costs nothing extra.
 */
export interface FetchUnit {
  kind: FetchKind;
  label: string;
  file: string;
  fallback?: string;
  apply(snap: LiveSnapshot, text: string): void;
}

export const FETCH_UNITS: Record<FetchKind, FetchUnit> = {
  // VERSION.DG is the cheapest identity file; PRGSTATE.DG's header carries the same
  // fields on controllers that do not publish it.
  info: { kind: 'info', label: 'Controller info', file: 'VERSION.DG', fallback: 'PRGSTATE.DG', apply: () => { /* header only, and that is applied for every unit */ } },
  position: { kind: 'position', label: 'Current position', file: 'CURPOS.DG', apply: (s, t) => { s.position = parseCurPos(t); } },
  tasks: { kind: 'tasks', label: 'Tasks / running line', file: 'PRGSTATE.DG', apply: (s, t) => { s.tasks = parsePrgState(t); } },
  numregs: { kind: 'numregs', label: 'Numeric registers', file: 'NUMREG.VA', apply: (s, t) => registerReaders.numregs?.(s, t) },
  io: { kind: 'io', label: 'I/O state', file: 'IOSTATE.DG', apply: (s, t) => { s.io = new Map(parseIoState(t).map(p => [`${p.kind}:${p.index}`, p])); } },
  strregs: { kind: 'strregs', label: 'String registers', file: 'STRREG.VA', apply: (s, t) => registerReaders.strregs?.(s, t) },
  posregs: { kind: 'posregs', label: 'Position registers', file: 'POSREG.VA', apply: (s, t) => registerReaders.posregs?.(s, t) },
};

/** what "Get values" on the Registers node pulls in one go */
export const REGISTER_KINDS: FetchKind[] = ['numregs', 'strregs', 'posregs'];

export class RobotManager implements vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<string | undefined>();
  /** fires with the robot name whose data changed (undefined = profile list changed) */
  readonly onDidChange = this._onDidChange.event;
  private readonly _onDidConnect = new vscode.EventEmitter<string>();
  /**
   * Fires once a robot is connected, so the command layer can pull whatever
   * robotCode.live.fetchOnConnect asks for. An event rather than a call inside connect()
   * because one of those things is the file listing, which is the tree's, not ours - and
   * because auto-connect at startup has to take the same path as a button press.
   */
  readonly onDidConnect = this._onDidConnect.event;
  readonly connections = new Map<string, RobotConnection>();
  private readonly disposables: vscode.Disposable[] = [];
  /** guards against a heartbeat overlap while one is still running */
  private heartbeating = false;
  /** one queue per robot: a bulk transfer runs alone, so two sessions never share the wire */
  private readonly transferChains = new Map<string, Promise<unknown>>();
  /** Resolves the cell.json root path for workspace-scoped controller storage. Set by Services. */
  cellRootResolver?: () => string | undefined;

  constructor(private ctx: vscode.ExtensionContext, private output: vscode.OutputChannel) {
    this.loadProfiles();
    this.disposables.push(vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('robotCode.robots')) this.loadProfiles(); }));
    this.disposables.push(vscode.workspace.onDidChangeConfiguration(e => {
      // untick the experimental switch and every open session ends with it
      if (e.affectsConfiguration('robotCode.experimental.robotConnections') && !robotConnectionsEnabled()) for (const c of this.connections.values()) this.disconnect(c.profile.name);
    }));
    if (robotConnectionsEnabled()) for (const c of this.connections.values()) if (c.profile.autoConnect) void this.connect(c.profile.name).catch(() => { /* the error shows on the node */ });
  }

  dispose() { for (const c of this.connections.values()) this.stopAuto(c); for (const d of this.disposables) d.dispose(); this._onDidChange.dispose(); this._onDidConnect.dispose(); }

  // ---- profiles ----
  /** Read profiles from VS Code settings. When cellRoot exists, only workspace-scoped profiles are returned. */
  static readProfiles(cellRoot?: string): RobotProfile[] {
    const cfg = vscode.workspace.getConfiguration('robotCode');
    let raw: any[];
    if (cellRoot) {
      // Cell.json is the source of truth for workspace controllers — only load workspace-scoped settings
      const insp = cfg.inspect<any[]>('robots');
      raw = insp?.workspaceValue ?? [];
    } else {
      raw = cfg.get<any[]>('robots', []);
    }
    const seen = new Set<string>();
    const out: RobotProfile[] = [];
    for (const r of raw) {
      if (!r || typeof r.host !== 'string' || !r.host.trim()) continue;
      const name = String(r.name || r.host).trim();
      if (seen.has(name)) continue; seen.add(name);
      out.push({
        name, host: r.host.trim(), httpPort: Number(r.httpPort) || 80, ftpPort: Number(r.ftpPort) || 21, ftpUser: String(r.ftpUser ?? ''),
        device: String(r.device || 'MD:'), useFtp: !!r.useFtp, pollIntervalMs: Math.max(1000, Number(r.pollIntervalMs) || 5000),
        autoConnect: !!r.autoConnect, autoRefresh: !!r.autoRefresh,
      });
    }
    return out;
  }

  private loadProfiles() {
    const cellRoot = this.cellRootResolver?.();
    const profiles = RobotManager.readProfiles(cellRoot);
    const names = new Set(profiles.map(p => p.name));
    for (const [name, c] of this.connections) if (!names.has(name)) { this.stopAuto(c); this.connections.delete(name); }
    for (const p of profiles) {
      const existing = this.connections.get(p.name);
      if (existing) { existing.profile = p; this.armAuto(existing); }
      else this.connections.set(p.name, { profile: p, source: 'user', state: 'disconnected', busy: false, traffic: { requests: 0, bytes: 0 } });
    }
    this._onDidChange.fire(undefined);
  }

  async addProfile(p: RobotProfile, target?: vscode.ConfigurationTarget): Promise<void> {
    if (target === undefined) {
      const scope = vscode.workspace.getConfiguration('robotCode').get<string>('controllers.scope', 'workspace');
      const cellRoot = this.cellRootResolver?.();
      if (scope === 'workspace' && cellRoot) {
        // Write to cell.json — only connection details, not user preferences
        const spec: CellControllerSpec = { host: p.host };
        if (p.httpPort !== 80) spec.httpPort = p.httpPort;
        if (p.ftpPort !== 21) spec.ftpPort = p.ftpPort;
        if (p.ftpUser) spec.ftpUser = p.ftpUser;
        if (p.device !== 'MD:') spec.device = p.device;
        if (p.useFtp) spec.useFtp = p.useFtp;
        if (p.autoConnect) spec.autoConnect = p.autoConnect;
        if (p.autoRefresh) spec.autoRefresh = p.autoRefresh;
        if (p.pollIntervalMs !== 5000) spec.pollIntervalMs = p.pollIntervalMs;
        upsertCellController(cellRoot, p.name, spec);
        return;
      }
      target = vscode.ConfigurationTarget.Global;
    }
    const cfg = vscode.workspace.getConfiguration('robotCode');
    const cur = cfg.get<any[]>('robots', []).filter(x => x && x.name !== p.name);
    await cfg.update('robots', [...cur, p], target);
  }
  async removeProfile(name: string): Promise<void> {
    // Remove from cell.json if present
    const cellRoot = this.cellRootResolver?.();
    if (cellRoot) removeCellController(cellRoot, name);
    // Also remove from VS Code settings (workspace + global)
    const cfg = vscode.workspace.getConfiguration('robotCode');
    const insp = cfg.inspect<any[]>('robots');
    for (const [arr, target] of [[insp?.workspaceValue, vscode.ConfigurationTarget.Workspace], [insp?.globalValue, vscode.ConfigurationTarget.Global]] as const) {
      if (arr?.some(x => x?.name === name)) await cfg.update('robots', arr.filter(x => x?.name !== name), target);
    }
    await this.ctx.secrets.delete(secretKey(name));
  }

  /**
   * Merge cell.json controller definitions into the profile list.
   * Cell.json is the source of truth for controllers defined there: connection details
   * (host, ports, device, etc.) override settings. Profiles not in cell.json are untouched.
   * Passwords are never stored in cell.json — they stay in SecretStorage.
   *
   * When cell.json defines controllers, global-only profiles (from user settings) that
   * aren't in cell.json are pruned — only cell.json + workspace-scoped profiles survive.
   */
  mergeCellProfiles(defs: Record<string, CellControllerSpec>): void {
    if (Object.keys(defs).length === 0) return;
    let changed = false;

    // Prune: remove connections that aren't in cell.json and aren't in workspace settings
    const insp = vscode.workspace.getConfiguration('robotCode').inspect<any[]>('robots');
    const workspaceNames = new Set((insp?.workspaceValue ?? []).filter(x => x?.name).map(x => x.name));
    for (const [name, c] of this.connections) {
      if (!defs[name] && !workspaceNames.has(name)) {
        this.stopAuto(c);
        this.connections.delete(name);
        changed = true;
      }
    }

    // Merge cell.json controllers (cell wins over settings)
    for (const [name, spec] of Object.entries(defs)) {
      const existing = this.connections.get(name);
      if (existing) {
        // Mark as workspace-sourced and update connection details (cell wins over settings)
        existing.source = 'workspace';
        const updated: RobotProfile = {
          ...existing.profile,
          host: spec.host,
          httpPort: spec.httpPort ?? existing.profile.httpPort,
          ftpPort: spec.ftpPort ?? existing.profile.ftpPort,
          ftpUser: spec.ftpUser ?? existing.profile.ftpUser,
          device: spec.device ?? existing.profile.device,
          useFtp: spec.useFtp ?? existing.profile.useFtp,
          autoConnect: spec.autoConnect ?? existing.profile.autoConnect,
          autoRefresh: spec.autoRefresh ?? existing.profile.autoRefresh,
          pollIntervalMs: spec.pollIntervalMs ?? existing.profile.pollIntervalMs,
        };
        if (JSON.stringify(updated) !== JSON.stringify(existing.profile)) {
          existing.profile = updated;
          changed = true;
        }
      } else {
        // Create a new profile from cell.json definition
        const profile: RobotProfile = {
          name,
          host: spec.host,
          httpPort: spec.httpPort ?? 80,
          ftpPort: spec.ftpPort ?? 21,
          ftpUser: spec.ftpUser ?? '',
          device: spec.device ?? 'MD:',
          useFtp: spec.useFtp ?? false,
          autoConnect: spec.autoConnect ?? false,
          autoRefresh: spec.autoRefresh ?? false,
          pollIntervalMs: spec.pollIntervalMs ?? 5000,
        };
        this.connections.set(name, { profile, source: 'workspace', state: 'disconnected', busy: false, traffic: { requests: 0, bytes: 0 } });
        changed = true;
      }
    }
    if (changed) this._onDidChange.fire(undefined);
  }

  get(name: string): RobotConnection | undefined { return this.connections.get(name); }
  list(): RobotConnection[] { return [...this.connections.values()].sort((a, b) => a.profile.name.localeCompare(b.profile.name)); }
  connected(): RobotConnection[] { return this.list().filter(c => c.state === 'connected' && c.snapshot); }

  async setPassword(name: string, password: string): Promise<void> { await this.ctx.secrets.store(secretKey(name), password); }
  async getPassword(name: string): Promise<string> { return (await this.ctx.secrets.get(secretKey(name))) ?? ''; }

  // ---- connection ----
  /**
   * Connect = prove the controller answers, and nothing else. The probe is a static
   * web-server page (or a bare FTP login), never a .DG file, so the robot is not asked
   * to generate anything. The snapshot starts empty; every panel waits for its Get.
   */
  async connect(name: string): Promise<void> {
    const c = this.connections.get(name);
    if (!c) throw new Error(`Unknown robot ${name}`);
    if (c.state === 'connected' || c.state === 'connecting') return;
    c.state = 'connecting'; c.error = undefined; this._onDidChange.fire(name);
    this.log(name, `connecting to ${c.profile.host} (${c.profile.useFtp ? 'FTP' : 'HTTP'})`);
    try {
      await this.probe(c.profile);
    } catch (e: any) {
      throw await this.failConnect(c, e);
    }
    c.snapshot = emptySnapshot(name);
    c.state = 'connected';
    c.reachable = true; c.pingedAt = Date.now();
    this.log(name, 'connected');
    this._onDidChange.fire(name);
    this._onDidConnect.fire(name);
    this.armAuto(c);
  }

  /**
   * Record a failed connect. When an HTTP profile's web server is unreachable but FTP answers,
   * say so distinctly: the controller's HTTP server is wedged and the answer is to read over FTP.
   */
  private async failConnect(c: RobotConnection, e: any): Promise<Error> {
    const msg = e?.message ?? String(e);
    if (!c.profile.useFtp) {
      try {
        await this.probeFtp(c.profile);
        c.state = 'error'; c.error = 'web server not answering (FTP is)';
        this.log(c.profile.name, 'connect failed: HTTP web server wedged, FTP reachable');
        this._onDidChange.fire(c.profile.name);
        return new WebServerUnreachableError(c.profile.name, c.profile.host, msg);
      } catch { /* FTP is not reachable either: report the HTTP failure below */ }
    }
    c.state = 'error'; c.error = msg;
    this.log(c.profile.name, `connect failed: ${c.error}`);
    this._onDidChange.fire(c.profile.name);
    return e instanceof Error ? e : new Error(msg);
  }

  /** cheapest "is anybody there" check that does not make the controller generate a file */
  private async probe(p: RobotProfile): Promise<void> {
    this.gate();
    if (p.useFtp) { await this.probeFtp(p); return; }
    this.count(p.name, 'connect probe');
    // Any HTTP answer proves the web server is up; the root page is static, and a 404 there
    // still means the controller replied. A server that accepts the TCP connection and then
    // never answers hits httpGet's absolute timeout, so a wedged server is a bounded failure.
    const r = await httpGet({ host: p.host, port: p.httpPort }, '/');
    if (r.status >= 500) throw new Error(`HTTP ${r.status} from ${p.host}`);
  }

  private async probeFtp(p: RobotProfile): Promise<void> {
    this.count(p.name, 'connect probe');
    const c = new FtpClient({ host: p.host, port: p.ftpPort, user: p.ftpUser, password: await this.getPassword(p.name) });
    try { await c.connect(); } finally { await c.quit().catch(() => { /* already closing */ }); }
  }

  /** Keep the option list a brand read for a connected robot on its snapshot, and tell the views. */
  setOptions(name: string, options: ControllerOptionEntry[], highlights: OptionHighlight[] = []): void {
    const c = this.connections.get(name); if (!c?.snapshot) return;
    c.snapshot.options = options; c.snapshot.optionHighlights = highlights; c.snapshot.optionsAt = Date.now();
    this._onDidChange.fire(name);
  }

  disconnect(name: string) {
    const c = this.connections.get(name); if (!c) return;
    this.stopAuto(c);
    c.state = 'disconnected'; c.error = undefined; c.snapshot = undefined;
    c.reachable = undefined; c.pingedAt = undefined;
    this.log(name, 'disconnected');
    this._onDidChange.fire(name);
  }

  /**
   * One cheap reachability check for every connected robot. `connect` proves the controller
   * answered once; this keeps the claim true, so the status bar's "connected" means *answering
   * now* and not *was connected once*. The same probe as connecting (a static web page over
   * HTTP, or a bare FTP login) - it never asks the controller to generate a file. Skipped while
   * a robot is busy (its own request is a check in itself), and sequential, so it never opens
   * FTP sessions on top of one another.
   */
  async heartbeat(): Promise<void> {
    if (this.heartbeating) return;
    this.heartbeating = true;
    try {
      for (const c of this.connections.values()) if (c.state === 'connected' && !c.busy) await this.probeConnection(c);
    } finally { this.heartbeating = false; }
  }

  /** Re-check one robot now (the status bar's click when it is not answering). */
  async ping(name: string): Promise<void> {
    const c = this.connections.get(name);
    if (c && c.state === 'connected' && !c.busy) await this.probeConnection(c);
  }

  /** Does FTP answer for this robot right now? Used to offer an FTP fallback when HTTP is wedged. */
  async ftpReachable(name: string): Promise<boolean> {
    const c = this.connections.get(name);
    if (!c) return false;
    try { await this.probeFtp(c.profile); return true; } catch { return false; }
  }

  /**
   * Run a multi-request transfer as the robot's only in-flight work. A bulky read (Fetch All,
   * a folder fetch, a backup pull) walks many files; the heartbeat and auto-refresh already skip
   * a `busy` robot, so marking the transfer busy stops a probe from opening a second session
   * while the first is mid-flight - the overlap that can wedge a controller's single-session web
   * server. Overlapping transfers queue behind each other, one robot at a time.
   */
  async withTransfer<T>(name: string, fn: () => Promise<T> | Thenable<T>): Promise<T> {
    const c = this.connections.get(name);
    const run = async (): Promise<T> => {
      if (c) c.busy = true;
      try { return await fn(); } finally { if (c) c.busy = false; }
    };
    const prev = this.transferChains.get(name) ?? Promise.resolve();
    const chain = prev.then(run, run);
    this.transferChains.set(name, chain.then(() => undefined, () => undefined));
    return chain;
  }

  private async probeConnection(c: RobotConnection): Promise<void> {
    try { await this.probe(c.profile); c.reachable = true; c.error = undefined; }
    catch (e: any) { c.reachable = false; c.error = e?.message ?? String(e); }
    c.pingedAt = Date.now();
    this._onDidChange.fire(c.profile.name);
  }

  // ---- on-demand fetching ----
  /** has this piece ever been fetched for this robot? */
  has(name: string, kind: FetchKind): boolean {
    return !!this.connections.get(name)?.snapshot?.fetchedAt.has(kind);
  }

  /**
   * Fetch exactly the units asked for - one controller file each - and nothing else.
   * Returns the units that failed, so the caller can surface a single message.
   */
  async fetch(name: string, kinds: FetchKind[]): Promise<FetchKind[]> {
    const c = this.connections.get(name);
    if (!c || c.state !== 'connected' || !c.snapshot) return kinds;
    if (c.busy) return [];
    c.busy = true;
    const failed: FetchKind[] = [];
    try {
      for (const kind of kinds) {
        const unit = FETCH_UNITS[kind];
        try {
          let text: string;
          try { text = await this.readText(c.profile, unit.file); }
          catch (e) { if (!unit.fallback) throw e; text = await this.readText(c.profile, unit.fallback); }
          unit.apply(c.snapshot, text);
          // Free: every controller file header carries F number / version / date.
          Object.assign(c.snapshot.info, stripEmpty(parseControllerInfo(text)));
          c.snapshot.fetchedAt.set(kind, Date.now());
          if (kind !== 'info') c.snapshot.fetchedAt.set('info', Date.now());
          c.snapshot.errors.delete(kind);
          c.reachable = true;
        } catch (e: any) {
          failed.push(kind);
          // no answer at all (refused, timed out, unreachable): red now, not at the next heartbeat
          if (isNoAnswer(e)) { c.reachable = false; c.error = e?.message ?? String(e); c.pingedAt = Date.now(); }
          c.snapshot.errors.set(kind, e?.message ?? String(e));
          this.log(name, `${unit.label}: ${e?.message ?? e}`);
        }
      }
    } finally { c.busy = false; }
    this._onDidChange.fire(name);
    return failed;
  }

  /** re-fetch only what already has data; never pulls something nobody asked for */
  async refresh(name: string): Promise<FetchKind[]> {
    const c = this.connections.get(name);
    if (!c?.snapshot) return [];
    const loaded = FETCH_KINDS.filter(k => k !== 'info' && c.snapshot!.fetchedAt.has(k));
    if (!loaded.length) return [];
    return this.fetch(name, loaded);
  }

  /** turn the timer on/off for one robot and persist it on the profile */
  async setAutoRefresh(name: string, on: boolean): Promise<void> {
    const c = this.connections.get(name); if (!c) return;
    c.profile = { ...c.profile, autoRefresh: on };
    await this.addProfile(c.profile, profileTarget(name));
    this.armAuto(c);
    this.log(name, `auto-refresh ${on ? `on (every ${c.profile.pollIntervalMs} ms)` : 'off'}`);
    this._onDidChange.fire(name);
  }

  /** switch a robot between HTTP and FTP for every read/write, and persist it on the profile */
  async setUseFtp(name: string, on: boolean): Promise<void> {
    const c = this.connections.get(name); if (!c) return;
    c.profile = { ...c.profile, useFtp: on };
    await this.addProfile(c.profile, profileTarget(name));
    this.log(name, `read files over ${on ? 'FTP' : 'HTTP'}`);
    this._onDidChange.fire(name);
  }

  private armAuto(c: RobotConnection) {
    this.stopAuto(c);
    if (!c.profile.autoRefresh || c.state !== 'connected') return;
    const tick = async () => {
      if (c.state !== 'connected' || !c.profile.autoRefresh) return;
      const started = Date.now();
      await this.refresh(c.profile.name);
      if (c.state === 'connected' && c.profile.autoRefresh) c.timer = setTimeout(tick, Math.max(500, c.profile.pollIntervalMs - (Date.now() - started)));
    };
    c.timer = setTimeout(tick, c.profile.pollIntervalMs);
  }
  private stopAuto(c: RobotConnection) { if (c.timer) { clearTimeout(c.timer); c.timer = undefined; } }

  // ---- file access (used by Get, the fanuc:// file system and backup pull) ----
  //
  // EVERY read from a controller goes through these three and the connect probe, and each
  // one is counted. That is what makes the traffic meter and the "no background requests"
  // smoke check meaningful: a request that does not appear in the count is a request that
  // went around the transport.

  /**
   * Every request to a controller starts here - the probe, reads, listings and the one write.
   * With the experimental switch off nothing leaves the PC, whichever path asked.
   */
  private gate() {
    if (!robotConnectionsEnabled()) throw new Error('Robot connections are an experimental feature and are turned off (Settings > Robot Code > Experimental: Robot Connections).');
  }

  /** record one request against a robot, whether it succeeded or not */
  private count(name: string, what: string, bytes = 0) {
    const c = this.connections.get(name);
    if (!c) return;
    c.traffic.requests++;
    c.traffic.bytes += bytes;
    c.traffic.lastAt = Date.now();
    c.traffic.lastWhat = what;
  }

  /** what this extension has asked of a robot since VS Code started */
  traffic(name: string): RobotTraffic | undefined { return this.connections.get(name)?.traffic; }

  async readText(p: RobotProfile, file: string, device = p.device): Promise<string> {
    this.gate();
    const text = p.useFtp
      ? await ftpGetText({ host: p.host, port: p.ftpPort, user: p.ftpUser, password: await this.getPassword(p.name) }, device, file)
      : await httpGetText({ host: p.host, port: p.httpPort }, device, file);
    this.count(p.name, `${device}${file}`, text.length);
    return text;
  }
  /**
   * The ONE write in this tier: a file onto the controller's device, over FTP (the
   * controller's web server takes no uploads). Only "Push to Robot" calls it,
   * after its own confirmation; the reply the controller gives when it refuses (program
   * selected, running, write-protected) comes back as the error.
   */
  async writeBinary(p: RobotProfile, file: string, data: Uint8Array, device = p.device): Promise<void> {
    this.gate();
    const c = new FtpClient({ host: p.host, port: p.ftpPort, user: p.ftpUser || 'anonymous', password: await this.getPassword(p.name) });
    try { await c.connect(); await c.cwd(device); await c.store(file, data); } finally { await c.quit(); }
    this.count(p.name, `${device}${file} (upload)`, data.length);
  }
  async readBinary(p: RobotProfile, file: string, device = p.device): Promise<Uint8Array> {
    this.gate();
    let data: Uint8Array;
    if (p.useFtp) {
      const c = new FtpClient({ host: p.host, port: p.ftpPort, user: p.ftpUser, password: await this.getPassword(p.name) });
      try { await c.connect(); await c.cwd(device); data = await c.retrieve(file); } finally { await c.quit(); }
    } else {
      data = await httpGetBinary({ host: p.host, port: p.httpPort }, device, file);
    }
    this.count(p.name, `${device}${file}`, data.length);
    return data;
  }
  /**
   * Many files, one session. Over FTP this logs in ONCE and RETRs each file on the same
   * control connection, which is the whole difference between a backup that takes half a
   * minute and one that takes ten: the controller's cost is per session, not per byte.
   * Over HTTP each file is its own GET, as it has to be. Each file is counted as it lands.
   */
  async readBinaryMany(
    p: RobotProfile, files: string[], device: string,
    onFile: (name: string, result: { data: Uint8Array } | { error: string }, index: number) => void,
    isCancelled: () => boolean = () => false,
    signal?: AbortSignal,
  ): Promise<void> {
    this.gate();
    const report: typeof onFile = (name, result, i) => {
      this.count(p.name, `${device}${name}`, 'data' in result ? result.data.length : 0);
      onFile(name, result, i);
    };
    if (p.useFtp) {
      const c = new FtpClient({ host: p.host, port: p.ftpPort, user: p.ftpUser, password: await this.getPassword(p.name) });
      const stop = () => isCancelled() || !!signal?.aborted;
      try { await c.connect(); await c.cwd(device); await c.retrieveMany(files, report, stop); }
      finally { await c.quit(); }
      return;
    }
    for (let i = 0; i < files.length; i++) {
      if (isCancelled() || signal?.aborted) return;
      try { report(files[i], { data: await httpGetBinary({ host: p.host, port: p.httpPort }, device, files[i], signal) }, i); }
      catch (e: any) { report(files[i], { error: e?.message ?? String(e) }, i); }
    }
  }
  // ---- the device listing, remembered ----
  //
  // Whoever lists a device (the Files panel, on Get) leaves the listing here, so a CALL in
  // a program opened off the robot can be resolved against it without another request.
  private readonly listings = new Map<string, RemoteFile[]>();
  setFiles(name: string, files: RemoteFile[] | undefined) { if (files) this.listings.set(name.toLowerCase(), files); else this.listings.delete(name.toLowerCase()); }
  hasListing(name: string): boolean { return this.listings.has(name.toLowerCase()); }
  cachedFiles(name: string): RemoteFile[] | undefined { return this.listings.get(name.toLowerCase()); }

  /**
   * `NAME` → the file on the robot's device that is that program: the ASCII `.LS` first,
   * then the compiled `.TP`, then a KAREL `.PC`. Only from the remembered listing - never
   * a request. Robot names arrive lower-cased from a URI authority, so the match is loose.
   */
  resolveRemoteProgram(robot: string, name: string): { uri: vscode.Uri; kind: 'tp' | 'karel' | 'binary'; robot: string; device: string; file: string } | undefined {
    const c = this.connections.get(robot) ?? this.list().find(x => x.profile.name.toLowerCase() === robot.toLowerCase());
    const files = c && this.listings.get(c.profile.name.toLowerCase());
    if (!c || !files) return undefined;
    const upper = name.toUpperCase();
    for (const [ext, kind] of [['.LS', 'tp'], ['.TP', 'binary'], ['.PC', 'binary'], ['.KL', 'karel']] as const) {
      const f = files.find(x => !x.isDir && x.name.toUpperCase() === upper + ext);
      if (f) return { uri: robotUri(c.profile.name, c.profile.device, f.name), kind, robot: c.profile.name, device: c.profile.device, file: f.name };
    }
    return undefined;
  }

  async listFiles(p: RobotProfile, device = p.device): Promise<RemoteFile[]> {
    this.gate();
    // Counted as one request even though httpList may read several index pages - the
    // interesting number is "how many times did we go and ask", and the bytes are exact.
    this.count(p.name, `list ${device}`);
    if (p.useFtp) return ftpList({ host: p.host, port: p.ftpPort, user: p.ftpUser, password: await this.getPassword(p.name) }, device);
    try { return await httpList({ host: p.host, port: p.httpPort }, device); }
    catch (e) {
      // web server listing blocked -> fall back to FTP if a user is configured
      if (p.ftpUser || await this.getPassword(p.name)) return ftpList({ host: p.host, port: p.ftpPort, user: p.ftpUser, password: await this.getPassword(p.name) }, device);
      throw e;
    }
  }

  // ---- lookups used by hovers / decorations ----
  /**
   * Value of a register or I/O point from the first connected robot that has it.
   * Only ever reads the snapshot, so it costs the robot nothing - but the value is
   * as old as the last Get, which is why `age` is part of the result.
   */
  liveValue(kind: string, index: number): { robot: string; text: string; age: number } | undefined {
    for (const c of this.connected()) {
      const s = c.snapshot!;
      const age = (k: FetchKind) => { const t = s.fetchedAt.get(k); return t === undefined ? undefined : Date.now() - t; };
      if (kind === 'R') { const r = s.numregs.get(index); const a = age('numregs'); if (r && a !== undefined) return { robot: c.profile.name, text: String(r.value), age: a }; }
      else if (kind === 'SR') { const r = s.strregs.get(index); const a = age('strregs'); if (r && a !== undefined) return { robot: c.profile.name, text: `'${r.value}'`, age: a }; }
      else if (kind === 'PR') { const r = s.posregs.get(index); const a = age('posregs'); if (r && a !== undefined) return { robot: c.profile.name, text: r.kind === 'uninit' ? 'uninit' : r.summary, age: a }; }
      else { const p = s.io.get(`${kind}:${index}`); const a = age('io'); if (p && a !== undefined) return { robot: c.profile.name, text: `${p.value}${p.simulated ? ' (SIM)' : ''}`, age: a }; }
    }
    return undefined;
  }

  /** TP tasks that are running or paused, across connected robots that have fetched tasks */
  activeTpTasks(): Array<{ robot: string; task: LiveSnapshot['tasks'][number]; age: number }> {
    const out: Array<{ robot: string; task: LiveSnapshot['tasks'][number]; age: number }> = [];
    for (const c of this.connected()) {
      const at = c.snapshot!.fetchedAt.get('tasks');
      if (at === undefined) continue;
      for (const t of c.snapshot!.tasks) if ((t.status === 'RUNNING' || t.status === 'PAUSED' || t.status === 'PAUSING') && t.current) out.push({ robot: c.profile.name, task: t, age: Date.now() - at });
    }
    return out;
  }

  log(robot: string, msg: string) { this.output.appendLine(`[${new Date().toLocaleTimeString()}] [${robot}] ${msg}`); }
  /** bring the connection log to the front (an error's Open Output button) */
  showLog() { this.output.show(true); }
}

function secretKey(name: string) { return `robotCode.ftpPassword.${name}`; }

/** write a profile back where it already lives, so a workspace profile stays in the workspace */
function profileTarget(name: string): vscode.ConfigurationTarget {
  const insp = vscode.workspace.getConfiguration('robotCode').inspect<any[]>('robots');
  return insp?.workspaceValue?.some(x => x?.name === name) ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
}

/** so a file without a Robot Name line does not blank out one we already have */
function stripEmpty<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== '')) as Partial<T>;
}

export function emptySnapshot(robot: string): LiveSnapshot {
  return { robot, fetchedAt: new Map(), info: {}, numregs: new Map(), posregs: new Map(), strregs: new Map(), io: new Map(), tasks: [], errors: new Map() };
}
