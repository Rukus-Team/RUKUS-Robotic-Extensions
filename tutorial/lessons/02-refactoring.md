# 2. Refactoring

**Objective:** split and merge programs safely, and renumber a register everywhere.

## Extract a selection into a new program

1. Select a block of self-contained lines.
2. Run **Extract Selection to New Program…**.

It refuses anything that is not self-contained control flow: a `JMP` that leaves the selection, a
jump into the middle of it, an unbalanced `IF` / `FOR`. TP has no block scope to protect the cut,
so the check is the feature. Positions used only by the moved lines go with them, renumbered from
`P[1]`; ones used on both sides are copied, and it warns the two copies will drift.

**You should see** a new program with a `CALL` left behind in the original.

## Inline a called program

Put the cursor on a `CALL` and run **Inline Called Program Here**. The callee's labels and
positions are renumbered past whatever this program already uses. A call with arguments is
refused.

## Renumber a register across the program

Run **Renumber Register / I-O in This Program…**, `R[5]` → `R[105]` everywhere in the file. Inline
comments are kept; a collision with a number already in use is reported. The robot-folder
right-click does the whole folder.

## Practice

1. Extract the `WAIT` line of `LOAD.LS` into its own program.
2. **You should see** the new program created and a `CALL` where the line was.

## More

- How-to: `docs/how-to/refactor.md`
