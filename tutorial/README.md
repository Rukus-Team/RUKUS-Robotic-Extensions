# Robot Code tutorials (deep dive)

This bundle goes deeper than the in-editor walkthroughs. The walkthroughs teach the basics in
VS Code; these lessons are for when you want to work faster on real programs.

## How to use it

1. Install the **Robot Code** extension.
2. Unzip this bundle anywhere.
3. Open the folder in VS Code (`File > Open Folder…`), or run **Robot Code: Open the Tutorial
   Cell** first for a workspace to practise on.
4. Work through the lessons in `lessons/`. Each has a short objective, a worked example, and a
   practice step with the result you should see.

## Lessons

1. [Positions and frames](lessons/01-positions-and-frames.md) - offset, set axes, convert, mirror, relabel
2. [Refactoring](lessons/02-refactoring.md) - extract, inline, combine, remap a register
3. [Analysis](lessons/03-analysis.md) - flow, call graph, cross-reference, backup diff
4. [Sync in depth](lessons/04-sync-in-depth.md) - the snapshot as an index, and why a push can be refused
5. [Containers and RUKUS](lessons/05-containers-and-rukus.md) - cells, robot containers, the cluster bridge

The reference is the extension's **What Can I Do Here?** (`Ctrl+Alt+H`) and the README. The
reasons behind the designs are in the repository's `docs/design-*.md`.
