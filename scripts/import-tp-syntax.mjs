// Merge TP syntax extracted from the FANUC manuals into data/tp-syntax.json - the curated source that
// scripts/build-tp-syntax.mjs turns into the grammar block, hovers, completions and parser knowledge.
//
//   node scripts/import-tp-syntax.mjs <dir with <family>.json files>
//
// Each input file is { family, sources:[{file, manual}], items:[{ keyword, kind, forms, examples, option,
// summary, notes, pages, confidence }] }, written per manual family (base, optional, tracking, vision,
// handling, process, arc2, spot2, sensors, misc; manuals2 + pallettool from the 2026-10 manuals, optcatalog from the FANUC-Options-Catalog). KAREL is separate (packages/fanuc/src/karel/builtins.ts).
// Items are merged by kind + normalised head; the first family listed below wins the summary, the forms
// and examples of every family are kept (de-duplicated), and the source of each is recorded.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = process.argv[2];
if (!dir) { console.error('usage: node scripts/import-tp-syntax.mjs <dir>'); process.exit(2); }
const FAMILIES = ['base', 'optional', 'tracking', 'vision', 'handling', 'process', 'arc2', 'spot2', 'sensors', 'misc', 'manuals2', 'pallettool', 'optcatalog', 'seen'];
const KINDS = new Set(['instruction', 'motion-option', 'operand', 'function', 'program-call']);

const clean = s => String(s ?? '').replace(/[‘’′]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();
/** the identity of an item: its kind and the literal words before the first placeholder/bracket */
function head(kind, item) {
  const f = clean((item.forms || [])[0] || item.keyword);
  const lead = f.replace(/^CALL\s+/i, '').split(/[<\[(,=]| \.\.\./)[0].trim().toUpperCase().replace(/\s+/g, ' ');
  return `${kind}:${lead || clean(item.keyword).toUpperCase()}`;
}

const merged = new Map();
const report = [];
for (const fam of FAMILIES) {
  const file = path.join(dir, `${fam}.json`);
  if (!existsSync(file)) { report.push(`${fam}: (none)`); continue; }
  const j = JSON.parse(readFileSync(file, 'utf8'));
  const manual = Object.fromEntries((j.sources || []).map(s => [s.file, s.manual]));
  const srcTitle = (j.sources || []).map(s => s.manual || s.file).join('; ');
  let n = 0;
  for (const it of j.items || []) {
    if (!KINDS.has(it.kind)) continue;
    const forms = (it.forms || []).map(clean).filter(Boolean);
    if (!forms.length && it.kind !== 'program-call') continue;            // nothing to match or show
    const key = head(it.kind, it);
    const src = { family: fam, manual: (it.source && manual[it.source]) || srcTitle, pages: it.pages || [] };
    const prev = merged.get(key);
    if (prev) {
      for (const f of forms) if (!prev.forms.includes(f)) prev.forms.push(f);
      for (const e of (it.examples || []).map(clean)) if (e && !prev.examples.includes(e) && prev.examples.length < 6) prev.examples.push(e);
      if (!prev.option?.code && it.option?.code) prev.option = it.option;
      if (prev.confidence !== 'high' && it.confidence === 'high') prev.confidence = 'high';
      prev.sources.push(src);
    } else {
      merged.set(key, {
        id: key, keyword: clean(it.keyword), kind: it.kind, family: fam,
        forms, examples: (it.examples || []).map(clean).filter(Boolean).slice(0, 6),
        option: it.option && (it.option.code || it.option.name) ? { code: it.option.code || null, name: clean(it.option.name) } : null,
        summary: clean(it.summary), notes: (it.notes || []).map(clean).filter(Boolean).slice(0, 4),
        confidence: it.confidence === 'high' ? 'high' : 'medium', sources: [src],
      });
    }
    n++;
  }
  report.push(`${fam}: ${n} items`);
}

// Corrections from real controllers (scripts/tp-option-probe.mjs -> tp-probe-verdicts.mjs): data/tp-syntax-overrides.json,
// kept in the repo because the extraction folder is not. Per item id: { remove, reason } drops a form the controller
// rejects (a pendant-menu abbreviation, say); { keyword, forms, examples } replace; { notes } are added first; { confidence };
// { probe } records what the controller said. An override for an id that no longer exists is reported, not ignored.
const ovPath = path.join(root, 'data', 'tp-syntax-overrides.json');
if (existsSync(ovPath)) {
  const ov = JSON.parse(readFileSync(ovPath, 'utf8')).items;
  let applied = 0;
  for (const [id, o] of Object.entries(ov)) {
    const it = merged.get(id);
    if (!it) { report.push(`override for unknown item ${id}`); continue; }
    if (o.remove) { merged.delete(id); applied++; continue; }
    if (o.keyword) it.keyword = clean(o.keyword);
    if (o.forms) it.forms = o.forms.map(clean);
    if (o.examples) it.examples = o.examples.map(clean);
    if (o.notes) it.notes = [...o.notes.map(clean), ...it.notes.filter(n => !o.notes.includes(n))].slice(0, 5);
    if (o.confidence) it.confidence = o.confidence;
    if (o.probe) it.probe = o.probe;
    applied++;
  }
  report.push(`overrides: ${applied} of ${Object.keys(ov).length} applied`);
}

const items = [...merged.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.keyword.localeCompare(b.keyword));
const out = {
  about: 'TP syntax from the FANUC manuals (see sources per item), merged by scripts/import-tp-syntax.mjs; built into the grammar, hovers, completions and parser by scripts/build-tp-syntax.mjs. Summaries are short descriptions, not manual text.',
  generated: new Date().toISOString().slice(0, 10),
  count: items.length,
  items,
};
writeFileSync(path.join(root, 'data', 'tp-syntax.json'), JSON.stringify(out, null, 1) + '\n');
const byKind = items.reduce((m, i) => (m[i.kind] = (m[i.kind] || 0) + 1, m), {});
console.log(report.join('\n'));
console.log(`-> data/tp-syntax.json: ${items.length} items ${JSON.stringify(byKind)}`);
