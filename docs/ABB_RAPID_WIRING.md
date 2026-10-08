# ABB RAPID - wiring the language into the extension

Phase 3 of the monorepo split added `packages/abb/src/rapid/`: a RAPID parser, diagnostics,
hover docs, a TextMate grammar, a language configuration and snippets.

**Wired 2026-09-25.** The language, grammar and icon come from the `mod` row in
`scripts/make-file-icons.mjs` (run `node scripts/sync-file-icon-manifest.mjs` after editing it);
snippets, the Latin-1 default and the `robotCode.abb.enabled` setting are in package.json;
`packages/abb/src/brand.ts` is the ABB brand (index + backup detection) and
`packages/abb/src/rapid/providers.ts` the providers, both registered from src/extension.ts only
while the setting is on. `npm run smoke:abb` checks them in a real VS Code against a corpus
backup. What follows is the plan as it was written, kept for the reasoning.

## What is there

| File | What it is |
|------|------------|
| `packages/abb/src/rapid/lexer.ts` | tokens with line/col; comments; `looksEncrypted` |
| `packages/abb/src/rapid/parser.ts` | `parseRapid(text)` -> `RapidModule`; `parseRobTarget`, `parseJointTarget`, `robTargetsOf`, `parseAggregate`, `routineAt`, `moduleSymbols` |
| `packages/abb/src/rapid/diagnostics.ts` | `diagnoseModule(mod)`, `diagnoseTask(mods, { shared })` -> `RapidIssue[]` |
| `packages/abb/src/rapid/docs.ts` | `lookupRapidDoc(word)`, `rapidDocMarkdown(doc)` |
| `packages/abb/src/rapid/builtins.ts` | instruction / function / type name sets |
| `syntaxes/rapid.tmLanguage.json` | grammar, scope `source.rapid` |
| `language-configs/rapid.language-configuration.json` | `!` comments, brackets, folding and indent rules |
| `snippets/rapid.json` | module / proc / func / trap / error / IF / FOR / WHILE / TEST / moves / robtarget |
| `test/rapid.test.ts` | unit checks, corpus checks, grammar checks |

Everything under `packages/abb` is pure TypeScript: no `vscode` import. The providers below
are the only VS Code-facing code still to write; they belong in
`packages/abb/src/rapid/providers.ts`, the way `packages/fanuc/src/karel/providers.ts` does it
for KAREL.

## File extensions

Checked against the 24 IRC5 backups (RobotWare 6.13): 1 204 `.mod`, 4 448 `.sys` and 3
`.SYS`. No `.modx` and no `.prg` appear. `.modx` (the RobotStudio/OmniCore XML-wrapped
module) and `.prg` (S4C and earlier) are still worth claiming - `.prg` is plain RAPID and
parses as-is; `.modx` does not and should stay out until someone needs it. The `.pgf` files
in HOME are XML lists of the modules in a program - not RAPID.

`.sys` is also the Windows driver extension. Registering it only for this language is
harmless, but the `filenamePatterns` below keep it to files that sit in a RAPID backup so a
workspace full of drivers is not suddenly RAPID. If that turns out too narrow, fall back to
plain `.sys`.

## package.json contributions

```jsonc
// contributes.languages
{
  "id": "abb-rapid",
  "aliases": ["ABB RAPID", "RAPID"],
  "extensions": [".mod", ".MOD", ".prg", ".PRG"],
  "filenamePatterns": ["**/RAPID/**/*.sys", "**/RAPID/**/*.SYS", "**/HOME/**/*.sys", "**/HOME/**/*.SYS", "**/SYSMOD/*.sys", "**/SYSMOD/*.SYS"],
  "firstLine": "^\\s*(%%%|MODULE\\s+\\w+)",
  "configuration": "./language-configs/rapid.language-configuration.json"
}

// contributes.grammars
{
  "language": "abb-rapid",
  "scopeName": "source.rapid",
  "path": "./syntaxes/rapid.tmLanguage.json"
}

// contributes.snippets
{
  "language": "abb-rapid",
  "path": "./snippets/rapid.json"
}

// contributes.configurationDefaults - the controller writes Latin-1, not UTF-8.
// 125 of the ~1000 distinct plain modules in the corpus carry Latin-1 bytes (Swedish and
// German comments, degree signs); none of them is valid UTF-8. Opened as UTF-8 those
// characters turn into U+FFFD and are written back that way on save.
"[abb-rapid]": {
  "files.encoding": "iso88591"
}
```

`.mod` is also used by other tools (Go's `go.mod` is a file name, not an extension, so it is
not affected; Modula-2 and some game engines use `.mod`). The `firstLine` pattern lets VS Code
pick RAPID for a `.mod` whose first line is `MODULE x` or `%%%` when another extension also
claims `.mod`.

File icons: `scripts/make-file-icons.mjs` builds the FANUC ones; add `mod` / `sys` there if
RAPID files should get their own.

## Providers to register

`src/extension.ts`, next to `registerKarelProviders(ctx, s)`:

```ts
import { registerRapidProviders } from '@abb/rapid/providers';
// ...
registerRapidProviders(ctx, s);
```

and in `packages/abb/src/rapid/providers.ts` (`const SEL = { language: 'abb-rapid' }`):

| Provider | Built on |
|----------|----------|
| `registerDocumentSymbolProvider` | `mod.routines` (name, `nameSpan`, `startLine`..`endLine`, `kind`, `signature`), `mod.data`, `mod.records`; routine-level `data` as children |
| `registerDefinitionProvider` | the word under the cursor -> `moduleSymbols(mod)` of this module, then of every module in the same `RAPID/TASKn` folder (+ `TASK0`, the shared modules); inside a routine try `routineAt(mod, line)` params and `data` first. RAPID is case-insensitive: compare upper-cased |
| `registerReferenceProvider` / `registerDocumentHighlightProvider` | `mod.refs` (with `write` for assignments), `mod.calls` (`kind: 'proc' | 'func' | 'late'`), `mod.connects` |
| `registerHoverProvider` | `lookupRapidDoc(word)` + `rapidDocMarkdown`; for a declared name, the declaration's `detail` / routine `signature` and `doc`; for a robtarget/jointtarget, `robTargetsOf(data)` / `parseJointTarget(init.text)` - show x/y/z, the quaternion and config, and drop external axes that `isUnusedAxis` |
| `registerFoldingRangeProvider` | `mod.blocks` (`open.line`..`close.line`) |
| `registerCompletionItemProvider` | `RAPID_INSTRUCTIONS`, `RAPID_FUNCTIONS`, `RAPID_TYPES`, plus the task's routines and data; trigger on `\\` for optional arguments |
| Diagnostics (`createDiagnosticCollection('abb-rapid')`) | `diagnoseTask(modulesOfTheTaskFolder, { shared: task0Modules })` when the file sits in `RAPID/TASKn/{SYSMOD,PROGMOD}`; `diagnoseModule(mod)` otherwise. Map `severity` 1:1, keep `code` as the diagnostic code |
| Code lens / outline of moves (optional) | `mod.moves` - each has `instruction`, `kind`, `target`, `speed`, `zone`, `tool`, `wobj`, `tload`, `gun`, `spot`, all with spans |

Spans are `{ line, col, len }` on one line (the `@core/span` type), so `spanToRange` from
`@core/util` converts them as for the FANUC languages. Argument spans (`RapidArg.span`) are
clamped to the argument's first line; `RapidArg.end` is where a wrapped argument ends.

Parse on every change is fine: the whole corpus (about 1 000 distinct plain modules, the largest
~140 KB) parses in about two seconds; a single module is milliseconds.

## Known gaps

- `diagnoseTask` resolves procedure-call statements only. Function calls (`Name(...)`) and
  data references are captured (`mod.calls` with `kind: 'func'`, `mod.refs`) but not checked:
  the built-in function list is not complete enough to call a miss an error.
- An unknown procedure is a warning, and only a hint when the task holds encrypted
  modules. In the corpus every task does - SpotWare and the site library ship encrypted
  `.sys` files - so every one of the 2 900-odd unresolved calls there is a hint.
- Encrypted modules parse to an empty module with `encrypted: true`.
- `.modx` is not handled.
