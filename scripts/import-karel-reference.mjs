// Reads FANUC's alphabetical description of the KAREL language (text extracted from the PDF) and
// writes what it says about each entry - no examples:
//   - data/karel-reference.json                      every entry, reviewable
//   - packages/fanuc/src/karel/karelReference.ts      the same, for hover, signature help and checks
//
//   node scripts/import-karel-reference.mjs <source.txt>
//
// Text extracted with the options catalog's extract.py. Each entry looks like:
//   GET_REG Built-In Procedure                     (or OPEN FILE Statement, %NOABORT Translator
//   Purpose: Gets an INTEGER or REAL value ...      Directive, PATH Data Type, ERROR Condition,
//   Syntax : GET_REG(register_no, ..., status)      SIGNAL EVENT Action, WITH Clause ...)
//   Input/Output Parameters:
//   [in] register_no :INTEGER ...
//   %ENVIRONMENT Group :REGOPE
//   Details:
//   • register_no specifies the register to get. ...
//   See Also: / Example:
// Built-ins: a Details bullet that starts with a parameter's name describes that parameter; the rest
// are notes. Everything else keeps its syntax lines and Details bullets as they are.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scrubReference } from './karel-reference-scrub.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = process.argv[2];
if (!src) { console.error('usage: node scripts/import-karel-reference.mjs <source.txt>'); process.exit(1); }

// page furniture the PDF text carries between entries
const NOISE = [/^===== PAGE \d+ =====$/, /^A\. KAREL LANGUAGE ALPHABETICAL DESCRIPTION$/, /^MARRC75KR\S+ Rev \S+$/, /^A[–-]\d+$/, /^A\.\d+\.\d+$/];
const text = readFileSync(src, 'utf8').split(/\r?\n/).map(l => l.trim());
const stamp = licenseeStamp(text);
const lines = text.filter(l => l && !stamp.has(l) && !NOISE.some(r => r.test(l)));

const KIND = '(?:iRVision\\s+)?Built[- ]?In(?:[- ](?:Procedure|Function|Routine))?|Translator Directive|Data Type|Statement|Action|Condition|Clause|Operator';
const HEAD = new RegExp(`^(?:A\\.\\d+\\.\\d+\\s+)?([%$]?[A-Z][A-Z0-9_]*(?: [A-Z][A-Z0-9_]*)*?)\\s+(${KIND})$`, 'i');
const APPENDIX = /^[B-Z]\. [A-Z][A-Z ]+$/;
const SECTION = /^(Purpose|Syntax|Function Return Type|Returned Value|Input\/Output Parameters|%ENVIRONMENT [Gg]roup|Details|See Also|Examples?|Example \d|Example Program)\s*:?/;
// the line above any Purpose: is an entry heading; it, or the next appendix, ends the entry before it
const starts = [], ends = [];
for (let i = 0; i < lines.length - 1; i++) {
  if (APPENDIX.test(lines[i])) ends.push(i);
  else if (/^Purpose\s*:/.test(lines[i + 1])) { ends.push(i); if (HEAD.test(lines[i])) starts.push(i); }
}

const tidy = s => s.replace(/\s+/g, ' ').replace(/\s+([,.;:)])/g, '$1').replace(/\(\s+/g, '(').trim();
const kindOf = k => /built/i.test(k) ? (/function/i.test(k) ? 'function' : 'procedure') : k.toLowerCase().replace('translator ', '');

/** a parameter type as a signature writes it: "INTEGER expression" INTEGER, "ARRAY of string" ARRAY OF STRING */
function karelType(t) {
  const s = t.replace(/%ENVI.*$/i, '').replace(/^:\s*/, '').replace(/\s+(expression|variable)$/i, '').trim();
  if (/^any\b/i.test(s)) return 'ANY';
  return s.replace(/\bINTEGER or REAL\b/i, 'INTEGER|REAL').replace(/\b(array|of|string|integer|real|boolean|jointpos)\b/gi, w => w.toUpperCase()).replace(/ARRAY\s*\[/, 'ARRAY[');
}

/** "IO_STATUS Built-In Function, SET_FILE_ATR Built-In Procedure, Chapter 7 ..." - the entries only */
function seeAlso(text) {
  const out = [];
  for (const part of text.split(/,|\band\b/)) {
    const m = new RegExp(`^\\s*([%$]?[A-Z][A-Z0-9_]*(?: [A-Z][A-Z0-9_]*)*)\\s+(${KIND})s?\\b`, 'i').exec(part.trim());
    if (m && !/^(Chapter|Section|Appendix)$/i.test(m[1])) out.push(m[1].toUpperCase());
  }
  return [...new Set(out)];
}

const builtins = {}, language = {};
for (const s of starts) {
  const body = lines.slice(s, ends.find(e => e > s) ?? lines.length);
  const [, rawName, rawKind] = HEAD.exec(body[0]);
  const name = rawName.toUpperCase(), kind = kindOf(rawKind);
  // split the entry into its labelled sections
  const sec = {}; let cur = null;
  for (const l of body.slice(1)) {
    const m = SECTION.exec(l);
    if (m) { cur = m[1].replace(/^%ENVIRONMENT.*/, 'env').replace(/^Example.*/, 'Example'); (sec[cur] ??= []).push(l.slice(m[0].length).trim()); continue; }
    if (cur) sec[cur].push(l);
  }
  // "%ENVIRONMENT Group :SYSTEM" is one word; an entry whose Details: label the PDF lost carries its
  // bullets on after it
  const envLines = (sec.env ?? []).map(l => l.replace(/^:\s*/, ''));
  let env = /^[A-Za-z]+/.exec(envLines[0] ?? '')?.[0]?.toUpperCase() ?? '';
  const envRest = [envLines[0]?.replace(/^[A-Za-z]+(\s+[A-Za-z]+$)?/, '').trim() ?? '', ...envLines.slice(1)].filter(Boolean);
  if (envRest.some(l => /^[•●]/.test(l))) sec.Details = [...envRest, ...(sec.Details ?? [])];
  // the same lost label after Syntax (%ENVIRONMENT): its bullets are the Details
  const firstBullet = (sec.Syntax ?? []).findIndex(l => /^[•●]/.test(l));
  if (firstBullet > 0) sec.Details = [...sec.Syntax.splice(firstBullet), ...(sec.Details ?? [])];
  // Details: bullets, continuation lines joined to the bullet above
  const bullets = [];
  for (const l of sec.Details ?? []) {
    if (/^[•●]/.test(l)) bullets.push(l.replace(/^[•●]\s*/, ''));
    else if (bullets.length) bullets[bullets.length - 1] += ' ' + l;
    else if (l) bullets.push(l);
  }
  const entry = { kind, purpose: tidy((sec.Purpose ?? []).join(' ')) };
  const also = seeAlso((sec['See Also'] ?? []).join(' ')).filter(n => n !== name);
  // an entry with no %ENVIRONMENT Group line (DAQ_START ...) whose example section loads one
  if (!env) env = /^%ENVIRONMENT\s+(\w+)/i.exec((sec.Example ?? []).find(l => /^%ENVIRONMENT\s+\w+/i.test(l)) ?? '')?.[1]?.toUpperCase() ?? '';

  if (kind === 'function' || kind === 'procedure') {
    const params = [];
    for (const l of sec['Input/Output Parameters'] ?? []) {
      const m = /^\[\s*(in|out|in\s*,\s*out|in\/out)\s*\]\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.+)$/i.exec(l);
      if (m) params.push({ name: m[2], dir: m[1].toLowerCase().replace(/\s+/g, '').replace('in/out', 'in,out'), type: tidy(m[3]), text: '' });
      else if (params.length && !/^\[/.test(l)) params[params.length - 1].type = tidy(`${params[params.length - 1].type} ${l}`);
    }
    // "INTEGER %ENVIORNMENT group: REGOPE": the group the PDF ran into the last parameter's type
    for (const p of params) {
      const g = /%ENVI\w*\s+group\s*:\s*(\w+)/i.exec(p.type);
      if (g && !env) env = g[1].toUpperCase();
      p.type = karelType(p.type);
    }
    // optional parameters: <mem_pool> or [group_no] in the Syntax line
    const syntax = (sec.Syntax ?? []).join(' ');
    for (const p of params) if (new RegExp(`[<\\[]\\s*,?\\s*${p.name}\\b`, 'i').test(syntax)) p.optional = true;
    const notes = [];
    for (const raw of bullets.map(tidy).filter(Boolean)) {
      const first = /^(?:The\s+)?(?:optional\s+)?([A-Za-z_][A-Za-z0-9_]*)/i.exec(raw)?.[1]?.toLowerCase();
      const p = params.find(q => q.name.toLowerCase() === first);
      if (p) p.text = p.text ? `${p.text} ${raw}` : raw;
      else notes.push(raw);
    }
    // a parameter no bullet starts with: the first bullet that names it ("real_flag is set to TRUE and
    // real_value to the register content ...")
    for (const p of params.filter(q => !q.text)) {
      const re = new RegExp(`\\b${p.name}\\b`, 'i');
      const hit = params.find(q => q !== p && re.test(q.text))?.text ?? notes.find(n => re.test(n));
      if (hit) { p.text = hit; const ni = notes.indexOf(hit); if (ni >= 0) notes.splice(ni, 1); }
    }
    const ret = tidy((sec['Function Return Type'] ?? []).join(' '));
    if (ret) entry.returns = ret;
    if (params.length) entry.params = params;
    if (notes.length) entry.notes = notes;
    if (env) entry.env = env;
    if (also.length) entry.seeAlso = also;
    builtins[name] = entry; // a name the chapter lists twice keeps its later (fuller) entry
  } else {
    entry.syntax = (sec.Syntax ?? []).map(tidy).filter(Boolean);
    if (bullets.length) entry.details = bullets.map(tidy).filter(Boolean);
    if (env) entry.env = env;
    if (also.length) entry.seeAlso = also;
    // SIGNAL EVENT is both an Action and a Statement: one list per name
    (language[name] ??= []).push(entry);
  }
}

// "Refer to the INI_DYN_DISB built-in procedure for a description of the other parameters": the
// parameters still undescribed take the same-named ones' text from the built-in a note points to
for (const e of Object.values(builtins)) {
  const refs = (e.notes ?? []).flatMap(n => [...n.matchAll(/\b([A-Z][A-Z0-9_]{2,})\s+[Bb]uilt-?[Ii]n\b/g)].map(m => builtins[m[1]]).filter(Boolean));
  for (const p of (e.params ?? []).filter(q => !q.text))
    p.text = refs.map(r => r.params?.find(q => q.name === p.name)?.text).find(Boolean) ?? '';
}

// no sample programs, no pointers to chapters, sections, tables or books (karel-reference-scrub.mjs)
scrubReference({ builtins, language });

const sort = o => Object.fromEntries(Object.keys(o).sort().map(k => [k, o[k]]));
const B = sort(builtins), L = sort(language);
writeFileSync(path.join(root, 'data', 'karel-reference.json'), JSON.stringify({ builtins: B, language: L }, null, 1) + '\n');
writeFileSync(path.join(root, 'packages', 'fanuc', 'src', 'karel', 'karelReference.ts'),
`// GENERATED by scripts/import-karel-reference.mjs - do not edit by hand.
// What each built-in's parameters are for, its %ENVIRONMENT group and related entries; and the
// statements, directives, data types, conditions, actions and clauses.
/* eslint-disable */
export interface KParamDetail { name: string; dir: string; type: string; text: string; optional?: boolean }
export interface KBuiltinDetail { kind: 'function' | 'procedure'; purpose: string; returns?: string; params?: KParamDetail[]; notes?: string[]; env?: string; seeAlso?: string[] }
export interface KLanguageDetail { kind: string; purpose: string; syntax: string[]; details?: string[]; env?: string; seeAlso?: string[] }
export const KAREL_BUILTIN_DETAILS: Record<string, KBuiltinDetail> = ${JSON.stringify(B)};
export const KAREL_LANGUAGE_DETAILS: Record<string, KLanguageDetail[]> = ${JSON.stringify(L)};
`);
const kinds = {};
for (const es of Object.values(L)) for (const e of es) kinds[e.kind] = (kinds[e.kind] ?? 0) + 1;
const bn = Object.keys(B);
console.log(`${bn.length} built-ins (${bn.filter(n => B[n].params?.some(p => p.text)).length} with parameter descriptions, ${bn.filter(n => B[n].env).length} with an %ENVIRONMENT group); language: ${Object.entries(kinds).map(([k, v]) => `${v} ${k}`).join(', ')}`);

/**
 * The licensee stamp a downloaded manual prints at the top of every page: the lines right after
 * most page markers that are the same every time. Found, not named, so no licensee is written here.
 */
function licenseeStamp(text) {
  const seen = new Map(); let pages = 0;
  text.forEach((l, i) => {
    if (!/^===== PAGE \d+ =====$/.test(l)) return;
    pages++;
    for (const n of text.slice(i + 1, i + 3)) if (n) seen.set(n, (seen.get(n) ?? 0) + 1);
  });
  return new Set([...seen].filter(([, c]) => c > pages / 2).map(([l]) => l));
}
