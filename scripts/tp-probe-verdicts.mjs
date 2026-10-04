// Turn tp-option-probe results from one or more controllers into one verdict per catalog item.
//
//   node scripts/tp-probe-verdicts.mjs <label>=<a.json,b.json,...> [<label>=...] [--out probe-results/verdicts]
//
// Every input file is a probe result array; several files per controller are merged by line
// (a re-test overrides an earlier answer for the same line). A line the controller ACCEPTED is not
// automatically right: the loader keeps a line but silently drops the part it does not understand
// (FORCE CTRL[1] ErrorLBL[0] -> FORCE CTRL[1:]; ... FINE RESET WATER SAVER -> ... FINE), so the read-back
// is compared word by word. Per line:
//   confirmed   accepted, every word kept (spacing, case, register comments, --eg: aside)
//   respelled   accepted, every word kept but the controller writes it differently (Lpos -> LPOS)
//   dropped     accepted, but words of the line are gone in the read-back
//   vanished    the program loaded but the line was thrown away (empty /MN) - not installed, or wrong
//   option      SCIO-016: the word is known, the option is not installed
//   setup       recognised but needs configuration (ASBN-120 undefined pallet number ...)
//   rejected    ASBN-0xx as written
//   unsent      not probed (crashes the loader) or no response
// Per catalog item the best line wins (confirmed > respelled > option > setup > dropped > rejected > unsent).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const oi = args.indexOf('--out');
const out = oi >= 0 ? args.splice(oi, 2)[1] : path.join(root, 'probe-results', 'verdicts');
// --verified "<controller description>": also write data/tp-syntax-verified.json, the positive results
// only, which scripts/build-tp-syntax.mjs puts in the hover ("Verified on a FANUC controller")
const vi = args.indexOf('--verified');
const verifiedOn = vi >= 0 ? args.splice(vi, 2)[1] : undefined;
const hosts = args.map(a => { const [label, files] = a.split('='); return { label, files: files.split(',') }; });
if (!hosts.length) { console.error('usage: tp-probe-verdicts.mjs <label>=<a.json,...> ...'); process.exit(2); }

const SETUP = /ASBN-120|Undefined pallet|ASBN-157 Invalid distance schedule|ASBN-142|not configured/i;
const words = s => (s ?? '').toUpperCase()
  .replace(/\[(\s*\d+\s*):[^\]]*\]/g, '[$1]')          // register comments, added or removed by the controller
  .replace(/^--EG:/, '--').replace(/'[^']*'/g, ' ')    // --eg: comment marker; string contents
  .match(/[A-Z_$][A-Z0-9_$]*/g) ?? [];
const squash = s => (s ?? '').toUpperCase().replace(/\[(\s*\d+\s*):[^\]]*\]/g, '[$1]').replace(/^--EG:/, '--').replace(/\s+/g, '');

function lineVerdict(r) {
  if (r.ok) {
    // the program loaded with an empty /MN: the loader threw the whole line away without an error -
    // a feature that is not on this controller (Arc Start on SpotTool+), or a wrong form
    if (!(r.controller ?? '').trim()) return { v: 'vanished' };
    const have = new Set(words(r.controller));
    const flat = squash(r.controller);
    const lost = words(r.line).filter(w => !have.has(w) && !flat.includes(w));   // "EV 50%" -> "EV50%" is spacing
    if (lost.length) return { v: 'dropped', lost: [...new Set(lost)] };
    return { v: squash(r.line) === squash(r.controller) ? 'confirmed' : 'respelled' };
  }
  if (r.verdict === 'option-missing') return { v: 'option' };
  if (r.verdict === 'syntax') return { v: SETUP.test(r.cause ?? '') ? 'setup' : 'rejected' };
  return { v: 'unsent' };
}
const RANK = ['confirmed', 'respelled', 'option', 'setup', 'dropped', 'vanished', 'rejected', 'unsent'];

const catalog = JSON.parse(fs.readFileSync(path.join(root, 'data', 'tp-syntax.json'), 'utf8')).items;
const items = new Map(catalog.map(i => [i.id, { id: i.id, keyword: i.keyword, kind: i.kind, option: i.option, confidence: i.confidence, hosts: {} }]));

for (const h of hosts) {
  const byLine = new Map();
  for (const f of h.files) for (const r of JSON.parse(fs.readFileSync(f, 'utf8'))) {
    // files are given oldest first: a later answer for the same line (a re-test, a re-check with the
    // full read-back) replaces the earlier one, unless the later run did not actually send it
    const prev = byLine.get(r.line);
    if (!prev || (r.verdict !== 'no-response' && r.verdict !== 'not-probed')) byLine.set(r.line, r);
  }
  for (const r of byLine.values()) {
    const it = items.get(r.id);
    if (!it) continue;
    const lv = lineVerdict(r);
    const slot = (it.hosts[h.label] ??= { lines: [] });
    slot.lines.push({ line: r.line, controller: r.controller, cause: r.cause, where: r.where, ...lv });
  }
}
for (const it of items.values()) {
  const all = Object.values(it.hosts).flatMap(s => s.lines);
  it.verdict = all.length ? all.map(l => l.v).sort((a, b) => RANK.indexOf(a) - RANK.indexOf(b))[0] : 'unsent';
  for (const s of Object.values(it.hosts)) s.best = s.lines.map(l => l.v).sort((a, b) => RANK.indexOf(a) - RANK.indexOf(b))[0];
}

const list = [...items.values()];
const count = v => list.filter(i => i.verdict === v).length;
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(`${out}.json`, JSON.stringify(list, null, 1));

if (verifiedOn) {
  // Positive results only. A rejection where the option is missing proves nothing, and the clear
  // rejections are fixed or noted in data/tp-syntax-overrides.json.
  const POSITIVE = new Set(['confirmed', 'respelled', 'option', 'setup']);
  // An item's examples can include context lines (the calling DB line, an L move before a C move,
  // an R[] assignment beside a CALL). A mark only counts from a line that is the item itself: one that
  // contains the literal start of one of its forms.
  const cat = new Map(catalog.map(c => [c.id, c]));
  const flat = s => (s ?? '').toUpperCase().replace(/[\s_]/g, '');
  const starts = c => (c?.forms ?? []).map(f => flat(f.replace(/^CALL\s+/i, 'CALL').replace(/^<motion>\s*/i, '').split(/<|\.\.\./)[0])).filter(s => /[A-Z]/.test(s) && s.length >= 2);
  const own = (id, line) => { const s = starts(cat.get(id)); return !s.length || s.some(x => flat(line).includes(x)); };
  const items = {};
  for (const i of list) {
    const lines = Object.values(i.hosts).flatMap(s => s.lines).filter(x => POSITIVE.has(x.v) && own(i.id, x.line));
    if (!lines.length) continue;
    i.verdict = lines.map(x => x.v).sort((a, b) => RANK.indexOf(a) - RANK.indexOf(b))[0];
    for (const s of Object.values(i.hosts)) s.best = s.lines.filter(x => own(i.id, x.line)).map(x => x.v).sort((a, b) => RANK.indexOf(a) - RANK.indexOf(b))[0];
    const l = lines.find(x => x.v === i.verdict);
    // name only the controllers that gave this verdict: "verified on HandlingTool" must not include one
    // that merely recognised the word without the option
    const on = Object.entries(i.hosts).filter(([, s]) => s.best === i.verdict).map(([h]) => h);
    items[i.id] = { verdict: i.verdict, on, ...(i.verdict === 'confirmed' || i.verdict === 'respelled' ? { stored: l.controller.split('\n').map(s => s.trim()).join(' ') } : {}) };
  }
  const file = path.join(root, 'data', 'tp-syntax-verified.json');
  fs.writeFileSync(file, JSON.stringify({
    about: 'Which catalog items a real FANUC controller accepted, from scripts/tp-option-probe.mjs via tp-probe-verdicts.mjs. verdict: confirmed (loaded and kept word for word), respelled (loaded, stored as "stored"), option (keyword recognised, option not installed), setup (recognised, needs configuration). Only positive results are listed.',
    controllers: verifiedOn,
    date: new Date().toISOString().slice(0, 10),
    items,
  }, null, 1) + '\n');
  console.log(`-> data/tp-syntax-verified.json: ${Object.keys(items).length} items`);
}
const opt = i => i.option ? `${i.option.code ?? ''} ${i.option.name ?? ''}`.trim() : '';
const hostCols = hosts.map(h => h.label);
const cell = (i, h) => i.hosts[h]?.best ?? '-';
const ex = (i, v) => Object.values(i.hosts).flatMap(s => s.lines).find(l => l.v === v);
const md = [
  '# TP catalog - verdicts from the controllers', '',
  `${list.length} catalog items on ${hostCols.join(', ')}: ${RANK.map(v => `${count(v)} ${v}`).join(', ')}.`, '',
  '## Dropped - accepted, but the controller silently removed part of the line', '',
  `| Item | Option | ${hostCols.join(' | ')} | Sent | Controller kept | Lost |`, `|---|---|${hostCols.map(() => '---').join('|')}|---|---|---|`,
  ...list.filter(i => i.verdict === 'dropped').map(i => { const l = ex(i, 'dropped'); return `| \`${i.keyword}\` | ${opt(i)} | ${hostCols.map(h => cell(i, h)).join(' | ')} | \`${l.line}\` | \`${l.controller}\` | ${l.lost.join(' ')} |`; }), '',
  '## Vanished - the program loaded but the line was thrown away (not installed here, or a wrong form)', '',
  ...list.filter(i => i.verdict === 'vanished').map(i => `- \`${i.keyword}\` ${opt(i)}: \`${ex(i, 'vanished').line}\``), '',
  '## Rejected on every controller', '',
  `| Item | Option | Conf. | Line | Cause |`, '|---|---|---|---|---|',
  ...list.filter(i => i.verdict === 'rejected').map(i => { const l = ex(i, 'rejected'); return `| \`${i.keyword}\` | ${opt(i)} | ${i.confidence} | \`${l.line}\` | ${(l.cause ?? '').replace(/\|/g, '/')} ${l.where ?? ''} |`; }), '',
  '## Respelled - accepted, the controller writes it differently', '',
  '| Item | Sent | Controller |', '|---|---|---|',
  ...list.filter(i => i.verdict === 'respelled').map(i => { const l = ex(i, 'respelled'); return `| \`${i.keyword}\` | \`${l.line}\` | \`${l.controller}\` |`; }), '',
  '## Recognised, needs setup on the controller', '', ...list.filter(i => i.verdict === 'setup').map(i => `- \`${i.keyword}\` - ${ex(i, 'setup').cause}`), '',
  '## Recognised, option not installed on the probed controllers', '', ...list.filter(i => i.verdict === 'option').map(i => `- \`${i.keyword}\` ${opt(i)}`), '',
  '## Not probed', '', ...list.filter(i => i.verdict === 'unsent').map(i => `- \`${i.keyword}\` ${opt(i)}`), '',
  '## Confirmed', '', ...list.filter(i => i.verdict === 'confirmed').map(i => `- \`${i.keyword}\``), '',
].join('\n');
fs.writeFileSync(`${out}.md`, md);
console.log(md.split('\n')[2]);
console.log(`-> ${path.relative(root, out)}.md / .json`);
