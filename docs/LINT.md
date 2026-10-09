# Linting robot programs

One set of checks for FANUC TP (`.ls`), KAREL (`.kl`) and ABB RAPID (`.mod`, `.sys`, `.prg`, `.modx`, `.sysx`).
It runs in three places, and they all report the same findings:

| where | what |
|---|---|
| the editor | the Problems panel for every open program, as you type |
| **RUKUS: Lint Folder…** | every program under a folder or backup (Explorer right-click → RUKUS, or the Command Palette); findings go to Problems, and a summary goes to Output → *Robot Code Lint* |
| `robot-lint` | the same from a command line, for CI, RUKUS or a quick look at a backup |

RAPID needs `robotCode.abb.enabled` in the editor. `robot-lint` always checks all three languages.

## Rules

There are two kinds of rule:

- **check** rules flag something the controller or ktrans will refuse, or something that goes wrong on the robot. They are on by default.
- **style** rules (`tp.style.*`, `karel.style.*`, `rapid.style.*`) are house rules. The ones most plants agree on are hints: a WAIT with no timeout, a missing program comment, TODO left in, unused LOCAL data, BREAK left in. The opinionated ones are off until you turn them on: program/routine length, naming, keyword case, fixed waits, uncommented I/O, frame selection, speed limits, inline targets. No style rule is an error by default.

`robot-lint --rules` lists every rule with its default and its options.

## .robotlint.json

The nearest `.robotlint.json` at or above a file applies to it. **RUKUS: Create Lint Config** writes a starter file, and `robot-lint --init` does the same from a command line. VS Code completes the rule names from the schema.

```json
{
  "rules": {
    "tp.unusedLabel": "off",
    "tp.style.*": "info",
    "tp.style.programLength": ["warning", { "max": 300 }],
    "tp.style.programName": ["hint", { "pattern": "^(PNS|RSR|SUB_)[A-Z0-9_]*$" }],
    "rapid.style.dataNaming": ["hint", { "robtarget": "p", "tooldata": "tool" }],
    "karel.style.keywordCase": "hint"
  },
  "ignore": ["old/**", "*_bak.ls"]
}
```

- Each rule takes `off`, `hint`, `info`, `warning` or `error`. Add `[severity, { options }]` to set its options.
- A key ending in `.*` sets every rule with that prefix, and `*` sets every rule. An exact code wins over a prefix, and a longer prefix wins over a shorter one.
- `ignore` takes glob patterns relative to the config file. A pattern without `/` matches the file name in any folder.
- The existing `robotCode.tp.diagnostics.*` and `robotCode.karel.diagnostics.*` settings still work in the editor.

## How files belong together

- **TP:** the programs in one folder are one robot. A `CALL` to a program the folder doesn't have (as `.ls`, `.tp`, `.pc` or `.kl`) is reported.
- **RAPID:** the modules of one task (`RAPID/TASKn/SYSMOD` + `PROGMOD`) are checked together, with TASK0's shared modules. A library in a backup's `HOME` folder is checked against the backup's tasks and the rest of `HOME`.
- A few TP checks need the editor's data: the robot's `.va` files, the cross-reference and a live controller. These are `tp.crossReference`, `tp.unknownMacro`, `tp.payload` and `tp.commentMismatch`. Lint Folder and `robot-lint` skip them.

## robot-lint

`dist/robot-lint.js` is built with the extension and ships inside the `.vsix`. It runs on plain Node 18+:

```
node robot-lint.js [paths...] [--config file] [--format text|json|sarif] [--output file]
                   [--quiet] [--max-warnings n] [--rules [language]] [--schema] [--init]
```

Exit codes: `0` means no errors, `1` means errors (or more warnings than `--max-warnings`), and `2` means it could not run.
`--format sarif` writes SARIF 2.1.0 for code-scanning tools. From the repo, `npm run lint:robot -- <folder>` builds it and runs it.

After adding or changing a rule, regenerate the schema (a unit test fails if you forget):

```
node dist/robot-lint.js --schema > schemas/robotlint.schema.json
```
