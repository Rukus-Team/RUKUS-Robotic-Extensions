/**
 * Compare Ignoring Line Numbers: what is taken out of both files before they are compared.
 * Wired in by test/run.ts.
 */
import { cleanForCompare, compareIgnores, describeIgnores, DEFAULT_COMPARE_IGNORES, type CompareIgnore } from '@fanuc/cleanCompare';

type Check = (cond: unknown, msg: string) => void;

export function run(check: Check): void {
  const file = (attr: string[], mn: string[], pos: string[] = [], eol = '\n') => ['/PROG  PICK', '/ATTR', ...attr, '/MN', ...mn, '/POS', ...pos, '/END', ''].join(eol);
  const set = (...i: CompareIgnore[]) => new Set<CompareIgnore>(i);
  const dflt = compareIgnores(undefined);
  const clean = (t: string, ig = dflt) => cleanForCompare(t, 'tp', ig);

  // the same program off the controller, and as edited: a line added at the top, CRLF, typed lines, a new save time
  const robot = file(['CREATE\t\t= DATE 26-01-02  TIME 10:00:00;', 'MODIFIED\t= DATE 26-03-04  TIME 11:22:33;', 'LINE_COUNT\t= 3;', 'PROTECT\t\t= READ_WRITE;'],
    ['   1:  R[5:count]=0 ;', '   2:J P[1] 100% FINE    ;', '   3:  CALL PLACE ;'], ['P[1]{', '   GP1:', '};'], '\r\n');
  const edited = file(['CREATE\t\t= DATE 26-01-02  TIME 10:00:00;', 'MODIFIED\t= DATE 26-11-13  TIME 09:00:00;', 'LINE_COUNT = 3;', 'PROTECT\t\t= READ_WRITE;'],
    ['    1:  R[5:count]=0', '  2:J P[1] 100% FINE ;', 'CALL   PLACE'], ['P[1]{', '   GP1:', '};']);
  check(robot !== edited && clean(robot) === clean(edited), `numbers, terminators, spacing, line endings and header bookkeeping do not count:\n${clean(robot)}\n---\n${clean(edited)}`);
  check(clean(robot).split('\n').slice(7, 10).join('|') === 'R[5:count]=0|J P[1] 100% FINE|CALL PLACE', `a cleaned /MN reads as the instructions: ${clean(robot).split('\n').slice(7, 10).join('|')}`);
  check(/^PROTECT = READ_WRITE;$/m.test(clean(robot)) && /^MODIFIED = …;$/m.test(clean(robot)), 'only the bookkeeping attributes are blanked');

  const shifted = file([], ['   1:  !new first line ;', '   2:  R[5:count]=0 ;', '   3:J P[1] 100% FINE    ;', '   4:  CALL PLACE ;']);
  const a = clean(file([], ['   1:  R[5:count]=0 ;', '   2:J P[1] 100% FINE    ;', '   3:  CALL PLACE ;'])).split('\n'), b = clean(shifted).split('\n');
  check(b.length === a.length + 1 && b.filter(l => !a.includes(l)).join() === '!new first line', 'a line added at the top is the only difference, not every line under it');

  // each thing on its own
  const one = '   1:  R[5:count]=0 ;';
  check(cleanForCompare(file([], [one]), 'tp', set()) === file([], [one]), 'nothing ignored: the text as it is');
  check(cleanForCompare(file([], [one], [], '\r\n'), 'tp', set()) === file([], [one]), 'line endings never count');
  check(clean(file([], [one]), set('lineNumbers')).includes('\n  R[5:count]=0 ;\n') && clean(file([], [one]), set('terminators')).includes('\n   1:  R[5:count]=0\n'), 'line numbers and terminators are separate choices');
  check(clean(file([], ['   1:  R[5:count]=R[R[6:idx]]+DI[2:gate] ;']), set('names')).includes('R[5]=R[R[6]]+DI[2] ;'), 'names: the comment in the brackets goes, indirect ones too');
  check(clean(file([], ["   1:  SR[1]='a:b]' ;"]), set('names')).includes("SR[1]='a:b]'"), 'names: a string is not a bracket comment');
  const cm = clean(file([], ['   1:  !note ;', '   2:  //R[1]=1 ;', '   3:  --eg: long', '    :  note ;', '   4:  R[1]=1 ;', '   5:  --eg:one ;', '   6:  R[2]=2 ;']), set('commentLines')).split('\n').slice(3, -3);
  check(cm.join('|') === '   4:  R[1]=1 ;|   6:  R[2]=2 ;', `comment lines: !, //, and an --eg with its continuation: ${cm.join('|')}`);
  check(!clean(robot, set('positions')).includes('GP1') && clean(robot, set('positions')).includes('/POS\n/END'), 'positions: /POS is emptied, its marker stays');
  check(clean(file([], ['   1:  if (r[1]=1) then ;']), set('case')).includes('IF (R[1]=1) THEN'), 'case');
  check(clean(file([], ['   1:  C P[1]', '    :  P[2] 100mm/sec FINE ;'])).includes('C P[1]\n… P[2] 100mm/sec FINE'), 'a continuation line keeps a mark where its number field was');

  // never equal when they are not the same program (review, 2026-11-13)
  const note = clean(file([], ['   5:  --eg: note', '    :  R[1]=0 ;', '   6:  R[2]=1 ;'])), sets = clean(file([], ['   5:  --eg: note ;', '   6:  R[1]=0 ;', '   7:  R[2]=1 ;']));
  check(note !== sets && note.includes('… R[1]=0') && sets.includes('\nR[1]=0\n'), `comment text on a ":" line is not the instruction it looks like:\n${note}\n---\n${sets}`);
  check(clean(file([], ['   1:L P[3] 1000mm/sec FINE', '    :  SPOT[S=1 ]    ;'])) !== clean(file([], ['   1:L P[3] 1000mm/sec FINE ;', '   2:  SPOT[S=1 ]    ;'])), 'a wrapped instruction and the two instructions it could be split into differ');
  check(clean(file([], ['   1:C P[1]', '    :  P[2] 100mm/sec FINE ;'])) !== clean(file([], ['   1:C P[1] ;', '   2:  P[2] 100mm/sec FINE ;'])), 'a circular move and two separate lines differ');
  check(clean(file([], ["   1:  SR[1]='A  B' ;"])) !== clean(file([], ["   1:  SR[1]='A B' ;"])) && clean(file([], ["   1:  SR[1]='A  B'   ;"])) === clean(file([], ["   1:  SR[1] = 'A  B' ;"]).replace('SR[1] = ', 'SR[1]=')), 'spacing inside a quoted string is data');
  check(clean(file([], ['    :  R[1]=1', '    :  R[2]=2'])) === clean(file([], ['   1:  R[1]=1 ;', '   2:  R[2]=2 ;'])), 'a numberless copy (":" for every number) equals its numbered twin');
  // from real controller files
  check(clean(file([], [one], [], '\r\r\n')) === clean(file([], [one])), 'CR CR LF (some controller-written files) is one line ending');
  check(clean(file([], ['   1:  R[1]=1 ;', '', '   2:  R[2]=2 ;'])) === clean(file([], ['   1:  R[1]=1 ;', '   2:   ;', '   3:  R[2]=2 ;'])), 'an empty line and the empty numbered line the renumber makes of it are the same');
  check(clean(file([], ['   1:  --kn:a', '    :  --eg:b ;', '   2:  R[1]=1 ;']), set('commentLines')).split('\n').slice(3, -3).join('|') === '   2:  R[1]=1 ;', 'comment lines: a multi-language comment starting with another tag');
  check(cleanForCompare('PROGRAM a\r\n  x = 1  \r\n-- note\r\nEND a\r\n', 'karel', dflt) === 'PROGRAM a\nx = 1\n-- note\nEND a\n', 'KAREL: line endings and spacing');
  check(cleanForCompare('PROGRAM a\n-- note\nEND a', 'karel', set('commentLines')) === 'PROGRAM a\nEND a', 'KAREL: comment lines');

  check([...compareIgnores(['names', 'bogus', 'case'])].join() === 'names,case' && [...compareIgnores('x')].join() === DEFAULT_COMPARE_IGNORES.join() && compareIgnores([]).size === 0, 'the setting: unknown entries dropped, a missing one is the default, an empty one means nothing');
  check(describeIgnores(dflt) === 'line numbers, line terminators, spacing and header bookkeeping' && describeIgnores(set()) === 'line endings' && describeIgnores(set('case')) === 'upper / lower case', `the title says what is ignored: ${describeIgnores(dflt)}`);
}
