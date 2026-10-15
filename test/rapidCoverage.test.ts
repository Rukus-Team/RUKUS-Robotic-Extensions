/**
 * RAPID coverage: every instruction, function and data type that ABB's RAPID manuals list for
 * RobotWare 6 (IRC5, 3HAC050917) and RobotWare 8 (OmniCore, 3HAC098387) - the names in
 * packages/abb/src/rapid/manual-names.json, from scripts/import-rapid-rw8.mjs - is known to the
 * language support: a reference entry (hover, argument hints, typed completion), the built-in
 * sets (no "unknown routine" warning, plain completion) and the grammar (colouring).
 * Plus the RobotWare 8 merge (new arguments, RW6 / RW8 only notes) and the option-manual names.
 * Wired in by test/run.ts.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { rapidRef, rapidRefEntries, rapidRefMarkdown, rapidManualNames, rapidManualRw } from '@abb/rapid/reference';
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

  // options documented only in their own manuals (EGM, SoftMove, Force Control): known names, no warning
  for (const n of ['EGMRunJoint', 'EGMActPose', 'CSSAct', 'CSSDeactMoveL', 'FCAct', 'FCPressL', 'SocketCreate', 'TriggL', 'SyncMoveOn', 'MToolRotCalib'])
    check(RAPID_INSTRUCTIONS.has(n.toUpperCase()) && g.instruction.test(sample.instruction(n)), `${n} is a known, coloured instruction`);
  check(RAPID_FUNCTIONS.has('EGMGETSTATE') && RAPID_TYPES.has('EGMIDENT') && RAPID_FUNCTIONS.has('FILETIMEDNUM'), 'EGMGetState, egmident, FileTimeDnum are known');
  const m = parseRapid('MODULE M\r\nPROC main()\r\n  EGMRunJoint egmID1, EGM_STOP_HOLD;\r\n  CSSAct \\Y;\r\n  MoveAbsL j1, v100, fine, tool0;\r\n  NoSuchThing;\r\nENDPROC\r\nENDMODULE');
  const unknown = diagnoseTask([m])[0].filter(x => x.code === 'rapid.unknownRoutine').map(x => x.message.split(' ')[0]);
  check(unknown.join() === 'NoSuchThing', `only NoSuchThing is an unknown routine (${unknown.join()})`);
}
