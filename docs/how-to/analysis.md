# Understand a cell

## Draw a program as a flow chart

Run **Show Program Flow** (`robotCode.tp.showFlow`) with a `.ls` file open. Every edge is
captioned with where it lands; TRUE / FALSE carry the whole condition; labels stack; the entry
node is bannered. **Copy as Mermaid** exports it.

## See who calls what

**Show Program Call Graph** (`robotCode.tp.showCallGraph`) draws callees to depth 5, direct
callers, and macro edges; a missing program is dashed.

## Find who touches a register or output

**Register & I/O Cross-Reference Report** (`robotCode.tools.xrefReport`) lists every R / PR / DO /
F with its read and write sites across all programs, exportable as CSV / HTML - the "who touches
`R[151]`" question.

## Find programs nothing calls

**Report: Programs Never Called** (`robotCode.tools.unusedPrograms`). It respects macros, RSR /
PNS tables and condition handlers.

## Compare two backups

**Compare Two Backups…** (`robotCode.tools.diffBackups`) shows changed programs, changed
positions (with deltas), changed registers, changed I/O comments and changed system variables -
the commissioning question "what changed between these two backups?".

## Open the register and I/O table

**Open Register & I/O Table** (`robotCode.data.openRegisterTable`) is a filterable webview with a
tab per kind, copy-as-`R[5:Comment]`, and find-uses.
