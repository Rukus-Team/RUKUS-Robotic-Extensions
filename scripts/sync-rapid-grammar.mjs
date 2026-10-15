// Writes the RAPID built-in names into syntaxes/rapid.tmLanguage.json, so the colouring knows every instruction,
// function and data type the language support knows (scripts/rapid-names.mjs: builtins.ts's hand lists, the RW6 and
// RW8 reference, both manuals' names). Run it after scripts/import-rapid-rw8.mjs or after editing builtins.ts;
// test/rapidCoverage.test.ts fails when the grammar is behind.
//
//   node scripts/sync-rapid-grammar.mjs
//
// Longest names first in each list, so a regex alternative never stops at a shorter prefix (MoveL before Move...).
import { readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rapidNames } from './rapid-names.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(root, 'syntaxes', 'rapid.tmLanguage.json');
const g = JSON.parse(readFileSync(file, 'utf8'));
const n = rapidNames(root, true);
const alt = list => [...new Set(list)].sort((a, b) => b.length - a.length || a.localeCompare(b)).join('|');
const set = (rule, before, list, after) => {
  const r = g.repository[rule];
  if (!r.match.startsWith(before) || !r.match.endsWith(after)) throw new Error(`${rule}: unexpected match ${r.match.slice(0, 40)}...`);
  r.match = `${before}${alt(list)}${after}`;
};
set('instruction', '(?i)^\\s*(', n.instructions, ')\\b');
set('function', '(?i)\\b(', n.functions, ')(?=\\s*\\()');
set('type', '(?i)\\b(', n.types, ')\\b');
writeFileSync(file, JSON.stringify(g, null, 2) + '\n');
console.log(`syntaxes/rapid.tmLanguage.json: ${n.instructions.length} instructions, ${n.functions.length} functions, ${n.types.length} types`);
