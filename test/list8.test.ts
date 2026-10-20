/**
 * Regressions from Sam's list 8 (2026-10-19). Synthetic, nothing here needs a backup or a
 * controller. Wired in by test/run.ts: `run(check)`.
 *
 *   1. hover text: a file or module header (copyright, change history, routine list, the
 *      "use MS Word" note) is not the description of the declaration under it - RAPID and KAREL
 */
import { isHeaderComment, isDivider } from '@core/headerComment';
import { parseRapid } from '@abb/rapid/parser';
import { parseKarel } from '@fanuc/karel/parser';

type Check = (cond: unknown, msg: string) => void;

export function run(check: Check): void {
  // ---- the header test itself ----
  check(isDivider(' ********************') && isDivider('-- =========') && isDivider('-----') && !isDivider(' Pick approach') && !isDivider(' a-b'), 'divider lines');
  check(isHeaderComment([' Copyright (c) 2024 ACME'], false), 'copyright is a header');
  check(isHeaderComment([' Please use MS Word to view the change history'], false), 'the MS Word note is a header');
  check(isHeaderComment([' Change history:', ' 2024-01-02 SM first'], false), 'change history is a header');
  check(isHeaderComment([' Routines:', '   Main'], false), 'a routine list is a header');
  check(!isHeaderComment([' Approach point above the pick'], false), 'a one-line note is not a header');
  check(!isHeaderComment([' Approach point above the pick'], true), 'a one-line note right after MODULE is still a note');
  check(isHeaderComment([' *****', ' Pick cell', ' *****'], true), 'a ruled block right after MODULE is the header');
  check(!isHeaderComment([' *****', ' Pick routine: picks one part', ' *****'], false), 'a ruled block above a routine is its note');
  check(isHeaderComment(Array.from({ length: 20 }, (_, i) => ` line ${i}`), false), 'a 20-line block is not a declaration note');

  // ---- RAPID: the robtarget under the module header gets no header text ----
  const rapid = parseRapid([
    'MODULE Pick_27L30L',                                                     // 0
    '  !***********************************************************',          // 1
    '  ! NOTE: use MS Word to read the change history of this file',           // 2
    '  ! Copyright (c) 2024 ACME Automation',                                  // 3
    '  ! Project: 27L30L pick cell',                                           // 4
    '  ! Change history:',                                                     // 5
    '  !   2024-01-02  first version',                                         // 6
    '  ! Routines:',                                                           // 7
    '  !   Pick_27L30L',                                                       // 8
    '  !***********************************************************',          // 9
    '  CONST robtarget pVia_Pick_27L30L_1:=[[1,2,3],[1,0,0,0],[0,0,0,0],[9E9,9E9,9E9,9E9,9E9,9E9]];', // 10
    '  ! Approach point above the pick',                                       // 11
    '  CONST robtarget pVia_Pick_27L30L_2:=[[1,2,9],[1,0,0,0],[0,0,0,0],[9E9,9E9,9E9,9E9,9E9,9E9]];', // 12
    '  !***********************************************************',          // 13
    '  ! Pick_27L30L: picks one part',                                         // 14
    '  !***********************************************************',          // 15
    '  PROC Pick_27L30L()',                                                    // 16
    '  ENDPROC',                                                               // 17
    'ENDMODULE',                                                               // 18
  ].join('\n'));
  const p1 = rapid.data.find(d => d.name === 'pVia_Pick_27L30L_1');
  const p2 = rapid.data.find(d => d.name === 'pVia_Pick_27L30L_2');
  check(p1 && p1.doc === undefined, `RAPID: no header text on the first robtarget: ${JSON.stringify(p1?.doc)}`);
  check(p2?.doc === 'Approach point above the pick', `RAPID: a robtarget keeps its own note: ${JSON.stringify(p2?.doc)}`);
  check(rapid.routines[0]?.doc === 'Pick_27L30L: picks one part', `RAPID: a ruled routine note stays: ${JSON.stringify(rapid.routines[0]?.doc)}`);

  const tail = parseRapid([
    'MODULE M',
    '  !*****',
    '  ! Copyright (c) 2024 ACME',
    '  !*****',
    '  ! Home position',
    '  CONST robtarget pHome:=[[1,2,3],[1,0,0,0],[0,0,0,0],[9E9,9E9,9E9,9E9,9E9,9E9]];',
    'ENDMODULE',
  ].join('\n'));
  check(tail.data[0]?.doc === 'Home position', `RAPID: the note under the header's last rule stays: ${JSON.stringify(tail.data[0]?.doc)}`);

  // ---- KAREL: same for the first declaration under the program header ----
  const karel = parseKarel([
    'PROGRAM pick',
    '-- ****************************',
    '-- Copyright (c) 2024 ACME',
    '-- Change history:',
    '--   2024-01-02 first version',
    '-- ****************************',
    'VAR',
    '  -- part counter',
    '  count : INTEGER',
    'CONST',
    '  -- Copyright (c) 2024 ACME',
    '  MAXP = 10',
    'BEGIN',
    'END pick',
  ].join('\n'));
  const sym = (n: string) => karel.symbols.find(s => s.upper === n);
  check(sym('COUNT')?.doc === 'part counter', `KAREL: a variable keeps its own note: ${JSON.stringify(sym('COUNT')?.doc)}`);
  check(sym('MAXP') && sym('MAXP')!.doc === undefined, `KAREL: no header text on a constant: ${JSON.stringify(sym('MAXP')?.doc)}`);
}
