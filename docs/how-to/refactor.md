# Restructure a program

## Extract a selection into a new program

1. Select the lines.
2. Run **Extract Selection to New Program…** (`robotCode.tp.extractProgram`).

It refuses anything that is not self-contained control flow: a `JMP` that leaves the selection,
a jump into the middle of it, an unbalanced `IF` / `FOR`. TP has no block scope to protect the
cut, so the check is the feature. Positions used only by the moved lines go with them,
renumbered from `P[1]`; ones used on both sides are copied, and it warns the two copies will
drift.

## Inline a called program

Run **Inline Called Program Here** (`robotCode.tp.inlineProgram`) with the cursor on the `CALL`.
The callee's labels and positions are renumbered past whatever this program already uses. A call
with arguments is refused.

## Combine programs

**Combine Programs…** (`robotCode.tp.combinePrograms`) appends one program to another, fixing up
labels and positions.

## Renumber a register across the program

**Renumber Register / I-O in This Program…** (`robotCode.tp.remapRegister`) rewrites `R[5]` →
`R[105]` everywhere in the file, keeping inline comments and warning if the destination is already
in use. The workspace-wide version is on the robot-folder right-click.
