# 4. Sync in depth

**Objective:** understand the snapshot model well enough to trust it on a live cell.

## The model

The snapshot is the robot's **index**, in the same shape as git:

| Git | Robot Code |
|---|---|
| working tree | your working program folders |
| index / remote-tracking ref | the snapshot (`.robocode-robot/snapshot/`) - the robot's last known state |
| remote | the live controller |
| remote history | the dated backup folders |

The snapshot only ever advances from the robot (a **Fetch**). Working edits are never staged into
it; your own git is the commit layer.

## The three comparisons, and why two of them differ

- **Working ↔ Snapshot** drives the tree marker. It is **normalized**: line numbers, terminators
  and `LINE_COUNT` are ignored, so a renumber reads as identical.
- **Robot ↔ Snapshot** is the **push gate**. It is **verbatim**: nothing is stripped, so a
  pendant edit that changed only a taught position still blocks a push.

That second rule is the safety feature. A wrongly-overwritten position looks perfectly valid
afterwards, so the push refuses until you **Update Snapshot from Robot**, review the diff, and
push again.

## A push completes the sync

After an explicit **Push**, the controller's read-back is pulled into the working file so
working = snapshot = robot. `containers.pullAfterPush` chooses how aggressively; the difference is
reported when the controller rewrote something (metadata, line numbers, labels).

## History

Every snapshot file's previous version is kept in `.robocode-robot/snapshot-history/`, bounded by
`containers.snapshotHistory`. **Snapshot History…** browses a file's kept versions - diff, open,
or restore one into the working copy.

## Practice

1. Open `S002R01/LS/LOAD.LS` (it differs from its snapshot) and press **Compare**.
2. **You should see** a one-line diff. Press **Revert** and the file returns to the snapshot;
   `Ctrl+Z` undoes even that.

## More

- Explanation: `docs/design-snapshot-ux.md`
- How-to: `docs/how-to/pendant-changes.md`
