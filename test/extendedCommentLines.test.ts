/**
 * `--eg:` extended comments while editing: the lines under an unterminated one are its `:` lines,
 * never numbered instructions, and no line is re-wrapped unless a width is asked for.
 * Wired in by test/run.ts.
 */
import { renumber, applyLineEdits } from '@fanuc/tp/renumber';
import { parseTp } from '@fanuc/tp/parser';
import { tpChecks, CODES } from '@fanuc/tp/checks';
import { kindFindings } from '@fanuc/tp/knowledge';

type Check = (cond: unknown, msg: string) => void;

export function run(check: Check): void {
  const wrap = (mn: string[]) => ['/PROG  T', '/ATTR', 'LINE_COUNT\t= 0;', '/MN', ...mn, '/POS', '/END', ''].join('\n');
  // the /MN lines after a renumber in the controller's format; `caret` = /MN lines the caret is on
  const after = (mn: string[], o: { caret?: number[]; width?: number; semicolon?: boolean } = {}) => {
    const text = wrap(mn);
    const r = renumber(text, { width: 4, autoSemicolon: o.semicolon ?? true, updateLineCount: true, extendedCommentWidth: o.width ?? 0, skipLines: o.caret ? new Set(o.caret.map(c => c + 4)) : undefined });
    const out = applyLineEdits(text, r.edits).split('\n');
    return { lines: out.slice(4, out.indexOf('/POS')), count: r.lineCount };
  };
  const same = (got: string[], want: string[], msg: string) => check(got.join('\n') === want.join('\n'), `${msg}:\n${got.join('\n')}`);

  const long = '   1:  --eg: ' + 'word '.repeat(40).trim() + ' ;';
  same(after([long, '   2:  R[1]=1 ;']).lines, [long, '   2:  R[1]=1 ;'], 'a long extended comment line is left as written (no width set)');
  check(after([long]).lines.length === 1 && after([long], { width: 78 }).lines.length > 1, 'a width, when set, still re-wraps it');
  const longIf = '   1:  IF (' + Array.from({ length: 14 }, (_, i) => `R[${i + 1}]=${i + 1}`).join(' AND ') + ') THEN ;';
  same(after([longIf, '   2:  ENDIF ;'], { width: 78 }).lines, [longIf, '   2:  ENDIF ;'], 'an instruction line has no length limit');

  // Enter in the middle of a comment: the new blank line is a `:` line and stays open
  const mid = after(['   1:  --eg: first', '', '    :  third ;', '   2:  R[2]=1 ;']);
  same(mid.lines, ['   1:  --eg: first', '    :  ', '    :  third ;', '   2:  R[2]=1 ;'], 'a blank line inside an extended comment is a continuation, not a numbered line');
  check(mid.count === 2, `the comment counts as one line: ${mid.count}`);
  same(after(mid.lines).lines, mid.lines, 'and a second pass leaves it alone (the lines under it keep their `:`)');
  same(after(['   1:  --eg: first', '    :', '    :  third ;']).lines, ['   1:  --eg: first', '    :  ', '    :  third ;'], 'a blank `:` line in the middle gets no terminator');
  same(after(['   1:  --eg: first', '    :  second', '']).lines, ['   1:  --eg: first', '    :  second', '    :   ;'], 'a blank line at the end of an open comment is its last line');
  // text typed under it, without the head
  same(after(['   1:  R[1]=1 ;', '--eg: first line of it', 'more words here', '   2:  R[2]=1 ;']).lines,
    ['   1:  R[1]=1 ;', '   2:  --eg: first line of it', '    :  more words here ;', '   3:  R[2]=1 ;'], 'text typed under an open --eg line joins the comment');
  // Enter before the ` ;` of the last line leaves the terminator on a line of its own
  same(after(['   1:  --eg: first', '    :  second', ' ;', '   2:  R[2]=1 ;']).lines, ['   1:  --eg: first', '    :  second', '    :   ;', '   2:  R[2]=1 ;'], 'an orphaned terminator under the comment closes it as a `:` line');
  // what ends a comment still ends it
  same(after(['--eg: first', '   2:  R[2]=1 ;']).lines, ['   1:  --eg: first ;', '   2:  R[2]=1 ;'], 'a numbered line under it ends the comment');
  same(after(['   1:  --eg: first ;', 'R[2]=1']).lines, ['   1:  --eg: first ;', '   2:  R[2]=1 ;'], 'a terminated comment is over: the next line is an instruction');
  same(after(['   1:  --eg: first', '--eg: second']).lines, ['   1:  --eg: first ;', '   2:  --eg: second ;'], 'a second --eg line is a new comment');
  same(after(['   1:  --eg: first', '    :  second ;', '']).lines, ['   1:  --eg: first', '    :  second ;', '   2:   ;'], 'a blank line under a finished comment is a numbered line');
  // the caret line is not rewritten, but it still belongs to the comment
  same(after(['   1:  --eg: first', 'typing here', '    :  third ;'], { caret: [1] }).lines, ['   1:  --eg: first', 'typing here', '    :  third ;'], 'the line being typed is left alone and the comment around it stays whole');
  // a second ; typed at the end is taken out (the controller refuses ` ; ;`, ASBN-031)
  same(after(['   1:  R[1]=1 ; ;', '   2:  R[2]=2 ;;', '   3:J P[1] 100% FINE    ;  ;', '   4:  !note; ;', '   5:  //R[1]=1 ; ;', '   6:   ; ;', '   7:  --eg: text ; ;', "   8:  SR[1]='a;' ;", '   9:  R[9]=9 ;;;']).lines,
    ['   1:  R[1]=1 ;', '   2:  R[2]=2 ;', '   3:J P[1] 100% FINE ;', '   4:  !note; ;', '   5:  //R[1]=1 ; ;', '   6:   ;', '   7:  --eg: text ; ;', "   8:  SR[1]='a;' ;", '   9:  R[9]=9 ;'], 'a doubled terminator becomes one; comments, remarks and strings keep their text');
  same(after(['   1:  R[1]=1 ; ;', '   2:  R[2]=2 ;'], { caret: [0] }).lines, ['   1:  R[1]=1 ; ;', '   2:  R[2]=2 ;'], 'not while the caret is still on the line');
  same(after(['   1:L P[3] 1000mm/sec FINE', '    :  SPOT[S=1 ]    ; ;', '   2:  R[2]=2 ;']).lines, ['   1:L P[3] 1000mm/sec FINE', '    :  SPOT[S=1 ] ;', '   2:  R[2]=2 ;'], 'also on the last part of a wrapped instruction');
  same(after(['   1:  R[1]=1 ; ;'], { semicolon: false }).lines, ['   1:  R[1]=1 ; ;'], 'with auto-semicolon off terminators are left alone');
  // ---- what real controller files look like (a 1,152-program V9.40 backup, 2026-11-13) ----
  // a long instruction is wrapped onto `:` lines; only the last carries the ` ;`
  const wrapped = ['   1:  !Move and fire ;', '   2:L P[3] 1000mm/sec FINE', '    :  SPOT[S=1 ]    ;', '   3:  IF ((DI[216:SKIP]=ON OR ', '    :  DI[209:ACPT]=ON) ', '    :  AND DI[210:RJCT]=OFF),JMP LBL[30] ;', '   4:  LBL[30] ;'];
  same(after(wrapped).lines, wrapped, 'a wrapped instruction is left exactly as the controller wrote it');
  check(after(wrapped).count === 4, `...and counts as one line: ${after(wrapped).count}`);
  const wp = parseTp(wrap(wrapped));
  check(wp.lines.filter(l => l.kind === 'continuation').length === 3 && wp.numberedLineCount === 4, 'the parser takes the `:` lines as the rest of the instruction above');
  check(!tpChecks(wrap(wrapped), wp, {}).some(f => f.code === CODES.terminator || f.code === CODES.lineSeq || f.code === CODES.lineCount && false), `no missing-terminator or sequence finding on it: ${tpChecks(wrap(wrapped), wp, {}).filter(f => f.code === CODES.terminator || f.code === CODES.lineSeq).map(f => f.message).join(' | ')}`);
  check(kindFindings('bglogic', wp).filter(f => f.line === 9 || f.line === 10).length === 0, 'a rule check sees a wrapped IF as one instruction, not three');
  // but in a program that writes numberless lines, a `:` line is an instruction, also under a line still being typed
  const scaffold = ['   1:  R[1]=1 ;', '    :  R[2]=2 ;', '    :  R[5]=5 ;', '   2:  R[3]=3', '    :  R[4]=4 ;'];
  check(parseTp(wrap(scaffold)).lines.filter(l => l.kind === 'continuation').length === 0, 'numberless style: the `:` line under an unfinished line is not its continuation');
  check(parseTp(wrap(['   1:  R[1]=1', '    :  R[2]=2', '   2:  R[3]=3'])).lines.filter(l => l.kind === 'continuation').length === 0, 'a program without terminators: no line is taken for a continuation');
  // one `:` line stranded under a blank line (Enter after a wrapped line's first part) does not switch the rule off for the rest
  const three = ['   1:L P[1] 100mm/sec FINE', '    :  SPOT[S=1 ]    ;', '   2:L P[2] 100mm/sec FINE', '', '    :  SPOT[S=2 ]    ;', '   3:L P[3] 100mm/sec FINE', '    :  SPOT[S=3 ]    ;'];
  const t3 = parseTp(wrap(three));
  check(t3.lines[5].kind === 'continuation' && t3.lines[10].kind === 'continuation', 'the other wrapped instructions are still whole when one has been broken');
  const r3 = after(three).lines;
  const p3 = r3.findIndex(l => /L P\[3\]/.test(l));
  check(r3[0] === three[0] && r3[1] === three[1] && !/;\s*$/.test(r3[p3]) && r3[p3 + 1] === three[6], `...and the renumber leaves them alone:\n${r3.join('\n')}`);
  // a comment in several languages starts with any language tag, not only --eg
  const langs = ['   1:  --kn:first', '    :  --jp:second', '    :  --eg:Pick first string', '    :  --ch:Pick first string;', '   2:  SR[2]=SUBSTR SR[1],1,1 ;'];
  same(after(langs).lines, langs, 'a multi-language comment that starts with --kn is one comment');
  const lp = parseTp(wrap(langs));
  check(lp.lines.filter(l => l.ext).length === 4 && lp.numberedLineCount === 2, 'all four lines are the comment; two lines counted');
  const rem = parseTp(wrap(['   1:  //--kn:first', '    :  --eg:Initial Exposure Time ;', '   2:  R[1]=1 ;']));
  check(rem.lines[4].kind === 'remark' && rem.lines[5].ext === true && rem.numberedLineCount === 2, 'a remarked-out one keeps its `:` lines');
  check(after([long.replace('--eg:', '--jp:')], { width: 78 }).lines[0].startsWith('   1:  --jp: word'), 're-wrapping keeps the comment\'s own language tag');
  // without terminators nothing marks the end of a comment, so nothing is assumed
  same(after(['   1:  --eg: first', 'R[2]=1'], { semicolon: false }).lines, ['   1:  --eg: first', '   2:  R[2]=1'], 'with terminators off a typed line is not pulled into the comment');
}
