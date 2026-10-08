/**
 * A Robot Web Services 1.0 client for an IRC5 (RobotWare 6): the ABB side of "talk to the
 * controller", the way packages/core/src/live does it for FANUC over its web server and FTP.
 *
 * Reads are GETs. The requests that are not:
 * - the kinematics calculations (POST `?action=CalcPoseFromJoints` / `JointsFromCartesian` /
 *   `AllJointSolutions`): the controller computes and answers, nothing moves, nothing is stored;
 * - deleting the TEMP copy the controller itself makes of a module too big to send inline
 *   ({@link RwsClient.moduleText});
 * - WRITES, each its own method, each confirmed by the command that calls it (as Upload Program
 *   does for FANUC): {@link RwsClient.startBackup}, {@link RwsClient.deletePath}, and the control
 *   methods (speed, motors, RAPID start/stop/PP, load/unload a module, a signal, a RAPID value,
 *   write access / mastership) - see "control" below.
 *
 * How an IRC5 wants to be spoken to:
 * - HTTP Digest (MD5, qop=auth) on the first request; the controller then hands out a session
 *   cookie (`-http-session-`, `ABBCX`) that later requests carry. A controller has a small
 *   number of sessions (about 70 on RW6) and a client that logs in on every request uses them
 *   up, so the cookie is kept and {@link RwsClient.logout} gives the session back.
 * - One request at a time: the controller's web server is not built for bursts, and a queue
 *   makes "how many requests did that cost" a plain count ({@link RwsClient.requests}).
 * - One kept-alive connection: RW 6 ties mastership to the TCP connection that asked for it and
 *   drops it when that connection closes - a client that opens a socket per request gets 204 for
 *   the request and holds nothing a moment later. VS Code's extension host patches http.request /
 *   https.request to put its proxy agent (a new socket each time) on every request, so requests are
 *   built as ClientRequest with this client's own agent: direct to the controller, never a proxy.
 *
 * An OmniCore (RobotWare 7/8, `family: 'omnicore'`) speaks RWS 2.0 instead, and never 1.0 - the
 * dialect follows the controller family, not a per-request fallback. What differs:
 * - HTTP Basic over HTTPS (self-signed certificate), then the same session cookie; logout is 204.
 * - `Accept: application/hal+json;v=2.0` and HAL+JSON answers (hal.ts turns them into the same
 *   pages), forms as `application/x-www-form-urlencoded;v=2.0`.
 * - A few resources moved: `/rw/panel/ctrl-state`, `/rw/rapid/tasks/{task}/modules[/{m}/text]`,
 *   `/ctrl/backup/state`, `/ctrl/backup/create`. Checked against RobotWare 8.2.1 (RobotStudio VC).
 */
import * as http from 'node:http';
import * as https from 'node:https';
import { createHash, randomBytes } from 'node:crypto';
import { parseRwsPage, itemOf, itemsOf, rwsPosition, decodeXml, type RwsPage } from './xhtml';
import { parseRwsJson } from './hal';

export interface RwsTarget {
  host: string;
  /** 'irc5' (RWS 1.0, the default) or 'omnicore' (RWS 2.0) */
  family?: 'irc5' | 'omnicore';
  /** 80 on the service port and most LANs; RobotStudio's virtual controller uses its own */
  port?: number;
  https?: boolean;
  /** 'Default User' on a controller that was never changed */
  user: string;
  password: string;
  timeoutMs?: number;
}

export class RwsError extends Error {
  constructor(readonly status: number, readonly path: string, message: string) { super(message); }
}

interface DigestChallenge { realm: string; nonce: string; qop?: string; opaque?: string; algorithm?: string }

const md5 = (s: string) => createHash('md5').update(s).digest('hex');

/** `Digest realm="x", nonce="y", qop="auth"` -> fields */
export function parseDigestChallenge(header: string): DigestChallenge | undefined {
  if (!/^\s*Digest\s/i.test(header)) return undefined;
  const f: Record<string, string> = {};
  for (const m of header.replace(/^\s*Digest\s+/i, '').matchAll(/(\w+)\s*=\s*(?:"([^"]*)"|([^,\s]*))/g)) f[m[1].toLowerCase()] = m[2] ?? m[3];
  return f.realm !== undefined && f.nonce ? { realm: f.realm, nonce: f.nonce, qop: f.qop, opaque: f.opaque, algorithm: f.algorithm } : undefined;
}

/** The Authorization header for one request (RFC 2617, MD5, qop=auth when offered). */
export function digestAuthorization(c: DigestChallenge, user: string, password: string, method: string, uri: string, nc: number, cnonce: string): string {
  const ha1 = md5(`${user}:${c.realm}:${password}`);
  const ha2 = md5(`${method}:${uri}`);
  const qop = c.qop?.split(',').map(s => s.trim()).includes('auth') ? 'auth' : undefined;
  const ncHex = nc.toString(16).padStart(8, '0');
  const response = qop ? md5(`${ha1}:${c.nonce}:${ncHex}:${cnonce}:${qop}:${ha2}`) : md5(`${ha1}:${c.nonce}:${ha2}`);
  const parts = [`username="${user}"`, `realm="${c.realm}"`, `nonce="${c.nonce}"`, `uri="${uri}"`, `response="${response}"`];
  if (qop) parts.push(`qop=${qop}`, `nc=${ncHex}`, `cnonce="${cnonce}"`);
  if (c.opaque) parts.push(`opaque="${c.opaque}"`);
  if (c.algorithm) parts.push(`algorithm=${c.algorithm}`);
  return `Digest ${parts.join(', ')}`;
}

export interface RwsSystem { name?: string; robotWare?: string; robotWareName?: string; sysid?: string; started?: string; options: string[] }
export interface RwsPanel { ctrlState?: string; opMode?: string; speedRatio?: number }
export interface RwsTask { name: string; type?: string; taskState?: string; execState?: string; active?: boolean; motion: boolean }
export interface RwsPointer { module: string; routine: string; begin?: { line: number; col: number }; end?: { line: number; col: number } }
export interface RwsModuleInfo { name: string; type: 'ProgMod' | 'SysMod' | string }
/** who holds the right to change the controller: RW 8 write access, RW 6 mastership per domain */
export interface RwsWriteAccess { holder?: string; holderId?: string; free: boolean; externalControl?: boolean; domains?: Record<string, string>; summary: string }
export interface RwsSignal { name: string; type: string; category?: string; value: string; state?: string; path: string }
/** an event log message; type 1 = information, 2 = warning, 3 = error */
export interface RwsEvent { code: number; type: number; time: string; title: string; description?: string; causes?: string; consequences?: string; actions?: string }
export interface RwsJointTarget { robax: number[]; extax: number[] }
export interface RwsRobTarget { trans: [number, number, number]; rot: [number, number, number, number]; robconf: [number, number, number, number]; extax: number[] }

export interface RwsModuleText {
  text: string;
  /** the controller's RAPID change count when read: a later read with the same count is the same text */
  changeCount?: number;
  /** set when the controller sent the module as a file (too big to answer inline) */
  viaFile?: string;
}
/** A pose as RAPID writes it: mm, quaternion q1..q4, [cf1, cf4, cf6, cfx]. */
export interface RwsPose { trans: [number, number, number]; rot: [number, number, number, number]; robconf: [number, number, number, number] }
export interface KinematicsOpts {
  mechUnit?: string;
  /** the tool frame on the flange (tooldata.tframe), mm; the flange (tool0) when omitted */
  tool?: { trans: number[]; rot: number[] };
  /** external axes, mm or degrees; unused (9E9) when omitted */
  extax?: number[];
}

/** `$BACKUP/a b/x.cfg` -> `$BACKUP/a%20b/x.cfg`: each segment encoded, $VARIABLES kept */
const fsPath = (p: string) => p.replace(/^\/+/, '').split('/').map(s => (s.startsWith('$') ? s : encodeURIComponent(s))).join('/');
const rad = (deg: number) => deg * Math.PI / 180;
const deg = (r: number) => r * 180 / Math.PI;
const mm = (m: number) => Math.round(m * 1e6) / 1e3;
const vec = (a: readonly number[]) => `[${a.map(v => +v.toPrecision(10)).join(',')}]`;
/** RWS wants six external axis values; 9E9 means "not used" (and linear axes in metres, rotational in radians - passed as given) */
const extaxOf = (e?: number[]) => Array.from({ length: 6 }, (_, i) => e?.[i] ?? 9e9);
const jointsOf = (f: Record<string, string>) => [1, 2, 3, 4, 5, 6].map(i => deg(Number(f[`robotjoint${i}`])));

export class RwsClient {
  private readonly cookies = new Map<string, string>();
  private challenge: DigestChallenge | undefined;
  private nc = 0;
  private queue: Promise<unknown> = Promise.resolve();
  /** requests sent since construction, including the 401 that starts a session */
  requests = 0;

  /** one socket, kept open between requests: see the note on mastership above */
  private readonly agent: http.Agent;

  constructor(readonly target: RwsTarget) {
    this.agent = new (target.https ? https : http).Agent({ keepAlive: true, maxSockets: 1 });
  }

  get base(): string { return `${this.target.https ? 'https' : 'http'}://${this.target.host}:${this.target.port ?? (this.target.https ? 443 : 80)}`; }
  get hasSession(): boolean { return this.cookies.size > 0; }
  /** RWS 2.0 (OmniCore) rather than 1.0 (IRC5) */
  get rws2(): boolean { return this.target.family === 'omnicore'; }

  /** GET one resource and read it (XHTML on RWS 1.0, HAL+JSON on 2.0) as a page. */
  async page(path: string): Promise<RwsPage> {
    const r = await this.get(path);
    return this.parse(r.body);
  }

  private parse(body: Buffer): RwsPage { return this.rws2 ? parseRwsJson(body.toString('utf8')) : parseRwsPage(body.toString('utf8')); }

  /** GET one resource as raw bytes (fileservice). */
  async bytes(path: string): Promise<Buffer> { return (await this.get(path)).body; }

  /** Give the session back to the controller. Never throws. */
  async logout(): Promise<void> {
    if (!this.cookies.size) return;
    try { await this.get('/logout'); } catch { /* the controller may already have dropped it */ }
    this.cookies.clear();
    this.challenge = undefined;
    this.holdsMastership = false;
    this.agent.destroy();
  }

  // ------------------------------------------------------------------ typed reads

  async system(): Promise<RwsSystem> {
    const p = await this.page('/rw/system');
    // RWS 1.0 'sys-system-li' / 'sys-option-li', RWS 2.0 'sys-system' / 'sys-options'
    const s = (itemOf(p, 'sys-system-li') ?? itemOf(p, 'sys-system'))?.fields ?? {};
    return { name: s.name, robotWare: s.rwversion, robotWareName: s.rwversionname, sysid: s.sysid, started: s.starttm, options: [...itemsOf(p, 'sys-option-li'), ...itemsOf(p, 'sys-options')].map(i => i.fields.option).filter(Boolean) };
  }

  /** controller state, operating mode and speed override: three small reads */
  async panel(): Promise<RwsPanel> {
    const ctrl = itemOf(await this.page(this.rws2 ? '/rw/panel/ctrl-state' : '/rw/panel/ctrlstate'), 'pnl-ctrlstate')?.fields.ctrlstate;
    const op = itemOf(await this.page('/rw/panel/opmode'), 'pnl-opmode')?.fields.opmode;
    const sr = itemOf(await this.page('/rw/panel/speedratio'), 'pnl-speedratio')?.fields.speedratio;
    return { ctrlState: ctrl, opMode: op, speedRatio: sr === undefined ? undefined : Number(sr) };
  }

  async execution(): Promise<{ state?: string; cycle?: string }> {
    const f = itemOf(await this.page('/rw/rapid/execution'), 'rap-execution')?.fields ?? {};
    return { state: f.ctrlexecstate, cycle: f.cycle };
  }

  async tasks(): Promise<RwsTask[]> {
    return itemsOf(await this.page('/rw/rapid/tasks'), 'rap-task-li').map(i => ({
      name: i.fields.name ?? i.title, type: i.fields.type, taskState: i.fields.taskstate, execState: i.fields.excstate,
      active: i.fields.active === undefined ? undefined : /^on$/i.test(i.fields.active), motion: /^true$/i.test(i.fields.motiontask ?? ''),
    }));
  }

  /** where a task's program pointer and motion pointer are (1-based line/col in the module) */
  async pointers(task: string): Promise<{ program?: RwsPointer; motion?: RwsPointer }> {
    const p = await this.page(`/rw/rapid/tasks/${encodeURIComponent(task)}/pcp`);
    const read = (title: string): RwsPointer | undefined => {
      const f = p.items.find(i => i.cls === 'pcp-info' && i.title === title)?.fields;
      // RW 6.16 spells it "modulemame" on the program pointer and "begposition" on the motion pointer
      const module = f?.modulename ?? f?.modulemame;
      if (!f || !module || !f.routinename) return undefined;
      return { module, routine: f.routinename, begin: rwsPosition(f.beginposition ?? f.begposition), end: rwsPosition(f.endposition) };
    };
    return { program: read('progpointer'), motion: read('motionpointer') };
  }

  async modules(task: string): Promise<RwsModuleInfo[]> {
    const at = this.rws2 ? `/rw/rapid/tasks/${encodeURIComponent(task)}/modules` : `/rw/rapid/modules?task=${encodeURIComponent(task)}`;
    return itemsOf(await this.page(at), 'rap-module-info-li').map(i => ({ name: i.fields.name ?? i.title, type: i.fields.type ?? '' }));
  }

  async jointTarget(mechUnit = 'ROB_1'): Promise<RwsJointTarget> {
    const f = itemOf(await this.page(`/rw/motionsystem/mechunits/${encodeURIComponent(mechUnit)}/jointtarget`), 'ms-jointtarget')?.fields ?? {};
    const n = (k: string) => Number(f[k]);
    return { robax: [1, 2, 3, 4, 5, 6].map(i => n(`rax_${i}`)), extax: ['a', 'b', 'c', 'd', 'e', 'f'].map(c => n(`eax_${c}`)) };
  }

  /**
   * the TCP in the given tool and work object (the controller's current ones when omitted).
   * Unused external axes read 9E9.
   */
  async robTarget(mechUnit = 'ROB_1', opts: { tool?: string; wobj?: string; coordinate?: 'Base' | 'World' | 'Tool' | 'Wobj' } = {}): Promise<RwsRobTarget> {
    // RW 6.16 spells the world frame "Word": coordinate=World is an HTTP 400 (RobotStudio VC, 2026-09-25)
    const q = Object.entries(opts).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(k === 'coordinate' && v === 'World' ? 'Word' : v!)}`).join('&');
    const f = itemOf(await this.page(`/rw/motionsystem/mechunits/${encodeURIComponent(mechUnit)}/robtarget${q ? `?${q}` : ''}`), 'ms-robtargets')?.fields ?? {};
    const n = (k: string) => Number(f[k]);
    return {
      trans: [n('x'), n('y'), n('z')], rot: [n('q1'), n('q2'), n('q3'), n('q4')], robconf: [n('cf1'), n('cf4'), n('cf6'), n('cfx')],
      extax: ['a', 'b', 'c', 'd', 'e', 'f'].map(c => n(`eax_${c}`)),
    };
  }

  /**
   * A RAPID data value as the controller formats it (`0`, `[[949.17,...]]`, `"text"`).
   * `module` may be omitted for task-global data.
   */
  async symbol(task: string, name: string, module?: string): Promise<string | undefined> {
    const path = ['RAPID', task, module, name].filter(Boolean).map(s => encodeURIComponent(s!)).join('/');
    return itemOf(await this.page(this.rws2 ? `/rw/rapid/symbol/${path}/data` : `/rw/rapid/symbol/data/${path}`), 'rap-data')?.fields.value;
  }

  /**
   * A loaded module's source, exactly as the controller holds it (a GET, no save). Line numbers
   * match the program and motion pointers. A module too big to answer inline comes back as a
   * `file-path` the controller wrote it to; that copy is read and then deleted - the one write
   * this client makes, and only of a file the controller made for this read.
   */
  async moduleText(task: string, module: string): Promise<RwsModuleText> {
    const url = this.rws2
      ? `/rw/rapid/tasks/${encodeURIComponent(task)}/modules/${encodeURIComponent(module)}/text`
      : `/rw/rapid/modules/${encodeURIComponent(module)}?task=${encodeURIComponent(task)}&resource=module-text`;
    const body = (await this.get(url)).body.toString('utf8');
    const f = itemOf(this.rws2 ? parseRwsJson(body) : parseRwsPage(body), 'rap-module-text')?.fields ?? {};
    const changeCount = f['change-count'] ? Number(f['change-count']) : undefined;
    // not the trimmed field: the text is kept to the character, leading blank lines included
    // (the JSON field already is: hal.ts keeps values as sent)
    const inline = this.rws2 ? f['module-text'] : (() => { const s = /<span class="module-text">([^<]*)<\/span>/.exec(body)?.[1]; return s === undefined ? undefined : decodeXml(s); })();
    const file = f['file-path'];
    if (inline !== undefined && (inline !== '' || !file)) return { text: inline, changeCount };
    if (!file) throw new RwsError(200, `modules/${module}`, `${this.target.host} sent no text for ${task}/${module}`);
    const at = `/fileservice/${fsPath(file)}`;
    try {
      // RAPID files on the controller are Latin-1
      return { text: (await this.get(at)).body.toString('latin1'), changeCount, viaFile: file };
    } finally {
      try { await this.enqueue('DELETE', at); } catch { /* left in TEMP; the controller clears it on restart */ }
    }
  }

  // ------------------------------------------------------------------ files and backup

  /**
   * One folder on the controller: `$HOME`, `$BACKUP/x/SYSPAR`. Follows the listing's `next` link
   * when the controller pages it.
   */
  async listDir(dir: string): Promise<{ dirs: string[]; files: { name: string; size: number }[] }> {
    const out = { dirs: [] as string[], files: [] as { name: string; size: number }[] };
    let at: string | undefined = `/fileservice/${fsPath(dir)}`;
    for (let guard = 0; at && guard < 1000; guard++) {
      const p = await this.page(at);
      for (const i of p.items) {
        if (i.cls === 'fs-dir') out.dirs.push(i.title);
        else if (i.cls === 'fs-file') out.files.push({ name: i.title, size: Number(i.fields['fs-size'] ?? 0) });
      }
      const next: string | undefined = p.links.next;
      at = next ? new URL(next, `http://x${at}`).pathname + new URL(next, `http://x${at}`).search : undefined;
    }
    return out;
  }

  /** a file's bytes */
  async file(pathOnController: string): Promise<Buffer> { return this.bytes(`/fileservice/${fsPath(pathOnController)}`); }

  async exists(pathOnController: string): Promise<boolean> {
    try { await this.get(`/fileservice/${fsPath(pathOnController)}`); return true; } catch (e) {
      if (e instanceof RwsError && e.status === 404) return false;
      throw e;
    }
  }

  /** 'Init State' (none since restart), 'Backup in Progress', 'Backup Ready' (the last one finished), 'Error during backup', ... */
  async backupState(): Promise<string | undefined> {
    const f = itemOf(await this.page(this.rws2 ? '/ctrl/backup/state' : '/ctrl/backup?action=backupstate'), 'ctrl-backup-state')?.fields;
    return f?.['backup state'] ?? f?.['backup-state'];
  }

  /**
   * WRITE: ask the controller for a backup into `dest` (`$BACKUP/<name>`), as the FlexPendant's
   * Backup does; RAPID keeps running. Returns when the controller has accepted it (202), not when
   * it is done: poll {@link backupState}. RW 6.16 wants the destination as a fileservice path.
   */
  async startBackup(dest: string): Promise<void> {
    const value = `/fileservice/${dest.replace(/^\/+/, '')}`;
    // RW 8.2 takes the form value as written (RUKUS captured it raw); RW 6.16 takes it encoded
    if (this.rws2) await this.enqueue('POST', '/ctrl/backup/create', undefined, `backup=${value}`);
    else await this.enqueue('POST', '/ctrl/backup?action=backup', { backup: value });
  }

  /** WRITE: delete a file or a whole folder (one request, recursive) on the controller. */
  async deletePath(pathOnController: string): Promise<void> {
    await this.enqueue('DELETE', `/fileservice/${fsPath(pathOnController)}`);
  }

  // ------------------------------------------------------------------ control (WRITES)
  // Each one changes what the controller does; the command that calls it asks first. RW 6 wants
  // RAPID mastership held for RAPID edits (load, unload, PP, data) and given back after; RW 8 has
  // no such step but refuses (403) until the user has write access - granted on the FlexPendant.

  /** WRITE: the speed override, 0-100 %. */
  async setSpeedRatio(percent: number): Promise<void> {
    const v = String(Math.max(0, Math.min(100, Math.round(percent))));
    await this.enqueue('POST', this.rws2 ? '/rw/panel/speedratio' : '/rw/panel/speedratio?action=setspeedratio', { 'speed-ratio': v });
  }

  /** WRITE: motors on or off (on needs AUTO, or the enabling device held in manual). */
  async setMotors(on: boolean): Promise<void> {
    await this.enqueue('POST', this.rws2 ? '/rw/panel/ctrl-state' : '/rw/panel/ctrlstate?action=setctrlstate', { 'ctrl-state': on ? 'motoron' : 'motoroff' });
  }

  /** WRITE: program pointer to Main, every task. */
  async resetProgramPointer(): Promise<void> {
    await this.withRapidMastership(() => this.enqueue('POST', this.rws2 ? '/rw/rapid/execution/resetpp' : '/rw/rapid/execution?action=resetpp', {}));
  }

  /** WRITE: start RAPID from the program pointer - THE ROBOT MOVES. `once` runs the program one cycle. */
  async startRapid(cycle: 'once' | 'forever' = 'once'): Promise<void> {
    await this.enqueue('POST', this.rws2 ? '/rw/rapid/execution/start' : '/rw/rapid/execution?action=start',
      { regain: 'continue', execmode: 'continue', cycle, condition: 'none', stopatbp: 'disabled', alltaskbytsp: 'false' });
  }

  /** WRITE: stop RAPID (all normal tasks). */
  async stopRapid(): Promise<void> {
    await this.enqueue('POST', this.rws2 ? '/rw/rapid/execution/stop' : '/rw/rapid/execution?action=stop', { stopmode: 'stop', usetsp: 'normal' });
  }

  /** WRITE: put a file on the controller (`$HOME/x.mod`), replacing one of that name. */
  async uploadFile(pathOnController: string, data: Buffer): Promise<void> {
    await this.enqueue('PUT', `/fileservice/${fsPath(pathOnController)}`, undefined, undefined, data);
  }

  /** WRITE: load a module file that is on the controller (`$HOME/x.mod`) into a task. */
  async loadModule(task: string, modulePath: string, replace = true): Promise<void> {
    const t = encodeURIComponent(task);
    await this.withRapidMastership(() => this.enqueue('POST', this.rws2 ? `/rw/rapid/tasks/${t}/loadmod` : `/rw/rapid/tasks/${t}?action=loadmod`, { modulepath: modulePath, replace: String(replace) }));
  }

  /** WRITE: unload a module from a task. */
  async unloadModule(task: string, module: string): Promise<void> {
    const t = encodeURIComponent(task);
    await this.withRapidMastership(() => this.enqueue('POST', this.rws2 ? `/rw/rapid/tasks/${t}/unloadmod` : `/rw/rapid/tasks/${t}?action=unloadmod`, { module }));
  }

  /** WRITE: set a signal (`path` as {@link signals} gives it, e.g. `Local/DRV_1/DO1`). */
  async setSignal(path: string, value: string): Promise<void> {
    const p = path.split('/').map(encodeURIComponent).join('/');
    await this.enqueue('POST', this.rws2 ? `/rw/iosystem/signals/${p}/set-value` : `/rw/iosystem/signals/${p}?action=set`, { lvalue: value });
  }

  /** WRITE: a RAPID data value, written as RAPID writes it (`5`, `TRUE`, `"text"`, `[1,2,3]`). */
  async setRapidData(task: string, name: string, value: string, module?: string): Promise<void> {
    const p = ['RAPID', task, module, name].filter(Boolean).map(s => encodeURIComponent(s!)).join('/');
    await this.withRapidMastership(() => this.enqueue('POST', this.rws2 ? `/rw/rapid/symbol/${p}/data` : `/rw/rapid/symbol/data/${p}?action=set`, { value }));
  }

  /**
   * RW 6: hold RAPID mastership around `fn` and give it back (also when `fn` fails) - unless the
   * user holds mastership with {@link requestWriteAccess}, which a single edit must not give away.
   * RW 8: just `fn`.
   */
  private async withRapidMastership<T>(fn: () => Promise<T>): Promise<T> {
    if (this.rws2 || this.holdsMastership) return fn();
    await this.enqueue('POST', '/rw/mastership/rapid?action=request', {});
    try { return await fn(); } finally {
      try { await this.enqueue('POST', '/rw/mastership/rapid?action=release', {}); } catch { /* held until the session ends; the controller frees it then */ }
    }
  }

  /** RW 6: mastership taken with {@link requestWriteAccess} and not yet released by this session */
  holdsMastership = false;

  /**
   * WRITE: ask for the right to change the controller, and keep it until {@link releaseWriteAccess}
   * (or the session ends). RW 8: write access for this session's control station
   * (`/rw/controlstation/writeaccess/request`); a PC must first be registered as a remote control
   * station - `station` does that, with the id and PIN the controller is configured to allow - and
   * the pendant's Remote Access must be on. RW 6: mastership of every domain (RAPID, configuration,
   * motion), which a pendant user cannot take while this session holds it.
   */
  async requestWriteAccess(station?: { name: string; id: string; pin: string }): Promise<void> {
    if (!this.rws2) {
      await this.enqueue('POST', '/rw/mastership?action=request', {});
      this.holdsMastership = true;
      return;
    }
    if (station) await this.registerRemote(station);
    await this.enqueue('POST', '/rw/controlstation/writeaccess/request', {});
  }

  /** WRITE: register this session as a remote control station (RW 8), before asking for write access. */
  async registerRemote(station: { name: string; id: string; pin: string }): Promise<void> {
    await this.enqueue('POST', '/rw/controlstation/register/remote', {
      'control-station-name': station.name, 'control-station-id': station.id, pincode: station.pin, 'release-write-access-when-lost': 'true',
    });
  }

  /** WRITE: give write access (RW 8) / every domain's mastership (RW 6) back. */
  async releaseWriteAccess(): Promise<void> {
    if (this.rws2) { await this.enqueue('POST', '/rw/controlstation/writeaccess/release', {}); return; }
    try { await this.enqueue('POST', '/rw/mastership?action=release', {}); } finally { this.holdsMastership = false; }
  }

  /**
   * Who holds the right to change the controller (a read). RW 8: the control station holding write
   * access (`/rw/controlstation/writeaccess/status`). RW 6: mastership of RAPID, configuration and
   * motion - `nomaster`, `local` (the FlexPendant) or `remote` (an RWS/PC SDK client).
   */
  async writeAccess(): Promise<RwsWriteAccess> {
    if (this.rws2) {
      const f = itemOf(await this.page('/rw/controlstation/writeaccess/status'), 'controlstation-write-access-status')?.fields ?? {};
      const name = f['held-by-control-station-name'];
      const holder = name && name !== 'none' ? name : undefined;
      const id = f['held-by-control-station-Id'];
      return {
        holder, holderId: id && id !== 'none' ? id : undefined,
        free: !holder,
        externalControl: /^true$/i.test(f['control-station-external-control-enabled'] ?? ''),
        // "external control" is the pendant's Remote Access switch: off, no other control station may even ask
        summary: `${holder ? `held by ${holder}` : 'free'}${/^true$/i.test(f['control-station-external-control-enabled'] ?? '') ? '' : ' · remote access off'}`,
      };
    }
    const domains: Record<string, string> = {};
    for (const d of ['rapid', 'cfg', 'motion']) {
      try { domains[d] = itemOf(await this.page(`/rw/mastership/${d}`), 'msh-resource')?.fields.mastership ?? '?'; } catch { domains[d] = '?'; }
    }
    const held = Object.entries(domains).filter(([, v]) => v !== 'nomaster' && v !== '?');
    const by = (v: string) => (v === 'local' ? 'the FlexPendant' : v === 'remote' ? 'a remote client' : v);
    const holders = [...new Set(held.map(([, v]) => by(v)))];
    return {
      holder: holders.length ? holders.join(', ') : undefined,
      free: !held.length,
      domains,
      summary: held.length ? `${held.map(([d]) => d === 'cfg' ? 'configuration' : d === 'rapid' ? 'RAPID' : d).join(' + ')} held by ${holders.join(', ')}` : 'free',
    };
  }

  // ------------------------------------------------------------------ I/O and event log (reads)

  /** Every signal: name, type (DI/DO/AI/AO/GI/GO), value and the path {@link setSignal} takes. Follows `next` pages. */
  async signals(): Promise<RwsSignal[]> {
    const out: RwsSignal[] = [];
    let at: string | undefined = '/rw/iosystem/signals?limit=100';
    for (let guard = 0; at && guard < 200; guard++) {
      const p = await this.page(at);
      for (const i of itemsOf(p, 'ios-signal-li')) {
        const self = i.links.self ?? '';
        const path = decodeURIComponent(self.replace(/^.*?signals\//, '').replace(/[?;].*$/, '')) || i.fields.name || i.title;
        out.push({ name: i.fields.name ?? i.title, type: i.fields.type ?? '', category: i.fields.category, value: i.fields.lvalue ?? '', state: i.fields.lstate, path });
      }
      const next: string | undefined = p.links.next?.replace(/&amp;/g, '&');
      at = next ? new URL(next, `http://x/rw/iosystem/`).pathname + new URL(next, `http://x/rw/iosystem/`).search : undefined;
    }
    return out;
  }

  /** The newest event log messages of one category (0 = common), newest first. */
  async eventLog(domain = 0, limit = 50): Promise<RwsEvent[]> {
    // RW 6 pages newest first with order=lifo. RW 8 refuses lifo and lists oldest first, and its
    // `start` is a PAGE number (1-based), not a message number: read the category's count, start at
    // the page that holds the oldest message wanted, read to the end, keep the newest `limit` and
    // turn them round. Both hand out at most 50 a page, so `next` is followed.
    const pageSize = Math.min(limit, 50);
    let start = '';
    if (this.rws2) {
      const n = Number(itemsOf(await this.page('/rw/elog?lang=en'), 'elog-domain-li').find(i => i.title === String(domain))?.fields.numevts ?? 0);
      if (!n) return [];
      start = `&start=${Math.floor((Math.max(1, n - limit + 1) - 1) / pageSize) + 1}`;
    }
    const list: RwsEvent[] = [];
    let at: string | undefined = `/rw/elog/${domain}?lang=en&limit=${pageSize}${this.rws2 ? start : '&order=lifo'}`;
    for (let guard = 0; at && (this.rws2 || list.length < limit) && guard < 100; guard++) {
      const p = await this.page(at);
      const items = itemsOf(p, 'elog-message-li');
      for (const i of items) list.push({
        code: Number(i.fields.code), type: Number(i.fields.msgtype), time: i.fields.tstamp ?? '', title: i.fields.title ?? '',
        description: i.fields.desc, causes: i.fields.causes, consequences: i.fields.conseqs, actions: i.fields.actions,
      });
      const next: string | undefined = p.links.next?.replace(/&amp;/g, '&');
      at = items.length && next ? new URL(next, `http://x/rw/elog/`).pathname + new URL(next, `http://x/rw/elog/`).search : undefined;
    }
    return this.rws2 ? list.slice(-limit).reverse() : list.slice(0, limit);
  }

  // ------------------------------------------------------------------ kinematics
  // The controller's own model, Absolute Accuracy included: calculations only (POST ?action=,
  // but nothing moves and nothing is stored). RWS takes and gives METERS and RADIANS; these
  // methods take and give millimetres and degrees, as RAPID writes them.

  /** Forward kinematics: the flange (or `tool` frame on it) in the base frame for these joints. */
  async poseFromJoints(robax: number[], opts: KinematicsOpts = {}): Promise<RwsPose> {
    const r = await this.enqueue('POST', this.calcPath(opts.mechUnit, 'CalcPoseFromJoints'), {
      rob_joints: vec(robax.map(rad)), ext_joints: vec(extaxOf(opts.extax)), ...this.toolForm(opts),
    });
    const f = itemOf(this.parse(r.body), 'position-from-joint')?.fields ?? {};
    const n = (k: string) => Number(f[k]);
    return {
      // metres to mm, to the micrometre: RWS answers in 7 digits, the rest is float noise
      trans: [mm(n('position-x')), mm(n('position-y')), mm(n('position-z'))],
      rot: [0, 1, 2, 3].map(i => n(`robtargetorientation-u${i}`)) as RwsPose['rot'],
      robconf: ['j1', 'j4', 'j6', 'jx'].map(j => n(`quarter-rev-${j}`)) as RwsPose['robconf'],
    };
  }

  /** Inverse kinematics: the solution for `pose` in its `robconf` nearest to `near` (degrees). */
  async jointsFromPose(pose: RwsPose, near: number[] = [0, 0, 0, 0, 0, 0], opts: KinematicsOpts = {}): Promise<number[]> {
    const p = this.parse((await this.enqueue('POST', this.calcPath(opts.mechUnit, 'JointsFromCartesian'), this.ikForm(pose, near, opts))).body);
    return jointsOf(itemOf(p, 'joints-from-cartesian')?.fields ?? {});
  }

  /** Every joint solution for `pose`, whatever its configuration, each with the robconf it has. */
  async allJointSolutions(pose: RwsPose, opts: KinematicsOpts = {}): Promise<{ joints: number[]; robconf: RwsPose['robconf'] }[]> {
    const p = this.parse((await this.enqueue('POST', this.calcPath(opts.mechUnit, 'AllJointSolutions'), this.ikForm(pose, [0, 0, 0, 0, 0, 0], opts))).body);
    // RW 6.16 names the first one quarter_rev_j11
    return itemsOf(p, 'all-joint-solutions').map(i => ({ joints: jointsOf(i.fields), robconf: ['j11', 'j4', 'j6', 'jx'].map(j => Number(i.fields[`quarter_rev_${j}`] ?? i.fields[`quarter_rev_${j.slice(0, 2)}`])) as RwsPose['robconf'] }));
  }

  private mechUnitPath(mechUnit = 'ROB_1') { return `/rw/motionsystem/mechunits/${encodeURIComponent(mechUnit)}`; }

  /** RWS 1.0: `?action=CalcPoseFromJoints` on the mechunit; RWS 2.0 (RW 8.2): a resource of its own, same form fields */
  private calcPath(mechUnit: string | undefined, action: 'CalcPoseFromJoints' | 'JointsFromCartesian' | 'AllJointSolutions'): string {
    const rws2 = { CalcPoseFromJoints: 'pose-from-joints', JointsFromCartesian: 'joints-from-cartesian', AllJointSolutions: 'all-joints-solution' }[action];
    return this.rws2 ? `${this.mechUnitPath(mechUnit)}/${rws2}` : `${this.mechUnitPath(mechUnit)}?action=${action}`;
  }

  private toolForm(opts: KinematicsOpts): Record<string, string> {
    const t = opts.tool ?? { trans: [0, 0, 0], rot: [1, 0, 0, 0] };
    return { tool_frame_position: vec(t.trans.map(v => v / 1000)), tool_frame_orientation: vec(t.rot), robot_fixed_object: 'FALSE', elog_at_error: 'FALSE' };
  }

  private ikForm(pose: RwsPose, near: number[], opts: KinematicsOpts): Record<string, string> {
    const ext = vec(extaxOf(opts.extax));
    return {
      curr_position: vec(pose.trans.map(v => v / 1000)), curr_orientation: vec(pose.rot), curr_ext_joints: ext,
      old_rob_joints: vec(near.map(rad)), old_ext_joints: ext, robot_configuration: vec(pose.robconf), ...this.toolForm(opts),
    };
  }

  // ------------------------------------------------------------------ transport

  private get(path: string): Promise<{ status: number; body: Buffer }> { return this.enqueue('GET', path); }

  private enqueue(method: string, path: string, form?: Record<string, string>, rawForm?: string, file?: Buffer): Promise<{ status: number; body: Buffer }> {
    const body = file ?? rawForm ?? (form ? Object.entries(form).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&') : undefined);
    const run = () => this.send(method, path, body);
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async send(method: string, path: string, body?: string | Buffer, retried = false): Promise<{ status: number; body: Buffer }> {
    const headers: Record<string, string> = { Accept: this.rws2 ? 'application/hal+json;v=2.0' : 'application/xhtml+xml, text/html, */*' };
    if (body !== undefined) {
      // a Buffer is a file's bytes (an upload), a string is a form
      const kind = Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/x-www-form-urlencoded';
      headers['Content-Type'] = this.rws2 ? `${kind};v=2.0` : kind;
      headers['Content-Length'] = String(Buffer.byteLength(body));
    }
    if (this.cookies.size) headers.Cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    // RWS 2.0: Basic on every request (HTTPS); the session cookie keeps it to one session
    if (this.rws2) headers.Authorization = `Basic ${Buffer.from(`${this.target.user}:${this.target.password}`).toString('base64')}`;
    else if (this.challenge) headers.Authorization = digestAuthorization(this.challenge, this.target.user, this.target.password, method, path, ++this.nc, randomBytes(8).toString('hex'));
    const r = await this.raw(method, path, headers, body);
    for (const c of r.setCookies) { const m = /^\s*([^=;\s]+)=([^;]*)/.exec(c); if (m) this.cookies.set(m[1], m[2]); }
    if (r.status === 401 && this.rws2) throw new RwsError(401, path, `${this.target.host} refused the login for "${this.target.user}" - check the user name and password`);
    if (r.status === 401 && !retried) {
      const ch = parseDigestChallenge(r.authenticate ?? '');
      if (!ch) throw new RwsError(401, path, `${this.target.host} asked for a login this client does not speak (${r.authenticate ?? 'no WWW-Authenticate'})`);
      // a stale session cookie is what a controller restart leaves behind: start over
      this.cookies.clear();
      this.challenge = ch; this.nc = 0;
      return this.send(method, path, body, true);
    }
    if (r.status === 401) throw new RwsError(401, path, `${this.target.host} refused the login for "${this.target.user}" - check the user name and password`);
    if (r.status >= 400) throw new RwsError(r.status, path, `${this.target.host}: HTTP ${r.status} on ${path}${retcodeOf(r.body)}`);
    return { status: r.status, body: r.body };
  }

  private raw(method: string, path: string, headers: Record<string, string>, body?: string | Buffer, again = false): Promise<{ status: number; body: Buffer; setCookies: string[]; authenticate?: string }> {
    this.requests++;
    return new Promise((resolve, reject) => {
      // not http.request: see the note on VS Code's proxy patch at the top
      const req = new http.ClientRequest({
        protocol: this.target.https ? 'https:' : 'http:', host: this.target.host, port: this.target.port ?? (this.target.https ? 443 : 80), method, path, headers, agent: this.agent,
        // a controller's certificate is self-signed on every IRC5/OmniCore out of the box
        ...(this.target.https ? { rejectUnauthorized: false } : {}),
        timeout: this.target.timeoutMs ?? 5000,
      }, res => {
        const chunks: Buffer[] = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const sc = res.headers['set-cookie'];
          const wa = res.headers['www-authenticate'];
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks), setCookies: Array.isArray(sc) ? sc : sc ? [sc] : [], authenticate: Array.isArray(wa) ? wa.find(w => /digest/i.test(w)) : wa });
        });
      });
      req.on('timeout', () => req.destroy(new Error(`${this.target.host} did not answer within ${(this.target.timeoutMs ?? 5000) / 1000} s`)));
      // RW 6 mastership lives as long as the connection: when it closes, nothing is held any more
      req.on('socket', sock => { if (!(sock as any).__rwsWatched) { (sock as any).__rwsWatched = true; sock.once('close', () => { this.holdsMastership = false; }); } });
      req.on('error', (e: NodeJS.ErrnoException) => {
        // a kept-alive socket the controller closed while idle: send once more on a new one
        if (!again && req.reusedSocket && e.code === 'ECONNRESET') resolve(this.raw(method, path, headers, body, true));
        else reject(e);
      });
      req.end(body);
    });
  }
}

/**
 * RWS puts an error's code in the body as `<a href=".../retcode?code=-1073414145" rel="error">`
 * (RW 6.16: `<span class="code">`), and on RW 6.16 a reason in `<span class="msg">`, prefixed
 * with the controller's source file: `C:\BUILDAGENTS\...
ws_resource_motionsystem.cpp[923] Invalid resource parameter value code:-1073445879 icode:-1`.
 */
export function retcodeOf(body: Buffer): string {
  const t = body.toString('utf8');
  // RWS 2.0 says it in JSON: { "status": { "code": -1073414145, "msg": "..." } } or "code"/"msg" fields
  const code = /retcode\?code=(-?\d+)/.exec(t)?.[1] ?? /<span class="code">\s*(-?\d+)/.exec(t)?.[1] ?? /"code"\s*:\s*"?\s*(-\d+)/.exec(t)?.[1];
  // "... reason code:-1073445879 icode:-1" (rws_*) or "... reason -1073414146 -1" (fileservice)
  const msg = (/<span class="msg">([^<]*)/.exec(t)?.[1] ?? /"msg"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(t)?.[1])?.replace(/^.*\.(?:cpp|c)\[\d+\]\s*/, '').replace(/\s*(?:code:\s*-?\d+\s*icode:\s*-?\d+|-?\d+\s+-?\d+)\s*$/, '').trim();
  return [msg ? `: ${msg}` : '', code ? ` (RWS return code ${code})` : ''].join('');
}
