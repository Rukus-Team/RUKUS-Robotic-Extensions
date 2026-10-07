// Reads the R-30iB Plus Error Code Manual (as text extracted from the PDF) and writes every alarm code
// it lists, for the alarm hover and lookup:
//   - data/fanuc-alarms.json   facility numbers + one alarm per line; shipped with the extension and
//                              read on the first lookup (alarms.ts), not bundled: it is ~2.8 MB
//
//   node scripts/import-alarm-codes.mjs <errorcodes.txt>
//
// Text from the R-30iB Plus / Mate Plus / Compact Plus Error Code Manual (MARRUEROR02171E Rev J),
// extracted with the options catalog's extract.py. Table 1-8 maps each facility name to its number,
// one cell per line:
//   FILE / 2 / 0X2 / FILE SYSTEM
// KAREL status values and POST_ERR codes are facility * 1000 + alarm number (2014 = FILE-014), so
// the number is what turns a status a program reports back into a name. Chapter 3 lists the alarms:
//   3.6.1.14 FILE-014 File not found          (the section number is sometimes on a line of its own)
//   Cause: The specified file was not found.
//   Remedy: Check that the file exists and that the file name was spelled correctly.
// This manual does not print a severity next to each code (the pendant shows it, the manual only
// describes the levels), so entries carry one only when a heading starts with a severity word.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = process.argv[2];
if (!src) { console.error('usage: node scripts/import-alarm-codes.mjs <errorcodes.txt>'); process.exit(1); }

// page furniture the PDF text carries between entries: page markers, the licensee stamp, the running
// header (manual number, chapter title) and the page number
const NOISE = [/^===== PAGE \d+ =====$/, /^MARRUEROR\S+ REV \S+$/i, /^\d+\. [A-Z][A-Z ]+$/, /^\d+[–-]\d+$/, /^About This Manual$/];
const text = readFileSync(src, 'utf8').split(/\r?\n/).map(l => l.trim());
const stamp = licenseeStamp(text);
const raw = text.filter(l => l && !stamp.has(l) && !NOISE.some(r => r.test(l)));
// a section number alone on its line belongs to the heading below it
const lines = [];
for (let i = 0; i < raw.length; i++) {
  if (/^3\.\d+(\.\d+){1,2}$/.test(raw[i]) && i + 1 < raw.length) { lines.push(`${raw[i]} ${raw[++i]}`); continue; }
  lines.push(raw[i]);
}

// ---- Table 1-8: facility name, decimal code, hex code, description
const facilities = {};
for (let i = 0; i + 2 < lines.length; i++) {
  if (/^[A-Z][A-Z0-9]{1,4}$/.test(lines[i]) && /^\d{1,3}$/.test(lines[i + 1]) && /^0X[0-9A-F]+$/i.test(lines[i + 2])
      && parseInt(lines[i + 2], 16) === Number(lines[i + 1])) facilities[lines[i]] = Number(lines[i + 1]);
}

// ---- chapter 3: one entry per heading, up to the next heading, section heading or the glossary
const ENTRY = /^3\.\d+\.\d+\.\d+\s+([A-Z][A-Z0-9]{1,4})-(\d{3,4})\b\s*(.*)$/;
const STOP = [ENTRY, /^3\.\d+\s+[A-Z]$/, /^3\.\d+\.\d+\s+\S+\s+Alarm Codes?$/i, /^Glossary$/];
const LABEL = /^(Cause|Remedy)\s*:\s*/i;
const SEVERITY = /^(WARN|PAUSE|STOP|SERVO|ABORT|SYSTEM|NONE)(?:\.[GL])?\s+(?=\S)/;
const tidy = s => s.replace(/\s+/g, ' ').replace(/\s+([,.;:)])/g, '$1').replace(/\(\s+/g, '(').trim();

const alarms = {};
const odd = [];
for (let i = 0; i < lines.length; i++) {
  const h = ENTRY.exec(lines[i]);
  if (!h) continue;
  let j = i + 1;
  while (j < lines.length && !STOP.some(r => r.test(lines[j]))) j++;
  // a label the PDF ran onto the end of a line ("... amplifier .Remedy:", SRVO-295) starts a line
  const body = lines.slice(i + 1, j).flatMap(l => l.split(/(?<=\S)\s*(?=\b(?:Cause|Remedy)\s*:)/));
  const sec = { pre: [] }; let cur = 'pre';
  for (const l of body) {
    const m = LABEL.exec(l);
    if (m) { cur = m[1].toLowerCase(); (sec[cur] ??= []).push(l.slice(m[0].length)); continue; }
    sec[cur].push(l);
  }
  const id = `${h[1]}-${h[2]}`;
  let message = h[3];
  const entry = {};
  const sev = SEVERITY.exec(message);
  if (sev) { entry.severity = sev[1]; message = message.slice(sev[0].length); }
  // lines between the heading and Cause: are the message wrapping; with no Cause/Remedy at all they
  // are whatever the manual says instead, kept as the cause
  if (sec.cause || sec.remedy) message = `${message} ${sec.pre.join(' ')}`;
  else if (sec.pre.length) { (sec.cause = sec.pre); odd.push(id); }
  entry.message = tidy(message);
  const cause = tidy((sec.cause ?? []).join(' ')), remedy = tidy((sec.remedy ?? []).join(' '));
  if (cause) entry.cause = cause;
  if (remedy) entry.remedy = remedy;
  // a code the manual lists twice keeps the fuller entry
  const prev = alarms[id];
  const size = e => (e.cause?.length ?? 0) + (e.remedy?.length ?? 0);
  if (!prev || size(entry) > size(prev)) alarms[id] = entry;
  i = j - 1;
}

const ids = Object.keys(alarms).sort();
const sortedAlarms = Object.fromEntries(ids.map(k => [k, alarms[k]]));
const sortedFac = Object.fromEntries(Object.keys(facilities).sort().map(k => [k, facilities[k]]));
const data = { facilities: sortedFac, alarms: sortedAlarms };
// one alarm per line: reviewable in a diff, and no indentation for the extension to ship
writeFileSync(path.join(root, 'data', 'fanuc-alarms.json'),
  `{"facilities":${JSON.stringify(sortedFac)},\n"alarms":{\n${ids.map(k => `${JSON.stringify(k)}:${JSON.stringify(sortedAlarms[k])}`).join(',\n')}\n}}\n`);

const facs = new Set(ids.map(k => k.split('-')[0]));
const unnumbered = [...facs].filter(f => !(f in facilities)).sort();
const noCause = ids.filter(k => !alarms[k].cause).length, noRemedy = ids.filter(k => !alarms[k].remedy).length;
console.log(`${ids.length} alarms in ${facs.size} facilities; ${Object.keys(facilities).length} facility numbers from Table 1-8`);
console.log(`${noCause} without a cause, ${noRemedy} without a remedy, ${ids.filter(k => alarms[k].severity).length} with a severity`);
if (unnumbered.length) console.log(`facilities with alarms but no number in Table 1-8: ${unnumbered.join(' ')}`);
if (odd.length) console.log(`${odd.length} entries with text but no Cause:/Remedy: label (kept as cause): ${odd.slice(0, 20).join(' ')}${odd.length > 20 ? ' ...' : ''}`);

/**
 * The licensee stamp a downloaded manual prints at the top of every page: the lines right after
 * most page markers that are the same every time. Found, not named, so no licensee is written here.
 */
function licenseeStamp(text) {
  const seen = new Map(); let pages = 0;
  text.forEach((l, i) => {
    if (!/^===== PAGE \d+ =====$/.test(l)) return;
    pages++;
    for (const n of text.slice(i + 1, i + 3)) if (n) seen.set(n, (seen.get(n) ?? 0) + 1);
  });
  return new Set([...seen].filter(([, c]) => c > pages / 2).map(([l]) => l));
}
