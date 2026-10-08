/**
 * RAPID formatting: the VB-style indenter against a hand-written module, then against the IRC5
 * corpus (never changes anything but leading whitespace; idempotent; files already laid out
 * by the controller barely move). Wired in by test/run.ts: `run(check)`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { formatRapid, detectRapidIndent, rapidIndents } from '@abb/rapid/format';
import { findCorpus } from './rapid.test';

type Check = (cond: unknown, msg: string) => void;
const apply = (text: string, edits: { line: number; newText: string }[]) => { const l = text.split(/\r?\n/); for (const e of edits) l[e.line] = e.newText; return l.join('\n'); };

export function run(check: Check): void {
  const messy = [
    '%%%', '  VERSION:1', '  LANGUAGE:ENGLISH', '%%%', '',
    'MODULE Main(SYSMODULE)',
    'VAR num n := 0;',
    '! a module comment',
    'CONST robtarget pA := [[1,2,3],[1,0,0,0],',
    '                      [0,0,0,0],[9E9,9E9,9E9,9E9,9E9,9E9]];',
    'PROC main()',
    'IF n > 0 THEN',
    'TPWrite "n";',
    '! inside the IF',
    'ELSEIF n < 0 THEN',
    'n := 0;',
    'ELSE',
    'FOR i FROM 1 TO 3 DO',
    'MoveL pA, v100,',
    '      z10, tool0;',
    'ENDFOR',
    'ENDIF',
    'TEST n',
    'CASE 1, 2:',
    'Stop;',
    'DEFAULT:',
    'WHILE TRUE DO',
    'WaitTime 1;',
    'ENDWHILE',
    'ENDTEST',
    'IF n = 5 n := 6;',
    'ERROR',
    'RETRY;',
    'ENDPROC',
    '   ',
    'LOCAL FUNC num Twice(num x)',
    'RETURN 2 * x;',
    'ENDFUNC',
    'ENDMODULE',
  ].join('\n');
  const want = [
    '%%%', '  VERSION:1', '  LANGUAGE:ENGLISH', '%%%', '',
    'MODULE Main(SYSMODULE)',
    '  VAR num n := 0;',
    '  ! a module comment',
    '  CONST robtarget pA := [[1,2,3],[1,0,0,0],',
    '                        [0,0,0,0],[9E9,9E9,9E9,9E9,9E9,9E9]];',
    '  PROC main()',
    '      IF n > 0 THEN',
    '          TPWrite "n";',
    '          ! inside the IF',
    '      ELSEIF n < 0 THEN',
    '          n := 0;',
    '      ELSE',
    '          FOR i FROM 1 TO 3 DO',
    '              MoveL pA, v100,',
    '                    z10, tool0;',
    '          ENDFOR',
    '      ENDIF',
    '      TEST n',
    '      CASE 1, 2:',
    '          Stop;',
    '      DEFAULT:',
    '          WHILE TRUE DO',
    '              WaitTime 1;',
    '          ENDWHILE',
    '      ENDTEST',
    '      IF n = 5 n := 6;',
    '  ERROR',
    '      RETRY;',
    '  ENDPROC',
    '',
    '  LOCAL FUNC num Twice(num x)',
    '      RETURN 2 * x;',
    '  ENDFUNC',
    'ENDMODULE',
  ].join('\n');
  const got = apply(messy, formatRapid(messy, { base: 2, step: 4 }));
  const gl = got.split('\n'), wl = want.split('\n');
  const diff = wl.map((w, i) => (gl[i] === w ? '' : `line ${i + 1}: got ${JSON.stringify(gl[i])} want ${JSON.stringify(w)}`)).filter(Boolean);
  check(diff.length === 0, `format (base 2, step 4) lays out every construct:\n    ${diff.slice(0, 8).join('\n    ')}`);
  check(formatRapid(got, { base: 2, step: 4 }).length === 0, 'formatting is idempotent');
  const six = apply(messy, formatRapid(messy, { base: 6, step: 3 })).split('\n');
  check(six[6] === '      VAR num n := 0;' && six[10] === '      PROC main()' && six[11] === '         IF n > 0 THEN' && six[5] === 'MODULE Main(SYSMODULE)', `a customer base of 6 and step of 3: ${JSON.stringify(six.slice(5, 12))}`);
  const d = detectRapidIndent(want);
  check(d.base === 2 && d.step === 4, `detectRapidIndent reads base 2, step 4 back: ${JSON.stringify(d)}`);
  check(rapidIndents('garbage without a module', { base: 2, step: 2 }).every(x => x === undefined), 'a file with no MODULE is left alone');

  // ---- indentation set by hand: any size, tabs ----
  const tabbed = apply(messy, formatRapid(messy, { base: 4, step: 4, useTabs: true, tabWidth: 4 })).split('\n');
  check(tabbed[6] === '\tVAR num n := 0;' && tabbed[10] === '\tPROC main()' && tabbed[11] === '\t\tIF n > 0 THEN', `tabs, 4 wide: ${JSON.stringify(tabbed.slice(6, 12))}`);
  const mixed = apply(messy, formatRapid(messy, { base: 2, step: 4, useTabs: true, tabWidth: 4 })).split('\n');
  check(mixed[10] === '  PROC main()' && mixed[11] === '\t  IF n > 0 THEN', `tabs with a base that is not a whole tab: the rest in spaces: ${JSON.stringify(mixed.slice(10, 12))}`);
  check(formatRapid(tabbed.join('\n'), { base: 4, step: 4, useTabs: true, tabWidth: 4 }).length === 0, 'tab-indented output is stable under a second format');
  const five = apply(messy, formatRapid(messy, { base: 1, step: 5 })).split('\n');
  check(five[10] === ' PROC main()' && five[11] === '      IF n > 0 THEN', `a base of 1 and a step of 5: ${JSON.stringify(five.slice(10, 12))}`);
  const dt = detectRapidIndent(tabbed.join('\n'));
  check(dt.useTabs === true && detectRapidIndent(want).useTabs === false, `detectRapidIndent sees tabs vs spaces: ${JSON.stringify(dt)}`);

  // ---- the corpus ----
  const root = findCorpus();
  if (!root) { console.log('  (abb-reference corpus not found; RAPID format corpus checks skipped)'); return; }
  const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
  const seen = new Set<string>();
  let files = 0, lines = 0, moved = 0, broken = 0, notIdem = 0, clean = 0;
  const worst: string[] = [];
  for (const f of walk(root).filter(p => /\.(mod|sys)$/i.test(p))) {
    const text = fs.readFileSync(f, 'latin1');
    if (/^[\xfc\xfe]/.test(text) || !/^\s*MODULE\s/im.test(text)) continue;
    const key = `${text.length}:${text.slice(0, 300)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    files++;
    const det = detectRapidIndent(text);
    const opt = { base: det.base ?? 2, step: det.step ?? 4 };
    const edits = formatRapid(text, opt);
    const out = apply(text, edits);
    const n = text.split(/\r?\n/).length;
    lines += n; moved += edits.filter(e => e.newText.trim()).length;
    if (!edits.length) clean++;
    // nothing but leading whitespace may change
    const strip = (s: string) => s.split(/\r?\n/).map(l => l.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '')).join('\n');
    if (strip(out) !== strip(text)) broken++;
    if (formatRapid(out, opt).length) notIdem++;
    const share = edits.length / n;
    if (share > 0.2) worst.push(`${path.basename(f)} ${(share * 100).toFixed(0)}% (base ${opt.base}, step ${opt.step})`);
  }
  check(files > 500 && broken === 0, `format changes nothing but indentation over ${files} corpus modules (${broken} changed code)`);
  check(notIdem === 0, `format is idempotent over the corpus (${notIdem} files move again)`);
  const pct = (moved / lines) * 100;
  check(pct < 10, `with each file's own base and step, formatting moves few lines of controller-written code: ${pct.toFixed(1)}% of ${lines}`);
  console.log(`  rapid format: ${files} modules, ${clean} untouched, ${moved} of ${lines} code lines re-indented (${pct.toFixed(1)}%); most moved: ${worst.slice(0, 4).join(', ') || 'none over 20%'}`);
}
