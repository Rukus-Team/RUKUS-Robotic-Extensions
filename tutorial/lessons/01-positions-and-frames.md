# 1. Positions and frames

**Objective:** move and re-express taught points without re-jogging the robot.

## Worked example - the fixture moved 3 mm

1. Open a program with several points (try the tutorial cell's `S002R01/LS/LOAD.LS`).
2. Select the `P[n]` blocks, or the motion lines that use them.
3. Run **Robot Code: Offset Positions…**.
4. Type `X=3 Y=-1.5`.

**You should see** a preview of each point's new coordinates before anything is written. Confirm
and the numbers change in place, keeping the column and decimals.

The offset is applied **in each point's own user frame**. If your selection spans several frames,
the extension says so instead of moving them all the same way in the cell. A cartesian offset onto
a joint-taught point is refused, not converted.

## Set or add extended-axis values

Run **Set / Add Axis Values on Positions…** to put `E1=0` on `P[1-9]`, or add a delta to a rail
axis across a range.

## Convert to another frame

Run **Convert Positions to Another Frame…** and choose the target `UF` / `UT`. The robot does not
move and neither do the points - the same places are written against a different reference, so the
numbers can change by metres while nothing physically moves. Joint-taught points are refused:
turning joint angles into a position needs link geometry a backup does not contain.

## Relabel (do not confuse with convert)

**Relabel Position Frames…** changes the `UF` / `UT` a point *claims* while leaving every number
alone - so the point means a different place. Right for a point taught against the wrong frame
whose numbers are correct; wrong for everything else.

## Practice

1. Offset `P[1]` by `Z=10`, then undo it with `Ctrl+Z`.
2. **You should see** the point return exactly - the edit is one undoable step.

## More

- How-to: `docs/how-to/offset-and-move-positions.md`, `docs/how-to/frames.md`
- Design: `docs/FEATURES.md`, "0.9.0 - frames"
