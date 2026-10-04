// Notepad++ support (beta list 4, item 9), generated from what the extension already knows so
// the two cannot drift: keyword lists from syntaxes/*.tmLanguage.json, KAREL built-in
// signatures from packages/fanuc/src/karel/builtins.ts.
//
//   node scripts/make-notepadpp.mjs      writes notepad++/  (then `node esbuild.mjs --npp` for robotcode.js)
//
// Out:
//   userDefineLangs/FANUC TP.xml, FANUC KAREL.xml      colouring + folding (User Defined Language 2.1)
//   autoCompletion/FANUC TP.xml, FANUC KAREL.xml       Ctrl+Space words; KAREL built-ins with call tips
//   functionList/fanuc_tp.xml, fanuc_karel.xml         Function List: TP labels, KAREL routines
//   install.ps1, uninstall.ps1                         from scripts/notepadpp/: copy the above into %APPDATA%\Notepad++
//                                                      (+ robotcode.js and its Run menu entries), and take it all out
//                                                      (autoCompletion beside notepad++.exe: only place it is read)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'notepad++');
const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const grammar = f => JSON.parse(readFileSync(path.join(root, 'syntaxes', f), 'utf8')).repository;

/** the words in the first \b(a|b|c)\b of a pattern; regex pieces (CNT\d{1,3}) are dropped, multi-word ones quoted */
function words(match) {
  const m = /\\b\(([^()]*)\)/.exec(match);
  if (!m) return [];
  return m[1].split('|').filter(w => w && !/[\\[\](){}?*+.^$]/.test(w)).map(w => (/\s/.test(w) ? `"${w}"` : w));
}
const uniq = a => [...new Set(a)];
const sortCi = a => [...a].sort((x, y) => x.toUpperCase() < y.toUpperCase() ? -1 : x.toUpperCase() > y.toUpperCase() ? 1 : 0);
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ---------------------------------------------------------------- keyword lists
const tp = grammar('tp.tmLanguage.json');
const kl = grammar('karel.tmLanguage.json');

const tpControl = words(tp.keyword.patterns[0].match);
const tpTypes = words(tp.keyword.patterns[1].match);
const tpMotion = uniq(tp['motion-option'].patterns.flatMap(p => words(p.match)).concat(['FINE', 'CNT', 'ACC', 'mm/sec', 'deg/sec', 'cm/min', 'sec', 'msec']));
const tpData = ['R', 'PR', 'SR', 'AR', 'P', 'DI', 'DO', 'RI', 'RO', 'GI', 'GO', 'AI', 'AO', 'UI', 'UO', 'SI', 'SO', 'WI', 'WO', 'WSI', 'WSO', 'F', 'M', 'VR', 'TIMER', 'TIMER_OVERFLOW', 'UALM', 'LBL', 'UFRAME', 'UTOOL', 'VR'];
// option syntax from the FANUC manuals (the grammar's generated "catalog" rule): phrases ("Search Start",
// "Prompt Box Msg") come quoted - a UDL keyword with spaces must be - single words as they are
const tpOptionPhrases = [], tpOptionWords = [];
for (const p of tp.catalog?.patterns ?? []) {
  const m = /\((?:\?<![^)]*\))?\(([^()]*)\)/.exec(p.match) ?? /\(([^()]*)\)/.exec(p.match);
  if (!m) continue;
  for (const raw of m[1].split('|')) {
    const w = raw.replace(/\\s\+/g, ' ').replace(/\\\./g, '.').replace(/\\/g, '');
    if (!/^[A-Za-z_][A-Za-z0-9_. ]*$/.test(w)) continue;
    (w.includes(' ') ? tpOptionPhrases : tpOptionWords).push(w.includes(' ') ? `"${w}"` : w);
  }
}
const tpSections = ['/PROG', '/ATTR', '/APPL', '/MN', '/POS', '/END', 'OWNER', 'COMMENT', 'PROG_SIZE', 'CREATE', 'MODIFIED', 'FILE_NAME', 'VERSION', 'LINE_COUNT', 'MEMORY_SIZE', 'PROTECT', 'TCD', 'STACK_SIZE', 'TASK_PRIORITY', 'TIME_SLICE', 'BUSY_LAMP_OFF', 'ABORT_REQUEST', 'PAUSE_REQUEST', 'DEFAULT_GROUP', 'CONTROL_CODE', 'READ_WRITE', 'READ_ONLY', 'MACRO', 'GP1', 'GP2', 'GP3', 'GP4', 'GP5', 'UF', 'UT', 'CONFIG'];

const klKeywords = words(kl.keyword.match);
const klTypes = words(kl.type.match);
const klConstants = words(kl.constant.match);
const klBuiltinsGrammar = words(kl.builtin.match);
const klPorts = words(kl.port.match);
const klDirectives = ['%NOLOCKGROUP', '%NOPAUSE', '%NOABORT', '%NOBUSYLAMP', '%COMMENT', '%ALPHABETIZE', '%CMOSVARS', '%CRTDEVICE', '%DEFGROUP', '%ENVIRONMENT', '%INCLUDE', '%LOCKGROUP', '%PRIORITY', '%STACKSIZE', '%TIMESLICE', '%TPMOTION', '%UNINITVARS', '%NOPAUSESHFT', '%SHADOWVARS', '%DELAY', '%FROM'];

// KAREL built-ins with signatures, from the extension's own table
const builtinsTs = readFileSync(path.join(root, 'packages/fanuc/src/karel/builtins.ts'), 'utf8');
const builtins = new Map();
for (const m of builtinsTs.matchAll(/\bb\('([A-Z0-9_]+)',\s*'([^']*)',\s*'((?:[^'\\]|\\.)*)'(?:,\s*'([^']*)')?\)/g)) builtins.set(m[1], { sig: m[2], doc: m[3].replace(/\\'/g, "'"), ret: m[4] });
const klBuiltins = uniq([...klBuiltinsGrammar, ...builtins.keys()]);

// ---------------------------------------------------------------- UDL
// Colours follow the extension's type colours: amber TP, blue PC/KAREL, teal macro, grey data.
// The XML carries one set; Notepad++'s own dark mode re-tints a UDL that says darkModeTheme="yes".
function udl({ name, ext, comments, keywords, folds, operators, delimiters, styles }) {
  const kw = (i) => sortCi(uniq(keywords[i] ?? [])).join(' ');
  // Notepad++ tries fold words in list order and takes a prefix: END listed before ENDIF closes on
  // the END of ENDIF and then reopens on its IF, so every list goes longest first.
  const fold = (list) => esc((list ?? '').split(/\s+/).filter(Boolean).sort((a, b) => b.length - a.length).join(' '));
  const s = (n, fg, bold = false, italic = false) => `            <WordsStyle name="${n}" fgColor="${fg}" bgColor="FFFFFF" colorStyle="1" fontName="" fontStyle="${(bold ? 1 : 0) | (italic ? 2 : 0)}" nesting="0" />`;
  return `<?xml version="1.0" encoding="UTF-8" ?>
<!-- ${name} for Notepad++ - generated by robot-code-vscode scripts/make-notepadpp.mjs, Robot Code ${version}. Do not edit by hand. -->
<NotepadPlus>
    <UserLang name="${name}" ext="${ext}" udlVersion="2.1">
        <Settings>
            <Global caseIgnored="yes" allowFoldOfComments="no" foldCompact="no" forcePureLC="0" decimalSeparator="0" />
            <Prefix Keywords1="no" Keywords2="no" Keywords3="no" Keywords4="no" Keywords5="no" Keywords6="no" Keywords7="no" Keywords8="no" />
        </Settings>
        <KeywordLists>
            <Keywords name="Comments">${esc(comments)}</Keywords>
            <Keywords name="Numbers, prefix1"></Keywords>
            <Keywords name="Numbers, prefix2"></Keywords>
            <Keywords name="Numbers, extras1"></Keywords>
            <Keywords name="Numbers, extras2"></Keywords>
            <Keywords name="Numbers, suffix1"></Keywords>
            <Keywords name="Numbers, suffix2"></Keywords>
            <Keywords name="Numbers, range"></Keywords>
            <Keywords name="Operators1">${esc(operators)}</Keywords>
            <Keywords name="Operators2"></Keywords>
            <Keywords name="Folders in code1, open">${fold(folds.open)}</Keywords>
            <Keywords name="Folders in code1, middle">${fold(folds.middle)}</Keywords>
            <Keywords name="Folders in code1, close">${fold(folds.close)}</Keywords>
            <Keywords name="Folders in code2, open">${fold(folds.open2)}</Keywords>
            <Keywords name="Folders in code2, middle"></Keywords>
            <Keywords name="Folders in code2, close">${fold(folds.close2)}</Keywords>
            <Keywords name="Folders in comment, open"></Keywords>
            <Keywords name="Folders in comment, middle"></Keywords>
            <Keywords name="Folders in comment, close"></Keywords>
${[1, 2, 3, 4, 5, 6, 7, 8].map(i => `            <Keywords name="Keywords${i}">${esc(kw(i))}</Keywords>`).join('\n')}
            <Keywords name="Delimiters">${esc(delimiters)}</Keywords>
        </KeywordLists>
        <Styles>
            <WordsStyle name="DEFAULT" fgColor="000000" bgColor="FFFFFF" colorStyle="1" fontName="" fontStyle="0" nesting="0" />
${s('COMMENTS', '008000', false, true)}
${s('LINE COMMENTS', '008000', false, true)}
${s('NUMBERS', 'B5530B')}
${styles.map(([n, fg, bold]) => s(n, fg, bold)).join('\n')}
${s('OPERATORS', '555555')}
${s('FOLDER IN CODE1', '0000C0', true)}
${s('FOLDER IN CODE2', '0000C0', true)}
${s('FOLDER IN COMMENT', '008000')}
${s('DELIMITERS1', 'A31515')}
${s('DELIMITERS2', 'A31515')}
${[3, 4, 5, 6, 7, 8].map(i => s(`DELIMITERS${i}`, '000000')).join('\n')}
        </Styles>
    </UserLang>
</NotepadPlus>
`;
}

// Delimiters: "00" open "01" escape "02" close for delimiter 1, "03/04/05" for 2, ... 8 pairs
const delims = (pairs) => {
  const cells = [];
  for (let i = 0; i < 8; i++) { const p = pairs[i] ?? ['', '', '']; cells.push(p[0], p[1], p[2]); }
  return cells.map((c, i) => `${String(i).padStart(2, '0')}${c}`).join(' ');
};

const tpUdl = udl({
  name: 'FANUC TP', ext: 'ls LS',
  // line comment "//" (remark) and "!" (comment instruction); block comments: none
  comments: '00// 00! 01 02 03 04',
  operators: '= < > + - * ( ) , ; : [ ] { }',
  folds: { open: 'THEN', middle: 'ELSE', close: 'ENDIF', open2: 'FOR', close2: 'ENDFOR' },
  delimiters: delims([["'", '', "'"], ['"', '', '"']]),
  keywords: {
    // a word in two lists takes the first list's colour: header words (ABORT_REQUEST) stay header-coloured
    1: tpControl.filter(w => !tpSections.includes(w)), 2: tpMotion, 3: tpData, 4: tpSections, 5: tpTypes,
    6: ['J', 'L', 'C', 'A', 'S', 'CALL', 'RUN', 'JMP'],
    // instructions, motion options and macros that come with software options (line tracking, vision, arc, spot ...)
    7: [...tpOptionPhrases, ...tpOptionWords],
  },
  styles: [
    ['KEYWORDS1', '0000C0', true],   // control flow
    ['KEYWORDS2', '7A3E9D'],         // motion options, termination
    ['KEYWORDS3', 'B8860B', true],   // data: R[] DO[] P[] - the amber of TP
    ['KEYWORDS4', '808080', true],   // /PROG /MN /POS and header fields
    ['KEYWORDS5', '008080'],         // UFRAME UTOOL PAYLOAD
    ['KEYWORDS6', 'C04000', true],   // motion type + CALL/RUN/JMP
    ['KEYWORDS7', '6A1B9A', true],   // option instructions (line tracking, vision, arc, spot ...)
    ['KEYWORDS8', '000000'],
  ],
});

const klUdl = udl({
  name: 'FANUC KAREL', ext: 'kl KL',
  comments: '00-- 01 02 03 04',
  operators: '= < > + - * / ( ) , ; : [ ] . @ # &',
  folds: {
    open: 'BEGIN IF FOR WHILE REPEAT SELECT CONDITION STRUCTURE USING',
    middle: 'ELSE',
    close: 'END ENDIF ENDFOR ENDWHILE UNTIL ENDSELECT ENDCONDITION ENDSTRUCTURE ENDUSING',
  },
  delimiters: delims([["'", '', "'"]]),
  keywords: { 1: klKeywords, 2: klTypes, 3: klConstants, 4: klBuiltins, 5: klPorts, 6: klDirectives },
  styles: [
    ['KEYWORDS1', '0000C0', true],   // statements
    ['KEYWORDS2', '1F5FBF'],         // types - the blue of PC programs
    ['KEYWORDS3', 'B5530B'],         // constants
    ['KEYWORDS4', '795E26'],         // built-in routines
    ['KEYWORDS5', 'B8860B', true],   // ports DIN[] DOUT[]
    ['KEYWORDS6', '808080', true],   // %directives
    ['KEYWORDS7', '000000'],
    ['KEYWORDS8', '000000'],
  ],
});

// ---------------------------------------------------------------- auto-completion
function autoComplete(language, entries, env) {
  const sorted = [...entries].sort((a, b) => (a.name.toUpperCase() < b.name.toUpperCase() ? -1 : a.name.toUpperCase() > b.name.toUpperCase() ? 1 : 0));
  const kws = sorted.map(e => {
    if (!e.params) return `        <KeyWord name="${esc(e.name)}" />`;
    return `        <KeyWord name="${esc(e.name)}" func="yes">
            <Overload retVal="${esc(e.ret ?? '')}" descr="${esc(e.doc ?? '')}">
${e.params.map(p => `                <Param name="${esc(p)}" />`).join('\n')}
            </Overload>
        </KeyWord>`;
  });
  return `<?xml version="1.0" encoding="UTF-8" ?>
<!-- ${language} auto-completion for Notepad++ - generated by robot-code-vscode scripts/make-notepadpp.mjs, Robot Code ${version}. -->
<NotepadPlus>
    <AutoComplete language="${esc(language)}">
        <Environment ignoreCase="yes" startFunc="(" stopFunc=")" paramSeparator="${esc(env.sep)}" terminal=";" additionalWordChar="_%$" />
${kws.join('\n')}
    </AutoComplete>
</NotepadPlus>
`;
}
// Notepad++ hands the list to Scintilla space-separated and Scintilla binary-searches it, so a
// two-word entry (TIME AFTER) splits, lands out of order and hides others (UTOOL, LBL): one word
// each, and one spelling per word (the controller's upper case when the grammar has both).
const tpSingle = new Map();
for (const w of [...tpControl, ...tpMotion, ...tpData, ...tpTypes, ...tpSections, ...tpOptionWords].flatMap(w => w.replace(/"/g, '').split(/\s+/)).filter(Boolean)) {
  const key = w.toUpperCase();
  if (!tpSingle.has(key) || w === key) tpSingle.set(key, w);
}
const tpWords = [...tpSingle.values()].map(name => ({ name }));
const klEntries = new Map();
for (const w of [...klKeywords, ...klTypes, ...klConstants, ...klPorts, ...klDirectives, ...klBuiltins]) klEntries.set(w.replace(/"/g, '').toUpperCase(), { name: w.replace(/"/g, '') });
for (const [name, b] of builtins) {
  const inner = /\((.*)\)/.exec(b.sig)?.[1] ?? '';
  klEntries.set(name, { name, params: inner ? inner.split(';').map(p => p.trim()) : [], doc: b.doc, ret: b.ret });
}

// ---------------------------------------------------------------- function list
const functionList = (id, name, mainExpr, nameExpr) => `<?xml version="1.0" encoding="UTF-8" ?>
<!-- ${name} Function List - generated by robot-code-vscode scripts/make-notepadpp.mjs, Robot Code ${version}. -->
<NotepadPlus>
    <functionList>
        <parser displayName="${name}" id="${id}" commentExpr="${esc(name === 'FANUC TP' ? '(?m-s)//.*$' : '(?m-s)--.*$')}">
            <function mainExpr="${esc(mainExpr)}">
                <functionName>
                    <nameExpr expr="${esc(nameExpr)}" />
                </functionName>
            </function>
        </parser>
    </functionList>
</NotepadPlus>
`;

// ---------------------------------------------------------------- install / uninstall scripts
// Plain .ps1 templates in scripts/notepadpp/ (PowerShell inside a JS template string needs every
// backtick and backslash escaped twice); only {{VERSION}} is filled in.
const ps1 = name => readFileSync(path.join(root, 'scripts', 'notepadpp', name), 'utf8').replace(/{{VERSION}}/g, version);

// ---------------------------------------------------------------- write
for (const d of ['userDefineLangs', 'autoCompletion', 'functionList']) mkdirSync(path.join(out, d), { recursive: true });
const w = (rel, text) => { writeFileSync(path.join(out, rel), text.replace(/\r?\n/g, '\r\n'), 'utf8'); console.log(`  ${rel}`); };
w('userDefineLangs/FANUC TP.xml', tpUdl);
w('userDefineLangs/FANUC KAREL.xml', klUdl);
w('autoCompletion/FANUC TP.xml', autoComplete('FANUC TP', tpWords, { sep: ',' }));
w('autoCompletion/FANUC KAREL.xml', autoComplete('FANUC KAREL', [...klEntries.values()], { sep: ';' }));
// TP: labels "  12:  LBL[10:HOME] ;" ; KAREL: ROUTINE name (bodies and FROM forward declarations alike)
w('functionList/fanuc_tp.xml', functionList('fanuc_tp', 'FANUC TP', '(?m)^\\s*\\d+:\\s*LBL\\[\\d+(:[^\\]]*)?\\]', 'LBL\\[\\d+(:[^\\]]*)?\\]'));
w('functionList/fanuc_karel.xml', functionList('fanuc_karel', 'FANUC KAREL', '(?mi)^\\s*ROUTINE\\s+\\w+', '\\w+$'));
w('install.ps1', ps1('install.ps1'));
w('uninstall.ps1', ps1('uninstall.ps1'));
console.log(`Notepad++ files for Robot Code ${version}: ${klEntries.size} KAREL words (${builtins.size} with call tips), ${tpWords.length} TP words`);
