# Change which frame a point is written against

## Convert a point to another frame

1. Select the points.
2. Run **Robot Code: Convert Positions to Another Frame…** (`robotCode.tp.convertFrame`).
3. Choose the target `UF` / `UT`.

**The robot does not move, and neither do the points** - the same places in the cell are written
down against a different reference, so the numbers can change by metres while nothing physically
moves. The confirmation says so before anything is applied.

This needs no kinematics: converting a cartesian point between frames needs only the two frames,
which `sysframe.va` states exactly. Joint-taught points are refused, because turning joint angles
into a position needs the robot's link geometry.

## Relabel frames without converting

**Relabel Position Frames…** (`robotCode.tp.relabelFrames`) changes the `UF` / `UT` a point
claims **while leaving every number alone**, so the point ends up meaning a different place in the
cell. Right for a point taught against the wrong frame whose numbers are correct; wrong for
everything else.

## Related

- [Move points you have already taught](offset-and-move-positions.md)
- Design note: `docs/FEATURES.md`, "0.9.0 - frames"
