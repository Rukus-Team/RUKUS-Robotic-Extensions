/**
 * Snippets are offered where their statement starts, and a block statement that is already under
 * way gets its remainder (`THEN ... ENDIF`) instead of a second, whole statement.
 * Wired in by test/run.ts.
 */
import { readSnippets, blockTails, blockContinuation, statementStart, type SnippetLanguage } from '@core/snippets';
import tpJson from '../snippets/tp.json';
import karelJson from '../snippets/karel.json';
import rapidJson from '../snippets/rapid.json';

type Check = (cond: unknown, msg: string) => void;

export function run(check: Check): void {
  const snippets = { tp: readSnippets(tpJson), karel: readSnippets(karelJson), rapid: readSnippets(rapidJson) };
  const tails = { tp: blockTails(snippets.tp), karel: blockTails(snippets.karel), rapid: blockTails(snippets.rapid) };

  check(snippets.tp.find(s => s.name === 'If then block')?.prefixes.join('|') === 'ifthen|if|if then endif', 'a snippet keeps all its prefixes');
  const tailList = (l: SnippetLanguage) => tails[l].map(t => `${t.head}: ${t.label}`).join(' | ');
  check(tailList('tp') === 'IF: THEN … ENDIF | IF: THEN … ELSE … ENDIF', `TP block tails: ${tailList('tp')}`);
  check(tailList('karel') === 'IF: THEN … ENDIF | IF: THEN … ELSE … ENDIF | FOR: DO … ENDFOR | WHILE: DO … ENDWHILE | SELECT: OF … ENDSELECT', `KAREL block tails: ${tailList('karel')}`);
  check(tailList('rapid') === 'IF: THEN … ENDIF | FOR: DO … ENDFOR | WHILE: DO … ENDWHILE', `RAPID block tails: ${tailList('rapid')}`);
  check(tails.tp[0].insert === 'THEN ;\n  ${0}\nENDIF ;', `the TP tail is the snippet from THEN on: ${JSON.stringify(tails.tp[0].insert)}`);

  // `|` marks the caret; what is offered there: the tails' labels, `keyword` when only the keyword, or nothing
  const at = (lang: SnippetLanguage, text: string) => {
    const lines = text.split('\n');
    const line = lines.findIndex(l => l.includes('|'));
    const col = lines[line].indexOf('|');
    lines[line] = lines[line].replace('|', '');
    const c = blockContinuation(lang, tails[lang], lines, line, col);
    return c ? `${c.word}>${c.tails.length ? c.tails.map(t => t.label).join(',') : c.keyword}+${c.tail}` : undefined;
  };
  const cases: [SnippetLanguage, string, string | undefined][] = [
    // the reported one: a second IF block written into the IF being typed
    ['tp', '   3:  IF (R[1]=1) TH|', 'TH>THEN … ENDIF,THEN … ELSE … ENDIF+0'],
    ['tp', '   3:  IF (R[1]=1) | ;', '>THEN … ENDIF,THEN … ELSE … ENDIF+2'],
    ['tp', '   3:  IF (R[1]=1 AND DI[2:ready]=ON) then|   ;', 'then>THEN … ENDIF,THEN … ELSE … ENDIF+4'],
    ['tp', '   3:  IF (R[1]=1)TH|', 'TH>THEN … ENDIF,THEN … ELSE … ENDIF+0'],
    // its ENDIF is already there: THEN alone
    ['tp', '   3:  IF (R[1]=1) TH|\n   4:  R[2]=1 ;\n   5:  ENDIF ;', 'TH>THEN ;+0'],
    // ... unless that ENDIF closes another IF
    ['tp', '   2:  IF (R[5]=0) THEN ;\n   3:  IF (R[1]=1) TH|\n   5:  ENDIF ;', 'TH>THEN … ENDIF,THEN … ELSE … ENDIF+0'],
    ['tp', '   2:  !ENDIF ;\n   3:  IF (R[1]=1) TH|', 'TH>THEN … ENDIF,THEN … ELSE … ENDIF+0'],
    // not the place for THEN
    ['tp', '   3:  IF R[1]=1,JMP LBL[2] T|', undefined],
    ['tp', '   3:  IF (R[1]=T|', undefined],
    ['tp', '   3:  IF (R[1]=1) THEN T|', undefined],
    ['tp', '   3:  IF (R[1]=1) TH| R[2]=1 ;', undefined],
    ['tp', '   3:  IF (R[1:t|', undefined],
    ['tp', '   3:  !IF (R[1]=1) TH|', undefined],
    ['tp', '   3:  WAIT (R[1]=1) TH|', undefined],
    ['tp', '   3:  IF (R[1]=1) X|', undefined],

    ['karel', '  IF status <> 0 TH|', 'TH>THEN … ENDIF,THEN … ELSE … ENDIF+0'],
    ['karel', '  IF done t|', 't>THEN … ENDIF,THEN … ELSE … ENDIF+0'],
    ['karel', '  IF status = t|', undefined],
    ['karel', '  IF a AND t|', undefined],
    ['karel', "  IF name = 'x' TH|", 'TH>THEN … ENDIF,THEN … ELSE … ENDIF+0'],
    ['karel', '  -- IF done TH|', undefined],
    ['karel', '  IF done TH| -- note', undefined],
    ['karel', '  FOR i = 1 TO 10 D|', 'D>DO … ENDFOR+0'],
    ['karel', '  FOR i = 1 T|', undefined],
    ['karel', '  WHILE busy DO|', 'DO>DO … ENDWHILE+0'],
    ['karel', '  SELECT mode O|', 'O>OF … ENDSELECT+0'],
    ['karel', '  IF done TH|\n    x = 1\n  ENDIF', 'TH>THEN+0'],
    ['karel', '  WAIT FOR done TH|', undefined],

    ['rapid', '    IF reg1 > 5 TH|', 'TH>THEN … ENDIF+0'],
    ['rapid', '    IF di1 = 1 AND t|', undefined],
    ['rapid', '    FOR i FROM 1 TO 10 D|', 'D>DO … ENDFOR+0'],
    ['rapid', '    WHILE reg1 < 5 d|', 'd>DO … ENDWHILE+0'],
    ['rapid', '    ! IF reg1 > 5 TH|', undefined],
    // a compact IF has no ENDIF and is not an opener; the THEN ... ENDIF pair above is complete
    ['rapid', '    IF a THEN\n      IF b Stop;\n    ENDIF\n    IF reg1 > 5 TH|', 'TH>THEN … ENDIF+0'],
  ];
  for (const [lang, text, want] of cases) {
    const got = at(lang, text);
    check(got === want, `${lang} ${JSON.stringify(text)}: ${got}, want ${want}`);
  }

  // whole-statement snippets: at the start of a statement only
  const starts: [SnippetLanguage, string, string | undefined][] = [
    ['tp', '   3:  IF', 'IF'], ['tp', '   3:  ', ''], ['tp', 'if', 'if'], ['tp', '   3:  !', '!'], ['tp', '   3:  r=', 'r='], ['tp', '   3:  R++', 'R++'], ['tp', '   3:  =', undefined],
    ['tp', '   3:  IF (R[1]=1) TH', undefined], ['tp', '   3:  R[1]=DO', undefined], ['tp', '   3:  IF DI[1]=ON,CALL', undefined],
    ['karel', '  if', 'if'], ['karel', '', ''], ['karel', '  IF done THEN wr', 'wr'], ['karel', '  x = 1; fo', 'fo'],
    ['karel', '  IF done th', undefined], ['karel', '  x = sel', undefined], ['karel', '  -- if', undefined], ["karel", "  WRITE('if", undefined],
    ['rapid', '    mo', 'mo'], ['rapid', '    IF reg1 > 5 th', undefined], ['rapid', '    x := fo', undefined], ['rapid', '    ! if', undefined],
  ];
  for (const [lang, text, want] of starts) {
    const got = statementStart(lang, text, text.length);
    check(got === want, `statementStart ${lang} ${JSON.stringify(text)}: ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
}
