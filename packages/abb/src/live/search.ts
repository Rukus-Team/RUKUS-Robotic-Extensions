/**
 * Searching for ABB controllers: the RobotStudio virtual controllers on this PC (vcDiscovery.ts),
 * the service port address every ABB controller has (192.168.125.1), and the subnets of the PC's
 * wired adapters (WiFi only when the user said yes). Robot Web Services answers on 80 (IRC5, RWS
 * 1.0) or 443 (OmniCore, RWS 2.0) of a real controller; each open port is asked `/rw` with no
 * login, and each RWS one who it is.
 */
import { scan, planScan, type Adapter, type ScanTarget, type ScanSource } from '@core/live/netScan';
import { RwsClient } from '../rws/client';
import { probeRws, discoverVirtualControllers } from './vcDiscovery';
import { SERVICE_PORT_IP } from './network';

export const ABB_DEFAULT_HOSTS = [SERVICE_PORT_IP];
export const ABB_RWS_PORTS = [80, 443];

export interface AbbFound {
  host: string;
  port: number;
  family: 'irc5' | 'omnicore';
  https: boolean;
  source: ScanSource;
  ctrlName?: string;
  systemName?: string;
  systemId?: string;
  virtual?: boolean;
  /** why the login to ask its name failed (the controller is still there) */
  error?: string;
}

export interface AbbSearchOptions {
  adapters: readonly Adapter[];
  wifi: boolean;
  user?: string;
  password?: string;
  signal?: { readonly isCancellationRequested: boolean };
  progress?: (done: number, total: number) => void;
  /** for tests */
  findVirtual?: () => Promise<AbbFound[]>;
  open?: (host: string, port: number, timeoutMs: number) => Promise<boolean>;
}

/** Log in once and ask the controller its name; the login is the factory one unless given. */
export async function identifyRws(host: string, port: number, rws: { https: boolean; family: 'irc5' | 'omnicore' }, user = 'Default User', password = 'robotics'): Promise<Pick<AbbFound, 'ctrlName' | 'systemName' | 'systemId' | 'virtual' | 'error'>> {
  const out: Pick<AbbFound, 'ctrlName' | 'systemName' | 'systemId' | 'virtual' | 'error'> = {};
  const cl = new RwsClient({ host, port, family: rws.family, https: rws.https, user, password, timeoutMs: 3000 });
  try {
    const sys = await cl.system();
    out.systemName = sys.name; out.systemId = sys.sysid;
    try { const id = await cl.identity(); out.ctrlName = id.name; out.virtual = id.virtual; } catch { /* older RobotWare: the system name has to do */ }
  } catch (e: any) { out.error = e?.message ?? String(e); }
  finally { await cl.logout(); }
  return out;
}

/** The virtual controllers on this PC as search findings; none when discovery cannot run. */
async function virtualOnes(user?: string, password?: string): Promise<AbbFound[]> {
  try {
    return (await discoverVirtualControllers({ user, password })).map(e => ({
      host: '127.0.0.1', port: e.port, family: e.family, https: e.https, source: 'local' as const,
      ctrlName: e.ctrlName, systemName: e.systemName, systemId: e.systemId, virtual: e.virtual, error: e.error,
    }));
  } catch { return []; }
}

/** The network part of the search: what to try. Loopback is the virtual controllers' (by process, not by address). */
export function abbTargets(adapters: readonly Adapter[], wifi: boolean): ScanTarget[] {
  return planScan({ local: [], defaults: ABB_DEFAULT_HOSTS, adapters, wifi, ports: ABB_RWS_PORTS });
}

/** Every ABB controller found: virtual ones first, then the network, each host:port once. */
export async function searchAbbControllers(o: AbbSearchOptions): Promise<AbbFound[]> {
  const local = await (o.findVirtual ?? (() => virtualOnes(o.user, o.password)))();
  const remote = await scan(abbTargets(o.adapters, o.wifi), {
    signal: o.signal, progress: o.progress, open: o.open,
    probe: async t => {
      const rws = await probeRws(t.host, t.port, 1500);
      if (!rws) return undefined;
      return { host: t.host, port: t.port, ...rws, source: t.source, ...(await identifyRws(t.host, t.port, rws, o.user, o.password)) };
    },
  });
  const seen = new Set(local.map(f => `${f.host}:${f.port}`));
  const out = [...local];
  for (const { target: _t, ...f } of remote) {
    // one controller answering on 80 and 443 (an OmniCore redirects) is listed once, on its RWS port
    if (seen.has(`${f.host}:${f.port}`) || out.some(x => x.host === f.host && x.family === f.family)) continue;
    seen.add(`${f.host}:${f.port}`); out.push(f);
  }
  return out;
}

const SOURCE_LABEL: Record<ScanSource, string> = { local: 'this PC', default: 'service port', wired: 'wired', wifi: 'WiFi' };
export const sourceLabel = (s: ScanSource) => SOURCE_LABEL[s];
