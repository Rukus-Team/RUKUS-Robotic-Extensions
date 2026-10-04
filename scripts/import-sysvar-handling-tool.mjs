// Merges Appendix C ("SYSTEM VARIABLES") of the R-30iB Plus Operator's Manual (Basic
// Function), B-83284EN/09, into RUKUS's SysVarsReference.json. This is the current,
// authoritative text, so it overrides whatever a path had - an inferred guess or the older
// R-J3 wording alike.
//
// The appendix, as text out of the PDF, reads:
//
//   $DMR_GRP[ group ]. $MASTER_COUN[ 1 ] *        ← one or more path lines (array elements)
//   INTEGER RW 0 to 100000000 ( pulse )           ← type, RW/RO, PU, valid range
//    [Function]   Store mastering pulse counts
//    [Description]   Pulsecoder count at zero degree position is stored. ...
//    [Setting]   ...
//
//   node scripts/import-sysvar-handling-tool.mjs <manual.txt> <SysVarsReference.json> [--write] [--add-missing]
import fs from 'node:fs';

const [txtPath, jsonPath, ...flags] = process.argv.slice(2);
if (!txtPath || !jsonPath) { console.error('usage: import-sysvar-handling-tool.mjs <manual.txt> <SysVarsReference.json> [--write] [--add-missing]'); process.exit(2); }
const write = flags.includes('--write');
const addMissing = flags.includes('--add-missing');

const all = fs.readFileSync(txtPath, 'utf8').split(/\r?\n/);
// the appendix body: the LAST "C.2 SYSTEM VARIABLES" heading (the first is the contents) to the start of appendix D
const start = all.map((l, i) => (/^C\.2 SYSTEM VARIABLES\s*$/.test(l) ? i : -1)).filter(i => i >= 0).pop();
const end = all.findIndex((l, i) => i > start && /^D SAVING RESEARCH DATA\s*$/.test(l));
if (start === undefined || end < 0) { console.error('could not find Appendix C in the text'); process.exit(1); }
const lines = all.slice(start + 1, end)
  .filter(l => !/^(C\. SYSTEM VARIABLES APPENDIX B-83284EN\/09|B-83284EN\/09 APPENDIX C\. SYSTEM VARIABLES|- \d+ -)\s*$/.test(l))
  .map(l => l.replace(/\s+$/, ''));

const TYPES = /^(BOOLEAN|BYTE|SHORT|INTEGER|ULONG|REAL|CHAR|STRING|XYZWPR|POSITION|JOINTPOS|VECTOR|ARRAY)\b/;
const PATHLINE = /^(\$[A-Z_][A-Z0-9_]*(?:\s*\[[^\]]*\])?(?:\s*\.\s*\$?[A-Z_][A-Z0-9_]*(?:\s*\[[^\]]*\])?)*)\s*(.*)$/;

/** `$DMR_GRP[ group ]. $MASTER_COUN[ 1 ]` → `$DMR_GRP[1].$MASTER_COUN[1]` (placeholders become element 1) */
const norm = p => p.replace(/\s+/g, '').toUpperCase()
  .replace(/\[([^\]]*)\]/g, (_, inner) => `[${inner.split(',').map(x => (/^\d+$/.test(x.trim()) ? x.trim() : '1')).join(',')}]`)
  .replace(/\.(?!\$)/g, '.$');

const entries = [];
let cur;
let category = '';
for (let i = 0; i < lines.length; i++) {
  const l = lines[i];
  const t = l.trim();
  if (!t) continue;
  const pm = PATHLINE.exec(t);
  if (pm && /^\$/.test(t)) {
    // a new entry starts when the previous one already has a type line
    if (!cur || cur.type) { cur = { paths: [], category, type: undefined, access: undefined, pu: false, range: '', func: '', desc: '', setting: '' }; entries.push(cur); }
    cur.paths.push(norm(pm[1]));
    continue;
  }
  if (cur && !cur.type && TYPES.test(t)) {
    const parts = t.split(/\s+/);
    cur.type = parts[0];
    cur.access = parts.find(x => x === 'RW' || x === 'RO');
    cur.pu = parts.includes('PU');
    cur.range = t.replace(/^\S+\s+(RW|RO)?\s*(PU)?\s*/, '').trim();
    cur.field = undefined;
    continue;
  }
  if (cur) {
    const m = /^\[(Function|Description|Setting)\]\s*(.*)$/.exec(t);
    if (m) { cur.field = m[1].toLowerCase(); cur[m[1] === 'Function' ? 'func' : m[1] === 'Description' ? 'desc' : 'setting'] += (m[2] ? m[2] + ' ' : ''); continue; }
    if (cur.field && cur.type) { const k = cur.field === 'function' ? 'func' : cur.field === 'description' ? 'desc' : 'setting'; cur[k] += t + ' '; continue; }
  }
  // anything else before a path line is a category heading ("Mastering", "Break control")
  if (!cur || cur.type) category = t;
}

const clean = s => s.replace(/\s+/g, ' ').replace(/ ([,.;:])/g, '$1').trim();
const ref = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
const byPath = new Map(ref.map(r => [r.path.toUpperCase(), r]));
let updated = 0, added = 0, missing = 0;
const seen = new Set();
for (const e of entries) {
  if (!e.func && !e.desc) continue;
  const text = clean(`${e.func ? clean(e.func).replace(/\.$/, '') + (e.desc ? ' — ' : '') : ''}${e.desc}${e.setting ? ` [Setting: ${clean(e.setting)}]` : ''}`);
  const desc = text.length > 900 ? text.slice(0, 897) + '…' : text;
  // every listed element, plus the element-1 form the extension normalises to
  const targets = new Set([...e.paths, ...e.paths.map(p => p.replace(/\[[^\]]*\]/g, m => `[${m.slice(1, -1).split(',').map(() => '1').join(',')}]`))]);
  for (const key of targets) {
    if (seen.has(key)) continue;
    seen.add(key);
    const r = byPath.get(key) ?? byPath.get(key.replace(/\[[^\]]*\]$/, ''));
    if (r) {
      r.description = desc; r.source = 'manual';
      if (e.type && !/^ARRAY/.test(e.type)) r.dataType = r.dataType ?? e.type;
      if (e.access) r.access = r.access ?? e.access;
      updated++;
    } else if (addMissing) {
      const row = { path: key, description: desc, source: 'manual', access: e.access ?? null, storage: null, dataType: e.type ?? null };
      ref.push(row); byPath.set(key, row); added++;
    } else missing++;
  }
}
console.log(`handling tool appendix C: ${entries.length} entries, ${entries.reduce((n, e) => n + e.paths.length, 0)} paths (${new Set(entries.map(e => e.category)).size} categories)`);
console.log(`updated ${updated}, added ${added}${missing ? `, ${missing} not in the reference (pass --add-missing)` : ''}; ${ref.filter(r => r.source === 'manual').length} manual of ${ref.length}`);
for (const p of ['$DMR_GRP[1].$MASTER_DONE', '$SEMIPOWERFL', '$PARAM_GROUP[1].$SV_OFF_TIME[3]', '$MASTER_ENB']) { const r = byPath.get(p); if (r) console.log(`  ${p} => [${r.source}] ${r.description.slice(0, 120)}`); }
if (write) { fs.writeFileSync(jsonPath, JSON.stringify(ref, null, 1) + '\n'); console.log(`written ${jsonPath}`); }
else console.log('(dry run - pass --write to save)');
