// Generates media/file-icons/ - one SVG per FANUC file type, and the "Robot Code" file icon
// theme that puts them in front of everything else.
//
// The icons reach the Explorer, editor tabs and Quick Open two ways:
//   1. `contributes.languages[].icon` - used by WHATEVER icon theme is active, whenever that
//      theme has no icon of its own for the file. Enough for .va .tp .kl ... which no theme
//      knows. Not enough for .ls (Seti and vscode-icons both map it to LiveScript, and a theme's
//      own extension mapping beats a language icon) or .txt (a language icon would have to claim
//      every text file as a FANUC language).
//   2. `contributes.iconThemes` - the "Robot Code" theme: Seti (the theme a fresh VS Code shows,
//      vendored under media/seti) with the FANUC types written over its tables. Only one icon
//      theme can be active, so the extension switches to this one on first activation
//      (robotCode.fileIcons.enabled, default on; off puts the previous theme back - packages/core/src/fileIcons.ts).
//      Because it IS Seti underneath, no other file loses its icon.
//
//   node scripts/make-file-icons.mjs          write the files
//   node scripts/make-file-icons.mjs --check  exit 1 if a committed file differs (the test uses this)
//
// THE ICON IS THE EXTENSION, AND NOTHING ELSE. Sam, 2026-09-19: "can we just have the name - if
// it's say .VA it just shows a purple VA, not a box or anything, just a big VA." The first set
// put the letters on a rounded tile; at 16 px the tile took the room the letters needed. So:
//   the letters    are the file extension, as large as the square allows
//   the colour     is the family:  amber TP programs · blue KAREL · teal command files ·
//                                  purple controller data · red diagnostics · green I/O ·
//                                  orange vision · grey everything else
//   an underline   marks a compiled or binary file - same family, nothing to read or edit
// Two letters or three, the word is stretched to the same width (textLength), so a column of
// them lines up. Each icon is drawn twice: bright for dark themes, a darker shade for light
// themes, where bright amber or green on white all but disappears.
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const FAMILY = {
  tp:     { dark: '#f6c343', light: '#a87b00' },
  karel:  { dark: '#61afef', light: '#1f66b8' },
  cmd:    { dark: '#56b6c2', light: '#157a87' },
  data:   { dark: '#c678dd', light: '#8a3fa3' },
  diag:   { dark: '#e06c75', light: '#b3323d' },
  io:     { dark: '#98c379', light: '#3f7d1f' },
  vision: { dark: '#e5954b', light: '#b35a0c' },
  misc:   { dark: '#aab4c0', light: '#566170' },
  // ABB, not a FANUC family: ABB's own red, darkened for light themes
  abb:    { dark: '#ff5a4f', light: '#c0271c' },
};

/**
 * Every file type. `ext` is the extension and the letters; `id` is the VS Code language that
 * carries the icon (each type has its own, or it could not have its own icon); `grammar` names
 * the TextMate grammar a readable type is highlighted with, and only those activate the
 * extension. `match` replaces the extension for a type that must be matched by file NAME:
 * .sv is also SystemVerilog, so only the controller's own system files are claimed.
 * `themeOnly` marks a type that gets an icon in the Robot Code THEME but no language of its
 * own: .txt is every text file on the PC, not a FANUC type, so the language route would be wrong.
 *
 * ABB (monorepo phase 3) adds fields a FANUC type never needed: `moreExt` for a language that
 * owns several extensions (.mod and .prg are both RAPID), `patterns` for file names matched by
 * glob ON TOP of the extensions (.sys is also the Windows driver extension, so only a .sys inside
 * a RAPID backup layout is claimed), `firstLine` for content-sniffing and `scope` for a grammar
 * whose scope is not source.fanuc.<grammar>.
 */
export const FILE_ICONS = [
  { ext: 'ls',  id: 'fanuc-tp',        family: 'tp',     binary: false, grammar: 'tp',    alias: 'FANUC TP',                        what: 'TP program, ASCII listing' },
  { ext: 'tp',  id: 'fanuc-tp-binary', family: 'tp',     binary: true,                    alias: 'FANUC TP (compiled .tp)',         what: 'TP program, compiled' },
  { ext: 'kl',  id: 'fanuc-karel',     family: 'karel',  binary: false, grammar: 'karel', alias: 'FANUC KAREL',                     what: 'KAREL source' },
  { ext: 'pc',  id: 'fanuc-pc',        family: 'karel',  binary: true,                    alias: 'FANUC KAREL (compiled .pc)',      what: 'KAREL program, compiled' },
  { ext: 'utx', id: 'fanuc-utx',       family: 'karel',  binary: false,                   alias: 'FANUC Dictionary Text',           what: 'KAREL dictionary source' },
  { ext: 'ftx', id: 'fanuc-ftx',       family: 'karel',  binary: false,                   alias: 'FANUC Form Text',                 what: 'KAREL form dictionary source' },
  { ext: 'cm',  id: 'fanuc-cm',        family: 'cmd',    binary: false, grammar: 'cm',    alias: 'FANUC Command File',              what: 'command file' },
  { ext: 'cf',  id: 'fanuc-cf',        family: 'cmd',    binary: false, grammar: 'cm',    alias: 'FANUC Command File (startup)',    what: 'command file, run at startup' },
  { ext: 'va',  id: 'fanuc-va',        family: 'data',   binary: false, grammar: 'va',    alias: 'FANUC Variable Dump',             what: 'variable dump, ASCII' },
  { ext: 'dt',  id: 'fanuc-dt',        family: 'data',   binary: false, grammar: 'va',    alias: 'FANUC Data File',                 what: 'data file' },
  { ext: 'vr',  id: 'fanuc-vr',        family: 'data',   binary: true,                    alias: 'FANUC Variable File (binary .vr)', what: 'variable file, binary' },
  { ext: 'sv',  id: 'fanuc-sv',        family: 'data',   binary: true,                    alias: 'FANUC System File (binary .sv)',  what: 'system file, binary',
    match: { filenames: ['cellio.sv', 'iahand.sv', 'mixlogic.sv', 'pmccfg.sv'], patterns: ['sys*.sv', 'dcs*.sv'] } },
  { ext: 'df',  id: 'fanuc-df',        family: 'data',   binary: true,                    alias: 'FANUC Default File (.df)',        what: 'default-value file, binary' },
  { ext: 'dg',  id: 'fanuc-dg',        family: 'diag',   binary: false, grammar: 'va',    alias: 'FANUC Diagnostic Dump',           what: 'diagnostic dump' },
  { ext: 'io',  id: 'fanuc-io',        family: 'io',     binary: false, grammar: 'va',    alias: 'FANUC I/O Configuration Dump',    what: 'I/O configuration dump' },
  { ext: 'vda', id: 'fanuc-vda',       family: 'vision', binary: false,                   alias: 'FANUC Vision Data (ASCII .vda)',  what: 'iRVision data, ASCII' },
  { ext: 'vd',  id: 'fanuc-vd',        family: 'vision', binary: true,                    alias: 'FANUC Vision Data (binary .vd)',  what: 'iRVision data, binary' },
  { ext: 'cam', id: 'fanuc-cam',       family: 'vision', binary: true,                    alias: 'FANUC Camera Data (.cam)',        what: 'camera definition, binary' },
  { ext: 'pmc', id: 'fanuc-pmc',       family: 'misc',   binary: true,                    alias: 'FANUC PMC Ladder (.pmc)',         what: 'PMC ladder / parameters, binary' },
  { ext: 'stm', id: 'fanuc-stm',       family: 'misc',   binary: false,                   alias: 'FANUC Web Page (.stm)',           what: 'controller web page' },
  { ext: 'txt', id: null,              family: 'misc',   binary: false, themeOnly: true,  alias: 'Text',                            what: 'text file (theme icon only, no language)' },
  { ext: 'mod', id: 'abb-rapid',       family: 'abb',    binary: false, grammar: 'rapid', alias: 'ABB RAPID',                       what: 'ABB RAPID module',
    scope: 'source.rapid', moreExt: ['prg'], firstLine: '^\\s*(%%%|MODULE\\s+\\w+)',
    patterns: ['**/RAPID/**/*.sys', '**/HOME/**/*.sys', '**/SYSMOD/*.sys'] },
];

/** the file icon THEME's id in package.json, and the file it is generated into */
export const ICON_THEME_ID = 'robot-code-icons';
export const ICON_THEME_FILE = 'robot-code-icon-theme.json';

/**
 * One icon: the letters, bold, fitted to a fixed width so two letters and three fill the
 * same box at the same height; an underline for a binary type. Letters sit a little higher when underlined so
 * the pair stays centred in the square.
 */
function draw(letters, colour, binary) {
  const three = letters.length >= 3;
  // Three letters get the SAME height as two and are squeezed to the width instead (textLength
  // narrows the glyphs). Drawn at a smaller size they were legible enlarged and a smudge at 16 px.
  const size = 22;
  const base = binary ? 21 : 23.5;
  const word = `<text x="16" y="${base}" font-family="Segoe UI, Arial, Helvetica, sans-serif" font-size="${size}" font-weight="800" text-anchor="middle" textLength="${three ? 31 : 28}" lengthAdjust="spacingAndGlyphs" fill="${colour}">${letters}</text>`;
  const line = binary ? `\n  <rect x="2" y="25.5" width="28" height="3" rx="1.5" fill="${colour}"/>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">\n  ${word}${line}\n</svg>\n`;
}

/**
 * file name -> content, for every icon: <ext>-dark.svg and <ext>-light.svg - and, given the
 * parsed Seti theme, the Robot Code theme file as well
 */
export function renderAll(seti) {
  const out = new Map();
  for (const t of FILE_ICONS) {
    const letters = t.ext.toUpperCase(), c = FAMILY[t.family];
    out.set(`${t.ext}-dark.svg`, draw(letters, c.dark, t.binary));
    out.set(`${t.ext}-light.svg`, draw(letters, c.light, t.binary));
  }
  if (seti) out.set(ICON_THEME_FILE, renderTheme(seti));
  return out;
}

/**
 * The "Robot Code" file icon theme: Seti's tables (parsed media/seti/vs-seti-icon-theme.json)
 * with every FANUC type written over them - by extension, by the controller file names that .sv
 * is matched with, and by language id, dark and light. Paths are relative to the theme file,
 * which sits in media/file-icons beside the SVGs; the Seti font is one folder up.
 */
export function renderTheme(seti) {
  const t = JSON.parse(JSON.stringify(seti));   // never touch the vendored copy
  t.information_for_contributors = [
    'GENERATED by scripts/make-file-icons.mjs - do not edit. Seti (media/seti, MIT) with the FANUC file types on top.',
    'Extensions are matched lower-case by VS Code, so FOO.LS and foo.ls both get the FANUC icon.',
  ];
  t.fonts = t.fonts.map(f => ({ ...f, src: f.src.map(s => ({ ...s, path: `../seti/${path.posix.basename(s.path)}` })) }));
  t.light ??= {};
  for (const k of ['fileExtensions', 'fileNames', 'languageIds']) { t[k] ??= {}; t.light[k] ??= {}; }
  for (const x of FILE_ICONS) {
    const dark = `fanuc-${x.ext}-dark`, light = `fanuc-${x.ext}-light`;
    t.iconDefinitions[dark] = { iconPath: `./${x.ext}-dark.svg` };
    t.iconDefinitions[light] = { iconPath: `./${x.ext}-light.svg` };
    for (const e of [x.ext, ...(x.moreExt ?? [])]) { t.fileExtensions[e] = dark; t.light.fileExtensions[e] = light; }
    for (const n of x.match?.filenames ?? []) { t.fileNames[n] = dark; t.light.fileNames[n] = light; }
    if (x.id) { t.languageIds[x.id] = dark; t.light.languageIds[x.id] = light; }
  }
  return JSON.stringify(t, null, 2) + '\n';
}

/** the `contributes.languages`, `contributes.grammars` and onLanguage activation events this table implies */
export function manifestBlocks() {
  const both = list => list.flatMap(e => [e, e.toUpperCase()]);
  const config = { tp: 'tp', karel: 'karel', va: 'va', cm: 'cm', rapid: 'rapid' };
  const languages = FILE_ICONS.filter(t => !t.themeOnly).map(t => ({
    id: t.id,
    aliases: [t.alias],
    ...(t.match ? { filenames: both(t.match.filenames), filenamePatterns: both(t.match.patterns) } : { extensions: both(['.' + t.ext, ...(t.moreExt ?? []).map(e => '.' + e)]) }),
    ...(t.patterns ? { filenamePatterns: t.patterns.flatMap(p => [p, p.replace(/\.sys$/, '.SYS')]) } : {}),
    ...(t.firstLine ? { firstLine: t.firstLine } : {}),
    ...(t.grammar ? { configuration: `./language-configs/${config[t.grammar]}.language-configuration.json` } : {}),
    icon: { light: `./media/file-icons/${t.ext}-light.svg`, dark: `./media/file-icons/${t.ext}-dark.svg` },
  }));
  const grammars = FILE_ICONS.filter(t => t.grammar).map(t => ({ language: t.id, scopeName: t.scope ?? `source.fanuc.${t.grammar}`, path: `./syntaxes/${t.grammar}.tmLanguage.json` }));
  const activation = FILE_ICONS.filter(t => t.grammar).map(t => `onLanguage:${t.id}`);
  return { languages, grammars, activation };
}

// import.meta.url is empty when the tests bundle this file to CommonJS, so nothing at the top level
// may touch it: the table and the functions above are pure, the paths live in here.
const isMain = !!import.meta.url && !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const outDir = path.join(repo, 'media', 'file-icons');
  const files = renderAll(JSON.parse(readFileSync(path.join(repo, 'media', 'seti', 'vs-seti-icon-theme.json'), 'utf8')));
  if (process.argv.includes('--check')) {
    const stale = [...files].filter(([name, body]) => !existsSync(path.join(outDir, name)) || readFileSync(path.join(outDir, name), 'utf8').replace(/\r\n/g, '\n') !== body).map(([n]) => n);
    if (stale.length) { console.error(`file icons out of date: ${stale.join(', ')} - run node scripts/make-file-icons.mjs`); process.exit(1); }
    console.log(`file icons: ${files.size} up to date`);
  } else {
    mkdirSync(outDir, { recursive: true });
    for (const old of readdirSync(outDir)) if (!files.has(old)) unlinkSync(path.join(outDir, old));   // an icon whose type or shape went away
    for (const [name, body] of files) writeFileSync(path.join(outDir, name), body);
    console.log(`file icons: wrote ${files.size} to media/file-icons`);
  }
}
