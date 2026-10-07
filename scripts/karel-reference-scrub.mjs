// What the KAREL reference keeps out of its text: sample programs, and pointers to the chapters,
// sections, tables and books it was taken from. scripts/import-karel-reference.mjs runs scrubReference
// on every import; run this file alone to scrub data/karel-reference.json and karelReference.ts in place:
//
//   node scripts/karel-reference-scrub.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// "See Section 7.10.1. and Section 7.10.2 for predefined window names." / "Refer to Chapter 6,
// "Condition Handlers," for ..." / "(See Table A–14)": a dot followed by a digit or " and" does not end it
const POINTER = /\s*\(?\b(?:Refer to|refer to|See also|See|see)\b(?:[^.()]|\.(?=\d|\s+and\b))*?\b(?:Section|Chapter|Appendix|Table|[Mm]anual)\b(?:[^.()]|\.(?=\d|\s+and\b))*(?:\.|\))?/g;
const RULES = [
  [/,\s*shown in Table [A-Z]?[–-]?\d+,/g, ''],
  // "... are shown in Table A–15. Table A–15. IO_STATUS Errors ...": the table follows
  [/\s+in Table ([A-Z]?[–-]?\d+)\.\s*Table \1\.\s*/g, ' below. '],
  [/\s+(?:described|listed|shown) in (?:Appendix|Chapter|Section) [A-Z\d][\w.]*?(?=[.,;]?(?:\s|$))/g, ''],
  [POINTER, ''],
  // what a pointer leaves of a quoted chapter title: Refer to Chapter 13, ``Input/Output System.''
  [/(\.)''(?=\s|$)/g, '$1'],
  [/\bin this appendix\b/g, ''],
  // "Table A–12. Conversion Characters ...": the table stays, its number goes
  [/\bTable [A-Z]?[–-]?\d+(?:[–-]\d+)?\.\s*/g, ''],
  [/\s*\((?:listed as RW )?in Table [\d–-]+[^)]*\)/g, ''],
  [/\bin Table [A-Z]?[–-]?\d+(?:[–-]\d+)?,?\s*(?:“[^”]*”|``[^']*''|"[^"]*")?/g, ''],
  [/Table [A-Z]?[–-]?\d+ lists/g, 'The following lists'],
  // a sentence that names a FANUC book: "... in the iRVision Visual Tracking START-UP GUIDANCE Manual."
  [/[^.]*\b[A-Z][\w-]*(?: [A-Z][\w+-]*)* Manual\b[^.]*\.?/g, ''],
  [/^Some examples in Appendix A reference the following include files:/, 'FANUC supplies these include files:'],
  [/\s*Example:\s*$/, ''],
  // the next chapter's heading the last entries ran into
  [/\s*A\.\d+ - [A-Z] - KAREL LANGUAGE DESCRIPTION[\s\S]*$/, ''],
];
const SAMPLE = /-{20,}|\bthe above KAREL program\b/;

export function scrubText(s) {
  let t = s;
  for (const [re, by] of RULES) t = t.replace(re, by);
  return t.replace(/\s{2,}/g, ' ').replace(/\s+([.,;:])/g, '$1')
    // "(R718).." / "is set.. 1": a doubled full stop - not a range (1..9, F1..F5, [n.. m])
    .replace(/(\)|[a-z]{2})\.\.(?=\s+(?:\d|$)|$)/g, '$1.').trim();
}
const list = xs => xs?.filter(x => !SAMPLE.test(x)).map(scrubText).filter(Boolean);

/** { builtins, language } as the importer builds them, scrubbed in place */
export function scrubReference({ builtins, language }) {
  for (const e of Object.values(builtins)) {
    e.purpose = scrubText(e.purpose);
    for (const p of e.params ?? []) p.text = scrubText(p.text);
    if (e.notes) { e.notes = list(e.notes); if (!e.notes.length) delete e.notes; }
  }
  for (const es of Object.values(language)) for (const e of es) {
    e.purpose = scrubText(e.purpose);
    if (e.details) { e.details = list(e.details); if (!e.details.length) delete e.details; }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const json = path.join(root, 'data', 'karel-reference.json');
  const ts = path.join(root, 'packages', 'fanuc', 'src', 'karel', 'karelReference.ts');
  const d = JSON.parse(readFileSync(json, 'utf8'));
  scrubReference({ builtins: d.builtins, language: d.language });
  writeFileSync(json, JSON.stringify(d, null, 1) + '\n');
  writeFileSync(ts, readFileSync(ts, 'utf8')
    .replace(/(export const KAREL_BUILTIN_DETAILS: Record<string, KBuiltinDetail> = ).*;/, (_, a) => a + JSON.stringify(d.builtins) + ';')
    .replace(/(export const KAREL_LANGUAGE_DETAILS: Record<string, KLanguageDetail\[\]> = ).*;/, (_, a) => a + JSON.stringify(d.language) + ';'));
}
