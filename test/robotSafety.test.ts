/**
 * Robot safety (2026-10-11): telling a virtual controller from a real one by its host, secrets
 * that come back only for the host they were saved for, and FANUC controllers told apart by F
 * number when they share an address. Pure, no vscode, no network.
 * Wired in by test/run.ts: `run(check)`.
 */
import { targetKindOfHost, targetKindLabel } from '@core/live/targetKind';
import { getBoundSecret, storeBoundSecret, deleteBoundSecret } from '@core/live/boundSecrets';
import { fanucIdentityMismatch, fanucExpectationOf } from '@core/live/fanucIdentity';
import { parseControllerInfo } from '@core/live/parsers';

/** SecretStorage over a Map: the calls boundSecrets.ts makes */
function memorySecrets() {
  const m = new Map<string, string>();
  return {
    map: m,
    get: async (k: string) => m.get(k),
    store: async (k: string, v: string) => { m.set(k, v); },
    delete: async (k: string) => { m.delete(k); },
  } as any;
}

export async function run(check: (cond: unknown, msg: string) => void): Promise<void> {
  // ---- virtual or live ----
  check(['127.0.0.1', '127.0.0.3', 'localhost', 'LOCALHOST', '::1', '[::1]', ' 127.0.0.2 '].every(h => targetKindOfHost(h) === 'virtual'), 'loopback hosts (ROBOGUIDE / RobotStudio on this PC) are virtual');
  check(['192.168.1.10', '10.0.0.5', 'robot01.plant.local', '128.0.0.1', '127.0.0', '192.168.125.1'].every(h => targetKindOfHost(h) === 'live'), 'any other host is a real controller');
  check(targetKindLabel('virtual') === 'Virtual' && targetKindLabel('live') === 'Live', 'labels: Virtual / Live');

  // ---- secrets bound to a host ----
  const s = memorySecrets();
  await storeBoundSecret(s, 'pw.R01', 'secret', '192.168.1.10');
  check(await getBoundSecret(s, 'pw.R01', '192.168.1.10') === 'secret', 'the password comes back for the host it was saved for');
  check(await getBoundSecret(s, 'pw.R01', ' 192.168.1.10 ') === 'secret', 'host compare ignores surrounding spaces');
  check(await getBoundSecret(s, 'pw.R01', '203.0.113.9') === undefined, 'a profile of the same name at another host gets no password');
  check(await getBoundSecret(s, 'pw.R01', undefined) === undefined, 'no host known: no password');

  // a password saved before hosts were bound is bound to the first host it is read for
  s.map.set('pw.OLD', 'legacy');
  check(await getBoundSecret(s, 'pw.OLD', '10.0.0.5') === 'legacy', 'a legacy password is returned once and bound');
  check(await getBoundSecret(s, 'pw.OLD', '10.0.0.6') === undefined, '...after which another host gets nothing');

  // saving again for a new host moves the binding
  await storeBoundSecret(s, 'pw.R01', 'secret2', '203.0.113.9');
  check(await getBoundSecret(s, 'pw.R01', '203.0.113.9') === 'secret2' && await getBoundSecret(s, 'pw.R01', '192.168.1.10') === undefined, 'a password typed for a new host is bound to it');

  await deleteBoundSecret(s, 'pw.R01');
  check(!s.map.has('pw.R01') && !s.map.has('pw.R01.host'), 'forgetting removes the password and its host');

  // several profiles at one address (every ABB service port is 192.168.125.1) keep their own passwords
  await storeBoundSecret(s, 'pw.C1', 'one', '192.168.125.1');
  await storeBoundSecret(s, 'pw.C2', 'two', '192.168.125.1');
  check(await getBoundSecret(s, 'pw.C1', '192.168.125.1') === 'one' && await getBoundSecret(s, 'pw.C2', '192.168.125.1') === 'two', 'profiles sharing an address keep separate passwords');

  // ---- FANUC: which controller, by F number ----
  const header = (f: string, robot?: string) => [`F Number: ${f}`, '$VERSION: V9.40P/25', 'DATE: 11-OCT-26 10:00', robot ? `Robot Name ${robot}` : ''].join('\n');
  const noF = parseControllerInfo('$VERSION: V9.40P/25\n');
  const r01 = parseControllerInfo(header('F123456', 'R01'));
  const r02 = parseControllerInfo(header('F654321', 'R02'));
  const first = fanucExpectationOf(r01);
  check(first?.fNumber === 'F123456' && first.robotName === 'R01', `the first header read is remembered by F number (${JSON.stringify(first)})`);
  check(fanucIdentityMismatch('R01', '192.168.125.1', undefined, r02) === undefined, 'nothing remembered yet: any controller is taken');
  check(fanucIdentityMismatch('R01', '192.168.125.1', first, r01) === undefined, 'the same controller passes');
  check(fanucIdentityMismatch('R01', '192.168.125.1', first, parseControllerInfo(header('f123456'))) === undefined, 'F number compare ignores case');
  const why = fanucIdentityMismatch('R01', '192.168.125.1', first, r02);
  check(!!why && why.includes('F654321') && why.includes('F123456') && why.includes('Forget Controller Identity'), `another controller at the same address is refused, naming both F numbers (${why})`);
  check(fanucIdentityMismatch('R01', '192.168.125.1', first, noF) === undefined, 'a header with no F number has nothing to compare and passes');
  check(fanucExpectationOf(noF) === undefined, '...and is not remembered');
}
