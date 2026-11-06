# 3. Analysis

**Objective:** answer "what does this program do, who uses it, and what changed" without reading
every line.

## Flow and call graph

- **Show Program Flow** draws the branch structure: TRUE / FALSE edges carry the whole condition,
  labels stack, the entry node is bannered. **Copy as Mermaid** exports it.
- **Show Program Call Graph** draws callees to depth 5 and direct callers; a missing program is
  dashed.

## Cross-reference

**Register & I/O Cross-Reference Report** lists every R / PR / DO / F with its read and write
sites across all programs, exportable as CSV / HTML - the "who touches `R[151]`" question. The
same findings appear as editor diagnostics (a register that is only ever read is flagged "never
written").

## Programs never called

**Report: Programs Never Called** respects macros, RSR / PNS tables and condition handlers.

## Compare two backups

**Compare Two Backups…** shows changed programs, changed positions (with deltas), changed
registers, changed I/O comments and changed system variables. This is the commissioning question:
*what changed between the last good backup and this one?*

**You should see** a report listing only the differences, with position deltas in mm and degrees.

## Practice

1. Compare the tutorial cell's two snapshots, or two of your own backups.
2. **You should see** a per-file difference list; open a changed program to jump to it.

## More

- How-to: `docs/how-to/analysis.md`
