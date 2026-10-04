// Program templates: expansion, and that a program built from one is a clean controller file.
import { parseTp } from '@fanuc/tp/parser';
import { renumber } from '@fanuc/tp/renumber';
import { DEFAULT_HEADER_TEMPLATES, expandHeader, ruleLine } from '@fanuc/tp/headers';
import { DEFAULT_PROGRAM_TEMPLATES, expandTemplate, templatePrompts, buildProgramText, layoutBodyLine, unnumberedBodyLines } from '@fanuc/tp/programTemplates';

export function run(check: (cond: unknown, msg: string) => void): void {
  const main = DEFAULT_PROGRAM_TEMPLATES.find(t => t.name === 'Main loop')!;
  const empty = DEFAULT_PROGRAM_TEMPLATES.find(t => t.name === 'Empty')!;
  check(!!main && !!empty && empty.lines.length === 0, 'default program templates: Empty and Main loop');
  check(templatePrompts(main).join(',') === 'UFRAME,UTOOL', `Main loop asks for: ${templatePrompts(main).join(',')}`);

  const rule = '-'.repeat(32);
  const ex = expandTemplate(main, { UFRAME: '1', UTOOL: '2', RULE: rule });
  check(ex.missing.length === 0 && ex.tooLong.length === 0, `Main loop expands fully: missing ${ex.missing.join(',')} tooLong ${ex.tooLong.join(',')}`);
  check(ex.lines[0] === `!${rule}` && ex.lines[3] === 'UFRAME_NUM=1' && ex.lines[4] === 'UTOOL_NUM=2' && ex.lines[6] === 'LBL[10:MAIN LOOP]' && ex.lines[ex.lines.length - 1] === 'JMP LBL[10]', `Main loop lines: ${JSON.stringify(ex.lines)}`);
  const unanswered = expandTemplate(main, { RULE: rule });
  check(unanswered.missing.join(',') === 'UFRAME,UTOOL' && unanswered.lines[3] === 'UFRAME_NUM=${UFRAME}', 'unanswered placeholders are left as written and reported');

  // layout follows the controller: motion hugs the colon, the rest sits two spaces in, blank is "   ;"
  check(layoutBodyLine('J P[1] 100% FINE') === 'J P[1] 100% FINE ;' && layoutBodyLine('R[1]=1') === '  R[1]=1 ;' && layoutBodyLine('') === '   ;' && layoutBodyLine('CALL SUB ;') === '  CALL SUB ;', 'body line layout');
  check(unnumberedBodyLines(['R[1]=1'], 4)[0] === '       R[1]=1 ;', `unnumbered line keeps the number field blank: ${JSON.stringify(unnumberedBodyLines(['R[1]=1'], 4))}`);

  // a whole program: Generic header + Main loop is a clean controller file
  const generic = DEFAULT_HEADER_TEMPLATES.find(t => t.name === 'Generic')!;
  const header = expandHeader(generic, { PROGRAM: 'MAIN_PICK', DESCRIPTION: 'Picks bolts', AUTHOR: 'RUKUS', DATE: '26-09-16', RULE: ruleLine(generic) }).lines;
  const text = buildProgramText({ name: 'main_pick', comment: 'Picks bolts', group: '1,*,*,*,*', headerLines: header, bodyLines: ex.lines, date: '26-09-16', time: '12:00:00' });
  const prog = parseTp(text);
  const expected = header.length + ex.lines.length;
  check(prog.header.name === 'MAIN_PICK' && prog.numberedLineCount === expected && prog.header.attrs.get('LINE_COUNT')?.value === String(expected), `built program counts ${prog.numberedLineCount} lines, LINE_COUNT ${prog.header.attrs.get('LINE_COUNT')?.value}, expected ${expected}`);
  check(prog.labels.some(l => l.num === 10) && prog.jumps.some(j => j.num === 10) && prog.lines.filter(l => l.kind === 'comment').length === header.length + 4, 'built program parses its label, its jump and its comments');
  const r = renumber(text, { width: 4, autoSemicolon: true, updateLineCount: true });
  check(r.edits.length === 0, `a built program needs no renumber edits: ${JSON.stringify(r.edits.slice(0, 3))}`);

  // no header, no template: the one-line comment the wizard always wrote
  const bare = buildProgramText({ name: 'X', comment: '', group: '*,*,*,*,*', headerLines: [], bodyLines: [], date: '26-09-16', time: '12:00:00' });
  const bp = parseTp(bare);
  check(bp.numberedLineCount === 1 && bp.header.attrs.get('LINE_COUNT')?.value === '1' && renumber(bare, { width: 4, autoSemicolon: true, updateLineCount: true }).edits.length === 0, 'empty template gives the one-comment program');
}
