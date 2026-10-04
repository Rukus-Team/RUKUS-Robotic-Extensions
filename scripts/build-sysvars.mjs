// Generates data/sysvars.json - the subset of RUKUS's SysVarsReference.json the extension
// bundles: every entry with a description, plus every top-level variable (so completion after
// `$` knows all the names). Run by `npm run package`; harmless when the RUKUS repo is not
// beside this one (the committed data file is kept).
//
//   node scripts/build-sysvars.mjs [path\to\SysVarsReference.json]
import fs from 'node:fs';
import path from 'node:path';

const src = process.argv[2] ?? path.resolve('..', 'Robotic Utility Kit', 'Assets', 'SysVarsReference.json');
const out = path.resolve('data', 'sysvars.json');
if (!fs.existsSync(src)) { console.log(`sysvars: ${src} not found; keeping ${fs.existsSync(out) ? 'the committed' : 'no'} data/sysvars.json`); process.exit(0); }

const all = JSON.parse(fs.readFileSync(src, 'utf8'));
// Every described entry travels, the inferred ones included: a guess labelled as a guess is
// still better than "not in the reference" on a plant PC without RUKUS. Column 6 is the
// source, so the hover can say which kind it is.
//
// One row per VARIABLE, not per array element. The controller capture lists `$X[1].$F`,
// `$X[2].$F`, ... `$X[32].$F` as separate rows; the extension normalises every index to 1
// before it looks anything up, so only the element-1 spelling can ever answer - the rest
// quadrupled the bundle (5.9 MB for 1.3 MB of information) and, worse, an element-2 row
// still carried the capture's older wording after a manual had described element 1.
// Same normalisation as `normalizeSysVar` in packages/fanuc/src/data/sysVarsIndex.ts.
const normalize = p => p.toUpperCase().replace(/\[([0-9, ]*)\]/g, (_, inner) => `[${inner.split(',').map(() => '1').join(',')}]`).replace(/\.(?!\$)/g, '.$');
const paths = new Set(all.map(x => x.path.toUpperCase()));
const rows = all
  .filter(x => x.description || !x.path.includes('.'))
  // keep the element-1 form; keep another element only when no element-1 twin exists at all
  .filter(x => { const n = normalize(x.path); return n === x.path.toUpperCase() || !paths.has(n); })
  .map(x => [x.path, x.description ?? null, x.dataType ?? null, x.access ?? null, x.storage ?? null, x.source ?? null]);
fs.mkdirSync(path.dirname(out), { recursive: true });
// keep the old date when nothing else changed, so a build does not leave a one-line diff behind
let generated = new Date().toISOString().slice(0, 10);
try {
  const prev = JSON.parse(fs.readFileSync(out, 'utf8'));
  if (prev.total === all.length && JSON.stringify(prev.rows) === JSON.stringify(rows)) generated = prev.generated;
} catch { /* first build */ }
fs.writeFileSync(out, JSON.stringify({ source: 'RUKUS Assets/SysVarsReference.json', generated, total: all.length, rows }));
console.log(`sysvars: ${rows.length} of ${all.length} entries (${rows.filter(r => r[1]).length} described, ${rows.filter(r => r[5] === 'manual').length} from a manual) -> ${path.relative('.', out)} (${(fs.statSync(out).size / 1024).toFixed(0)} KB)`);
