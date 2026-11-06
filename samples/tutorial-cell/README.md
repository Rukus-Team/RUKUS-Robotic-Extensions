# Tutorial Cell

> **Tip:** read this as a **preview** - press `Ctrl+Shift+V`, or click the **Open Preview** icon.

A tiny, self-contained cell for trying Robot Code. Nothing here talks to a real robot - the
two controllers are placeholders, so connecting to them will time out. They are here to show
the shape of a cell, not a live connection.

```
.robocode-cell/cell.json     the cell: its name and two controllers
S002R01/                     127.0.0.2 - working programs in LS/ and KL/, snapshot in .robocode-robot/snapshot/
S002R05/                     127.0.0.3 - working programs in LS/, snapshot in .robocode-robot/snapshot/
```

- `S002R01/LS/LOAD.LS` **differs** from its snapshot (an extra `WAIT` line).
- `S002R05/LS/PICK.LS` is **identical** to its snapshot.
- `S002R05/LS/BAD.LS` has a mistake to find, and is **not in the snapshot**.
- `R[5]` is `Part Count` in `S002R01`'s `numreg.va` - hover it in `LOAD.LS`.

A real robot container also gets a `.robocode-robot/.gitignore` (written by the wizard) that
keeps the snapshot out of your own git. This tutorial omits it so the snapshot is committed with
everything else.

## Try it

Each step says what you should see. If you do not see it, you are on the wrong track - reset the
cell from **Robot Code: Open the Tutorial Cell** and start again.

1. **Read a program.** Open `S002R01/LS/LOAD.LS` and hover `R[5]`, `P[1]`, `J` and `L`.
   **You should see** *Part Count* on `R[5]`, the taught coordinates on `P[1]`, and the motion
   line decoded on `J` / `L`.
2. **See the snapshot markers.** Open the **Robot Code** panel, then **Programs**.
   **You should see** `LOAD` marked `↑1` (it differs from the snapshot) and `PICK` marked `✓`
   (it matches).
3. **Compare.** With `LOAD.LS` open, press the tab's **Compare** button.
   **You should see** a one-line diff - the extra `WAIT R[5]>=10` line.
4. **Find the mistake (a practice problem).** Open `S002R05/LS/BAD.LS`.
   **You should see** a red squiggle under `LBL[99]` (an undefined label), and `BAD` marked `?`
   in the Programs view because it is not in the snapshot. Fix it by adding `LBL[99]` or changing
   the jump to a label that exists - the squiggle goes away.
5. **The cell (preview).** Turn on **Robot Code > Experimental: Robot Connections**.
   **You should see** `S002R01` and `S002R05` in the **Controllers** view, read from `cell.json`.
   Each robot's `robot.json` binds it to its controller by name.

## If you have RUKUS

RUKUS is a separate app. If it is installed, its clusters appear in the **RUKUS Clusters** view,
and a cluster can be written into this cell's `cell.json` (or this cell sent back as a cluster).
See the **Robot Code + RUKUS** walkthrough.
