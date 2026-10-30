/**
 * Looking for robot controllers on the networks this PC is on. Brand-neutral: a brand gives the
 * ports to try and a probe that says "this is one of mine" (ABB: RWS answers /rw with a 401; FANUC:
 * the controller's web server serves "ROBOT Homepage"); this file finds the addresses.
 *
 * Where it looks:
 *   - this PC (127.0.0.x: simulators such as ROBOGUIDE bind a loopback address per robot);
 *   - a brand's default addresses (ABB's service port is always 192.168.125.1);
 *   - the subnet of every wired adapter, at most the /24 around the PC's own address;
 *   - WiFi adapters only when the user says so: a public or office WiFi is no place to probe.
 *
 * A host is probed only after a plain TCP connect to the port succeeds, so dead addresses cost one
 * short timeout and closed ports one reset. Parsers and planners are pure, so tests drive them.
 *
 * What is not found has to be explainable (Sam: "I had 6 robots today and it said it couldn't find
 * one of them"): what was closed gets a second, slower try, and an open port that a brand does not
 * recognise is reported with why, not dropped.
 */
import * as net from 'node:net';
import * as os from 'node:os';
import { execFile } from 'node:child_process';

export type AdapterKind = 'wired' | 'wifi';

export interface Adapter {
  name: string;
  address: string;
  netmask: string;
  kind: AdapterKind;
}

/** Adapter names that are WiFi whatever the OS says (fallback when `netsh` cannot run). */
const WIFI_NAME = /wi-?fi|wlan|wireless|802\.11/i;
/** Virtual switches, VPNs and container bridges: not where a robot lives. */
const VIRTUAL_NAME = /vethernet|hyper-v|virtualbox|vmware|vmnet|docker|wsl|loopback|tailscale|zerotier|vpn|tap-|tun\d|utun|bluetooth/i;

/** `netsh wlan show interfaces` -> the names of the WiFi adapters (English and most locales: the first "Name" field). */
export function parseNetshWlan(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*Name\s*:\s*(.+?)\s*$/.exec(line);
    if (m) out.push(m[1]);
  }
  return out;
}

/**
 * The PC's IPv4 adapters worth scanning, each marked wired or WiFi. `interfaces` is
 * `os.networkInterfaces()`; `wifiNames` the adapters the OS calls wireless.
 */
export function listAdapters(interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>, wifiNames: readonly string[] = []): Adapter[] {
  const wifi = new Set(wifiNames.map(n => n.toLowerCase()));
  const out: Adapter[] = [];
  for (const [name, infos] of Object.entries(interfaces)) {
    if (VIRTUAL_NAME.test(name)) continue;
    for (const i of infos ?? []) {
      if (i.family !== 'IPv4' || i.internal) continue;
      if (/^169\.254\./.test(i.address)) continue; // no DHCP answer: nothing on that cable
      out.push({ name, address: i.address, netmask: i.netmask, kind: wifi.has(name.toLowerCase()) || WIFI_NAME.test(name) ? 'wifi' : 'wired' });
    }
  }
  return out;
}

/** The WiFi adapter names Windows knows (empty elsewhere, or when `netsh` is blocked). */
export function wifiAdapterNames(): Promise<string[]> {
  if (process.platform !== 'win32') return Promise.resolve([]);
  return new Promise(resolve => execFile('netsh', ['wlan', 'show', 'interfaces'], { windowsHide: true, timeout: 5000 }, (e, out) => resolve(e ? [] : parseNetshWlan(out))));
}

/** This PC's adapters, read now. */
export async function currentAdapters(): Promise<Adapter[]> {
  return listAdapters(os.networkInterfaces(), await wifiAdapterNames());
}

const toInt = (ip: string) => ip.split('.').reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;
const toIp = (n: number) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');

/**
 * The hosts to try on an adapter's subnet: every address of the subnet, but never more than the
 * /24 around the PC's own address (a /16 plant network is 65 000 addresses). The PC itself, the
 * network and the broadcast address are left out.
 */
export function subnetHosts(address: string, netmask: string): string[] {
  const bits = Math.max(24, netmask.split('.').reduce((n, o) => n + (Number(o) >>> 0).toString(2).replace(/0/g, '').length, 0));
  if (bits >= 31) return [];
  const mask = bits === 32 ? 0xffffffff : (0xffffffff << (32 - bits)) >>> 0;
  const self = toInt(address);
  const base = (self & mask) >>> 0;
  const size = 2 ** (32 - bits);
  const out: string[] = [];
  for (let i = 1; i < size - 1; i++) { const n = base + i; if (n !== self) out.push(toIp(n)); }
  return out;
}

/** The most addresses one range may name: a /22, about ten minutes' worth of a slow network at worst. */
export const MAX_RANGE_HOSTS = 1022;

const ipOk = (ip: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(ip) && ip.split('.').every(o => Number(o) <= 255);

/**
 * What a user typed as a range: `192.168.1.0/24`, `10.1.2.50-60`, `10.1.2.50-10.1.3.20` or one address.
 * The addresses, or a sentence saying what is wrong.
 */
export function parseScanRange(text: string): string[] | string {
  const t = text.trim();
  const cidr = /^([\d.]+)\/(\d{1,2})$/.exec(t);
  const span = /^([\d.]+)\s*-\s*([\d.]+)$/.exec(t);
  const first = cidr?.[1] ?? span?.[1] ?? t;
  if (!ipOk(first)) return 'Type an address, a range such as 10.1.2.50-60, or a subnet such as 192.168.1.0/24.';
  if (cidr) {
    const bits = Number(cidr[2]);
    if (bits > 32) return 'A subnet has at most 32 bits.';
    if (2 ** (32 - bits) > MAX_RANGE_HOSTS + 2) return `That is too many addresses: ${MAX_RANGE_HOSTS} at most (a /22).`;
    if (bits >= 31) return [first];
    const size = 2 ** (32 - bits);
    const base = (toInt(first) & ((0xffffffff << (32 - bits)) >>> 0)) >>> 0;
    return Array.from({ length: size - 2 }, (_, i) => toIp(base + i + 1));
  }
  if (!span) return [first];
  const last = span[2].includes('.') ? span[2] : `${first.slice(0, first.lastIndexOf('.'))}.${span[2]}`;
  if (!ipOk(last)) return `${span[2]} is not an address.`;
  const from = toInt(first), to = toInt(last);
  if (to < from) return 'The range ends before it starts.';
  if (to - from + 1 > MAX_RANGE_HOSTS) return `That is too many addresses: ${MAX_RANGE_HOSTS} at most (a /22).`;
  return Array.from({ length: to - from + 1 }, (_, i) => toIp(from + i));
}

/**
 * Every IPv4 address of this PC and what the search does with it, for the log: why an adapter was
 * left out is half of why a robot was not found.
 */
export function describeAdapters(interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>, used: readonly Adapter[], wifi: boolean): string[] {
  const out: string[] = [];
  for (const [name, infos] of Object.entries(interfaces)) {
    for (const i of infos ?? []) {
      if (i.family !== 'IPv4' || i.internal) continue;
      const a = used.find(u => u.name === name && u.address === i.address);
      const hosts = subnetHosts(i.address, i.netmask);
      const covers = hosts.length ? `${hosts[0]} to ${hosts[hosts.length - 1]}` : 'nothing';
      const state = a ? (a.kind === 'wifi' && !wifi ? 'skipped: WiFi' : `searched ${covers}`) : /^169\.254\./.test(i.address) ? 'skipped: no address from the network' : 'skipped: a virtual adapter';
      out.push(`${name}: ${i.address} mask ${i.netmask} - ${state}`);
    }
  }
  return out;
}

/** What a server says first on connecting (an FTP greeting), or undefined when it says nothing in time. */
export function readGreeting(host: string, port: number, timeoutMs = 4000): Promise<string | undefined> {
  return new Promise(resolve => {
    const s = net.connect({ host, port });
    const done = (text?: string) => { s.removeAllListeners(); s.destroy(); resolve(text); };
    s.setTimeout(timeoutMs, () => done());
    s.once('data', d => done(d.toString('latin1').split(/\r?\n/)[0]));
    s.once('error', () => done());
  });
}

/** Does `host` accept a TCP connection on `port` within `timeoutMs`? */
export function tcpOpen(host: string, port: number, timeoutMs = 600): Promise<boolean> {
  return new Promise(resolve => {
    const s = net.connect({ host, port });
    const done = (ok: boolean) => { s.removeAllListeners(); s.destroy(); resolve(ok); };
    s.setTimeout(timeoutMs, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

export interface ScanTarget { host: string; port: number; source: ScanSource }
export type ScanSource = 'local' | 'default' | 'wired' | 'wifi';

/** A port that took the connection, but was not one of the brand's controllers, and why. */
export interface ScanMiss { target: ScanTarget; why: string }

export interface ScanPlan {
  /** loopback hosts, e.g. ROBOGUIDE's 127.0.0.2..; '127.0.0.1' at least */
  local?: readonly string[];
  /** a brand's fixed addresses, e.g. ABB's 192.168.125.1 */
  defaults?: readonly string[];
  /** addresses the user typed: a range of their own */
  hosts?: readonly string[];
  adapters?: readonly Adapter[];
  /** scan WiFi adapters too (the user said yes) */
  wifi?: boolean;
  ports: readonly number[];
}

/** Every host:port to try, once each; the first source that names a host wins (local > default > wired > wifi). */
export function planScan(p: ScanPlan): ScanTarget[] {
  const seen = new Set<string>();
  const out: ScanTarget[] = [];
  const add = (host: string, source: ScanSource) => {
    for (const port of p.ports) {
      const key = `${host}:${port}`;
      if (seen.has(key)) continue;
      seen.add(key); out.push({ host, port, source });
    }
  };
  for (const h of p.local ?? ['127.0.0.1']) add(h, 'local');
  for (const h of p.defaults ?? []) add(h, 'default');
  for (const h of p.hosts ?? []) add(h, 'wired');
  for (const a of p.adapters ?? []) {
    if (a.kind === 'wifi' && !p.wifi) continue;
    for (const h of subnetHosts(a.address, a.netmask)) add(h, a.kind);
  }
  return out;
}

export interface ScanOptions<T> {
  /** what a brand makes of an open port: its finding, or undefined when it is not one of its controllers */
  probe: (t: ScanTarget) => Promise<T | undefined>;
  connectTimeoutMs?: number;
  /** connects in flight at once */
  concurrency?: number;
  /** a second try at everything that did not connect: a loaded controller or a dropped ARP misses the first */
  slowPass?: { connectTimeoutMs: number; concurrency: number };
  /** told of an open port the probe turned down or failed on */
  missed?: (m: ScanMiss) => void;
  signal?: { readonly isCancellationRequested: boolean };
  progress?: (done: number, total: number) => void;
  /** for tests: replaces the TCP connect */
  open?: (host: string, port: number, timeoutMs: number) => Promise<boolean>;
}

/** Try every target; the brand's findings, in target order. */
export async function scan<T>(targets: readonly ScanTarget[], o: ScanOptions<T>): Promise<Array<T & { target: ScanTarget }>> {
  const open = o.open ?? tcpOpen;
  const results: Array<(T & { target: ScanTarget }) | undefined> = new Array(targets.length);
  const closed: number[] = [];
  let done = 0, total = targets.length;
  const look = async (i: number, timeoutMs: number) => {
    const t = targets[i];
    if (!await open(t.host, t.port, timeoutMs)) { closed.push(i); return; }
    try {
      const hit = await o.probe(t);
      if (hit) results[i] = { ...hit, target: t };
      else o.missed?.({ target: t, why: 'not recognised' });
    } catch (e: any) { o.missed?.({ target: t, why: e?.message ?? String(e) }); }
  };
  const pass = async (list: readonly number[], timeoutMs: number, concurrency: number) => {
    let next = 0;
    const worker = async () => {
      while (next < list.length && !o.signal?.isCancellationRequested) {
        await look(list[next++], timeoutMs).catch(() => undefined);
        o.progress?.(++done, total);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, worker));
  };
  await pass(targets.map((_, i) => i), o.connectTimeoutMs ?? 600, o.concurrency ?? 64);
  if (o.slowPass && closed.length) {
    const again = closed.splice(0);
    total += again.length;
    await pass(again, o.slowPass.connectTimeoutMs, o.slowPass.concurrency);
  }
  return results.filter((r): r is T & { target: ScanTarget } => r !== undefined);
}

/** The second pass of a search: about 10 s more per port on a /24, which is what finding the sixth robot costs. */
export const SLOW_PASS = { connectTimeoutMs: 1200, concurrency: 32 };

/** Adapter summary for a prompt: "Wi-Fi (10.0.0.23)". */
export const adapterLabel = (a: Adapter) => `${a.name} (${a.address})`;
