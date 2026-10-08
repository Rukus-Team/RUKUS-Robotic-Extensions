/**
 * The linter: .robotlint.json, the rule catalog, each language's style rules, Lint Folder's
 * engine on a scratch folder, robot-lint's exit codes, the shipped schema, and both corpora
 * (programs that run on real controllers: no style rule may call one an error).
 * Wired in by test/run.ts: `run(check, fanucRoot)`.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseLintConfig, ruleSetting, settingsFor, applyLintConfig, globToRegExp, isLintIgnored, findLintConfig, LINT_STARTER_CONFIG } from '@core/lint/config';
import { lintPaths, lintTotals } from '@core/lint/engine';
import { formatLintJson, formatLintSarif, formatLintText, lintConfigSchema } from '@core/lint/format';
import { lintRule, lintRules, DEFAULT_SETTINGS, type LintFinding } from '@core/lint/types';
import { registerFanucLint } from '@fanuc/lint';
import { registerAbbLint } from '@abb/lint';
import { parseTp } from '@fanuc/tp/parser';
import { tpChecks } from '@fanuc/tp/checks';
import { parseKarel } from '@fanuc/karel/parser';
import { karelChecks } from '@fanuc/karel/checks';
import { parseRapid } from '@abb/rapid/parser';
import { rapidStyleChecks } from '@abb/rapid/style';
import { main as robotLint } from '../src/lintCliMain';
import { findCorpus } from './rapid.test';

type Check = (cond: unknown, msg: string) => void;
const codes = (xs: LintFinding[]) => xs.map(x => x.code);
const has = (xs: LintFinding[], code: string) => xs.some(x => x.code === code);

const TP = [
  '/PROG  PICK',
  '/ATTR',
  'COMMENT\t\t= "";',
  'LINE_COUNT\t= 6;',
  '/MN',
  '   1:  !TODO check the gripper ;',
  '   2:  WAIT DI[1:Part present]=ON    ;',
  '   3:  WAIT DI[2]=ON TIMEOUT,LBL[1] ;',
  '   4:  WAIT   1.50(sec) ;',
  '   5:J P[1] 100% FINE    ;',
  '   6:  LBL[1] ;',
  '/POS',
  'P[1]{',
  '   GP1:',
  '\tUF : 0, UT : 1,\t\tCONFIG : \'N U T, 0, 0, 0\',',
  '\tX =   100.000  mm,\tY =     0.000  mm,\tZ =   100.000  mm,',
  '\tW =   180.000 deg,\tP =     0.000 deg,\tR =     0.000 deg',
  '};',
  '/END',
].join('\n');

const KL = [
  'PROGRAM tidy',
  '%NOLOCKGROUP',
  'VAR',
  '  n : INTEGER',
  'BEGIN',
  '  -- FIXME remove the counter',
  '  n = 1',
  '  if n = 1 then',
  '    n = 2',
  '  endif',
  'END tidy',
].join('\n');

const RAPID = [
  'MODULE Tidy',
  '  LOCAL VAR num nUnused := 0;',
  '  LOCAL VAR num nUsed := 0;',
  '  CONST robtarget Home := [[0,0,0],[1,0,0,0],[0,0,0,0],[9E9,9E9,9E9,9E9,9E9,9E9]];',
  '  PROC main()',
  '    WaitDI di1, 1;',
  '    WaitDI di1, 1 \\MaxTime:=5;',
  '    WaitUntil nUsed > 1',
  '      \\MaxTime:=3;',
  '    WaitUntil nUsed > 2;',
  '    BREAK;',
  '    MoveL *, v100, z10, tool0;',
  '    MoveL Home, v100, fine, tool0;',
  '    ! TODO fix the approach',
  '  ENDPROC',
  'ENDMODULE',
].join('\n');

export function run(check: Check, fanucRoot?: string): void {
  registerFanucLint();
  registerAbbLint();

  // ---------- the rule catalog ----------
  const all = lintRules();
  check(all.length > 60 && new Set(all.map(r => r.code)).size === all.length, `the catalog has every rule once (${all.length})`);
  for (const lang of ['fanuc-tp', 'fanuc-karel', 'abb-rapid']) check(lintRules(lang).some(r => r.kind === 'style') && lintRules(lang).some(r => r.kind === 'check'), `${lang} has check and style rules`);
  check(all.every(r => r.kind === 'check' || r.code.includes('.style.')), 'every style rule is named <language>.style.<rule>');
  check(all.filter(r => r.kind === 'style').every(r => r.defaultSeverity !== 'error'), 'no style rule is an error by default');

  // ---------- .robotlint.json ----------
  const cfg = parseLintConfig(`{
    // comments are allowed, as in VS Code settings
    "rules": {
      "tp.unusedLabel": "off",
      "tp.style.*": "warning",
      "tp.style.programLength": ["error", { "max": 3 }],
      "*": "info",
      "tp.notARule": "hint",
      "tp.style.todo": "loud"
    },
    "ignore": ["old/**", "*_bak.ls"]
  }`, path.join('C:', 'cell', '.robotlint.json'));
  check(cfg.problems.length === 2 && cfg.problems.some(p => p.includes('tp.notARule')) && cfg.problems.some(p => p.includes('"loud"')), `config problems reported: ${cfg.problems.join(' | ')}`);
  check(ruleSetting(cfg, 'tp.unusedLabel') === 'off', 'an exact code wins');
  check(ruleSetting(cfg, 'tp.style.waitTimeout') === 'warning', 'a prefix.* applies');
  check(JSON.stringify(ruleSetting(cfg, 'tp.style.programLength')) === '["error",{"max":3}]', 'an exact code wins over its prefix');
  check(ruleSetting(cfg, 'rapid.syntax') === 'info', '"*" is the fallback for everything');
  const s = settingsFor(cfg);
  check(!s.enabled('tp.unusedLabel') && s.enabled('tp.style.fixedWait') && s.option<number>('tp.style.programLength', 'max', 500) === 3, 'settings: off, an off-by-default rule turned on, an option');
  check(DEFAULT_SETTINGS.enabled('tp.style.waitTimeout') && !DEFAULT_SETTINGS.enabled('tp.style.fixedWait') && DEFAULT_SETTINGS.option<number>('tp.style.programLength', 'max', 0) === 500, 'defaults: on/off and option defaults come from the catalog');
  const applied = applyLintConfig([
    { code: 'tp.unusedLabel', message: '', severity: 'hint', span: { line: 0, col: 0, len: 0 } },
    { code: 'tp.style.waitTimeout', message: '', severity: 'hint', span: { line: 0, col: 0, len: 0 } },
    { code: 'tp.undefinedLabel', message: '', severity: 'error', span: { line: 0, col: 0, len: 0 } },
  ], cfg);
  check(applied.length === 2 && applied[0].severity === 'warning' && applied[1].severity === 'info', `config applied: ${JSON.stringify(applied.map(a => a.code + ':' + a.severity))}`);
  check(applyLintConfig([{ code: 'tp.style.fixedWait', message: '', severity: 'hint', span: { line: 0, col: 0, len: 0 } }], parseLintConfig('{}')).length === 0, 'an off-by-default rule is dropped without a config');
  check(parseLintConfig('not json').problems.length === 1 && parseLintConfig('[]').problems.length === 1, 'bad config files are reported, not thrown');
  check(parseLintConfig(LINT_STARTER_CONFIG).problems.length === 0, 'the starter config is valid');
  check(globToRegExp('*_bak.ls').test('a/b/x_bak.ls') && globToRegExp('old/**').test('old/x/y.ls') && !globToRegExp('old/**').test('older/y.ls') && globToRegExp('**/TASK?/*.mod').test('RAPID/TASK1/m.mod'), 'glob patterns');
  check(isLintIgnored(cfg, path.join('C:', 'cell', 'old', 'p.ls')) && isLintIgnored(cfg, path.join('C:', 'cell', 'r1', 'MAIN_bak.ls')) && !isLintIgnored(cfg, path.join('C:', 'cell', 'r1', 'MAIN.ls')), 'ignore is relative to the config file');

  // ---------- TP ----------
  const tp = tpChecks(TP, parseTp(TP));
  check(has(tp, 'tp.style.programComment') && has(tp, 'tp.style.todo'), `TP: empty COMMENT and TODO found: ${codes(tp).join(' ')}`);
  const waits = tp.filter(f => f.code === 'tp.style.waitTimeout');
  check(waits.length === 1 && waits[0].span.line === 6, `TP: only the WAIT without TIMEOUT is flagged: ${JSON.stringify(waits.map(w => w.span))}`);
  check(!has(tp, 'tp.style.fixedWait') && !has(tp, 'tp.style.programLength'), 'TP: rules that are off by default stay quiet');
  const tpOn = tpChecks(TP, parseTp(TP), { settings: settingsFor(parseLintConfig('{"rules":{"tp.style.*":"hint","tp.style.programLength":["hint",{"max":3}],"tp.unusedLabel":"off"}}')) });
  check(['tp.style.fixedWait', 'tp.style.programLength', 'tp.style.uncommentedIo', 'tp.style.frameSelect'].every(c => has(tpOn, c)), `TP: style rules turned on fire: ${codes(tpOn).join(' ')}`);
  check(tpOn.filter(f => f.code === 'tp.style.uncommentedIo').length === 1, 'TP: only DI[2] (no comment) is uncommented I/O');
  check(!has(tpOn, 'tp.unusedLabel'), 'TP: a rule turned off is not even computed');
  const tpCall = tpChecks('/PROG A\n/MN\n   1:  CALL B ;\n   2:  CALL C ;\n/END\n', parseTp('/PROG A\n/MN\n   1:  CALL B ;\n   2:  CALL C ;\n/END\n'), { calls: { resolve: n => (n === 'B' ? 'found' : 'missing') } });
  check(tpCall.filter(f => f.code === 'tp.missingProgram').length === 1, 'TP: a CALL is missing only when the robot does not have the program');

  // ---------- KAREL ----------
  const kl = karelChecks(parseKarel(KL));
  check(has(kl, 'karel.style.programComment') && has(kl, 'karel.style.todo') && !has(kl, 'karel.style.keywordCase'), `KAREL: %COMMENT and FIXME found, keyword case off by default: ${codes(kl).join(' ')}`);
  const klOn = karelChecks(parseKarel(KL), { settings: settingsFor(parseLintConfig('{"rules":{"karel.style.keywordCase":"hint","karel.style.routineLength":["hint",{"max":3}]}}')) });
  check(klOn.filter(f => f.code === 'karel.style.keywordCase').length === 3, `KAREL: if / then / endif in lower case: ${klOn.filter(f => f.code === 'karel.style.keywordCase').length}`);
  check(has(klOn, 'karel.style.routineLength'), 'KAREL: a main body over the limit');
  check(karelChecks(parseKarel(KL), { fsPath: path.join('x', 'other.kl') }).some(f => f.code === 'karel.fileName'), 'KAREL: file name check needs the path');

  // ---------- RAPID ----------
  const mod = parseRapid(RAPID);
  const rs = rapidStyleChecks(mod, DEFAULT_SETTINGS);
  const rw = rs.filter(f => f.code === 'rapid.style.waitTimeout');
  check(rw.length === 2 && rw[0].span.line === 5 && rw[1].span.line === 9, `RAPID: WaitDI/WaitUntil without \\MaxTime, also across lines: ${JSON.stringify(rw.map(w => w.span.line))}`);
  check(rs.filter(f => f.code === 'rapid.style.unusedLocalData').map(f => mod.lines[f.span.line].trim()).join() === 'LOCAL VAR num nUnused := 0;', 'RAPID: the unused LOCAL data only');
  check(has(rs, 'rapid.style.breakInstruction') && has(rs, 'rapid.style.todo') && !has(rs, 'rapid.style.inlineTarget') && !has(rs, 'rapid.style.dataNaming'), `RAPID: BREAK and TODO; opinionated rules off: ${codes(rs).join(' ')}`);
  const rsOn = rapidStyleChecks(mod, settingsFor(parseLintConfig('{"rules":{"rapid.style.inlineTarget":"hint","rapid.style.dataNaming":["hint",{"robtarget":"p"}],"rapid.style.routineLength":["hint",{"max":5}]}}')));
  check(has(rsOn, 'rapid.style.inlineTarget') && rsOn.some(f => f.code === 'rapid.style.dataNaming' && f.message.includes('Home')) && has(rsOn, 'rapid.style.routineLength'), `RAPID: inline target, naming, routine length when on: ${codes(rsOn).join(' ')}`);

  // ---------- the engine on a scratch folder, and robot-lint ----------
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'robot-lint-'));
  try {
    fs.mkdirSync(path.join(dir, 'R1'));
    fs.mkdirSync(path.join(dir, 'old'));
    fs.writeFileSync(path.join(dir, 'R1', 'PICK.ls'), TP, 'latin1');
    fs.writeFileSync(path.join(dir, 'R1', 'tidy.kl'), KL, 'latin1');
    fs.writeFileSync(path.join(dir, 'R1', 'Tidy.mod'), RAPID, 'latin1');
    fs.writeFileSync(path.join(dir, 'R1', 'BAD.ls'), '/PROG BAD\n/MN\n   1:  JMP LBL[9] ;\n/END\n', 'latin1');
    fs.writeFileSync(path.join(dir, 'old', 'OLD.ls'), '/PROG OLD\n/MN\n   1:  JMP LBL[9] ;\n/END\n', 'latin1');
    fs.writeFileSync(path.join(dir, '.robotlint.json'), '{ "rules": { "tp.style.todo": "off", "rapid.style.breakInstruction": "error" }, "ignore": ["old/**"] }');
    const r = lintPaths([dir]);
    const by = (name: string) => r.files.find(f => path.basename(f.path) === name)!;
    check(r.files.length === 4 && r.ignored === 1, `engine: 4 files linted, old/ ignored (${r.files.length}, ${r.ignored})`);
    check(by('PICK.ls').language === 'fanuc-tp' && by('tidy.kl').language === 'fanuc-karel' && by('Tidy.mod').language === 'abb-rapid', 'engine: each file to its language');
    check(!has(by('PICK.ls').findings, 'tp.style.todo') && by('Tidy.mod').findings.some(f => f.code === 'rapid.style.breakInstruction' && f.severity === 'error'), 'engine: the folder\'s .robotlint.json applies');
    check(r.configs.length === 1 && findLintConfig(path.join(dir, 'R1')).file === path.join(dir, '.robotlint.json'), 'engine: the nearest config above the file');
    const t = lintTotals(r);
    check(t.error === 2, `engine: the undefined label and the BREAK raised to error (${t.error})`);
    const text = formatLintText(r, { base: dir });
    check(/R1[\\/]BAD\.ls:3:\d+: error tp\.undefinedLabel:/.test(text) && /4 files linted \(1 ignored\): 2 errors/.test(text), `text report: ${text.split('\n').slice(-2).join(' / ')}`);
    const json = JSON.parse(formatLintJson(r));
    check(json.totals.error === 2 && json.files.every((f: any) => f.findings.every((x: any) => x.line >= 1 && x.column >= 1)), 'JSON report: 1-based lines and columns');
    const sarif = JSON.parse(formatLintSarif(r, { name: 'robot-lint', version: 't' }));
    check(sarif.version === '2.1.0' && sarif.runs[0].results.length === json.files.reduce((n: number, f: any) => n + f.findings.length, 0) && sarif.runs[0].tool.driver.rules.every((x: any) => lintRule(x.id)), 'SARIF report: every finding, every rule described');

    const quiet = console.log, err = console.error;
    const said: string[] = [];
    console.log = (...a: unknown[]) => { said.push(a.join(' ')); };
    console.error = (...a: unknown[]) => { said.push(a.join(' ')); };
    let codeErr: number, codeClean: number, codeWarn: number, codeBad: number, codeOut: number;
    try {
      codeErr = robotLint([dir]);
      codeClean = robotLint([path.join(dir, 'R1', 'tidy.kl'), '--quiet']);
      codeWarn = robotLint([path.join(dir, 'R1', 'tidy.kl'), '--max-warnings', '-1', '--config', path.join(dir, '.robotlint.json')]);
      codeBad = robotLint([path.join(dir, 'nope')]);
      codeOut = robotLint([dir, '--format', 'sarif', '--output', path.join(dir, 'out.sarif')]);
    } finally { console.log = quiet; console.error = err; }
    check(codeErr === 1 && codeClean === 0 && codeWarn === 0 && codeBad === 2 && codeOut === 1, `robot-lint exit codes: errors 1, clean 0, warnings 0, bad path 2, sarif 1 (${[codeErr, codeClean, codeWarn, codeBad, codeOut]})`);
    check(JSON.parse(fs.readFileSync(path.join(dir, 'out.sarif'), 'utf8')).runs[0].results.length > 0, 'robot-lint --output writes the report');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }

  // ---------- the schema VS Code reads for .robotlint.json is up to date ----------
  const schemaFile = path.resolve(__dirname, '..', 'schemas', 'robotlint.schema.json');
  const shipped = fs.existsSync(schemaFile) ? fs.readFileSync(schemaFile, 'utf8').replace(/\r\n/g, '\n').trim() : '';
  check(shipped === JSON.stringify(lintConfigSchema(), null, 2), 'schemas/robotlint.schema.json matches the rules (regenerate: node dist/robot-lint.js --schema > schemas/robotlint.schema.json)');

  // ---------- the corpora: programs that run on real controllers ----------
  const corpora = [fanucRoot, findCorpus()].filter((p): p is string => !!p && fs.existsSync(p));
  if (!corpora.length) { console.log('  (no corpus found; lint corpus checks skipped)'); return; }
  for (const root of corpora) {
    const r = lintPaths([root]);
    const styleErrors = r.files.flatMap(f => f.findings.filter(x => x.code.includes('.style.') && x.severity === 'error').map(x => `${f.path}:${x.span.line + 1} ${x.code}`));
    const rapidErrors = r.files.filter(f => f.language === 'abb-rapid').flatMap(f => f.findings.filter(x => x.severity === 'error').map(x => `${f.path}:${x.span.line + 1} ${x.code} ${x.message}`));
    const rapidWarnings = r.files.filter(f => f.language === 'abb-rapid').flatMap(f => f.findings.filter(x => x.severity === 'warning'));
    check(r.files.length > 0 && !r.unreadable.length, `lint corpus ${path.basename(root)}: ${r.files.length} files read`);
    check(!styleErrors.length, `lint corpus ${path.basename(root)}: no style rule says error:\n    ${styleErrors.slice(0, 8).join('\n    ')}`);
    check(!rapidErrors.length, `lint corpus ${path.basename(root)}: no RAPID error:\n    ${rapidErrors.slice(0, 8).join('\n    ')}`);
    // HOME libraries are judged against the backup's tasks: no "unknown routine" for a routine a task has
    check(rapidWarnings.length === 0, `lint corpus ${path.basename(root)}: no RAPID warning (${rapidWarnings.length}: ${rapidWarnings.slice(0, 3).map(w => w.message).join(' | ')})`);
  }
}
