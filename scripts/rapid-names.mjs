// The RAPID built-in names for the generators (scripts/sync-rapid-grammar.mjs, scripts/make-notepadpp.mjs), the same
// set packages/abb/src/rapid/builtins.ts exports: its hand lists (instructions, functions, types, in that order), then
// every name of reference.json, reference-rw8.json, reference-options.json (EGM, SoftMove, Force Control) and
// manual-names.json, as RobotWare spells it. Read as text and
// JSON: the scripts run without a TypeScript build.
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

// RAPID's reserved words (RAPID kernel manual, RobotWare 8): never a built-in name. Break and Continue are also
// instructions (`Break;`, `Continue;`): builtins.ts keeps them, the grammar colours them as keywords (rapidNames(root, true)).
const RESERVED = new Set('ALIAS AND BACKWARD BREAK CASE CONNECT CONST CONTINUE DEFAULT DIV DO ELSE ELSEIF ENDFOR ENDFUNC ENDIF ENDMODULE ENDPROC ENDRECORD ENDTEST ENDTRAP ENDWHILE ERROR EXIT FALSE FOR FROM FUNC GOTO IF INOUT LOCAL MOD MODULE NOSTEPIN NOT NOVIEW OR PERS PROC RAISE READONLY RECORD RETRY RETURN STEP SYSMODULE TEST THEN TO TRAP TRUE TRYNEXT UNDO VAR VIEWONLY WHILE WITH XOR'.split(' '));

/** { instructions, functions, types }: spelled names, hand-listed ones first, no duplicates (case-insensitive); `grammar`: no reserved word at all. */
export function rapidNames(root, grammar = false) {
  const dir = path.join(root, 'packages', 'abb', 'src', 'rapid');
  const ts = readFileSync(path.join(dir, 'builtins.ts'), 'utf8');
  const hand = [...ts.matchAll(/= set\(`([^`]*)`\)/g)].map(m => m[1].split(/\s+/).filter(Boolean));
  const json = f => JSON.parse(readFileSync(path.join(dir, f), 'utf8'));
  const rw8 = json('reference-rw8.json').entries;
  const fixed = new Set(rw8.filter(e => e.fixKind).map(e => e.name.toUpperCase()));
  const ref = [
    ...json('reference.json').entries.filter(e => !fixed.has(e.name.toUpperCase())),
    ...rw8.filter(e => e.summary !== undefined),
    ...json('reference-options.json').entries,
  ];
  const manual = json('manual-names.json');
  const known = (kind, list) => {
    const seen = new Set(list.map(x => x.toUpperCase()));
    const out = [...list];
    const more = [...ref.filter(e => e.kind === kind).map(e => e.name),
      ...[...manual.rw6.entries, ...manual.rw8.entries].filter(e => e[0] === kind).map(e => e[1])];
    for (const n of more) {
      const u = n.toUpperCase();
      if (seen.has(u) || (RESERVED.has(u) && (grammar || (u !== 'BREAK' && u !== 'CONTINUE'))) || !/^[A-Za-z_]\w*$/.test(n)) continue;
      seen.add(u); out.push(n);
    }
    return out;
  };
  const drop = list => grammar ? list.filter(n => !RESERVED.has(n.toUpperCase())) : list;
  return { instructions: drop(known('instruction', hand[0])), functions: drop(known('function', hand[1])), types: drop(known('type', hand[2])) };
}
