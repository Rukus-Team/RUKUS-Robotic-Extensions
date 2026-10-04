// Build the TP syntax catalog from data/tp-syntax.json (see scripts/import-tp-syntax.mjs):
//   - packages/fanuc/src/tp/syntaxCatalog.ts   hover entries, instruction heads the parser must not take
//                                               for macros, option macros, FANUC-supplied programs, completions
//   - syntaxes/tp.tmLanguage.json "catalog"     colouring for the words and phrases those forms use
//
//   node scripts/build-tp-syntax.mjs           write both
//   node scripts/build-tp-syntax.mjs --check   exit 1 if either is out of date (the unit test runs this)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const check = process.argv.includes('--check');
const data = JSON.parse(readFileSync(path.join(root, 'data', 'tp-syntax.json'), 'utf8'));
const items = data.items;
// data/tp-syntax-verified.json (scripts/tp-probe-verdicts.mjs --verified): what a real controller made of each item
const verifiedPath = path.join(root, 'data', 'tp-syntax-verified.json');
const verified = existsSync(verifiedPath) ? JSON.parse(readFileSync(verifiedPath, 'utf8')) : { items: {} };
/** the hover line for an item a controller accepted, or undefined */
function verifiedText(id) {
  const v = verified.items[id];
  if (!v) return undefined;
  const on = `${v.on?.length ? `${v.on.join(' and ')}, ` : ''}${verified.controllers}`;
  if (v.verdict === 'confirmed') return `Verified on a FANUC controller (${on}): loaded as written.`;
  if (v.verdict === 'respelled') return `Verified on a FANUC controller (${on}); the controller stores it as \`${v.stored}\`.`;
  if (v.verdict === 'option') return `Recognised by a FANUC controller without the option installed (${on}): the word is right, the operands were not checked.`;
  if (v.verdict === 'setup') return `Recognised by a FANUC controller (${on}); it needs the option configured before the line loads.`;
  return undefined;
}

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** the literal start of a form: everything before the first placeholder or "..." */
const literalStart = form => form.replace(/^CALL\s+/i, '').split(/<|\.\.\./)[0].replace(/\s+$/, '');
/** regex source for that literal start: flexible spacing, a word boundary after a trailing word char */
function startRegex(form) {
  const lit = literalStart(form);
  if (lit.replace(/[^A-Za-z]/g, '').length < 2) return undefined;
  let re = lit.split(/\s+/).map(esc).join('\\s*').replace(/(\\\[|\\\(|,|=)/g, '\\s*$1\\s*').replace(/(\\s\*)+/g, '\\s*');
  if (/[A-Za-z0-9_]$/.test(lit)) re += '\\b';
  return re.replace(/^(\\s\*)+|(\\s\*)+$/g, '');
}
const quoteTs = s => JSON.stringify(s);
const DATA_KINDS = new Set(['R', 'PR', 'SR', 'AR', 'VR', 'P', 'GP', 'DI', 'DO', 'RI', 'RO', 'GI', 'GO', 'AI', 'AO', 'UI', 'UO', 'SI', 'SO', 'F', 'M', 'WI', 'WO', 'LBL', 'JMP', 'CALL', 'RUN', 'IF', 'ON', 'OFF', 'AND', 'OR', 'NOT', 'MM', 'SEC', 'MSEC', 'DEG', 'CM', 'MIN', 'TO', 'THEN']);

// ---------------------------------------------------------------- hover docs + parser heads
const docs = [];          // { re, anywhere, title, syntax, description, notes, option, source }
const heads = [];         // instruction / macro heads the parser must not take for a user macro
const macros = new Set(); // option-supplied macro names (Prompt Box Msg ...): never "missing" from sysmacro.va
const programs = {};      // FANUC-supplied programs called from TP
const completions = [];   // { label, insert, detail, kind }
/** a motion option is written as a whole motion line ("J <position> <speed> <term> MROT"): keep the option */
const optionTail = f => f.replace(/^(?:[JLCAS]\s+)?(?:<[^>]*>\s*)+/, '').replace(/^\.\.\.\s*/, '').trim() || f;
for (const raw of items) {
  const it = raw.kind === 'motion-option' ? { ...raw, forms: [...new Set(raw.forms.map(optionTail))] } : raw;
  const isCallForm = f => /^CALL\s+/i.test(f);
  const option = it.option ? [it.option.code, it.option.name].filter(Boolean).join(' ') : undefined;
  const src = it.sources.map(s => `${s.manual}${s.pages?.length ? ` p.${s.pages.slice(0, 3).join(', ')}` : ''}`).filter((v, i, a) => a.indexOf(v) === i).slice(0, 2).join('; ');
  const ver = verifiedText(it.id);
  const accepted = ['confirmed', 'respelled'].includes(verified.items[it.id]?.verdict);
  const notes = [...(it.examples.length ? [`Example: \`${it.examples[0]}\``] : []), ...(it.confidence === 'medium' && !accepted ? ['Spelling not confirmed by a real .LS file yet - the manual shows it only in a figure or inconsistently.'] : [])];
  const res = [...new Set(it.forms.map(f => (it.kind === 'program-call' && isCallForm(f) ? `CALL\\s+${esc(f.replace(/^CALL\s+/i, '').split(/[\s(]/)[0])}\\b` : startRegex(f))).filter(Boolean))];
  if (!res.length) continue;
  const anywhere = it.kind !== 'instruction';
  docs.push({ res, anywhere, title: it.keyword, syntax: it.forms.join('\n'), description: it.summary, notes, option, source: src, ...(ver ? { verified: ver } : {}) });

  if (it.kind === 'instruction') for (const r of res) heads.push(r);
  if (it.kind === 'program-call') {
    for (const f of it.forms) {
      if (isCallForm(f)) {
        const name = f.replace(/^CALL\s+/i, '').split(/[\s(]/)[0].toUpperCase();
        if (/^[A-Z][A-Z0-9_]*$/.test(name)) programs[name] = { summary: it.summary, option };
      } else {
        // a macro instruction an option installs: "Prompt Box Msg(...)", "Grip Part" ...
        const name = literalStart(f).split('(')[0].trim();
        // still a macro call to the parser (cross-reference, macro hover); only never "missing"
        if (/^[A-Za-z]/.test(name)) macros.add(name.toUpperCase().replace(/\s+/g, ' '));
      }
    }
  }
  if (it.kind !== 'operand' && it.confidence === 'high') {
    for (const f of it.forms.slice(0, 3)) {
      let n = 0;
      const insert = f.replace(/<([^>]*)>/g, (_, p) => `\${${++n}:${p.replace(/[}$\\]/g, '')}}`).replace(/\.\.\./g, '');
      completions.push({ label: f, insert, detail: [it.keyword, option].filter(Boolean).join(' · '), kind: it.kind });
    }
  }
}

const ts = `// GENERATED by scripts/build-tp-syntax.mjs from data/tp-syntax.json - do not edit by hand.
// TP syntax from the FANUC manuals (instructions, motion options, operands, functions, option macros
// and FANUC-supplied programs) that the hand-written tables in docs.ts / parser.ts do not cover.
/* eslint-disable */
export interface CatalogDoc { res: string[]; anywhere: boolean; title: string; syntax: string; description: string; notes: string[]; option?: string; source?: string; verified?: string }
export const CATALOG_DOCS: CatalogDoc[] = ${JSON.stringify(docs, null, 0)};
/** literal heads of option instructions: a line starting with one is an instruction, not a macro call */
export const CATALOG_HEADS: string[] = ${JSON.stringify([...new Set(heads.filter(Boolean))], null, 0)};
/** macro instructions options install (upper case, single spaces) - never reported missing from sysmacro.va */
export const CATALOG_MACROS: string[] = ${JSON.stringify([...macros].sort(), null, 0)};
/** programs an option installs on the controller, called from TP - never reported as missing from the workspace */
export const FANUC_PROGRAMS: Record<string, { summary: string; option?: string }> = ${JSON.stringify(Object.fromEntries(Object.entries(programs).sort()), null, 0)};
export const CATALOG_COMPLETIONS: Array<{ label: string; insert: string; detail: string; kind: string }> = ${JSON.stringify(completions, null, 0)};
`;

// ---------------------------------------------------------------- grammar block
const phrases = new Set(), indexed = new Set(), words = new Set(), funcs = new Set();
// a phrase starting with a motion type or a base keyword is base syntax the grammar already colours
const BASE_FIRST = new Set(['J', 'L', 'C', 'A', 'S', 'WAIT', 'IF', 'SELECT', 'FOR', 'JMP', 'ACC', 'CNT', 'TB', 'TA', 'DB', 'CALL', 'RUN']);
const NOT_FUNCS = new Set(['WAIT', 'DIV', 'MOD', 'IF', 'AND', 'OR']);
/** a word worth colouring on its own: not a fragment, not a short mixed-case unit */
const wordOk = w => w.length >= 2 && !/_$/.test(w) && !DATA_KINDS.has(w.toUpperCase()) && (w.length > 2 || w === w.toUpperCase());
for (const it of items) {
  if (it.kind === 'program-call' && it.forms.every(f => /^CALL\s/i.test(f))) continue;    // the call rule colours those
  const macroLike = it.kind === 'program-call';                                             // "Prompt Box Msg(...)": the phrase only
  for (const f of it.forms) {
    const lit = f.replace(/<[^>]*>/g, ' ').replace(/'[^']*'|"[^"]*"/g, ' ');
    // a multi-word head ("Search Start", "Op. Entry Menu", "Prompt Box Msg"), minus trailing operand names
    const lead = /^([A-Za-z][A-Za-z0-9_.]*(?: [A-Za-z][A-Za-z0-9_.]*)+)/.exec(literalStart(f).replace(/\[.*$|\(.*$/, '').trim());
    if (lead) {
      const ws = lead[1].split(' ');
      while (ws.length && (DATA_KINDS.has(ws[ws.length - 1].toUpperCase()) || ws[ws.length - 1].length === 1 || /^(GP|ERR_NUM|LNSCH|LDR|UF)$/i.test(ws[ws.length - 1]))) ws.pop();
      if (ws.length >= 2 && ws.length <= 5 && !BASE_FIRST.has(ws[0].toUpperCase())) phrases.add(ws.join(' '));
    }
    if (macroLike) continue;
    // the head's words are coloured as the phrase; only what follows it is looked at word by word
    const rest = lead ? lit.slice(lit.indexOf(lead[1]) + lead[1].length) : lit;
    for (const m of rest.matchAll(/([A-Za-z_][A-Za-z0-9_]*)(\s*\[)?/g)) {
      const w = m[1];
      if (!wordOk(w)) continue;
      if (it.kind === 'function') { if (!NOT_FUNCS.has(w.toUpperCase())) funcs.add(w); }
      else if (m[2]) indexed.add(w);
      else words.add(w);
    }
  }
}
const alt = set => [...set].sort((a, b) => b.length - a.length || a.localeCompare(b)).map(w => w.split(' ').map(esc).join('\\s+')).join('|');
const catalog = {
  comment: 'GENERATED by scripts/build-tp-syntax.mjs from data/tp-syntax.json (FANUC manuals): option instructions, motion options and macros',
  patterns: [
    { match: `(?<![A-Za-z0-9_])(${alt(phrases)})(?![A-Za-z0-9_])`, name: 'keyword.control.option.tp' },
    { match: `\\b(${alt(indexed)})(?=\\s*\\[)`, name: 'keyword.control.option.tp' },
    { match: `\\b(${alt(funcs)})(?=\\s*\\[)`, name: 'support.function.tp' },
    { match: `\\b(${alt(words)})\\b`, name: 'keyword.control.option.tp' },
  ],
};

const gFile = path.join(root, 'syntaxes', 'tp.tmLanguage.json');
const gRaw = readFileSync(gFile, 'utf8');
const nl = gRaw.includes('\r\n') ? '\r\n' : '\n';
const block = `    "catalog": ${JSON.stringify(catalog)},${nl}`;
let gNext;
const at = gRaw.search(/^    "catalog": \{.*\},\r?\n/m);
if (at >= 0) gNext = gRaw.replace(/^    "catalog": \{.*\},\r?\n/m, () => block);
else {
  const k = gRaw.indexOf('    "keyword": {');
  if (k < 0) throw new Error('no "keyword" rule in the TP grammar');
  gNext = gRaw.slice(0, k) + block + gRaw.slice(k);
}
// instruction-body includes #catalog just before #keyword (one-time)
if (!/"include":\s*"#catalog"/.test(gNext)) gNext = gNext.replace(/(\{\s*"include":\s*"#keyword"\s*\})/, '{ "include": "#catalog" }, $1');
JSON.parse(gNext);

const tsFile = path.join(root, 'packages', 'fanuc', 'src', 'tp', 'syntaxCatalog.ts');
const tsNext = ts.replace(/\r?\n/g, nl);
let tsPrev = ''; try { tsPrev = readFileSync(tsFile, 'utf8'); } catch { /* new */ }
if (check) {
  // line endings do not count: with core.autocrlf Git checks these files out with CRLF, the build writes LF
  const same = (a, b) => a.replace(/\r\n/g, '\n') === b.replace(/\r\n/g, '\n');
  const stale = [!same(tsPrev, tsNext) && 'syntaxCatalog.ts', !same(gRaw, gNext) && 'tp.tmLanguage.json'].filter(Boolean);
  if (stale.length) { console.error(`out of date: ${stale.join(', ')} - run node scripts/build-tp-syntax.mjs`); process.exit(1); }
  console.log('tp syntax catalog up to date');
} else {
  writeFileSync(tsFile, tsNext);
  writeFileSync(gFile, gNext);
  console.log(`catalog: ${docs.length} hover entries, ${heads.length} instruction/macro heads, ${macros.size} option macros, ${Object.keys(programs).length} FANUC programs, ${completions.length} completions; grammar: ${phrases.size} phrases, ${indexed.size} indexed words, ${funcs.size} functions, ${words.size} words`);
}
