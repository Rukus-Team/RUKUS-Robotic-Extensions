/**
 * Regressions from Sam's list 8 (2026-10-19). Synthetic, nothing here needs a backup or a
 * controller. Wired in by test/run.ts: `run(check)`.
 *
 *   1. hover text: a file or module header (copyright, change history, routine list, the
 *      "use MS Word" note) is not the description of the declaration under it - RAPID and KAREL
 *   1b. (2026-10-20) `!!!! ROBOT POINTS !!!!` section titles and group labels are not a
 *      declaration's note either; a same-line comment is; stray `)` / `]` keep commas splitting
 */
import { isHeaderComment, isDivider, isBanner } from '@core/headerComment';
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

  // ---- 1b: section titles, group labels, same-line comments ----
  check(isDivider('!!!!!!!!!!!') && isDivider(' !!!!!!!'), '!!!! lines are dividers');
  check(isBanner('!!!!!!! ROBOT POINTS !!!!!!!') && isBanner(' *** Pick ***') && isBanner('-----') && !isBanner(' Safe position above the conveyor') && !isBanner(' a-b'), 'section titles');
  const pts = '[[1,2,3],[1,0,0,0],[0,0,0,0],[9E+09,9E+09,9E+09,9E+09,9E+09,9E+09]]';
  const hover = parseRapid([
    'MODULE HoverTest',
    '  !!!!!!!!!!!!!!!!!!!! ROBOT POINTS !!!!!!!!!!!!!!!!!!!!',
    `  CONST robtarget pApp:=${pts};`,
    `  CONST robtarget pPick:=${pts};`,
    '',
    '  ! Safe position above the conveyor',
    `  CONST robtarget pSafe:=${pts};`,
    '  PERS num nCount:=0; ! parts picked this cycle',
    '',
    '  ! Pick positions',
    `  CONST robtarget pPick1:=${pts};`,
    `  CONST robtarget pPick2:=${pts};`,
    '',
    '  !!!!!!!!!!!!!!!!!!!! ROUTINES !!!!!!!!!!!!!!!!!!!!',
    '  PROC MOV_Pick()',
    '  ENDPROC',
    '',
    '  !!!!!! ROUTINES !!!!!!',
    '  ! Places the part',
    '  ! on the conveyor',
    '  PROC MOV_Place()',
    '  ENDPROC',
    '',
    '  ! Drops part on conveyor',
    '  PROC MOV_Drop(num a], num b)',
    '  ENDPROC',
    '',
    '  VAR num nGrid{3), 4};',
    'ENDMODULE',
  ].join('\n'));
  const hd = (n: string) => hover.data.find(d => d.name === n)?.doc;
  const hr = (n: string) => hover.routines.find(r => r.name === n);
  check(hd('pApp') === undefined && hd('pPick') === undefined, `RAPID: no section title on the points under it: ${JSON.stringify([hd('pApp'), hd('pPick')])}`);
  check(hd('pSafe') === 'Safe position above the conveyor', `RAPID: a point keeps its own note: ${JSON.stringify(hd('pSafe'))}`);
  check(hd('nCount') === 'parts picked this cycle', `RAPID: the same-line comment is the note: ${JSON.stringify(hd('nCount'))}`);
  check(hd('pPick1') === undefined && hd('pPick2') === undefined, `RAPID: a group label is nobody's note: ${JSON.stringify([hd('pPick1'), hd('pPick2')])}`);
  check(hr('MOV_Pick')?.doc === undefined, `RAPID: no section title on a routine: ${JSON.stringify(hr('MOV_Pick')?.doc)}`);
  check(hr('MOV_Place')?.doc === 'Places the part\non the conveyor', `RAPID: the routine note under a section title stays: ${JSON.stringify(hr('MOV_Place')?.doc)}`);
  check(hr('MOV_Drop')?.doc === 'Drops part on conveyor', `RAPID: a routine keeps its note: ${JSON.stringify(hr('MOV_Drop')?.doc)}`);
  check(hr('MOV_Drop')?.params.length === 2, `RAPID: a stray ] does not merge parameters: ${hr('MOV_Drop')?.params.map(p => p.name).join(',')}`);
  check(hd('nGrid') === undefined && hover.data.find(d => d.name === 'nGrid')?.dims?.length === 2, `RAPID: a stray ) does not merge dimensions: ${JSON.stringify(hover.data.find(d => d.name === 'nGrid')?.dims)}`);

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
