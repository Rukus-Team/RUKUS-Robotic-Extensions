// Writes the three package.json blocks that the file-icon table implies - activationEvents,
// contributes.languages and contributes.grammars - from FILE_ICONS in make-file-icons.mjs, so a
// file type is added in ONE place. package.json has hand-formatted lines elsewhere, so this
// splices text between two anchors instead of re-serialising the whole file.
//
//   node scripts/sync-file-icon-manifest.mjs          rewrite the blocks
//   node scripts/sync-file-icon-manifest.mjs --check  exit 1 if package.json is out of date
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { manifestBlocks } from './make-file-icons.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(repo, 'package.json');
const raw = readFileSync(file, 'utf8');
const eol = raw.includes('\r\n') ? '\r\n' : '\n';
const lines = raw.split(/\r?\n/);

const start = lines.findIndex(l => l === '  "activationEvents": [');
const end = lines.findIndex((l, i) => i > start && l === '    "snippets": [');
if (start < 0 || end < 0) { console.error('sync-file-icon-manifest: could not find the activationEvents / snippets anchors in package.json'); process.exit(1); }

const { languages, grammars, activation } = manifestBlocks();
// whatever activates the extension besides a language stays exactly as it was
const keep = [];
for (let i = start + 1; i < lines.length && !/^\s*\],?$/.test(lines[i]); i++) { const m = /^\s*"(.+)",?$/.exec(lines[i]); if (m && !m[1].startsWith('onLanguage:')) keep.push(m[1]); }

const block = (key, value, indent) => (`"${key}": ` + JSON.stringify(value, null, 2)).split('\n').map(l => indent + l);
const comma = arr => arr.map((l, i) => (i === arr.length - 1 ? l + ',' : l));
const out = [
  ...comma(block('activationEvents', [...activation, ...keep], '  ')),
  '  "contributes": {',
  ...comma(block('languages', languages, '    ')),
  ...comma(block('grammars', grammars, '    ')),
];
const next = [...lines.slice(0, start), ...out, ...lines.slice(end)].join(eol);
JSON.parse(next.split(eol).join('\n'));   // never write something that is not JSON

if (process.argv.includes('--check')) {
  if (next !== raw) { console.error('package.json is out of date with scripts/make-file-icons.mjs - run node scripts/sync-file-icon-manifest.mjs'); process.exit(1); }
  console.log(`package.json: ${languages.length} languages, ${grammars.length} grammar bindings - in sync`);
} else {
  if (next !== raw) writeFileSync(file, next);
  console.log(`package.json: ${languages.length} languages, ${grammars.length} grammar bindings${next === raw ? ' (already in sync)' : ' written'}`);
}
