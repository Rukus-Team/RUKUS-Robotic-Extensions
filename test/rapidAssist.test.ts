/**
 * What drives RAPID argument hints and completion: which call the cursor is in and which
 * argument it is on, and the snippets built from the reference. Wired in by test/run.ts.
 */
import { callContext, rapidRef, instructionSnippet, positionalArgs } from '@abb/rapid/reference';

type Check = (cond: unknown, msg: string) => void;

export function run(check: Check): void {
  const cases: [string, ReturnType<typeof callContext>][] = [
    ['    MoveL ', { name: 'MoveL', index: 0 }],
    ['    MoveL p10, v1', { name: 'MoveL', index: 1 }],
    ['    MoveL p10, v100\\V:=5', { name: 'MoveL', index: 1, optional: 'V' }],
    ['    MoveL \\Conc, p10, v100, ', { name: 'MoveL', index: 2 }],
    ['    MoveL Offs(p10, 0, ', { name: 'Offs', index: 2, paren: true }],
    ['    MoveL Offs(p10, 0, 0, 100), v100, z10, tool0\\WObj:=', { name: 'MoveL', index: 3, optional: 'WObj' }],
    ['    TPWrite "a, b, (c"', { name: 'TPWrite', index: 0 }],
    ['    n := n + 1', undefined],
    ['    IF a THEN', undefined],
    ['    lbl: MoveJ p1, ', { name: 'MoveJ', index: 1 }],
    ['    x := Abs(', { name: 'Abs', index: 0, paren: true }],
    ['    MoveL p10, v100, z10, tool0;\n    MoveJ p20, ', { name: 'MoveJ', index: 1 }],
    ['    MoveL p10, v100, ! a, b, c', { name: 'MoveL', index: 2 }],
  ];
  for (const [text, want] of cases) {
    const got = callContext(text);
    const norm = (x: typeof got) => x && JSON.stringify({ name: x.name, index: x.index, optional: x.optional, paren: x.paren ?? undefined });
    check(norm(got) === norm(want), `callContext(${JSON.stringify(text)}) = ${norm(got)}, want ${norm(want)}`);
  }

  const movel = rapidRef('movel', 'instruction');
  check(!!movel && positionalArgs(movel).map(a => `${a.name}:${a.type}`).join(',') === 'ToPoint:robtarget,Speed:speeddata,Zone:zonedata,Tool:tooldata',
    `MoveL's required arguments from the manual: ${movel && positionalArgs(movel).map(a => `${a.name}:${a.type}`).join(',')}`);
  check(movel && instructionSnippet(movel) === 'MoveL ${1:ToPoint}, ${2:Speed}, ${3:Zone}, ${4:Tool};', `MoveL snippet: ${movel && instructionSnippet(movel)}`);
  check(movel?.args?.some(a => a.name === 'WObj' && a.optional && a.type === 'wobjdata'), 'MoveL has the optional \\WObj wobjdata');
  const offs = rapidRef('Offs', 'function');
  check(offs?.returns === 'robtarget' && positionalArgs(offs).length === 4, `Offs returns robtarget with 4 arguments: ${offs?.returns} ${offs && positionalArgs(offs).length}`);
}
