// Merges FANUC's own system-variable descriptions into RUKUS's SysVarsReference.json.
//
// Source: the "System Variable Listing" chapter of the R-J3 Software Reference Manual
// (MARS35GEN09801E), as text extracted from the PDF. Every entry there has the shape
//
//   $PATH Minimum: x Default: y Maximum: z KCL/Data: RW Program: RW GET/SET_VAR: RW
//   Data Type: REAL Name: Axis Error Tolerance Description: The maximum ... Power Up: ...
//
// and a structure opens with `$NAME STRUCTURE Name: ... Description: ... Power Up: ...`.
// The manual is R-J3 era, but the names carried forward, so a description is written onto
// the reference's matching path (indices normalised to element 1) whenever that path has
// no description or only an inferred one. Hand-written ("manual") descriptions are kept.
//
//   node scripts/import-sysvar-manual.mjs <listing.txt> <SysVarsReference.json> [--write]
import fs from 'node:fs';

const [txtPath, jsonPath, ...flags] = process.argv.slice(2);
if (!txtPath || !jsonPath) { console.error('usage: import-sysvar-manual.mjs <listing.txt> <SysVarsReference.json> [--write]'); process.exit(2); }
const write = flags.includes('--write');
const addMissing = flags.includes('--add-missing');
let added = 0;

const flat = fs.readFileSync(txtPath, 'utf8').replace(/\s+/g, ' ');

// page-header noise that the PDF text carries between entries
const NOISE = [
  /Table 2-2 lists and describes the available system variable information\. Table 2-3 describes the access rights of system variables\. Table 2-2\.\s*/g,
  /System Variable InformationITEM DESCRIPTION Minimum Provides the minimum value[^$]*?(?=\$|$)/g,
  /Fanuc (?:robot )?system variables list\.\s*/g, /Fanuc variable list\.\s*/g, /Fanuc variable programming example\.\s*/g,
  /Back to Main \| Table of Contents \| Previous Section \|[^$]*?(?=\$|$)/g,
  /Access Rights for system variablesACCESS MEANINGNO No accessRO Read onlyRW Read and writeFP Field protection; if it is a structure, one of the first three protections will apply\.\s*/g,
];
let text = flat;
for (const re of NOISE) text = text.replace(re, ' ');

const PATH = String.raw`\$[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?(?:\.\$[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?)*`;

// Repairs for what the PDF did to the text on its way out:
//  - a column wrap inside an identifier: `$DMR_GRP[1].$adapt_col_ m[9] Minimum:`
//  - HTML residue around a path: `<="">$GROUP[1].$uframe <=""> Minimum:`
//  - the path repeated with its declaration: `$MNUFRAME[1, 6] $MNUFRAME[1, 6] = POSITION NIL … Minimum:`
text = text.replace(/<=""\s*>/g, ' ').replace(/\s+/g, ' ').replace(/\.\$ ([a-z_])/g, '.$$$1');
for (let pass = 0; pass < 3; pass++) {
  text = text.replace(new RegExp(`(${PATH}) ([A-Za-z0-9_]+(?:\\[[0-9, \\-]*\\])?)((?: [A-Za-z0-9_]+(?:\\[[0-9, \\-]*\\])?){0,2}) Minimum:`, 'g'), (all, a, b, c) => /^[a-z_]|^_/.test(b) || /_$/.test(a) ? `${a}${b}${c.replace(/ /g, '')} Minimum:` : all);
}
text = text.replace(new RegExp(`(${PATH}) (?:${PATH}) = [^$]{0,80}? Minimum:`, 'g'), '$1 Minimum:');
const START = new RegExp(`(${PATH}) Minimum:|(\\$[A-Z_][A-Z0-9_]*) STRUCTURE Name:`, 'g');

const entries = [];
const starts = [];
for (const m of text.matchAll(START)) starts.push({ at: m.index, path: m[1] ?? m[2], struct: !!m[2], len: m[0].length });
for (let i = 0; i < starts.length; i++) {
  const s = starts[i];
  const chunk = text.slice(s.at, starts[i + 1]?.at ?? text.length);
  const get = re => re.exec(chunk)?.[1]?.trim();
  const name = get(/Name: (.*?) Description:/);
  const description = get(/Description: (.*?)(?: Power Up:| User Interface Location:| Minimum:|$)/);
  if (!description) continue;
  entries.push({
    path: s.path, struct: s.struct, name,
    description: description.replace(/\s+/g, ' ').trim(),
    dataType: s.struct ? 'STRUCTURE' : get(/Data Type: (.*?) Name:/),
    access: s.struct ? undefined : get(/Program: (\w+)/),
    min: s.struct ? undefined : get(/Minimum: (.*?) Default:/), def: s.struct ? undefined : get(/Default: (.*?) Maximum:/), max: s.struct ? undefined : get(/Maximum: (.*?) KCL\/Data:/),
  });
}

/** `$GROUP[1].$uframe` / `$MNUFRAME[1, 6]` / `$AC_CRC_ID[1-5]` → `$GROUP[1].$UFRAME` / `$MNUFRAME[1,1]` / `$AC_CRC_ID[1]` */
const norm = p => p.toUpperCase().replace(/\[([^\]]*)\]/g, (_, inner) => `[${inner.split(',').map(() => '1').join(',')}]`).replace(/\.(?!\$)/g, '.$');

const ref = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
const byPath = new Map(ref.map(r => [r.path.toUpperCase(), r]));
let filled = 0, keptManual = 0, replacedInferred = 0, unmatched = [];
const seen = new Set();
for (const e of entries) {
  const key = norm(e.path);
  if (seen.has(key)) continue;
  seen.add(key);
  const r = byPath.get(key) ?? byPath.get(key.replace(/\[[^\]]*\]$/, ''));
  const desc = e.name && !new RegExp(`^${e.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(e.description) ? `${e.name} — ${e.description}` : e.description;
  if (!r) {
    // Not in the capture. Some of these are R-J3 relics ($AB_INT_CFG), but most are live
    // variables the capture's .va set simply did not include - $DMR_GRP, $MNUFRAME, the
    // $SCR_GRP fields - so they are ADDED, marked manual, with no storage class (the
    // capture is what knows that) so nothing downstream mistakes them for captured paths.
    unmatched.push(e.path);
    if (addMissing) {
      const row = { path: key, description: desc.length > 900 ? desc.slice(0, 897) + '…' : desc, source: 'manual', access: e.access ?? null, storage: null, dataType: e.dataType ?? null };
      ref.push(row); byPath.set(key, row); added++;
    }
    continue;
  }
  if (r.description && r.source === 'manual') { keptManual++; continue; }
  if (r.description && r.source === 'inferred') replacedInferred++; else filled++;
  r.description = desc.length > 900 ? desc.slice(0, 897) + '…' : desc;
  r.source = 'manual';
  if (!r.dataType && e.dataType && e.dataType !== 'STRUCTURE') r.dataType = e.dataType;
  if (!r.access && e.access) r.access = e.access;
}
const described = ref.filter(r => r.description).length;
console.log(`manual entries parsed: ${entries.length} (${entries.filter(e => e.struct).length} structures)`);
console.log(`filled empty: ${filled}, replaced inferred: ${replacedInferred}, kept hand-written: ${keptManual}, no matching path in the reference: ${unmatched.length}${addMissing ? ` (added ${added})` : ' (pass --add-missing to add them)'}`);
console.log(`reference now: ${described} of ${ref.length} described`);
if (unmatched.length) console.log('unmatched sample:', unmatched.slice(0, 12).join(', '));
// original order kept, new rows appended, so the diff is only what changed
if (write) { fs.writeFileSync(jsonPath, JSON.stringify(ref, null, 1) + '\n'); console.log(`written ${jsonPath}`); }
else console.log('(dry run - pass --write to save)');
