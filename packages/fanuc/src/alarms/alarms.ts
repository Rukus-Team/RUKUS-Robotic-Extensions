/**
 * Alarm code lookup: what the R-30iB Plus Error Code Manual says about FILE-014, 2014 or 43001.
 *
 * A pendant shows an alarm as FACILITY-NNN, but a KAREL program sees it as a number - the status
 * a built-in returns, the code it hands to POST_ERR - which is facility * 1000 + alarm number
 * (FILE is facility 2, so 2014 = FILE-014; past facility 9 it runs to five digits, 43001 = RPM-001).
 * Both spellings end up here. No vscode import, so the unit tests can call it.
 *
 * The manual's 10,000-odd alarms (data/fanuc-alarms.json, scripts/import-alarm-codes.mjs) are ~2.8 MB,
 * so they ship next to the bundle and are read on the first lookup rather than parsed at every start.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface AlarmEntry { severity?: string; message: string; cause?: string; remedy?: string }
interface AlarmData { facilities: Record<string, number>; alarms: Record<string, AlarmEntry> }

// dist/extension.js and dist/test.js both sit one folder below data/
let dataFile = path.join(__dirname, '..', 'data', 'fanuc-alarms.json');
let data: AlarmData | undefined;

/** where the extension is installed; the default (next to the bundle) is right for it and the tests */
export function setAlarmDataDir(extensionPath: string): void {
  dataFile = path.join(extensionPath, 'data', 'fanuc-alarms.json');
  data = undefined;
}

function alarmData(): AlarmData {
  if (!data) {
    try { data = JSON.parse(fs.readFileSync(dataFile, 'utf8')) as AlarmData; } catch { data = { facilities: {}, alarms: {} }; }
  }
  return data;
}

/** every alarm, for the lookup's list */
export function allAlarms(): Record<string, AlarmEntry> { return alarmData().alarms; }
/** facility name to number (FILE = 2) */
export function alarmFacilities(): Record<string, number> { return alarmData().facilities; }

export interface AlarmInfo {
  /** FACILITY-NNN, as the pendant shows it */
  id: string;
  /** facility name, e.g. FILE */
  facility: string;
  /** alarm number within the facility, e.g. 14 */
  number: number;
  /** facility * 1000 + number, the KAREL status value; undefined when the manual gives the facility no number */
  code?: number;
  /** the manual does not print one per alarm, so this is usually absent */
  severity?: string;
  message: string;
  cause?: string;
  remedy?: string;
}

let byCode: Map<number, string> | undefined;
function facilityOfCode(n: number): string | undefined {
  byCode ??= new Map(Object.entries(alarmFacilities()).map(([name, num]) => [num, name]));
  return byCode.get(n);
}

/** the manual's entry for `"FILE-014"`, `"file-14"`, `2014` or `"2014"`; undefined when it has none */
export function lookupAlarm(code: string | number): AlarmInfo | undefined {
  let facility: string | undefined, number: number;
  const s = String(code).trim();
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    facility = facilityOfCode(Math.floor(n / 1000));
    number = n % 1000;
  } else {
    const m = /^([A-Za-z][A-Za-z0-9]{1,4})\s*-\s*(\d{1,4})$/.exec(s);
    if (!m) return undefined;
    facility = m[1].toUpperCase();
    number = Number(m[2]);
  }
  if (!facility) return undefined;
  const id = `${facility}-${String(number).padStart(3, '0')}`;
  const e = allAlarms()[id];
  if (!e) return undefined;
  const fnum = alarmFacilities()[facility];
  return { id, facility, number, code: fnum === undefined ? undefined : fnum * 1000 + number, ...e };
}

// manual text can carry *, _, [ ], <, > and backslashes (file paths, "%s^4") that markdown would eat
const escapeMd = (s: string) => s.replace(/[\\`*_[\]<>|#~]/g, '\\$&');

/** hover lines for an alarm: heading, cause, remedy, and where it came from */
export function alarmMarkdownLines(a: AlarmInfo): string[] {
  const out = [`**${a.id}**${a.severity ? ` ${a.severity}` : ''} — ${escapeMd(a.message)}`];
  if (a.cause) out.push('', `**Cause:** ${escapeMd(a.cause)}`);
  if (a.remedy) out.push('', `**Remedy:** ${escapeMd(a.remedy)}`);
  return out;
}
