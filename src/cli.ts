/**
 * robotcode - the extension's base TP edits from a command line, for editors that are not
 * VS Code (Notepad++ through its Run menu or NppExec; see notepad++/README.md). The same
 * code as the extension - renumber.ts, teach.ts, parser.ts - with no vscode import, so a
 * file edited in Notepad++ comes out byte-for-byte as the extension would write it.
 *
 *   node robotcode.js renumber  <file.ls> [--width 4] [--no-semicolon]
 *   node robotcode.js labels    <file.ls> [--start 10] [--step 10]
 *   node robotcode.js format    <file.ls>      lay /POS out the controller's way
 *   node robotcode.js strip     <file.ls>      a copy without position data, <name>_nopos.ls
 *   node robotcode.js check     <file.ls>      list labels/positions/calls problems, no edit
 *
 * The file is rewritten in place (except strip and check) and keeps its line endings.
 * Exit code 0 = done / nothing to report, 1 = problems reported, 2 = could not run.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { renumber, renumberLabels, applyLineEdits, stripPositions } from '@fanuc/tp/renumber';
import { formatPositions, applyTeachEdits } from '@fanuc/tp/teach';
import { parseTp } from '@fanuc/tp/parser';
import { EXT_COMMENT_WIDTH } from '@fanuc/tp/extendedComment';

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? Number(process.argv[i + 1]) : NaN;
  return Number.isFinite(v) ? v : fallback;
}

function main(): number {
  const [cmd, file] = process.argv.slice(2);
  if (!cmd || !file || cmd === 'help') {
    console.log('usage: robotcode <renumber|labels|format|strip|check> <file.ls> [options] - see notepad++/README.md');
    return cmd === 'help' ? 0 : 2;
  }
  let text: string;
  try { text = fs.readFileSync(file, 'latin1'); } catch (e: any) { console.error(`robotcode: cannot read ${file}: ${e?.message ?? e}`); return 2; }
  const write = (out: string, what: string) => {
    if (out === text) { console.log(`${path.basename(file)}: ${what} - nothing to change`); return; }
    fs.writeFileSync(file, out, 'latin1');
    console.log(`${path.basename(file)}: ${what}`);
  };

  switch (cmd) {
    case 'renumber': {
      const r = renumber(text, { width: arg('width', 4), autoSemicolon: !process.argv.includes('--no-semicolon'), updateLineCount: true, extendedCommentWidth: EXT_COMMENT_WIDTH });
      write(applyLineEdits(text, r.edits), `renumbered, ${r.lineCount} lines`);
      return 0;
    }
    case 'labels': {
      const r = renumberLabels(text, { start: arg('start', 10), step: arg('step', 10) });
      write(applyTeachEdits(text, r.edits), `${r.mapping.length} label(s) renumbered${r.indirectJumps ? `; ${r.indirectJumps} indirect JMP LBL[R[n]] not followed - check them` : ''}`);
      return 0;
    }
    case 'format':
      write(applyTeachEdits(text, formatPositions(text)), '/POS laid out the controller\'s way');
      return 0;
    case 'strip': {
      const out = file.replace(/(\.ls)?$/i, '_nopos.ls');
      fs.writeFileSync(out, stripPositions(text), 'latin1');
      console.log(`${path.basename(out)} written without position data`);
      return 0;
    }
    case 'check': {
      const prog = parseTp(text);
      const problems: string[] = [];
      const labels = new Set(prog.labels.map(l => l.num));
      for (const j of prog.jumps) if (typeof j.num === 'number' && !labels.has(j.num)) problems.push(`line ${j.line + 1}: JMP LBL[${j.num}] - no such label`);
      const taught = new Set(prog.positions.map(p => p.index));
      for (const r of prog.posRefs) if (!taught.has(r.index)) problems.push(`line ${r.line + 1}: P[${r.index}] has no position data in /POS`);
      const used = new Set(prog.posRefs.map(r => r.index));
      for (const p of prog.positions) if (!used.has(p.index)) problems.push(`/POS: P[${p.index}] is never used`);
      for (const p of problems) console.log(`${file}: ${p}`);
      const callees = [...new Set(prog.calls.map(c => c.name))];
      console.log(`${path.basename(file)}: ${problems.length} problem(s), ${callees.length ? `${prog.calls.length} call(s) to ${callees.join(', ')}` : 'no calls'}`);
      return problems.length ? 1 : 0;
    }
    default:
      console.error(`robotcode: unknown command ${cmd}`);
      return 2;
  }
}

process.exitCode = main();
