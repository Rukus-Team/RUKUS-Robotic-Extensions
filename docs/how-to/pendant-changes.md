# Find out whether someone touched a program on the pendant

Someone jogged the robot and taught a point without telling you. The question is whether your
file still matches the robot.

1. Open the program (in a robot container, so the extension knows which robot it belongs to).
2. Press **Fetch** on the editor tab - or run **Robot Code: Fetch from Robot…**
   (`robotCode.sync.fetch`). This reads the controller's copy into the snapshot; it never touches
   your file.
3. Press **Compare** (`robotCode.sync.compareFile`). The diff is usually a taught position, and
   the message names it: *"only taught positions differ (3)"*.
4. To take the robot's copy, press **Pull** (`robotCode.sync.pullFile`). One Ctrl+Z undoes it.

## Why a push cannot silently overwrite a pendant edit

Before a **Push**, the robot's copy is compared to the snapshot **verbatim**. If they differ, the
push is **refused** until you update the snapshot from the robot and review the diff. Nothing you
have not seen can be overwritten.

There is deliberately no watch mode: a watch is a poll wearing a different hat, and every poll
costs the controller a generated file.

## Related

- Design note: `docs/design-snapshot-ux.md`
- [Move points you have already taught](offset-and-move-positions.md)
