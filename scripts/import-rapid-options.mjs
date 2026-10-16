// Adds the RAPID of options that RobotWare's instruction manuals leave out, from their own application manuals:
// Externally Guided Motion (EGM), SoftMove (Cartesian Soft Servo, CSS) and Force Control (FC).
//
//   node scripts/import-rapid-options.mjs <pdf>...
//
// with any of: 3HAC073319 / 3HAC073318 (EGM, RobotWare 6 / 7), 3HAC050977 / 3HAC066560 (SoftMove, RobotWare 6 /
// OmniCore), 3HAC050377 / 3HAC090251 / 3HAC083267 (Force Control, RobotWare 6 / OmniCore Standard / Standard for GoFa).
// The Force Control Package product manual (3HAC091307) has no RAPID reference.
//
// Rewrites the `manuals` part of packages/abb/src/rapid/reference-options.json: every instruction, function and data
// type each manual's chapter "RAPID reference information" lists, with the option its page header names (names only;
// which manual has what, for test/rapidCoverage.test.ts and the "RobotWare 6 only" / "OmniCore only" notes).
// The `entries` part (signatures: argument names, types, optional / switch / alternatives, return types, predefined
// values) is kept as it is: it was written from the manuals' syntax sections, with summaries and argument descriptions
// in our own words. The script lists the names that still have no entry, and entries no manual lists.
// reference.ts merges the entries in.
// Needs pdftotext (Git for Windows ships it; set PDFTOTEXT to another path). Temporary files go to the OS temp dir.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// the manuals this knows, by document number: key, title, RobotWare ('6': IRC5; 'omnicore': RobotWare 7 and later), the option
const MANUALS = {
  '3HAC073319': { key: 'egm6', rw: '6', option: 'Externally Guided Motion', title: '3HAC073319 Application manual - Externally Guided Motion, RobotWare 6 (IRC5)' },
  '3HAC073318': { key: 'egm7', rw: 'omnicore', option: 'Externally Guided Motion', title: '3HAC073318 Application manual - Externally Guided Motion, RobotWare 7 (OmniCore)' },
  '3HAC050977': { key: 'css6', rw: '6', option: 'SoftMove (Cartesian Soft Servo)', title: '3HAC050977 Application manual - SoftMove, RobotWare 6 (IRC5)' },
  '3HAC066560': { key: 'css7', rw: 'omnicore', option: 'SoftMove (Cartesian Soft Servo)', title: '3HAC066560 Application manual - SoftMove, OmniCore' },
  '3HAC050377': { key: 'fc6', rw: '6', option: 'Force Control', title: '3HAC050377 Application manual - Force Control, RobotWare 6 (IRC5)' },
  '3HAC090251': { key: 'fc7', rw: 'omnicore', option: 'Force Control', title: '3HAC090251 Application manual - Force Control Standard, OmniCore' },
  '3HAC083267': { key: 'fcgofa', rw: 'omnicore', option: 'Force Control', title: '3HAC083267 Application manual - Force Control Standard for GoFa, RobotWare 7' },
};
const pdfs = process.argv.slice(2);
if (!pdfs.length || pdfs.some(p => !fs.existsSync(p) || !MANUALS[/3HAC\d{6}/i.exec(path.basename(p))?.[0]?.toUpperCase()])) {
  console.error(`usage: node scripts/import-rapid-options.mjs <pdf>...  (one or more of ${Object.keys(MANUALS).join(', ')})`);
  process.exit(2);
}
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(repo, 'packages', 'abb', 'src', 'rapid', 'reference-options.json');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rapid-options-'));
const U = s => s.toUpperCase();

function pdfText(pdf) {
  const out = path.join(tmp, 'manual.txt');
  for (const exe of [process.env.PDFTOTEXT, 'pdftotext', 'C:/Program Files/Git/mingw64/bin/pdftotext.exe'].filter(Boolean)) {
    try { execFileSync(exe, ['-enc', 'UTF-8', pdf, out], { stdio: ['ignore', 'ignore', 'pipe'] }); return fs.readFileSync(out, 'utf8'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  throw new Error('pdftotext not found (set PDFTOTEXT to its path)');
}

/**
 * [kind, name, option] of the chapter "RAPID reference information", from the table of contents: its sections
 * N.1 / N.2 / N.3 are Instructions, Functions, Data types (N is 5 in the EGM and SoftMove manuals, 7 or 8 in Force
 * Control's). The option is the manual's, unless the entry's page header names RobotWare Base / RobotWare - OS
 * (IsCSSAct, EGM_MAX_RAPID_DNUM): '' then.
 */
function names(text, option) {
  const KIND = { Instructions: 'instruction', Functions: 'function', 'Data types': 'type' };
  const toc = text;   // only the table of contents has dot leaders
  const section = new Map();
  for (const m of toc.matchAll(/\b(\d)\.(\d) (Instructions|Functions|Data types) \.{3,}/g)) section.set(`${m[1]}.${m[2]}`, KIND[m[3]]);
  const out = new Map();
  // `5.1.3 CSSDeactMoveL - Moves the robot ... Soft Servo . 35`: a long title leaves a single leader dot
  for (const m of toc.matchAll(/\b(\d)\.(\d)\.(\d+) ([A-Za-z_]\w*)(?: [-\u2013] [^.]*?)? \.+ \d+/g)) {
    const kind = section.get(`${m[1]}.${m[2]}`);
    if (!kind || out.has(`${kind}:${U(m[4])}`)) continue;
    // a page header such as `5.2.1 IsCSSAct - Test if ... RobotWare Base`
    const base = new RegExp(String.raw`^\s*${m[1]}\.${m[2]}\.${m[3]} ${m[4]}\b.*\bRobotWare( Base|\s*-\s*OS)\s*$`, 'm').test(text);
    out.set(`${kind}:${U(m[4])}`, [kind, m[4], base ? '' : option]);
  }
  return [...out.values()].sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1], 'en', { sensitivity: 'base' }));
}

const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
doc.manuals ??= {};
for (const pdf of pdfs) {
  const m = MANUALS[U(/3HAC\d{6}/i.exec(path.basename(pdf))[0])];
  doc.manuals[m.key] = { source: m.title, rw: m.rw, entries: names(pdfText(pdf), m.option) };
  console.log(`${m.key}: ${doc.manuals[m.key].entries.length} names`);
}
doc.manuals = Object.fromEntries(Object.entries(doc.manuals).sort(([a], [b]) => a.localeCompare(b)));
// one array per line, as manual-names.json
fs.writeFileSync(file, JSON.stringify(doc, null, 2)
  .replace(/\[\n\s+"(instruction|function|type)",\n\s+("(?:[^"\\]|\\.)*"),\n\s+("(?:[^"\\]|\\.)*")\n\s+\]/g, '["$1", $2, $3]') + '\n');
fs.rmSync(tmp, { recursive: true, force: true });

const listed = new Set(Object.values(doc.manuals).flatMap(x => x.entries.map(e => `${e[0]}:${U(e[1])}`)));
const have = new Set(doc.entries.map(e => `${e.kind}:${U(e.name)}`));
const noEntry = [...listed].filter(k => !have.has(k));
const noManual = [...have].filter(k => !listed.has(k));
if (noEntry.length) console.log(`write an entry (signature from the manual, summary in our own words) for: ${noEntry.join(', ')}`);
if (noManual.length) console.log(`entries no manual lists: ${noManual.join(', ')}`);
