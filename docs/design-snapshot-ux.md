# Design: Snapshot UX - git-shaped sync

> Status: **Implemented** (26.91.24012, issue #12)

## The model

The snapshot stops being a read-only inventory and becomes the robot's **index**, in the
same shape as git:

| Git | Robot Code |
|---|---|
| working tree | the working program folders (`robot.json.programs`) - the editable set |
| index / remote-tracking ref | `.robocode-robot/snapshot/` - the robot's **last known state**, and the base every diff is against |
| remote (`origin`) | the live robot controller (`MD:` device) |
| remote history | the dated backup folders (RUKUS's store) |
| your own repository | the local commit layer - the extension does not replace it |

The snapshot only ever advances from the robot (a fetch). Working edits are never staged into
it. There is deliberately no `commit`: your own git is that layer.

### Invariants
1. The snapshot is never silently overwritten with local edits - it only advances from a fetch.
2. The working copy is never silently overwritten by the robot - pull and revert are explicit
   and undoable.
3. A push never overwrites robot changes the snapshot has not seen.

### Sync states
| State | Meaning |
|---|---|
| `✓ synced` | W = S = R |
| `↑ local` | W ≠ S, S = R |
| `↓ robot changed` | W = S, S ≠ R |
| `⤨ diverged` | W ≠ S, S ≠ R |
| `compiled only` | no editable source to compare (a compiled `.tp`/`.pc`); byte compare is on demand |
| `not in snapshot` | no snapshot copy of the file |

The working side is always known from the index. The robot side is only known after a read - the
extension never polls - so it is computed at the moment it matters (a push, or a compare), and
cached for the status bar with an age.

### Source vs compiled

A program has two representations: the editable **source** (`.ls`, `.kl`) and the controller's
**compiled** artifact (`.tp`, `.pc`). The compiled copy counts for *identity and history* - a
program that exists only compiled still resolves a `CALL`, and the tree says "compiled only" -
but it is **never read, normalized or text-diffed**. Every comparison is representation-matched:
source↔source (normalized) or compiled↔compiled (a byte boolean, on demand). A source is never
diffed against its compiled copy, which is what produced binary garbage in the compare pane.

A fetch of either representation also pulls its **partner** into the snapshot when the controller
has it (`NAME.LS ↔ NAME.TP`, `NAME.KL ↔ NAME.PC`), so the pair stays together; the replaced copy
of each goes to the history. A pull writes back only the representation that was targeted - the
snapshot always keeps both.

## Two comparisons, on purpose

They are different questions and must not be conflated:

| Compare | Used for | Rule |
|---|---|---|
| **W ↔ S** (working vs snapshot) | the tree marker, the status bar, the snapshot view | **normalized** - line numbers, terminators and `LINE_COUNT` are ignored, so a renumber reads as identical |
| **R′ ↔ S** (robot vs snapshot) | the **push gate** | **normalized** - line numbers, `DATE`/`MODIFIED`/`TIME`, `LINE_COUNT` and the controller's own stamps are ignored; a real text change still blocks |

The normalized rule is the safety feature without the false conflicts: a pendant touch-up that
changes a taught position is a real text change and is seen; a robot that only renumbered lines
or re-stamped a date is not. The gate read is also the **pre-push copy** (see below).

Blank lines are not stripped: a scaffolded empty line (`   :  ;`) normalizes to an empty line, but
the line itself is kept, so adding or removing one is a real difference. The same-kind **source**
copy is what a program is compared against - a compiled `.tp`/`.pc` beside the `.ls` in a snapshot
folder carries no text and must not make every edit read as identical.

## Push algorithm

1. Save and parse; the existing guards (running program, RUKUS write lock, `live.upload`); the
   local diagnostics and git note; then **one modal** naming the robot, device and program.
2. **One FTP session** does the rest, so the controller sees **one login** instead of one per step:
   identity (`VERSION.DG`), tasks (`PRGSTATE.DG`), options (cached), the gate read R′, the backup,
   the write, the read-back R″ and (by default) the compiled partner.
3. Compare **R′ ↔ S normalized** (`roundTripCompare`):
   - equal -> the gate passes; write the **pre-push copy** (one file, overwritten) and push;
   - unequal -> **refuse** (unless `containers.guardUpload` is off). Offer
     `Update Snapshot from Robot` (S <- R′, previous S to the history) or `Show Diff`; the user
     reviews, then pushes again.
4. On success, set **S <- R″** and check the round trip with the same normalized compare, so a
   controller that only re-stamped the date (or added `LOCAL_REGISTERS = 0,0,0;`) is not called a
   difference. A compile normally rewrites the source (and a source with no point data can read
   back with a different line layout), so R″ differing from what was sent is a **warning**, not a
   failed push. An explicit push **pulls R″ into the working copy** (the last step) according to
   `containers.pullAfterPush`: `always` (default) overwrites even when the compile rewrote it,
   `when-identical` keeps your file on a difference, `never` leaves it alone. Only a controller
   error (the STOR is refused) fails the push and is captured from `ERRACT` (`ERRALL` where it is missing).
   `containers.pullPartnerAfterPush` controls the partner representation read;
   `containers.pullCompiledAfterSourcePush` controls the compiled `.TP`/`.PC` read after a
   source `.LS`/`.KL` push, fetch or pull.
5. **Cancel** is honoured before the write (nothing is sent) and during the final pull. The write
   itself is never aborted. If the pull fails or is cancelled, the push offers **Revert** from the
   pre-push copy, and `robotCode.sync.restorePrePush` is always available.

Both the push gate (R′ ↔ S) and the round-trip check (R″ ↔ sent) use the normalized compare; the
W ↔ S compare that drives the marker is the same family.

Live Edit is gated once at pairing by the same compare; each save sets S <- read-back.

## Transports

Bulk file work - single-file fetch/pull, folder fetch/pull (including its listing), backup,
snapshot-from-robot and compare-all - prefers **FTP** (`robotCode.transfers.preferFtp`, default
true), even when the robot profile uses HTTP for single reads. A controller's cost is per session,
not per byte. If FTP is unavailable or its login is refused, reads fall back to HTTP when
`live.protocolFallback: auto`; writes are always FTP. Single reads and the connection probe keep
the profile's `useFtp`, and the sticky last-good transport is reset on reconnect.

## Transfer queue and status

Every controller operation and long local job is one entry in `TransferQueue`
(`packages/core/src/transferQueue.ts`), serialised per key (`robot:<name>`, `container:<root>`,
`index`):

- **Status bar** (left): foreground operations always; long background work (index/data refresh,
  snapshot from backup, container init) only when no foreground item is active; sub-second reads
  are in the QuickPick only. The line names the action and the real step, e.g.
  `Push MAIN.LS — ftp(s3): STOR MD:MAIN.LS`.
- **QuickPick** (`robotCode.transfers.show`, the status item's click): Active/Queued/Recent,
  per-item remove/cancel, `Cancel all`, and the technical log; recent entries stay
  `transfers.recentSeconds` (default 120 s).
- **Cancel**: a queued item is removed only; a running item is aborted through its signal and
  the operation applies its own rule (preflight/gate abort, `STOR` finishes then offers a revert).
- **Conflict update**: `handlePushConflict` runs inside the push's queue entry (session closed
  during the modal), and `WorkspaceIndex.refreshUri` indexes the one snapshot file instead of
  rescanning the workspace. The second push is visibly queued behind it.
- **Heartbeat**: while a transfer owns a robot, the beat is paused (not failed) and the robot
  item shows `$(sync~spin)`/`$(clock)`, never the red disconnect slash.
- **Future**: a dedicated Transfers panel (GitHub issue), and moving the heartbeat to an
  isolated channel so it never shares the transfer path.

## Snapshot history (the reflog)

`.robocode-robot/snapshot-history/<stamp>/<relpath>` keeps the copy a fetch replaced. Bounded by
`robotCode.containers.snapshotHistory` (default 50, 0 = keep everything), gitignored. Nothing is
ever both overwritten and unrecoverable.

The **pre-push copy** is separate: one file for the last push only, in
`.robocode-robot/push-backup/<FILE>` with a small manifest. It exists to recover from a push whose
final pull failed or was cancelled, not to version programs - the snapshot history is for that.

## `snapshot.json`

```jsonc
{
  "date": "2026-09-24T14:30:00Z",
  "updatedAt": "2026-09-24T16:05:00Z",
  "source": { "kind": "robot", "name": "S002R01", "host": "10.0.0.5" },
  "fileCount": 247,
  "files": { "prog.ls": "2026-09-24T16:05:00Z", "numreg.va": "2026-09-24T14:30:00Z" },
  "controller": { "name": "S002R01", "version": "V9.40", "fNumber": "F368808" }
}
```

`files` is keyed by the snapshot-relative path (forward slashes, lower-cased) and written for
every file when a snapshot is taken, updated on each partial fetch. Absence falls back to the
file's mtime. `updatedAt` is the last time any part changed.

## Surfaces

- **Editor tab**: git-shaped buttons in a fixed order - (Revert) Fetch (`repo-fetch`),
  Pull (`repo-pull`), (Push `repo-push`, confirms), Compare (`git-compare`), History
  (`history`) - plus Show Program Flow for TP. Fetch, Pull and Push are shown together for any
  working file in a robot container whose controller has an address (`robotCode.fileHasRobot`),
  whether or not it is connected; Revert appears only when the working copy differs from the
  snapshot, and Push stays visible when there is nothing to send (the command says so). A Push
  with `robotCode.live.upload` off is visible too and explains how to turn uploads on. Our items
  use `navigation@0.x` so they pack before another extension's Git **Open Changes**
  (`navigation@2`), which the user's own git layer contributes; a `fanuc://` file adds Download
  first. Karel adds Check/Compile. Age and state are in the tooltip and the status bar.
- **One Compare command**: the tab, the status-bar click, the tree inline action and every context
  menu all run `robotCode.sync.compareFile`; `sync.diffOpen` and `containers.diffWithSnapshot` are
  its internal implementation and are hidden from the palette. It always opens the diff, identical
  or not. (The old top-of-file CodeLens was removed in favour of the tab button.)
- **Editor context**: a **Snapshot & Robot** submenu (Fetch, Pull, Push, Compare, Revert, History,
  Position/Register compare), always showing the full set regardless of the file's state.
- **Snapshot view** (`robotCode.snapshot`, replacing the old Backup inventory): per-robot rows,
  scope groups above (Programs, Data & I/O) and a raw file mirror below; ages and `=`/`≠`; row
  actions Fetch, Pull, Compare, Revert, History.
- **Programs / PC programs**: a git-shaped marker per row (`✓` synced, `↑n` local, `↓n` robot
  changed, `↕` diverged, `?` not in snapshot, `compiled only`) and the robot↔snapshot state; robot
  rows carry the `n/n synced` summary; row actions Compare, Fetch, Pull, Revert, Positions,
  History; robot folder -> Fetch Programs and **Fetch & Compare All** (reads the robot once and
  records whether each copy differs).
- **Status bar**: two items for the focused file's robot (a coloured connection glyph + the robot
  name; click to connect / reveal / open Controllers) and a git-shaped sync item for the open file
  (`[LS] NAME (✓) age` - the file's extension in brackets, then the state and the copy's age):
  bracketed and tinted by context - plain when the working copy matches the snapshot, amber `(↑n)`
  local changes to push / `(↓n)` robot changed since the snapshot, red `(↕)` diverged, plain `(?)`
  not in the snapshot. The tooltip spells the state out in words, lists the program's type, lines,
  labels and positions, and names the robot and the last fetch; there is no symbol/colour legend.
  The separate running-program item and the TP stats item are gone; only the connection glyph and
  the sync marker are coloured. There is no separate Sync view - it was folded into Programs.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `robotCode.containers.guardUpload` | `true` | the normalized push gate (the gate read is also the pre-push backup) |
| `robotCode.containers.prePushBackup` | `true` | keep the last pre-push copy in `.robocode-robot/push-backup/` |
| `robotCode.containers.pullPartnerAfterPush` | `always` | read the partner representation after a push |
| `robotCode.containers.pullCompiledAfterSourcePush` | `true` | read the compiled `.TP`/`.PC` after a source `.LS`/`.KL` push, fetch or pull |
| `robotCode.containers.unchangedCheck` | `auto` | skip a fetch when size/mtime match the last one |
| `robotCode.live.protocolFallback` | `auto` | read-only fallback between HTTP and FTP (network or FTP login refusal) |
| `robotCode.transfers.preferFtp` | `true` | bulk transfers try FTP first, regardless of the profile protocol |
| `robotCode.transfers.recentSeconds` | `120` | how long a finished queue entry stays in the QuickPick |
| `robotCode.containers.snapshotHistory` | `50` | reflog stamps to keep (0 = all) |
| `robotCode.containers.gitAware` | `false` | on push, note uncommitted git changes |

## Out of scope / follow-ups

Tracked as their own issues and in `docs/ux-audit.md`:

- Dedicated Transfers panel and an isolated heartbeat channel: GitHub issue #77.

- Full RUKUS integration: a cluster imported into a robot cell (this is why the containers
  exist). Where RUKUS is linked, a push failure offers RUKUS's Error Watcher.
- Container-first migration: cells and clusters resolved by directory, away from
  `robotCode.robots` / `data.backupFolders` settings.
- ~~A per-robot Sync view (ahead/behind for every program, not just the open one).~~ **Shipped
  2026-09-25, then folded into the Programs view** (per-program marker + `n/n synced` robot rows +
  `Fetch & Compare All`); the separate `robotCode.syncStatus` view was retired as redundant.
- ~~Snapshot diff as a position/register diff (reusing `tools/positionDiff.ts`).~~ **Shipped
  2026-09-25** as `robotCode.sync.comparePositions` / `compareRegisters`.
- ~~A snapshot-history browser.~~ **Shipped 2026-09-25** with diff, open and restore.
- **Auto-fetch on open**: when a container working file is opened, refresh its snapshot entry
  from its own connected robot, so the sync marker reflects the robot without a manual Fetch.
  Must be opt-in (a setting, default off) to keep the live tier's **no background requests**
  guarantee; needs a debounce, a per-file in-flight guard, and to skip window-reload / pinned
  preview tabs. Follow-up; not scheduled.
- Standardising every transient status-bar message.
