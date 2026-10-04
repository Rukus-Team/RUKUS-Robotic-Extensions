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
| **R′ ↔ S** (robot vs snapshot) | the **push gate** | **verbatim** - nothing is stripped; a metadata-only difference still blocks, but is labelled |

The verbatim rule is the safety feature: a pendant touch-up that changes only a taught position
is exactly the change that must be seen before a push, and no normalization may hide it.

Blank lines are not stripped: a scaffolded empty line (`   :  ;`) normalizes to an empty line, but
the line itself is kept, so adding or removing one is a real difference. The same-kind **source**
copy is what a program is compared against - a compiled `.tp`/`.pc` beside the `.ls` in a snapshot
folder carries no text and must not make every edit read as identical.

## Push algorithm

1. Save and parse; the existing guards (running program, RUKUS write lock, `live.upload`); no
   snapshot yet -> the robot's current copy becomes the first snapshot entry.
2. Read the robot's copy R′ (`CURPOS`-style: one read, on the button).
3. Compare **R′ ↔ S verbatim**:
   - equal -> show the W ↔ S summary in the confirm, push;
   - unequal -> **refuse**. Offer `Update Snapshot from Robot` (S <- R′, previous S to the
     history) or `Show Diff`; the user reviews, then pushes again.
4. On success, read the program back (R″), set **S <- R″** verbatim, and check the round trip with
   the **metadata-insensitive** compare (`stripTpMetadata`: CREATE/MODIFIED stamps, `LINE_COUNT`,
   `PROG_SIZE`, `MEMORY_SIZE` ignored) so a controller that only re-stamped the date is not called
   a difference. An explicit push then **pulls R″ into the working copy**, so workspace = snapshot
   = robot and a post-push "compare with snapshot" has nothing to show. `containers.pullAfterPush`
   chooses how aggressively: `always` (default) overwrites the working file even when R″ differs
   from what was sent (the common case - DATE/MODIFIED, line numbers, variable labels), reporting
   the difference; `when-identical` keeps the local copy on a difference; `never` leaves it alone.
   Live edit never pulls - the editor is the source there, and a save is not a user-initiated sync.

Both the push gate (R′ ↔ S) and the round-trip check (R″ ↔ sent) read the robot; the W ↔ S
compare that drives the marker is normalized on top of that.

Live Edit is gated once at pairing by the same compare; each save sets S <- read-back.

## Snapshot history (the reflog)

`.robocode-robot/snapshot-history/<stamp>/<relpath>` keeps the copy a fetch replaced, and the
pre-push R′. Bounded by `robotCode.containers.snapshotHistory` (default 50, 0 = keep
everything), gitignored. Nothing is ever both overwritten and unrecoverable.

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
  (`history`) - plus Show Program Flow for TP. Revert appears only when the working copy differs
  from the snapshot; Push only when there is something to send (`robotCode.syncPushable`: a local
  difference, or a program the snapshot has never seen). Our items use `navigation@0.x` so they
  pack before another extension's Git **Open Changes** (`navigation@2`), which the user's own git
  layer contributes; a `fanuc://` file adds Download first. Karel adds Check/Compile. Age and
  state are in the tooltip and the status bar.
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
| `robotCode.containers.guardUpload` | `true` | the verbatim push gate |
| `robotCode.containers.snapshotHistory` | `50` | reflog stamps to keep (0 = all) |
| `robotCode.containers.gitAware` | `false` | on push, note uncommitted git changes |

## Out of scope / follow-ups

Tracked as their own issues and in `docs/ux-audit.md`:

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
