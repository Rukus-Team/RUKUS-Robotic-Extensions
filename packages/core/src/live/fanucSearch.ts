/**
 * Searching for FANUC controllers (netScan.ts does the addresses). A FANUC controller's web server
 * answers `/` on port 80 with its "ROBOT Homepage", which names the robot:
 *
 *   <h1>ROBOT<br>Homepage</h1> ... Hostname: PSNGRSTLD<br> Robot No: F363347<br>
 *
 * Where it looks: this PC (ROBOGUIDE binds each virtual robot to its own 127.0.0.x), the wired
 * networks, and WiFi when the user says yes. FANUC has no factory address to try.
 */
import { scan, planScan, type Adapter, type ScanSource } from './netScan';
import { httpGet } from './http';

/** ROBOGUIDE numbers its robots' loopback addresses from 127.0.0.1 up; a cell rarely has more. */
export const FANUC_LOCAL_HOSTS = Array.from({ length: 16 }, (_, i) => `127.0.0.${i + 1}`);
export const FANUC_HTTP_PORT = 80;

export interface FanucFound { host: string; port: number; source: ScanSource; hostname?: string; robotNo?: string }

/** Is this page a FANUC controller's home page? Its host name and robot (F) number when it says them. */
export function parseFanucHomepage(html: string): { hostname?: string; robotNo?: string } | undefined {
  if (!/ROBOT\s*(?:<br\s*\/?>\s*)?Homepage|\/frs\/robothp|FRSU\/|\/frh\/cgtp\//i.test(html)) return undefined;
  const field = (label: string) => new RegExp(`${label}\\s*:\\s*([^<\\r\\n]+)`, 'i').exec(html)?.[1].trim() || undefined;
  return { hostname: field('Hostname'), robotNo: field('Robot No\\.?') };
}

export interface FanucSearchOptions {
  adapters: readonly Adapter[];
  wifi: boolean;
  signal?: { readonly isCancellationRequested: boolean };
  progress?: (done: number, total: number) => void;
  /** for tests */
  local?: readonly string[];
  open?: (host: string, port: number, timeoutMs: number) => Promise<boolean>;
}

export async function searchFanucControllers(o: FanucSearchOptions): Promise<FanucFound[]> {
  const targets = planScan({ local: o.local ?? FANUC_LOCAL_HOSTS, adapters: o.adapters, wifi: o.wifi, ports: [FANUC_HTTP_PORT] });
  const hits = await scan(targets, {
    signal: o.signal, progress: o.progress, open: o.open, connectTimeoutMs: 500,
    probe: async t => {
      const r = await httpGet({ host: t.host, port: t.port, timeoutMs: 3000 }, '/');
      if (r.status !== 200) return undefined;
      const page = parseFanucHomepage(r.body.toString('latin1'));
      return page ? { host: t.host, port: t.port, source: t.source, ...page } : undefined;
    },
  });
  return hits.map(({ target: _t, ...f }) => f);
}
