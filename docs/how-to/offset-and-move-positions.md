# Move points you have already taught

## Offset a selection

1. Select the `P[n]` blocks, or the motion lines that use them.
2. Run **Robot Code: Offset Positions…** (`robotCode.tp.offsetPositions`).
3. Type the shift - `X=3 Y=-1.5`, `3 0 -1.5` or `E1=250` all parse.
4. Confirm the preview.

The offset is applied **in each point's own user frame**. A selection spanning several frames
says so rather than moving them all the same way in the cell. A cartesian offset onto a
joint-taught point is refused, not converted.

## Set or add extended-axis values

Run **Set / Add Axis Values on Positions…** (`robotCode.tp.setAxisValues`) to put `E1=0` on
`P[1-9]`, or add a delta to the rail axis across a range.

## Mirror a selection

Run **Mirror Positions Across a Plane…** (`robotCode.tp.mirrorPositions`), then choose which
frame's plane to reflect across. Orientation is conjugated, so the result is still a valid
rotation; `CONFIG` is left alone and flagged, because a mirrored pose often needs a different
arm configuration.

## Clean up unused positions

Run **Clean Up Unused Positions…** (`robotCode.tp.cleanupPositions`) to review and remove points
no live line uses. **Copy Program Without Position Data** (`robotCode.tp.stripPositions`) writes a
copy with the `/POS` block dropped.

## Related

- [Change which frame a point is written against](frames.md)
- [Find out whether someone touched a program on the pendant](pendant-changes.md)
