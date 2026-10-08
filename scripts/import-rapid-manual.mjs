// Builds packages/abb/src/rapid/reference.json - a machine-readable RAPID reference - from
// ABB's "Technical reference manual - RAPID Instructions, Functions and Data types"
// (3HAC050917, RobotWare 6).
//
//   node scripts/import-rapid-manual.mjs "<3HAC050917 ... RW 6-en.pdf>"
//
// The PDF is run through pdftotext twice, into the OS temp dir (never the repo):
//  - plain (reading order) for the prose: Usage, Arguments, Return value, Components. Each
//    argument/component there carries a `Data type: x` line, and its description follows it.
//    The margin headings (the argument names) drift away from their bodies in both modes, so
//    descriptions are matched to arguments by walking those `Data type:` lines in order;
//  - -layout for the two formal blocks: Syntax (one argument per line, the grammar the
//    arguments are read from) and Structure (the record components, indented by depth).
// Every entry opens with a heading `1.146 MoveL - Moves the robot linearly`; chapter 1 is
// instructions, 2 functions, 3 data types. Page furniture (manual title, document number and
// revision, copyright, page numbers, the repeated section header) is stripped first.
//
// Output is deterministic (entries sorted by name, fixed key order) apart from `generated`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const pdf = process.argv[2];
if (!pdf || !fs.existsSync(pdf)) { console.error('usage: node scripts/import-rapid-manual.mjs "<3HAC050917 RAPID Instructions, Functions and Data Types.pdf>"'); process.exit(2); }
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outPath = path.join(repo, 'packages', 'abb', 'src', 'rapid', 'reference.json');

// ---------------------------------------------------------------- pdftotext
function pdftotext(layout) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rapid-manual-'));
  const out = path.join(tmp, layout ? 'layout.txt' : 'plain.txt');
  const candidates = [process.env.PDFTOTEXT, 'pdftotext', 'C:/Program Files/Git/mingw64/bin/pdftotext.exe'].filter(Boolean);
  for (const exe of candidates) {
    try {
      execFileSync(exe, ['-enc', 'UTF-8', ...(layout ? ['-layout'] : []), pdf, out], { stdio: ['ignore', 'ignore', 'pipe'] });
      const text = fs.readFileSync(out, 'utf8');
      fs.rmSync(tmp, { recursive: true, force: true });
      return text;
    } catch (e) { if (e.code !== 'ENOENT') { fs.rmSync(tmp, { recursive: true, force: true }); throw e; } }
  }
  throw new Error('pdftotext not found (set PDFTOTEXT to its path)');
}
// some headings use an en dash between name and title: `1.24 CamWaitLoadJob – Wait until ...`
const dashes = t => t.replace(/ – /g, ' - ');
const plainText = dashes(pdftotext(false));
const layoutText = dashes(pdftotext(true));

// ---------------------------------------------------------------- sections
const KIND = { 1: 'instruction', 2: 'function', 3: 'type' };
/** `1.146 MoveL - Moves the robot linearly` - the body heading of an entry (a TOC line has dot leaders) */
const HEAD = /^\s*([123])\.(\d+) (\S.*?) - (.+?)\s*$/;

/** Splits a text into entries keyed `1.146`, each the text from its first heading to the next entry's. */
function sections(text) {
  const lines = text.split(/\r?\n/);
  // the body starts at the second `1 Instructions` chapter heading (the first is in the TOC)
  let start = 0, seenToc = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*1 Instructions\s*$/.test(lines[i])) { if (seenToc || i > 500) { start = i; break; } seenToc = true; }
  }
  let end = lines.findIndex((l, i) => i > start && /^\s*4 Programming type examples\s*$/.test(l) && !/\.{4}/.test(l));
  if (end < 0) end = lines.length;
  const firsts = [];
  const seen = new Set();
  let expect = { 1: 1, 2: 1, 3: 1 };
  for (let i = start; i < end; i++) {
    const m = HEAD.exec(lines[i]);
    if (!m || /\.{4}/.test(lines[i])) continue;
    const id = `${m[1]}.${m[2]}`;
    if (seen.has(id)) continue;
    // entries come in order; a cross-reference that happens to look like a heading does not
    if (Number(m[2]) !== expect[m[1]]) continue;
    seen.add(id); expect[m[1]]++;
    firsts.push({ id, chapter: Number(m[1]), name: m[3].trim(), line: i });
  }
  // the title: the shortest spelling of the heading (the page header repeats it with the option appended)
  const titles = new Map();
  for (let i = start; i < end; i++) {
    const m = HEAD.exec(lines[i]);
    if (!m || /\.{4}/.test(lines[i])) continue;
    const id = `${m[1]}.${m[2]}`, t = m[4].replace(/\s+Continued$/, '');
    if (seen.has(id) && (!titles.has(id) || t.length < titles.get(id).length)) titles.set(id, t);
  }
  const out = new Map();
  for (let k = 0; k < firsts.length; k++) {
    const f = firsts[k];
    out.set(f.id, { ...f, title: titles.get(f.id), lines: lines.slice(f.line, firsts[k + 1]?.line ?? end) });
  }
  return out;
}

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Removes the page furniture from an entry's lines (substring-wise: in -layout a margin label can share the line). */
function clean(lines, id, name, title) {
  const header = new RegExp(`${esc(id)} ${esc(name)} - ${esc(title).replace(/ /g, '\\s+')}(\\s+(RobotWare\\s*-\\s*OS|[^\\n]*?))?(\\s+Continued)?\\s*$`);
  const out = [];
  lines.forEach((l, i) => {
    let s = l
      .replace(/Technical reference manual - RAPID Instructions, Functions and Data types/g, '')
      .replace(/Continues on next page/g, '')
      .replace(/3HAC050917-001 Revision: \S+/g, '')
      .replace(/(?:©|\uFFFD)?\s*Copyright \d{4}-\d{4} ABB\. All rights reserved\./g, '');
    if (/^\s*[123] (Instructions|Functions|Data types)\s*$/.test(s)) return;
    s = s.replace(/\s+[123] (Instructions|Functions|Data types)\s*$/, '');
    if (header.test(s.trim())) s = s.replace(header, '');
    if (/^\s*(RobotWare\s*-\s*OS)?\s*(Continued)?\s*$/.test(s) && /\S/.test(s)) return;
    s = s.replace(/\s{2,}Continued\s*$/, '');
    if (/^\s*\d{1,4}\s*$/.test(s)) return; // page number
    out.push(s.replace(/\s+$/, ''));
  });
  return out;
}

/** The option named on the entry's page header: `1.62 CorrWrite - Writes to a correction generator Path Offset` */
function optionOf(rawLines, name, title, id) {
  const re = new RegExp(`^${esc(id)} ${esc(name)} - ${esc(title)}\\s+(.+?)(\\s+Continued)?$`);
  for (const l of rawLines) {
    const m = re.exec(l.trim());
    if (m) {
      const opt = m[1].trim();
      if (/^RobotWare\s*-\s*OS$/i.test(opt) || /^Continued$/.test(opt)) return undefined;
      return opt;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------- prose helpers
const flat = s => s.replace(/\u00AD/g, '').replace(/[\u2022\uFFFD]/g, ' ').replace(/\s+/g, ' ').trim();
/** The first sentence, capped. Does not split after `e.g.`, `i.e.`, `etc.` or a decimal point. */
function firstSentence(s, max) {
  s = flat(s);
  const re = /[.!?](?=\s+[A-Z(]|$)/g;
  let m, cut = s.length;
  while ((m = re.exec(s))) {
    const before = s.slice(Math.max(0, m.index - 5), m.index + 1);
    if (/\b(e\.g|i\.e|etc|approx|max|min|no|No|Fig|see)\.$/.test(before)) continue;
    cut = m.index + 1; break;
  }
  s = s.slice(0, cut).trim();
  if (s.length > max) s = s.slice(0, max - 1).replace(/\s+\S*$/, '') + '…';
  return s;
}

const HEADINGS = ['Usage', 'Description', 'Basic examples', 'Examples', 'Example', 'Arguments', 'Return value', 'Program execution',
  'More examples', 'Limitations', 'Error handling', 'Syntax', 'Related information', 'Components', 'Structure', 'Predefined data',
  'Characteristics', 'Program running', 'Fundamentals', 'Note'];
/** The text of a margin-headed block: from the line opening with `name` to the next line opening with one of `stops`. */
function block(lines, name, stops) {
  const startRe = new RegExp(`^\\s*${esc(name)}\\b`);
  const stopRe = new RegExp(`^\\s*(${stops.map(esc).join('|')})\\b`);
  const i = lines.findIndex(l => startRe.test(l));
  if (i < 0) return undefined;
  const out = [lines[i].replace(startRe, '')];
  for (let j = i + 1; j < lines.length; j++) {
    if (stopRe.test(lines[j])) break;
    out.push(lines[j]);
  }
  return out.join('\n');
}

/** `Data type: robtarget The destination ...` occurrences in order: the type and the text up to the next one. */
function dataTypeBlocks(text) {
  if (!text) return [];
  const t = flat(text);
  // `Data type: array of dnum`, and `stoppoint data` where a line break split `stoppointdata`
  const re = /Data type:\s*(?:array of\s+)?([A-Za-z_]\w*(?:\s*\{\*\})?(?:\s+data\b)?(?:\s+or\s+[A-Za-z_]\w*)*)/g;
  const hits = [...t.matchAll(re)];
  return hits.map((m, k) => ({
    type: m[1].replace(/^(\w+)\s+data\b/, (all, w) => TYPE_NAMES.has(`${w}data`) ? `${w}data` : w).replace(/\s+/g, ' '),
    text: t.slice(m.index + m[0].length, hits[k + 1]?.index ?? t.length).trim(),
  }));
}

/** Pairs syntax-ordered items with the `Data type:` blocks: same type (first word) within a short look-ahead. */
function describe(items, blocks) {
  let j = 0;
  for (const it of items) {
    const want = (it.type ?? '').toLowerCase().replace(/\{.*\}$/, '');
    let hit = -1;
    for (let k = j; k < Math.min(blocks.length, j + 4); k++) {
      const got = blocks[k].type.toLowerCase().split(/\s+or\s+/).map(x => x.replace(/\s*\{\*\}$/, ''));
      if (got.includes(want) || (want === 'anytype' && k === j) || (it.switch && got.includes('switch'))) { hit = k; break; }
    }
    if (hit < 0) continue;
    const d = cleanDesc(blocks[hit].text);
    if (d) it.desc = d;
    j = hit + 1;
  }
  // `[\T2] [\T3] ... [\T8]`, `TPFK2 ... TPFK5`: one paragraph describes the numbered run
  const stem = n => /^(.*?)\d+$/.exec(n)?.[1];
  items.forEach((it, k) => {
    const prev = items[k - 1];
    if (!it.desc && prev?.desc && stem(it.name) !== undefined && stem(it.name) === stem(prev.name) && it.type === prev.type) it.desc = prev.desc;
  });
}
function cleanDesc(s) {
  // bits of the margin column that land in front of the body: `[ \ID ]`, `Tool`
  s = s.replace(/^(\[\s*\\?\w+\s*\]\s*)+/, '');
  const d = firstSentence(s, 160);
  return /[a-z]/.test(d) ? d : undefined;
}

/** margin headings that pile up in front of the body text: `Usage Basic examples Example 1 Return value ...` */
const HEADING_RUN = /^(?:(?:Usage|Description|Basic examples|More examples|Examples?(?: \d+)?|Arguments|Return value|Syntax|Components|Program execution|Limitations|Error handling)\s+)+/;
/** `AccSet is used when handling fragile loads ...` - the first sentence that names the entry and says what it is used for. */
function summaryOf(lines, name, title) {
  const t = flat(lines.join('\n'));
  const n = esc(name);
  const pats = [
    new RegExp(String.raw`(?<![\w.])${n}\b(?:\s*\([^)]*\))?[^.;]{0,160}?\b(?:is|are|can be) used\b`),
    new RegExp(String.raw`(?<![\w.])${n}\b(?:\s*\([^)]*\))?[^.;]{0,100}?\b(?:is|returns?|reads?|gets?|calculates?|converts?|gives|checks?|tests?)\b`),
    /\b(?:[A-Z]\w*|This|The)\b[^.;]{0,160}?\b(?:is|are) used (?:to|for|when|in)\b/,
  ];
  for (const re of pats) {
    const m = re.exec(t);
    if (m) {
      // start where the sentence starts: the name, not the margin headings before it
      const d = firstSentence(t.slice(m.index).replace(HEADING_RUN, ''), 200);
      if (d.length > 15) return d;
    }
  }
  const usage = block(lines, 'Usage', HEADINGS.filter(h => h !== 'Usage' && h !== 'Description'));
  const d = usage && firstSentence(usage.replace(/^\s*Description\b/, ''), 200);
  return d && /[a-z]{3}/.test(d) ? d : undefined;
}

// ---------------------------------------------------------------- syntax
/** The Syntax block of the -layout text, one line: `MoveL [ '\' Conc ',' ] [ ToPoint ':=' ] < expression (IN) of robtarget > ...` */
/**
 * The formal syntax found by its shape rather than its heading (the `Syntax` margin label often
 * lands pages away in -layout): the entry's name followed by the grammar's quoted tokens
 * (`':='`, `'('`, `'\'`, `';'`), up to `';'` for an instruction or the `A function with a
 * return value ...` sentence for a function.
 */
function formalSyntax(lines, name, kind) {
  const t = flat(lines.join('\n')).replace(/[\u2018\u2019\u00B4`]/g, "'");
  const re = new RegExp(String.raw`(?<![\w'])${esc(name)}\s*(?='\(|\[|<|'\\'|';'|'\s)`, 'gi');
  for (const m of t.matchAll(re)) {
    const rest = t.slice(m.index, m.index + 4000);
    if (!/^\S+\s*(?:'\(')?[^.]{0,120}?'(?::=|\(|;|,|\\)'/.test(rest)) continue;
    let end;
    if (kind === 'function') {
      const f = /\bAn? function with\b[^.]*\./i.exec(rest);
      // (a few functions are written with an instruction's closing `';'`)
      end = f ? f.index + f[0].length : rest.indexOf("')'") >= 0 ? rest.indexOf("')'") + 3 : rest.indexOf("';'") + 3;
    } else {
      const semi = rest.indexOf("';'");
      end = semi >= 0 ? semi + 3 : -1;
    }
    if (end > 0) return rest.slice(0, end);
  }
  return undefined;
}

function syntaxText(lines) {
  // a table or a figure can carry a `Syntax` label too; the formal block is the one whose text
  // is written in the grammar's quoted tokens (`':='`, `'('`, `';'`), else the last one
  const texts = [];
  lines.forEach((l, i) => {
    if (!/^\s*Syntax\s*$/.test(l)) return;
    const out = [];
    for (let j = i + 1; j < lines.length; j++) {
      const s = lines[j];
      if (/^\s*(Syntax|Related information|Error handling|Limitations|More examples|Program execution|Structure|Predefined data|Characteristics)\s*$/.test(s)) break;
      if (/^\s*Related information\b/.test(s)) break;
      out.push(s);
      if (/^\s*An? (function|instruction)\b/i.test(s)) break;
    }
    texts.push(flat(out.join('\n')).replace(/[‘’´`]/g, "'"));
  });
  if (!texts.length) return undefined;
  return texts.find(t => /'(?::=|\(|;|,)'/.test(t)) ?? texts[texts.length - 1];
}

function tokenize(s) {
  const toks = [];
  const re = /'([^']*)'|<([^<>]*)>|(\[|\]|\||\{|\}|\(|\))|([A-Za-z_][\w]*)|(\S)/g;
  let m;
  while ((m = re.exec(s))) {
    if (m[1] !== undefined) toks.push({ q: m[1].trim() });
    else if (m[2] !== undefined) toks.push({ spec: m[2].trim() });
    else if (m[3]) toks.push({ p: m[3] });
    else if (m[4]) toks.push({ w: m[4] });
    else toks.push({ x: m[5] });
  }
  return toks;
}
/** `expression (IN) of robtarget` → robtarget; `array {*} (IN) of num` → num{*} */
function specType(spec) {
  const m = /\bof\s+([A-Za-z_]\w*)\s*$/.exec(spec);
  if (!m) return undefined;
  return /\{\s*\*/.test(spec) ? `${m[1]}{*}` : m[1];
}

/** Reads the arguments out of the formal syntax: name, type, optional (inside [ ]), switch (no value), alt (either side of `|`). */
function parseSyntax(text, name) {
  if (!text) return undefined;
  const cut = text.search(/\bAn? (function|instruction)\b/i);
  // the manual's own typos: `'ToolName ':='`, `[TableName '=']`, `of any type`, a quoted `'|'`
  const s = (cut >= 0 ? text.slice(0, cut) : text)
    .replace(/(?<!\\)'(\w+)\s*'?\s*:=\s*'/g, "$1 ':='")
    .replace(/'\s*=\s*'/g, "':='")
    .replace(/\bany type\b/g, 'anytype')
    .replace(/'\|'/g, '|');
  const toks = tokenize(s);
  // the routine's own name opens the syntax (the manual misspells a few - `CircleFit` for FitCircle)
  let i = toks.findIndex(t => t.w && t.w.toLowerCase() === name.toLowerCase());
  if (i < 0) i = toks.findIndex(t => t.w);
  if (i < 0) return undefined;
  i++;
  const args = [];
  let depth = 0, pendingAlt = false, alt = 0, lastAltArg = null;
  const push = a => {
    if (args.some(x => x.name === a.name)) return;
    if (pendingAlt && lastAltArg) {
      if (lastAltArg.alt === undefined) lastAltArg.alt = ++alt;
      a.alt = lastAltArg.alt;
    }
    pendingAlt = false;
    args.push(a); lastAltArg = a;
  };
  for (; i < toks.length; i++) {
    const t = toks[i], n1 = toks[i + 1], n2 = toks[i + 2], n3 = toks[i + 3];
    if (t.p === '[') {
      // [ Name ':=' ] <spec>  - a required argument whose name may be written
      if (n1?.w && n2?.q === ':=' && n3?.p === ']') {
        const spec = toks[i + 4]?.spec;
        push({ name: n1.w, type: spec ? specType(spec) : undefined, optional: depth > 0, switch: false });
        i += spec ? 4 : 3; continue;
      }
      depth++; continue;
    }
    if (t.p === ']') { depth = Math.max(0, depth - 1); continue; }
    if (t.p === '|') { pendingAlt = true; continue; }
    if (t.q === '\\' && n1?.w) {
      if (n2?.q === ':=') {
        // `[ '\' WObj ':=' ] <spec>` - the bracket closed before the value, as a few entries write it
        const spec = n3?.spec ?? (n3?.p === ']' ? toks[i + 4]?.spec : undefined);
        push({ name: n1.w, type: spec ? specType(spec) : undefined, optional: depth > 0, switch: false });
        i += n3?.spec ? 3 : 2;
      } else {
        push({ name: n1.w, type: 'switch', optional: depth > 0, switch: true });
        i += 1;
      }
      continue;
    }
    // Name ':=' <spec>  - a required argument whose name must be written
    if (t.w && n1?.q === ':=' && n2?.spec) {
      push({ name: t.w, type: specType(n2.spec), optional: depth > 0, switch: false });
      i += 2; continue;
    }
  }
  return args;
}

/** One RAPID-style line: `MoveL [\Conc] ToPoint [\ID] Speed [\V] | [\T] Zone ...`, functions `Offs (Point XOffset ...)`. */
function syntaxLine(name, args, fn, syntax) {
  const bs = syntax ?? '';
  const parts = [];
  args.forEach((a, k) => {
    const slash = new RegExp(`'\\\\'\\s*${esc(a.name)}\\b`).test(bs) ? '\\' : '';
    const core = `${slash}${a.name}`;
    const piece = a.optional ? `[${core}]` : core;
    if (k > 0 && a.alt !== undefined && a.alt === args[k - 1].alt) parts.push('|');
    parts.push(piece);
  });
  return fn ? `${name} (${parts.join(' ')})` : [name, ...parts].join(' ');
}

// ---------------------------------------------------------------- structure (data types)
function structureComponents(lines) {
  // found by its root line rather than the `Structure` label, which can land elsewhere
  const i = lines.findIndex(l => /<\s*dataobject of\b/.test(l));
  if (i < 0) return undefined;
  const items = [];
  let prose = 0;
  for (let j = i; j < lines.length; j++) {
    const l = lines[j];
    if (/^\s*(Related information|Predefined data|Characteristics|Limitations|Syntax)\b/.test(l)) break;
    if (/\S/.test(l) && !l.includes('<')) { if (++prose > 12) break; continue; }
    for (const m of l.matchAll(/<\s*([A-Za-z_]\w*)\s+of\s+([A-Za-z_]\w*)\s*>/g)) items.push({ indent: l.indexOf('<', m.index) , col: m.index, name: m[1], type: m[2] });
    for (const m of l.matchAll(/<\s*dataobject of\s+([A-Za-z_]\w*)\s*>/g)) items.push({ root: true, col: m.index, type: m[1] });
  }
  const root = items.find(x => x.root);
  const comps = items.filter(x => !x.root && x.name !== 'dataobject');
  if (!comps.length) return undefined;
  const top = Math.min(...comps.map(c => c.col));
  if (root && top <= root.col) return undefined;
  return comps.filter(c => c.col === top).map(c => ({ name: c.name, type: c.type }));
}

// ---------------------------------------------------------------- build
const plain = sections(plainText);
const layout = sections(layoutText);
/** the data type names (chapter 3), to mend `Data type: stoppoint data` */
const TYPE_NAMES = new Set([...plain.values()].filter(p => p.chapter === 3).map(p => p.name));
const entries = [];
let noSyntax = [], noUsage = [];
for (const [id, p] of plain) {
  const kind = KIND[p.chapter];
  const name = p.name;
  const title = p.title;
  const L = layout.get(id);
  const raw = clean(p.lines, id, name, title);
  const lay = L ? clean(L.lines, id, name, title) : [];
  const e = { name, kind };

  // summary: the manual's `<Name> ... is used to ...` sentence
  e.summary = summaryOf(raw, name, title) ?? (noUsage.push(name), firstSentence(title, 200));

  // The prose before the formal block holds the `Data type:` paragraphs, in order: for a
  // function the return value first, then the arguments; for a record type the components.
  // (Margin headings - `Arguments`, `Return value` - often land away from their bodies, so the
  // region is cut at the formal block rather than between headings.)
  // The formal block is found by its text, as the `Syntax` / `Structure` labels pile up early.
  const prose = flat(raw.join('\n')).replace(/[‘’´`]/g, "'");
  let cut = -1;
  if (kind === 'type') cut = prose.search(/<\s*dataobject of\b/);
  else {
    const f = formalSyntax(raw, name.split(/\s+/).pop(), kind);
    if (f) cut = prose.indexOf(f.slice(0, 60));
  }
  if (cut < 0) cut = prose.search(/\bRelated information\b(?![\s\S]*\bRelated information\b)/);
  const blocks = dataTypeBlocks(cut < 0 ? prose : prose.slice(0, cut));

  if (kind !== 'type') {
    const syn = formalSyntax(lay, name.split(/\s+/).pop(), kind) ?? syntaxText(lay);
    const args = parseSyntax(syn, name.split(/\s+/).pop()) ?? [];
    if (!syn) noSyntax.push(name);
    if (process.env.RAPID_DEBUG?.split(",").includes(name)) console.log(name, JSON.stringify(syn), JSON.stringify(args));
    let argBlocks = blocks;
    if (kind === 'function') {
      const st = syn && /return value of the data type\s+([A-Za-z_]\w*(?:\s+or\s+[A-Za-z_]\w*)*)/i.exec(syn);
      const hasRv = raw.some(l => /^\s*Return value\b/.test(l) || /\bReturn value\b/.test(l));
      const ret = st?.[1] ?? (hasRv ? blocks[0]?.type : undefined);
      if (ret) e.returns = ret;
      if (hasRv && blocks.length) argBlocks = blocks.slice(1);
    }
    describe(args, argBlocks);
    if (process.env.RAPID_DEBUG?.split(",").includes(name)) console.log(JSON.stringify(blocks.map(b => b.type + ": " + b.text.slice(0, 70))));
    if (syn && args.length) e.syntax = syntaxLine(name, args, kind === 'function', syn);
    else if (syn) e.syntax = kind === 'function' ? `${name} ()` : name;
    if (args.length) e.args = args.map(a => ({ name: a.name, type: a.type, optional: a.optional, switch: a.switch, alt: a.alt, desc: a.desc }));
  } else {
    const comps = structureComponents(lay);
    if (comps) {
      describe(comps, blocks);
      e.components = comps.map(c => ({ name: c.name, type: c.type, desc: c.desc }));
    }
  }
  const opt = optionOf(p.lines, name, title, id);
  if (opt) e.option = opt;
  entries.push(e);
}

// omit empty fields, keep the key order of the schema
const KEYS = ['name', 'kind', 'summary', 'syntax', 'args', 'returns', 'components', 'option'];
const tidy = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== '' && !(Array.isArray(v) && !v.length)));
const out = entries
  .map(e => {
    const r = {};
    for (const k of KEYS) if (e[k] !== undefined) r[k] = e[k];
    if (r.args) r.args = r.args.map(tidy);
    if (r.components) r.components = r.components.map(tidy);
    return tidy(r);
  })
  .sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) || a.name.localeCompare(b.name) || a.kind.localeCompare(b.kind));

const doc = {
  source: '3HAC050917 RAPID Instructions, Functions and Data Types, RobotWare 6',
  generated: new Date().toISOString().slice(0, 10),
  entries: out,
};
fs.writeFileSync(outPath, JSON.stringify(doc, null, 2) + '\n');
const count = k => out.filter(e => e.kind === k).length;
console.log(`entries: ${out.length} (instructions ${count('instruction')}, functions ${count('function')}, types ${count('type')})`);
console.log(`no Syntax block: ${noSyntax.length}${noSyntax.length ? ` (${noSyntax.slice(0, 20).join(', ')})` : ''}`);
console.log(`no Usage block: ${noUsage.length}${noUsage.length ? ` (${noUsage.slice(0, 20).join(', ')})` : ''}`);
console.log(`written ${path.relative(repo, outPath)}`);
