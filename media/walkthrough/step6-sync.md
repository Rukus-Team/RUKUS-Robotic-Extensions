## Your file, the snapshot, and the robot

Think of it the way git thinks of a working tree, an index and a remote:

| Git | Robot Code |
|---|---|
| working tree | your working program folders |
| index | the snapshot (`.robocode-robot/snapshot/`) - the robot's **last known state** |
| remote | the live robot controller |

You always edit offline. The snapshot is the line you compare against and the thing a push is
checked with.

- **Fetch** reads the open file from the robot into the snapshot. It never touches your file.
- **Pull** fetches, then replaces your working copy with the robot's copy (one **Ctrl+Z**).
- **Push** sends your working copy to the robot - the one write - and always asks first.
- **Revert** puts your working copy back to the snapshot.

The **Snapshot** view shows every robot's snapshot, each file with its age and `=`/`≠` state.
The status bar shows the open file: its snapshot age, whether it is modified, and whether the
robot's copy has been compared.

### Why a push can be refused

Before a push, the robot's copy is compared to the snapshot **verbatim**. If they differ,
someone edited the program on the pendant and that change was never fetched - so the push is
refused until you **Update Snapshot from Robot**, review the diff, and push again. Nothing you
have not seen can be overwritten.

Each snapshot file's previous version is kept in `.robocode-robot/snapshot-history/`, so even a
fetched pendant edit stays recoverable.

### Keeping your own git honest

Turn on `robotCode.containers.gitAware` and a push will mention it when the program has
uncommitted changes in your own repository, offering to open Source Control - the same habit as
not pushing to a shared branch before you have committed.
