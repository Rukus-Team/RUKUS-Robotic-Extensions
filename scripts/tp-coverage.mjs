// Which words in real TP programs does the TP grammar not know? Reads every .ls under the folders
// given (default: the reference backup and RUKUS's test corpus), takes the /MN lines, drops what is
// data (comments, strings, [..] contents, numbers), and lists each unknown upper-case word with a count
// and one example line. Used to find syntax the grammar is missing, e.g. instructions from options
// none of our test robots had.
//   node scripts/tp-coverage.mjs [folder ...]
import { readFileSync, readdirSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const folders = process.argv.slice(2).length ? process.argv.slice(2) : [path.join(root, '..', 'reference-backup'), path.join(root, '..', 'Robotic Utility Kit', 'RUKUS.Tests', 'TestData')];

// every word any grammar pattern can match: the alternations inside \b(...)\b, split on |
const grammar = JSON.stringify(JSON.parse(readFileSync(path.join(root, 'syntaxes', 'tp.tmLanguage.json'), 'utf8')));
const known = new Set();
// every word of every alternation group in any pattern: \b(A|B C|D)\b, (?<!..)(A\s+B|C), (A|B)(?=\[) ...
for (const m of grammar.matchAll(/\(([^()]*\|[^()]*)\)/g))
  for (const w of m[1].split('|')) for (const p of w.split(/\\\\s[+*]|\\\\\.|\s+|\\\\b/)) if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(p)) known.add(p.toUpperCase());

function* lsFiles(dir, depth = 0) {
  let names; try { names = readdirSync(dir); } catch { return; }
  for (const n of names) {
    const p = path.join(dir, n);
    let st; try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) { if (depth < 12 && !/^(node_modules|\.git)$/.test(n)) yield* lsFiles(p, depth + 1); }
    else if (/\.ls$/i.test(n)) yield p;
  }
}

const unknown = new Map();   // WORD -> { count, files:Set, example }
let files = 0, lines = 0;
for (const f of folders) for (const file of lsFiles(f)) {
  files++;
  const text = readFileSync(file, 'latin1');
  const mn = /\/MN\s*\r?\n([\s\S]*?)(?:\r?\n\/POS|\r?\n\/END|$)/i.exec(text);
  if (!mn) continue;
  for (const raw of mn[1].split(/\r?\n/)) {
    let l = raw.replace(/^\s*\d*\s*:\s*/, '').replace(/;\s*$/, '');
    if (/^\s*(!|\/\/|--eg)/.test(l)) continue;
    lines++;
    l = l.replace(/\b(CALL|RUN)\s+[A-Za-z_][A-Za-z0-9_]*/g, ' ')    // program names: the call rule colours them
         .replace(/'[^']*'|"[^"]*"/g, ' ')                       // strings
         .replace(/\b\d+(mm\/sec|cm\/min|inch\/min|deg\/sec|sec|msec|%)/gi, ' ')   // speeds (the speed rule)
         .replace(/\bCNT\d+\b/g, ' ')
         .replace(/\[[^\]]*\]/g, '[]')                             // register/label contents and comments
         .replace(/\b\d+(\.\d+)?\b/g, ' ');
    for (const w of l.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []) {
      const W = w.toUpperCase();
      if (known.has(W) || W.length < 2) continue;
      const e = unknown.get(W) ?? { count: 0, files: new Set(), example: raw.trim() };
      e.count++; e.files.add(path.basename(file)); unknown.set(W, e);
    }
  }
}
const rows = [...unknown.entries()].sort((a, b) => b[1].count - a[1].count);
console.log(`${files} programs, ${lines} /MN lines, ${known.size} grammar words, ${rows.length} unknown words\n`);
for (const [w, e] of rows) console.log(`${String(e.count).padStart(6)}  ${w.padEnd(22)} ${String(e.files.size).padStart(4)} files   ${e.example.slice(0, 110)}`);
