/**
 * ABB controllers the extension can talk to over Robot Web Services, and what was last read
 * from each. The ABB counterpart of core's RobotManager - kept apart until the live layer is
 * one per-brand connector - with the same rule: the controller is read ONLY when the user asks
 * (Connect, Get, opening a module, a conversion), never on a timer and never from a hover, and
 * nothing is written except what the user confirmed: a Backup, or one of the Actions (actions.ts)
 * through {@link AbbControllers.control} (see rws/client.ts for the full list).
 *
 * Profiles live in the `robotCode.abb.controllers` setting; passwords in VS Code's secret
 * storage, never in settings.
 */
import * as vscode from 'vscode';
import * as os from 'node:os';
import { takeBackup, type BackupProgress, type BackupResult } from './backup';
import { RwsClient, RwsError, type RwsSystem, type RwsPanel, type RwsTask, type RwsPointer, type RwsJointTarget, type RwsRobTarget, type RwsModuleInfo, type RwsModuleText, type RwsSignal, type RwsEvent, type RwsWriteAccess } from '../rws/client';

export interface AbbProfile {
  name: string;
  /**
   * 'irc5' when omitted: RobotWare 6, RWS 1.0. 'omnicore' is RobotWare 7/8, RWS 2.0 - a different
   * protocol (never a fallback of 1.0): the client speaks the one the family says.
   */
  family?: 'irc5' | 'omnicore';
  host: string;
  port?: number;
  https?: boolean;
  /** 'Default User' when omitted */
  user?: string;
  /** the mechanical unit whose position is read; 'ROB_1' when omitted */
  mechUnit?: string;
}

export type AbbState = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface AbbSnapshot {
  system?: RwsSystem;
  panel?: RwsPanel;
  /** who holds write access (RW 8) / mastership (RW 6), read with the state */
  access?: RwsWriteAccess;
  execution?: { state?: string; cycle?: string };
  tasks?: RwsTask[];
  pointers?: Map<string, { program?: RwsPointer; motion?: RwsPointer }>;
  /** the modules loaded in each task */
  modules?: Map<string, RwsModuleInfo[]>;
  joints?: RwsJointTarget;
  tcp?: RwsRobTarget;
  /** read on request (the controller page, the I/O and event log pages) */
  signals?: RwsSignal[];
  events?: RwsEvent[];
  /** when each part was read */
  at: Map<string, number>;
}

export interface AbbConnection {
  profile: AbbProfile;
  /** the RUKUS cluster this controller comes from; undefined for one saved in settings */
  rukusCluster?: string;
  state: AbbState;
  error?: string;
  client?: RwsClient;
  snapshot: AbbSnapshot;
}

const SECRET = (name: string) => `robotCode.abb.password.${name}`;
/** the PIN of the remote control station an OmniCore allows (Request Write Access); secret like a password */
const PIN = (name: string) => `robotCode.abb.stationPin.${name}`;

/** The name this PC registers under as an OmniCore remote control station: what the pendant shows as the holder. */
export function controlStationName(): string { return `Robot Code ${os.hostname()}`.slice(0, 40); }


export class AbbControllers implements vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<string | undefined>();
  readonly onDidChange = this._onDidChange.event;
  private readonly conns = new Map<string, AbbConnection>();
  private readonly subs: vscode.Disposable[] = [];

  constructor(private readonly secrets: vscode.SecretStorage, private readonly output: vscode.OutputChannel) {
    this.load();
    this.subs.push(vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('robotCode.abb.controllers')) { this.load(); this._onDidChange.fire(undefined); } }));
  }

  list(): AbbConnection[] { return [...this.conns.values()]; }
  get(name: string): AbbConnection | undefined { return this.conns.get(name); }
  connected(): AbbConnection[] { return this.list().filter(c => c.state === 'connected'); }

  /** Profiles from the setting; a connection whose profile is unchanged keeps its session. */
  /** the open RUKUS cluster's ABB robots (rukusCluster.ts); they win over a setting of the same name, as cell.json does for FANUC */
  private cluster: { name: string; profiles: AbbProfile[] } | undefined;

  /** The open RUKUS cluster's ABB robots, or none (no cluster open). Keeps a session whose profile did not change. */
  setClusterProfiles(clusterName: string | undefined, profiles: AbbProfile[]) {
    const next = clusterName && profiles.length ? { name: clusterName, profiles } : undefined;
    if (JSON.stringify(next) === JSON.stringify(this.cluster)) return;
    this.cluster = next;
    this.load();
    this._onDidChange.fire(undefined);
  }

  /** the RUKUS cluster a controller comes from, when it does */
  clusterOf(name: string): string | undefined { return this.conns.get(name)?.rukusCluster; }

  private load() {
    const fromCluster = new Set((this.cluster?.profiles ?? []).map(p => p.name.toLowerCase()));
    const saved = vscode.workspace.getConfiguration('robotCode').get<AbbProfile[]>('abb.controllers', [])
      .filter(p => p?.name && p?.host && !fromCluster.has(p.name.toLowerCase()));
    const entries: [AbbProfile, string | undefined][] = [
      ...saved.map(p => [p, undefined] as [AbbProfile, string | undefined]),
      ...(this.cluster?.profiles ?? []).map(p => [p, this.cluster!.name] as [AbbProfile, string | undefined]),
    ];
    const next = new Map<string, AbbConnection>();
    for (const [p, rukusCluster] of entries) {
      const old = this.conns.get(p.name);
      if (old && JSON.stringify(old.profile) === JSON.stringify(p)) { old.rukusCluster = rukusCluster; next.set(p.name, old); }
      else { if (old?.client) void old.client.logout(); next.set(p.name, { profile: p, rukusCluster, state: 'disconnected', snapshot: { at: new Map() } }); }
    }
    for (const [n, c] of this.conns) if (!next.has(n) && c.client) void c.client.logout();
    this.conns.clear();
    for (const [n, c] of next) this.conns.set(n, c);
  }

  async setPassword(name: string, password: string) { await this.secrets.store(SECRET(name), password); }
  async getPassword(name: string) { return this.secrets.get(SECRET(name)); }
  async hasPassword(name: string) { return (await this.secrets.get(SECRET(name))) !== undefined; }
  async forgetPassword(name: string) { await this.secrets.delete(SECRET(name)); await this.secrets.delete(PIN(name)); }
  async setStationPin(name: string, pin: string) { await this.secrets.store(PIN(name), pin); }
  async getStationPin(name: string) { return this.secrets.get(PIN(name)); }
  async forgetStationPin(name: string) { await this.secrets.delete(PIN(name)); }

  /** Whether this session holds write access: RW 6 mastership it took, RW 8 the holder is this PC's control station. */
  holdsAccess(name: string): boolean {
    const c = this.conns.get(name);
    if (!c?.client) return false;
    return c.profile.family === 'omnicore' ? c.snapshot.access?.holder === controlStationName() : c.client.holdsMastership;
  }

  /** Log in and read who the controller is. The password comes from secret storage. */
  async connect(name: string): Promise<void> {
    const c = this.conns.get(name);
    if (!c) throw new Error(`No ABB controller named ${name}.`);
    const password = await this.secrets.get(SECRET(name));
    if (password === undefined) throw new Error(`No password stored for ${name}.`);
    if (c.client) await c.client.logout();
    c.client = new RwsClient({ host: c.profile.host, port: c.profile.port, family: c.profile.family, https: c.profile.https ?? c.profile.family === 'omnicore', user: c.profile.user ?? 'Default User', password });
    c.state = 'connecting'; c.error = undefined; this._onDidChange.fire(name);
    try {
      c.snapshot = { at: new Map() };
      c.snapshot.system = await c.client.system(); c.snapshot.at.set('system', Date.now());
      c.state = 'connected';
      this.log(name, `connected: ${c.snapshot.system.name ?? '?'} RobotWare ${c.snapshot.system.robotWareName ?? c.snapshot.system.robotWare ?? '?'}`);
    } catch (e: any) {
      c.state = 'error'; c.error = e?.message ?? String(e);
      this.log(name, `connect failed: ${c.error}`);
    }
    this._onDidChange.fire(name);
    if (c.state === 'error') throw new Error(c.error);
  }

  async disconnect(name: string): Promise<void> {
    const c = this.conns.get(name);
    if (!c) return;
    if (c.client) { await c.client.logout(); this.log(name, `disconnected after ${c.client.requests} request(s)`); }
    c.client = undefined; c.state = 'disconnected'; c.error = undefined;
    this._onDidChange.fire(name);
  }

  /**
   * Read what the controller view shows: state, RAPID tasks and where their pointers are, and
   * the robot's position. About a dozen small GETs; nothing more is read until the next Get.
   */
  async refresh(name: string, what: ReadonlyArray<'state' | 'tasks' | 'position'> = ['state', 'tasks', 'position']): Promise<void> {
    const c = this.conns.get(name);
    if (!c?.client || c.state !== 'connected') throw new Error(`${name} is not connected.`);
    const s = c.snapshot, cl = c.client, now = () => Date.now();
    const before = cl.requests;
    try {
      if (what.includes('state')) {
        s.panel = await cl.panel(); s.execution = await cl.execution();
        try { s.access = await cl.writeAccess(); } catch { s.access = undefined; }   // an older RobotWare may not have it: not an error
        s.at.set('state', now());
      }
      if (what.includes('tasks')) {
        s.tasks = await cl.tasks();
        s.pointers = new Map(); s.modules = new Map();
        // a task that was never started has no pointer; its read answers with an error, which is not one
        for (const t of s.tasks) {
          try { s.pointers.set(t.name, await cl.pointers(t.name)); } catch { s.pointers.set(t.name, {}); }
          try { s.modules.set(t.name, await cl.modules(t.name)); } catch { s.modules.set(t.name, []); }
        }
        s.at.set('tasks', now());
      }
      if (what.includes('position')) {
        const mu = c.profile.mechUnit ?? 'ROB_1';
        s.joints = await cl.jointTarget(mu); s.tcp = await cl.robTarget(mu); s.at.set('position', now());
      }
      c.error = undefined;
    } catch (e: any) {
      c.error = e?.message ?? String(e);
      this.log(name, `read failed: ${c.error}`);
      this._onDidChange.fire(name);
      throw e;
    } finally {
      this.log(name, `read ${what.join(', ')}: ${cl.requests - before} request(s)`);
    }
    this._onDidChange.fire(name);
  }

  /** The I/O signals or the newest event log messages, read now and kept in the snapshot with their time. */
  async readExtra(name: string, what: 'signals' | 'events'): Promise<void> {
    const c = this.conns.get(name);
    if (!c?.client || c.state !== 'connected') throw new Error(`${name} is not connected.`);
    const before = c.client.requests;
    try {
      if (what === 'signals') c.snapshot.signals = await c.client.signals();
      else c.snapshot.events = await c.client.eventLog(0, 100);
      c.snapshot.at.set(what, Date.now());
    } catch (e: any) { this.log(name, `read ${what} failed: ${e?.message ?? e}`); throw e; }
    finally { this.log(name, `read ${what}: ${c.client.requests - before} request(s)`); }
    this._onDidChange.fire(name);
  }

  /** A module's source from the controller: one read, when the user opens it. */
  async moduleText(name: string, task: string, module: string): Promise<RwsModuleText> {
    const c = this.conns.get(name);
    if (!c?.client || c.state !== 'connected') throw new Error(`${name} is not connected.`);
    const before = c.client.requests;
    try { return await c.client.moduleText(task, module); } finally { this.log(name, `read ${task}/${module}: ${c.client.requests - before} request(s)`); }
  }

  /** WRITE, confirmed by the caller: a backup into $BACKUP/<backupName>, downloaded to <localRoot>/<backupName>. */
  async backup(name: string, backupName: string, localRoot: string, opts: { remove?: boolean; progress?: BackupProgress } = {}): Promise<BackupResult> {
    const c = this.conns.get(name);
    if (!c?.client || c.state !== 'connected') throw new Error(`${name} is not connected.`);
    const before = c.client.requests;
    this.log(name, `backup ${backupName} -> $BACKUP, download to ${localRoot}${opts.remove ? ', then remove it from the controller' : ''}`);
    try {
      const r = await takeBackup(c.client, backupName, localRoot, opts);
      this.log(name, `backup ${backupName}: ${r.files} files, ${(r.bytes / 1024).toFixed(0)} KB in ${(r.ms / 1000).toFixed(1)} s${r.removed ? ', removed from the controller' : ', kept in $BACKUP'}`);
      return r;
    } catch (e: any) {
      this.log(name, `backup ${backupName} failed: ${e?.message ?? e}`);
      throw e;
    } finally { this.log(name, `backup: ${c.client.requests - before} request(s)`); }
  }

  /** The connected client, for a calculation the user asked for (kinematics); logged like a read. */
  async calc<T>(name: string, what: string, fn: (c: RwsClient, mechUnit: string) => Promise<T>): Promise<T> {
    const c = this.conns.get(name);
    if (!c?.client || c.state !== 'connected') throw new Error(`${name} is not connected.`);
    const before = c.client.requests;
    try { return await fn(c.client, c.profile.mechUnit ?? 'ROB_1'); } finally { this.log(name, `${what}: ${c.client.requests - before} request(s)`); }
  }

  /**
   * WRITE, confirmed by the caller: one control action (speed, motors, RAPID start/stop/PP, load a
   * module, a signal, a RAPID value). Logged as a write; what the action changes is read again after.
   * An OmniCore that refuses with 403 is told apart: it needs write access granted on the controller.
   */
  async control<T>(name: string, what: string, fn: (c: RwsClient, conn: AbbConnection) => Promise<T>, reread: ReadonlyArray<'state' | 'tasks' | 'position'> = ['state']): Promise<T> {
    const c = this.conns.get(name);
    if (!c?.client || c.state !== 'connected') throw new Error(`${name} is not connected.`);
    const before = c.client.requests;
    this.log(name, `WRITE ${what}`);
    try {
      return await fn(c.client, c);
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      this.log(name, `WRITE ${what} refused: ${msg}`);
      if (c.profile.family === 'omnicore' && e instanceof RwsError && e.status === 403) {
        const held = c.snapshot.access?.holder;
        const remoteOff = c.snapshot.access?.externalControl === false;
        throw new Error(`${name} refused "${what}": this PC has no write access. RobotWare 7/8 only takes changes from the control station that holds write access${held ? ` (now: ${held})` : ''}. `
          + `${remoteOff ? 'Remote Access is off on this controller: on the FlexPendant open Write Access and turn on Remote Access (long-press the hard button with the speech-bubble icon, or the E-Device button), then request write access. ' : 'Request write access for this PC and grant it on the FlexPendant. '}`
          + `${held ? `${held} has to release it first. ` : ''}(${msg})`);
      }
      throw e;
    } finally {
      this.log(name, `${what}: ${c.client.requests - before} request(s)`);
      try { if (reread.length) await this.refresh(name, reread); } catch { /* the error is on the controller row */ }
    }
  }

  private log(name: string, msg: string) { this.output.appendLine(`[${new Date().toLocaleTimeString()}] ABB ${name}: ${msg}`); }

  dispose() {
    for (const c of this.conns.values()) if (c.client) void c.client.logout();
    for (const d of this.subs) d.dispose();
    this._onDidChange.dispose();
  }
}

/** "12 s ago", "3 min ago" - every reading shows its age: a pointer the robot left minutes ago is not where it is */
export function ago(t: number | undefined): string {
  if (t === undefined) return 'never read';
  const s = Math.round((Date.now() - t) / 1000);
  return s < 60 ? `${s} s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
}
