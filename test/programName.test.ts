/**
 * A program's file name and the name inside it have to match: renaming the file renames the
 * header, and a mismatch is reported. Wired in by test/run.ts.
 */
import { headerEditsForFileRename, programNameProblem, tpHeaderName, karelHeaderName, fileBaseName } from '@fanuc/programName';
import { parseTp } from '@fanuc/tp/parser';
import { tpChecks, CODES } from '@fanuc/tp/checks';
import { surplusCloser } from '@fanuc/tp/brackets';

type Check = (cond: unknown, msg: string) => void;

export function run(check: Check): void {
  const tp = ['/PROG  PICK', '/ATTR', 'LINE_COUNT\t= 1;', '/MN', '   1:  CALL PLACE ;', '/POS', '/END', ''].join('\n');
  const kl = ['PROGRAM pick', '%NOLOCKGROUP', 'ROUTINE helper', 'BEGIN', 'END helper', 'BEGIN', '  -- END pick', 'END pick', ''].join('\n');
  const apply = (text: string, oldPath: string, newPath: string) => {
    const lines = text.split('\n');
    for (const e of headerEditsForFileRename(oldPath, newPath, text)) lines[e.line] = lines[e.line].slice(0, e.col) + e.newText + lines[e.line].slice(e.col + e.len);
    return lines.join('\n');
  };
  check(fileBaseName('C:\\cell\\R1\\Pick_Part.ls') === 'Pick_Part' && fileBaseName('/a/b/pick.kl') === 'pick', 'fileBaseName');
  check(tpHeaderName(tp)?.name === 'PICK' && karelHeaderName(kl)?.name === 'pick', 'the header names are found');
  check(apply(tp, '/c/PICK.ls', '/c/pick_part.ls').startsWith('/PROG  PICK_PART\n'), `TP: the file renamed, /PROG follows in capitals: ${apply(tp, '/c/PICK.ls', '/c/pick_part.ls').split('\n')[0]}`);
  check(apply(tp, '/c/pick.LS', '/c/Drop.LS').startsWith('/PROG  DROP\n'), 'TP: file name case does not matter for the match');
  check(apply(tp, '/c/PICK.ls', '/d/PICK.ls') === tp && apply(tp, '/c/PICK.ls', '/c/pick.ls') === tp, 'TP: a move or a change of case alone changes nothing');
  check(apply(tp, '/c/PICK_old.ls', '/c/PICK_older.ls') === tp, 'TP: a file whose /PROG did not match its name is not rewritten');
  check(apply(tp, '/c/PICK.ls', '/c/PICK (copy).ls') === tp && apply(tp, '/c/PICK.ls', '/c/2PICK.ls') === tp, 'TP: a file name that is not a program name is not written into /PROG');
  check(apply(tp, '/c/PICK.ls', '/c/PICK.txt') === tp, 'a change of extension is not a program rename');
  const kl2 = apply(kl, '/c/pick.kl', '/c/place.kl').split('\n');
  check(kl2[0] === 'PROGRAM place' && kl2[7] === 'END place' && kl2[4] === 'END helper' && kl2[6] === '  -- END pick', `KAREL: PROGRAM and its END follow, a routine's END and a comment do not:\n${kl2.join('\n')}`);
  check(apply(kl, '/c/pick.kl', '/c/PICK.kl').split('\n')[0] === 'PROGRAM PICK', 'KAREL: the name is written as the file spells it');
  check(programNameProblem('PICK_1') === undefined && !!programNameProblem('1PICK') && !!programNameProblem('PICK-1') && !!programNameProblem('') && !!programNameProblem('A'.repeat(37)) && programNameProblem('A'.repeat(36)) === undefined, 'program name rules');

  // a closer typed into a line that had nothing left to close (the line is given with it in)
  const surplus: [string, string, boolean][] = [
    ['   3:  R[35:index]] ;', ']', true], ['   3:  R[R[35]]] ;', ']', true], ['   3:  R[R[35]] ;', ']', false], ['   3:  R[R[35] ;', ']', false],
    ['   3:  IF (R[1]=1)) THEN ;', ')', true], ['   3:  IF (R[1]=1) THEN ;', ')', false], ["   3:  SR[1]='a]' ;", ']', false], ["   3:  SR[1]]='a[' ;", ']', true],
    ['   3:  R[1]]] ;', ']', false], ['   3:  R[1]} ;', '}', false],
    // an apostrophe in a bracket name is text, not the start of a string
    ["   3:  R[1:a's]=R[R[2:c's]] ;", ']', false], ["   3:  R[1:a's]=R[R[2:c's]]] ;", ']', true], ["   3:  DO[1:it's on]=ON ;", ']', false],
    // a wrapped instruction is counted whole: the ) closes a ( from the line above
    ['   3:  IF ((DI[1]=ON OR \n    :  DI[2]=ON) \n    :  AND DI[3]=OFF),JMP LBL[30] ;\n', ')', false], ['   3:  IF ((DI[1]=ON OR \n    :  DI[2]=ON)) \n    :  AND DI[3]=OFF),JMP LBL[30] ;\n', ')', true],
  ];
  for (const [line, c, want] of surplus) check(surplusCloser(line, c) === want, `surplusCloser(${JSON.stringify(line)}, ${c}) should be ${want}`);

  const codes = (fileName?: string) => tpChecks(tp, parseTp(tp), { fileName }).filter(f => f.code === CODES.programName);
  check(codes('PICK').length === 0 && codes('pick').length === 0 && codes(undefined).length === 0, 'a matching name (any case), or no file, is not reported');
  const off = codes('PICK_OLD');
  check(off.length === 1 && off[0].span.line === 0 && off[0].span.col === 7 && off[0].span.len === 4 && /PICK_OLD/.test(off[0].message), `a /PROG that differs from the file is reported on the name: ${JSON.stringify(off)}`);
}
