/**
 * RAPID coverage: every instruction, function and data type that ABB's RAPID manuals list for
 * RobotWare 6 (IRC5, 3HAC050917) and RobotWare 8 (OmniCore, 3HAC098387) - the names in
 * packages/abb/src/rapid/manual-names.json, from scripts/import-rapid-rw8.mjs - is known to the
 * language support: a reference entry (hover, argument hints, typed completion), the built-in
 * sets (no "unknown routine" warning, plain completion) and the grammar (colouring).
 * Plus the RobotWare 8 merge (new arguments, RW6 / RW8 only notes) and the options documented in their own
 * application manuals (EGM, SoftMove, Force Control: reference-options.json, scripts/import-rapid-options.mjs).
 * Wired in by test/run.ts.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { rapidRef, rapidRefEntries, rapidRefMarkdown, rapidManualNames, rapidManualRw, rapidOptionManualNames, RAPID_OPTION_MANUALS, PREDEFINED, positionalArgs, callContext } from '@abb/rapid/reference';
import { RAPID_INSTRUCTIONS, RAPID_FUNCTIONS, RAPID_TYPES, RAPID_RESERVED } from '@abb/rapid/builtins';
import { parseRapid } from '@abb/rapid/parser';
import { diagnoseTask } from '@abb/rapid/diagnostics';

type Check = (cond: unknown, msg: string) => void;

function grammarRules(): Record<'instruction' | 'function' | 'type', RegExp> {
  for (let dir = __dirname, i = 0; i < 6; i++, dir = path.dirname(dir)) {
    const file = path.join(dir, 'syntaxes', 'rapid.tmLanguage.json');
    if (!fs.existsSync(file)) continue;
    const g = JSON.parse(fs.readFileSync(file, 'utf8')).repository;
    const re = (m: string) => new RegExp(m.replace(/^\(\?i\)/, ''), 'i');
    return { instruction: re(g.instruction.match), function: re(g.function.match), type: re(g.type.match) };
  }
  throw new Error(`syntaxes/rapid.tmLanguage.json not found above ${__dirname}`);
}

export function run(check: Check): void {
  const g = grammarRules();
  const sets = { instruction: RAPID_INSTRUCTIONS, function: RAPID_FUNCTIONS, type: RAPID_TYPES };
  const sample = { instruction: (n: string) => `    ${n} x;`, function: (n: string) => `x := ${n}(1)`, type: (n: string) => `VAR ${n} x;` };
  for (const rw of ['6', '8'] as const) {
    for (const kind of ['instruction', 'function', 'type'] as const) {
      // the manuals' IF, FOR, AND, DIV ... are reserved words: the grammar's keywords, not built-in names
      const names = rapidManualNames(kind, rw).filter(n => !RAPID_RESERVED.has(n.toUpperCase()));
      check(names.length > (kind === 'type' ? 80 : 200), `coverage RW${rw}: the manual lists ${names.length} ${kind}s`);
      const noRef = names.filter(n => !rapidRef(n, kind) && !rapidRef(n));
      const noSet = names.filter(n => !sets[kind].has(n.toUpperCase()));
      const noColour = names.filter(n => !g[kind].test(sample[kind](n)));
      check(noRef.length === 0, `coverage RW${rw} ${kind}s: every one has a reference entry (missing: ${noRef.join(', ')})`);
      check(noSet.length === 0, `coverage RW${rw} ${kind}s: every one is a known built-in (missing: ${noSet.join(', ')})`);
      check(noColour.length === 0, `coverage RW${rw} ${kind}s: the grammar colours every one (missing: ${noColour.join(', ')}; run scripts/sync-rapid-grammar.mjs)`);
    }
  }
  // the grammar knows everything the built-in sets know (names added by hand to builtins.ts too); no reserved word is a built-in
  check(['IF', 'FOR', 'AND', 'DIV', 'EXIT'].every(w => !RAPID_INSTRUCTIONS.has(w) && !RAPID_FUNCTIONS.has(w)) && RAPID_INSTRUCTIONS.has('BREAK') && RAPID_INSTRUCTIONS.has('CONTINUE'), 'reserved words are not built-ins (Break and Continue are both)');
  check(!g.instruction.test('    IF x THEN') && !g.instruction.test('    Continue;'), 'the grammar leaves IF and CONTINUE to the keyword rule');
  for (const kind of ['instruction', 'function', 'type'] as const) {
    const miss = [...sets[kind]].filter(n => !RAPID_RESERVED.has(n) && !g[kind].test(sample[kind](n)));
    check(miss.length === 0, `grammar colours every built-in ${kind} (missing: ${miss.slice(0, 20).join(', ')}; run scripts/sync-rapid-grammar.mjs)`);
  }

  // RobotWare 8's additions
  const moveAbsL = rapidRef('MoveAbsL', 'instruction');
  check(moveAbsL?.rw === '8' && rapidManualRw('MoveAbsL') === '8', 'MoveAbsL is RobotWare 8 only');
  check(/RobotWare 8 \(OmniCore\) only/.test(moveAbsL ? rapidRefMarkdown(moveAbsL) : ''), 'the hover says RobotWare 8 only');
  check(rapidRef('IOBusStart')?.rw === '6' && /RobotWare 6 \(IRC5\) only/.test(rapidRefMarkdown(rapidRef('IOBusStart')!)), 'IOBusStart is RobotWare 6 only');
  check(rapidRef('MoveL')?.rw === undefined && rapidManualRw('MoveL') === 'both', 'MoveL is in both');
  const keep = rapidRef('MoveL', 'instruction')?.args?.find(a => a.name === 'KeepStartPath');
  check(keep?.rw === '8' && keep.optional === true, 'MoveL has RW8\'s optional \\KeepStartPath, marked RobotWare 8');
  const args = rapidRef('MoveL', 'instruction')?.args?.map(a => a.name) ?? [];
  check(args.indexOf('KeepStartPath') === args.indexOf('T') + 1, `\\KeepStartPath follows \\T (${args.join(' ')})`);
  check(rapidRef('StrFormat', 'function')?.returns === 'string' && !rapidRef('StrFormat', 'instruction'), 'StrFormat is a function returning string (the RW6 import filed it as an instruction)');
  check(rapidRef('JSONToVal', 'instruction') !== undefined && rapidRef('translationdata', 'type') !== undefined, 'RW8 JSON instructions and translationdata');
  const empty = rapidRefEntries().filter(e => !e.summary?.trim()).map(e => e.name);
  check(empty.length === 0, `every reference entry has a summary (empty: ${empty.join(', ')})`);
  check(rapidRefEntries().every((e, i, a) => i === 0 || a[i - 1].name.localeCompare(e.name, 'en', { sensitivity: 'base' }) <= 0), 'merged reference sorted by name');

  // options documented only in their own application manuals (EGM, SoftMove, Force Control): every name each manual
  // lists has a reference entry of that kind, is a known built-in and is coloured
  check(RAPID_OPTION_MANUALS.join() === 'css6,css7,egm6,egm7,fc6,fc7,fcgofa', `option manuals: ${RAPID_OPTION_MANUALS.join()}`);
  const counts: string[] = [];
  for (const key of RAPID_OPTION_MANUALS) {
    for (const kind of ['instruction', 'function', 'type'] as const) {
      const names = rapidOptionManualNames(kind, key);
      counts.push(`${key} ${kind} ${names.length}`);
      const noRef = names.filter(n => !rapidRef(n, kind));
      const noSet = names.filter(n => !sets[kind].has(n.toUpperCase()));
      const noColour = names.filter(n => !g[kind].test(sample[kind](n)));
      check(noRef.length === 0, `option manual ${key} ${kind}s: every one has a reference entry (missing: ${noRef.join(', ')})`);
      check(noSet.length === 0, `option manual ${key} ${kind}s: every one is a known built-in (missing: ${noSet.join(', ')})`);
      check(noColour.length === 0, `option manual ${key} ${kind}s: the grammar colours every one (missing: ${noColour.join(', ')})`);
    }
  }
  const count = (key: string) => (['instruction', 'function', 'type'] as const).map(k => rapidOptionManualNames(k, key).length).join('/');
  check(count('egm6') === '18/1/6' && count('egm7') === '18/1/5' && count('css6') === '6/0/3' && count('css7') === '6/1/3'
    && count('fc6') === '40/4/14' && count('fc7') === '41/4/14' && count('fcgofa') === '41/4/14', `option manual name counts (${counts.join('; ')})`);
  const egmRun = rapidRef('EGMRunJoint', 'instruction');
  check(egmRun?.option === 'Externally Guided Motion' && positionalArgs(egmRun).map(a => `${a.name}:${a.type}`).join() === 'EGMid:egmident,Mode:egmstopmode'
    && egmRun.args?.some(a => a.name === 'NoWaitCond' && a.switch) && egmRun.rw === undefined, 'EGMRunJoint: EGMid, Mode, \\NoWaitCond, in both EGM manuals');
  check((PREDEFINED.egmstopmode ?? []).join() === 'EGM_STOP_HOLD,EGM_STOP_RAMP_DOWN' && (PREDEFINED.css_soft_dir ?? []).includes('CSS_XYZ') && (PREDEFINED.fcplane ?? []).join() === 'FCPLANE_XY,FCPLANE_XZ,FCPLANE_YZ', 'option alias types offer their predefined constants');
  const cssAct = rapidRef('CSSAct', 'instruction');
  check(positionalArgs(cssAct!).map(a => a.type).join() === 'css_soft_dir' && callContext('CSSAct \\RefFrame:=CSS_REFFRAME_TOOL, CSS_')?.index === 0, 'CSSAct: SoftDir after the optional \\RefFrame');
  check(rapidRef('EGM_MAX_RAPID_DNUM')?.rw === '6' && /RobotWare 6 \(IRC5\) only/.test(rapidRefMarkdown(rapidRef('EGM_MAX_RAPID_DNUM')!)), 'EGM_MAX_RAPID_DNUM: RobotWare 6 only');
  for (const n of ['IsCSSAct', 'FCCondCombine']) check(rapidRef(n)?.rw === 'omnicore' && /OmniCore only/.test(rapidRefMarkdown(rapidRef(n)!)), `${n}: OmniCore only`);
  check(rapidRef('IsCSSAct', 'function')?.returns === 'bool' && rapidRef('FCLoadID', 'function')?.returns === 'loaddata' && rapidRef('FCGetForce', 'function')?.returns === 'fcforcevector', 'option functions return their types');
  const dcg = rapidRef('FCPress1LStart', 'instruction')?.args?.find(a => a.name === 'DeflectionCompGain');
  check(dcg?.rw === 'omnicore' && /\(OmniCore\)/.test(rapidRefMarkdown(rapidRef('FCPress1LStart')!)), 'FCPress1LStart \\DeflectionCompGain is marked OmniCore');
  check(rapidRef('CSSAct')?.rw === undefined && rapidRef('FCAct')?.rw === undefined && rapidRef('FCAct')?.option === 'Force Control', 'CSSAct and FCAct are in both RobotWare 6 and OmniCore manuals');
  // known names, no warning
  for (const n of ['EGMRunJoint', 'EGMActPose', 'EGMWaitCond', 'CSSAct', 'CSSDeactMoveL', 'FCAct', 'FCPressL', 'FCCondCombine', 'FCResetMaxForceChangeTune', 'SocketCreate', 'TriggL', 'SyncMoveOn', 'MToolRotCalib'])
    check(RAPID_INSTRUCTIONS.has(n.toUpperCase()) && g.instruction.test(sample.instruction(n)), `${n} is a known, coloured instruction`);
  check(RAPID_FUNCTIONS.has('EGMGETSTATE') && RAPID_TYPES.has('EGMIDENT') && RAPID_FUNCTIONS.has('FILETIMEDNUM'), 'EGMGetState, egmident, FileTimeDnum are known');
  const m = parseRapid('MODULE M\r\nPROC main()\r\n  EGMRunJoint egmID1, EGM_STOP_HOLD;\r\n  CSSAct \\Y;\r\n  MoveAbsL j1, v100, fine, tool0;\r\n  NoSuchThing;\r\nENDPROC\r\nENDMODULE');
  const unknown = diagnoseTask([m])[0].filter(x => x.code === 'rapid.unknownRoutine').map(x => x.message.split(' ')[0]);
  check(unknown.join() === 'NoSuchThing', `only NoSuchThing is an unknown routine (${unknown.join()})`);
}
