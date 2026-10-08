# Robot Code — FANUC TP & KAREL for VS Code

> ## BETA
>
> In active development and **not yet proven against a live cell**. The file-based half is
> tested hard - every parser runs against real controller backups on each build - but the
> parts that touch a robot have only been exercised against ROBOGUIDE virtual controllers
> and a mock. In particular **teaching a position has never been done on real hardware**:
> jog a robot, press Teach, send the program back, and watch where it actually goes before
> trusting it on a cell that matters.
>
> Nothing here writes to a controller. Every edit lands in the file, and undo puts it back.

Full editor support for FANUC robot programming, from the RUKUS team. Install it from the
[VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=rukus-team.robot-code), or
download the `.vsix` from [Releases](https://github.com/Rukus-Team/RUKUS-Robotic-Extensions/releases)
(Extensions view -> `...` -> **Install from VSIX...**). It is built to grow to other robot brands
(ABB RAPID, KUKA KRL, Yaskawa INFORM).

## Feedback & issues

This is a beta, so reports are very welcome:

- **In VS Code:** run **Robot Code: Report an Issue** from the command palette (or the `...` menu of
  the Robots view). It opens the bug form with your versions already filled in.
- **On GitHub:** [open an issue](https://github.com/Rukus-Team/RUKUS-Robotic-Extensions/issues/new/choose)
  (bug report or feature request).

The repository is public: leave customer programs, plant names and IP addresses out of reports. A small
made-up file that shows the problem is the most useful thing to attach.

## What it does

### TP programs (`.ls`)

| Area | Feature |
|---|---|
| Highlighting | Full grammar: header attributes, line numbers, motion types, speeds/units, termination, motion options, registers with inline comments, I/O, labels, calls, macros, system variables, `/POS` blocks. |
| Hover | Every instruction and motion option explained. `$` system variables (TP, KAREL and `.va`) described from RUKUS's `SysVarsReference.json` — type, access, storage — using the RUKUS install's full copy when present, else the bundled subset. Registers and I/O show the **controller comment and value** from `numreg.va` / `posreg.va` / `strreg.va` / `diocfgsv.va`. `P[n]` shows the full taught position. `CALL X` shows the callee's comment, size and callers. Macro instructions resolve through `sysmacro.va`. |
| Navigation | Ctrl+click `JMP LBL[n]` → label. `P[n]` → position data. `CALL`/`RUN` → program file — including programs that exist only as a compiled `.pc` / `.tp` in the backup. Macro name (the whole name) → macro program. Find All References for labels, positions, registers, I/O and program names (workspace-wide callers). |
| Outline | Header, main program split by label regions (with calls, macros and motions inside), positions with UF/UT and coordinates. Workspace symbol search (`Ctrl+T`) lists every program. |
| Completion | Instructions as snippets, labels after `JMP LBL[`, programs after `CALL ` (the robot's own, then the FANUC-supplied programs of the options it has installed), registers/I-O **with their controller comments** after `R[`, `DI[` …, positions after `P[`, macro names. |
| In-line hints | Editor-drawn hints are wrapped in `{ }` so they never read as code: `P[1]{JNT}{UF1}{UT2}` (the representation and frames, one badge each - pick which with `robotCode.tp.decorations.positionFields`: type, user frame, user tool, or none), `R[15]{Speed}` (the controller comment for a register written without one - hover to **Insert it**), and the live value `R[151]{2}`. They're decorations, so no theme can tint them, and use a muted palette; `robotCode.tp.inlineHints` turns them off. Names written in code (`R[15:Speed]`) are part of the variable, not a comment. |
| Diagnostics | Duplicate / undefined / unused labels, untaught or unused positions, `IF THEN`/`FOR` balance, speed and CNT ranges, CALL targets missing from the workspace, unknown macros, inline comments that disagree with the controller or with each other, header problems. Quick fixes included. |
| CodeLens | Jump count on each label, caller count on the program header. |
| Editing | **Automatic renumbering** with `LINE_COUNT` update and terminator fix-up, merged into your undo step (Enter before the ` ;` keeps the terminator on its line). Rename label numbers, position numbers and position names across the file, and register comments across the whole backup (`F2`). **Clean Up Unused Positions…** reviews and removes points no live line uses. **Insert Program Header…** drops in a customer header block from `robotCode.tp.headerTemplates` (Ford / GM / Stellantis / Generic starters, editable). Format Document = renumber. |
| Commands | Renumber · Go to Label · Toggle remark (`//`) on lines · Insert comment banner · Convert J⇄L · Scale speeds · Set termination · Copy program without positions · New TP program wizard · **Call graph** webview. |
| Folding | Header, label regions, IF/FOR blocks, comment banners, every position. |

### KAREL (`.kl`)

Hover docs for 200+ built-ins and common `$` system variables, go to definition (including `ROUTINE … FROM prog` into the providing file and `%INCLUDE` files), references, rename, outline (constants, types with structure fields, variables, routines with locals), completion with parameter snippets, signature help, folding, indentation formatter, a lint of what ktrans refuses and what it lets through (C-isms, declarations after BEGIN, wrong argument counts, RETURN misuse, MOVE under `%NOLOCKGROUP`, limits) with **Check Before Compile** (`Ctrl+Alt+Shift+K`), block-balance diagnostics that understand one-line `IF … ENDIF` and `MOVE … ENDMOVE`, unused declarations, identifier-length and file-name checks, and **compile with ktrans** (`Ctrl+Shift+B`) with errors mapped back to the editor.

### Live controller (on demand; one guarded upload)

Add a robot by IP (Robots view → **+**). **There is no background polling of data** — a FANUC controller *generates* each `.DG` diagnostic file at the moment it is requested, so a poll is permanent load on the robot for data nobody is looking at. The one thing that runs on a timer is a cheap **connection heartbeat** (`robotCode.live.heartbeatSeconds`, default 10, `0` = off): while a robot is connected it re-probes with the same static request connecting uses — a web page over HTTP, or a bare FTP login, never a generated file — so the status bar's green glyph means *answering now* and not *was connected once*. Set it to `0` for the strict never-touches-the-controller behaviour.

Connecting reads three things once — registers, I/O and the device listing — because those are what the editor itself runs on (hovers, inlay values, completion, the file tree). Everything else waits for a button. Change that with `robotCode.live.fetchOnConnect`, or set it to `[]` to read nothing at all on connect.

Click a robot for its **robot page**: running task, position, tasks, I/O and registers, each card with a Get button and the age of its own reading. Nothing on it refreshes itself.

Each panel is its own **Get** button, reading exactly one file over the web server (`http://<ip>/MD/…`) or FTP:

| Panel | Reads |
|---|---|
| Controller | `VERSION.DG` (falls back to `PRGSTATE.DG`) |
| Position | `CURPOS.DG` |
| Tasks | `PRGSTATE.DG` |
| Registers | `NUMREG.VA`, `STRREG.VA`, `POSREG.VA` |
| I/O | `IOSTATE.DG` |

- Every reading **carries its age** — "4 min ago" on the panel, greyed out in the editor once stale, and the status bar says *"not read"* rather than "idle" until program state has actually been fetched.
- Hovers and editor decorations show register and I/O values from the last Get; the I/O tree shows ● ON / ○ OFF. Drawing them costs the robot nothing.
- The TP line a task was on is **highlighted** in the editor, with the task in the status bar.
- Open any controller file read-only (`fanuc://ROBOT/MD/FILE`), diff a program against the robot's copy, add the device as a workspace folder, or download a backup into a dated folder.
- **Auto-refresh** exists, off by default, per robot — it re-reads only the panels you already opened, and warns you what it costs before switching on.

- In a local program: **Ctrl+Alt+Shift+D** downloads the robot's copy over the local file (the old text is kept, Ctrl+Z undoes), **Ctrl+Alt+Shift+C** downloads and diffs first, **Ctrl+Alt+Shift+U** uploads the program to the robot, **Ctrl+Alt+Shift+E** starts live edit (every save is sent, until you stop it).

Upload is the one thing that writes to a robot: it asks first, names what it replaces, refuses a program the controller reports as running or that RUKUS has write-locked, is logged here and in RUKUS's write audit log, and reads the program back. Everything else only reads. ROBOGUIDE virtual controllers work on `127.0.0.1`. Without a robot, `npm run mock` serves any backup folder as a fake controller for trying it out.

### Teaching positions from the robot

Right-click a `P[n]` (or put the cursor in its block) → **Teach Position from Robot**. One
`CURPOS.DG` read, a confirmation showing every axis that moves and how far the tool centre point
travels, then one undo-able edit. **The file changes; the robot does not** — this costs exactly
what the Get Position button costs.

Only the numbers that actually changed are rewritten, in place, keeping the column, the decimals
and FANUC's own leading-zero style. Every taught position in the reference backups re-teaches to
byte-identical text, which is what the corpus test checks.

It refuses more than it accepts, because a wrongly taught point looks perfectly valid afterwards:

- **Frame mismatch.** `CURPOS.DG` reports the *active* `UF`/`UT`; the point carries its own. When
  they differ the numbers are in different spaces — blocked, with the choice to teach anyway or to
  retarget the point's frames on purpose.
- **Representation mismatch.** A joint-taught point cannot take a cartesian reading. Converting
  needs the robot's kinematics, which a backup does not contain, so this one has no override.
- **A missing axis.** If the point stores `E1` and the reading has none, teaching would leave the
  rail where it was while everything else moved.

Also here: **Record New Position from Robot** (next free `P[n]`, written in the file's own style,
with an optional `J`/`L` motion line at the cursor) and **Teach Position from PR[n]**, which uses
the position registers already read from `posreg.va` and needs no robot at all.

### Moving points you have already taught

**Offset Positions…** shifts a selection by a fixed amount — the answer to "the fixture
moved 3 mm" without re-jogging twenty points. Select the points (or the motion lines that use
them), type `X=3 Y=-1.5`, `3 0 -1.5` or `E1=250`, and you get the same preview and the same
byte-exact surgery as teaching.

**The offset is applied in each point's own user frame.** Expressing a world offset inside a
`UF` needs that frame's transform, which is not in a `.ls` file and is not guessed here — so a
selection spanning several frames says so plainly rather than pretending it moved them all the
same way in the cell. A cartesian offset onto a joint-taught point is refused, not converted.

### Changing which frame a point is written against

**Convert Positions to Another Frame…** re-expresses taught points against a different `UF` or
`UT`, reading the frames from the robot's own `sysframe.va`.

**The robot does not move, and neither do the points** — the same places in the cell are written
down against a different reference, so the numbers can change by metres while nothing physically
moves. The confirmation says so before anything is applied.

This needs no kinematics, and that distinction is worth being precise about: turning joint angles
into a position needs the robot's link geometry, which a backup does not contain; converting a
cartesian point between frames needs only the two frames, which the backup states exactly. So
joint-taught points are refused, cartesian ones are just arithmetic.

The rotation convention (`Rz(R)·Ry(P)·Rx(W)`) was established against real controller data rather
than assumed — `CURPOS.DG` reports one pose in both the active frame and world, and only that
ordering reproduces one from the other.

**Mirror Positions Across a Plane…** reflects a selection — the left/right-hand cell job. The
orientation is mirrored properly (conjugated, so the result is still a valid rotation; a 90° turn
about Z becomes −90°), and you choose which frame's plane to reflect across. `CONFIG` is left
alone and flagged: a mirrored pose often needs a different arm configuration, and working that out
needs kinematics.

**Relabel Position Frames…** is the opposite of converting and worth not confusing: it changes the
`UF`/`UT` a point claims **while leaving every number alone**, so the point ends up meaning a
different place in the cell. Right for a point taught against the wrong frame whose numbers are
correct; wrong for everything else, which is why the confirmation says so loudly.

### Refactoring

- **Extract Selection to New Program…** — the selected lines become their own program with a
  `CALL` left behind. It refuses anything that is not self-contained control flow: a `JMP` that
  leaves the selection, a jump into the middle of it, an unbalanced `IF`/`FOR`. TP has no block
  scope to protect the cut, so the check is the feature. Positions used only by the moved lines
  go with them, renumbered from `P[1]`; ones used on both sides are copied, and it tells you the
  two copies will drift apart.
- **Inline Called Program Here** — `CALL X` becomes X's body, with X's labels and positions
  renumbered past whatever this program already uses. Refuses a call with arguments.
- **Renumber Register / I-O in This Program…** — `R[5]` → `R[105]` everywhere in the file,
  keeping inline comments, warning if the destination is already in use.

### Has someone touched this on the pendant?

**Fetch** (editor title bar, TP files) reads the open program off the controller once into the
snapshot — nothing on the robot changes. **Compare** opens the diff, and **Pull** replaces your
working copy with the robot's. The answer you are usually looking for is *"only taught positions
differ (3)"*, and a **Push** is refused outright if the robot's copy differs from the snapshot,
so an uncaptured pendant edit can never be silently overwritten. See *Keeping your copy in sync*
above and `docs/design-snapshot-ux.md`.

There is deliberately no watch mode. A watch is a poll wearing a different hat.

### RUKUS's clusters are the cells

With RUKUS installed there is nothing to set up: the **RUKUS Clusters** view lists its clusters from `Documents\RUKUS` (or a portable RUKUS's data folder). Click a cluster and its backup folder becomes the workspace with the cluster's robots in the Controllers view; click another and the workspace switches. Changes made in RUKUS reach the open cell on their own. **Send Cell to RUKUS** writes the cell's controllers back into the cluster file without touching what only RUKUS knows. Backups taken here are filed where RUKUS files its own, named by RUKUS's templates, with RUKUS's manifest. Without RUKUS, **Initialize Cell Container…** sets a cell up by hand.

### Opens in RUKUS

Live monitoring, alarm history and scheduled backups are cell management — [RUKUS](https://github.com/Rukus-Team/Robotic-Utility-Kit-User-System)'s job, not the editor's. Each robot in the Robots view has buttons that open the real screens over a `rukus://` link instead of a weaker copy in a webview:

- **Live monitor** → RUKUS Production Dashboard
- **Alarm history** → RUKUS Error Watcher
- **Scheduled backups** → RUKUS Backup Scheduler (also offered after a backup pull)

If RUKUS is not installed, the buttons offer the download rather than failing. Turn the whole hand-off off with `robotCode.rukus.enabled`. The protocol contract is in `RUKUS-INTEGRATION.md`.

### Analysis tools

- **Compare Two Backups…**: two backup folders in; changed programs (+/− lines), moved positions with deltas and distance, changed registers, renamed I/O, macro changes out. Click through to A ⟷ B diffs, save as Markdown.
- **Register & I/O Cross-Reference Report**: who writes and who reads every register and I/O point across the cell, with findings (inconsistent comments, never-written, never-read, multi-writer outputs). Export CSV/Markdown.

### Linting

One set of checks for TP, KAREL and ABB RAPID, in the editor, over a whole folder or backup (**Robot Code: Lint Folder…**), and from a command line (`robot-lint`, shipped as `dist/robot-lint.js`). It covers what the controller or ktrans will refuse, plus house-style rules: a WAIT with no timeout, a missing program comment, TODO left in, unused LOCAL data, and opt-in length, naming and case rules. Rules and severities live in a `.robotlint.json`. See [docs/LINT.md](docs/LINT.md).

### Controller data views

Activity bar → **Robot Code**, six sections with a count or status on each header: **Controllers** ("1 of 2 live"; each row a status dot, model, IP and what it is running — or why it failed), **Backup** (each backup folder: date, counts, data files read, any bracket arguments the parser had to guess at), **Programs** (TP, with call/caller trees; compiled-only `.tp` dimmed; **+** starts a new one), **PC programs** (KAREL sources and `.pc`), **Macros** (the macro table, with whether each target exists), **Data** (R, PR, SR, payload schedules, I/O). One colour and one icon per kind — amber TP, blue PC, teal macro, grey data — the same in the editor's call-target tints and the status bar. The *Registers & I/O Table* command opens a filterable table with one-click "find uses" and copy-as-`R[5:Comment]`. Under a connected controller the panels are grouped *Controller*, *Device*, *RUKUS*; each is dim until read, dated once read.

Data comes from the workspace or from folders listed in `robotCode.data.backupFolders` ("Add Controller Backup Folder…"). Point it at an *All of the above* backup; `.va` files are read directly.

### Per-robot containers (`.robocode`)

A structured multi-robot workspace — working programs in one place, dated backup archives
in another, several robots side by side — does not fit "the folder with the `.va` files is
the robot". Containers make the relationship explicit instead of inferred:

```
cell/                          # the workspace
  .robocode-cell/cell.json     # optional: cell name (conventions can be added later)
  robot 1/
    .robocode-robot/
      robot.json               # { "name": "S002R01", "programs": ["2_Load_LS", "5_KAREL"] }
      snapshot.json            # when the snapshot was taken, from where, controller info
      .gitignore               # keeps snapshot/ out of git (robotCode.containers.gitignoreSnapshot)
      snapshot/                # a complete, verbatim robot backup
    2_Load_LS/  5_KAREL/       # working programs — the only editable set
    1_MD/                      # dated backup archives — never touched, never indexed
```

- **Markers partition the workspace.** Only declared program folders are indexed as
  editable programs. Archived backups and `.robot-history/` under a robot folder are
  invisible to the extension. Folders without a marker keep today's behavior exactly.
- **The snapshot is the robot's one data source** — register comments, frames, macros and
  payloads in the working programs come from it, with no date heuristics and no guessing
  between robots. Everything is still fully offline.
- **Snapshot programs are reference-indexed**: a `CALL` to a program that exists only on
  the controller resolves and cross-references see the whole robot, but snapshot copies
  never appear as editable rows and always lose to a working copy of the same name.
- **Which version is where**: every working program carries its status against the
  snapshot — `= snapshot 2026-09-15`, `differs · 3 lines` (the tab's Compare button and a
  tree button open the diff), or `not in snapshot`. Comparison ignores line numbers,
  terminators and `LINE_COUNT`, so a renumber-only change reads as identical and one
  inserted line shows as one line, not a cascade.
- **Snapshots are taken on demand**: *Snapshot from Backup Folder…* copies one of your
  dated archives wholesale, and *Snapshot from Robot…* (on the **Controllers** view and the robot
  page) overwrites the snapshot with everything on a connected controller. Both replace the previous
  snapshot wholesale and record provenance (`snapshot.json`: date, source, file count, controller F
  number and version). A **Fetch** on the Snapshot view is the incremental alternative: it updates
  only what you choose, never touches the working copy, and keeps each replaced file's previous
  version in `snapshot-history/`.
- **It knows RUKUS's backup layout.** *Snapshot from Backup Folder…* lists this robot's backups
  for you - RUKUS's `<cluster>\Latest\<robot>` first, then the dated ones, newest first - from
  the workspace, from `robotCode.data.backupFolders` and from the robot folder's own archives,
  so add your RUKUS backups root to that setting once. Both RUKUS naming presets are read
  (`S002R01_(MD)_260912` and `S002R01_MD_2026-09-12`). The *Initialize Robot Container* wizard
  leaves out anything that looks like a backup, by name or by what is in it.

Commands: **Initialize Cell Container…**, **Initialize Robot Container…** (a wizard:
folder → name → working folders → git hygiene → first snapshot), **Snapshot from Backup
Folder…**, **Snapshot from Robot…**, and **Diff Working Copy with Snapshot**. The design
document is `docs/design-robocode-containers.md`.

### Keeping your copy in sync

The snapshot is treated as the robot's **index** - the last known state every working copy is
compared against - in the same shape as git: working folders are the working tree, the snapshot
is the index, backups are remote history, and the controller is the remote. Everything stays
offline; the only write is Push.

The **Snapshot** view lists each robot's snapshot: the files, their age, and whether each is
`=` or `≠` the working copy. Its toolbar has **Fetch** (a multi-select of TP/KAREL source, compiled
programs, data, I/O); the rows add **Fetch / Pull / Compare / Revert / History** for one file. The same actions are on a
right-click in the **File Explorer** for a program or data file. The **Programs** view lists every
working program of a robot against its snapshot with a git-shaped marker (`✓`, `↑n`, `↓n`, `↕`,
`?`), and **Compare All with Robot** on its toolbar reads the robot and says whether each copy
differs too. In the editor, the tab carries
**Fetch · Pull · Push · Compare** — and a **Revert** (discard) when the working copy differs — and
each action uses the robot of the file's own container, so it never asks which robot. The status
bar names the focused file's robot and shows the open file's snapshot state and age.

`History` now browses a file's kept versions - diff, open, or restore one into the working copy -
and a program can be compared with its snapshot point by point (**Compare Positions**) or a
`numreg.va` register by register (**Compare Registers**), not just as raw text.

A **Push** is guarded **verbatim**: the robot's copy is compared to the snapshot with nothing
stripped, and if they differ - someone edited the program on the pendant and it was never
fetched - the push is **refused** until the snapshot is updated, so an uncaptured change is
never silently overwritten. After a push the program is read back, the snapshot is set to what
the controller now holds, and the message says whether the round trip was identical. Every
snapshot file's previous version is kept in `.robocode-robot/snapshot-history/`.
`docs/design-snapshot-ux.md` is the design.

### Other files

Syntax highlighting for `.va` / `.dt` / `.dg` / `.io` dumps and `.cm` / `.cf` command files.

### Color themes

Preferences ▸ Color Theme (`Ctrl+K Ctrl+T`), all under **Robot Code**:

- **Dark**, **Light**, **High Contrast** and **Light High Contrast** — the originals.
- **Purple**, **Red**, **Blue** and **Green**, each as Dark and Light — Robot Code Dark / Light
  with that color as the accent and a tint of it in the editor and side bars.
- One Dark and one Light per **RUKUS skin**, so the editor matches the app: **RUKUS**,
  **Phanook Flakes**, **All-Berry Bites**, **Kooka Puffs**, **Ciao Crunch**, **Kowabunga Krispies**,
  **Halloween**, **Christmas** and **Pixel**. Backgrounds, text, accent and the error / warning /
  success colors are the skin's own; program, routine and label names take its heading color.

The syntax colors are the same in every theme, so a program reads the same whichever you pick.

### File icons

Every FANUC file type has its own icon in the Explorer, on editor tabs and in Quick Open. They
are **on by default**: the first time the extension runs it switches the file icon theme to
**Robot Code**, which is Seti - the theme a fresh VS Code shows - with the FANUC types on top, so
no other file loses its icon. `robotCode.fileIcons.enabled` turns this off and puts the theme
you had back; if you pick another theme yourself, that stands (turn the setting off and on to
come back). The icon is the extension and nothing else - a big coloured **VA**, no tile behind it:

- **The letters are the file extension**, as large as the space allows.
- **The colour is the family.**
- **An underline marks a compiled or binary file** - the same family, nothing to read or edit.

| Colour | Readable | Underlined (compiled / binary) |
|---|---|---|
| Amber - TP programs | `.ls` | `.tp` |
| Blue - KAREL | `.kl` `.utx` `.ftx` | `.pc` |
| Teal - command files | `.cm` `.cf` | |
| Purple - controller data | `.va` `.dt` | `.vr` `.sv` `.df` |
| Red - diagnostics | `.dg` | |
| Green - I/O | `.io` | |
| Orange - iRVision | `.vda` | `.vd` `.cam` |
| Grey - other | `.stm` `.txt` | `.pmc` |

Other generic files - `.xml`, `.zip`, `.gif`, `.dat` - keep Seti's icons. The FANUC icons are also
attached to each language, so with the setting off and a theme that has no icon of its own for
a type (every theme, for `.va` `.tp` `.kl` ...) they still show; `.ls` and `.txt` are the two
that need the theme, because Seti and vscode-icons map `.ls` to LiveScript and `.txt` is every
text file on the PC.
`.sv` is matched by name (`sys*.sv`, `dcs*.sv` and the other controller system files), not by
extension, so a SystemVerilog file keeps its own language. To give each file type an icon, each
is its own language id now (`fanuc-dt`, `fanuc-dg`, `fanuc-io`, `fanuc-cf` ... beside `fanuc-va`
and `fanuc-cm`): same grammar and same features, but a per-language setting block such as
`"[fanuc-va]"` no longer reaches `.dt` / `.dg` / `.io` files. One table drives all of it -
`FILE_ICONS` in `scripts/make-file-icons.mjs`: add a file type there, then run
`node scripts/make-file-icons.mjs` (the drawings) and `node scripts/sync-file-icon-manifest.mjs`
(the languages, grammars and activation events in `package.json`). **If an old icon still
shows after an update, run *Developer: Reload Window*** - VS Code keeps icons until it reloads.

## Finding things

**Ctrl+Alt+H** (or the **?** on the Programs and Controllers sections) opens *What Can I Do Here?*: every feature grouped by what you are trying to do, each with its keyboard shortcut. The full shortcut table, and leader mappings for the Vim extension, are in `docs/KEYBOARD-AND-VIM.md`.

## Settings

All under `robotCode.*`; see the Settings UI. The ones you will touch:

- `tp.autoRenumber` / `tp.autoSemicolon` — on by default.
- `tp.inlineHints` (all line hints on/off), `tp.decorations.positions`, `tp.decorations.positionFields` (which of type / userFrame / userTool show after `P[n]`), `tp.decorations.comments`, `live.inlayValues`.
- `tp.diagnostics.*` — switch off individual checks.
- `tp.completion.fanucPrograms` — the FANUC-supplied programs offered after `CALL ` / `RUN `:
  `installed` (default) lists only those of options the robot has — read from the robot when its
  file comes to the front (a program open from it, or in a container bound to it), else from the
  `orderfil.dat` of the backup folder the program is in — or `all` for the whole catalog.
- `karel.ktransPath`, `karel.ktransConfig` (a `robot.ini`; optional — ktrans compiles without one using its basic support files), `karel.compileOnSave`, `karel.maxIdentifierLength`.
- `data.backupFolders` — extra folders scanned for `.va` and `.ls`.
- `live.fetchOnConnect` — what one connect reads; `[]` for nothing.
- `containers.guardUpload` — refuse a push while the robot's copy differs from the snapshot (default on).
- `containers.snapshotHistory` — how many prior snapshot-file versions to keep (default 50, `0` = all).
- `containers.pullAfterPush` — after an explicit push, pull the controller's copy back into the working file so working = snapshot = robot: `always` (default, overwrites even when the controller changed it), `when-identical`, or `never`.
- `containers.gitAware` — before a push, note uncommitted changes in your own git repo (default off).
- `sync.promptOnOpen` — opening a container program connects its robot and offers to fetch the newest copy into the snapshot; the working copy is never touched. Muted for 5 minutes after the last snapshot fetch (default on).
- `tp.diagnostics.duplicatePositionTolerance` — mm below which two points in the same frame are
  flagged as leftovers (default 0.5; `0` switches it off).
- `tp.diagnostics.cntBeforeOperation` / `tp.diagnostics.fineRequiredPatterns` — the `CNT`-before-work
  check and your plant's own list of what counts as work.
- `tp.diagnostics.crossReference` — what the robot's other programs do with a register or output.
- `karel.diagnostics.undeclared` — KAREL names used but never declared (**ktrans does not check this**).

## Building

```
npm install
npm test          # parses every program in ../reference-backup and the RUKUS KAREL corpus,
                  # and compiles + exercises every grammar under Oniguruma
npm run version:id     # this branch's version id (YY.MT.DDIII) into package.json; -- --show to only look, -- --release for a release id
npm run package   # → robot-code-<version>.vsix
npm run install-local
npm run release   # tag + GitHub release with the .vsix, and bundle it into ../Robotic Utility Kit
```

A version is a **version id**, the same shape RUKUS uses: `26.92.19005` is a bug fix (type 2)
for issue #5, started on 19 September 2026 - the year, the month and change type run together,
then the start day and the issue number run together. A release is `26.99.1`: September's first.
`npm run version:id` works it out from the branch: the issue from the `#5` in its name, the type
from its prefix, the start date from its first commit. `docs/VERSIONING.md` is the walkthrough -
reading one, making one, and what to do when `npm run release` says the number is not higher.

The `.vsix` is not in this repo's history. Each version is kept in two places: as the asset of
the GitHub release `v<version>`, and in the RUKUS repo on GitLab as `Assets/VSCode/robot-code.vsix`
(LFS), which is what RUKUS installs from. `npm run release` does both (`--dry-run` to see the
commands; `--github-only` / `--rukus-only`; the RUKUS commit is not pushed unless `--push-rukus`).

Themes: see *Color themes* above.

Press `F5` in VS Code to launch the Extension Development Host. The default config, **Launch Extension (F5: local dev host)**, builds, opens a dev host on the last workspace you used (else a scratch copy of `test/fixtures-cell` at `.vscode-test/debug-cell`, gitignored), and attaches to its inspector on `127.0.0.1:9229`. It exists because the built-in `extensionHost` debugger can time out attaching to the extension host on Windows: its target discovery races `127.0.0.1` and `[::1]` and treats the always-refused IPv6 side as fatal. Attaching with an explicit `address: "127.0.0.1"` avoids that race. **Attach to Running Extension Host (127.0.0.1)** attaches without launching (for `npm run dev:debug`); the built-in `Run Extension …` configs remain for a machine where that debugger works.

To test a build **without** the F5 debugger (the editor's `extensionHost` debugger can fail to attach to the extension host), use the local runner:

```
npm run dev                 # build + open a dev host on the last workspace used
npm run dev -- <folder>     # build + open a dev host on that folder (remembered next time)
npm run dev:debug           # the same, but with the inspector on 127.0.0.1:9229
```

`npm run dev` needs no task and no debugger, so it always opens a working host. For breakpoints, `npm run dev:debug` (or the **debug host** task) launches with `--inspect-extensions=9229`, then pick **Attach to Extension Host (127.0.0.1)** — it attaches to `127.0.0.1` explicitly, avoiding the `localhost`/IPv6 race in the built-in debugger. `--clean` kills leftover dev-host processes first (the debug task does this).

See `RUKUS-INTEGRATION.md` for how RUKUS installs the `.vsix`, and `ROADMAP.md` for the live-robot plan.

## AI assistance

AI tools were used to assist in building this extension. Every change is reviewed and tested by
the maintainers, who are responsible for it.
