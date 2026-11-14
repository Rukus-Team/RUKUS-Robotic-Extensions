/**
 * The Knowledge view's content: kinds of program, the check of a program against its kind, and
 * the building blocks. Wired in by test/run.ts.
 */
import { parseTp } from '@fanuc/tp/parser';
import { PROGRAM_KINDS, BLOCKS, kindOfProgram, kindFindings, blockFits, blockPreview } from '@fanuc/tp/knowledge';

type Check = (cond: unknown, msg: string) => void;

export function run(check: Check): void {
  const prog = (first: string, group: string, mn: string[]) => parseTp([first, '/ATTR', `DEFAULT_GROUP\t= ${group};`, '/MN', ...mn, '/POS', '/END', ''].join('\n'));
  check(kindOfProgram(prog('/PROG  A', '1,*,*,*,*', [])) === 'tp' && kindOfProgram(prog('/PROG  A\t  Macro', '1,*,*,*,*', [])) === 'macro' && kindOfProgram(prog('/PROG  A\t  Cond', '*,*,*,*,*', [])) === 'cond', 'the kind is read from the /PROG sub type');
  check(PROGRAM_KINDS.every(k => k.rules.length && k.setup.length && k.summary), 'every kind has a summary, a setup note and rules');
  check(PROGRAM_KINDS.flatMap(k => k.rules).every(r => r.source === undefined || /p\.\d|sec\. \d|controller/.test(r.source)), 'a rule is either sourced to a manual page or marked to confirm');

  const msgs = (kind: Parameters<typeof kindFindings>[0], p: ReturnType<typeof parseTp>) => kindFindings(kind, p).map(f => `${f.line}${f.sourced ? '!' : '?'}`).join(' ');
  const cond = prog('/PROG  WATCH\t  Cond', '1,*,*,*,*', ['   1:  WHEN DI[1]=ON,CALL STOPIT ;', '   2:  R[1]=1 ;', '   3:  WHEN DI[1]=ON AND DI[2]=ON OR DI[3]=ON,CALL X ;', '   4:  !note ;', '   5:J P[1] 100% FINE ;']);
  check(msgs('cond', cond) === '2! 5! 6! 8!', `Cond: the motion group, a non-WHEN line, AND with OR, a motion: ${msgs('cond', cond)}`);
  check(msgs('cond', prog('/PROG  W\t  Cond', '*,*,*,*,*', ['   1:  WHEN DI[1]=ON AND DI[2]=ON AND DI[3]=ON AND DI[4]=ON AND DI[5]=ON,CALL X ;', '   2:  WHEN DI[1]=ON OR DI[2]=ON OR DI[3]=ON OR DI[4]=ON OR DI[5]=ON OR DI[6]=ON,CALL X ;'])) === '5!', 'Cond: five conditions on a line, not six');
  check(msgs('cond', prog('/PROG  WATCH\t  Cond', '*,*,*,*,*', ['   1:  WHEN DI[1]=ON,CALL STOPIT ;', '   2:  WHEN R[1]=1 OR R[2]=1,CALL X ;'])) === '', 'Cond: a clean one has no findings');
  const bg = prog('/PROG  BG1', '*,*,*,*,*', ['   1:  LBL[1] ;', '   2:  DO[1]=(DI[1] AND !DI[2]) ;', '   3:  IF (DI[3]),F[1]=(ON) ;', '   4:  M[1]=(DI[1]) ;', '   5:  JMP LBL[1] ;', '   6:  JMP LBL[2] ;', '   7:  WAIT 1.00(sec) ;', '   8:  CALL OTHER ;', '   9:  LBL[2] ;', '  10:  RUN LOGGER ;']);
  check(msgs('bglogic', bg) === '7! 8! 10! 11!', `background logic: a marker assigned, a jump back, WAIT, CALL: ${msgs('bglogic', bg)}`);
  check(msgs('bglogic', prog('/PROG  BG1', '1,*,*,*,*', ['   1:J P[1] 100% FINE ;'])) === '2? 4!', 'background logic: a motion group (common practice) and a motion');
  const bg2 = prog('/PROG  BG2', '*,*,*,*,*', ['   1:  IF DI[1]=ON,JMP LBL[9] ;', '   2:  IF (DI[1]=ON),JMP LBL[9] ;', '   3:  IF (DI[1]) THEN ;', '   4:  R[1]=R[1]+1 ;', '   5:  R[1]=(R[1]+1) ;', '   6:  IF (DI[2]),DO[2]=PULSE,1.0sec ;', '   7:  SELECT R[1]=1,JMP LBL[9] ;', '   8:         =2,JMP LBL[9] ;', '   9:         ELSE,JMP LBL[9] ;', '  10:  UALM[1] ;', '  11:  IF (DI[3]),M[2]=(ON) ;', '  12:  IF (DI[3]),CALL X ;', '  13:  FOR R[1]=1 TO 2 ;', '  14:  LBL[9] ;', '  15:  !note ;', '  16:   ;']);
  check(msgs('bglogic', bg2) === '4! 6! 7? 14! 15! 16!', `background logic: IF without ( ), IF THEN, a plain assignment asked about, a marker and a CALL behind IF, FOR; SELECT, UALM, PULSE and comments pass: ${msgs('bglogic', bg2)}`);
  check(msgs('tp', bg) === '' && msgs('macro', cond) === '', 'an ordinary program and a macro have nothing kind-specific checked');

  const fit = (kind: Parameters<typeof blockFits>[1]) => BLOCKS.filter(b => blockFits(b, kind)).map(b => b.label);
  check(fit('cond').every(l => /^WHEN|Comment|Banner/.test(l)) && fit('cond').some(l => /^WHEN/.test(l)), `Cond offers WHEN lines and comments only: ${fit('cond').join(', ')}`);
  check(!fit('bglogic').some(l => /move|Wait|Call program$/i.test(l)) && fit('bglogic').includes('Output from inputs') && fit('bglogic').includes('Jump'), `background logic offers no motion or WAIT: ${fit('bglogic').join(', ')}`);
  check(fit('tp').includes('If then block') && fit('tp').includes('Joint move') && !fit('tp').some(l => /^WHEN/.test(l)), 'an ordinary program gets the usual blocks, not WHEN');
  check(!BLOCKS.some(b => /^(Program skeleton|Position entry|Joint position entry)$/.test(b.label)), 'file-level snippets are not building blocks');
  check(blockPreview('IF (${1:R[1]=1}) THEN ;\n  ${0}\nENDIF ;') === 'IF (R[1]=1) THEN ;\n  \nENDIF ;' && blockPreview('DO[${1:1}]=${2|ON,OFF|} ;') === 'DO[1]=ON ;', 'a block previews as the text it writes');
}
