/**
 * Active alarms come from ERRACT.LS, the controller's own active list (R-30iB Plus V9.40,
 * ROBOGUIDE 2026-10-13). ERRCURR.LS is a version/feature dump there, never an alarm list.
 * ERRALL.LS since the last RESET is the fallback only where ERRACT.LS is missing.
 * Synthetic, nothing here needs a backup or a controller. Wired in by test/run.ts: `runAsync(check)`.
 * The ERRACT.LS rows are the ones RUKUS Studio's FanucCore tests use (FanucTextTests.ErrAct).
 */
import { parseAlarms, activeAlarms, isErrActListing, readActiveAlarms } from '@core/live/parsers';

type Check = (cond: unknown, msg: string) => void;

const ERRACT =
  'ERRACT.LS      Robot Name ROBOT 10-OCT-26 23:58:26  \n\n' +
  '94" 10-OCT-26 23:45:08 " SYST-212 Need to apply to DCS param               " " STOP.G                        00100110" \n';
const ERRACT_NONE = 'ERRACT.LS      Robot Name ROBOT 13-OCT-26 16:45:28  \n\n';
const ERRALL =
  'ERRALL.LS      Robot Name ROBOT 10-OCT-26 23:58:26  \n\n' +
  '   798" 10-OCT-26 23:40:00 " INTP-213 TeachMem still ON (-PMC-, 1) UALM[23]    " " WARN     00000000"    "\n' +
  '   797" 10-OCT-26 23:30:00 " R E S E T                                       " "          00000000"    "\n';
// what ERRCURR.LS holds on V9.40: versions and features, no alarm rows
const ERRCURR = 'ERRCURR.LS     Robot Name ROBOT 13-OCT-26 16:45:28  \n\n F Number: F00000\n VERSION : HandlingTool\n $VERSION: V9.40P/23\n';
const HOME = '<html><head><title>Web Server</title></head><body>FANUC Web Server</body></html>';

/** a controller that answers only the files given; anything else is a 404 */
function controller(files: Record<string, string>, asked: string[] = []): (file: string) => Promise<string> {
  return async (file: string) => {
    asked.push(file);
    if (file in files) return files[file];
    throw new Error(`404 ${file}`);
  };
}

export async function runAsync(check: Check): Promise<void> {
  // ---- the ERRACT.LS format parses with the ERRALL row parser ----
  const rows = parseAlarms(ERRACT);
  check(rows.length === 1, 'ERRACT.LS: one row');
  const a = activeAlarms(rows)[0];
  check(a && a.seq === 94 && a.code === 'SYST-212' && a.message === 'SYST-212 Need to apply to DCS param' && a.severity === 'STOP' && a.time === '10-OCT-26 23:45:08',
    `ERRACT.LS row fields (${JSON.stringify(a)})`);
  check(parseAlarms(ERRACT_NONE).length === 0, 'ERRACT.LS with only the header: no alarms');
  check(isErrActListing(ERRACT) && isErrActListing(ERRACT_NONE), 'ERRACT.LS header recognised');
  check(!isErrActListing(HOME) && !isErrActListing(ERRCURR) && !isErrActListing(ERRALL), 'home page / ERRCURR / ERRALL are not ERRACT.LS');
  check(parseAlarms(ERRCURR).length === 0, 'ERRCURR.LS version dump has no alarm rows');

  // ---- readActiveAlarms: which file answers ----
  let asked: string[] = [];
  let got = await readActiveAlarms(controller({ 'ERRACT.LS': ERRACT, 'ERRALL.LS': ERRALL, 'ERRCURR.LS': ERRCURR }, asked));
  check(got.length === 1 && got[0].code === 'SYST-212', 'ERRACT.LS rows are the active alarms');
  check(asked.join() === 'ERRACT.LS', `ERRACT.LS answered: nothing else read (${asked.join()})`);

  asked = [];
  got = await readActiveAlarms(controller({ 'ERRACT.LS': ERRACT_NONE, 'ERRALL.LS': ERRALL, 'ERRCURR.LS': ERRCURR }, asked));
  check(got.length === 0, 'ERRACT.LS header only: no active alarms, ERRALL history not shown as active');
  check(!asked.includes('ERRALL.LS'), 'ERRACT.LS header only: ERRALL.LS not read');

  asked = [];
  got = await readActiveAlarms(controller({ 'ERRALL.LS': ERRALL, 'ERRCURR.LS': ERRCURR }, asked));
  check(got.length === 1 && got[0].code === 'INTP-213', 'no ERRACT.LS: ERRALL.LS since the last RESET');
  check(asked.join() === 'ERRACT.LS,ERRALL.LS', `no ERRACT.LS: ERRACT then ERRALL (${asked.join()})`);

  got = await readActiveAlarms(controller({ 'ERRACT.LS': HOME, 'ERRALL.LS': ERRALL }));
  check(got.length === 1 && got[0].code === 'INTP-213', 'home page for ERRACT.LS: falls back to ERRALL.LS');

  asked = [];
  got = await readActiveAlarms(controller({ 'ERRCURR.LS': ERRCURR }, asked));
  check(got.length === 0 && !asked.includes('ERRCURR.LS'), 'ERRCURR.LS is never read as alarms');

  got = await readActiveAlarms(controller({}));
  check(got.length === 0, 'nothing readable: no alarms, no throw');
}
