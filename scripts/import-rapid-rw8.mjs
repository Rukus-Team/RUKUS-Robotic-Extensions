// Adds RobotWare 8 (OmniCore) to the RAPID reference, beside the RobotWare 6 one that
// scripts/import-rapid-manual.mjs builds into packages/abb/src/rapid/reference.json.
//
//   node scripts/import-rapid-rw8.mjs "<3HAC098387 TRM RAPID RW 8-en.pdf>" "<3HAC050917 TRM RAPID RW 6-en.chm | its hh -decompile folder>"
//
// Writes two files next to reference.json (reference.ts merges them in when the extension loads):
//  - manual-names.json: every instruction, function and data type of each manual, with the option
//    its page header names (empty for RobotWare Base). Names only: which RobotWare has what, and the
//    list test/rapidCoverage.test.ts holds the language support to.
//  - reference-rw8.json: what RobotWare 8 adds - entries reference.json does not have (signature,
//    return type, record components, option), arguments RW8 adds to entries it has (`addArgs`,
//    placed after the argument named in `after`), a different RW8 option (`option8`) or return type
//    (`returns8`), and `fixKind` where the RW6 import filed a function as an instruction.
//    Only names, types and the formal syntax are taken from the manual. An entry's `summary` is
//    written by hand in our own words; the script keeps the summaries already in the file and lists
//    the entries that still need one.
// The RW6 manual on this PC is RobotStudio's compiled help (.chm, RobotWare 6.16); its names come from
// its table of contents (toc.hhc) and the option from each page's header. hh.exe decompiles it (Windows).
// Temporary files go to the OS temp dir, never the repo.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const [pdf, chm] = process.argv.slice(2);
if (!pdf || !fs.existsSync(pdf) || !chm || !fs.existsSync(chm)) {
  console.error('usage: node scripts/import-rapid-rw8.mjs "<3HAC098387 RW 8 pdf>" "<3HAC050917 RW 6 chm or decompiled folder>"');
  process.exit(2);
}
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(repo, 'packages', 'abb', 'src', 'rapid');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rapid-rw8-'));
const KIND = { 1: 'instruction', 2: 'function', 3: 'type' };
const U = s => s.toUpperCase();

// ---------------------------------------------------------------- RW8: the importer's parse of the PDF
const rw8Json = path.join(tmp, 'rw8.json');
execFileSync(process.execPath, [path.join(repo, 'scripts', 'import-rapid-manual.mjs'), pdf, '--out', rw8Json,
  '--source', '3HAC098387 RAPID Instructions, Functions and Data Types, RobotWare 8'], { stdio: 'inherit' });
const rw8 = JSON.parse(fs.readFileSync(rw8Json, 'utf8')).entries;

// RW8 names and options from the entry headings: the page header repeats `1.1 AccSet - Reduces the acceleration RobotWare Base`
function pdfText() {
  const out = path.join(tmp, 'rw8.txt');
  for (const exe of [process.env.PDFTOTEXT, 'pdftotext', 'C:/Program Files/Git/mingw64/bin/pdftotext.exe'].filter(Boolean)) {
    try { execFileSync(exe, ['-enc', 'UTF-8', pdf, out], { stdio: ['ignore', 'ignore', 'pipe'] }); return fs.readFileSync(out, 'utf8'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  throw new Error('pdftotext not found (set PDFTOTEXT to its path)');
}
function rw8Names() {
  const heads = new Map();
  for (const m of pdfText().matchAll(/^\s*([123])\.(\d+) (\S+) [-\u2013] (.+?)\s*$/gm)) {
    if (/\.{4}/.test(m[4])) continue;   // the table of contents
    const key = `${m[1]}.${m[2]}`;
    if (!heads.has(key)) heads.set(key, { kind: KIND[m[1]], name: m[3], titles: new Set() });
    heads.get(key).titles.add(m[4].replace(/\s+Continued$/, ''));
  }
  return [...heads.values()].map(h => {
    const t = [...h.titles].sort((a, b) => a.length - b.length);
    const longer = t.slice(1).find(x => x.startsWith(t[0] + ' '));
    return { kind: h.kind, name: h.name, option: longer ? longer.slice(t[0].length).trim() : '' };
  });
}

// ---------------------------------------------------------------- RW6: the CHM's table of contents
function rw6Names() {
  let folder = chm;
  if (/\.chm$/i.test(chm)) {
    folder = path.join(tmp, 'rw6');
    fs.mkdirSync(folder);
    try { execFileSync('hh.exe', ['-decompile', folder, path.resolve(chm)], { stdio: 'ignore' }); } catch { /* hh exits 1 on success */ }
  }
  const toc = fs.readFileSync(path.join(folder, 'toc.hhc'), 'utf8');
  const un = s => s.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  const out = [];
  const stack = [];
  let last;
  for (const m of toc.matchAll(/<UL>|<\/UL>|<param name="Name" value="([^"]*)">(?:\s*<param name="Local" value="([^"]*)">)?/gi)) {
    if (/^<UL>$/i.test(m[0])) { stack.push(last); continue; }
    if (/^<\/UL>$/i.test(m[0])) { stack.pop(); continue; }
    last = un(m[1]);
    const chapter = stack.filter(Boolean);
    const kind = { Instructions: 'instruction', Functions: 'function', 'Data types': 'type' }[chapter[0]];
    if (chapter.length !== 1 || !kind || !m[2]) continue;
    const h = /^(\S+)\s+[-\u2013]\s+/.exec(last);
    if (!h) continue;
    const page = fs.readFileSync(path.join(folder, m[2]), 'utf8');
    const opt = /class="maplabel">[\s\S]*?<\/span><\/td><\/tr><tr><td[^>]*><span class="italic">([^<]*)<\/span>/.exec(page);
    out.push({ kind, name: h[1].replace(/^"(.*)"$/, '$1'), option: opt ? un(opt[1]).trim() : '' });
  }
  return out;
}

// ---------------------------------------------------------------- merge
const base = JSON.parse(fs.readFileSync(path.join(dir, 'reference.json'), 'utf8')).entries;
const baseBy = new Map(base.map(e => [`${e.kind}:${U(e.name)}`, e]));
const baseNames = new Map();
for (const e of base) baseNames.set(U(e.name), [...(baseNames.get(U(e.name)) ?? []), e]);
const extraFile = path.join(dir, 'reference-rw8.json');
const kept = new Map(fs.existsSync(extraFile) ? JSON.parse(fs.readFileSync(extraFile, 'utf8')).entries.map(e => [`${e.kind}:${U(e.name)}`, e.summary]) : []);

const names8 = rw8Names();
const names6 = rw6Names();
const option8 = new Map(names8.map(n => [`${n.kind}:${U(n.name)}`, n.option === 'RobotWare Base' ? '' : n.option]));
const isBase = o => !o || /^RobotWare( Base|\s*-\s*OS)$/i.test(o);
const noDesc = a => Object.fromEntries(Object.entries(a).filter(([k, v]) => k !== 'desc' && v !== undefined));

const extra = [];
const needSummary = [];
for (const e of rw8) {
  const key = `${e.kind}:${U(e.name)}`;
  const was = baseBy.get(key);
  const opt8 = option8.get(key) ?? '';
  if (!was) {
    const x = { name: e.name, kind: e.kind, summary: kept.get(key) ?? '' };
    if (!x.summary) needSummary.push(`${e.kind} ${e.name}`);
    if (e.syntax) x.syntax = e.syntax;
    if (e.args?.length) x.args = e.args.map(noDesc);
    if (e.returns) x.returns = e.returns;
    if (e.components?.length) x.components = e.components.map(noDesc);
    if (!isBase(opt8)) x.option = opt8;
    // the RW6 import filed this name under another kind (its PDF's chapter); RW6.16 and RW8 agree on this one
    if ((baseNames.get(U(e.name)) ?? []).some(b => b.kind !== e.kind) && names6.some(n => n.kind === e.kind && U(n.name) === U(e.name))) x.fixKind = true;
    extra.push(x);
    continue;
  }
  const x = { name: was.name, kind: e.kind };
  // arguments RW8 adds, each after the argument it follows in the RW8 syntax (RW8's alternatives keep their own groups)
  const had = new Set((was.args ?? []).map(a => U(a.name)));
  const add = [];
  (e.args ?? []).forEach((a, i) => {
    if (had.has(U(a.name))) return;
    const y = noDesc(a);
    if (y.alt !== undefined) y.alt += 100;
    if (i > 0) y.after = e.args[i - 1].name;
    add.push(y);
  });
  // a parse that lost most of the RW6 arguments is not a new signature (the importer misses a few RW8 layouts)
  const lost = (was.args ?? []).filter(a => !(e.args ?? []).some(b => U(b.name) === U(a.name))).length;
  if (add.length && lost <= (was.args ?? []).length / 2) x.addArgs = add;
  if (e.returns && was.returns && U(e.returns) !== U(was.returns)) x.returns8 = e.returns;
  // the same option spelled differently ("Continuous Application Platform (CAP)") is not a change
  const norm = o => (isBase(o) ? '' : o ?? '').toLowerCase().replace(/\s*\([^)]*\)/g, '').trim();
  if (norm(opt8) !== norm(was.option)) x.option8 = opt8 || 'RobotWare Base';
  if (Object.keys(x).length > 2) extra.push(x);
}
extra.sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) || a.kind.localeCompare(b.kind));

const list = ns => ns.filter(n => /^[A-Za-z_]\w*$/.test(n.name)).map(n => [n.kind, n.name, isBase(n.option) ? '' : n.option])
  .sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1], 'en', { sensitivity: 'base' }));
const today = new Date().toISOString().slice(0, 10);
fs.writeFileSync(path.join(dir, 'manual-names.json'), JSON.stringify({
  note: 'Names only: [kind, name, option ("" = RobotWare Base)]. Written by scripts/import-rapid-rw8.mjs.',
  generated: today,
  rw6: { source: '3HAC050917 Technical reference manual - RAPID Instructions, Functions and Data types, RobotWare 6.16', entries: list(names6) },
  rw8: { source: '3HAC098387 Technical reference manual - RAPID Instructions, Functions and Data types, RobotWare 8.2', entries: list(names8) },
}, null, 1).replace(/\[\n\s+"(instruction|function|type)",\n\s+("(?:[^"\\]|\\.)*"),\n\s+("(?:[^"\\]|\\.)*")\n\s+\]/g, '["$1", $2, $3]') + '\n');
fs.writeFileSync(extraFile, JSON.stringify({
  source: '3HAC098387 RAPID Instructions, Functions and Data Types, RobotWare 8 (names, syntax and types; summaries in our own words)',
  generated: today,
  entries: extra,
}, null, 2) + '\n');
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`manual-names.json: RW6 ${names6.length}, RW8 ${names8.length}`);
console.log(`reference-rw8.json: ${extra.length} entries (${extra.filter(e => e.summary !== undefined).length} new, ${extra.filter(e => e.addArgs).length} with RW8 arguments)`);
if (needSummary.length) console.log(`write a summary (own words) for: ${needSummary.join(', ')}`);
