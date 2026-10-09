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
import { setLiveSignalSource, type SignalType } from '../signals';
import { StatusWatch, type StatusUpdate } from './liveStatus';
import { identityMismatch, expectationOf, controllerLabel, type ControllerIdentity, type ExpectedController } from './identity';
import { cfgInstances, ipSettings, wirelessEnabled, reachability, type PortSetting, type Reachability } from './network';
import { rememberEvents, type EventCatalog } from './eventCatalog';
import { takeBackup, type BackupProgress, type BackupResult } from './backup';
import { RwsClient, RwsError, type RwsSystem, type RwsPanel, type RwsTask, type RwsPointer, type RwsJointTarget, type RwsRobTarget, type RwsModuleInfo, type RwsModuleText, type RwsSignal, type RwsEvent, type RwsWriteAccess, type RwsIdentity, isControlStationId, newControlStationId } from '../rws/client';

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
  /**
   * The controller this profile is for, by its own name (/ctrl/identity ctrl-name) and system id
   * (/rw/system sysid). Optional: without them the first controller that answers is remembered.
   * A different controller at the same address is refused (identity.ts).
   */
  controllerName?: string;
  controllerId?: string;
}

export type AbbState = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface AbbSnapshot {
  system?: RwsSystem;
  /** `/ctrl/identity`, read on Connect: name, id, virtual or real */
  identity?: RwsIdentity;
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
  /** the ports and their addresses, and whether the controller can be reached off the service port (network.ts) */
  network?: { ports: PortSetting[]; wireless?: boolean; reach: Reachability };
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
  /**
   * Does the controller answer now? `connected` says it answered once; this keeps it true. False
   * after a dropped event socket, a failed poll, or a read that got no answer - the status is red
   * then until the controller answers again. Undefined while not connected.
   */
  reachable?: boolean;
  /** keeps state, mode and execution current: RWS events, polling as the fallback (liveStatus.ts) */
  watch?: StatusWatch;
  /** this PC's RW 8 control station id for this controller ({@link AbbControllers.stationId}) */
  stationId?: string;
}

const SECRET = (name: string) => `robotCode.abb.password.${name}`;
/** the PIN of the remote control station an OmniCore allows (Request Write Access); secret like a password */
const PIN = (name: string) => `robotCode.abb.stationPin.${name}`;
/** the GUID this PC registers under as that remote control station (RW 8); kept so the holder stays the same */
const STATION = (name: string) => `robotCode.abb.stationGuid.${name}`;
/** the controller (name, system id) a profile met at its first connect, in globalState */
const IDENTITY = (name: string) => `robotCode.abb.identity.${name}`;
/** the event codes read from controllers, in globalState (eventCatalog.ts) */
const EVENT_CATALOG = 'robotCode.abb.eventCatalog';

/** The name this PC registers under as an OmniCore remote control station: what the pendant shows as the holder. */
export function controlStationName(): string { return `Robot Code ${os.hostname()}`.slice(0, 40); }


export class AbbControllers implements vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<string | undefined>();
  readonly onDidChange = this._onDidChange.event;
  private readonly conns = new Map<string, AbbConnection>();
  private readonly subs: vscode.Disposable[] = [];

  /** `memento` keeps which controller each profile met first (identity.ts); without one nothing is remembered */
  constructor(private readonly secrets: vscode.SecretStorage, private readonly output: vscode.OutputChannel, private readonly memento?: vscode.Memento) {
    this.load();
    // RAPID completion offers the signals a connected controller has read (signals.ts)
    setLiveSignalSource(() => this.connected().flatMap(c => (c.snapshot.signals ?? [])
      .filter(x => /^(DI|DO|AI|AO|GI|GO)$/.test(x.type))
      .map(x => ({ name: x.name, type: x.type as SignalType, device: x.path.split('/').slice(-2, -1)[0] || undefined }))));
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
      else { if (old) void this.endSession(old); next.set(p.name, { profile: p, rukusCluster, state: 'disconnected', snapshot: { at: new Map() } }); }
    }
    for (const [n, c] of this.conns) if (!next.has(n)) void this.endSession(c);
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

  /**
   * This PC's control station id for a controller (RW 8): a GUID in braces, made once and kept.
   * Any GUID is taken (checked on RobotWare 8.2.1); keeping it makes the holder the pendant shows,
   * and `held-by-control-station-Id`, the same from one session to the next.
   */
  async stationId(name: string): Promise<string> {
    const kept = await this.secrets.get(STATION(name));
    if (kept && isControlStationId(kept)) { const c = this.conns.get(name); if (c) c.stationId = kept; return kept; }
    const id = newControlStationId();
    await this.secrets.store(STATION(name), id);
    const c = this.conns.get(name); if (c) c.stationId = id;
    return id;
  }

  /**
   * Whether this session holds write access. RW 8: the status names this PC's control station id as
   * the holder (`held-by-control-station-Id`). RW 6/7: mastership this session took.
   */
  holdsAccess(name: string): boolean {
    const c = this.conns.get(name);
    if (!c?.client) return false;
    if (!c.client.usesControlStation) return c.client.holdsMastership;
    const holderId = c.snapshot.access?.holderId?.toLowerCase();
    return !!holderId && holderId === c.stationId?.toLowerCase();
  }

  /**
   * Writes to an OmniCore are let through on a virtual controller only: write access and a write
   * were proved on a RobotWare 8.2.1 VC, not yet on a real controller. A real OmniCore stays
   * read-only until `robotCode.abb.allowRealOmniCoreWrites` is turned on (to validate one).
   * Undefined when writes may go ahead, else why not.
   */
  writeBlocked(name: string): string | undefined {
    const c = this.conns.get(name);
    if (!c || c.profile.family !== 'omnicore') return undefined;
    if (c.snapshot.identity?.virtual === true) return undefined;
    if (vscode.workspace.getConfiguration('robotCode').get<boolean>('abb.allowRealOmniCoreWrites', false)) return undefined;
    const what = c.snapshot.identity?.virtual === false ? `a real OmniCore (${c.snapshot.identity.type ?? 'not virtual'})` : 'an OmniCore that did not say it is virtual';
    return `${name} is ${what}. Changing an OmniCore has been checked on RobotStudio virtual controllers only, so on a real one this extension only reads. To validate a real controller, turn on "robotCode.abb.allowRealOmniCoreWrites".`;
  }

  /** The controller as it described itself on Connect (/ctrl/identity and /rw/system). */
  identityOf(c: AbbConnection): ControllerIdentity {
    const s = c.snapshot;
    return { ctrlName: s.identity?.name, ctrlId: s.identity?.id, systemName: s.system?.name, systemId: s.system?.sysid, virtual: s.identity?.virtual, robotWare: s.system?.robotWareName ?? s.system?.robotWare };
  }

  /** The controller a profile is for: as set in the profile, else as remembered from its first connect. */
  expected(c: AbbConnection): ExpectedController | undefined {
    if (c.profile.controllerId || c.profile.controllerName) return { id: c.profile.controllerId, name: c.profile.controllerName };
    return this.memento?.get<ExpectedController>(IDENTITY(c.profile.name));
  }

  /** Every event code this PC has read from a controller, with its title, cause and remedy (eventCatalog.ts). */
  eventCatalog(): EventCatalog { return this.memento?.get<EventCatalog>(EVENT_CATALOG) ?? {}; }

  /** Keep what a controller's event log said, for looking codes up later. */
  async rememberEvents(controller: string, events: readonly RwsEvent[]): Promise<void> {
    if (!this.memento || !events.length) return;
    const cat = { ...this.eventCatalog() };
    if (rememberEvents(cat, events, controller)) this.log(controller, `event catalogue: ${Object.keys(cat).length} codes`);
    await this.memento.update(EVENT_CATALOG, cat);
  }

  /** Forget the remembered controller, so the next Connect takes whichever one answers (not one set in the profile). */
  async forgetIdentity(name: string): Promise<void> { await this.memento?.update(IDENTITY(name), undefined); }

  /** Log in and read who the controller is. The password comes from secret storage. */
  async connect(name: string): Promise<void> {
    const c = this.conns.get(name);
    if (!c) throw new Error(`No ABB controller named ${name}.`);
    const password = await this.secrets.get(SECRET(name));
    if (password === undefined) throw new Error(`No password stored for ${name}.`);
    await this.endSession(c);
    c.client = new RwsClient({ host: c.profile.host, port: c.profile.port, family: c.profile.family, https: c.profile.https ?? c.profile.family === 'omnicore', user: c.profile.user ?? 'Default User', password });
    c.state = 'connecting'; c.error = undefined; this._onDidChange.fire(name);
    try {
      c.snapshot = { at: new Map() };
      c.snapshot.system = await c.client.system(); c.snapshot.at.set('system', Date.now());
      // virtual or real, and the controller's own name and id (an older RobotWare may not have it)
      try { c.snapshot.identity = await c.client.identity(); } catch { c.snapshot.identity = undefined; }
      // which controller answered, by its own name and id: the address cannot say (every service port is 192.168.125.1)
      const seen = this.identityOf(c);
      const mismatch = identityMismatch(name, c.profile.host, this.expected(c), seen);
      if (mismatch) throw new Error(mismatch);
      if (!this.expected(c)?.id && (seen.systemId || seen.ctrlId)) await this.memento?.update(IDENTITY(name), expectationOf(seen));
      if (c.profile.family === 'omnicore') c.stationId = (await this.secrets.get(STATION(name))) ?? c.stationId;
      c.state = 'connected'; c.reachable = true;
      this.log(name, `connected: ${controllerLabel(seen) ?? '?'}${seen.systemId ? ` (system id ${seen.systemId})` : ''}${seen.virtual ? ', virtual' : ''}, RobotWare ${c.snapshot.system.robotWareName ?? c.snapshot.system.robotWare ?? '?'}`);
      await this.startWatch(c);
    } catch (e: any) {
      c.state = 'error'; c.reachable = undefined; c.error = e?.message ?? String(e);
      await this.endSession(c).catch(() => undefined);   // give back a session a wrong controller opened
      this.log(name, `connect failed: ${c.error}`);
    }
    this._onDidChange.fire(name);
    if (c.state === 'error') throw new Error(c.error);
  }

  async disconnect(name: string): Promise<void> {
    const c = this.conns.get(name);
    if (!c) return;
    const requests = c.client?.requests;
    await this.endSession(c);
    if (requests !== undefined) this.log(name, `disconnected after ${requests} request(s)`);
    c.client = undefined; c.state = 'disconnected'; c.error = undefined; c.reachable = undefined;
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
      c.error = undefined; c.reachable = true;
    } catch (e: any) {
      c.error = e?.message ?? String(e);
      this.noAnswer(c, e);
      this.log(name, `read failed: ${c.error}`);
      this._onDidChange.fire(name);
      throw e;
    } finally {
      this.log(name, `read ${what.join(', ')}: ${cl.requests - before} request(s)`);
    }
    this._onDidChange.fire(name);
  }

  /**
   * The I/O signals, the newest event log messages, or the network setup (network.ts), read now
   * and kept in the snapshot with their time.
   */
  async readExtra(name: string, what: 'signals' | 'events' | 'network'): Promise<void> {
    const c = this.conns.get(name);
    if (!c?.client || c.state !== 'connected') throw new Error(`${name} is not connected.`);
    const before = c.client.requests;
    try {
      if (what === 'signals') c.snapshot.signals = await c.client.signals();
      else if (what === 'events') { c.snapshot.events = await c.client.eventLog(0, 100); await this.rememberEvents(name, c.snapshot.events); }
      else {
        const ports = ipSettings(cfgInstances(await c.client.cfg('SIO', 'IP_SETTING')));
        // no wireless gateway type on this RobotWare is not an error: there is none
        let wireless: boolean | undefined;
        try { wireless = wirelessEnabled(cfgInstances(await c.client.cfg('SIO', 'CSGW_WIRELESS'))); } catch (e) { if (!(e instanceof RwsError)) throw e; }
        c.snapshot.network = { ports, wireless, reach: reachability(c.profile.family === 'omnicore' ? 'omnicore' : 'irc5', ports, wireless, c.snapshot.system?.options ?? []) };
      }
      c.snapshot.at.set(what, Date.now());
    } catch (e: any) { this.log(name, `read ${what} failed: ${e?.message ?? e}`); if (this.noAnswer(c, e)) this._onDidChange.fire(name); throw e; }
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
    // a real OmniCore only reads until one has been validated; stopping RAPID is never held back
    const blocked = what === 'RAPID stop' ? undefined : this.writeBlocked(name);
    if (blocked) { this.log(name, `WRITE ${what} not sent: ${blocked}`); throw new Error(blocked); }
    const before = c.client.requests;
    this.log(name, `WRITE ${what}`);
    try {
      return await fn(c.client, c);
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      this.log(name, `WRITE ${what} refused: ${msg}`);
      if (this.noAnswer(c, e)) this._onDidChange.fire(name);
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

  /** Start keeping the status current: RWS events first, polling when they cannot be had. */
  private async startWatch(c: AbbConnection): Promise<void> {
    const name = c.profile.name, client = c.client!;
    const watch = new StatusWatch(client, {
      update: (u: StatusUpdate) => {
        if (c.watch !== watch) return;
        const s = c.snapshot;
        s.panel = { ...s.panel, ...(u.ctrlState !== undefined ? { ctrlState: u.ctrlState } : {}), ...(u.opMode !== undefined ? { opMode: u.opMode } : {}) };
        s.execution = { ...s.execution, ...(u.execState !== undefined ? { state: u.execState } : {}), ...(u.cycle !== undefined ? { cycle: u.cycle } : {}) };
        this._onDidChange.fire(name);
      },
      reachable: (ok, why) => {
        if (c.watch !== watch || c.state !== 'connected') return;
        const was = c.reachable;
        c.reachable = ok;
        if (!ok) c.error = `not answering: ${why ?? 'no reply'}`;
        else if (c.error?.startsWith('not answering')) c.error = undefined;
        if (was !== ok) { this.log(name, ok ? 'answering again' : `not answering: ${why ?? 'no reply'}`); this._onDidChange.fire(name); }
      },
      log: msg => this.log(name, msg),
    });
    c.watch = watch;
    await watch.start();
  }

  /** Stop the status watch and give the session back. */
  private async endSession(c: AbbConnection): Promise<void> {
    const w = c.watch; c.watch = undefined;
    try { await w?.stop(); } catch { /* best effort */ }
    if (c.client) await c.client.logout();
  }

  /** A failure with no answer from the controller (refused, timed out, reset) makes it not reachable. True when that changed. */
  private noAnswer(c: AbbConnection, e: unknown): boolean {
    if (e instanceof RwsError && e.status > 0) return false;
    if (c.reachable === false) return false;
    c.reachable = false;
    return true;
  }

  private log(name: string, msg: string) { this.output.appendLine(`[${new Date().toLocaleTimeString()}] ABB ${name}: ${msg}`); }

  dispose() {
    for (const c of this.conns.values()) void this.endSession(c);
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
