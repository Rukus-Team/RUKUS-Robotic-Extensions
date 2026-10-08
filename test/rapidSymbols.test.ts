/**
 * RAPID symbols: which declaration a name means (routine, LOCAL, task, labels) and every place
 * that names it - what references, rename, highlights, lenses and the call graph stand on.
 * Wired in by test/run.ts: `run(check)`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseRapid, type RapidModule } from '@abb/rapid/parser';
import { rapidSymbolAt, rapidOccurrences, rapidCallsFrom, RAPID_NAME } from '@abb/rapid/symbols';
import { findCorpus } from './rapid.test';

type Check = (cond: unknown, msg: string) => void;

const MAIN = [
  'MODULE MainModule',                                   // 0
  '  VAR num nCount := 0;',                              // 1
  '  LOCAL VAR num nHidden := 0;',                       // 2
  '  RECORD part',                                       // 3
  '    num id;',                                         // 4
  '  ENDRECORD',                                         // 5
  '  VAR part pCur;',                                    // 6
  '  PROC main()',                                       // 7
  '    nCount := nCount + 1;',                           // 8
  '    PickPart;',                                       // 9
  '    Helper 3;',                                       // 10
  '    IF nCount > 5 GOTO done;',                        // 11
  '    nHidden := 1;',                                   // 12
  '    done:',                                           // 13
  '    MoveL pHome, v100, fine, tool0;',                 // 14
  '  ENDPROC',                                           // 15
  '  PROC Helper(num nCount)',                           // 16
  '    nCount := nCount * 2;',                           // 17
  '    GOTO done;',                                      // 18
  '    done:',                                           // 19
  '  ENDPROC',                                           // 20
  '  LOCAL PROC Tidy()',                                 // 21
  '    %"PickPart"%;',                                   // 22
  '  ENDPROC',                                           // 23
  'ENDMODULE',                                           // 24
].join('\n');

const GRIP = [
  'MODULE Gripper',                                      // 0
  '  LOCAL VAR num nHidden := 5;',                       // 1
  '  CONST robtarget pHome := [[0,0,0],[1,0,0,0],[0,0,0,0],[9E9,9E9,9E9,9E9,9E9,9E9]];', // 2
  '  PROC PickPart()',                                   // 3
  '    nCount := nCount + nHidden;',                     // 4
  '    Tidy;',                                           // 5
  '  ENDPROC',                                           // 6
  '  LOCAL PROC Tidy()',                                 // 7
  '  ENDPROC',                                           // 8
  'ENDMODULE',                                           // 9
].join('\n');

export function run(check: Check): void {
  const mods = [parseRapid(MAIN), parseRapid(GRIP)];
  const at = (m: number, line: number, word: string) => {
    const col = mods[m].lines[line].indexOf(word);
    return rapidSymbolAt(mods, m, line, col + 1);
  };
  const where = (m: number, line: number, word: string) => {
    const s = at(m, line, word)!;
    return rapidOccurrences(mods, s).map(o => `${o.module}:${o.span.line}${o.kind === 'decl' ? 'd' : ''}`).join(' ');
  };

  // a global, used in both modules; the parameter of the same name in Helper is another symbol
  check(where(0, 8, 'nCount') === '0:1d 0:8 0:8 0:11 1:4 1:4', `global nCount, not Helper's parameter: ${where(0, 8, 'nCount')}`);
  check(where(0, 17, 'nCount') === '0:16d 0:17 0:17', `Helper's parameter nCount: ${where(0, 17, 'nCount')}`);
  // LOCAL data: each module has its own
  check(where(0, 12, 'nHidden') === '0:2d 0:12', `MainModule's LOCAL nHidden: ${where(0, 12, 'nHidden')}`);
  check(where(1, 4, 'nHidden') === '1:1d 1:4', `Gripper's LOCAL nHidden: ${where(1, 4, 'nHidden')}`);
  // a routine across modules, a late-bound call by literal name included
  check(where(0, 9, 'PickPart') === '0:9 0:22 1:3d', `PickPart from its call: ${where(0, 9, 'PickPart')}`);
  check(at(0, 9, 'PickPart')?.decl?.module === 1 && at(0, 9, 'PickPart')?.what === 'routine', 'PickPart is declared in Gripper');
  // LOCAL routines of one name in two modules
  check(where(1, 5, 'Tidy') === '1:5 1:7d', `Gripper's LOCAL Tidy: ${where(1, 5, 'Tidy')}`);
  check(where(0, 21, 'Tidy') === '0:21d', `MainModule's LOCAL Tidy: ${where(0, 21, 'Tidy')}`);
  // labels belong to their routine
  check(where(0, 11, 'done') === '0:11 0:13d', `main's label done: ${where(0, 11, 'done')}`);
  check(where(0, 18, 'done') === '0:18 0:19d', `Helper's label done: ${where(0, 18, 'done')}`);
  // a record used as a type
  check(where(0, 6, 'part') === '0:3d 0:6', `record part and its use as a type: ${where(0, 6, 'part')}`);
  // unknown names: built-ins and option routines
  const mv = at(0, 14, 'MoveL'), tool = at(0, 14, 'tool0');
  check(mv?.what === 'unknown' && !mv.decl && tool?.what === 'unknown', 'MoveL and tool0 are unknown (never renamed)');
  check(at(0, 14, 'pHome')?.decl?.module === 1, 'pHome resolves into Gripper');

  // the call graph's edges
  const calls = rapidCallsFrom(mods, 0, 'main').map(e => 'unknown' in e.to ? `?${e.to.unknown}` : `${e.to.module}.${e.to.routine}`);
  check(calls.join(' ') === '1.PickPart 0.Helper ?MoveL', `main calls: ${calls.join(' ')}`);
  check(RAPID_NAME.test('pPick_10') && !RAPID_NAME.test('1abc') && !RAPID_NAME.test('a'.repeat(33)), 'RAPID name rule');

  // ---- corpus: every occurrence's span holds the name it stands for ----
  const root = findCorpus();
  if (!root) { console.log('  (abb-reference corpus not found; RAPID symbol corpus checks skipped)'); return; }
  const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
  let files = 0, occs = 0;
  const bad: string[] = [];
  for (const f of walk(root).filter(p => /\.(mod|sys)$/i.test(p)).slice(0, 600)) {
    const mod: RapidModule = parseRapid(fs.readFileSync(f, 'latin1'));
    if (mod.encrypted) continue;
    files++;
    for (const r of mod.routines) {
      const s = rapidSymbolAt([mod], 0, r.nameSpan.line, r.nameSpan.col);
      if (!s || s.upper !== r.name.toUpperCase()) { bad.push(`${path.basename(f)}:${r.nameSpan.line + 1} ${r.name} -> ${s?.upper}`); continue; }
      for (const o of rapidOccurrences([mod], s)) {
        occs++;
        const text = mod.lines[o.span.line].substr(o.span.col, o.span.len).toUpperCase();
        if (text !== s.upper) bad.push(`${path.basename(f)}:${o.span.line + 1} "${text}" for ${s.upper}`);
      }
    }
  }
  check(files > 100 && bad.length === 0, `routine occurrences hold their name over ${files} corpus modules, ${occs} occurrences:\n    ${bad.slice(0, 8).join('\n    ')}`);
}
