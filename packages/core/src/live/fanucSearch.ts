/**
 * Searching for FANUC controllers (netScan.ts does the addresses). A FANUC controller's web server
 * answers `/` on port 80 with its "ROBOT Homepage", which names the robot:
 *
 *   <h1>ROBOT<br>Homepage</h1> ... Hostname: PSNGRSTLD<br> Robot No: F363347<br>
 *
 * Where it looks: this PC (ROBOGUIDE binds each virtual robot to its own 127.0.0.x, on 3080 when
 * RobotStudio holds 80), the wired networks, and WiFi when the user says yes. FANUC has no factory
 * address to try. A controller with its web server locked or wedged still greets on FTP, so that is
 * the second way to know one.
 */
import { scan, planScan, readGreeting, SLOW_PASS, type Adapter, type ScanMiss, type ScanSource } from './netScan';
import { httpGet } from './http';

/** ROBOGUIDE numbers its robots' loopback addresses from 127.0.0.1 up; a cell rarely has more. */
export const FANUC_LOCAL_HOSTS = Array.from({ length: 16 }, (_, i) => `127.0.0.${i + 1}`);
export const FANUC_HTTP_PORT = 80;
export const FANUC_FTP_PORT = 21;
/** ROBOGUIDE's web port when RobotStudio's RobVC holds 80 on every address. */
export const FANUC_LOCAL_HTTP_PORT = 3080;

export interface FanucFound {
  host: string; port: number; source: ScanSource; hostname?: string; robotNo?: string;
  /** known by its FTP greeting: its web server did not answer as a controller */
  ftpOnly?: boolean;
}

/** Does this FTP greeting come from a FANUC controller? */
export const isFanucFtp = (greeting: string) => /FANUC|R-?30i|R-?J3|R-?J2|ROBOT/i.test(greeting);

/** Is this page a FANUC controller's home page? Its host name and robot (F) number when it says them. */
export function parseFanucHomepage(html: string): { hostname?: string; robotNo?: string } | undefined {
  if (!/ROBOT\s*(?:<br\s*\/?>\s*)?Homepage|\/frs\/robothp|FRSU\/|\/frh\/cgtp\//i.test(html)) return undefined;
  const field = (label: string) => new RegExp(`${label}\\s*:\\s*([^<\\r\\n]+)`, 'i').exec(html)?.[1].trim() || undefined;
  return { hostname: field('Hostname'), robotNo: field('Robot No\\.?') };
}

export interface FanucSearchOptions {
  adapters: readonly Adapter[];
  wifi: boolean;
  /** addresses the user typed */
  hosts?: readonly string[];
  signal?: { readonly isCancellationRequested: boolean };
  progress?: (done: number, total: number) => void;
  /** told of an open port that is not a FANUC controller, and why */
  missed?: (m: ScanMiss) => void;
  /** for tests */
  local?: readonly string[];
  open?: (host: string, port: number, timeoutMs: number) => Promise<boolean>;
  get?: (host: string, port: number) => Promise<{ status: number; body: Buffer }>;
  greeting?: (host: string, port: number) => Promise<string | undefined>;
}

export async function searchFanucControllers(o: FanucSearchOptions): Promise<FanucFound[]> {
  const local = o.local ?? FANUC_LOCAL_HOSTS;
  const targets = [
    ...planScan({ local, hosts: o.hosts, adapters: o.adapters, wifi: o.wifi, ports: [FANUC_HTTP_PORT, FANUC_FTP_PORT] }),
    ...planScan({ local, ports: [FANUC_LOCAL_HTTP_PORT] }),
  ];
  const get = o.get ?? ((host, port) => httpGet({ host, port, timeoutMs: 8000 }, '/'));
  const greet = o.greeting ?? readGreeting;
  const hits = await scan(targets, {
    signal: o.signal, progress: o.progress, open: o.open, connectTimeoutMs: 500, slowPass: SLOW_PASS, missed: o.missed,
    probe: async t => {
      if (t.port === FANUC_FTP_PORT) {
        const hello = await greet(t.host, t.port);
        if (hello === undefined) throw new Error('FTP port open, no greeting');
        if (!isFanucFtp(hello)) throw new Error(`FTP greeting: ${hello}`);
        return { host: t.host, port: FANUC_HTTP_PORT, source: t.source, ftpOnly: true };
      }
      const r = await get(t.host, t.port);
      if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
      const page = parseFanucHomepage(r.body.toString('latin1'));
      if (!page) throw new Error('HTTP 200, not a controller page');
      return { host: t.host, port: t.port, source: t.source, ...page };
    },
  });
  // one controller answers on both: its web page knows its name, so that finding stands
  const byPage = new Set(hits.filter(h => !h.ftpOnly).map(h => h.host));
  return hits.filter(h => !h.ftpOnly || !byPage.has(h.host)).map(({ target: _t, ...f }) => f);
}
