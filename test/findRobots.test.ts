/**
 * Regressions from Sam's Find Robots report (2026-10-30): "I had 6 robots today and it said it
 * couldn't find one of them". Synthetic, nothing here touches a network. Wired in by test/run.ts:
 * `run(check)`.
 *
 *   - what did not connect gets a second, slower try
 *   - an open port that is not recognised is reported with why, not dropped
 *   - a FANUC controller is known by its FTP greeting when its web server does not say so
 *   - a range can be typed, and the log says what each adapter was used for
 */
import { parseScanRange, describeAdapters, scan, planScan, subnetHosts, MAX_RANGE_HOSTS, type ScanMiss } from '@core/live/netScan';
import { searchFanucControllers, isFanucFtp } from '@core/live/fanucSearch';
import { searchAbbControllers } from '@abb/live/search';

type Check = (cond: unknown, msg: string) => void;

const ok200 = (html: string) => ({ status: 200, body: Buffer.from(html, 'latin1') });
const HOME = '<h1>ROBOT<br>Homepage</h1> Hostname: LINE1<br> Robot No: F123456<br>';

export async function run(check: Check): Promise<void> {
  // ---- ranges ----
  const subnet = parseScanRange('192.168.1.0/24');
  check(Array.isArray(subnet) && subnet.length === 254 && subnet[0] === '192.168.1.1' && subnet[253] === '192.168.1.254', 'a /24 is its 254 hosts');
  check(JSON.stringify(parseScanRange('10.1.2.50-52')) === '["10.1.2.50","10.1.2.51","10.1.2.52"]', 'a short range stays in its subnet');
  const across = parseScanRange('10.1.2.254-10.1.3.1');
  check(Array.isArray(across) && across.length === 4 && across[2] === '10.1.3.0', 'a range can cross a subnet');
  check(JSON.stringify(parseScanRange(' 10.1.2.77 ')) === '["10.1.2.77"]', 'one address');
  check(Array.isArray(parseScanRange('10.0.0.0/22')) && (parseScanRange('10.0.0.0/22') as string[]).length === MAX_RANGE_HOSTS, 'a /22 is the most');
  check(typeof parseScanRange('10.0.0.0/21') === 'string', 'a /21 is refused');
  check(typeof parseScanRange('10.1.2.60-50') === 'string', 'a range cannot run backwards');
  check(typeof parseScanRange('10.1.2.300') === 'string' && typeof parseScanRange('robot') === 'string', 'nonsense is refused');

  // ---- the second pass ----
  const tries = new Map<string, number>();
  const found = await scan(planScan({ local: [], hosts: ['slow', 'dead'], ports: [80] }), {
    open: async (host, _p, timeoutMs) => { tries.set(host, (tries.get(host) ?? 0) + 1); return host === 'slow' && timeoutMs >= 1000; },
    probe: async () => ({ ok: true }), connectTimeoutMs: 500, slowPass: { connectTimeoutMs: 1200, concurrency: 2 },
  });
  check(found.length === 1 && found[0].target.host === 'slow', 'a slow host is found on the second pass');
  check(tries.get('slow') === 2 && tries.get('dead') === 2, 'what did not connect is tried twice');
  let ticks = 0, last = 0, lastTotal = 0;
  await scan(planScan({ local: [], hosts: ['a'], ports: [80] }), { open: async () => false, probe: async () => undefined, slowPass: { connectTimeoutMs: 1, concurrency: 1 }, progress: (d, t) => { ticks++; last = d; lastTotal = t; } });
  check(ticks === 2 && last === 2 && lastTotal === 2, 'the progress counts both passes');
  const stop = { isCancellationRequested: false };
  let calls = 0;
  await scan(planScan({ local: [], hosts: ['a', 'b'], ports: [80] }), { open: async () => { calls++; stop.isCancellationRequested = true; return false; }, probe: async () => undefined, concurrency: 1, slowPass: { connectTimeoutMs: 1, concurrency: 1 }, signal: stop });
  check(calls === 1, 'cancel stops the second pass too');

  // ---- nothing open is lost ----
  const missed: ScanMiss[] = [];
  await scan(planScan({ local: [], hosts: ['a', 'b'], ports: [80] }), { open: async () => true, probe: async t => { if (t.host === 'a') throw new Error('HTTP 401'); return undefined; }, missed: m => missed.push(m) });
  check(missed.length === 2 && missed.some(m => m.target.host === 'a' && m.why === 'HTTP 401') && missed.some(m => m.target.host === 'b' && m.why === 'not recognised'), 'an open port is reported with why');

  // ---- FANUC ----
  const none = { adapters: [], wifi: false, local: [] };
  const fanuc = async (get: (h: string, p: number) => Promise<{ status: number; body: Buffer }>, greeting: (h: string, p: number) => Promise<string | undefined>, open = async () => true) => {
    const out: ScanMiss[] = [];
    const list = await searchFanucControllers({ ...none, hosts: ['10.0.0.1'], get, greeting, open, missed: m => out.push(m) });
    return { list, out };
  };
  const both = await fanuc(async () => ok200(HOME), async () => '220 R-30iB FTP server ready.');
  check(both.list.length === 1 && both.list[0].hostname === 'LINE1' && !both.list[0].ftpOnly, 'on both ports it is one robot, by its page');
  const locked = await fanuc(async () => ({ status: 401, body: Buffer.alloc(0) }), async () => '220 R-30iB FTP server ready.');
  check(locked.list.length === 1 && locked.list[0].ftpOnly === true && locked.list[0].port === 80, 'a locked web server is still known by FTP');
  check(locked.out.some(m => m.why === 'HTTP 401'), 'and the log says why the page did not count');
  const printer = await fanuc(async () => ok200('<html>Printer</html>'), async () => '220 printer ready');
  check(printer.list.length === 0 && printer.out.length === 2 && printer.out.some(m => m.why === 'HTTP 200, not a controller page') && printer.out.some(m => m.why.startsWith('FTP greeting')), 'something else is reported, not added');
  const wedged = await fanuc(async () => { throw new Error('timeout after 8000 ms'); }, async () => undefined);
  check(wedged.list.length === 0 && wedged.out.some(m => m.why === 'timeout after 8000 ms') && wedged.out.some(m => m.why.includes('no greeting')), 'a wedged web server is reported');
  check(isFanucFtp('220 R-J3 Controller FTP server ready') && isFanucFtp('220 R-30iB Plus') && !isFanucFtp('220 ProFTPD Server'), 'FTP greetings');

  const ports: number[] = [];
  await searchFanucControllers({ adapters: [], wifi: false, local: ['127.0.0.9'], open: async (_h, p) => { ports.push(p); return false; } });
  check(ports.includes(80) && ports.includes(21) && ports.includes(3080), 'ROBOGUIDE is tried on 3080 too');
  const lan: Array<[string, number]> = [];
  await searchFanucControllers({ adapters: [], wifi: false, local: [], hosts: ['10.0.0.1'], open: async (h, p) => { lan.push([h, p]); return false; } });
  check(!lan.some(([, p]) => p === 3080), 'no 3080 on the network');

  // ---- ABB ----
  const abbMissed: ScanMiss[] = [];
  await searchAbbControllers({ adapters: [], wifi: false, hosts: ['127.0.0.1'], findVirtual: async () => [], open: async h => h === '127.0.0.1', missed: m => abbMissed.push(m) });
  check(abbMissed.some(m => m.target.host === '127.0.0.1' && m.why.includes('Robot Web Services')), 'ABB: an open port without RWS is reported');

  // ---- the log ----
  const adapters = [{ name: 'Ethernet', address: '192.168.1.5', netmask: '255.255.255.0', kind: 'wired' as const }];
  const info = (address: string) => [{ family: 'IPv4', internal: false, address, netmask: '255.255.255.0' }] as any;
  const lines = describeAdapters({ Ethernet: info('192.168.1.5'), 'vEthernet (WSL)': info('172.20.0.1'), Spare: info('169.254.1.2') }, adapters, false);
  check(lines[0].includes('searched 192.168.1.1 to 192.168.1.254'), 'the log says what an adapter covered');
  check(lines[1].includes('virtual') && lines[2].includes('no address'), 'and why one was left out');
  check(subnetHosts('10.4.7.9', '255.255.0.0').length === 253, 'a /16 is still searched as the /24 around the PC');
}
