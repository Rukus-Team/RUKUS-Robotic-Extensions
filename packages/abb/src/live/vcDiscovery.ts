/**
 * Finding RobotStudio virtual controllers. A VC listens for Robot Web Services on a port of its
 * own choosing, new at every start, so a profile's port goes stale. The way to it, on this PC only
 * (virtual controllers, never a real one):
 *
 *   1. the VC processes: `vrchost64.exe` (OmniCore, RobotWare 7/8) and `RobVC.exe` (IRC5);
 *   2. the TCP ports each one listens on (`tasklist` for the PIDs, `netstat -ano` for the ports);
 *   3. each port probed for RWS with a 1 s timeout: a 401 from `/rw` says which dialect
 *      (Digest over HTTP: RWS 1.0, IRC5; Basic over HTTPS: RWS 2.0, OmniCore);
 *   4. each RWS port logged into and asked who it is (`/ctrl/identity`, `/rw/system`), so a
 *      profile is matched by controller name, not by a port that changes.
 *
 * When any of it cannot run (not Windows, the commands blocked), the user gets the same steps to
 * do by hand ({@link MANUAL_STEPS}). Parsers and the probe are pure / node-only, so tests drive them.
 */
import * as http from 'node:http';
import * as https from 'node:https';
import { execFile } from 'node:child_process';
import { RwsClient } from '../rws/client';

export const VC_PROCESSES = [
  { image: 'vrchost64.exe', family: 'omnicore' as const },
  { image: 'RobVC.exe', family: 'irc5' as const },
];

export interface VcProcess { image: string; pid: number; family: 'irc5' | 'omnicore' }
export interface VcEndpoint { pid: number; image: string; port: number; family: 'irc5' | 'omnicore'; https: boolean; ctrlName?: string; systemName?: string; systemId?: string; virtual?: boolean; error?: string }

/** `tasklist /FO CSV /NH` -> the VC processes in it. */
export function parseTasklist(csv: string): VcProcess[] {
  const out: VcProcess[] = [];
  for (const line of csv.split(/\r?\n/)) {
    const cells = [...line.matchAll(/"([^"]*)"/g)].map(m => m[1]);
    if (cells.length < 2) continue;
    const kind = VC_PROCESSES.find(p => p.image.toLowerCase() === cells[0].toLowerCase());
    const pid = Number(cells[1]);
    if (kind && Number.isInteger(pid)) out.push({ image: kind.image, pid, family: kind.family });
  }
  return out;
}

/** `netstat -ano -p TCP` (or all protocols) -> the ports each of `pids` listens on, sorted, once each. */
export function parseNetstatListening(text: string, pids: ReadonlySet<number>): Map<number, number[]> {
  const out = new Map<number, Set<number>>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTEN(?:ING)?\s+(\d+)\s*$/i.exec(line);
    if (!m) continue;
    const pid = Number(m[3]);
    if (!pids.has(pid)) continue;
    if (!out.has(pid)) out.set(pid, new Set());
    out.get(pid)!.add(Number(m[2]));
  }
  return new Map([...out].map(([pid, ports]) => [pid, [...ports].sort((a, b) => a - b)]));
}

/**
 * Does `port` speak RWS? One GET of `/rw` with no login, `timeoutMs` each way: HTTP first, then
 * HTTPS. RWS answers 401 and says how it wants the login. Undefined when it is not RWS.
 */
export async function probeRws(host: string, port: number, timeoutMs = 1000): Promise<{ https: boolean; family: 'irc5' | 'omnicore' } | undefined> {
  const once = (secure: boolean) => new Promise<{ status: number; auth: string } | undefined>(resolve => {
    const req = new http.ClientRequest({
      protocol: secure ? 'https:' : 'http:', host, port, path: '/rw', method: 'GET', timeout: timeoutMs,
      agent: new (secure ? https : http).Agent(), ...(secure ? { rejectUnauthorized: false } : {}),
      headers: { Accept: secure ? 'application/hal+json;v=2.0' : 'application/xhtml+xml' },
    }, res => { res.resume(); const a = res.headers['www-authenticate']; resolve({ status: res.statusCode ?? 0, auth: Array.isArray(a) ? a.join(', ') : a ?? '' }); });
    req.on('timeout', () => { req.destroy(); resolve(undefined); });
    req.on('error', () => resolve(undefined));
    req.end();
  });
  const plain = await once(false);
  if (plain && /digest/i.test(plain.auth) && /robapi/i.test(plain.auth)) return { https: false, family: 'irc5' };
  if (plain && plain.status === 401 && /basic/i.test(plain.auth)) return { https: false, family: 'omnicore' };
  const tls = await once(true);
  if (tls && tls.status === 401) return { https: true, family: /digest/i.test(tls.auth) ? 'irc5' : 'omnicore' };
  return undefined;
}

/** Run a Windows command; its stdout, or a thrown error that says the command could not run. */
const run = (cmd: string, args: string[]) => new Promise<string>((resolve, reject) =>
  execFile(cmd, args, { windowsHide: true, timeout: 10_000, maxBuffer: 8 * 1024 * 1024 }, (e, out) => (e ? reject(e) : resolve(out))));

export interface DiscoverOptions {
  /** the login to ask each RWS port who it is; the factory one when omitted */
  user?: string;
  password?: string;
  probeTimeoutMs?: number;
  /** for tests: the commands' output instead of running them */
  tasklist?: () => Promise<string>;
  netstat?: () => Promise<string>;
  host?: string;
}

/**
 * Every virtual controller running on this PC, with its RWS port and, where the login works, its
 * name. Throws (with the reason) when the processes or ports cannot be listed - then the manual
 * steps apply.
 */
export async function discoverVirtualControllers(o: DiscoverOptions = {}): Promise<VcEndpoint[]> {
  if (!o.tasklist && process.platform !== 'win32') throw new Error('finding virtual controllers needs Windows (RobotStudio runs there)');
  const procs = parseTasklist(await (o.tasklist ?? (() => run('tasklist', ['/FO', 'CSV', '/NH'])))());
  if (!procs.length) return [];
  const ports = parseNetstatListening(await (o.netstat ?? (() => run('netstat', ['-ano', '-p', 'TCP'])))(), new Set(procs.map(p => p.pid)));
  const host = o.host ?? '127.0.0.1';
  const found: VcEndpoint[] = [];
  for (const p of procs) {
    for (const port of ports.get(p.pid) ?? []) {
      const rws = await probeRws(host, port, o.probeTimeoutMs ?? 1000);
      if (!rws) continue;
      const ep: VcEndpoint = { pid: p.pid, image: p.image, port, family: rws.family, https: rws.https };
      const cl = new RwsClient({ host, port, family: rws.family, https: rws.https, user: o.user ?? 'Default User', password: o.password ?? 'robotics', timeoutMs: 3000 });
      try {
        const sys = await cl.system();
        ep.systemName = sys.name; ep.systemId = sys.sysid;
        try { const id = await cl.identity(); ep.ctrlName = id.name; ep.virtual = id.virtual; } catch { /* older RobotWare: the system name has to do */ }
      } catch (e: any) { ep.error = e?.message ?? String(e); }
      finally { await cl.logout(); }
      // a process of RobotStudio's that said it is a real controller is not one of ours to touch
      if (ep.virtual !== false) found.push(ep);
    }
  }
  return found;
}

/** The endpoint a profile is for, by controller name (or system id); case does not matter. */
export function matchEndpoint(eps: VcEndpoint[], want: { name?: string; id?: string }): VcEndpoint | undefined {
  const id = want.id?.replace(/^\{|\}$/g, '').toLowerCase();
  if (id) { const hit = eps.find(e => e.systemId?.replace(/^\{|\}$/g, '').toLowerCase() === id); if (hit) return hit; }
  const name = want.name?.trim().toLowerCase();
  return name ? eps.find(e => e.ctrlName?.toLowerCase() === name || e.systemName?.toLowerCase() === name) : undefined;
}

/** What to do by hand when discovery cannot run. */
export const MANUAL_STEPS = [
  'Find a RobotStudio virtual controller\'s RWS port by hand:',
  '1. Start the virtual controller in RobotStudio and wait until it is running.',
  '2. In a terminal: tasklist /FI "IMAGENAME eq vrchost64.exe"  (OmniCore)  or  tasklist /FI "IMAGENAME eq RobVC.exe"  (IRC5) - note the PID.',
  '3. netstat -ano -p TCP | findstr LISTENING | findstr <PID>  - the ports that process listens on.',
  '4. Open http://127.0.0.1:<port>/rw (IRC5) or https://127.0.0.1:<port>/rw (OmniCore) for each: the one that asks for a login is RWS.',
  '5. Put that port in the controller\'s profile (ABB: Edit Connection...), host 127.0.0.1. It changes each time the VC starts.',
].join('\n');
