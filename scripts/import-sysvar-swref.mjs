// Merges the R-30iA Software Reference Manual's system-variable listing (MARACSSRF03061E
// Rev F, "Chapter 2 SYSTEM VARIABLE LISTING", V7.20+) into RUKUS's SysVarsReference.json.
// It is the modern successor of the R-J3 listing and describes 2,800 paths, so its text
// overrides an inferred guess and the older R-J3 wording alike; only the Handling Tool
// manual (newer still) is applied after it.
//
// As text out of the PDF each entry reads:
//
//   $DMR_GRP[1].$adapt_col_m[9]
//   Minimum:-32768Maximum:32767Default:0KCL/Data:RWProgram:RWUIF:
//   Not availableCRTL:Not availableData Type:SHORTMemory:Not available
//   Name:Adaptive Corioli Minus
//   Description:Data for adaptive control.
//   Power Up:N/A
//
// with the odd path split after its `$` onto the next line, and page headers in between.
//
//   node scripts/import-sysvar-swref.mjs <manual.txt> <SysVarsReference.json> [--write] [--add-missing]
import fs from 'node:fs';

const [txtPath, jsonPath, ...flags] = process.argv.slice(2);
if (!txtPath || !jsonPath) { console.error('usage: import-sysvar-swref.mjs <manual.txt> <SysVarsReference.json> [--write] [--add-missing]'); process.exit(2); }
const write = flags.includes('--write');
const addMissing = flags.includes('--add-missing');

let text = fs.readFileSync(txtPath, 'utf8');
// page furniture
text = text.replace(/^.*SYSTEM VARIABLE LISTING.*MARACSSRF03061E.*$/gm, '').replace(/^MARACSSRF03061E REV F.*$/gm, '').replace(/^2–\d+\s*$/gm, '');
// `$` alone at the end of a line, name on the next
text = text.replace(/\$\s*\n\s*([A-Za-z_])/g, '$$$1');
const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

const PATH = /^(\$[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?(?:\.\$?[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?)*)\s*(STRUCTURE)?\s*$/;
const norm = p => p.toUpperCase()
  .replace(/\[([^\]]*)\]/g, (_, inner) => `[${inner.split(',').map(x => (/^\d+$/.test(x.trim()) ? x.trim() : '1')).join(',')}]`)
  .replace(/\.(?!\$)/g, '.$');

// cut into entries at path lines; an entry is real when its body carries Name:/Description:
const entries = [];
let cur;
for (const l of lines) {
  const m = PATH.exec(l);
  if (m && !/:/.test(l)) { cur = { path: m[1], struct: !!m[2], body: '' }; entries.push(cur); continue; }
  if (cur) cur.body += l + ' ';
}
const parsed = [];
for (const e of entries) {
  const name = /Name:\s*(.*?)\s*Description:/.exec(e.body)?.[1];
  const desc = /Description:\s*(.*?)\s*(?:Power Up:|$)/.exec(e.body)?.[1];
  if (!desc) continue;
  const type = /Data Type:\s*([A-Z][A-Z0-9_]*?)(?=Memory:|\s|$)/.exec(e.body)?.[1];
  const access = /Program:\s*(RW|RO|FP|NO)(?=[A-Z]|\s|$)/.exec(e.body)?.[1];
  parsed.push({ path: norm(e.path), name: name?.replace(/\s+/g, ' ').trim(), desc: desc.replace(/\s+/g, ' ').trim(), type: type && type !== 'Not' ? type : undefined, access });
}

const ref = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
const byPath = new Map(ref.map(r => [r.path.toUpperCase(), r]));
let updated = 0, added = 0, missing = 0;
const seen = new Set();
for (const p of parsed) {
  if (seen.has(p.path)) continue;
  seen.add(p.path);
  const text = p.name && !new RegExp(`^${p.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(p.desc) ? `${p.name} — ${p.desc}` : p.desc;
  const desc = text.length > 900 ? text.slice(0, 897) + '…' : text;
  const r = byPath.get(p.path) ?? byPath.get(p.path.replace(/\[[^\]]*\]$/, ''));
  if (r) { r.description = desc; r.source = 'manual'; if (!r.dataType && p.type) r.dataType = p.type; if (!r.access && p.access) r.access = p.access; updated++; }
  else if (addMissing) { const row = { path: p.path, description: desc, source: 'manual', access: p.access ?? null, storage: null, dataType: p.type ?? null }; ref.push(row); byPath.set(p.path, row); added++; }
  else missing++;
}
console.log(`software reference (Rev F): ${entries.length} entries, ${parsed.length} with a description, ${seen.size} distinct paths`);
console.log(`updated ${updated}, added ${added}${missing ? `, ${missing} not in the reference (pass --add-missing)` : ''}; ${ref.filter(r => r.source === 'manual').length} manual of ${ref.length}`);
for (const p of ['$DMR_GRP[1].$MASTER_DONE', '$SCR_GRP[1].$M_POS_ENB', '$PARAM_GROUP[1].$PAYLOAD', '$MNUFRAME[1,1]', '$MOR_GRP[1].$CURRENTLINE', '$AAVM_WRK[1].$EXPOSURE']) { const r = byPath.get(p); console.log(`  ${p} => ${r ? `[${r.source}] ${r.description.slice(0, 110)}` : '(absent)'}`); }
if (write) { fs.writeFileSync(jsonPath, JSON.stringify(ref, null, 1) + '\n'); console.log(`written ${jsonPath}`); }
else console.log('(dry run - pass --write to save)');
