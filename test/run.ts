/**
 * Corpus test: parse every .ls / .kl / .va file found under the given folders
 * (default: ../reference-backup and ../Robotic Utility Kit/RUKUS.Tests/TestData)
 * and check invariants. Run with `npm test`.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { registerBrand } from '@core/brand';
import { fanucBrand } from '@fanuc/brand';
import { parseTp, frameLabel, frameHintFields, describePosition, positionMarkdown, isIndirectLabelIndex } from '@fanuc/tp/parser';
import { renumber, applyLineEdits, renumberLabels, commentScaffold } from '@fanuc/tp/renumber';
import { reflowExtendedComment, extCommentColumns, extCommentText, wrapWords } from '@fanuc/tp/extendedComment';
import { buildFlow, flowToMermaid, edgeText, edgeCaption } from '@fanuc/tp/flow';
import { findStalePositions, planPositionRemoval } from '@fanuc/tp/cleanup';
import { DEFAULT_HEADER_TEMPLATES, expandHeader, headerPrompts, ruleLine } from '@fanuc/tp/headers';
import { SysVarsIndex, normalizeSysVar, sysVarTokenAt, describeSysVar } from '@fanuc/data/sysVarsIndex';
import { parseKarel, findUnused, stripCommentAndStrings } from '@fanuc/karel/parser';
import { parseNumReg, parsePosReg, parseStrReg, parseIoComments, parseMacroTable, parsePayloads, describePayload, robotNameFromFolder } from '@fanuc/data/vaParser';
import { lookupTpDoc, lookupTpDocsAt, TP_INSTRUCTION_COMPLETIONS, TP_OPERAND_COMPLETIONS } from '@fanuc/tp/docs';
import { FANUC_PROGRAMS, CATALOG_MACROS } from '@fanuc/tp/syntaxCatalog';
import { parseCurPos, parsePrgState, parseIoState, parseAlarms, parseControllerInfo } from '@core/live/parsers';
import { planTeach, planRewriteBlock, applyTeachEdits, sourceFromCurrentPosition, buildPositionBlock, posSectionBounds, nextFreePositionIndex, planOffset, parseAxisOffsets, positionDistance, planFrameShift, planMirror, planRelabelFrames } from '@fanuc/tp/teach';
import { planRemap, planExtract, planInline, planCombine, applyLineChanges } from '@fanuc/tp/refactor';
import { lintKarel, countArgs, LINT_CODES, identifierLengthIssues, karelNameLimits, karelCoreVersionOf } from '@fanuc/karel/lint';
import { includedNames } from '@fanuc/karel/includes';
import { detectTabWidth, indentWidth } from '@fanuc/karel/tabWidth';
import { LIST_LIMIT_JS } from '@core/webviewStyle';
import { convertUserFrame, convertToolFrame, toPose, fromPose, mirror, sameOrientation, IDENTITY } from '@fanuc/tp/frameMath';
import { parseOrderFile, hasOption, canLoadAscii, optionHighlights, ASCII_UPLOAD, catalogOptionInstalled } from '@fanuc/live/controllerOptions';
import { connectionHint } from '@core/live/connectionHints';
import { parseSysFrames, frameOrIdentity } from '@fanuc/data/sysFrameParser';
import { usageFindings, accessOfRef } from '@fanuc/tools/xref';
import { findUndeclared } from '@fanuc/karel/parser';
import { KAREL_BUILTINS, KAREL_PREDEFINED } from '@fanuc/karel/builtins';
import { parseHttpListing, httpGetText, httpList } from '@core/live/http';
import { ftpGetText, ftpList, FtpClient, globToRegExp, transferTimeout } from '@core/live/ftp';
import { filesToShow } from '@core/live/fileFilter';
import { unwrapControllerHtml, looksLikeHtml } from '@core/live/html';
import { parseKtransIssues } from '@fanuc/karel/ktransOutput';
import { lookupAlarm, alarmMarkdownLines, alarmFacilities } from '@fanuc/alarms/alarms';
import { startMockRobot } from './mockRobot.mjs';
import { diffBackups, backupDiffMarkdown } from '@fanuc/tools/backupDiff';
import { buildXref, xrefFindings, xrefCsv } from '@fanuc/tools/xref';
import * as oniguruma from 'vscode-oniguruma';
import * as vsctm from 'vscode-textmate';
import { run as runPositionDiff } from './positionDiff.test';
import { run as runPositionFormat } from './positionFormat.test';
import { run as runCommentSync } from './commentSync.test';
import { run as runProgramTemplates } from './programTemplates.test';
import {
  parseRobotJson, parseCellJson, classifyPath, markerOf, markersWithOverlap,
  normalizeTpForCompare, normalizeKarelForCompare, normalizedTextHash, lineDiffCount,
  stripTpMetadata, roundTripCompare,
  buildRankComparator,
  copySnapshot, readProvenance, writeProvenance,
  underPath, ROBOT_DIR, CELL_DIR, SNAPSHOT_DIR, ROBOT_JSON, CELL_JSON,
  type RobotMarker,
} from '@core/robotContainers';
import { run as runIssue5 } from './issue5.test';
import { run as runVersionId } from './versionId.test';
import { run as runContainersHardening } from './containersHardening.test';
import { run as runSnapshotSync } from './snapshotSync.test';
import { run as runSyncCore } from './syncCore.test';
import { run as runFileIcons } from './fileIcons.test';
import { run as runRukusLayout } from './rukusLayout.test';
import { run as runRukusStore } from './rukusStore.test';
import { run as runBetaIssues } from './betaIssues.test';

const roots = process.argv.slice(2).length ? process.argv.slice(2) : [
  path.resolve(__dirname, '..', '..', 'reference-backup'),
  path.resolve(__dirname, '..', '..', 'Robotic Utility Kit', 'RUKUS.Tests', 'TestData'),
  // three programs off a V8.30 SpotTool+ controller: [index:state:comment] I/O, --eg: lines, untaught positions
  path.resolve(__dirname, '..', 'test', 'fixtures-v830'),
];

let failures = 0;
let checksRun = 0;
function check(cond: unknown, msg: string) { checksRun++; if (!cond) { failures++; console.log('  FAIL', msg); } }

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!/^(bin|obj|node_modules)$/i.test(e.name)) walk(p, out); }
    else out.push(p);
  }
  return out;
}

// Core asks the registered brands which folders are backups and how to index a program;
// the extension registers them at activation, the tests here.
registerBrand(fanucBrand);

const files = roots.flatMap(r => walk(r));
(async () => {
const ls = files.filter(f => /\.ls$/i.test(f));
const kl = files.filter(f => /\.kl$/i.test(f));
const va = files.filter(f => /\.va$/i.test(f));

console.log(`TP programs: ${ls.length}, KAREL: ${kl.length}, VA: ${va.length}`);

// ---------- TP ----------
let totalLines = 0, totalLabels = 0, totalJumps = 0, totalCalls = 0, totalPos = 0, totalRefs = 0, skippedLogs = 0;
const undocumented = new Map<string, number>();
const macroNames = new Map<string, number>();
for (const f of ls) {
  const text = fs.readFileSync(f, 'utf8');
  if (!/^\/PROG\b/m.test(text)) { skippedLogs++; continue; } // alarm logs (err*.ls, hist.ls) share the extension
  const prog = parseTp(text);
  const name = path.basename(f);
  check(prog.header.name, `${name}: no /PROG name`);
  for (const mc of prog.macros) macroNames.set(mc.name, (macroNames.get(mc.name) ?? 0) + 1);
  check(prog.sections.mn !== undefined, `${name}: no /MN`);
  const lc = prog.header.attrs.get('LINE_COUNT');
  if (lc) check(parseInt(lc.value, 10) === prog.numberedLineCount, `${name}: LINE_COUNT ${lc.value} but ${prog.numberedLineCount} numbered lines`);
  // labels referenced must exist (controller enforces this at run time, not at load, so only warn)
  for (const j of prog.jumps) if (!prog.labels.some(l => l.num === j.num)) console.log(`  note ${name}: JMP LBL[${j.num}] has no label`);
  // positions referenced exist
  for (const r of prog.posRefs) check(prog.positions.some(p => p.index === r.index), `${name}: P[${r.index}] referenced but not in /POS`);
  // renumber must be a no-op on a clean controller file
  const res = renumber(text, { width: 4, autoSemicolon: true, updateLineCount: true });
  if (res.edits.length) {
    console.log(`  note ${name}: renumber would change ${res.edits.length} line(s):`);
    for (const e of res.edits.slice(0, 3)) console.log(`     L${e.line + 1}: ${JSON.stringify(text.split(/\r?\n/)[e.line])} -> ${JSON.stringify(e.newText)}`);
  }
  check(res.lineCount === prog.numberedLineCount, `${name}: renumber count ${res.lineCount} != parsed ${prog.numberedLineCount}`);
  // instruction docs coverage
  for (const l of prog.lines) {
    if (l.kind === 'instruction' || l.kind === 'motion') {
      if (prog.macros.some(m => m.line === l.line)) continue;
      if (!lookupTpDoc(l.body)) { const k = l.body.split(/[\s[=]/)[0]; undocumented.set(k, (undocumented.get(k) ?? 0) + 1); }
    }
  }
  totalLines += prog.numberedLineCount; totalLabels += prog.labels.length; totalJumps += prog.jumps.length; totalCalls += prog.calls.length; totalPos += prog.positions.length; totalRefs += prog.dataRefs.length;
}
console.log(`TP totals: ${totalLines} lines, ${totalLabels} labels, ${totalJumps} jumps, ${totalCalls} calls, ${totalPos} positions, ${totalRefs} data refs; ${skippedLogs} non-program .ls skipped`);
console.log('TP macro calls:', [...macroNames.entries()].map(([k, n]) => `"${k}"(${n})`).join(' '));
check(macroNames.has('GO TO HOME POS'), 'macro "GO TO HOME POS" detected');
check(![...macroNames.keys()].some(k => /^(IF|WAIT|JMP|CALL|LBL|SELECT|END|ELSE|ENDIF|ABORT|PAUSE|DO|R|PR)\b/.test(k)), 'no instruction mistaken for macro');
if (undocumented.size) console.log('TP instructions without hover doc:', [...undocumented.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([k, n]) => `${k}(${n})`).join(' '));

// Renumber synthetic test
{
  const src = [
    '/PROG  T', '/ATTR', 'LINE_COUNT\t= 2;', '/MN',
    '   1:  R[1]=1 ;',
    'DO[1]=ON',                    // unnumbered, needs number + terminator
    '   9:  !comment ;',           // wrong number
    'J P[1] 100% FINE',            // unnumbered motion
    '   4:C P[1] ',                // circular first half (no terminator wanted)
    '    :  P[2] 500mm/sec FINE ;',
    '',                            // empty -> blank instruction
    '/POS', '/END',
  ].join('\n');
  const res = renumber(src, { width: 4, autoSemicolon: true, updateLineCount: true });
  const out = applyLineEdits(src, res.edits).split('\n');
  check(out[4] === '   1:  R[1]=1 ;', `renumber keeps line 1: ${out[4]}`);
  check(out[5] === '   2:  DO[1]=ON ;', `renumber numbers new line: ${JSON.stringify(out[5])}`);
  check(out[6] === '   3:  !comment ;', `renumber fixes wrong number: ${JSON.stringify(out[6])}`);
  check(out[7] === '   4:J P[1] 100% FINE ;', `renumber motion hugs colon: ${JSON.stringify(out[7])}`);
  check(out[8] === '   5:C P[1] ', `circular first half untouched: ${JSON.stringify(out[8])}`);
  check(out[9] === '    :  P[2] 500mm/sec FINE ;', `continuation untouched: ${JSON.stringify(out[9])}`);
  check(out[10] === '   6:   ;', `empty becomes blank instruction: ${JSON.stringify(out[10])}`);
  check(out[2] === 'LINE_COUNT\t= 6;', `LINE_COUNT updated: ${JSON.stringify(out[2])}`);
  const prog = parseTp(applyLineEdits(src, res.edits));
  check(prog.lines.find(l => l.line === 7)?.motion?.speed?.value === '100', 'motion speed parsed');
  check(prog.lines.find(l => l.line === 9)?.motion?.target?.index === 2, 'continuation target parsed');
}

// Program flow graphs: every program in the corpus must produce a consistent graph
{
  let flowPrograms = 0, totalBlocks = 0, totalEdges = 0;
  for (const f of ls) {
    const text = fs.readFileSync(f, 'utf8');
    if (!/^\/PROG\b/m.test(text)) continue;
    const prog = parseTp(text);
    const g = buildFlow(prog);
    flowPrograms++; totalBlocks += g.nodes.length; totalEdges += g.edges.length;
    const name = path.basename(f);
    check(g.edges.every(e => e.from >= 0 && e.from < g.nodes.length && e.to >= 0 && e.to < g.nodes.length), `${name}: flow edges reference existing nodes`);
    check(g.nodes.every((n, i) => n.id === i), `${name}: node ids sequential`);
    // every executable numbered line appears in exactly one block
    const mn = prog.sections.mn!, pos = prog.sections.pos ?? prog.sections.end ?? 1e9;
    const exec = prog.lines.filter(l => l.line > mn && l.line < pos && l.num !== undefined && !['blank', 'empty', 'remark', 'comment'].includes(l.kind)).length;
    const inBlocks = g.nodes.reduce((n, b) => n + b.lines.filter(x => x.kind !== 'comment').length, 0);
    check(inBlocks === exec, `${name}: ${exec} executable lines vs ${inBlocks} in blocks`);
    // labels that are jumped to must be nodes; unresolved must match parser's undefined labels
    const undefinedLabels = new Set(prog.jumps.filter(j => !prog.labels.some(l => l.num === j.num)).map(j => j.num));
    check(g.unresolved.every(u => undefinedLabels.has(u.label)), `${name}: unresolved jumps only for undefined labels`);
    // entry node is first, every non-entry node except unreachable has an incoming edge or is the first
    check(g.nodes.length === 0 || ['entry', 'label', 'end', 'loop'].includes(g.nodes[0].kind), `${name}: first node is entry-like (${g.nodes[0]?.kind})`);
    const mermaid = flowToMermaid(g, prog.header.name ?? name);
    check(mermaid.startsWith('flowchart TD') && (mermaid.match(/^\s+B\d+ /gm)?.length ?? 0) === g.edges.length, `${name}: mermaid edges`);
  }
  console.log(`  flow: ${flowPrograms} programs, ${totalBlocks} blocks, ${totalEdges} edges`);
  const f = ls.find(x => /enterzon\.ls$/i.test(x));
  if (f) {
    const g = buildFlow(parseTp(fs.readFileSync(f, 'utf8')));
    const start = g.nodes[0];
    const selectEdges = g.edges.filter(e => e.from === start.id && e.kind === 'case');
    check(selectEdges.length === 15, `enterzon: SELECT fans out to 15 cases (got ${selectEdges.length})`);
    const lbl10 = g.nodes.find(n => n.label === 10)!;
    check(g.edges.some(e => e.to === lbl10.id && e.back && e.kind === 'true'), 'enterzon: IF ...,JMP LBL[10] loops back to LBL[10]');
    const lbl200 = g.nodes.find(n => n.label === 200)!;
    check(g.edges.filter(e => e.to === lbl200.id).length >= 14, `enterzon: LBL[200] is the merge point (${g.edges.filter(e => e.to === lbl200.id).length} in)`);
    check(g.nodes.some(n => n.kind === 'end'), 'enterzon: has an END node');
  }
}

// Robot folder naming (multi-robot backup trees)
check(robotNameFromFolder('C:\\Backups\\Latest\\S002R01_(MD)_260912') === 'S002R01', 'robot name from (MD) folder');
check(robotNameFromFolder('/x/S002R01_full_260823/') === 'S002R01', 'robot name from full backup folder');
check(robotNameFromFolder('C:\\Backups\\2026-08-29_09-15') === '2026-08-29_09-15', 'dated folder keeps its name');
check(robotNameFromFolder('R7_260912') === 'R7', 'trailing yymmdd stripped');

// Label renumbering
{
  const f = ls.find(x => /enterzon\.ls$/i.test(x));
  if (f) {
    const text = fs.readFileSync(f, 'utf8');
    const before = parseTp(text);
    const res = renumberLabels(text, { start: 10, step: 10 });
    const lines = text.split(/\r?\n/);
    for (const e of [...res.edits].sort((a, b) => b.line - a.line || b.col - a.col)) lines[e.line] = lines[e.line].slice(0, e.col) + e.newText + lines[e.line].slice(e.col + e.len);
    const after = parseTp(lines.join('\n'));
    check(after.labels.length === before.labels.length, 'label renumber keeps label count');
    check(after.labels.map(l => l.num).join(',') === before.labels.map((_, i) => 10 + i * 10).join(','), `label renumber sequence: ${after.labels.map(l => l.num).join(',')}`);
    check(after.jumps.length === before.jumps.length && after.jumps.every(j => after.labels.some(l => l.num === j.num)), 'label renumber: every jump still resolves');
    check(after.labels.every((l, i) => l.comment === before.labels[i].comment), 'label renumber keeps comments');
    const noop = renumberLabels(lines.join('\n'), { start: 10, step: 10 });
    check(noop.edits.length === 0, 'label renumber is idempotent');
  }
}

// Parser detail test on a real program if available
{
  const f = ls.find(x => /enterzon\.ls$/i.test(x));
  if (f) {
    const prog = parseTp(fs.readFileSync(f, 'utf8'));
    check(prog.header.name === 'ENTERZON', 'enterzon name');
    check(prog.header.programType === 'Macro', 'enterzon Macro type');
    check(prog.labels.some(l => l.num === 10), 'enterzon has LBL[10]');
    check(prog.jumps.filter(j => j.num === 10).length >= 3, 'enterzon jumps to LBL[10] (SELECT + IF)');
    const r151 = prog.dataRefs.find(d => d.kind === 'R' && d.index === 151);
    check(r151?.comment === 'ZonSelNumEntrExt', `R[151] comment parsed: ${r151?.comment}`);
    const di25 = prog.dataRefs.find(d => d.kind === 'DI' && d.index === 25);
    check(di25?.comment === 'ZONE 1 CLR', `DI[25] comment parsed: ${di25?.comment}`);
  }
  const g = ls.find(x => /dcs_check\.ls$/i.test(x));
  if (g) {
    const prog = parseTp(fs.readFileSync(g, 'utf8'));
    const p1 = prog.positions.find(p => p.index === 1);
    check(p1 && p1.groups[0].uf === 11 && p1.groups[0].ut === 2, 'dcs_check P[1] UF/UT');
    check(p1 && Math.abs(p1.groups[0].values.X.value - 2220.302) < 1e-6, 'dcs_check P[1] X');
    check(p1?.groups[0].kind === 'cartesian', 'dcs_check P[1] cartesian');
    check(prog.lines.find(l => l.num === 1)?.motion?.target?.kind === 'PR', 'dcs_check line 1 PR target');
    check(prog.lines.find(l => l.num === 9)?.motion?.speed?.unit === 'mm/sec', 'dcs_check line 9 speed unit');
  }
}

// ---------- KAREL ----------
let kSyms = 0, kRoutines = 0, kDiag = 0, kLint = 0, kLintErrors = 0;
const kLintErrorSamples: string[] = [];
// programs a controller ran declare everything they use: the undeclared check must stay quiet
// on them, includes read from disk (no support folder here, so FANUC's own leave a file unjudged)
let kJudged = 0;
const kUndeclared: string[] = [];
const isCorpusB = (u: string) => KAREL_BUILTINS.has(u) || KAREL_PREDEFINED.has(u);
for (const f of kl) {
  const text = fs.readFileSync(f, 'utf8');
  const prog = parseKarel(text);
  const name = path.basename(f);
  if (!prog.name) console.log(`  note ${name}: no PROGRAM statement`);
  const errs = prog.diagnostics.filter(d => d.severity === 'error' && d.code === 'karel.unbalanced');
  if (errs.length) console.log(`  note ${name}: ${errs.length} block error(s): ${errs[0].message} @${errs[0].span.line + 1}`);
  kSyms += prog.symbols.length; kRoutines += prog.routines.length; kDiag += prog.diagnostics.length;
  // the lint over the corpus: programs a controller ran must not produce lint ERRORS
  // (a hint or a warning is advice; an error claims ktrans would refuse the file)
  if (prog.name) {
    for (const d of lintKarel(prog)) {
      kLint++;
      if (d.severity === 'error') { kLintErrors++; if (kLintErrorSamples.length < 12) kLintErrorSamples.push(`${name}:${d.span.line + 1} ${d.code} ${d.message}`); }
    }
    const inc = prog.includes.length ? includedNames(prog, path.dirname(f), []) : undefined;
    if (!inc || inc.complete) kJudged++;
    for (const u of findUndeclared(prog, isCorpusB, inc)) kUndeclared.push(`${name}:${u.line + 1} ${u.upper}`);
  }
}
console.log(`KAREL totals: ${kSyms} symbols, ${kRoutines} routines, ${kDiag} diagnostics, ${kLint} lint findings (${kLintErrors} errors)`);
check(kLintErrors === 0, `the lint reports no ERROR on the ${kl.length} corpus programs a controller ran:\n    ${kLintErrorSamples.join('\n    ')}`);
check(kUndeclared.length === 0, `no undeclared name in the ${kJudged} corpus programs the check could judge:\n    ${kUndeclared.slice(0, 12).join('\n    ')}`);
console.log(`KAREL undeclared check: ${kJudged} programs judged, ${kUndeclared.length} findings`);
{
  const src = [
    'PROGRAM test_prog', '%NOLOCKGROUP', '%INCLUDE klevkeys',
    'CONST', '  max_items = 10', "  greeting = 'hi -- not a comment'",
    'TYPE', '  item_t = STRUCTURE', '    id : INTEGER', '    name : STRING[16]', '  ENDSTRUCTURE',
    'VAR', '  count, total : INTEGER', '  items : ARRAY[max_items] OF item_t', '  unused_var : REAL',
    'ROUTINE ext_rtn(a : INTEGER) : BOOLEAN FROM other_prog',
    'ROUTINE add(a, b : INTEGER) : INTEGER', 'VAR', '  r : INTEGER', 'BEGIN', '  r = a + b', '  RETURN(r)', 'END add',
    'BEGIN', '  count = 0', '  FOR count = 1 TO max_items DO', '    IF items[count].id > 0 THEN', '      total = add(total, items[count].id)', '    ENDIF', '  ENDFOR',
    '  WHILE total > 0 DO', '    total = total - 1', '  ENDWHILE',
    '  WRITE TPDISPLAY(greeting, CR)',
    'END test_prog',
  ].join('\n');
  const prog = parseKarel(src);
  check(prog.name === 'test_prog', 'karel program name');
  check(prog.includes.includes('klevkeys'), 'karel include');
  check(prog.routines.length === 2, `karel routines: ${prog.routines.length}`);
  const add = prog.routines.find(r => r.upper === 'ADD');
  check(add?.params?.length === 2 && add.params[1].type === 'INTEGER', 'karel add params');
  check(add?.returnType === 'INTEGER', 'karel add return type');
  check(add?.endLine === 22, `karel add endLine ${add?.endLine}`);
  check(prog.routines.find(r => r.upper === 'EXT_RTN')?.from === 'other_prog', 'karel FROM');
  check(prog.symbols.some(s => s.kind === 'structure' && s.upper === 'ITEM_T' && s.fields?.length === 2), 'karel structure fields');
  check(prog.symbols.some(s => s.kind === 'constant' && s.upper === 'GREETING' && s.value?.includes('not a comment')), 'karel string const with --');
  check(prog.diagnostics.filter(d => d.code === 'karel.unbalanced').length === 0, `karel balanced: ${JSON.stringify(prog.diagnostics)}`);
  const unused = findUnused(prog).map(s => s.upper);
  check(unused.includes('UNUSED_VAR') && !unused.includes('COUNT') && !unused.includes('ADD'), `karel unused: ${unused.join(',')}`);
  const bad = parseKarel('PROGRAM x\nBEGIN\n  IF a THEN\n    b = 1\nEND x');
  check(bad.diagnostics.some(d => d.code === 'karel.unbalanced'), 'karel detects unclosed IF');
  const longName = parseKarel('PROGRAM x\nVAR\n  this_name_is_way_too_long : INTEGER\nBEGIN\nEND x');
  check(identifierLengthIssues(longName, karelNameLimits('V6')).length === 1, 'karel ident length: 25 characters is too long on V6');
  check(identifierLengthIssues(longName, karelNameLimits('V9')).length === 0, 'karel ident length: 25 characters is fine on V9');
}

// ---------- long webview lists: the shared "Show 10 / 50 / 100 / 250 / All" picker ----------
{
  let state: any = undefined;
  const vscodeStub = { getState: () => state, setState: (s: any) => { state = s; } };
  const api = new Function('vscode', `${LIST_LIMIT_JS}; return { rcSlice, rcLimitBar, rcLimit };`)(vscodeStub);
  const items = Array.from({ length: 300 }, (_, i) => i);
  check(api.rcSlice('reg', items, 50).length === 50, 'a list shows its default count first');
  const bar = api.rcLimitBar('reg', 50, 300, 50);
  check(/Showing 50 of 300/.test(bar) && /<option value="50" selected>50<\/option>/.test(bar) && /<option value="0">All<\/option>/.test(bar), `the bar says what is shown and offers 10/50/100/250/All: ${bar}`);
  check(api.rcLimitBar('reg', 8, 8, 50) === '', 'a short list gets no picker');
  state = { limits: { reg: 250, io: 0 } };
  check(api.rcSlice('reg', items, 50).length === 250 && api.rcSlice('io', items, 100).length === 300 && api.rcSlice('tsk', items, 50).length === 50, 'each list keeps its own choice; All shows everything');
}

// ---------- hover: what a real controller made of a catalog item (data/tp-syntax-verified.json) ----------
{
  const calib = lookupTpDoc('Calib_Start[1]');
  check(!!calib?.verified && /^Verified on a FANUC controller \(HandlingTool, V9\.40/.test(calib.verified) && /loaded as written/.test(calib.verified), `Calib_Start hover is marked verified: ${calib?.verified}`);
  const press = lookupTpDocsAt('L P[1] 2000mm/sec FINE PRESS_MOTN[SD=1,P=1,t=2.0]', 26).find(d => /PRESS_MOTN/i.test(d.title));
  check(!!press?.verified && /stores it as `.*:PRESS_MOTN\[/.test(press.verified) && !/HandlingTool/.test(press.verified), `PRESS_MOTN: stored form shown, only the controller that loaded it named: ${press?.verified}`);
  const ps = lookupTpDoc('PS -100mm +0.2sec,DO[1]=(ON)');
  check(!!ps && !ps.verified, 'PS (rejected on every controller) carries no verified mark');
  check(!lookupTpDoc('UTool Start[1]') || !/UTool Start/.test(lookupTpDoc('UTool Start[1]')!.syntax), 'the rejected pendant spelling "UTool Start" is no longer catalog syntax');
}

// ---------- KAREL tab width: ROBOGUIDE draws a tab 7 wide (one tab = 7 spaces, two = 14, measured 2026-10-03) ----------
{
  check(indentWidth('\t', 7) === 7 && indentWidth('\t\t', 7) === 14 && indentWidth('  \t', 7) === 7, 'a tab reaches the next multiple of the width');
  const block = (ind: string[]) => ['ROUTINE r', 'BEGIN', ...ind.map((s, i) => `${s}x${i} = 1`), 'END r'];
  check(detectTabWidth(block(['\t', ' '.repeat(7), '\t', ' '.repeat(7), '\t'])) === 7, 'tabs mixed with 7-space lines: written in ROBOGUIDE -> 7');
  check(detectTabWidth(block(['\t', '    ', '\t', '    ', '\t'])) === 4, 'tabs mixed with 4-space lines: written at width 4 -> 4');
  check(detectTabWidth(block(['\t', '\t', '\t\t', '\t'])) === undefined, 'a file indented with tabs only gives no verdict (any width looks right; the ROBOGUIDE default stands)');
  check(detectTabWidth(['\t-- this is a single table', '\t\t-- this is a dual tab', '-- this is not tabs']) === undefined, "Sam's ROBOGUIDE sample (comments only) gives no verdict - the default 7 applies");
  check(detectTabWidth(block(['\t', '  ', '\t', '    ', '\t', '      '])) === undefined, 'evidence that does not agree (2, 4 and 6 spaces beside tabs) gives no verdict');
}

// ---------- KAREL fixes from a customer KAREL deliverable (ktrans V6.40/V7.70/V8.30/V9.40) ----------
{
  const isKB = (u: string) => KAREL_BUILTINS.has(u) || KAREL_PREDEFINED.has(u);
  // name lengths by core version, as measured on ktrans
  const longProg = parseKarel(['PROGRAM comnd_complt_a1', 'VAR', '  recenb_stat_a1x : INTEGER', 'BEGIN', 'END comnd_complt_a1', ''].join('\n'));
  const at = (v: 'V6' | 'V7-V8' | 'V9') => identifierLengthIssues(longProg, karelNameLimits(v)).map(d => d.span.line).join();
  check(at('V6') === '0,2', `V6: program name and variable both over 12: ${at('V6')}`);
  check(at('V7-V8') === '0', `V7/V8: only the 15-character PROGRAM name is over 12: ${at('V7-V8')}`);
  check(at('V9') === '', `V9: 36 for everything: ${at('V9')}`);
  check(karelCoreVersionOf('[WinOLPC_Util]\r\nVersion=V8.30-1\r\n') === 'V7-V8' && karelCoreVersionOf('Version=V9.40-1') === 'V9' && karelCoreVersionOf('Version=V6.40-1') === 'V6', 'core version read from robot.ini');

  // `name FROM prog : type` declares name, not "name FROM prog"
  const fromVar = parseKarel(['PROGRAM p', 'VAR', '  errors FROM lib_install : INTEGER', '  log_on IN CMOS FROM lib_install : BOOLEAN', 'BEGIN', '  errors = 0', '  log_on = TRUE', 'END p', ''].join('\n'));
  const errs = fromVar.symbols.find(x => x.upper === 'ERRORS');
  check(errs?.from === 'lib_install' && errs.type === 'INTEGER' && fromVar.symbols.some(x => x.upper === 'LOG_ON' && x.from === 'lib_install'), `FROM variables: ${JSON.stringify(fromVar.symbols.map(x => [x.upper, x.from]))}`);
  check(identifierLengthIssues(fromVar, karelNameLimits('V6')).length === 0, 'a FROM clause is not part of the name length');
  check(findUndeclared(fromVar, isKB).length === 0, 'FROM variables are declared');
  const fromType = parseKarel(['PROGRAM p', 'TYPE shell_task_data FROM ku_taskmtr = STRUCTURE', '  name : STRING[12]', 'ENDSTRUCTURE', 'CONST MAX_ARMS = 2', 'VAR', '  shell_task IN CMOS FROM ku_cell : ARRAY[MAX_ARMS] OF shell_task_data', 'BEGIN', '  shell_task[1].name = \'\'', 'END p', ''].join('\n'));
  check(fromType.symbols.some(x => x.upper === 'SHELL_TASK_DATA' && x.kind === 'structure' && x.from === 'ku_taskmtr') && fromType.symbols.some(x => x.upper === 'MAX_ARMS' && x.kind === 'constant'), `TYPE/CONST opening their section on the declaration line: ${JSON.stringify(fromType.symbols.map(x => x.upper))}`);
  check(findUndeclared(fromType, isKB).length === 0 && !fromType.diagnostics.length, `TYPE ... FROM ... = STRUCTURE is declared: ${JSON.stringify(findUndeclared(fromType, isKB).map(r => r.upper))}`);
  // an include that ends inside VAR or CONST: the lines after it are still declarations
  const carried = parseKarel(['PROGRAM p', 'VAR', '  a : INTEGER', '%INCLUDE irvars', '  max_row : REAL', 'pos_mask : INTEGER', '%INCLUDE ircons', 'max_tool = 10', 'BEGIN', '  max_row = max_tool + pos_mask', 'END p', ''].join('\n'));
  check(['MAX_ROW', 'POS_MASK'].every(n => carried.symbols.some(x => x.upper === n && x.kind === 'variable')) && carried.symbols.some(x => x.upper === 'MAX_TOOL' && x.kind === 'constant'), `declarations carried on after an include: ${JSON.stringify(carried.symbols.map(x => [x.upper, x.kind]))}`);
  const afterSection = parseKarel(['PROGRAM p', '%INCLUDE irvars', '  max_row : REAL', 'BEGIN', '  max_row = 1', 'END p', ''].join('\n'));
  check(afterSection.symbols.some(x => x.upper === 'MAX_ROW' && x.kind === 'variable'), 'a declaration right after a leading %INCLUDE is read as the include\'s open section');
  // an option's own environment file the extension has no table for: not judged
  const env = parseKarel(['PROGRAM p', '%ENVIRONMENT tpfdef', 'VAR', '  s : ARRAY[8] OF FRMSET_T', 'BEGIN', 'END p', ''].join('\n'));
  check(findUndeclared(env, isKB).length === 0, 'a program loading an unknown %ENVIRONMENT is not judged');
  const envKnown = parseKarel(['PROGRAM p', '%ENVIRONMENT sysdef', 'BEGIN', '  nonsense_x = 1', 'END p', ''].join('\n'));
  check(findUndeclared(envKnown, isKB).map(r => r.upper).join() === 'NONSENSE_X', 'a known %ENVIRONMENT still lets the program be judged');
  // names from the KAREL environment files that real programs use bare
  check(['TSK_STATUS', 'ATR_IA', 'AT_PROTECT', 'DP_DEFAULT', 'KY_PREV', 'SPI_TPTCH', 'GET_TSK_ATTR'].every(isKB), 'environment-file names are predefined');

  // a compiled .pc saved under a .kl name (the start of the corpus's Copy.kl)
  const pc = parseKarel('þï\0\u0001\0\0Ådÿ\0)\u0088\u0005APPLOADER\0 FOR x\0');
  check(pc.compiled === true && pc.diagnostics.length === 1 && pc.diagnostics[0].code === 'karel.compiledFile' && !pc.name, `compiled file: ${JSON.stringify(pc.diagnostics)}`);

  // %INCLUDE files are read, so a program that includes its globals is judged
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-inc-'));
  try {
    fs.mkdirSync(path.join(dir, 'SYSTEM'));
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'SYSTEM', 'ku_global.kl'), ['VAR', '  app_ver : STRING[10]', '%INCLUDE nested', ''].join('\n'));
    fs.writeFileSync(path.join(dir, 'SYSTEM', 'nested.kl'), ['CONST', '  MAX_TRY = 3', ''].join('\n'));
    const src = ['PROGRAM p', '%INCLUDE ..\\SYSTEM\\ku_global', 'BEGIN', "  app_ver = '1'", '  IF MAX_TRY > 0 THEN', '    os_version = 0', '  ENDIF', 'END p', ''].join('\n');
    const inc = includedNames(parseKarel(src), path.join(dir, 'src'), []);
    check(inc.complete && inc.names.has('APP_VER') && inc.names.has('MAX_TRY'), `includes read, nested too: ${JSON.stringify([...inc.names])} missing ${inc.missing}`);
    check(findUndeclared(parseKarel(src), isKB, inc).map(r => r.upper).join() === 'OS_VERSION', 'with its includes read, the undeclared name ktrans rejects is reported');
    const missing = includedNames(parseKarel(src.replace('ku_global', 'not_there')), path.join(dir, 'src'), []);
    check(!missing.complete && findUndeclared(parseKarel(src), isKB, missing).length === 0, 'an include that cannot be found still means no answer');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// ---------- VA ----------
//
// The value assertions below are S002R01's OWN numbers - R[15] is its KAREL time-out,
// PR[1] is its Home 1. Pointed at the real multi-robot tree they would be run against
// 22 different robots that quite correctly have different values, which is noise, not a
// finding. So they are asserted on the reference robot and shape-checked on the rest.
const isRefRobot = (f: string) => /s002r01|reference-backup/i.test(f);
// Tighter still for the diagnostic files: CURPOS and ERRALL record ONE MOMENT. The same
// robot backed up on another day is parked a few mm away and has different alarms, so
// those readings are only ever asserted against the reference backup itself.
const isRefBackup = (f: string) => /reference-backup/i.test(f);

for (const f of va) {
  const base = path.basename(f).toLowerCase();
  const text = fs.readFileSync(f, 'utf8');
  const ref = isRefRobot(f);
  if (base === 'numreg.va') {
    const regs = parseNumReg(text);
    check(ref ? regs.length >= 200 : regs.length >= 0, `numreg entries: ${regs.length}`);
    const r15 = regs.find(r => r.index === 15);
    if (ref) check(r15?.comment === 'KAREL Time Out' && r15.value === 30000, `numreg R[15]: ${JSON.stringify(r15)}`);
    else check(!r15 || typeof r15.value === 'number' || typeof r15.value === 'string', `numreg R[15] shape: ${JSON.stringify(r15)}`);
  }
  if (base === 'posreg.va') {
    const prs = parsePosReg(text);
    check(ref ? prs.length >= 100 : prs.length >= 0, `posreg entries: ${prs.length}`);
    const pr1 = prs.find(p => p.index === 1);
    if (ref) check(pr1?.comment === 'Home 1' && pr1.kind === 'joint' && /J1 -16\.808/.test(pr1.summary), `posreg PR[1]: ${JSON.stringify(pr1)}`);
    else check(!pr1 || ['joint', 'cartesian', 'uninit'].includes(pr1.kind), `posreg PR[1] shape: ${JSON.stringify(pr1)}`);
    const cart = prs.find(p => p.kind === 'cartesian');
    if (cart) console.log(`  posreg cartesian sample PR[${cart.index}] '${cart.comment}': ${cart.summary} cfg=${cart.config}`);
    console.log(`  posreg kinds: joint=${prs.filter(p => p.kind === 'joint').length} cart=${prs.filter(p => p.kind === 'cartesian').length} uninit=${prs.filter(p => p.kind === 'uninit').length}`);
  }
  if (base === 'strreg.va') {
    const srs = parseStrReg(text);
    check(ref ? srs.length >= 25 : srs.length >= 0, `strreg entries: ${srs.length}`);
  }
  if (base === 'sysmacro.va') {
    const macros = parseMacroTable(text);
    if (ref) check(macros.some(m => m.macroName === 'GO TO HOME POS' && m.progName === 'MOV_HOME'), `macro table: ${macros.length} entries, ${JSON.stringify(macros.slice(0, 2))}`);
    else check(macros.every(m => !!m.macroName && !!m.progName), `macro table shape: ${JSON.stringify(macros.slice(0, 2))}`);
  }
  if (base === 'diocfgsv.va') {
    const io = parseIoComments(text);
    check(ref ? io.length > 100 : io.length >= 0, `io comments: ${io.length}`);
    const di25 = io.find(x => x.kind === 'DI' && x.index === 25);
    if (ref) check(di25?.comment === 'ZONE 1 CLR', `io DI[25]: ${JSON.stringify(di25)}`);
    else check(!di25 || typeof di25.comment === 'string', `io DI[25] shape: ${JSON.stringify(di25)}`);
    const kinds = new Map<string, number>(); for (const x of io) kinds.set(x.kind, (kinds.get(x.kind) ?? 0) + 1);
    console.log('  io kinds:', [...kinds.entries()].map(([k, n]) => `${k}=${n}`).join(' '));
  }
}

// ---------- Live-tier parsers against the real diagnostic files ----------
const curposFiles = roots.flatMap(r => walk(r)).filter(f => /curpos\.dg$/i.test(f));
// S002R01 specifically: every value assertion below is that robot's own reading.
const curposPick = curposFiles.find(isRefBackup) ?? curposFiles.find(isRefRobot) ?? curposFiles[0];
const backupDir = curposPick ? path.dirname(curposPick) : undefined;
if (backupDir && !isRefBackup(backupDir)) console.log(`  (reference backup not among the roots; the one-moment CURPOS/alarm checks are skipped - ${path.basename(backupDir)} is a different snapshot)`);
if (backupDir && isRefBackup(backupDir)) {
  const rd = (n: string) => fs.readFileSync(path.join(backupDir, n), 'latin1');
  const pos = parseCurPos(rd('curpos.dg'));
  check(pos?.joint?.joints.length === 6 && Math.abs(pos!.joint!.joints[0] + 101.43) < 1e-6, `curpos joints: ${JSON.stringify(pos?.joint)}`);
  check(pos?.userFrame && Math.abs(pos.userFrame.x + 156.83) < 1e-6 && pos.userFrame.config === 'N U T, 0, 0, 0', `curpos UF: ${JSON.stringify(pos?.userFrame)}`);
  check(pos?.world?.y === -1270.07 && pos.world.ext[0] === 100, `curpos world/ext: ${JSON.stringify(pos?.world)}`);
  check(pos?.frameNo === 1 && pos.toolNo === 1, 'curpos frame/tool numbers');
  const tasks = parsePrgState(rd('prgstate.dg'));
  check(tasks.length >= 19, `prgstate tasks: ${tasks.length}`);
  const t1 = tasks.find(t => t.taskNo === 1);
  check(t1?.name === 'MHMENUC' && t1.status === 'ABORTED' && t1.current?.line === 75 && t1.current.type === 'PC', `prgstate task 1: ${JSON.stringify(t1)}`);
  const io = parseIoState(rd('iostate.dg'));
  check(io.length > 3000, `iostate points: ${io.length}`);
  const di25 = io.find(p => p.kind === 'DI' && p.index === 25);
  check(di25?.value === 'OFF' && di25.comment === 'ZONE 1 CLR', `iostate DI[25]: ${JSON.stringify(di25)}`);
  check(io.some(p => p.kind === 'F') && io.some(p => p.kind === 'GO' && typeof p.value === 'number'), 'iostate flags and group values');
  const alarms = parseAlarms(rd('errall.ls'));
  check(alarms.length >= 50, `alarms: ${alarms.length}`);
  const a = alarms.find(x => x.seq === 798);
  check(a?.code === 'INTP-213' && a.severity === 'WARN' && /TeachMem/.test(a.message), `alarm 798: ${JSON.stringify(a)}`);
  check(alarms.some(x => x.isReset), 'alarm reset rows detected');
  const info = parseControllerInfo(rd('errall.ls') + rd('curpos.dg'));
  check(info.robotName === 'S002R01' && info.fNumber === 'F368808' && /V9\.40/.test(info.version ?? ''), `controller info: ${JSON.stringify(info)}`);
  // synthetic running task
  const running = parsePrgState('TASK STATES:\n\n1      MAIN_PICK status = RUNNING\n\n******  History Data  ******\nRoutine depth: 1  Routine: SUB\nLine:    12       Program: SUB_A     Type: TP\nRoutine depth: 0  Routine: MAIN_PICK\nLine:    44       Program: MAIN_PICK Type: TP\n');
  check(running[0]?.status === 'RUNNING' && running[0].current?.program === 'SUB_A' && running[0].stack.length === 2, `running task parse: ${JSON.stringify(running[0])}`);

  // ---- option syntax from the FANUC manuals (data/tp-syntax.json -> syntaxCatalog.ts) ----
  {
    const cat = await import('node:child_process');
    let upToDate = true;
    try { cat.execFileSync(process.execPath, [path.join(path.resolve(__dirname, '..'), 'scripts', 'build-tp-syntax.mjs'), '--check'], { stdio: 'pipe' }); } catch { upToDate = false; }
    check(upToDate, 'syntaxCatalog.ts and the grammar\'s catalog block match data/tp-syntax.json (run node scripts/build-tp-syntax.mjs)');
    // option instructions that are bare words are not user macro calls; an option's macro still is
    const optProg = parseTp(['/PROG X', '/MN', '   1:  Search End ;', '   2:  Touch Offset End ;', '   3:  STOP_TRACKING ;', '   4:  Sample End ;', '   5:  STOP ALL ISDT ;', '   6:  SOFTFLOAT END ;', '   7:  Prompt Box Msg(\'NotAtPerch\') ;', '   8:  GO TO HOME POS ;', '/POS', '/END', ''].join('\n'));
    const macroNames = optProg.macros.map(m => m.name);
    check(JSON.stringify(macroNames) === JSON.stringify(['Prompt Box Msg', 'GO TO HOME POS']), `only real macros are macro calls (option instructions are not): ${JSON.stringify(macroNames)}`);
    check(CATALOG_MACROS.includes('PROMPT BOX MSG') && CATALOG_MACROS.includes('STATUS MENU'), 'Menu Utility macros are known option macros (never "missing from sysmacro.va")');
    for (const p of ['RGETNREG', 'GESNDDAT', 'BINPICK_SEARCH', 'VSTKGETQ', 'IRVBKLSH', 'MREQZONE', 'TW_UPDAT']) check(!!FANUC_PROGRAMS[p], `FANUC-supplied program known (not "missing from the workspace"): ${p}`);
    // hover: instruction heads from the start of the body, calls and motion options anywhere, with the option
    for (const [body, title] of [['LINE[1] ON', /LINE/i], ['STOP_TRACKING', /STOP_TRACKING/i], ['Search Start[1] PR[2]', /Search Start/i], ['TORQ_LIMIT 20.0%', /TORQ_LIMIT/i], ['Weld Start[1,1]', /Weld|Arc start/i]] as Array<[string, RegExp]>) {
      const d = lookupTpDoc(body);
      check(!!d && title.test(d.title), `hover for "${body}": ${d?.title ?? 'none'}`);
    }
    const callDocs = lookupTpDocsAt("CALL RGETNREG('SERVER',10,20,0)", 7);
    check(callDocs.some(d => /J740/.test(d.option ?? '')), `hover on a FANUC program call names its option: ${JSON.stringify(callDocs.map(d => [d.title, d.option]))}`);
    const trackDoc = lookupTpDoc('Track TAST[1]');
    check(!!trackDoc && /seam tracking/i.test(trackDoc.title), `Track TAST is arc seam tracking, not line tracking: ${trackDoc?.title}`);
    check(TP_INSTRUCTION_COMPLETIONS.some(c => /^LINE\[/.test(c.label)) && TP_OPERAND_COMPLETIONS.some(c => c.motionOnly && /MROT/.test(c.label)), 'catalog completions are offered (LINE[...] ON, motion option MROT)');
  }
  // ROBOGUIDE V9.40 SpotTool+ (2026-10-01, real excerpt): an active task's head has no "status ="
  const v940 = parsePrgState('TASK STATES:\n\n9     PRDSUCHK status = ABORTED\n\n******  History Data  ******\nRoutine depth: 0  Routine: PRDSUCHK                            \nLine:     0       Program: PRDSUCHK                              Type: PC    \n\n10     SWAXTSK1 RUNNING @ 955 in PROCESSAMR of SWAXTCMN\n\n******  History Data  ******\nRoutine depth: 1  Routine: PROCESSAMR                          \nLine:   955       Program: SWAXTCMN                              Type: PC    \n\nRoutine depth: 0  Routine: SWAXTSK1                            \nLine:   172       Program: SWAXTSK1                              Type: PC    \n\n14     TOOL1MNT PAUSED @ 37 in TOOL1MNT of TOOL1MNT\n\n******  History Data  ******\nRoutine depth: 0  Routine: TOOL1MNT                            \nLine:    37       Program: TOOL1MNT                              Type: TP    \n\n15              status = ABORTED\n\nPROGRAM STATES:\n');
  const t14 = v940.find(t => t.taskNo === 14), t10 = v940.find(t => t.taskNo === 10);
  check(v940.length === 4 && t14?.status === 'PAUSED' && t14.name === 'TOOL1MNT' && t14.current?.program === 'TOOL1MNT' && t14.current.line === 37 && t14.current.type === 'TP', `V9.40 active task head (paused TP): ${JSON.stringify(t14)}`);
  check(t10?.status === 'RUNNING' && t10.current?.program === 'SWAXTCMN' && t10.current.line === 955 && t10.stack.length === 2, `V9.40 active task head (running KAREL, 2 deep): ${JSON.stringify(t10)}`);
  const headOnly = parsePrgState('3     MAINPROG RUNNING @ 12 in SUBR of MAINPROG\n');
  check(headOnly[0]?.current?.line === 12 && headOnly[0].current.program === 'MAINPROG' && headOnly[0].current.routine === 'SUBR', `V9.40 head with no detail lines still gives the line: ${JSON.stringify(headOnly[0])}`);
  // HTTP listing parser
  const listing = parseHttpListing('<table><tr><td><a href="/MD/NUMREG.VA">NUMREG.VA</a></td><td>1234</td></tr><tr><td><a href="/MD/enterzon.ls">enterzon.ls</a></td></tr></table>');
  check(listing.length === 2 && listing.some(f => f.name === 'NUMREG.VA' && f.size === 1234), `http listing: ${JSON.stringify(listing)}`);

  // mock robot end-to-end: HTTP + FTP clients
  await (async () => {
    const mock = startMockRobot(backupDir, 18090, 18091, { runningProgram: 'ENTERZON', runningLine: 44 });
    try {
      const txt = await httpGetText({ host: '127.0.0.1', port: 18090 }, 'MD:', 'PRGSTATE.DG');
      const t = parsePrgState(txt);
      check(t[0]?.status === 'RUNNING' && t[0].current?.program === 'ENTERZON', `mock http prgstate: ${JSON.stringify(t[0]?.current)}`);
      const list = await httpList({ host: '127.0.0.1', port: 18090 }, 'MD:');
      check(list.some(f => /^numreg\.va$/i.test(f.name)), `mock http listing ${list.length} files`);
      const ftpTxt = await ftpGetText({ host: '127.0.0.1', port: 18091, user: 'anonymous', password: '' }, 'MD:', 'CURPOS.DG');
      check(parseCurPos(ftpTxt)?.joint?.joints[5] === 95.4, 'mock ftp RETR curpos');
      const ftpFiles = await ftpList({ host: '127.0.0.1', port: 18091, user: 'anonymous', password: '' }, 'MD:');
      check(ftpFiles.some(f => /^iostate\.dg$/i.test(f.name)) && ftpFiles[0].size !== undefined, `mock ftp LIST ${ftpFiles.length} files`);
      // One session, many files - the mget shape. Also the test that the `226` after each
      // transfer is consumed: before, the second RETR on a session was answered by the
      // first one's completion line and failed, which is why every file got its own login.
      // The timeout is 300 ms on purpose: SLOW.DG keeps the control channel silent for
      // ~800 ms while its data trickles in (a control timer that ran during transfers ended
      // the whole backup on the first slow file), and RESET.DG drops its data connection
      // half way (whose 426 used to be left in the stream and answer the next PASV).
      const session = new FtpClient({ host: '127.0.0.1', port: 18091, user: 'anonymous', password: '', timeoutMs: 300 });
      await session.connect(); await session.cwd('MD:');
      const got: string[] = [];
      await session.retrieveMany(['CURPOS.DG', 'RESET.DG', 'NUMREG.VA', 'NO_SUCH.XYZ', 'SLOW.DG', 'PRGSTATE.DG'], (n, r) => got.push('data' in r ? `${n}:${r.data.length}` : `${n}:error:${r.error}`));
      const listedAfter = await session.list();
      await session.quit();
      check(got.length === 6 && /^CURPOS\.DG:[1-9]\d*$/.test(got[0]) && /^NUMREG\.VA:[1-9]\d*$/.test(got[2]) && got[3].startsWith('NO_SUCH.XYZ:error') && /^PRGSTATE\.DG:[1-9]\d*$/.test(got[5]), `mock ftp mget over one session: ${got.join(' ')}`);
      check(/^RESET\.DG:error:.*426/.test(got[1]), `a dropped data connection is reported with the server's 426 and the run goes on: ${got[1]}`);
      check(/^SLOW\.DG:(8\d|1\d\d)$/.test(got[4]), `a slow file arrives whole while the control channel sits idle past the timeout: ${got[4]}`);
      check(listedAfter.length === ftpFiles.length, `the session is still in step after six transfers (${listedAfter.length} files listed)`);
      // beta list 2, item 6: STOR - the one write. Round trip, then a refusal the session survives.
      const up = new FtpClient({ host: '127.0.0.1', port: 18091, user: 'anonymous', password: '', timeoutMs: 1000 });
      await up.connect(); await up.cwd('MD:');
      const payload = Buffer.from('/PROG  UPTEST\n/MN\n   1:  R[1]=1 ;\n/POS\n/END\n', 'latin1');
      await up.store('UPTEST.LS', payload);
      const back = await up.retrieve('UPTEST.LS');
      check(mock.uploads.get('UPTEST.LS')?.equals(payload) === true && back.equals(payload), `STOR lands the bytes on the device and RETR reads them back (${back.length} bytes)`);
      let refused = '';
      try { await up.store('ENTERZON.LS', payload); } catch (e: any) { refused = e.message; }
      const afterRefusal = await up.retrieve('UPTEST.LS');
      // a STOR the controller is slow to complete: the old code waited only the flat control
      // timeout (1 s here) for the compile's 226 and timed out - store must use its scaled one.
      // SLOWSTORE.LS holds the 226 back 1.2 s, past the flat timeout and far inside the scaled.
      const bigPayload = Buffer.from('/PROG  BIGUPLOAD\n/ATTR\nLINE_COUNT\t= 200;\n/MN\n' + '   1:  R[1]=1 ;\n'.repeat(200) + '/POS\n/END\n', 'latin1');
      await up.store('SLOWSTORE.LS', bigPayload);
      const bigBack = await up.retrieve('SLOWSTORE.LS');
      await up.quit();
      check(/550/.test(refused) && afterRefusal.equals(payload), `a refused STOR (program running) surfaces the controller's 550 and the session is still in step: ${refused}`);
      check(mock.uploads.get('SLOWSTORE.LS')?.equals(bigPayload) === true && bigBack.equals(bigPayload), `a slow STOR (compile reply past the flat control timeout) still lands (${bigBack.length} bytes)`);
    } catch (e: any) { check(false, `mock robot round trip failed: ${e?.stack ?? e}`); }
    finally { await mock.close(); }
  })();
} else console.log('  (no curpos.dg found; live parser tests skipped)');

// ---------- Teaching a position (text surgery over the whole corpus) ----------
{
  // The identity property: feeding a taught position its own values back must produce
  // ZERO edits. That is what proves the formatter reproduces FANUC's own bytes — the
  // corpus mixes `.000`, `0.000` and `0.00` inside single files, so a re-emitter that
  // "normalised" anything would rewrite points nobody touched.
  let identical = 0, blocks = 0;
  for (const f of ls) {
    const text = fs.readFileSync(f, 'latin1');
    if (!/^\/PROG\b/m.test(text)) continue;
    const prog = parseTp(text);
    for (const p of prog.positions) {
      const g = p.groups[0];
      if (!g || g.kind === 'unknown') continue;
      const values: Record<string, number> = {};
      for (const [k, v] of Object.entries(g.values)) values[k] = v.value;
      if (!Object.keys(values).length) continue;
      blocks++;
      const plan = planTeach(text, p.index, { kind: g.kind, uf: g.uf, ut: g.ut, config: g.config, values, origin: 'itself' });
      if (!plan) { check(false, `teach: P[${p.index}] not found in ${path.basename(f)}`); continue; }
      if (plan.edits.length || plan.blockers.length) {
        check(false, `teach identity ${path.basename(f)} P[${p.index}]: ${plan.edits.length} edit(s) ${JSON.stringify(plan.edits)} blockers=${plan.blockers.join(' | ')}`);
      } else identical++;
    }
  }
  // CI has no controller backups; only a local run must cover the corpus.
  if (!process.env.CI) check(blocks > 40, `teach identity covered only ${blocks} positions`);
  console.log(`  teach: ${identical}/${blocks} taught positions re-teach to byte-identical text`);

  // A real edit: move one axis, then check the column, the width and the neighbours.
  const cart = [
    '/PROG  T', '/MN', '   1:  J P[1] 100% FINE ;', '/POS',
    'P[1]{', '   GP1:', "\tUF : 12, UT : 2,\t\tCONFIG : 'N U T, 0, 0, 0',",
    '\tX =   261.855  mm,\tY =   235.485  mm,\tZ =  1499.917  mm,',
    '\tW =   175.511 deg,\tP =     -.098 deg,\tR =   -90.045 deg,',
    '\tE1=  7085.445  mm', '};', '/END', '',
  ].join('\n');
  const src = {
    kind: 'cartesian' as const, uf: 12, ut: 2, config: 'N U T, 0, 0, 0', origin: 'test',
    values: { X: 261.855, Y: 235.485, Z: 1499.917, W: 175.511, P: -0.098, R: -90.045, E1: 7085.445 },
  };
  const one = planTeach(cart, 1, { ...src, values: { ...src.values, X: 262.855 } })!;
  check(one.edits.length === 1 && one.changes.length === 1 && one.changes[0].axis === 'X' && Math.abs(one.changes[0].delta - 1) < 1e-9, `teach one axis: ${JSON.stringify(one.changes)}`);
  check(one.changes[0].unit === 'mm' && !one.blockers.length, `teach unit/blockers: ${JSON.stringify(one)}`);
  const after = applyTeachEdits(cart, one.edits);
  check(after.split('\n')[7] === '\tX =   262.855  mm,\tY =   235.485  mm,\tZ =  1499.917  mm,', `teach keeps the column: ${JSON.stringify(after.split('\n')[7])}`);
  check(after.split('\n').filter((l, i) => l !== cart.split('\n')[i]).length === 1, 'teach touches exactly one line');
  const reparsed = parseTp(after).positions[0].groups[0];
  check(reparsed.values.X.value === 262.855 && reparsed.values.E1.value === 7085.445 && reparsed.uf === 12, `teach reparse: ${JSON.stringify(reparsed.values)}`);
  check(!planTeach(cart, 1, src)!.edits.length, 'teaching the same values back is a no-op');

  // Leading-zero style comes from the token being replaced, both ways round.
  const styled = applyTeachEdits(cart, planTeach(cart, 1, { ...src, values: { ...src.values, P: -0.5, W: 0.25 } })!.edits);
  check(styled.includes('P =     -.500 deg') && styled.includes('W =      .250 deg'), `teach leading zero dropped: ${styled.split('\n')[8]}`);
  const zeroStyle = cart.replace('P =     -.098 deg', 'P =    -0.098 deg');
  const styledZero = applyTeachEdits(zeroStyle, planTeach(zeroStyle, 1, { ...src, values: { ...src.values, P: -0.5 } })!.edits);
  check(styledZero.includes('P =    -0.500 deg'), `teach keeps a written leading zero: ${styledZero.split('\n')[8]}`);

  // Refusals. Each of these is a way to write a position that looks perfectly valid and
  // is somewhere the robot has never been.
  const wrongUf = planTeach(cart, 1, { ...src, uf: 1 })!;
  check(wrongUf.blockers.length === 1 && /user frame 1/.test(wrongUf.blockers[0]), `teach UF blocker: ${JSON.stringify(wrongUf.blockers)}`);
  check(planTeach(cart, 1, { ...src, ut: 9 })!.blockers.some(b => /tool frame 9/.test(b)), 'teach UT blocker');
  const retarget = planTeach(cart, 1, { ...src, uf: 1, ut: 3 }, { retargetFrames: true })!;
  check(!retarget.blockers.length && applyTeachEdits(cart, retarget.edits).includes('UF : 1, UT : 3,'), `teach retarget: ${JSON.stringify(retarget.edits)}`);
  const asJoint = planTeach(cart, 1, { kind: 'joint' as const, uf: 12, ut: 2, origin: 'test', values: { J1: 0, J2: 0, J3: 0, J4: 0, J5: 0, J6: 0 } })!;
  check(asJoint.blockers.some(b => /kinematics/.test(b)), `teach representation blocker: ${JSON.stringify(asJoint.blockers)}`);
  const noRail = planTeach(cart, 1, { ...src, values: { X: 1, Y: 2, Z: 3, W: 4, P: 5, R: 6 } })!;
  check(noRail.blockers.some(b => /no value for E1/.test(b)), `teach missing-axis blocker: ${JSON.stringify(noRail.blockers)}`);
  const cfgMoved = planTeach(cart, 1, { ...src, config: 'N D B, 0, 0, 0', values: { ...src.values, X: 300 } })!;
  check(cfgMoved.configChange?.to === 'N D B, 0, 0, 0' && applyTeachEdits(cart, cfgMoved.edits).includes("CONFIG : 'N D B, 0, 0, 0'"), `teach config rewrite: ${JSON.stringify(cfgMoved.configChange)}`);

  // Joint-taught points stay joint-taught.
  const jnt = [
    '/PROG  T', '/MN', '   1:  J P[1] 100% FINE ;', '/POS',
    'P[1:"AGFS"]{', '   GP1:', '\tUF : 2, UT : 6,\t',
    '\tJ1=    -1.898 deg,\tJ2=     5.390 deg,\tJ3=   -49.094 deg,',
    '\tJ4=  -174.167 deg,\tJ5=   -33.477 deg,\tJ6=    85.159 deg,',
    '\tE1=  4479.142  mm', '};', '/END', '',
  ].join('\n');
  const jvals = { J1: -1.898, J2: 5.39, J3: -49.094, J4: -174.167, J5: -33.477, J6: 85.159, E1: 4479.142 };
  const jplan = planTeach(jnt, 1, { kind: 'joint' as const, ut: 6, origin: 'test', values: jvals })!;
  check(jplan.target.kind === 'joint' && !jplan.edits.length && !jplan.blockers.length, `teach joint identity: ${JSON.stringify(jplan)}`);
  const jmoved = applyTeachEdits(jnt, planTeach(jnt, 1, { kind: 'joint' as const, ut: 6, origin: 'test', values: { ...jvals, J6: 90 } })!.edits);
  check(jmoved.includes('J6=    90.000 deg'), `teach joint move: ${jmoved.split('\n')[8]}`);

  // CURPOS.DG → a teach source, including the world/user-frame choice that UF 0 implies.
  if (backupDir && isRefBackup(backupDir)) {
    const cp = parseCurPos(fs.readFileSync(path.join(backupDir, 'curpos.dg'), 'latin1'))!;
    const fromUf = sourceFromCurrentPosition(cp, 'cartesian', 1)!;
    check(fromUf.uf === 1 && fromUf.ut === 1 && fromUf.values.X === -156.83 && fromUf.values.E1 === 100 && fromUf.config === 'N U T, 0, 0, 0', `curpos → cartesian: ${JSON.stringify(fromUf)}`);
    const fromWorld = sourceFromCurrentPosition(cp, 'cartesian', 0)!;
    check(fromWorld.uf === 0 && fromWorld.values.Y === -1270.07, `curpos → world: ${JSON.stringify(fromWorld)}`);
    const fromJoint = sourceFromCurrentPosition(cp, 'joint', 2)!;
    check(fromJoint.kind === 'joint' && fromJoint.uf === undefined && fromJoint.values.J1 === -101.43 && fromJoint.values.E1 === 100, `curpos → joint: ${JSON.stringify(fromJoint)}`);
    // the frame guard, with real numbers on both sides: the robot is in UF 1, the point is UF 12
    check(planTeach(cart, 1, fromUf)!.blockers.some(b => /user frame 1\b/.test(b)), 'a UF 1 reading is refused into a UF 12 point');
  }

  // Recording a new point.
  check(nextFreePositionIndex([1, 2, 4]) === 3 && nextFreePositionIndex([]) === 1 && nextFreePositionIndex([1, 2, 3]) === 4, 'next free position index');
  const bounds = posSectionBounds(cart)!;
  check(bounds.pos === 3 && bounds.end === 11, `pos section bounds: ${JSON.stringify(bounds)}`);
  const block = buildPositionBlock(cart, 7, src, 'NEW PT');
  const withNew = cart.split('\n').flatMap((l, i) => (i === bounds.end ? [block, l] : [l])).join('\n');
  const np = parseTp(withNew).positions.find(p => p.index === 7)!;
  check(!!np && np.comment === 'NEW PT' && np.groups[0].uf === 12 && np.groups[0].ut === 2 && np.groups[0].kind === 'cartesian', `built block header: ${JSON.stringify(np?.groups[0])}`);
  check(np.groups[0].values.X.value === 261.855 && np.groups[0].values.E1.value === 7085.445, `built block values: ${JSON.stringify(np.groups[0].values)}`);
  check(!planTeach(withNew, 7, src)!.edits.length, 'a freshly built block re-teaches to itself with no edits');
  const jblock = buildPositionBlock(jnt, 2, { kind: 'joint', ut: 6, uf: 2, origin: 'test', values: jvals });
  const jWithNew = jnt.split('\n').flatMap((l, i) => (i === posSectionBounds(jnt)!.end ? [jblock, l] : [l])).join('\n');
  check(parseTp(jWithNew).positions.find(p => p.index === 2)?.groups[0].kind === 'joint', `built joint block: ${JSON.stringify(jblock)}`);
}

// ---------- Offsetting positions, and the refactors ----------
{
  const prog1 = [
    '/PROG  T', '/ATTR', 'LINE_COUNT\t= 3;', '/MN',
    '   1:  J P[1] 100% FINE ;', '   2:L P[2] 500mm/sec CNT100 ;', '   3:  R[5:Count]=R[5:Count]+1 ;',
    '/POS',
    'P[1]{', '   GP1:', "\tUF : 1, UT : 1,\t\tCONFIG : 'N U T, 0, 0, 0',",
    '\tX =   100.000  mm,\tY =   200.000  mm,\tZ =   300.000  mm,',
    '\tW =     0.000 deg,\tP =     0.000 deg,\tR =     0.000 deg,',
    '\tE1=  1000.000  mm', '};',
    'P[2]{', '   GP1:', "\tUF : 1, UT : 1,\t\tCONFIG : 'N U T, 0, 0, 0',",
    '\tX =   100.200  mm,\tY =   200.000  mm,\tZ =   300.000  mm,',
    '\tW =     0.000 deg,\tP =     0.000 deg,\tR =     0.000 deg,',
    '\tE1=  1000.000  mm', '};',
    '/END', '',
  ].join('\n');

  // Offsetting is the teach surgery with arithmetic instead of a reading: same column,
  // same formatting, and only the axes that actually move.
  const off = planOffset(prog1, 1, { X: 3, Z: -1.5 })!;
  check(off.edits.length === 2 && !off.blockers.length, `offset edits: ${JSON.stringify(off.changes)}`);
  const offText = applyTeachEdits(prog1, off.edits);
  check(offText.includes('X =   103.000  mm') && offText.includes('Z =   298.500  mm'), `offset applied: ${offText.split('\n')[11]}`);
  check(offText.includes('Y =   200.000  mm') && offText.includes('E1=  1000.000  mm'), 'offset leaves untouched axes byte-identical');
  check(!planOffset(prog1, 1, { X: 0, Y: 0 })!.edits.length, 'an offset of zero changes nothing');
  check(planOffset(prog1, 1, { Q: 5 })!.warnings.some(w => /no Q to offset/.test(w)), 'offset names an axis the point does not have');

  // A cartesian offset on a joint-taught point is refused, not converted.
  const jointProg = prog1.replace("\tUF : 1, UT : 1,\t\tCONFIG : 'N U T, 0, 0, 0',\n\tX =   100.000  mm,\tY =   200.000  mm,\tZ =   300.000  mm,\n\tW =     0.000 deg,\tP =     0.000 deg,\tR =     0.000 deg,",
    '\tUF : 1, UT : 1,\t\n\tJ1=     0.000 deg,\tJ2=     0.000 deg,\tJ3=     0.000 deg,\n\tJ4=     0.000 deg,\tJ5=     0.000 deg,\tJ6=     0.000 deg,');
  check(planOffset(jointProg, 1, { X: 3 })!.blockers.some(b => /kinematics/.test(b)), 'cartesian offset onto a joint point is refused');

  // Typed offsets, in the shapes people actually type.
  check(JSON.stringify(parseAxisOffsets('X=3 Y=-1.5')) === JSON.stringify({ X: 3, Y: -1.5 }), 'parse "X=3 Y=-1.5"');
  check(JSON.stringify(parseAxisOffsets('x 3, y -1.5')) === JSON.stringify({ X: 3, Y: -1.5 }), 'parse "x 3, y -1.5"');
  check(JSON.stringify(parseAxisOffsets('3 0 -1.5')) === JSON.stringify({ X: 3, Y: 0, Z: -1.5 }), 'parse bare "3 0 -1.5" as X Y Z');
  check(JSON.stringify(parseAxisOffsets('Z10')) === JSON.stringify({ Z: 10 }), 'parse "Z10"');
  check(JSON.stringify(parseAxisOffsets('E1=250')) === JSON.stringify({ E1: 250 }), 'parse "E1=250"');
  check(parseAxisOffsets('') === undefined && parseAxisOffsets('sideways a bit') === undefined && parseAxisOffsets('1 2 3 4') === undefined,
    'unreadable offsets are refused rather than guessed');

  // Distance between two points, and the refusal to compare across frames.
  const d = positionDistance(prog1, 1, 2);
  check(d !== undefined && Math.abs(d - 0.2) < 1e-9, `position distance: ${d}`);
  const mixedFrame = prog1.replace('P[2]{\n   GP1:\n\tUF : 1, UT : 1,', 'P[2]{\n   GP1:\n\tUF : 3, UT : 1,');
  check(positionDistance(mixedFrame, 1, 2) === undefined, 'distance across different user frames is refused');

  // Renumbering a register keeps its comment and counts every use.
  const remap = planRemap(prog1, 'R', 5, 105);
  check(remap.count === 2 && !remap.collision, `remap count: ${JSON.stringify(remap)}`);
  const remapped = applyTeachEdits(prog1, remap.edits.map(e => ({ ...e })));
  check(remapped.includes('R[105:Count]=R[105:Count]+1'), `remap applied: ${remapped.split('\n')[6]}`);
  check(planRemap(prog1, 'R', 5, 5).collision, 'remapping onto a number already in use is reported');

  // ---- extract ----
  const host = [
    '/PROG  HOST', '/ATTR', 'LINE_COUNT\t= 6;', 'DEFAULT_GROUP\t= 1,*,*,*,*;', '/MN',
    '   1:  !start ;', '   2:  J P[1] 100% FINE ;', '   3:  LBL[10] ;', '   4:  J P[2] 100% FINE ;',
    '   5:  JMP LBL[10] ;', '   6:  J P[1] 100% FINE ;',
    '/POS',
    'P[1]{', '   GP1:', "\tUF : 1, UT : 1,\t\tCONFIG : 'N U T, 0, 0, 0',",
    '\tX =   100.000  mm,\tY =   200.000  mm,\tZ =   300.000  mm,',
    '\tW =     0.000 deg,\tP =     0.000 deg,\tR =     0.000 deg', '};',
    'P[2]{', '   GP1:', "\tUF : 1, UT : 1,\t\tCONFIG : 'N U T, 0, 0, 0',",
    '\tX =   500.000  mm,\tY =   600.000  mm,\tZ =   700.000  mm,',
    '\tW =     0.000 deg,\tP =     0.000 deg,\tR =     0.000 deg', '};',
    '/END', '',
  ].join('\n');
  const hostLines = host.split('\n');
  const lineOf = (n: number) => hostLines.findIndex(l => new RegExp(`^\\s*${n}:`).test(l));

  // lines 3-5 are a self-contained loop: LBL[10] and the JMP that reaches it
  const ex = planExtract(host, lineOf(3), lineOf(5), 'SUBLOOP');
  check(!ex.blockers.length, `extract blockers: ${ex.blockers.join(' | ')}`);
  check(ex.movedLines === 3 && ex.positionMap.get(2) === 1, `extract moved ${ex.movedLines}, map ${JSON.stringify([...ex.positionMap])}`);
  const exProg = parseTp(ex.programText);
  check(exProg.header.name === 'SUBLOOP' && exProg.numberedLineCount === 3, `extracted program: ${exProg.header.name} ${exProg.numberedLineCount} lines`);
  check(exProg.positions.length === 1 && exProg.positions[0].index === 1 && exProg.positions[0].groups[0].values.X.value === 500,
    `extracted position renumbered to P[1] with its own values: ${JSON.stringify(exProg.positions[0]?.groups[0]?.values)}`);
  check(exProg.labels.length === 1 && exProg.jumps.length === 1, 'the loop went across whole');
  const hostAfter = parseTp(applyLineChanges(host, ex.lineChanges));
  check(hostAfter.calls.some(c => c.name.toUpperCase() === 'SUBLOOP'), `host calls the new program: ${JSON.stringify(hostAfter.calls.map(c => c.name))}`);
  check(!hostAfter.positions.some(p => p.index === 2), 'the moved position left the host');
  check(hostAfter.positions.some(p => p.index === 1), 'a position still used by the host stayed');

  // the second half of a circular move goes with the move; the extracted program is
  // numbered right and the continuation stays unnumbered, terminator on its last line
  const circ = host.replace('   4:  J P[2] 100% FINE ;', '   4:C P[2] \n    :  P[1] 500mm/sec FINE ;');
  const circLines = circ.split('\n');
  const cl = (n: number) => circLines.findIndex(l => new RegExp(`^\\s*${n}:`).test(l));
  const exc = planExtract(circ, cl(3), cl(5) + 0, 'CIRC');
  check(!exc.blockers.length, `extract with continuation: ${exc.blockers.join(' | ')}`);
  const excProg = parseTp(exc.programText);
  check(excProg.lines.some(l => l.kind === 'continuation' && l.motion?.target?.index !== undefined) && excProg.numberedLineCount === 3, `continuation carried across: ${JSON.stringify(excProg.lines.filter(l => l.num !== undefined || l.kind === 'continuation').map(l => l.raw))}`);
  check(renumber(exc.programText, { width: 4, autoSemicolon: true, updateLineCount: true }).edits.length === 0, 'the extracted program needs no renumbering');
  // P[2] (only used inside) becomes P[1]; the shared P[1] is copied as P[2] - and the two must not swap back
  check(/C P\[1\] ?\n    :  P\[2\] 500mm\/sec FINE ;/.test(exc.programText.replace(/\r/g, '')), `circular move kept its shape and its points: ${JSON.stringify(exc.programText.split('\n').filter(l => /C P\[|^\s*:/.test(l)))}`);
  check(excProg.positions.find(p => p.index === 1)?.groups[0].values.X.value === 500 && excProg.positions.find(p => p.index === 2)?.groups[0].values.X.value === 100, `each moved point kept its own data: ${JSON.stringify(excProg.positions.map(p => [p.index, p.groups[0].values.X.value]))}`);

  // a selection may not cut a circular move at its boundary: neither stop short of the
  // continuation nor start on it
  const cut = planExtract(circ, cl(3), cl(4), 'CUT');
  check(cut.blockers.some(b => /continues the last selected line/.test(b)), `extract refuses to stop before a continuation: ${cut.blockers.join(' | ')}`);
  const cut2 = planExtract(circ, cl(4) + 1, cl(5), 'CUT2');
  check(cut2.blockers.some(b => /continues the line above/.test(b)), `extract refuses to start on a continuation: ${cut2.blockers.join(' | ')}`);

  // a jump that leaves the selection cannot be extracted
  const bad = planExtract(host, lineOf(4), lineOf(5), 'NOPE');
  check(bad.blockers.some(b => /LBL\[10\]/.test(b)), `extract refuses a jump out of the selection: ${bad.blockers.join(' | ')}`);
  const bad2 = planExtract(host, lineOf(1), lineOf(4), 'NOPE2');
  check(bad2.blockers.some(b => /jumps to it from outside/.test(b)), `extract refuses a jump INTO the selection: ${bad2.blockers.join(' | ')}`);

  // ---- inline ----
  const callee = [
    '/PROG  SUB', '/ATTR', 'LINE_COUNT\t= 2;', 'DEFAULT_GROUP\t= 1,*,*,*,*;', '/MN',
    '   1:  LBL[10] ;', '   2:  J P[1] 100% FINE ;',
    '/POS',
    'P[1]{', '   GP1:', "\tUF : 1, UT : 1,\t\tCONFIG : 'N U T, 0, 0, 0',",
    '\tX =   900.000  mm,\tY =     0.000  mm,\tZ =     0.000  mm,',
    '\tW =     0.000 deg,\tP =     0.000 deg,\tR =     0.000 deg', '};',
    '/END', '',
  ].join('\n');
  const caller = host.replace('   6:  J P[1] 100% FINE ;', '   6:  CALL SUB ;');
  const callLine = caller.split('\n').findIndex(l => /CALL SUB/.test(l));
  const inl = planInline(caller, callLine, callee, 'SUB');
  check(!inl.blockers.length, `inline blockers: ${inl.blockers.join(' | ')}`);
  // the host already uses LBL[10] and P[1..2], so the callee's must move out of the way
  check(inl.labelMap.get(10) === 20 && inl.positionMap.get(1) === 3, `inline renumbering: LBL ${JSON.stringify([...inl.labelMap])} P ${JSON.stringify([...inl.positionMap])}`);
  const inlined = parseTp(applyLineChanges(caller, inl.lineChanges));
  check(!inlined.calls.length, 'the CALL is gone');
  check(inlined.labels.filter(l => l.num === 10).length === 1, 'the host label was not duplicated');
  check(inlined.positions.some(p => p.index === 3 && p.groups[0].values.X.value === 900), `the callee position came across as P[3]: ${JSON.stringify(inlined.positions.map(p => p.index))}`);

  const withArgs = caller.replace('CALL SUB ;', 'CALL SUB(1) ;');
  check(planInline(withArgs, callLine, callee, 'SUB').blockers.some(b => /arguments/.test(b)), 'inlining a call with arguments is refused');

  // ---- beta list 2, item 8: combine programs in the order given ----
  {
    const a = ['/PROG  A', '/ATTR', 'DEFAULT_GROUP\t= 1,*,*,*,*;', '/MN', '   1:  !first ;', '   2:  LBL[1] ;', '   3:J P[1] 100% FINE ;', '   4:  JMP LBL[1] ;', '/POS', 'P[1]{', '   GP1:', '\tUF : 0, UT : 1,\t\tCONFIG : \'N U T, 0, 0, 0\',', '\tX =     1.0  mm,\tY =     2.0  mm,\tZ =     3.0  mm,', '\tW =     0.0 deg,\tP =     0.0 deg,\tR =     0.0 deg', '};', '/END', ''].join('\n');
    const b = ['/PROG  B', '/ATTR', 'DEFAULT_GROUP\t= 1,*,*,*,*;', '/MN', '   1:  LBL[1] ;', '   2:  --eg: a long one', '    :  carried on ;', '   3:L P[1] 500mm/sec CNT100 ;', '   4:L P[2] 500mm/sec FINE ;', '   5:  END ;', '/POS', 'P[1]{', '   GP1:', '\tUF : 0, UT : 1,\t\tCONFIG : \'N U T, 0, 0, 0\',', '\tX =    11.0  mm,\tY =    12.0  mm,\tZ =    13.0  mm,', '\tW =     0.0 deg,\tP =     0.0 deg,\tR =     0.0 deg', '};', 'P[2]{', '   GP1:', '\tUF : 0, UT : 1,\t\tCONFIG : \'N U T, 0, 0, 0\',', '\tX =    21.0  mm,\tY =    22.0  mm,\tZ =    23.0  mm,', '\tW =     0.0 deg,\tP =     0.0 deg,\tR =     0.0 deg', '};', '/END', ''].join('\n');
    const res = planCombine([{ name: 'A', text: a }, { name: 'B', text: b }], 'both');
    const out = parseTp(res.programText);
    const mn = res.programText.split('\n').filter(l => /^\s*\d+:/.test(l) || /^\s*:/.test(l));
    check(!res.blockers.length && out.header.name === 'BOTH' && res.lineCount === 11 && out.numberedLineCount === 11, `combine: BOTH with 11 numbered lines (${res.lineCount}/${out.numberedLineCount}) ${res.blockers.join(' ')}`);
    check(mn[0].includes('!--- A ---') && mn.findIndex(l => /!--- B ---/.test(l)) === 5, `combine: a banner where each program starts:\n${mn.join('\n')}`);
    check(/LBL\[10\]/.test(mn[2]) && /JMP LBL\[10\]/.test(mn[4]) && /LBL\[20\]/.test(mn[6]), 'combine: A\'s LBL[1] becomes 10 and its JMP follows; B\'s LBL[1] becomes 20');
    check(/J P\[1\]/.test(mn[3]) && /L P\[2\]/.test(mn[9]) && /L P\[3\]/.test(mn[10]), 'combine: positions carry on from the last index, references follow');
    check(out.positions.map(p => p.index).join(',') === '1,2,3' && /X =    21\.0/.test(res.programText.split('P[3]{')[1] ?? ''), 'combine: /POS holds 1..3 with B\'s values byte-for-byte');
    check(/--eg: a long one/.test(mn[7]) && /^\s*:\s+carried on ;/.test(mn[8]), 'combine: an extended comment keeps its continuation');
    check(res.warnings.some(w => /B contains END/.test(w)), 'combine: END inside a part is warned about');
    check(res.parts.map(p => `${p.name}:${p.lines}/${p.positions}/${p.labels}`).join(' ') === 'A:4/1/1 B:5/2/1', `combine: per-part summary ${res.parts.map(p => `${p.name}:${p.lines}/${p.positions}/${p.labels}`).join(' ')}`);
    check(planCombine([{ name: 'A', text: a }], 'x').blockers.length === 1, 'combine: one program is not a combination');
    const b2 = b.replace('DEFAULT_GROUP\t= 1,*,*,*,*;', 'DEFAULT_GROUP\t= 1,1,*,*,*;');
    check(planCombine([{ name: 'A', text: a }, { name: 'B', text: b2 }], 'x').blockers.some(x => /DEFAULT_GROUP/.test(x)), 'combine: different group masks are refused');
    const rev = planCombine([{ name: 'B', text: b }, { name: 'A', text: a }], 'rev');
    const rmn = rev.programText.split('\n').filter(l => /^\s*\d+:/.test(l));
    check(/!--- B ---/.test(rmn[0]) && /!--- A ---/.test(rmn[6]) && /J P\[3\]/.test(rmn[9]), 'combine: the order given is the order in the result');
  }
}

// ---------- KAREL declarations the parser used to miss ----------
{
  const oneLine = ['PROGRAM p', 'VAR q:XYZWPR', 'BEGIN', '  q = q', 'END p', ''].join('\n');
  const kp = parseKarel(oneLine);
  check(kp.symbols.some(x => x.upper === 'Q' && x.kind === 'variable'), `"VAR q:XYZWPR" on one line declares q: ${JSON.stringify(kp.symbols.map(x => x.upper))}`);
  check(!kp.symbols.some(x => /\s/.test(x.name)), 'no symbol is named "VAR q"');

  const multi = ['PROGRAM p', 'VAR', '  first,', '  second   : INTEGER', 'BEGIN', '  first = second', 'END p', ''].join('\n');
  const km = parseKarel(multi);
  check(km.symbols.some(x => x.upper === 'FIRST') && km.symbols.some(x => x.upper === 'SECOND'), `multi-line name list: ${JSON.stringify(km.symbols.map(x => x.upper))}`);
  check(km.symbols.find(x => x.upper === 'FIRST')?.line === 2, 'each name keeps its own line');

  // the undeclared check: it must find the real thing and stay quiet about everything else
  const isB = (u: string) => KAREL_BUILTINS.has(u) || KAREL_PREDEFINED.has(u);
  check(findUndeclared(km, isB).length === 0, `nothing undeclared in a clean program: ${JSON.stringify(findUndeclared(km, isB).map(r => r.upper))}`);

  // ---- beta list 2, item 10: the KAREL lint ----
  {
    const lint = (src: string[]) => lintKarel(parseKarel(src.join('\n')));
    const codes = (src: string[]) => lint(src).map(d => d.code.replace('karel.lint.', '')).sort().join(',');
    const clean = ['PROGRAM good', '%NOLOCKGROUP', '%COMMENT = \'sixteen chars ok\'', 'CONST', '  limit = 10', 'VAR', '  n : INTEGER', '  s : STRING[254]',
      'ROUTINE twice(a : INTEGER) : INTEGER', 'BEGIN', '  RETURN(a * 2)', 'END twice',
      'ROUTINE say(msg : STRING)', 'BEGIN', '  WRITE TPDISPLAY(msg, CR)', '  RETURN', 'END say',
      'BEGIN', '  n = twice(limit)', '  IF n <> 20 THEN', '    say(\'no\')', '  ELSE', '    say(\'yes, a (paren) and, a comma\')', '  ENDIF', 'END good'];
    check(codes(clean) === '', `a clean program lints clean: ${JSON.stringify(lint(clean).map(d => d.message))}`);
    check(codes(['PROGRAM c', '%NOLOCKGROUP', 'VAR', '  a, b : INTEGER', 'BEGIN', '  IF a == b THEN', '  ENDIF', '  IF (a != b) && (b > 1) || FALSE THEN', '  ENDIF', '  a := 1', '  a++', '  // comment', 'END c']) === 'cStyle,cStyle,cStyle,cStyle,cStyle,cStyle,cStyle', `C-isms are each named: ${codes(['PROGRAM c', 'VAR', '  a, b : INTEGER', 'BEGIN', '  IF a == b THEN', '  ENDIF', '  IF (a != b) && (b > 1) || FALSE THEN', '  ENDIF', '  a := 1', '  a++', '  // comment', 'END c'])}`);
    check(codes(['PROGRAM e', '%NOLOCKGROUP', 'VAR', '  a : INTEGER', 'BEGIN', '  IF a = 1 THEN', '  ELSE IF a = 2 THEN', '  ENDIF', '  ENDIF', '  IF a = 3 THEN', '  ELSEIF a = 4 THEN', '  ENDIF', 'END e']) === 'elseif,elseif', 'ELSE IF and ELSEIF are named');
    check(codes(['PROGRAM d', '%NOLOCKGROUP', 'BEGIN', '  VAR', '  x : INTEGER', 'END d']) === 'declAfterBegin', 'VAR after BEGIN');
    check(codes(['PROGRAM p', 'VAR', '  x : INTEGER', '%NOLOCKGROUP', 'BEGIN', '  x = 1', '%NOPAUSE = ERROR', 'END p']) === 'directivePlacement,directivePlacement', 'a directive after the declarations warns, inside the body errors');
    check(codes(['PROGRAM p', '%NOLOCKGROUP', 'VAR', '  x : INTEGER', '%INCLUDE klevkeys', 'BEGIN', '  x = 1', 'END p']) === '', '%INCLUDE among declarations is fine');
    check(codes(['PROGRAM p', '%NOLOCKGROUP', '%COMMENT = \'this comment is far too long\'', 'BEGIN', 'END p']) === 'commentLength', '%COMMENT over 16');
    check(codes(['PROGRAM p', '%NOLOCKGROUP', 'VAR', '  s : STRING[300]', '  t : STRING[0]', '  n : INTEGER', 'BEGIN', '  n = 3000000000', '  n = 2147483647', '  s = \'' + 'x'.repeat(255) + '\'', 'END p']) === 'integerRange,stringLength,stringLength,stringLength', `limits: ${codes(['PROGRAM p', '%NOLOCKGROUP', 'VAR', '  s : STRING[300]', '  t : STRING[0]', '  n : INTEGER', 'BEGIN', '  n = 3000000000', '  n = 2147483647', '  s = \'' + 'x'.repeat(255) + '\'', 'END p'])}`);
    check(codes(['PROGRAM p', '%NOLOCKGROUP', 'VAR', '  delay : INTEGER', '  n : INTEGER', '  n : REAL', 'BEGIN', 'END p']) === 'duplicate,reservedName', `a reserved word as a name, and a name declared twice: ${codes(['PROGRAM p', '%NOLOCKGROUP', 'VAR', '  delay : INTEGER', '  n : INTEGER', '  n : REAL', 'BEGIN', 'END p'])}`);
    check(codes(['PROGRAM p', '%NOLOCKGROUP', 'CONST', '  top = 5', 'VAR', '  n : INTEGER', 'BEGIN', '  top = 6', '  IF top = 5 THEN', '    n = top', '  ENDIF', 'END p']) === 'assignConst', 'assignment to a constant, but not a comparison with it');
    check(codes(['PROGRAM m', '%NOLOCKGROUP', 'VAR', '  home : JOINTPOS', 'BEGIN', '  MOVE TO home', 'END m']) === 'lockGroup', 'MOVE under %NOLOCKGROUP is an error');
    check(lint(['PROGRAM m', 'VAR', '  n : INTEGER', 'BEGIN', '  n = 1', 'END m']).map(d => `${d.code.replace('karel.lint.', '')}:${d.severity}`).join(',') === 'lockGroup:hint', 'no motion and no %NOLOCKGROUP is a hint to add it');
    check(codes(['PROGRAM m', '%LOCKGROUP = 1', 'VAR', '  home : JOINTPOS', 'BEGIN', '  MOVE TO home', 'END m']) === '', 'motion with the group locked is fine');
    check(codes(['PROGRAM nb', '%NOLOCKGROUP', 'VAR', '  n : INTEGER']) !== '' && codes(['PROGRAM nb', '%NOLOCKGROUP', 'VAR', '  n : INTEGER']).includes('noBegin'), 'a program without BEGIN');
    check(lintKarel(parseKarel('-- just a fragment\nVAR\n  n : INTEGER\n')).length === 0, 'an include fragment (no PROGRAM) is not judged');
    check(codes(['PROGRAM p', '%NOLOCKGROUP', 'CONST', '  DIN = 1', '  ON = 1', '  OFF = 0', 'BEGIN', 'END p']) === '', 'predefined identifiers (ports, ON/OFF) may be redefined - a corpus program does');
    check(countArgs(stripCommentAndStrings('f(a, g(b, c), d[1, 2], \'x, y\')'), 2) === 4 && countArgs('f()', 2) === 0 && countArgs('f(a', 2) === undefined, `countArgs: nested calls, indexes and strings count once; unterminated is not judged (${countArgs(stripCommentAndStrings('f(a, g(b, c), d[1, 2], \'x, y\')'), 2)})`);
    const argSrc = ['PROGRAM p', '%NOLOCKGROUP', 'VAR', '  n : INTEGER', 'ROUTINE add(a : INTEGER; b : INTEGER) : INTEGER', 'BEGIN', '  RETURN(a + b)', 'END add', 'ROUTINE nothing', 'BEGIN', 'END nothing', 'BEGIN', '  n = add(1)', '  n = add(1, 2)', '  n = add(1, add(2, 3))', '  n = add(add(1, 2))', '  add', '  nothing', 'END p'];
    check(codes(argSrc) === 'argCount,argCount,argCount', `argCount findings: ${JSON.stringify(lint(argSrc).map(d => `${d.span.line + 1}:${d.message}`))}`);
    const retSrc = ['PROGRAM p', '%NOLOCKGROUP', 'ROUTINE f : INTEGER', 'BEGIN', '  RETURN', 'END f', 'ROUTINE g(x : INTEGER)', 'BEGIN', '  RETURN(1)', 'END g', 'ROUTINE h : INTEGER', 'BEGIN', 'END h', 'ROUTINE bare', 'BEGIN', '  RETURN(2)', 'END bare', 'BEGIN', '  g(1)', 'END p'];
    check(codes(retSrc) === 'returnValue,returnValue,returnValue,returnValue', `returnValue findings (a bare ROUTINE line is not judged - its parameters may be elsewhere): ${JSON.stringify(lint(retSrc).map(d => `${d.span.line + 1}:${d.message}`))}`);
    check(codes(['PROGRAM p', '%NOLOCKGROUP', 'ROUTINE ext(a : INTEGER) FROM other', 'ROUTINE two', 'BEGIN', 'END two', 'BEGIN', '  ext(1, 2)', '  two(1)', 'END p']) === '', 'an external (FROM) or bare declaration is not the truth about arguments, so calls to it are not judged');
    check(Object.values(LINT_CODES).every(c => c.startsWith('karel.lint.')), 'every lint code is namespaced');
  }
  const typo = ['PROGRAM p', 'VAR', '  counter : INTEGER', 'BEGIN', '  countre = 1', 'END p', ''].join('\n');
  check(findUndeclared(parseKarel(typo), isB).map(r => r.upper).join() === 'COUNTRE', 'a mistyped name is reported');
  const withInclude = ['PROGRAM p', '%INCLUDE other', 'BEGIN', '  whatever = 1', 'END p', ''].join('\n');
  check(findUndeclared(parseKarel(withInclude), isB).length === 0, 'a program with %INCLUDE is not judged at all');
  const noProgram = ['VAR', '  x : INTEGER', ''].join('\n');
  check(findUndeclared(parseKarel(noProgram), isB).length === 0, 'an include fragment with no PROGRAM is not judged');
  const labelled = ['PROGRAM p', 'BEGIN', '  GOTO done', 'done::', '  RETURN', 'END p', ''].join('\n');
  check(findUndeclared(parseKarel(labelled), isB).length === 0, 'GOTO labels are not undeclared variables');
  const builtinUse = ['PROGRAM p', 'VAR', '  s : STRING[20]', 'BEGIN', "  FORCE_SPMENU(TP_PANEL, SPI_TPUSER, 1)", '  WRITE(s)', 'END p', ''].join('\n');
  check(findUndeclared(parseKarel(builtinUse), isB).length === 0, `predefined screen constants are known: ${JSON.stringify(findUndeclared(parseKarel(builtinUse), isB).map(r => r.upper))}`);
}

// ---------- Flow: ELSE and ENDIF belong to a block ----------
{
  // The reference backup contains no IF ... THEN blocks at all, which is why this went
  // unnoticed: every ENDIF was silently dropped from the graph and no corpus file had one.
  const mk = (body: string[]) => ['/PROG  T', '/MN', ...body.map((b, i) => `${String(i + 1).padStart(4, ' ')}:  ${b} ;`), '/POS', '/END', ''].join('\n');
  const countIn = (g: ReturnType<typeof buildFlow>) => g.nodes.reduce((n, b) => n + b.lines.filter(x => x.kind !== 'comment').length, 0);

  const plain = parseTp(mk(['IF (R[1]=1) THEN', 'R[2]=1', 'ENDIF', 'R[3]=1']));
  check(countIn(buildFlow(plain)) === 4, `plain IF/ENDIF: every line in a block (${countIn(buildFlow(plain))}/4)`);

  // the shape that used to lose the ENDIF: the branch ends in something terminal
  for (const terminal of ['ABORT', 'END', 'JMP LBL[9]']) {
    const p = parseTp(mk(['IF (R[1]=1) THEN', terminal, 'ENDIF', 'LBL[9]', 'R[3]=1']));
    check(countIn(buildFlow(p)) === 5, `IF/${terminal}/ENDIF: every line in a block (${countIn(buildFlow(p))}/5)`);
  }
  const withElse = parseTp(mk(['IF (R[1]=1) THEN', 'ABORT', 'ELSE', 'R[2]=1', 'ENDIF', 'R[3]=1']));
  check(countIn(buildFlow(withElse)) === 6, `IF/ABORT/ELSE/ENDIF: every line in a block (${countIn(buildFlow(withElse))}/6)`);
  const trailing = parseTp(mk(['IF (R[1]=1) THEN', 'ABORT', 'ENDIF']));
  check(countIn(buildFlow(trailing)) === 3, `a trailing ENDIF still lands somewhere (${countIn(buildFlow(trailing))}/3)`);
}

// ---------- LINE_COUNT counts what the controller counts ----------
{
  // vmdata*.ls in the real tree has a bare " ;" where line 4 should be, and LINE_COUNT
  // still counts it. The parser used to count only lines that already carried a number,
  // which made it disagree with renumber() about the same file.
  const gap = ['/PROG  T', '/ATTR', 'LINE_COUNT\t= 5;', '/MN',
    '   1:  R[1]=1 ;', '   2:  R[2]=1 ;', '   3:  R[3]=1 ;', ' ;', '   5:  R[5]=1 ;', '/POS', '/END', ''].join('\n');
  const gp = parseTp(gap);
  check(gp.numberedLineCount === 5, `unnumbered line is still a line: ${gp.numberedLineCount}/5`);
  check(renumber(gap, { width: 4, autoSemicolon: true, updateLineCount: true }).lineCount === gp.numberedLineCount,
    'parser and renumber agree on the line count');
}

// ---------- Cross-reference findings from the index's access maps ----------
{
  const progs = [
    { name: 'A', dataAccess: new Map<string, 'w' | 'r'>([['DO:900', 'w'], ['R:10', 'r'], ['R:11', 'w']]) },
    { name: 'B', dataAccess: new Map<string, 'w' | 'r'>([['DO:900', 'w'], ['R:10', 'r']]) },
  ];
  const f = usageFindings(progs);
  check(f.get('DO:900')?.some(x => /written from 2 programs \(A, B\)/.test(x)), `multitask conflict: ${JSON.stringify(f.get('DO:900'))}`);
  check(f.get('R:10')?.some(x => /never written/.test(x)), `read-never-written: ${JSON.stringify(f.get('R:10'))}`);
  check(f.get('R:11')?.some(x => /never read/.test(x)), `written-never-read: ${JSON.stringify(f.get('R:11'))}`);
  const single = usageFindings([{ name: 'A', dataAccess: new Map<string, 'w' | 'r'>([['DO:900', 'w']]) }]);
  check(!single.get('DO:900')?.length, 'one writer is not a conflict');
}

// ---------- Frames: rigid-body maths, no kinematics ----------
{
  const near = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) < tol;
  const samePose = (a: any, b: any, tol = 1e-6) =>
    near(a.x, b.x, tol) && near(a.y, b.y, tol) && near(a.z, b.z, tol) &&
    near(a.w, b.w, tol) && near(a.p, b.p, tol) && near(a.r, b.r, tol);

  // A case small enough to work out by hand, so the convention is pinned by reasoning and
  // not only by the corpus below. UF is 100 mm along X and rotated 90 deg about Z; a point
  // 10 mm along that frame's X must land 10 mm along WORLD Y.
  const uf = { x: 100, y: 0, z: 0, w: 0, p: 0, r: 90 };
  const inUf = { x: 10, y: 0, z: 0, w: 0, p: 0, r: 0 };
  const inWorld = convertUserFrame(inUf, uf, IDENTITY);
  check(samePose(inWorld, { x: 100, y: 10, z: 0, w: 0, p: 0, r: 90 }, 1e-9),
    `hand-checked frame conversion: ${JSON.stringify(inWorld)}`);

  // and back again
  check(samePose(convertUserFrame(inWorld, IDENTITY, uf), inUf, 1e-9), 'converting back returns the original point');

  // Round trip through an awkward frame, including orientation.
  const odd = { x: -1234.567, y: 890.123, z: -45.6, w: 17.3, p: -88.1, r: 143.9 };
  const pt = { x: 55.5, y: -66.6, z: 77.7, w: -12.3, p: 4.5, r: 170.1 };
  const there = convertUserFrame(pt, odd, IDENTITY);
  const back = convertUserFrame(there, IDENTITY, odd);
  check(samePose(back, pt, 1e-6), `frame round trip: ${JSON.stringify(back)} vs ${JSON.stringify(pt)}`);
  check(!samePose(there, pt, 1e-3), 'the conversion actually moved the numbers');

  // XYZWPR -> matrix -> XYZWPR must be lossless for ordinary poses.
  for (const v of [pt, odd, { x: 0, y: 0, z: 0, w: 0, p: 0, r: 0 }, { x: 1, y: 2, z: 3, w: 180, p: 0, r: -180 }]) {
    const rt = fromPose(toPose(v));
    check(near(rt.x, v.x, 1e-9) && near(rt.y, v.y, 1e-9) && near(rt.z, v.z, 1e-9), `pose round trip position: ${JSON.stringify(rt)}`);
    // angles may come back in an equivalent representation; compare the rotation, not the numbers
    const again = fromPose(toPose(rt));
    check(near(again.w, rt.w, 1e-9) && near(again.p, rt.p, 1e-9) && near(again.r, rt.r, 1e-9), `pose round trip is stable: ${JSON.stringify(again)}`);
  }

  // Gimbal lock: P = 90 deg makes W and R act on the same axis. The controller has the same
  // ambiguity; what matters is that a valid pose comes back rather than NaN.
  const gimbal = fromPose(toPose({ x: 0, y: 0, z: 0, w: 30, p: 90, r: 40 }));
  check(Number.isFinite(gimbal.w) && Number.isFinite(gimbal.p) && Number.isFinite(gimbal.r) && near(gimbal.p, 90, 1e-6),
    `gimbal lock resolves rather than producing NaN: ${JSON.stringify(gimbal)}`);

  // Tool conversion holds the ROBOT still, not the TCP: with the flange fixed, a longer tool
  // records a different point.
  const tool1 = { x: 0, y: 0, z: 100, w: 0, p: 0, r: 0 };
  const tool2 = { x: 0, y: 0, z: 150, w: 0, p: 0, r: 0 };
  const withT2 = convertToolFrame({ x: 0, y: 0, z: 500, w: 0, p: 0, r: 0 }, tool1, tool2);
  check(near(withT2.z, 550, 1e-9), `tool conversion moves the recorded point by the tool difference: ${JSON.stringify(withT2)}`);
  check(samePose(convertToolFrame(withT2, tool2, tool1), { x: 0, y: 0, z: 500, w: 0, p: 0, r: 0 }, 1e-9), 'tool conversion is reversible');

  // ---- sysframe.va, against the real file (the exact values are S002R01's) ----
  if (backupDir && isRefBackup(backupDir)) {
    const sysframePath = path.join(backupDir, 'sysframe.va');
    if (fs.existsSync(sysframePath)) {
      const tbl = parseSysFrames(fs.readFileSync(sysframePath, 'latin1'));
      check(tbl.frames.size >= 10 && tbl.tools.size >= 10, `sysframe.va: ${tbl.frames.size} frames, ${tbl.tools.size} tools`);
      const uf2 = tbl.frames.get(2);
      check(!!uf2 && Math.abs(uf2.x - 7703.524) < 1e-6 && Math.abs(uf2.r - -90.202) < 1e-6, `UF 2 read exactly: ${JSON.stringify(uf2)}`);
      const ut2 = tbl.tools.get(2);
      check(!!ut2 && Math.abs(ut2.x - 484.934) < 1e-6 && Math.abs(ut2.p - -90) < 1e-6, `UT 2 read exactly: ${JSON.stringify(ut2)}`);
      check(tbl.frames.get(1) !== undefined && Math.abs(tbl.frames.get(1)!.x) < 1e-9, 'UF 1 is the identity on this robot');
      // $MNUFRAMENUM must not be mistaken for $MNUFRAME
      check(!tbl.frames.has(0), 'no phantom frame 0 from the NUM variables');
    }
  }

  // ---- the convention, against real controller readings ----
  //
  // CURPOS.DG reports one physical pose twice - in the active user frame and in world - and
  // sysframe.va gives that frame. So world MUST equal UF o P_uf. This is the check that
  // makes the maths a measurement rather than an assumption; it is what ruled out the two
  // plausible alternative orderings (they miss by up to 5.5 metres on this same data).
  let verified = 0, worst = 0;
  for (const cp of files.filter(f => /curpos\.dg$/i.test(f))) {
    const dir = path.dirname(cp);
    const sfPath = path.join(dir, 'sysframe.va');
    if (!fs.existsSync(sfPath)) continue;
    const pos = parseCurPos(fs.readFileSync(cp, 'latin1'));
    if (!pos?.userFrame || !pos.world || pos.frameNo === undefined) continue;
    const uf = parseSysFrames(fs.readFileSync(sfPath, 'latin1')).frames.get(pos.frameNo);
    if (!uf) continue;
    // an identity frame proves nothing: world and user frame are then trivially equal
    if (Math.abs(uf.x) + Math.abs(uf.y) + Math.abs(uf.z) + Math.abs(uf.w) + Math.abs(uf.p) + Math.abs(uf.r) < 1e-6) continue;

    const p = pos.userFrame;
    const asWorld = convertUserFrame({ x: p.x, y: p.y, z: p.z, w: p.w, p: p.p, r: p.r }, uf, IDENTITY);
    const err = Math.hypot(asWorld.x - pos.world.x, asWorld.y - pos.world.y, asWorld.z - pos.world.z);
    worst = Math.max(worst, err);
    check(err < 0.05, `${path.basename(dir)} UF${pos.frameNo}: user frame -> world is ${err.toFixed(3)} mm out`);
    verified++;
  }
  console.log(`  frames: convention verified against ${verified} real non-identity reading(s), worst ${worst.toFixed(3)} mm`);
  if (!verified) console.log('  NOTE: no real non-identity CURPOS reading was available, so nothing on this machine measured the Rz.Ry.Rx convention live - it is held by the recorded real readings and the pinned case in issue5.test.ts.');

  // ---- real programs, real frames: convert to world and back ----
  //
  // The invariant is NUMERICAL, not byte-for-byte, and the difference is worth being precise
  // about. Converting away and back returns every value exactly, but the spelling of a zero
  // can change: FANUC writes it `.000`, `0.000` and `-.000`, `editFor` takes its style from
  // the token it is replacing, and on the way back that token is the world value (`7703.813`)
  // which carries no leading-zero style. A one-way conversion - the actual use - is unaffected.
  {
    let rtChecked = 0, rtExact = 0, rtMoved = 0, rtWorst = 0;
    for (const f of ls) {
      const dir = path.dirname(f);
      const sfPath = path.join(dir, 'sysframe.va');
      if (!fs.existsSync(sfPath)) continue;
      const text = fs.readFileSync(f, 'latin1');
      if (!/^\/PROG\b/m.test(text)) continue;
      const frames = parseSysFrames(fs.readFileSync(sfPath, 'latin1')).frames;
      const prog = parseTp(text);

      for (const p of prog.positions) {
        const g = p.groups[0];
        if (!g || g.kind !== 'cartesian' || g.uf === undefined) continue;
        const from = frameOrIdentity(frames, g.uf);
        if (!from) continue;

        const out = planFrameShift(text, p.index, { fromUf: from, toUf: IDENTITY, toUfNumber: 0 });
        if (!out || out.blockers.length) continue;
        const asWorld = applyTeachEdits(text, out.edits);
        if (out.edits.length) rtMoved++;

        const back = planFrameShift(asWorld, p.index, { fromUf: IDENTITY, toUf: from, toUfNumber: g.uf });
        if (!back || back.blockers.length) continue;
        const returned = applyTeachEdits(asWorld, back.edits);

        rtChecked++;
        const before = parseTp(text).positions.find(x => x.index === p.index)!.groups[0];
        const after = parseTp(returned).positions.find(x => x.index === p.index)!.groups[0];
        const axes = ['X', 'Y', 'Z', 'W', 'P', 'R'];
        const worst = Math.max(...axes.map(a => Math.abs((before.values[a]?.value ?? 0) - (after.values[a]?.value ?? 0))));
        // One unit of the stored precision. A .ls holds three decimals, so a value that
        // travels through a rotation and back can land on the next representable number -
        // quantisation in the FILE, not error in the maths.
        check(worst <= 0.001 + 1e-9, `${path.basename(f)} P[${p.index}] UF${g.uf}: round trip is ${worst} out (more than one stored unit)`);
        rtWorst = Math.max(rtWorst, worst);
        check(after.uf === g.uf && after.ut === g.ut, `${path.basename(f)} P[${p.index}]: frame labels restored`);
        if (returned === text) rtExact++;
      }
    }
    if (rtChecked) {
      console.log(`  frames: ${rtChecked} real position(s) converted to world and back, worst ${rtWorst.toFixed(4)} mm/deg (${rtExact} byte-identical, ${rtMoved} moved numbers)`);
      check(rtMoved > 0, 'the conversions actually changed numbers rather than doing nothing');
    }
  }

  // ---- planFrameShift, on a program ----
  const prog = [
    '/PROG  T', '/MN', '   1:  J P[1] 100% FINE ;', '/POS',
    'P[1]{', '   GP1:', "\tUF : 1, UT : 1,\t\tCONFIG : 'N U T, 0, 0, 0',",
    '\tX =    10.000  mm,\tY =     0.000  mm,\tZ =     0.000  mm,',
    '\tW =     0.000 deg,\tP =     0.000 deg,\tR =     0.000 deg', '};',
    '/END', '',
  ].join('\n');

  const shift = planFrameShift(prog, 1, { fromUf: uf, toUf: IDENTITY, toUfNumber: 0 })!;
  check(!shift.blockers.length && shift.edits.length > 0, `frame shift plan: ${JSON.stringify(shift.blockers)}`);
  const shifted = applyTeachEdits(prog, shift.edits);
  check(shifted.includes('X =   100.000  mm') && shifted.includes('Y =    10.000  mm'), `frame shift values: ${shifted.split('\n')[7]}`);
  check(shifted.includes('R =    90.000 deg'), `frame shift orientation: ${shifted.split('\n')[8]}`);
  check(shifted.includes('UF : 0, UT : 1'), `frame shift relabels the block: ${shifted.split('\n')[6]}`);
  // the shifted point re-parses and converts back to where it started
  const reparsed = parseTp(shifted).positions[0].groups[0];
  check(reparsed.uf === 0 && reparsed.values.X.value === 100, `frame shift re-parses: ${JSON.stringify(reparsed.values)}`);

  // a joint-taught point has no user frame to convert
  const jointProg = prog.replace("\tUF : 1, UT : 1,\t\tCONFIG : 'N U T, 0, 0, 0',\n\tX =    10.000  mm,\tY =     0.000  mm,\tZ =     0.000  mm,\n\tW =     0.000 deg,\tP =     0.000 deg,\tR =     0.000 deg",
    '\tUF : 1, UT : 1,\t\n\tJ1=     0.000 deg,\tJ2=     0.000 deg,\tJ3=     0.000 deg,\n\tJ4=     0.000 deg,\tJ5=     0.000 deg,\tJ6=     0.000 deg');
  check(planFrameShift(jointProg, 1, { fromUf: uf, toUf: IDENTITY, toUfNumber: 0 })!.blockers.some(b => /joint angles/.test(b)),
    'a joint-taught point is refused, and says why');

  // ---- mirror ----
  {
    const near2 = (a: number, b: number, tol = 1e-9) => Math.abs(a - b) < tol;

    // Hand-checkable: reflecting across XZ negates Y and nothing else.
    const m1 = mirror({ x: 100, y: 50, z: 25, w: 0, p: 0, r: 0 }, 'XZ');
    check(near2(m1.x, 100) && near2(m1.y, -50) && near2(m1.z, 25), `mirror XZ negates Y: ${JSON.stringify(m1)}`);

    // The orientation check that catches a wrong reflection: a turn about Z mirrors to the
    // opposite turn. Applying the reflection to the rotation directly (rather than
    // conjugating) would give something with determinant -1, which is not a rotation at all.
    const m2 = mirror({ x: 0, y: 0, z: 0, w: 0, p: 0, r: 90 }, 'XZ');
    check(near2(Math.abs(m2.r), 90) && near2(m2.r, -90, 1e-6), `a 90 deg turn mirrors to -90: ${JSON.stringify(m2)}`);

    // Mirroring twice is the identity, for every plane and an awkward pose.
    const odd2 = { x: 12.5, y: -33.25, z: 404.125, w: 23.4, p: -56.7, r: 89.1 };
    for (const plane of ['XY', 'XZ', 'YZ'] as const) {
      const there = mirror(odd2, plane);
      const back2 = mirror(there, plane);
      check(near2(back2.x, odd2.x, 1e-6) && near2(back2.y, odd2.y, 1e-6) && near2(back2.z, odd2.z, 1e-6),
        `mirror ${plane} twice restores the position: ${JSON.stringify(back2)}`);
      check(sameOrientation(back2, odd2, 1e-9), `mirror ${plane} twice restores the orientation`);
      check(!sameOrientation(there, odd2, 1e-6) || plane === 'XY', `mirror ${plane} actually changed something`);
    }

    // A mirrored pose is still a valid rotation - the whole reason for conjugating.
    for (const plane of ['XY', 'XZ', 'YZ'] as const) {
      const r = toPose(mirror(odd2, plane)).R;
      const det =
        r[0][0] * (r[1][1] * r[2][2] - r[1][2] * r[2][1]) -
        r[0][1] * (r[1][0] * r[2][2] - r[1][2] * r[2][0]) +
        r[0][2] * (r[1][0] * r[2][1] - r[1][1] * r[2][0]);
      check(near2(det, 1, 1e-9), `mirror ${plane} yields a proper rotation (det ${det})`);
    }

    // On a program, through the planner.
    const mprog = [
      '/PROG  T', '/MN', '   1:  J P[1] 100% FINE ;', '/POS',
      'P[1]{', '   GP1:', "\tUF : 1, UT : 1,\t\tCONFIG : 'N U T, 0, 0, 0',",
      '\tX =   100.000  mm,\tY =    50.000  mm,\tZ =    25.000  mm,',
      '\tW =     0.000 deg,\tP =     0.000 deg,\tR =    90.000 deg', '};',
      '/END', '',
    ].join('\n');

    const mp = planMirror(mprog, 1, 'XZ')!;
    check(!mp.blockers.length && mp.edits.length > 0, `mirror plan: ${JSON.stringify(mp.blockers)}`);
    const mirrored = applyTeachEdits(mprog, mp.edits);
    check(mirrored.includes('Y =   -50.000  mm') && mirrored.includes('X =   100.000  mm'), `mirrored values: ${mirrored.split('\n')[7]}`);
    check(mirrored.includes('R =   -90.000 deg'), `mirrored orientation: ${mirrored.split('\n')[8]}`);
    check(mp.warnings.some(w => /CONFIG is left as/.test(w)), 'mirroring warns that the arm configuration is not recomputed');
    // CONFIG really is untouched
    check(mirrored.includes("CONFIG : 'N U T, 0, 0, 0'"), 'mirroring does not invent a new CONFIG');
    // and mirroring the result back returns the original numbers
    const backText = applyTeachEdits(mirrored, planMirror(mirrored, 1, 'XZ')!.edits);
    check(backText === mprog, 'mirroring twice through the planner returns the original bytes');

    check(planMirror(jointProg, 1, 'XZ')!.blockers.some(b => /joint angles/.test(b)), 'a joint-taught point cannot be mirrored');
  }

  // ---- relabel: the numbers stay, so the point moves ----
  {
    const rprog = [
      '/PROG  T', '/MN', '   1:  J P[1] 100% FINE ;', '/POS',
      'P[1]{', '   GP1:', "\tUF : 1, UT : 1,\t\tCONFIG : 'N U T, 0, 0, 0',",
      '\tX =   100.000  mm,\tY =    50.000  mm,\tZ =    25.000  mm,',
      '\tW =     0.000 deg,\tP =     0.000 deg,\tR =    90.000 deg', '};',
      '/END', '',
    ].join('\n');

    const rl = planRelabelFrames(rprog, 1, 4, 2)!;
    check(rl.edits.length === 1 && !rl.blockers.length, `relabel plan: ${JSON.stringify(rl)}`);
    const relabelled = applyTeachEdits(rprog, rl.edits);
    check(relabelled.includes('UF : 4, UT : 2'), `relabel rewrote the frames: ${relabelled.split('\n')[6]}`);
    // the whole point of relabel: NOT ONE number changed
    check(relabelled.includes('X =   100.000  mm') && relabelled.includes('R =    90.000 deg'), 'relabel leaves every value alone');
    check(rl.warnings.some(w => /DIFFERENT place in the cell/.test(w)), 'relabel says the point now means somewhere else');
    check(!planRelabelFrames(rprog, 1, 1, 1)!.edits.length, 'relabelling to the frames it already has does nothing');
  }

  // converting to the frame it is already in changes nothing
  const noop = planFrameShift(prog, 1, { fromUf: IDENTITY, toUf: IDENTITY, toUfNumber: 1 })!;
  check(!noop.edits.length, `converting to the same frame is a no-op: ${JSON.stringify(noop.changes)}`);
}

// ---------- ktrans output (real fixtures captured from KTRANS V9.40-1) ----------
{
  const fx = (n: string) => { const p = path.resolve(__dirname, '..', 'test', n); return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''; };
  const bad = parseKtransIssues(fx('fixtures-ktrans-error.txt'));
  check(bad.success === false, 'ktrans: failure detected');
  check(bad.issues.length === 2, `ktrans: 2 unique issues from 3 repeated blocks (got ${bad.issues.length}: ${JSON.stringify(bad.issues)})`);
  check(bad.issues[0]?.line === 9 && bad.issues[0].col === 0 && /ENDxxx/.test(bad.issues[0].message), `ktrans: first issue line 10 col 0: ${JSON.stringify(bad.issues[0])}`);
  check(bad.issues[1]?.line === 9 && bad.issues[1].col === 4 && /new line expected/.test(bad.issues[1].message), `ktrans: second issue col 4: ${JSON.stringify(bad.issues[1])}`);
  check(bad.notices.some(n => /robot\.ini/.test(n)), 'ktrans: robot.ini notice captured');
  const ok = parseKtransIssues(fx('fixtures-ktrans-ok.txt'));
  check(ok.success === true && ok.issues.length === 0 && /82 bytes/.test(ok.summary ?? ''), `ktrans: success summary ${ok.summary}`);
}

// ---------- Controller HTML unwrapping + live virtual robots (ROBOT_CODE_VROBOTS=dir of downloaded files) ----------
{
  const wrapped = '<html><head><title> S002R01 (robot) Homepage </title></head><BODY bgcolor= #FFF9e3>\n<PRE>\nF Number: F368808\nCURRENT JOINT POSITION:\nJoint   1:   -101.43\n</PRE>\n</BODY></html>';
  const un = unwrapControllerHtml(wrapped);
  check(un.startsWith('F Number: F368808') && /Joint\s+1:\s+-101\.43/.test(un) && !/<\/?PRE>/i.test(un), `html unwrap: ${JSON.stringify(un.slice(0, 60))}`);
  check(unwrapControllerHtml('plain text\nno html') === 'plain text\nno html', 'html unwrap: plain text untouched');
  const xmp = unwrapControllerHtml('<XMP>\n/PROG TEST\n/MN\n   1:J P[1] 100% FINE\n</XMP>\n');
  check(xmp.startsWith('/PROG TEST') && /J P\[1\]/.test(xmp) && !/<XMP>/i.test(xmp), `xmp unwrap: ${JSON.stringify(xmp.slice(0, 40))}`);
  const xmpPage = unwrapControllerHtml('<html><head><title>x</title></head><body>\n<xmp>\nhello controller\n</xmp>\n</body></html>');
  check(xmpPage.startsWith('hello controller') && !/xmp/i.test(xmpPage), `xmp inside html: ${JSON.stringify(xmpPage.slice(0, 40))}`);
  check(looksLikeHtml('<XMP>\nhi\n</XMP>') && !looksLikeHtml('/PROG X\n'), 'looksLikeHtml recognises the <XMP> wrapper, not a bare program');
  const xmpLate = unwrapControllerHtml('leading junk\r\n<XMP>\n/PROG LATE\n/MN\n</XMP>');
  check(xmpLate.startsWith('/PROG LATE') && !/<XMP>/i.test(xmpLate), `xmp unwrap wherever it sits: ${JSON.stringify(xmpLate.slice(0, 40))}`);
  check(unwrapControllerHtml('/PROG X\n/MN\n') === '/PROG X\n/MN\n', 'xmp unwrap: a plain program is untouched');
  const nested = unwrapControllerHtml('<html><head><meta x></head><body><A HREF="../">Home</A>\n<PRE>\n<XMP>\n/PROG NEST\n/MN\n   1:J P[1] 100% FINE\n</XMP>\n</PRE>\n</body></html>');
  check(nested.startsWith('/PROG NEST') && /J P\[1\]/.test(nested) && !/<\/?(pre|xmp)>/i.test(nested), `nested <PRE><XMP> unwrap: ${JSON.stringify(nested.slice(0, 50))}`);
  const realShape = unwrapControllerHtml('<html><body><PRE>\n<XMP>\n/PROG NEST\n/MN\n/END\r\n\r\n</XMP></PRE></body></html>');
  check(realShape.startsWith('/PROG NEST') && realShape.endsWith('/END\r\n') && !/\r?\n\r?\n$/.test(realShape), `no trailing blank line after /END: ${JSON.stringify(realShape.slice(-12))}`);
  check(parseHttpListing('<A HREF="../">Home Page</A><A HREF="../MD/-BCKED8-.TP">-BCKED8-.TP</A><A HREF="../MD/ENTERZON.LS">ENTERZON.LS</A>').map(f => f.name).join(',') === '-BCKED8-.TP,ENTERZON.LS', 'http listing from INDEX_TP anchors');
  const vdir = process.env.ROBOT_CODE_VROBOTS;
  if (vdir && fs.existsSync(vdir)) {
    for (const d of fs.readdirSync(vdir).filter(x => fs.statSync(path.join(vdir, x)).isDirectory())) {
      const rd = (n: string) => unwrapControllerHtml(fs.readFileSync(path.join(vdir, d, n), 'latin1'));
      const info = parseControllerInfo(rd('ERRALL.LS') + rd('CURPOS.DG'));
      const pos = parseCurPos(rd('CURPOS.DG'));
      const tasks = parsePrgState(rd('PRGSTATE.DG'));
      const io = parseIoState(rd('IOSTATE.DG'));
      const alarms = parseAlarms(rd('ERRALL.LS'));
      const nr = parseNumReg(rd('NUMREG.VA')), pr = parsePosReg(rd('POSREG.VA')), sr = parseStrReg(rd('STRREG.VA'));
      const ioc = parseIoComments(rd('DIOCFGSV.VA')), mac = parseMacroTable(rd('SYSMACRO.VA'));
      const listing = parseHttpListing(fs.readFileSync(path.join(vdir, d, 'INDEX_TP.HTM'), 'latin1'));
      const ok = !!info.robotName && pos?.joint?.joints.length === 6 && tasks.length >= 10 && io.length > 3000 && alarms.length >= 50 && nr.length === 250 && pr.length > 100 && sr.length >= 25 && ioc.length > 1000 && mac.length > 10 && listing.some(f => /\.LS$/i.test(f.name));
      check(ok, `virtual robot ${d}: robot=${info.robotName} joints=${pos?.joint?.joints.length} tasks=${tasks.length} io=${io.length} alarms=${alarms.length} R=${nr.length} PR=${pr.length} SR=${sr.length} ioComments=${ioc.length} macros=${mac.length} programs=${listing.filter(f => /\.LS$/i.test(f.name)).length}`);
      if (ok) console.log(`  virtual robot ${d} = ${info.robotName} ${info.version}: ${tasks.length} tasks, ${io.length} I/O, ${alarms.length} alarms, ${listing.filter(f => /\.LS$/i.test(f.name)).length} programs listed`);
    }
    // real FTP + HTTP against the first virtual controller (read-only)
    const host = fs.readdirSync(vdir).find(x => /^127\.0\.0\.\d+$/.test(x));
    if (host) {
      try {
        const files = await ftpList({ host, port: 21, user: 'anonymous', password: '' }, 'MD:');
        check(files.some(f => /^NUMREG\.VA$/i.test(f.name)), `virtual FTP LIST on ${host}: ${files.length} files`);
        const txt = await ftpGetText({ host, port: 21, user: 'anonymous', password: '' }, 'MD:', 'CURPOS.DG');
        check(parseCurPos(txt)?.joint?.joints.length === 6, `virtual FTP RETR CURPOS.DG on ${host}`);
        const http = await httpGetText({ host, port: 80 }, 'MD:', 'PRGSTATE.DG');
        check(parsePrgState(http).length >= 10 && !/<html/i.test(http), `virtual HTTP GET unwrapped on ${host}`);
        const list = await httpList({ host, port: 80 }, 'MD:');
        check(list.filter(f => /\.LS$/i.test(f.name)).length > 10 && list.some(f => /\.VA$/i.test(f.name)), `virtual HTTP listing via INDEX pages on ${host}: ${list.length} files`);
        console.log(`  virtual controller ${host}: FTP ${files.length} files, HTTP listing ${list.length} files`);
      } catch (e: any) { check(false, `virtual controller ${host} network test: ${e?.message ?? e}`); }
    }
  } else console.log('  (set ROBOT_CODE_VROBOTS to a folder of downloaded virtual-robot files to test against them)');
}

// ---------- Backup diff + cross-reference ----------
if (backupDir) {
  const os = await import('node:os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-diff-'));
  const b = path.join(tmp, 'B'); fs.mkdirSync(b);
  for (const f of fs.readdirSync(backupDir)) if (/\.(ls|va)$/i.test(f)) fs.copyFileSync(path.join(backupDir, f), path.join(b, f));
  // mutate B: move P[1] in dcs_check by +10 mm X, change a line in enterzon, delete cc.ls, change R[15] value, rename DI[25], change PR[1] comment
  const dcs = path.join(b, 'dcs_check.ls');
  fs.writeFileSync(dcs, fs.readFileSync(dcs, 'latin1').replace(/X =\s+2220\.302/, 'X =  2230.302'), 'latin1');
  const ez = path.join(b, 'enterzon.ls');
  fs.writeFileSync(ez, fs.readFileSync(ez, 'latin1').replace('DO[900:CLROFZONE1]=ON ;', 'DO[901:CLROFZONE1]=ON ;'), 'latin1');
  fs.unlinkSync(path.join(b, 'cc.ls'));
  const nr = path.join(b, 'numreg.va');
  fs.writeFileSync(nr, fs.readFileSync(nr, 'latin1').replace(/^(\s*\[15\]\s*=\s*)30000/m, '$145000'), 'latin1');
  const io = path.join(b, 'diocfgsv.va');
  fs.writeFileSync(io, fs.readFileSync(io, 'latin1').replace("'ZONE 1 CLR'", "'ZONE 1 CLEAR'"), 'latin1');
  const pr = path.join(b, 'posreg.va');
  fs.writeFileSync(pr, fs.readFileSync(pr, 'latin1').replace("'Home 1'", "'Home One'"), 'latin1');
  const d = diffBackups(backupDir, b);
  check(d.programs.some(p => p.name === 'DCS_CHECK' && p.kind === 'positions-only' && p.positions[0]?.index === 1 && Math.abs(p.positions[0].dx - 10) < 1e-6), `diff: moved position ${JSON.stringify(d.programs.find(p => p.name === 'DCS_CHECK'))}`);
  check(d.programs.some(p => p.name === 'ENTERZON' && p.kind === 'changed' && p.linesAdded === 1 && p.linesRemoved === 1), `diff: changed line ${JSON.stringify(d.programs.find(p => p.name === 'ENTERZON'))}`);
  check(d.programs.some(p => p.name === 'CC' && p.kind === 'removed'), 'diff: removed program');
  check(d.programs.length === 3, `diff: only 3 program changes (got ${d.programs.map(p => p.name).join(',')})`);
  check(d.numregs.length === 1 && d.numregs[0].index === 15 && d.numregs[0].kind === 'value' && d.numregs[0].b === 45000, `diff: R[15] ${JSON.stringify(d.numregs)}`);
  check(d.io.length === 1 && d.io[0].kind === 'DI' && d.io[0].index === 25 && d.io[0].b === 'ZONE 1 CLEAR', `diff: DI[25] ${JSON.stringify(d.io)}`);
  check(d.posregs.length === 1 && d.posregs[0].index === 1 && d.posregs[0].kind === 'comment', `diff: PR[1] ${JSON.stringify(d.posregs)}`);
  check(d.strregs.length === 0 && d.macros.length === 0, 'diff: no spurious SR/macro changes');
  const same = diffBackups(backupDir, backupDir);
  check(same.programs.length === 0 && same.numregs.length === 0 && same.io.length === 0 && same.otherFiles.length === 0, `diff: identical folders → empty (${JSON.stringify(same.summary)})`);
  const mdReport = backupDiffMarkdown(d);
  check(/\| DCS_CHECK \| positions-only/.test(mdReport) && /P\[1\] \| moved \| 10\.000/.test(mdReport), 'diff: markdown report');
  fs.rmSync(tmp, { recursive: true, force: true });

  const progs = ls.filter(f => /^\/PROG\b/m.test(fs.readFileSync(f, 'utf8'))).map(f => ({ name: path.basename(f).replace(/\.ls$/i, '').toUpperCase(), prog: parseTp(fs.readFileSync(f, 'utf8')) }));
  const xref = buildXref(progs);
  const r151 = xref.find(e => e.kind === 'R' && e.index === 151);
  check(r151 && r151.writers.has('ENTERZON') && r151.uses.some(u => u.access === 'write') && r151.uses.some(u => u.access === 'condition'), `xref R[151]: ${JSON.stringify(r151 && { w: [...r151.writers], uses: r151.uses.map(u => u.access) })}`);
  const do900 = xref.find(e => e.kind === 'DO' && e.index === 900);
  check(do900 && do900.uses.every(u => u.access === 'write'), `xref DO[900] all writes: ${JSON.stringify(do900?.uses.map(u => u.access))}`);
  const di25 = xref.find(e => e.kind === 'DI' && e.index === 25);
  check(di25 && di25.writers.size === 0 && di25.uses.some(u => u.access === 'wait') && di25.uses.some(u => u.access === 'condition'), `xref DI[25]: ${JSON.stringify(di25?.uses.map(u => u.access))}`);
  const csv = xrefCsv(xref);
  check(csv.split('\r\n').length === xref.reduce((n, e) => n + e.uses.length, 0) + 1 && csv.startsWith('Kind,Index'), 'xref csv rows');
  console.log(`  xref: ${xref.length} items, ${xrefFindings(xref).length} findings, e.g. ${xrefFindings(xref).slice(0, 2).map(f => `${f.entry.kind}[${f.entry.index}] ${f.finding}`).join(' | ')}`);
}

// ---------- 0.11: bracket shapes, names, labels, cleanup, flow labels, payloads, rewrite, mget ----------
{
  // registers inside parentheses are reads like any other
  const paren = parseTp(['/PROG  T', '/MN', '   1:  IF (R[90] >=0) THEN ;', '   2:  DO[1]=(R[91]>=0) ;', '   3:  ENDIF ;', '/POS', '/END', ''].join('\n'));
  const r90 = paren.dataRefs.find(r => r.kind === 'R' && r.index === 90);
  const r91 = paren.dataRefs.find(r => r.kind === 'R' && r.index === 91);
  check(!!r90 && !!r91, 'R[] inside parentheses is a data ref');
  check(r90 && accessOfRef(paren, r90) === 'condition', `(R[90] >=0) counts as a read: ${r90 && accessOfRef(paren, r90)}`);
  check(r91 && accessOfRef(paren, r91) === 'read', `DO[1]=(R[91]>=0) reads R[91]: ${r91 && accessOfRef(paren, r91)}`);

  // the same inside parentheses for every bracketed kind, and each one resolves for ctrl-click (first use is the definition)
  const kinds = parseTp(['/PROG  T', '/MN', '   1:  IF (DI[5]=ON AND PR[1,1]>0 AND AR[1]=2 AND DO[7]=OFF) THEN ;', '   2:  ENDIF ;', '/POS', '/END', ''].join('\n'));
  check(['DI:5', 'PR:1', 'AR:1', 'DO:7'].every(k => kinds.dataRefs.some(r => `${r.kind}:${r.index}` === k)), `bracketed kinds inside parentheses: ${kinds.dataRefs.map(r => `${r.kind}[${r.index}]`).join(' ')}`);
  check(kinds.dataRefs.filter(r => r.kind !== 'AR').every(r => accessOfRef(kinds, r) === 'condition'), 'they count as reads (condition)');

  // V8.30 writes the exported state between index and comment: that is a field, not a raw shape
  const v830 = parseTp(['/PROG  T', '/MN', '   1:  IF (DI[45:OFF:BIN 1 TRIG]=ON),R[231:BIN1]=(0) ;', '   2:  DO[900:ON :CLROFZONE1]=ON ;', '   3:  IF GI[28: * :LOAD POS SEL BITS]=1,JMP LBL[10] ;', '   4:  GO[5:12:PART TYPE]=R[1] ;', '   5:  LBL[10] ;', '/POS', '/END', ''].join('\n'));
  const st = (k: string, i: number) => v830.dataRefs.find(r => r.kind === k && r.index === i)!;
  check(st('DI', 45).state === 'OFF' && st('DI', 45).comment === 'BIN 1 TRIG' && !st('DI', 45).extra, `DI[45:OFF:BIN 1 TRIG]: ${JSON.stringify(st('DI', 45))}`);
  check(st('DO', 900).state === 'ON' && st('DO', 900).comment === 'CLROFZONE1', `DO[900:ON :CLROFZONE1]: ${JSON.stringify(st('DO', 900))}`);
  check(st('GI', 28).state === '*' && st('GI', 28).comment === 'LOAD POS SEL BITS' && st('GO', 5).state === '12', 'GI[28: * :…] and GO[5:12:…] states');
  check(v830.dataRefs.every(r => !r.extra), 'no state segment is reported as an unknown shape');

  // instruction keywords inside a reference comment are text, not code
  const kwCmt = parseTp(['/PROG  T', '/MN', '   1:  DO[1:RUN INTRPT ACK]=(ON) ;', '   2:  DO[2:CALL SUB PROG]=OFF ;', '   3:  R[3:JMP LBL[9] HERE]=1 ;', '/POS', '/END', ''].join('\n'));
  check(kwCmt.calls.length === 0, `RUN/CALL inside a bracket comment are not calls: ${JSON.stringify(kwCmt.calls.map(c => c.name))}`);
  check(kwCmt.jumps.length === 0, `JMP LBL[] inside a bracket comment is not a jump: ${JSON.stringify(kwCmt.jumps.map(j => j.num))}`);

  // an untaught position: UF/UT "F" and ******** values
  const untaught = parseTp(['/PROG  T', '/MN', '   1:  J P[1] 100% FINE ;', '/POS', 'P[1]{', '   GP1:', "\tUF : F, UT : F,\t\tCONFIG : 'N D B, 0, 0, 0',", '\tX = ********  mm,\tY = ********  mm,\tZ = ********  mm,', '\tW = ******** deg,\tP = ******** deg,\tR = ******** deg', '};', '/END', ''].join('\n'));
  check(untaught.positions[0].groups[0].untaught === true && untaught.positions[0].groups[0].uf === undefined && Object.keys(untaught.positions[0].groups[0].values).length === 0, `untaught block recognised: ${JSON.stringify(untaught.positions[0].groups[0])}`);
  check(describePosition(untaught.positions[0]) === 'untaught' && /untaught/.test(positionMarkdown(untaught.positions[0])), 'untaught in the summaries');
  check(planTeach(untaught.header ? ['/PROG  T', '/MN', '   1:  J P[1] 100% FINE ;', '/POS', 'P[1]{', '   GP1:', "\tUF : F, UT : F,", '\tX = ********  mm', '};', '/END', ''].join('\n') : '', 1, { kind: 'cartesian', uf: 1, ut: 1, origin: 't', values: { X: 1, Y: 2, Z: 3, W: 0, P: 0, R: 0 } })!.blockers.some(b => /no axis values/.test(b)), 'teaching an untaught point in place is refused (the block is rewritten instead)');

  // an undocumented bracket shape degrades to index + last segment, and says so
  const odd = parseTp(['/PROG  T', '/MN', '   1:  GO[10:curr value:PROG FEEDBACK]=1 ;', '   2:  R[5:Count]=1 ;', '/POS', '/END', ''].join('\n'));
  const go = odd.dataRefs.find(r => r.kind === 'GO')!;
  check(go.index === 10 && go.comment === 'PROG FEEDBACK' && go.extra?.join('|') === 'curr value', `GO[index:curr value:name]: ${JSON.stringify(go)}`);
  check(!!go.commentSpan && odd.lines[2].raw.slice(go.commentSpan.col, go.commentSpan.col + go.commentSpan.len) === 'PROG FEEDBACK', 'comment span points at the last segment');
  const r5 = odd.dataRefs.find(r => r.kind === 'R')!;
  check(r5.comment === 'Count' && !r5.extra, 'ordinary comments are untouched');

  // P[] names have spans, on the block and on the reference
  const named = parseTp(['/PROG  T', '/MN', '   1:  J P[1:Home] 100% FINE ;', '   2:  L P[2] 500mm/sec FINE ;', '/POS', 'P[1:"Home"]{', '   GP1:', '\tUF : 1, UT : 1,', '\tJ1=     0.000 deg', '};', 'P[2]{', '   GP1:', '\tUF : 1, UT : 1,', '\tJ1=     0.000 deg', '};', '/END', ''].join('\n'));
  check(named.posRefs[0].comment === 'Home' && named.posRefs[0].commentSpan?.col === named.posRefs[0].span.col + 4 && named.posRefs[0].commentSpan.len === 4, `P[1:Home] ref comment span: ${JSON.stringify(named.posRefs[0])}`);
  check(named.positions[0].commentSpan?.col === 5 && named.positions[0].commentSpan.len === 4 && named.posRefs[1].comment === undefined, `P[1:"Home"] block comment span: ${JSON.stringify(named.positions[0].commentSpan)}`);

  // labels
    check(frameLabel({ kind: 'joint', uf: 2, ut: 6 }) === '[JNT][UF2][UT6]' && frameLabel({ kind: 'cartesian', uf: 0, ut: 1 }) === '[XYZ][UF0][UT1]' && frameLabel(undefined) === 'no data', 'frame labels are spelled out');
  // the inline hint draws one badge per piece, tagged so `tp.decorations.positionFields` can filter
  const hintFields = (g: { kind: 'joint' | 'cartesian' | 'unknown'; uf?: number; ut?: number } | undefined) => frameHintFields(g).map(p => `${p.field}:${p.text}`);
  check(JSON.stringify(hintFields({ kind: 'joint', uf: 2, ut: 6 })) === JSON.stringify(['type:JNT', 'userFrame:UF2', 'userTool:UT6'])
    && JSON.stringify(hintFields({ kind: 'cartesian', uf: 0, ut: 1 })) === JSON.stringify(['type:XYZ', 'userFrame:UF0', 'userTool:UT1'])
    && JSON.stringify(hintFields({ kind: 'joint' })) === JSON.stringify(['type:JNT'])
    && JSON.stringify(hintFields(undefined)) === JSON.stringify([]), 'frame hint fields are tagged for filtering');
  const framesOnly = frameHintFields({ kind: 'joint', uf: 2, ut: 6 }).filter(p => p.field !== 'type').map(p => `{${p.text}}`).join('');
  check(framesOnly === '{UF2}{UT6}', `only the frames draw when type is turned off: ${framesOnly}`);
  // an R[n] that is a label index (LBL[R[n]]) is not a data reference to comment on
  check(isIndirectLabelIndex('JMP LBL[R[168]]', 8) && isIndirectLabelIndex('Wait R[2] Skip,LBL[R[3]]', 19)
    && !isIndirectLabelIndex('Wait R[2] Skip,LBL[R[3]]', 5) && !isIndirectLabelIndex('R[1]=1', 0),
    'indirect label registers are recognized (and normal registers are not)');

  // stale positions: unused, and used only on commented-out lines
  const stale = ['/PROG  T', '/MN', '   1:  J P[1] 100% FINE ;', '   2:  //L P[2] 500mm/sec FINE ;', '   3:  !J P[3] 100% FINE ;', '   4:  GP[1]=1 ;', '/POS',
    'P[1]{', '   GP1:', '\tUF : 1, UT : 1,', '\tJ1=     0.000 deg', '};',
    'P[2]{', '   GP1:', '\tUF : 1, UT : 1,', '\tJ1=     0.000 deg', '};',
    'P[3]{', '   GP1:', '\tUF : 1, UT : 1,', '\tJ1=     0.000 deg', '};',
    'P[4]{', '   GP1:', '\tUF : 1, UT : 1,', '\tJ1=     0.000 deg', '};',
    '/END', ''].join('\n');
  const found = findStalePositions(stale);
  check(found.map(f => `${f.index}:${f.reason}`).join(' ') === '2:remarked 3:remarked 4:unused', `stale positions: ${found.map(f => `${f.index}:${f.reason}`).join(' ')}`);
  check(found[0]?.mentions[0] === 3 && found[1]?.mentions[0] === 4, 'commented-out mentions carry their lines');
  const after = parseTp(applyLineChanges(stale, planPositionRemoval(stale, [2, 4])));
  check(after.positions.map(p => p.index).join(',') === '1,3' && after.numberedLineCount === 4, `removal keeps the rest: ${after.positions.map(p => p.index).join(',')}`);

  // flow: edges carry the whole condition, with TRUE/FALSE spelled out
  const longCond = 'R[1:Part Type]=3 AND DI[10:Fixture Clamped]=ON AND R[2:Cycle Count]<100';
  const fl = buildFlow(parseTp(['/PROG  T', '/MN', `   1:  IF (${longCond}) THEN ;`, '   2:  R[3]=1 ;', '   3:  ELSE ;', '   4:  R[3]=2 ;', '   5:  ENDIF ;', `   6:  IF ${longCond},JMP LBL[9] ;`, '   7:  R[4]=1 ;', '   8:  LBL[9] ;', '/POS', '/END', ''].join('\n')));
  const tEdges = fl.edges.filter(e => e.kind === 'true'), fEdges = fl.edges.filter(e => e.kind === 'false');
  const carries = (e: { label?: string }) => e.label === `(${longCond})` || e.label === longCond;
  check(tEdges.length === 2 && fEdges.length === 2 && tEdges.every(carries) && fEdges.every(carries), `flow edges keep the full condition: ${JSON.stringify(fl.edges.map(e => `${e.kind}:${e.label}`))}`);
  check(tEdges[0] && edgeText(tEdges[0]).startsWith('TRUE: ') && fEdges[0] && edgeText(fEdges[0]).startsWith('FALSE: '), `edge routing is explicit: ${tEdges[0] && edgeText(tEdges[0])} / ${fEdges[0] && edgeText(fEdges[0])}`);
  check(flowToMermaid(fl, 'T').includes('|TRUE:') && flowToMermaid(fl, 'T').includes('Cycle Count'), 'mermaid export carries the full condition');
  // every edge names its landing: the IF..JMP's true edge lands on LBL[9], the false edge on line 7, and the fall-through is captioned too
  const caps = fl.edges.map(e => edgeCaption(fl, e));
  check(caps.some(c => /^TRUE: .*→ LBL\[9\] \(line 8\)$/.test(c)) && caps.some(c => /^FALSE: .*→ line 7$/.test(c)), `edges name where they land: ${JSON.stringify(caps)}`);
  check(caps.some(c => /^falls through → /.test(c)), 'fall-through edges are captioned like jumps');

  // payload schedules from the real symotn.va
  if (backupDir && isRefBackup(backupDir)) {
    const pl = parsePayloads(fs.readFileSync(path.join(backupDir, 'symotn.va'), 'latin1'));
    check(pl.schedules.length === 10, `payload schedules: ${pl.schedules.length}`);
    const two = pl.schedules.find(p => p.index === 2)!;
    check(two.initialized && two.comment === 'Tool w/o Part' && Math.abs(two.mass - 110.733) < 1e-6 && Math.abs(two.cg.x + 2.611) < 1e-6 && Math.abs(two.inertia.ix - 96805.37) < 1e-3, `payload 2: ${JSON.stringify(two)}`);
    const four = pl.schedules.find(p => p.index === 4)!;
    check(!four.initialized && four.comment === '' && four.mass === 210, `payload 4 uninitialised: ${JSON.stringify(four)}`);
    check(pl.activeMass !== undefined && Math.abs(pl.activeMass - 110.733) < 1e-6, `active payload: ${pl.activeMass}`);
    check(describePayload(two) === '110.733 kg · CoG -2.611 / 29.562 / 26.375 mm', `describe payload: ${describePayload(two)}`);
  }
  check(parsePayloads('nothing here').schedules.length === 0, 'no payload table → no schedules');

  // rewriting a block in the other representation
  const cartProg = ['/PROG  T', '/MN', '   1:  J P[1:Pounce] 100% FINE ;', '/POS', 'P[1:"Pounce"]{', '   GP1:', "\tUF : 1, UT : 1,\t\tCONFIG : 'N U T, 0, 0, 0',", '\tX =   100.000  mm,\tY =   200.000  mm,\tZ =   300.000  mm,', '\tW =     0.000 deg,\tP =     0.000 deg,\tR =     0.000 deg', '};', '/END', ''].join('\n');
  const rw = planRewriteBlock(cartProg, 1, { kind: 'joint', ut: 1, origin: 'test', values: { J1: 1, J2: 2, J3: 3, J4: 4, J5: 5, J6: 6 } })!;
  check(!!rw && !rw.blockers.length && rw.line === 4 && rw.endLine === 9 && rw.comment === 'Pounce', `rewrite block plan: ${JSON.stringify(rw && { line: rw.line, endLine: rw.endLine, comment: rw.comment, blockers: rw.blockers })}`);
  const rewritten = parseTp(cartProg.split('\n').slice(0, rw.line).concat(rw.newText.split('\n'), cartProg.split('\n').slice(rw.endLine + 1)).join('\n'));
  check(rewritten.positions[0].comment === 'Pounce' && rewritten.positions[0].groups[0].kind === 'joint' && rewritten.positions[0].groups[0].values.J6.value === 6 && rewritten.positions[0].groups[0].values.X === undefined, `rewritten block: ${JSON.stringify(rewritten.positions[0].groups[0])}`);
  const twoGroups = cartProg.replace('\n};', '\n   GP2:\n\tUF : 1, UT : 1,\n\tJ1=     0.000 deg\n};');
  check(planRewriteBlock(twoGroups, 1, { kind: 'joint', origin: 'test', values: { J1: 1 } })!.blockers.some(b => /2 motion groups/.test(b)), 'a multi-group block is refused');
  check(planRewriteBlock(cartProg, 1, { kind: 'joint', origin: 'test', values: { X: 1 } })!.blockers.some(b => /no joint angles/.test(b)), 'a reading without the wanted axes is refused');

  // --eg: extended comment, from a real controller (S002R05 TEST.LS, 2026-09-15)
  const egText = fs.readFileSync(path.join(__dirname, '..', 'test', 'fixtures-extended-comment.ls'), 'latin1');
  const eg = parseTp(egText);
  const egFirst = eg.lines.find(l => /--eg:/.test(l.raw))!;
  const egNext = eg.lines[egFirst.line + 1];
  check(egFirst.kind === 'comment' && egFirst.ext === true && egFirst.num === 1, `--eg: line is an extended comment: ${JSON.stringify({ kind: egFirst.kind, ext: egFirst.ext, num: egFirst.num })}`);
  check(egNext.kind === 'comment' && egNext.ext === true && egNext.num === undefined && !egNext.motion, `its continuation line is comment text, not a motion: ${JSON.stringify({ kind: egNext.kind, ext: egNext.ext })}`);
  check(eg.numberedLineCount === 8 && eg.lines.filter(l => l.kind === 'motion').length === 3, `line count still 8 (${eg.numberedLineCount}), 3 motions`);
  check(renumber(egText, { width: 4, autoSemicolon: true, updateLineCount: true }).edits.length === 0, 'renumber leaves the extended comment alone (no " ;" added to line 1)');

  // ---- beta list 2, item 7: the pendant's width for extended comments ----
  // The rule was measured on ROBOGUIDE's own EXITZONE.LS (2026-09-11): widest line 78 columns,
  // wrapped between words. These four lines are that comment, verbatim.
  const pendantEg = [
    '   6:  --eg: testing 123 this has to end at some point i dont know how to tell',
    '    :  123 this has to end at some point i dont know how to tell 123 this has',
    '    :  to end at some point i eg: !dont know how to tell 123 this has to end',
    '    :  at some point i dont know how to t ;',
  ];
  check(Math.max(...pendantEg.map(extCommentColumns)) === 78, `the pendant's widest extended comment line is 78 columns (${pendantEg.map(extCommentColumns)})`);
  check(reflowExtendedComment(pendantEg) === undefined, 'a comment the pendant wrote is left exactly as it is');
  const pendantText = extCommentText(pendantEg);
  const rewrap = reflowExtendedComment(['   6:  --eg: ' + pendantText + ' ;']);
  check(!!rewrap && rewrap.lines.join('\n') === pendantEg.join('\n'), `the same text on one line wraps back into the pendant's four lines:\n${rewrap?.lines.join('\n')}`);
  const wrapped = wrapWords('a bb ccc dddd', 5, 4);
  check(wrapped.join('|') === 'a bb|ccc|dddd', `wrapWords fills each line then breaks between words: ${wrapped.join('|')}`);
  check(wrapWords('abcdefghij', 4, 4).join('|') === 'abcd|efgh|ij', `a word wider than a line is cut: ${wrapWords('abcdefghij', 4, 4).join('|')}`);
  check(wrapWords('', 10, 10).join('|') === '', 'no text is one empty piece');
  // the real S002R05 file: a 165-character continuation is loaded by the controller, and the
  // renumber (width on) wraps it the way the pendant would show it - three lines from two
  const egFlow78 = renumber(egText, { width: 4, autoSemicolon: true, updateLineCount: true, extendedCommentWidth: 78 });
  const egApplied = applyLineEdits(egText, egFlow78.edits).split(/\r?\n/);
  const egEnd = egApplied.findIndex(l => /^\s*2:/.test(l));
  const egLines = egApplied.slice(egApplied.findIndex(l => /--eg/.test(l)), egEnd);
  const egDs = /d{20,}/.exec(egText)![0].length;   // the one long word in the fixture (163 d's)
  check(egLines.length === 4 && egLines.every(l => extCommentColumns(l) <= 78) && /;\s*$/.test(egLines[3]) && egLines.slice(0, 3).every(l => !/;\s*$/.test(l)) && egLines[0] === '   1:  --eg: s the test' && egLines[1] === '    :  ' + 'd'.repeat(71) && egLines[3] === '    :  ' + 'd'.repeat(egDs - 142) + ' ;',
    `renumber wraps the ${egDs}-character continuation to the pendant's width (71 per continuation), terminator on the last line:\n${egLines.join('\n')}`);
  check(egFlow78.lineCount === 8 && parseTp(egApplied.join('\n')).numberedLineCount === 8, 'the reflow does not change the line count');
  // a comment that wrapped onto FEWER lines: the spare line is removed, not left empty
  const egShrinkText = ['/PROG  T', '/MN', '   1:  --eg: short', '    :  words', '    :  here ;', '   2:  R[1]=1 ;', '/POS', '/END', ''].join('\n');
  const egShrink = renumber(egShrinkText, { width: 4, autoSemicolon: true, updateLineCount: false, extendedCommentWidth: 78 });
  check(egShrink.edits.length === 0, 'three short lines fit, so nothing is touched even though they could be one line');
  const egShrink2Text = ['/PROG  T', '/MN', '   1:  --eg: ' + 'x'.repeat(80), '    :  a', '    :  b ;', '   2:  R[1]=1 ;', '/POS', '/END', ''].join('\n');
  const egShrink2 = applyLineEdits(egShrink2Text, renumber(egShrink2Text, { width: 4, autoSemicolon: true, updateLineCount: false, extendedCommentWidth: 78 }).edits).split('\n');
  check(egShrink2[2] === '   1:  --eg: ' + 'x'.repeat(65) && egShrink2[3] === '    :  ' + 'x'.repeat(15) + ' a b ;' && /^\s*2:/.test(egShrink2[4]), `a comment that needs fewer lines than it had loses the spare line:\n${egShrink2.slice(2, 5).join('\n')}`);
  // the caret on any line of the comment holds the whole comment still
  check(renumber(egText, { width: 4, autoSemicolon: true, updateLineCount: true, extendedCommentWidth: 78, skipLines: new Set([eg.lines.find(l => /--eg:/.test(l.raw))!.line + 1]) }).edits.length === 0, 'no reflow while the caret is on one of its lines');
  check(renumber(egText, { width: 4, autoSemicolon: true, updateLineCount: true, extendedCommentWidth: 0 }).edits.length === 0, 'width 0 switches the reflow off');

  // ---- beta list 2, item 9: Enter at the end of a comment keeps the next line a comment ----
  const scaf = (src: string[], at: number) => { const p = parseTp(['/PROG  T', '/MN', ...src, '/POS', '/END', ''].join('\n')); return commentScaffold(p.lines.find(l => l.line === at + 1), '   7:   ;'); };
  const bang = scaf(['   5:  !EXIT ZONE ;'], 1);
  check(bang?.newText === '   7:  ! ;' && bang.caretCol === 8 && !bang.stripPrevTerminator, `after a ! comment: ${JSON.stringify(bang)}`);
  check(scaf(['   5:  ! ;'], 1) === undefined, 'after an EMPTY ! comment the run ends (plain scaffold)');
  check(scaf(['   5:  R[1]=1 ;'], 1) === undefined, 'after an instruction: nothing');
  check(scaf(['   5:  //remark ;'], 1) === undefined, 'a // remark is not continued');
  const egc = scaf(['   5:  --eg: some text ;'], 1);
  check(egc?.newText === '    :   ;' && egc.caretCol === 7 && egc.stripPrevTerminator, `after an --eg: line: a continuation, and the line above loses its terminator: ${JSON.stringify(egc)}`);
  const egc2 = scaf(['   5:  --eg: some text', '    :  more ;'], 2);
  check(egc2?.newText === '    :   ;' && egc2.stripPrevTerminator, `after a continuation with text: another continuation: ${JSON.stringify(egc2)}`);
  check(scaf(['   5:  --eg: some text', '    :   ;'], 2) === undefined, 'after an empty continuation the run ends');
  check(scaf(['   5:  --eg: ;'], 1) === undefined, 'after an empty --eg: the run ends');
  const custom = commentScaffold(parseTp(['/PROG  T', '/MN', '    12:  !hello ;', '/POS', '/END', ''].join('\n')).lines.find(l => l.line === 2), '    13:   ;');
  check(custom?.newText === '    13:  ! ;' && custom.caretCol === 10, `the custom (indented) head is kept: ${JSON.stringify(custom)}`);
  // what the continuation becomes once the renumber sees it: still a continuation, untouched
  const afterEnter = ['/PROG  T', '/MN', '   1:  --eg: some text', '    :   ;', '   2:  R[1]=1 ;', '/POS', '/END', ''].join('\n');
  check(renumber(afterEnter, { width: 4, autoSemicolon: true, updateLineCount: false, extendedCommentWidth: 78 }).edits.length === 0 && parseTp(afterEnter).numberedLineCount === 2, 'the fresh continuation line is a continuation to the renumber, and line 2 stays 2');
  check(lookupTpDoc(egFirst.body)?.title.startsWith('Extended comment') === true, 'hover doc for --eg:');
  const egOne = parseTp(['/PROG  T', '/MN', '   1:  --eg:one line only ;', '   2:  R[1]=1 ;', '/POS', '/END', ''].join('\n'));
  check(egOne.lines[2].ext === true && egOne.lines[3].kind === 'instruction' && !egOne.lines[3].ext, 'a single-line --eg: ends at its own " ;"');
  const egBare = parseTp(['/PROG  T', '/MN', '   1:  --eg opens without a colon', '    :  and carries on ;', '   2:  R[1]=1 ;', '/POS', '/END', ''].join('\n'));
  check(egBare.lines[2].ext === true && egBare.lines[3].ext === true && egBare.lines[4].kind === 'instruction' && egBare.numberedLineCount === 2, '--eg without a colon is the same block');
  const egFlow = buildFlow(eg);
  // comments ahead of the first block ride on the entry node's title - the program's banner
  // is the one comment worth showing - and the extended comment is never an instruction
  check(/^Start · .*the test.*Test Drop Pounce Pos/.test(egFlow.nodes[0].title), `leading comments on the entry node: ${JSON.stringify(egFlow.nodes[0].title)}`);
  check(!egFlow.nodes.some(n => n.lines.some(l => (/--eg/.test(l.text) || /^d{20}/.test(l.text)) && l.kind !== 'comment')) && egFlow.nodes.reduce((n, b) => n + b.lines.filter(l => l.kind === 'motion').length, 0) === 3, `flow: extended comment is not an instruction; 3 motions (${JSON.stringify(egFlow.nodes.map(n => n.lines.map(l => `${l.kind}:${l.text.slice(0, 12)}`)))})`);
  // a comment titles the one block after it, not every block until the next comment
  // (the comment opens a block - it follows an IF THEN - so it titles that block, and only that one)
  const leak = buildFlow(parseTp(['/PROG  T', '/MN', '   1:  IF (R[1]=1) THEN ;', '   2:  !Set Robot UFRAME/UTOOL ;', '   3:  UFRAME_NUM=1 ;', '   4:  ENDIF ;', '   5:  IF (R[2]=1) THEN ;', '   6:  R[3]=1 ;', '   7:  ENDIF ;', '   8:  IF (R[4]=1) THEN ;', '   9:  R[5]=1 ;', '  10:  ENDIF ;', '  11:  R[6]=1 ;', '/POS', '/END', ''].join('\n')));
  const titled = leak.nodes.filter(n => /Set Robot UFRAME/.test(n.title));
  check(titled.length === 1 && titled[0].lines.some(l => /UFRAME_NUM/.test(l.text)), `comment titles one block only: ${JSON.stringify(leak.nodes.map(n => n.title))}`);
  const labelFirst = buildFlow(parseTp(['/PROG  T', '/MN', '   1:  !MAIN LOOP ;', '   2:  LBL[1] ;', '   3:  R[1]=1 ;', '   4:  JMP LBL[1] ;', '/POS', '/END', ''].join('\n')));
  check(/LBL\[1\].*MAIN LOOP/.test(labelFirst.nodes[0].title), `a banner before an opening label stays on that node: ${labelFirst.nodes[0].title}`);

  // header templates
  const ford = DEFAULT_HEADER_TEMPLATES.find(t => t.name.startsWith('Ford'))!;
  check(headerPrompts(ford).join(',') === 'DESCRIPTION,GROUPS', `Ford header asks for: ${headerPrompts(ford).join(',')}`);
  const h = expandHeader(ford, { PROGRAM: 'MAIN_PICK', DESCRIPTION: 'Moves Robot to Pounce Position' });
  // the GVOSS shape: banner, description, an empty comment line, the NOTE, banner
  check(h.lines[0] === '*'.repeat(32) && h.lines[1] === 'Moves Robot to Pounce Position' && h.lines[2] === '' && h.lines[3] === ' NOTE: This program has' && h.missing.join(',') === 'GROUPS' && h.lines[4] === ' ${GROUPS} motion', `header expand: ${JSON.stringify(h)}`);
  check(h.tooLong.length === 0 && expandHeader(ford, { DESCRIPTION: 'x'.repeat(40) }).tooLong.includes(1), 'over-width lines are reported');
  check(ruleLine(ford) === '*'.repeat(32) && ruleLine(DEFAULT_HEADER_TEMPLATES.find(t => t.name === 'Generic')!) === '-'.repeat(32), 'rule line follows the template');
  check(DEFAULT_HEADER_TEMPLATES.every(t => t.lines.every(l => l.length <= 32)), 'default templates fit the pendant');

  // system variable reference: normalisation, token detection, lookups over the bundled subset
  check(normalizeSysVar('$mnuframe[1,5].$x') === '$MNUFRAME[1,1].$X' && normalizeSysVar('$GROUP[3].UFRAME') === '$GROUP[1].$UFRAME' && normalizeSysVar('$MOTYPE') === '$MOTYPE', 'sysvar normalisation');
  const tok = sysVarTokenAt('  10:  $MNUFRAME[1,5].$X=R[1] ;', 12)!;
  check(!!tok && tok.token === '$MNUFRAME[1,5].$X' && tok.start === 7, `sysvar token at caret: ${JSON.stringify(tok)}`);
  check(sysVarTokenAt('  10:  R[1]=1 ;', 8) === undefined, 'no sysvar token where there is none');
  const bundledPath = path.resolve(__dirname, '..', 'data', 'sysvars.json');
  if (fs.existsSync(bundledPath)) {
    const idx = new SysVarsIndex();
    idx.add(JSON.parse(fs.readFileSync(bundledPath, 'utf8')).rows);
    check(idx.size > 4000, `bundled sysvars loaded: ${idx.size}`);
    const acc = idx.lookup('$ACC_MAXLMT');
    check(!!acc.info?.description && /ACC/.test(acc.info.description), `described variable found: ${JSON.stringify(acc.info)}`);
    const tops = idx.topLevel();
    check(tops.length > 800 && !!tops[0].description && tops.some(t => t.path === '$ACC_MAXLMT') && !tops.some(t => t.path.includes('.')), `top-level variables: ${tops.length}, described first`);
    const grp = idx.lookup('$GROUP[2].$NOSUCHFIELD');
    check(!grp.info && (grp.parent === undefined || grp.parent.path.startsWith('$GROUP')), `unknown field falls back to the described parent: ${JSON.stringify(grp.parent?.path)}`);
    const lines = describeSysVar('$ACC_MAXLMT', acc);
    check(lines[0].includes('$ACC_MAXLMT') && lines.some(l => /ACC/.test(l)), 'sysvar hover text');
  } else console.log('  (data/sysvars.json not generated; run npm run sysvars)');

  // custom renumber style: four spaces, the number as it is, a colon, no " ;" added - and
  // one already there stays; a blank line gets no "   ;" scaffold; running it twice changes nothing
  {
    const src = ['/PROG  CUST', '/ATTR', 'LINE_COUNT\t= 0;', '/MN', 'R[1]=1', '   2:  J P[1] 100% FINE ;', '', 'CALL SUB', '/POS', '/END'].join('\n');
    const custom = { indent: '    ', width: 0, autoSemicolon: false, updateLineCount: true };
    const r = renumber(src, custom);
    const after = applyLineEdits(src, r.edits).split('\n');
    check(after[4] === '    1:  R[1]=1' && after[5] === '    2:  J P[1] 100% FINE ;' && after[6] === '    3:' && after[7] === '    4:  CALL SUB' && after[2] === 'LINE_COUNT\t= 4;', `custom renumber style: ${JSON.stringify(after.slice(2, 8))}`);
    check(renumber(after.join('\n'), custom).edits.length === 0, 'custom renumber is stable on its own output');
    const ctl = applyLineEdits(after.join('\n'), renumber(after.join('\n'), { width: 4, autoSemicolon: true, updateLineCount: true }).edits).split('\n');
    check(ctl[4] === '   1:  R[1]=1 ;' && ctl[6] === '   3:   ;', `controller format restores the four-wide field and the terminators: ${JSON.stringify(ctl.slice(4, 8))}`);

    // no numbers: `spaces` keeps the instruction column, `none` keeps only the indent; both stable, both reversible
    const sp = applyLineEdits(after.join('\n'), renumber(after.join('\n'), { ...custom, number: 'spaces' }).edits).split('\n');
    check(sp[4] === '     :  R[1]=1' && sp[5] === '     :  J P[1] 100% FINE ;' && sp[6] === '     :' && sp[7] === '     :  CALL SUB' && sp[2] === 'LINE_COUNT\t= 4;', `spaces style keeps the colon: ${JSON.stringify(sp.slice(4, 8))}`);
    const spProg = parseTp(sp.join('\n'));
    check(spProg.numberedLineCount === 4 && !spProg.lines.some(l => l.kind === 'continuation'), `numberless colon lines parse as instructions, not continuations: ${spProg.numberedLineCount} lines, kinds ${spProg.lines.map(l => l.kind).join(',')}`);
    // a `:` line with no number is a first-class instruction (the scaffold default): hover,
    // block diagnostics, folding, labels and macros all treat it as the program line it is
    const scaf = parseTp(['/PROG  SCF', '/ATTR', 'LINE_COUNT\t= 3;', '/MN', '   1:  R[1]=1 ;', '    :  R[2]=2 ;', '    :   ;', '    :  ENDIF ;', '    :  LBL[7] ;', '/POS', '/END', ''].join('\n'));
    const scafMn = scaf.lines.filter(l => l.line >= 4 && l.line <= 8);
    check(scafMn[1].kind === 'instruction' && scafMn[1].num === undefined && scafMn[1].body === 'R[2]=2', `scaffold line is a first-class instruction: ${JSON.stringify(scafMn[1])}`);
    check(scafMn[2].kind === 'blank', `scaffold blank line is blank: ${scafMn[2].kind}`);
    check(scafMn[3].kind === 'instruction' && scafMn[3].body === 'ENDIF', `scaffold ENDIF is an instruction: ${scafMn[3].kind}`);
    check(scaf.labels.some(l => l.num === 7), `a scaffolded LBL is a label definition: ${JSON.stringify(scaf.labels)}`);
    check(scaf.numberedLineCount === 5, `scaffold lines still count: ${scaf.numberedLineCount}/5`);
    // every body shape a numberless line can take still lands on the right kind, and takes its
    // place in the count (seq), whether or not it carries the scaffold colon
    const km = parseTp(['/PROG  KND', '/MN', '   1:  R[1]=1 ;', '    :J P[1] 100% FINE ;', '    :  //note ;', '    :  WAIT 1.00 ;', 'R[9]=9', '/POS', '/END', ''].join('\n')).lines;
    check(km[3].kind === 'motion' && km[3].num === undefined, `a numberless motion line is motion: ${JSON.stringify(km[3])}`);
    check(km[4].kind === 'remark', `a numberless // line is a remark: ${km[4].kind}`);
    check(km[5].kind === 'instruction' && km[5].num === undefined, `a numberless instruction is an instruction: ${km[5].kind}`);
    check(km[6].kind === 'instruction' && km[6].num === undefined && km[6].body === 'R[9]=9', `bare text with no colon is an instruction: ${JSON.stringify(km[6])}`);
    check(km[2].seq === 1 && km[3].seq === 2 && km[4].seq === 3 && km[5].seq === 4 && km[6].seq === 5, `numberless lines take their place in the count: seq ${km.slice(2, 7).map(l => l.seq).join(',')}`);
    check(renumber(sp.join('\n'), { ...custom, number: 'spaces' }).edits.length === 0, 'spaces style is stable');
    const no = applyLineEdits(after.join('\n'), renumber(after.join('\n'), { ...custom, number: 'none' }).edits).split('\n');
    check(no[4] === '    :  R[1]=1' && no[5] === '    :  J P[1] 100% FINE ;' && no[6] === '    :' && no[7] === '    :  CALL SUB', `none style keeps the colon: ${JSON.stringify(no.slice(4, 8))}`);
    check(renumber(no.join('\n'), { ...custom, number: 'none' }).edits.length === 0 && parseTp(no.join('\n')).numberedLineCount === 4, 'none style is stable and every line still counts');
    // a numberless program still has every line in the flow graph, numbered by count
    const noFlow = buildFlow(parseTp(no.join('\n')));
    const noLines = noFlow.nodes.flatMap(n => n.lines.map(l => l.num));
    check(noLines.length >= 3 && noLines.includes(1) && noLines.includes(4), `numberless lines reach the flow graph with their count: ${JSON.stringify(noLines)}`);
    // as-you-type custom (`onlyNew`): the numbered lines are not touched, the typed line gets the style
    const mixed = ['/PROG  MIX', '/ATTR', 'LINE_COUNT\t= 0;', '/MN', '   1:  R[1]=1 ;', 'R[2]=2', '   3:  CALL SUB ;', '/POS', '/END'].join('\n');
    const on = applyLineEdits(mixed, renumber(mixed, { ...custom, number: 'spaces', onlyNew: true }).edits).split('\n');
    check(on[4] === '   1:  R[1]=1 ;' && on[5] === '     :  R[2]=2' && on[6] === '   3:  CALL SUB ;' && on[2] === 'LINE_COUNT\t= 3;', `onlyNew leaves numbered lines alone: ${JSON.stringify(on.slice(4, 7))}`);
    // a real continuation is still one: the second line of a circular move stays a continuation whatever precedes it
    const circ2 = ['/PROG  C2', '/ATTR', 'LINE_COUNT\t= 0;', '/MN', '   1:C P[1] ', '    :  P[2] 500mm/sec FINE ;', '     :  R[1]=1', '/POS', '/END'].join('\n');
    const c2 = parseTp(circ2);
    check(c2.lines.find(l => l.line === 5)?.kind === 'continuation' && c2.lines.find(l => l.line === 6)?.kind !== 'continuation' && c2.numberedLineCount === 2, `continuation after an open circular move, instruction after a terminated line: ${c2.lines.map(l => l.kind).join(',')}`);
    // a selection: only those lines are restyled
    const sel = applyLineEdits(mixed, renumber(mixed, { ...custom, number: 'ones', onlyNew: false, lines: { start: 6, end: 6 } }).edits).split('\n');
    check(sel[4] === '   1:  R[1]=1 ;' && sel[5] === 'R[2]=2' && sel[6] === '    1:  CALL SUB ;', `a range restyles only its lines: ${JSON.stringify(sel.slice(4, 7))}`);
    const ones = applyLineEdits(after.join('\n'), renumber(after.join('\n'), { ...custom, number: 'ones' }).edits).split('\n');
    check(ones[4] === '    1:  R[1]=1' && ones[5] === '    1:  J P[1] 100% FINE ;' && ones[7] === '    1:  CALL SUB' && ones[2] === 'LINE_COUNT\t= 4;', `ones style: ${JSON.stringify(ones.slice(4, 8))}`);
    check(renumber(ones.join('\n'), { ...custom, number: 'ones' }).edits.length === 0, 'ones style is stable');
    const back = applyLineEdits(sp.join('\n'), renumber(sp.join('\n'), { width: 4, autoSemicolon: true, updateLineCount: true }).edits).split('\n');
    check(back[4] === '   1:  R[1]=1 ;' && back[5] === '   2:  J P[1] 100% FINE ;' && back[6] === '   3:   ;' && back[7] === '   4:  CALL SUB ;', `numbers come back in controller format, spacing untouched: ${JSON.stringify(back.slice(4, 8))}`);
  }

  // scaffold mode: new lines get a blank prefix (spaces filling the number field + colon);
  // existing numbered lines are untouched; LINE_COUNT updates; autoSemicolon respected
  {
    const src = ['/PROG  SCF', '/ATTR', 'LINE_COUNT\t= 3;', '/MN', '   1:  R[1]=1 ;', '   2:  R[2]=2 ;', 'R[3]=3', '/POS', '/END'].join('\n');
    // scaffold with autoSemicolon ON: new line gets terminator, blank gets "   ;"
    const scaffold = { number: 'scaffold' as const, width: 0, autoSemicolon: true, updateLineCount: true, onlyNew: true };
    const r = renumber(src, scaffold);
    const after = applyLineEdits(src, r.edits).split('\n');
    check(after[4] === '   1:  R[1]=1 ;', `scaffold keeps existing line 1: ${JSON.stringify(after[4])}`);
    check(after[5] === '   2:  R[2]=2 ;', `scaffold keeps existing line 2: ${JSON.stringify(after[5])}`);
    check(after[6] === '    :  R[3]=3 ;', `scaffold prefixes new line with spaces+colon: ${JSON.stringify(after[6])}`);
    check(after[2] === 'LINE_COUNT\t= 3;', `scaffold updates LINE_COUNT: ${JSON.stringify(after[2])}`);
    check(renumber(after.join('\n'), scaffold).edits.length === 0, 'scaffold is stable on its own output');

    // scaffold width is the number field, not the digit count: 2-digit max still gets 4 spaces
    const big = ['/PROG  BIG', '/ATTR', 'LINE_COUNT\t= 99;', '/MN', '  99:  R[1]=1 ;', 'R[2]=2', '/POS', '/END'].join('\n');
    const br = renumber(big, scaffold);
    const ba = applyLineEdits(big, br.edits).split('\n');
    check(ba[4] === '  99:  R[1]=1 ;', `scaffold keeps existing 2-digit line: ${JSON.stringify(ba[4])}`);
    check(ba[5] === '    :  R[2]=2 ;', `scaffold pads to the 4-wide field, not the 2 digits: ${JSON.stringify(ba[5])}`);

    // the reported case: after a `  25:` line the scaffold must be `    :`, aligned with it
    const dots = ['/PROG  D25', '/ATTR', 'LINE_COUNT\t= 1;', '/MN', '  25:  R[1]=1 ;', 'R[2]=2', '/POS', '/END'].join('\n');
    const dd = applyLineEdits(dots, renumber(dots, scaffold).edits).split('\n');
    check(dd[5] === '    :  R[2]=2 ;', `scaffold after  25: lines up: ${JSON.stringify(dd[5])}`);

    // scaffold with autoSemicolon OFF: no terminator added
    const scaffoldNoTerm = { ...scaffold, autoSemicolon: false };
    const nr = renumber(src, scaffoldNoTerm);
    const na = applyLineEdits(src, nr.edits).split('\n');
    check(na[4] === '   1:  R[1]=1 ;', `scaffold no-term keeps existing: ${JSON.stringify(na[4])}`);
    check(na[6] === '    :  R[3]=3', `scaffold no-term omits terminator on new line: ${JSON.stringify(na[6])}`);

    // scaffold blank line: gets "   ;" when autoSemicolon ON, just "    :" when OFF
    const blank = ['/PROG  BLK', '/ATTR', 'LINE_COUNT\t= 1;', '/MN', '   1:  R[1]=1 ;', '', '/POS', '/END'].join('\n');
    const brk = renumber(blank, scaffold);
    const bka = applyLineEdits(blank, brk.edits).split('\n');
    check(bka[5] === '    :   ;', `scaffold blank line with auto-semicolon: ${JSON.stringify(bka[5])}`);
    const brkNo = renumber(blank, scaffoldNoTerm);
    const bkaNo = applyLineEdits(blank, brkNo.edits).split('\n');
    check(bkaNo[5] === '    :', `scaffold blank line without auto-semicolon: ${JSON.stringify(bkaNo[5])}`);

    // scaffold motion line hugs the colon
    const motion = ['/PROG  MOT', '/ATTR', 'LINE_COUNT\t= 1;', '/MN', '   1:  R[1]=1 ;', 'J P[1] 100% FINE ;', '/POS', '/END'].join('\n');
    const mr = renumber(motion, scaffold);
    const ma = applyLineEdits(motion, mr.edits).split('\n');
    check(ma[5] === '    :J P[1] 100% FINE ;', `scaffold motion hugs colon: ${JSON.stringify(ma[5])}`);

    // scaffold with no numbered lines falls back to width=4 (default lineNumberWidth)
    const fresh = ['/PROG  FSH', '/ATTR', 'LINE_COUNT\t= 0;', '/MN', 'R[1]=1', '/POS', '/END'].join('\n');
    const fr = renumber(fresh, { ...scaffold, width: 4 });
    const fa = applyLineEdits(fresh, fr.edits).split('\n');
    check(fa[4] === '    :  R[1]=1 ;', `scaffold fallback width=4: ${JSON.stringify(fa[4])}`);
  }

  // the Files panel: programs only by default - every .ls, a .tp only where no .ls of that name exists
  const listing = [
    { name: 'ENTERZON.LS', isDir: false }, { name: 'ENTERZON.TP', isDir: false }, { name: 'MHMENUC.PC', isDir: false },
    { name: 'binonly.tp', isDir: false }, { name: 'NUMREG.VA', isDir: false }, { name: 'CURPOS.DG', isDir: false },
    { name: 'SUB', isDir: true }, { name: 'README.TXT', isDir: false }, { name: 'SYSTEM.BIN', isDir: false },
  ];
  check(filesToShow(listing, 'programs').map(f => f.name).join(' ') === 'ENTERZON.LS binonly.tp SUB', `files panel, programs: ${filesToShow(listing, 'programs').map(f => f.name).join(' ')}`);
  check(filesToShow(listing, 'all').map(f => f.name).join(' ') === 'ENTERZON.LS ENTERZON.TP MHMENUC.PC binonly.tp NUMREG.VA CURPOS.DG SUB README.TXT', `files panel, all: ${filesToShow(listing, 'all').map(f => f.name).join(' ')}`);

  // mget patterns
  const g = globToRegExp('*.ls *.va');
  check(g.test('ENTERZON.LS') && g.test('numreg.va') && !g.test('curpos.dg'), 'glob: two patterns, case-insensitive');
  check(globToRegExp('*.*').test('anything.xyz') && !globToRegExp('*.*').test('noext') && globToRegExp('CUR?OS.DG').test('curpos.dg'), 'glob: *.* and ?');

  // a push is not killed by the flat 10 s control timeout: the data wait scales with size
  check(transferTimeout(10000, 0) === 30000, `ftp timeout: floor is 30 s (${transferTimeout(10000, 0)})`);
  const t150 = transferTimeout(10000, 150 * 1024);
  check(t150 > 60000 && t150 < 90000, `ftp timeout: a 150 KB program waits ~68 s (${t150})`);
  check(transferTimeout(10000, 512 * 1024) > t150, 'ftp timeout: grows with size');
  check(transferTimeout(10000, 100 * 1024 * 1024) === 300000, `ftp timeout: capped at 5 min (${transferTimeout(10000, 100 * 1024 * 1024)})`);
  check(transferTimeout(120000, 0) === 120000, 'ftp timeout: an explicit larger base is honoured');
  check(transferTimeout(120000, 512 * 1024) === 248000, `ftp timeout: the base and the size slice add (${transferTimeout(120000, 512 * 1024)})`);
}

// ---------- 0.13: position diff, frames, comment pull, unused programs, program templates ----------
{
  const ref = path.resolve(__dirname, '..', '..', 'reference-backup', 'S002R01_full_260823');
  if (fs.existsSync(ref)) { runPositionDiff(check, ref); runCommentSync(check, ref); }
  else console.log('  (reference-backup not found; position diff / comment sync checks skipped)');
  runPositionFormat(check, ls);
  runProgramTemplates(check);
  runIssue5(check);
  runVersionId(check);
  await runContainersHardening(check);
  await runSnapshotSync(check);
  await runSyncCore(check);
  runFileIcons(check);
  runRukusLayout(check);
  runRukusStore(check);
  runBetaIssues(check);
}

// ---------- the grammars: every regex compiles, and the scopes the changelog promises are produced ----------
//
// Nothing else here looks at tokens. 0.11.0 shipped eight rules in tp.tmLanguage.json with
// their backslashes eaten (`\\s*` -> `s*`, `\\b` -> a backspace byte); three of them would not
// compile at all, so VS Code threw on every bracket and every /POS block, and the other five
// could never match. Seven releases went out that way because parseTp never reads the grammar.
{
  const root = path.resolve(__dirname, '..');
  const wasm = fs.readFileSync(path.join(root, 'node_modules', 'vscode-oniguruma', 'release', 'onig.wasm'));
  await oniguruma.loadWASM(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) as ArrayBuffer);
  const grammarFiles = fs.readdirSync(path.join(root, 'syntaxes')).filter(f => /\.tmLanguage\.json$/i.test(f));
  check(grammarFiles.length >= 2, `grammars found: ${grammarFiles.join(', ')}`);
  for (const f of grammarFiles) {
    const g = JSON.parse(fs.readFileSync(path.join(root, 'syntaxes', f), 'utf8'));
    let rules = 0;
    const walkRules = (o: any, p: string) => {
      if (Array.isArray(o)) { o.forEach((x, i) => walkRules(x, `${p}[${i}]`)); return; }
      if (!o || typeof o !== 'object') return;
      for (const [k, v] of Object.entries(o)) {
        if ((k === 'match' || k === 'begin' || k === 'end' || k === 'while') && typeof v === 'string') {
          rules++;
          try { new oniguruma.OnigScanner([v]); } catch (e: any) { check(false, `${f} ${p}.${k} does not compile: ${e?.message ?? e} :: ${v}`); }
          // the tell-tale of an eaten backslash: a bare s* / d+ / G( or a control character
          check(!/[\x00-\x1f]/.test(v) && !/(^|[^\\])(s\*|d\+|G\()/.test(v), `${f} ${p}.${k} looks like it lost its backslashes :: ${v}`);
        } else walkRules(v, `${p}.${k}`);
      }
    };
    walkRules(g, f);
    check(rules >= 5, `${f}: ${rules} regexes compiled`);
  }

  // tokenise the fixtures the new rules were written for
  const registry = new vsctm.Registry({
    onigLib: Promise.resolve({ createOnigScanner: (s: string[]) => new oniguruma.OnigScanner(s), createOnigString: (s: string) => new oniguruma.OnigString(s) }),
    loadGrammar: async (scope: string) => {
      const f = scope === 'source.fanuc.tp' ? 'tp.tmLanguage.json' : scope === 'source.fanuc.karel' ? 'karel.tmLanguage.json' : undefined;
      return f ? vsctm.parseRawGrammar(fs.readFileSync(path.join(root, 'syntaxes', f), 'utf8'), f) : null;
    },
  });
  const tp = await registry.loadGrammar('source.fanuc.tp');
  check(!!tp, 'TP grammar loads');
  if (tp) {
    /** scopes of every token on every line, in file order */
    const tokenise = (text: string) => {
      let stack = vsctm.INITIAL;
      return text.split(/\r?\n/).map(line => {
        const r = tp.tokenizeLine(line, stack); stack = r.ruleStack;
        return r.tokens.map(t => ({ text: line.slice(t.startIndex, t.endIndex), scopes: t.scopes }));
      });
    };
    const has = (toks: { text: string; scopes: string[] }[], text: string, scope: string) => toks.some(t => t.text.trim() === text && t.scopes.includes(scope));
    const anyLine = (lines: ReturnType<typeof tokenise>, text: string, scope: string) => lines.some(l => has(l, text, scope));

    const ext = tokenise(fs.readFileSync(path.join(root, 'test', 'fixtures-extended-comment.ls'), 'utf8'));
    // the fixture's `--eg:s the test` has a word glued to the colon, so the opener token is `--eg` there
    check(anyLine(ext, '--eg:', 'punctuation.definition.comment.tp') || anyLine(ext, '--eg', 'punctuation.definition.comment.tp'), '--eg: opens an extended comment');
    check(ext.some(l => l.some(t => t.scopes.includes('comment.block.extended.tp') && /the test/.test(t.text))), 'the text after --eg: is comment');
    check(ext.some(l => has(l, ':', 'punctuation.separator.continuation.tp') && l.some(t => t.scopes.includes('comment.block.extended.tp') && /d{20}/.test(t.text))), 'the continuation line of an extended comment is comment');

    const v830 = tokenise(fs.readFileSync(path.join(root, 'test', 'fixtures-v830', 'pg08.ls'), 'utf8'));
    check(anyLine(v830, 'OFF', 'constant.language.io-state.tp') || anyLine(v830, 'ON', 'constant.language.io-state.tp'), 'V8.30 [index:state:comment] state segment is coloured');
    check(anyLine(v830, 'F', 'invalid.deprecated.untaught.tp'), 'UF : F marks an untaught block');
    check(v830.some(l => l.some(t => /^\*{3,}$/.test(t.text.trim()) && t.scopes.includes('invalid.deprecated.untaught.tp'))), 'X = ******** marks an untaught axis');

    const plain = tokenise('/PROG X\n/MN\n   1:  J P[1:"Home"] 100% FINE ;\n   2:  R[5:Speed]=DI[3:Part present] ;\n   3:C P[2]\n    :  P[3] 500mm/sec CNT100 ;\n/POS\n/END\n');
    check(has(plain[2], '1', 'constant.numeric.line-number.tp') && has(plain[3], '5', 'constant.numeric.index.tp') && has(plain[3], 'Speed', 'variable.other.tp-label.tp') && has(plain[3], 'Part present', 'variable.other.tp-label.tp'), `register and I/O brackets tokenise: ${JSON.stringify(plain[3].map(t => t.text))}`);
    check(has(plain[5], ':', 'punctuation.separator.continuation.tp'), 'second line of a circular move is a continuation');

    // ! is a comment only where an instruction starts; inside mixed logic it is NOT (Basic Operator's
    // Manual B-83284EN ch.9), and a multi-group register carries a GPn: prefix
    const logic = tokenise('/PROG X\n/MN\n   1:  !a real comment ;\n   2:  DO[1]=(DI[1] AND !DI[2]) ;\n   3:  R[1]=PR[GP2:5,3] ;\n    :  !scaffold comment ;\n/POS\n/END\n');
    const isComment = (t: { scopes: string[] }) => t.scopes.includes('comment.line.exclamation.tp');
    check(logic[2].some(t => isComment(t) && /a real comment/.test(t.text)), `! after the line number is a comment: ${JSON.stringify(logic[2].map(t => t.text))}`);
    check(!logic[3].some(isComment) && logic[3].some(t => t.text.includes('DI') && !isComment(t)), `! inside mixed logic is NOT, not a comment: ${JSON.stringify(logic[3].map(t => [t.text, t.scopes.at(-1)]))}`);
    check(has(logic[4], 'GP', 'support.type.register.tp') && has(logic[4], '5', 'constant.numeric.index.tp') && has(logic[4], '3', 'constant.numeric.index.tp'), `PR[GP2:5,3] keeps its group prefix and indexes: ${JSON.stringify(logic[4].map(t => [t.text, t.scopes.at(-1)]))}`);
    check(logic[5].some(t => isComment(t) && /scaffold comment/.test(t.text)), '! after a numberless line\'s colon is a comment');

    // option syntax from the FANUC manuals (generated catalog): coloured as option keywords
    const opt = tokenise(['/PROG X', '/MN', '   1:  LINE[1] ON ;', '   2:  Search Start[1] PR[2] ;', '   3:  STOP_TRACKING ;', '   4:  Weld Start[1,1] ;',
      '   5:  TORQ_LIMIT 20.0% ;', '   6:  SOFTFLOAT[1] ;', '   7:  Prompt Box Msg(\'NotAtPerch\') ;', '   8:  PALLETIZING-B_1 ;', '   9:  L P[1] 100mm/sec FINE MROT ;', '  10:  VISION GET_READING \'VP1\' SR[1] R[2] JMP LBL[9] ;', '/POS', '/END', ''].join('\n'));
    const optKw = (l: ReturnType<typeof tokenise>[number], text: string) => l.some(t => t.text.trim() === text && t.scopes.some(s => /^keyword|^support\.function|^entity|^storage\.modifier\.motion-option/.test(s)));
    const expect: Array<[number, string]> = [[2, 'LINE'], [3, 'Search Start'], [4, 'STOP_TRACKING'], [5, 'Weld Start'], [6, 'TORQ_LIMIT'], [7, 'SOFTFLOAT'], [8, 'Prompt Box Msg'], [9, 'PALLETIZING'], [10, 'MROT'], [11, 'GET_READING']];
    for (const [i, text] of expect) check(optKw(opt[i], text), `option syntax coloured: "${text}" in ${JSON.stringify(opt[i].map(t => [t.text, t.scopes.at(-1)]))}`);
    // the numberless styles: the body after the colon is coloured like any instruction
    const bare = tokenise('/PROG X\n/MN\n     :  !BANNER ;\n     :J P[1] 100% FINE ;\n     :  CALL SUB ;\n/POS\n/END\n');
    check(bare[2].some(t => /BANNER/.test(t.text) && t.scopes.some(s => s.startsWith('comment'))) && has(bare[3], 'J', 'keyword.control.motion.tp') && has(bare[4], 'CALL', 'keyword.control.call.tp'), `numberless colon lines are coloured as instructions: ${JSON.stringify([bare[2], bare[3]].map(l => l.map(t => [t.text, t.scopes[t.scopes.length - 1]])))}`);
    check(has(bare[2], ':', 'punctuation.separator.continuation.tp') && has(bare[3], ':', 'punctuation.separator.continuation.tp'), 'the scaffold/numberless colon carries the separator scope the themes paint like a numbered line');
    // '!' is the logical NOT operator inside an expression; only a '!' that opens the body is a remark
    const notOp = tokenise('/PROG X\n/MN\n   1:  IF (!F[103:RecoveryEnabled]),JMP LBL[900] ;\n   2:  !a real remark ;\n   3:  R[1]=!F[2] ;\n     :  !BANNER ;\n/POS\n/END\n');
    check(has(notOp[2], '!', 'keyword.operator.tp') && !notOp[2].some(t => t.text.includes('!') && t.scopes.some(s => s.startsWith('comment'))), `'!' before an I/O is NOT, not a comment: ${JSON.stringify(notOp[2].map(t => [t.text, t.scopes[t.scopes.length - 1]]))}`);
    check(has(notOp[2], 'F', 'support.type.io.tp') && has(notOp[2], 'JMP', 'keyword.control.jump.tp'), 'the IF expression after !F[..] still tokenises');
    check(has(notOp[3], '!a real remark', 'comment.line.exclamation.tp'), 'a remark that opens the body is still a comment');
    check(has(notOp[4], '!', 'keyword.operator.tp'), "'!' after '=' is the NOT operator");
    check(has(notOp[5], '!BANNER', 'comment.line.exclamation.tp'), 'a numberless remark line is still a comment');
  }
  // the leading ':' of a numberless / scaffold line is a separate scope from a numbered line's,
  // so every bundled theme must paint it the same colour or it reads as undecorated text
  for (const f of fs.readdirSync(path.join(root, 'themes')).filter(f => /color-theme\.json$/i.test(f))) {
    const t = JSON.parse(fs.readFileSync(path.join(root, 'themes', f), 'utf8'));
    const entry = (t.tokenColors ?? []).find((c: any) => (Array.isArray(c.scope) ? c.scope : [c.scope]).includes('punctuation.separator.line-number.tp'));
    const scopes: string[] = entry ? (Array.isArray(entry.scope) ? entry.scope : [entry.scope]) : [];
    check(scopes.includes('punctuation.separator.continuation.tp'), `${f}: the scaffold ':' is themed like a numbered line`);
  }
  const karel = await registry.loadGrammar('source.fanuc.karel');
  check(!!karel, 'KAREL grammar loads');
}

// ---------- .robocode containers: pure module checks ----------
{
  const cell = path.resolve(__dirname, '..', 'test', 'fixtures-cell');
  const robotA = path.join(cell, 'robotA');
  const robotB = path.join(cell, 'robotB');

  // --- parse robot.json ---
  const good = fs.readFileSync(path.join(robotA, ROBOT_DIR, ROBOT_JSON), 'utf8');
  const parsedA = parseRobotJson(good, robotA);
  check(!parsedA.errors.length || parsedA.errors.every(e => /Unknown key/.test(e)), `robotA parse: no errors`);
  check(parsedA.marker?.name === 'RobotA', `robotA name: ${parsedA.marker?.name}`);
  check(parsedA.marker?.programDirs?.length === 1, `robotA has 1 program dir: ${JSON.stringify(parsedA.marker?.programDirs)}`);
  check(parsedA.marker?.excludeDirs.length === 1, `robotA has 1 exclude dir`);
  check(parsedA.marker?.controller === 'RobotA', `robotA controller binding: ${parsedA.marker?.controller}`);

  const bad = parseRobotJson('{ "programs": 123 }', '/nope');
  check(bad.errors.length > 0, `bad robot.json caught: ${JSON.stringify(bad.errors)}`);

  const noName = parseRobotJson('{}', '/my/robotFolder');
  check(noName.marker?.name === 'robotFolder', `fallback name from folder: ${noName.marker?.name}`);

  const noPrograms = parseRobotJson('{ "name": "X" }', '/x');
  check(noPrograms.marker?.programDirs === undefined, `undefined programDirs = all subdirs`);

  // robot.json with controller field
  const withController = parseRobotJson('{ "name": "R1", "controller": "S002R01" }', '/r1');
  check(withController.marker?.controller === 'S002R01', `controller field parsed: ${withController.marker?.controller}`);
  check(!withController.errors.length, `no errors for valid controller field`);

  // robot.json with invalid controller type
  const badController = parseRobotJson('{ "controller": 123 }', '/r');
  check(badController.errors.some(e => /controller/.test(e)), `invalid controller type caught: ${JSON.stringify(badController.errors)}`);

  // robot.json with empty controller string (ignored)
  const emptyController = parseRobotJson('{ "controller": "" }', '/r');
  check(emptyController.marker?.controller === undefined, `empty controller ignored`);

  // parse cell.json with controllers
  const cellWithControllers = parseCellJson(JSON.stringify({
    name: 'My Cell',
    controllers: {
      'Robot1': { host: '10.0.0.1', device: 'MD:' },
      'Robot2': { host: '10.0.0.2', useFtp: true, ftpPort: 21 },
    }
  }), '/cell');
  check(cellWithControllers.cell?.name === 'My Cell', `cell name with controllers: ${cellWithControllers.cell?.name}`);
  check(Object.keys(cellWithControllers.cell?.controllers ?? {}).length === 2, `2 controllers parsed`);
  check(cellWithControllers.cell?.controllers['Robot1']?.host === '10.0.0.1', `Robot1 host`);
  check(cellWithControllers.cell?.controllers['Robot2']?.useFtp === true, `Robot2 useFtp`);
  check(!cellWithControllers.errors.length, `no errors for valid cell with controllers`);

  // cell.json with invalid controller (no host)
  const badCellControllers = parseCellJson(JSON.stringify({
    controllers: { 'Bad': { host: '' } }
  }), '/cell');
  check(badCellControllers.errors.some(e => /host/.test(badCellControllers.errors[0])), `missing host caught`);

  // cell.json with controllers as array (invalid)
  const arrayControllers = parseCellJson('{ "controllers": [] }', '/cell');
  check(arrayControllers.errors.length > 0, `array controllers caught`);

  // --- parse cell.json ---
  const cellText = fs.readFileSync(path.join(cell, CELL_DIR, CELL_JSON), 'utf8');
  const parsedCell = parseCellJson(cellText, cell);
  check(parsedCell.cell?.name === 'Test Cell', `cell name: ${parsedCell.cell?.name}`);
  check(Object.keys(parsedCell.cell?.controllers ?? {}).length === 2, `cell has 2 controllers: ${JSON.stringify(Object.keys(parsedCell.cell?.controllers ?? {}))}`);
  check(parsedCell.cell?.controllers['RobotA']?.host === '192.168.1.100', `cell RobotA host`);
  check(parsedCell.cell?.controllers['RobotB']?.useFtp === true, `cell RobotB useFtp`);

  const badCell = parseCellJson('not json', '/nope');
  check(badCell.errors.length > 0, `bad cell.json caught`);

  // --- classifyPath ---
  const markers = [parsedA.marker!, parseRobotJson(fs.readFileSync(path.join(robotB, ROBOT_DIR, ROBOT_JSON), 'utf8'), robotB).marker!].filter(Boolean) as RobotMarker[];

  // working: inside declared program dir
  check(classifyPath(path.join(robotA, 'LS', 'PROGA.LS'), markers) === 'working', 'A/LS/PROGA = working');

  // working: default programs (robotB, no programs field — all subdirs)
  check(classifyPath(path.join(robotB, 'PROGB.LS'), markers) === 'working', 'B root PROGB = working');

  // reference: inside snapshot
  check(classifyPath(path.join(robotA, ROBOT_DIR, SNAPSHOT_DIR, 'PROGA.LS'), markers) === 'reference', 'A/snapshot/PROGA = reference');

  // excluded: inside backups/ (excluded dir)
  check(classifyPath(path.join(robotA, 'backups', 'numreg.va'), markers) === 'excluded', 'A/backups/numreg.va = excluded');

  // excluded: inside .robocode-robot/ itself
  check(classifyPath(path.join(robotA, ROBOT_DIR, 'robot.json'), markers) === 'excluded', 'A/robot.json = excluded');

  // unmanaged: no marker matches
  check(classifyPath(path.join(cell, 'unmanaged', 'LOOSE.LS'), markers) === 'unmanaged', 'unmanaged/LOOSE = unmanaged');

  // cell container dir: not under any robot marker → unmanaged (not indexed by program watcher anyway)
  check(classifyPath(path.join(cell, CELL_DIR, 'cell.json'), markers) === 'unmanaged', 'cell.json = unmanaged');

  // robotA with programs=[] (empty) vs undefined
  const emptyPrograms = parseRobotJson('{ "programs": [] }', '/r');
  check(emptyPrograms.marker?.programDirs?.length === 0, `empty programs array = nothing working`);
  check(classifyPath('/r/any.ls', [emptyPrograms.marker!]) === 'excluded', 'empty programs → all excluded');

  // --- overlap detection ---
  const nested = parseRobotJson('{}', path.join(robotA, 'LS'));
  const overlapWarnings = markersWithOverlap([parsedA.marker!, nested.marker!]);
  check(overlapWarnings.length === 1 && /contains/.test(overlapWarnings[0]), `overlap detected: ${JSON.stringify(overlapWarnings)}`);

  // no overlap when markers don't nest
  check(markersWithOverlap(markers).length === 0, 'no overlap between robotA and robotB');

  // --- markerOf ---
  check(markerOf(path.join(robotA, 'LS', 'PROGA.LS'), markers)?.name === 'RobotA', 'markerOf A/LS = RobotA');
  check(markerOf(path.join(robotB, 'PROGB.LS'), markers)?.name === 'RobotB', 'markerOf B root = RobotB');
  check(markerOf(path.join(cell, 'unmanaged', 'LOOSE.LS'), markers) === undefined, 'markerOf unmanaged = undefined');

  // deeper marker wins (nested)
  check(markerOf(path.join(robotA, 'LS', 'test.ls'), [parsedA.marker!, nested.marker!])?.name === 'LS', 'deeper marker wins');

  // --- underPath ---
  check(underPath('/a/b/c', '/a/b'), 'underPath child');
  check(underPath('/a/b', '/a/b'), 'underPath equal');
  check(!underPath('/a/b', '/a/b/c'), 'underPath not reversed');
  check(underPath('/a/B/c', '/a/b'), 'underPath case-insensitive');

  // --- ranking comparator ---
  const inWs = (uri: string) => uri.startsWith('/workspace/');
  const cmp = buildRankComparator('/workspace/robotA', inWs);
  const working = { group: '/workspace/robotA', kind: 'tp' as const, mtime: 100, uri: '/workspace/robotA/LS/PROGA.LS' };
  const reference = { group: '/workspace/robotA', kind: 'tp' as const, reference: true, mtime: 200, uri: '/workspace/robotA/.robocode-robot/snapshot/PROGA.LS' };
  const binary = { group: '/workspace/robotA', kind: 'binary' as const, mtime: 50, uri: '/workspace/robotA/.robocode-robot/snapshot/PROGA.TP' };
  const crossGroup = { group: '/workspace/robotB', kind: 'tp' as const, mtime: 300, uri: '/workspace/robotB/PROGB.LS' };

  check(cmp(working, reference) < 0, 'working beats reference');
  check(cmp(reference, binary) < 0, 'reference beats binary');
  check(cmp(working, crossGroup) < 0, 'same group beats cross-group');
  check(cmp(reference, crossGroup) < 0, 'reference still beats cross-group');
  // newest tie-break: same rank, newer mtime wins
  const ref2 = { ...reference, mtime: 50 };
  check(cmp(reference, ref2) < 0, 'newer reference beats older reference');

  // --- normalizeTpForCompare ---
  const numbered = '/PROG  T\n/MN\n   1:  R[1]=1 ;\n   2:  J P[1] 100% FINE ;\n/POS\n/END\n';
  const numberless = '/PROG  T\n/MN\n    :  R[1]=1\n    :J P[1] 100% FINE\n/POS\n/END\n';
  const nNorm = normalizeTpForCompare(numbered);
  const nnNorm = normalizeTpForCompare(numberless);
  check(nNorm === nnNorm, `numbered ≡ numberless after normalize:\n  numbered:  ${JSON.stringify(nNorm)}\n  numberless:${JSON.stringify(nnNorm)}`);

  // LINE_COUNT blanked
  const withLc = '/PROG  T\n/ATTR\nLINE_COUNT\t= 5;\n/MN\n   1:  R[1]=1 ;\n/POS\n/END\n';
  const lcNorm = normalizeTpForCompare(withLc);
  check(lcNorm.includes('LINE_COUNT = #'), `LINE_COUNT blanked: ${JSON.stringify(lcNorm)}`);

  // --eg: extended comments stripped
  const eg = '/PROG  T\n/MN\n   1:  --eg:one line only ;\n   2:  R[1]=1 ;\n/POS\n/END\n';
  const egNorm = normalizeTpForCompare(eg);
  check(egNorm.includes('--eg:one line only'), 'eg comment preserved');

  // inserted line = exactly 1 diff
  const base = '/PROG  T\n/MN\n   1:  R[1]=1 ;\n   2:  R[2]=2 ;\n/POS\n/END\n';
  const inserted = '/PROG  T\n/MN\n   1:  R[1]=1 ;\n   2:  R[5]=5 ;\n   3:  R[2]=2 ;\n/POS\n/END\n';
  const diff = lineDiffCount(normalizeTpForCompare(base), normalizeTpForCompare(inserted));
  check(diff.changed === 0 && diff.added === 1 && diff.deleted === 0, `insert = 1 add: ${JSON.stringify(diff)}`);

  // renumber only = 0 diff
  const restyled = '/PROG  T\n/MN\n    :  R[1]=1\n    :  R[2]=2\n/POS\n/END\n';
  const diffRenumber = lineDiffCount(normalizeTpForCompare(base), normalizeTpForCompare(restyled));
  check(diffRenumber.changed === 0 && diffRenumber.added === 0 && diffRenumber.deleted === 0, `renumber = 0 diff: ${JSON.stringify(diffRenumber)}`);

  // hash stability: CRLF vs LF
  const crlf = numbered.replace(/\n/g, '\r\n');
  check(normalizedTextHash(numbered, 'tp') === normalizedTextHash(crlf, 'tp'), 'hash: CRLF stable');

  // hash differs on real change
  const changed = '/PROG  T\n/MN\n   1:  R[1]=999 ;\n   2:  R[2]=2 ;\n/POS\n/END\n';
  check(normalizedTextHash(base, 'tp') !== normalizedTextHash(changed, 'tp'), 'hash differs on real change');

  // --- round-trip compare: the controller's own metadata churn is not a difference ---
  const sent = '/PROG  T\n/ATTR\nCREATE\t= DATE 26-09-16  TIME 13:54:00;\nMODIFIED\t= DATE 26-09-16  TIME 13:54:00;\nPROG_SIZE\t= 1601;\nLINE_COUNT\t= 2;\n/MN\n   1:  R[1]=1 ;\n   2:  R[2]=2 ;\n/POS\n/END\n';
  const readBack = sent.replace('26-09-16', '26-09-28').replace('PROG_SIZE\t= 1601', 'PROG_SIZE\t= 1787').replace('LINE_COUNT\t= 2', 'LINE_COUNT\t= 2');
  const rt = roundTripCompare(readBack, sent, 'tp');
  check(rt.equal && rt.metadataOnly, `roundTripCompare: a re-stamped DATE/size is 'metadata only' (${JSON.stringify(rt)})`);
  check(roundTripCompare(sent, sent, 'tp').equal && !roundTripCompare(sent, sent, 'tp').metadataOnly, 'roundTripCompare: identical text is equal, not metadata-only');
  const realEdit = sent.replace('R[2]=2', 'R[2]=9');
  check(!roundTripCompare(realEdit, sent, 'tp').equal, 'roundTripCompare: a real instruction change is not equal');
  check(stripTpMetadata(readBack) === stripTpMetadata(sent), 'stripTpMetadata: blanks CREATE/MODIFIED/PROG_SIZE/LINE_COUNT values');
  // a V9.40 controller (ROBOGUIDE, 2026-10-01) adds LOCAL_REGISTERS to a program sent without it
  // and pads the terminator: same program
  const v940 = readBack.replace('LINE_COUNT\t= 2;\n', 'LINE_COUNT\t= 2;\nLOCAL_REGISTERS\t= 0,0,0;\n').replace('R[1]=1 ;', 'R[1]=1    ;');
  const rtLocal = roundTripCompare(v940, sent, 'tp');
  check(rtLocal.equal && rtLocal.metadataOnly, `roundTripCompare: LOCAL_REGISTERS added by the controller is not a change (${JSON.stringify(rtLocal)})`);
  const withLocal = sent.replace('LINE_COUNT\t= 2;\n', 'LINE_COUNT\t= 2;\nLOCAL_REGISTERS\t= 0,0,0;\n');
  check(!roundTripCompare(withLocal.replace('0,0,0', '2,0,0'), withLocal, 'tp').equal, 'roundTripCompare: a LOCAL_REGISTERS value changed on both sides still counts');
  check(roundTripCompare(sent, sent, 'karel').equal, 'roundTripCompare: KAREL identical');

  // --- controller options (MD:ORDERFIL.DAT, as ROBOGUIDE V9.40 writes it) ---
  const order = '! Generated by PCMCIA 9.40188.7 for F00000    \r\n! on DESKTOP    \r\n1A05B-2600-H552 ! HandlingTool         \r\n1A05B-2600-R796 ! Ascii Program Loader \r\n1A05B-2600-R507 ! Ascii Upload         \r\n1A05B-2600-FVRC ! Virtual Robot        \r\n';
  const opts = parseOrderFile(order);
  check(opts.length === 4 && opts[2].code === 'R507' && opts[2].name === 'Ascii Upload' && opts[3].code === 'FVRC', `parseOrderFile: options read, comments skipped: ${JSON.stringify(opts)}`);
  check(hasOption(opts, ASCII_UPLOAD) && !hasOption(parseOrderFile(order.replace(/^.*R507.*\r\n/m, '')), ASCII_UPLOAD), 'hasOption: Ascii Upload found when listed, missing when not');
  // ROBOGUIDE V9.40 SpotTool+ (2026-10-01) has R796 and no R507, and compiled a .LS sent over FTP:
  // either option is enough. The trailing "Z" line that cell's file ends with is not an option.
  const r796only = parseOrderFile(order.replace(/^.*R507.*\r\n/m, '') + 'Z\r\n');
  check(canLoadAscii(opts) && canLoadAscii(r796only) && r796only.length === 3, `canLoadAscii: R507 or R796 is enough (${r796only.map(o => o.code).join(',')})`);
  check(!canLoadAscii(parseOrderFile(order.replace(/^.*R507.*\r\n/m, '').replace(/^.*R796.*\r\n/m, ''))), 'canLoadAscii: neither R507 nor R796 -> cannot load a .LS');
  // the options card / page highlights, on the new SpotTool+ cell's real list (excerpt)
  const spot = parseOrderFile('1A05B-2600-H590 ! SpotTool+            \r\n1A05B-2600-H521 ! English Dictionary   \r\n1A05B-2600-R796 ! Ascii Program Loader \r\n1A05B-2600-R632 ! KAREL                \r\n1A05B-2600-R641 ! PC Interface         \r\n1A05B-2600-R648 ! User Socket Msg      \r\n1A05B-2600-FVRC ! Virtual Robot        \r\n1A05B-2600-H727 ! R-2000iC/210L        \r\nZ\r\n');
  const hl = optionHighlights(spot);
  const byLabel = (l: string) => hl.find(h => h.label === l);
  check(hl[0].label === 'SpotTool+ · R-2000iC/210L' && hl[0].ok === undefined && !/Dictionary/.test(hl[0].label), `optionHighlights: application + model first, no dictionary: ${hl[0].label}`);
  check(byLabel('Loads .LS programs')?.ok === true && /R796/.test(byLabel('Loads .LS programs')!.detail) && !/R507/.test(byLabel('Loads .LS programs')!.detail), `optionHighlights: .LS via R796 only: ${byLabel('Loads .LS programs')?.detail}`);
  check(byLabel('KAREL')?.ok === true && byLabel('PC Interface')?.ok === true && byLabel('Socket Messaging')?.ok === true, 'optionHighlights: KAREL, PC Interface, Socket Messaging found');
  const bare = optionHighlights(parseOrderFile('1A05B-2600-H552 ! HandlingTool         \r\n'));
  check(bare.find(h => h.label === 'Loads .LS programs')?.ok === false && bare.find(h => h.label === 'KAREL')?.ok === false, 'optionHighlights: missing options are marked missing');

  // the CALL list shows a FANUC program only when its option is installed (List 5, item 1)
  const optCell = parseOrderFile('1A05B-2600-H590 ! SpotTool+\r\n1A05B-2600-R902 ! 3DV Guidance Plus\r\n1A05B-2600-J684 ! Collision Guard Pack\r\n1A05B-2600-J753 ! DeviceNet Interface\r\n');
  const inst = (l: string) => catalogOptionInstalled(l, optCell);
  check(inst('R902 iRVision Bin Picking (3DV)') && !inst('R726 iRCalibration Signature'), 'catalogOptionInstalled: by order code');
  check(inst('iRVision (base: 2DV J901 / 3DL J902 / 3DV J914)') === false && catalogOptionInstalled('iRVision (base: 2DV J901 / 3DL J902 / 3DV J914)', parseOrderFile('1A05B-2600-J902 ! 3DL Vision\r\n')), 'catalogOptionInstalled: any of several codes');
  check(!inst('S521 iRPickTool/External Machine Vision Interface Add-on (needs R648 User Socket Messaging)') && !catalogOptionInstalled('S521 x (needs R648 y)', parseOrderFile('1A05B-2600-R648 ! User Socket Msg\r\n')), 'catalogOptionInstalled: a prerequisite code alone is not the option');
  check(inst('Collision Guard (Collision Skip)') && inst('DeviceNet') && !inst('PalletTool') && !inst('Force Control Deburring package'), 'catalogOptionInstalled: by name when the text has no code');

  // --- connection hints: the likely cause of a failed robot request ---
  const http = { useFtp: false }, ftp = { useFtp: true };
  const hints: Array<[string, { useFtp: boolean }, RegExp | undefined]> = [
    ['connect ECONNREFUSED 10.0.0.5:80', http, /web server enabled/],
    ['connect ECONNREFUSED 10.0.0.5:21', ftp, /FTP enabled/],
    ['connect ETIMEDOUT 10.0.0.5:80', http, /No answer/],
    ['connect EHOSTUNREACH 10.0.0.5:80', http, /No answer/],
    ['request timed out after 10000 ms', http, /No answer/],
    ['getaddrinfo ENOTFOUND robot1', http, /Use the IP address/],
    ['read ECONNRESET', http, /dropped the connection/],
    ['socket hang up', http, /dropped the connection/],
    ['HTTP 403 for MD:PROG.LS', http, /refused the file/],
    ['530 Login incorrect', ftp, /login failed/],
    ['FTP STOR failed: 550 Could not store file', ftp, /Ascii Upload \(R507\)/],
    ['FTP RETR failed: 550 File not found', ftp, /no file of that name/],
    ['FTP connection closed', ftp, /dropped the connection/],
    // ROBOGUIDE V9.40's actual reply for a write-protected program (2026-10-01)
    ['FTP STOR failed: 550 Protection error occurred.', ftp, /write-protected.*Write protect OFF/],
    ['FTP STOR failed: 550 Specified program is in use.', ftp, /selected, running or paused.*ABORT ALL/],
    ['something nobody has seen', http, undefined],
  ];
  for (const [err, p, want] of hints) {
    const h = connectionHint(err, p);
    check(want ? !!h && want.test(h) : h === undefined, `connectionHint(${JSON.stringify(err)}): ${h ?? 'none'}`);
  }
  // a metadata line with no ";" must stop at the newline, not swallow the rest of the file
  check(stripTpMetadata('LINE_COUNT = 3\n/MN\n   1:  R[1]=1 ;\n') === 'LINE_COUNT = #\n/MN\n   1:  R[1]=1 ;\n', `stripTpMetadata: no ";" still ends at the line (${JSON.stringify(stripTpMetadata('LINE_COUNT = 3\n/MN\n   1:  R[1]=1 ;\n'))})`);
  // a renumber is not a round-trip difference (line numbers are normalized away)
  const renumA = '/PROG  T\n/MN\n   1:  R[1]=1 ;\n   2:  R[2]=2 ;\n/POS\n/END\n';
  const renumB = '/PROG  T\n/MN\n   5:  R[1]=1 ;\n   9:  R[2]=2 ;\n/POS\n/END\n';
  check(roundTripCompare(renumA, renumB, 'tp').equal && !roundTripCompare(renumA, renumB, 'tp').metadataOnly, 'roundTripCompare: a renumber is not a difference');

  // KAREL normalization (CRLF + trailing ws only)
  const kl = 'PROGRAM test\nBEGIN\n  x = 1 \nEND test\n';
  const klCrlf = kl.replace(/\n/g, '\r\n');
  check(normalizeKarelForCompare(kl) === normalizeKarelForCompare(klCrlf), 'KAREL hash: CRLF stable');

  // --- snapshot helpers ---
  const tmpCell = path.join(os.tmpdir(), `rc-test-cell-${Date.now()}`);
  try {
    // copySnapshot
    const srcDir = path.join(tmpCell, 'src');
    const destDir = path.join(tmpCell, 'dest');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'a.txt'), 'hello');
    fs.mkdirSync(path.join(srcDir, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'sub', 'b.txt'), 'world');
    const count = copySnapshot(srcDir, destDir);
    check(count === 2, `copySnapshot copied ${count} files`);
    check(fs.readFileSync(path.join(destDir, 'a.txt'), 'utf8') === 'hello', 'copySnapshot: file content');
    check(fs.readFileSync(path.join(destDir, 'sub', 'b.txt'), 'utf8') === 'world', 'copySnapshot: nested file');

    // writeProvenance / readProvenance
    const prov = { date: '2026-09-18', source: { kind: 'backup' as const, path: '/src' }, fileCount: 42 };
    writeProvenance(destDir, prov);
    const readBack = readProvenance(destDir);
    check(readBack?.date === '2026-09-18', `provenance date: ${readBack?.date}`);
    check(readBack?.fileCount === 42, `provenance fileCount: ${readBack?.fileCount}`);
    check(readBack === undefined || typeof readBack.source === 'object', 'provenance source shape');

    // copySnapshot atomicity: old content survives failed copy
    fs.writeFileSync(path.join(destDir, 'a.txt'), 'original');
    try {
      copySnapshot(path.join(tmpCell, 'nonexistent'), destDir);
      check(false, 'should have thrown');
    } catch {
      check(fs.readFileSync(path.join(destDir, 'a.txt'), 'utf8') === 'original', 'atomic: failed copy preserves old');
    }
  } finally {
    fs.rmSync(tmpCell, { recursive: true, force: true });
  }

  // --- real fixture tree ---
  check(classifyPath(path.join(robotA, 'LS', 'PROGA.LS'), markers) === 'working', 'fixture: A working');
  check(classifyPath(path.join(robotA, ROBOT_DIR, SNAPSHOT_DIR, 'PROGA.LS'), markers) === 'reference', 'fixture: A snapshot = reference');
  check(classifyPath(path.join(robotA, 'backups', 'numreg.va'), markers) === 'excluded', 'fixture: A backup excluded');
  check(classifyPath(path.join(robotB, 'PROGB.LS'), markers) === 'working', 'fixture: B working');

  console.log(`  containers: ${checksRun} checks passed (module, classify, rank, normalize, snapshot)`);
}

// ---------- alarm codes (R-30iB Plus Error Code Manual): FILE-014 by name, and as the KAREL status 2014 ----------
{
  check(alarmFacilities().FILE === 2, `facility map: FILE = ${alarmFacilities().FILE}`);
  const byName = lookupAlarm('FILE-014');
  check(byName?.id === 'FILE-014' && byName.facility === 'FILE' && byName.number === 14 && byName.code === 2014 && /File not found/.test(byName.message) && !!byName.cause && !!byName.remedy, `FILE-014 by name: ${JSON.stringify(byName)}`);
  check(lookupAlarm('file-014')?.id === 'FILE-014' && lookupAlarm('FILE-14')?.id === 'FILE-014', 'lower case and unpadded spellings find FILE-014');
  check(lookupAlarm(2014)?.id === 'FILE-014' && lookupAlarm('2014')?.id === 'FILE-014', 'the KAREL status 2014 is FILE-014');
  check(lookupAlarm(43001)?.id === 'RPM-001', `five digits: 43001 = RPM-001: ${lookupAlarm(43001)?.id}`);
  check(lookupAlarm('FILE-999') === undefined && lookupAlarm(999999) === undefined && lookupAlarm('nonsense') === undefined, 'an unknown code is undefined');
  const md = alarmMarkdownLines(byName!);
  check(md[0].startsWith('**FILE-014**') && md.some(l => l.startsWith('**Cause:**')) && md.some(l => l.startsWith('**Remedy:**')), `hover lines: ${md.join(' | ')}`);
  check(alarmMarkdownLines({ id: 'X-001', facility: 'X', number: 1, message: 'a*b_c' })[0].endsWith('a\\*b\\_c'), 'markdown specials in manual text are escaped');
}

console.log(failures ? `\n${failures} FAILURE(S) of ${checksRun} checks` : `\nALL ${checksRun} CHECKS PASSED`);
process.exit(failures ? 1 : 0);
})();
