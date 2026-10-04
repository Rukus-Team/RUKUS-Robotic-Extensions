# Robot Code — feature backlog (living document)

This is the idea list so nothing has to be re-thought. **Add ideas here, not in chat.**

> **Scope decision (Sam, 2026-09-12):** keep the extension simple — it is the *editor*. Backups, backup diff, cross-reference reports, live robot connection and anything cell-management-like already live in **RUKUS** and should stay there. The 0.2/0.3 live and analysis features exist but are not the direction; do not extend them. New work goes into TP/KAREL editing quality only.
>
> **Pullback (Sam, 2026-09-13) — acted on in 0.6.0:** don't bog the robot down. A controller
> *generates* each `.DG` file when it is asked for, so background polling is permanent load for
> data nobody is looking at. Everything live is now **click-to-Get**: no auto-refresh by default,
> no position unless you press Get, no version unless you press Get. And where a feature is really
> RUKUS's job, the button **launches RUKUS** instead — links the two products together and pushes
> people toward RUKUS rather than growing a worse copy here. Live dashboard and alarm history
> moved out on that basis; download backup stays.

Four sections: **1** what has shipped, **2** what could still be added while staying
file-based, **3** what needs a live controller, **4** the questions nobody has answered yet.
`[x]` shipped, `[ ]` open — where only part of an idea shipped, the item stays `[ ]` and
says which part.

## 1. Shipped (0.1.0 – 0.12.x)

### 0.1.0 - 0.3.0, TP (.ls)
- [x] Full syntax grammar: header, line numbers, motion J/L/C/A/S, speeds and units, FINE/CNT/ACC, motion options, registers with inline comments, all I/O types, labels, CALL/RUN, macro instructions, `$` system variables, `/POS` blocks, remarks.
- [x] Hover docs for ~80 instructions and motion options, with the motion line decoded in plain English.
- [x] Register / I/O hover: controller comment and value from `numreg.va`, `posreg.va`, `strreg.va`, `diocfgsv.va`; mismatch warning when the inline comment differs.
- [x] `P[n]` hover shows the full taught position (UF, UT, config, XYZWPR or joints).
- [x] `CALL prog` hover shows the callee's comment, size, and who else calls it.
- [x] Macro instructions (`GO TO HOME POS`) resolved to the real program through `sysmacro.va`.
- [x] Go to definition: `JMP LBL` → label, `P[n]` → position data, CALL/RUN → program file, macro → program.
- [x] Find All References: labels, positions, registers, I/O, and program callers across the whole workspace.
- [x] Document highlights for the symbol under the cursor.
- [x] Outline: header attributes, main program split by label regions (calls, macros, motions inside), positions with coordinates and "unused" tags.
- [x] Workspace symbol search (`Ctrl+T`) over every program in the workspace and backup folders.
- [x] Completion: instruction snippets, labels after `JMP LBL[`, programs after `CALL `, registers/I-O/PRs **with controller comments** after `R[` `DI[` `PR[` …, positions after `P[`, macro names.
- [x] In-line hints, wrapped in `{ }` and muted (decorations, so no theme can tint them): `P[1]{JNT}{UF1}{UT2}` next to every `P[n]` (representation and frames as separate badges, narrowed by `robotCode.tp.decorations.positionFields` to any of type / user frame / user tool, or none); `R[15]{Speed}` controller comment after a register written without one (hover → **Insert it**); live value `R[151]{2}`. `robotCode.tp.inlineHints` turns them off.
- [x] Diagnostics: duplicate / undefined / unused labels, untaught / unused / duplicate positions, IF-THEN/FOR balance, speed and CNT ranges, missing CALL targets, unknown macros, comment mismatch (vs controller and vs other lines), header problems, line-number sequence and LINE_COUNT when auto-renumber is off.
- [x] Quick fixes: use controller comment, renumber, remove unused label, remove unused position data.
- [x] CodeLens: jump count on labels, caller count on the header.
- [x] Auto-renumber with LINE_COUNT and ` ;` fix-up, cursor line left alone, merged into your undo step.
- [x] Rename (`F2`): label number, position number, register/I-O comment across the file.
- [x] Format Document = renumber.
- [x] Commands: Renumber, Go to Label, Toggle remark `//`, Insert banner, Convert J⇄L, Scale speeds, Set termination, Copy without positions, New TP program wizard, Call graph webview.
- [x] Folding: header, label regions, IF/FOR, comment banners, each position.
- [x] Status bar: program name, line/label/position counts.

### 0.1.0 - 0.3.0, KAREL (.kl)
- [x] Grammar with directives, builtins, types, ports, system variables.
- [x] Hover for ~200 builtins (signature + description), ~40 common `$` variables, and every user symbol with its doc comment.
- [x] Go to definition incl. `ROUTINE x FROM prog` (into the other file) and `%INCLUDE` files.
- [x] References, highlights, rename (12-char limit enforced).
- [x] Outline: constants, types with structure fields, variables, routines with locals, main BEGIN.
- [x] Completion: keywords, directives, builtins with parameter snippets, user symbols in scope, `$` variables, structure fields after `.`.
- [x] Signature help for builtins and user routines.
- [x] Folding for routines and every block.
- [x] Indentation formatter.
- [x] Diagnostics: block balance (one-line `IF…ENDIF`, `MOVE … ENDMOVE`, `WAIT FOR`, `PULSE … FOR` handled), END-name mismatch, identifier length (configurable), unused declarations, program-name vs file-name.
- [x] Compile with ktrans (`Ctrl+Shift+B`), compile-on-save option, errors mapped to the editor.
- [x] New KAREL program wizard.

### 0.1.0 - 0.3.0, controller data & views
- [x] Reads `numreg.va`, `posreg.va`, `strreg.va`, `diocfgsv.va`, `sysmacro.va` from the workspace or any folders in `robotCode.data.backupFolders`; newest copy wins; live re-scan on change.
- [x] Programs / Registers / I/O trees in the Robot Code activity bar; click → find uses.
- [x] Registers & I/O table webview with filter, tabs per kind, copy-as-`R[5:Comment]`, find uses.
- [x] Call graph webview (callees to depth 5, direct callers, macro edges, missing programs dashed).
- [x] Grammars for `.va` `.dt` `.dg` `.io` and `.cm` `.cf`.
- [x] "Robot Code Dark" theme.
- [x] `.vsix` with zero runtime dependencies; `npm test` corpus tests; `npm run smoke` real-VS-Code integration test with screenshots.

### 0.7.0 - 0.8.0: teaching, offsets, checks and refactors

Proposed and built 2026-09-14 (Sam: *"go ahead and do it all except the cycle time"*).
Kept in full because what each one **refuses** to do is the part worth not re-deriving.

- [x] **Offset a selection of positions** - same byte-exact surgery as teach, driven by
      arithmetic. `X=3 Y=-1.5`, `3 0 -1.5`, `E1=250` all parse. Applied in each point's OWN
      user frame; a mixed-frame selection is called out, and a cartesian offset onto a
      joint-taught point is refused rather than converted. Rotation about a frame is still
      open and is a separate decision - that is where it gets mathy.
- [x] **Cross-reference findings as editor diagnostics** - the index now records
      read/write access while parsing each file, so `WorkspaceIndex.findings()` is one pass
      over cached data, cached per robot folder and dropped when the index changes. Reported
      once per register at its first use. Comment disagreements deliberately NOT repeated
      here; `tp.commentMismatch` already owns those.
- [x] **KAREL undeclared variables** - calibrated on the 623-file corpus: 977 raw hits to
      37, with the survivors hand-checked. Skips any program with `%INCLUDE` and any file
      with no `PROGRAM` statement (include fragments, and binary `.pc` saved as `.kl`).
      `KAREL_PREDEFINED` in builtins.ts holds the names that need no declaration - **add to
      it rather than loosening the check** when a false positive turns up.
- [x] **Near-duplicate positions** - same user frame only, tolerance
      `tp.diagnostics.duplicatePositionTolerance` (0.5 mm, `0` = off), one report per point.
- [x] **CNT into an operation that needs FINE** - `tp.diagnostics.fineRequiredPatterns`
      is the plant-specific escape hatch; the built-in rules are only the shapes that are
      nearly always real (process instruction, pulsed output, hand/tool signal).
- [x] **Extract to Program / Inline Program** - `refactor.ts`. Extract refuses a jump out
      of the selection, a jump into it, or an unbalanced IF/FOR, because TP has no scope. A
      position used on both sides of the cut is COPIED and the warning says the two copies
      will drift. Inline refuses a call with arguments and warns about `END` in the callee.
- [x] **Renumber a register across the program** - keeps inline comments, reports a
      collision with a number already in use. Single-file only; workspace-wide is still open.

### 0.9.0 - 0.12.x: frames, the field backlog, the sidebar (details in CHANGELOG.md)
- [x] **Frame conversion, mirror, relabel** (0.9.0 / 0.10.0) - arithmetic on `sysframe.va`,
      convention measured against CURPOS.DG; mirror conjugates and never touches CONFIG.
- [x] **Teach asks cartesian/joint and which UF/UT**; no "are you sure" after that; every
      choice shows the live values it would write. Untaught (`UF : F`, `********`) blocks are
      rebuilt from the reading.
- [x] **Clean Up Unused Positions**, position-name rename, whole-backup register renumber and
      comment rename.
- [x] **Customer header templates** (Ford GVOSS matches the 2024-10 guide; GM/Stellantis are
      starting points until their guides are to hand). Insert Program Header, New TP Program.
- [x] **`--eg` extended comments**, continuation lines, V8.30 `[index:state:comment]` I/O,
      unusual bracket shapes degrading with a diagnostic and a per-backup raw-token count.
- [x] **`$` system variable reference** - RUKUS's `SysVarsReference.json` (three FANUC manuals
      merged, the rest inferred from the name and labelled so), bundled subset for a PC without
      RUKUS, hover + completion in TP, KAREL and `.va`.
- [x] **Payload schedules** from `symotn.va`: hover, inlay, completion, diagnostic, status bar.
- [x] **Sidebar**: six sections with counts (Controllers cards, Backup, TP, PC, Macros, Data),
      one colour and icon per kind shared with editor tints and the status bar. TP programs
      list one row per name - the `.tp` only where no `.ls` exists. The Files panel under a
      robot shows programs only by default (`.ls`, a `.tp` where no `.ls`), filter icon flips it.
- [x] **Program flow**: every edge captioned with where it lands, TRUE/FALSE with the whole
      condition, labels stacked, banner on the entry node.
- [x] **Download Backup over one FTP session** (`mget`), with a slow file or a dropped data
      connection no longer ending the run.
- [x] **Programs resolve from where the file lives** - a robot file's CALLs against that
      robot's listing; nothing is claimed until the device has been listed.
- [x] **Themes**: Dark, Light, High Contrast, Light High Contrast (0.12.8).
- [x] **The grammar is tested** (0.12.8): every regex compiles under Oniguruma and the fixtures
      tokenise to the scopes the changelog names. 0.11.0-0.12.7 shipped a grammar three of whose
      rules did not compile (eaten backslashes); nothing exercised tokens until now.

### 26.91.24012: snapshot sync (issue #12) - the snapshot as the robot's index
- [x] **Fetch / Pull / Push / Compare / Revert** (`robotCode.sync.*`, editor tab, context submenu,
      Snapshot view rows, Programs rows, palette). The snapshot is the last known robot state.
- [x] **Container-bound robot actions** - fetch/pull/push/compare/revert/teach/record/live-edit use
      the robot the file's own container names (or the `fanuc://` authority); a container bound to
      a missing controller is refused, never aimed at another robot. Only non-container files ask.
- [x] **Compare with Snapshot** - diffs working↔snapshot (normalized/verbatim) and offers
      **Update & Compare** when the file's robot is connected. A **conditional Revert (discard)**
      tab button appears only when the working copy differs from the snapshot.
- [x] **`<XMP>`-wrapped controller files are unwrapped** (some firmware serves a text file as a
      bare `<XMP>…</XMP>`), so Pull/Fetch and the push read-back no longer keep the wrapper lines.
- [x] **Fetch on open** (`robotCode.sync.promptOnOpen`, default on) - opening a container program
      connects that program's robot and offers to fetch the newest copy into the snapshot (the
      working copy is never touched). Once per file per session and muted for 5 minutes after the
      container's last snapshot fetch, with **Don't Ask Again**.
- [x] **Verbatim push gate** - the robot's copy is compared to the snapshot with nothing
      stripped; a difference refuses the push until the snapshot is updated. `containers.guardUpload`.
- [x] **Push completes the sync** - after an explicit Upload Program the controller's read-back is
      pulled into the working file so working = snapshot = robot (`containers.pullAfterPush`:
      `always` / `when-identical` / `never`); the difference is reported when the controller
      rewrote something (metadata, line numbers, labels). Live-edit saves never rewrite the file.
- [x] **Post-push verification** - read back, snapshot set to the controller's copy, round-trip
      verdict (catches mistranslation).
- [x] **Snapshot history** reflog (`.robocode-robot/snapshot-history/`), bounded.
- [x] **Per-file age map** in `snapshot.json` (`files`, `updatedAt`).
- [x] **Snapshot view** replaces the Backup inventory (`robotCode.snapshot`); scope groups + raw
      mirror, ages, `=`/`≠`, per-file actions.
- [x] **Sync status bar item** + merged connection/snapshot item; TP stats item removed.
- [x] **Push failure errors** read from `ERRCURR.LS` / `ERRALL.LS` over HTTP, or RUKUS's Error
      Watcher when linked.
- [x] **`containers.gitAware`** - note uncommitted git changes before a push.
- [x] **Snapshot sync in the Programs view** (git-shaped marker per program, `n/n synced` robot
      rows, `Fetch & Compare All`), **snapshot position/register diff**
      (`robotCode.sync.comparePositions` / `compareRegisters`) and a **snapshot-history browser**
      with restore - shipped 2026-09-25. The separate per-robot Sync view was retired as
      redundant.
- [x] **Folder fetch / pull** (`robotCode.sync.fetchFolder` / `pullFolder`) - right-click a folder
      (Explorer, or a robot folder / snapshot scope / snapshot sub-folder in the views) to read
      everything at or under it off the controller. Fetch updates the snapshot only; Pull updates
      the snapshot, then overwrites the matching working files.
- [ ] Container-first migration (cells/clusters by directory; retire `robotCode.robots` /
      `data.backupFolders`) - follow-up.
- [ ] Full RUKUS cluster -> robot cell import - follow-up.

## 2. Could add — still file-based

**Skipped on purpose:** anything live/monitoring/backup-scheduling - RUKUS's. (Cycle-time
estimation was removed from this document entirely on 2026-09-14: Sam, "we cant and wont do
that". Do not re-propose it.)

**Both remaining items shipped in 0.9.0.** Sam pushed back on the "rotation is mathy" framing and
was right: *"we can do a utool/uframe to a different one since we can read all of that data from
the back up and it's just math - no kinematics needed."* The distinction that had been blurred:
**kinematics** (joint angles <-> cartesian) needs link geometry a backup does not contain;
**frame transforms** (cartesian in frame A <-> frame B) need only the two frames, and
`sysframe.va` states both exactly. See `tp/frameMath.ts`.

### Editing power tools
- [ ] **Position tools** (partly shipped): ~~shift selected positions by an offset~~ (shipped 0.8.0, in each point's own frame); rotate about a frame, ~~mirror across a plane~~ (0.10.0), convert joint ↔ cartesian representation of an EXISTING point (needs robot kinematics = pick from a model table — but ~~re-teaching from the robot in the other representation~~ shipped 0.11.0, since the controller reports both), ~~set UF/UT on selected positions~~ (0.10.0 relabel; 0.11.0 teach asks which frames), ~~re-teach `P[n]` from `PR[m]` data~~ (shipped 0.7.0), ~~clean up unused / commented-out-only positions~~ (0.11.0), ~~rename position names~~ (0.11.0).
- [x] **Position diff** (0.13.0): Compare Positions With… - another backup's copy or any file, deltas per axis, distance, moved/added/removed/reframed flags.
- [x] **Extract to program** (0.8.0): refuses anything that is not self-contained control flow.
- [x] **Inline program** (0.8.0): labels and positions renumbered past the host's.
- [x] **Renumber labels** in steps of 10 (0.3.1). Renumber positions contiguously / remove unused positions in one go: open.
- [ ] **Register renumbering / remap** (partly shipped) (0.8.0 does one program, with a preview and a collision warning). Across the whole workspace: still open.
- [ ] **Bulk comment sync** (pull half shipped 0.13.0 as Sync Inline Comments from Controller; push half needs KCL syntax verified on a real cell): push inline comments to a `.cm` command file (`SETREG`, `SETIOCMT`) the controller can run, or pull controller comments into every program.
- [ ] **Semantic tokens**: colour registers by "written here / read here", flag never-written registers.
- [ ] **Motion profile view**: for a selected motion path, list speeds/terminations, total path length estimate from positions, flag CNT100 into a FINE-required operation.
- [x] **Program templates** (0.13.0) via `robotCode.tp.programTemplates` (Empty, Main loop; New TP Program and Insert Program Template at Cursor). A `.robotcode/templates` folder is still open if plants want file-based ones.

### 0.9.0 - frames

- [x] **Convert positions between user and tool frames** - `tp/frameMath.ts` (pure rigid-body
      maths), `data/sysFrameParser.ts` (`$MNUFRAME` / `$MNUTOOL` out of `sysframe.va`), and
      `planFrameShift` in teach.ts reusing the same byte-exact surgery.
      **The rotation convention is MEASURED: `Rz(R) . Ry(P) . Rx(W)`.** CURPOS.DG reports one
      pose in both the active user frame and world, so world must equal `UF o P`; only that
      ordering reproduces it (9/9 real readings, worst 0.010 mm - the alternatives miss by up to
      5.5 m). **Do not "simplify" the ordering**; the corpus test will catch it, and that is why
      the test exists.
      Guards worth keeping: a joint-taught point is refused (there is no frame to convert, and
      converting would need the kinematics); extended axes are left alone (a frame change does
      not move the rail); and orientation is compared **as a rotation**, so a gimbal-locked point
      at P = +/-90 is not re-spelled into an equivalent-but-different W/P/R.
- [x] **Renumber a register across the robot folder** (0.9.0; 0.8.0 did one file). Counts per
      file before asking, names the programs where the destination is already in use, and says
      that the controller's own copy and any KAREL/PLC are not updated.
- [x] **Mirror a set of positions across a plane** (0.10.0). Orientation is CONJUGATED
      (`R' = M . R . M`), not multiplied: a reflection has determinant -1, so applying it
      directly gives something that is not a rotation and has no W/P/R. `CONFIG` is left alone
      and warned about - a mirrored pose often needs a different arm configuration, which needs
      kinematics. Which frame's plane is asked, not assumed.
- [x] **Relabel UF/UT without converting** (0.10.0) - keeps the numbers, so the point MOVES.
      The confirmation says so in capitals and points at Convert as the likely intent.

### Analysis / cross-program
- [x] **Register cross-reference report** (0.3.0): every R/PR/DO/F with read/write sites across all programs, exported as CSV/HTML — the "who touches R[151]" question.
- [ ] **Dead code** (programs half shipped 0.13.0 as Report: Programs Never Called, with caveats; labels half open): labels only reachable through never-true conditions, programs never called (respecting macros, RSR/PNS tables, condition handlers).
- [ ] **Call graph for the whole cell** with cycle detection and depth from the main program.
- [ ] **I/O usage map** (partly shipped) (partly in the cross-reference findings: outputs written from several programs; commented-but-unused still open): DI/DO used but not commented, commented but never used, outputs written in two tasks (multitask conflicts).
- [x] **Backup diff** (0.3.0): two backup folders → changed programs, changed positions (with delta), changed registers, changed I/O comments, changed system variables. This is a killer feature for commissioning.
- [ ] **Alarm log viewer** (partly shipped) (live alarms in the Robots view since 0.2.0; offline errall.ls table still open): parse `errall.ls` / `errhist.ls` into a table with severity filter and "open program at line".
- [ ] **System variable dumps** (frames half shipped 0.13.0: sysframe.va hover, Data view groups, register table tabs; dcs*.va open): outline and hover for `sysvars.va`, `dcs*.va`, frames (`sysframe.va`) with a frames table view.

### KAREL
- [ ] **Project-wide symbol index** (routines exported by each program, `%INCLUDE` graph) → cross-file references and rename.
- [ ] **Type checking light**: argument count/type mismatches on routine calls, INTEGER↔REAL assignments.
- [ ] **Dictionary (.ftx/.utx) support**: grammar, element hover, "go to dictionary element" from `READ_DICT`.
- [ ] **Form/menu file (.ftx) preview**.
- [ ] **ktrans problem matcher polish** once real output samples are on hand; `kcl`/`maketp` integration to build `.tp` from `.ls` and load into ROBOGUIDE.

### TP binary converter (.ls <-> .tp) — investigated 2026-09-14, Sam is taking this on

**Why it matters (Sam, 2026-09-14): "some robots dont have the ascii upload feature".** On a
cell without that option the only thing you can pull off the controller is `.tp`, and the only
thing you can put back is `.tp`. There the converter is not a convenience, it is the only way in
or out. An earlier read of this idea called it redundant because in
`Documents\RUKUS\Backups\Testing` **all 1402 `.tp` files have an `.ls` sibling (0 orphans)** —
but that tree is one plant whose robots all *do* have ASCII upload, so it proves nothing about
the cells that don't.

**Use FANUC's own tools; do not write a `.tp` parser.** `C:\Program Files (x86)\FANUC\WinOLPC\bin`
has `maketp.exe` (`.ls` -> `.tp`), `printtp.exe` (`.tp` -> `.ls`), `ktrans.exe` (`.kl` -> `.pc`),
`kcdict.exe`, `kconvars.exe`, `setrobot.exe`. The binary format is undocumented and version- and
option-specific; a home-grown decoder would be *silently* wrong, which is the one failure mode
this extension is built to avoid.

**Argument order (all of these tools):** `TOOL infile [outfile] [/config inifile]` — the input
file comes FIRST. A flag's value is otherwise read as a stray positional and you get
`Too many arguments: <value>`. This is exactly the bug that made `karel.ktransVersion` useless
(fixed 0.8.1).

**`robot.ini` — the format, confirmed from one setrobot actually wrote:**

```ini
[WinOLPC_Util]
Robot=\C\Users\you\Documents\My Workcells\<cell>\Robot_2
Version=V9.40-1
Path=C:\Program Files (x86)\FANUC\WinOLPC\Versions\V940-1\bin
Support=C:\Users\...\Robot_2\support
Output=C:\Users\...\Robot_2\output
```

- **`[WinOLPC_Util]` is the section.** This is the whole trick — with any other section (or none)
  every tool stops at *"A robot has not been defined yet, run Setrobot"* before reading anything
  else. With it, they proceed. **setrobot is not required per project; it is only needed once to
  produce a first file to copy.** A hand-written ini drives `printtp` to exactly the same stage.
- **`Robot=` uses `\C\Users\...`** — drive letter, no colon, leading backslash. A normal
  `C:\Users\...` path gets `0x80043054 The requested item was not found`.
- **`Output=` must not be the folder the input sits in.** The tool copies the input there and
  works on the copy; same folder gives `Copy to/from source directory failed: 32` (sharing).
- Default config path is `.\robot.ini`, i.e. the **current working directory** — so a wrapper can
  just set `cwd` and drop a generated ini there rather than fighting `/config`.

**TRAP — where setrobot puts it.** setrobot writes `robot.ini` *next to itself* in
`C:\Program Files (x86)\FANUC\WinOLPC\bin`. Unelevated that write is denied and Windows silently
redirects it to
`C:\Users\<user>\AppData\Local\VirtualStore\Program Files (x86)\FANUC\WinOLPC\bin\robot.ini`.
Nothing reports this, which is why it looks like setrobot saved nothing. Run it elevated and it
lands in the real folder.

**The hard part, and it is not the ini.** The translator needs a controller *image* whose
installed options match the program, because the instruction set differs per application. With a
correct ini, `printtp` gets all the way to real controller errors — `SPRM-086` (parameter) on an
image mismatch, `????-270` when the error dictionary is not in that robot's support. So each
robot needs a support set that matches it: a ROBOGUIDE virtual robot, or a real backup restored
into one. `Versions\V940-1\support` (82 generic files) is NOT enough; a virtual robot carries its
own (107 for the cell checked). 18 core versions V6.40–V9.40 are installed under
`WinOLPC\Versions\`.

**`FANUC_DEFAULT_VERSION`** is read by the tools but rejects `V9.40`, `V940` and `V940-1`, and
does not clear the robot gate anyway. Dead end.

- [ ] **Round-trip proof before trusting it either way.** `printtp` emits a *listing*; whether
      `.tp -> .ls -> .tp` is byte-stable is unknown and is exactly the kind of thing that wants
      the same corpus test the teach formatter got (1402 files available to try it on).
- [ ] **`.pc` -> `.kl` is impossible** — there is no KAREL decompiler; ktrans is one-way. Worth
      stating plainly so nobody expects a general "any format to any format" matrix. The real
      matrix is `.ls <-> .tp` both ways, and three one-way compiles.
- [ ] **`maketp` output goes on a robot.** If this gets wired up, it is explicit-only, never on
      save, and never silently overwriting a `.tp` inside a backup folder.

### Other brands (same architecture, new folder each)
- [ ] ABB RAPID (`.mod`, `.prg`, `.sys`), KUKA KRL (`.src`, `.dat`), Yaskawa INFORM (`.JBI`), Universal Robots URScript, Kawasaki AS. Each gets grammar, parser, symbols, hovers, and its own data-file readers.

### Distribution
- [ ] Auto-update from a private feed (RUKUS checks a version file, downloads the `.vsix`).
- [ ] Settings sync profile for the plant (theme, ktrans path, backup folders) written by RUKUS.

## 3. Runtime features — need a live controller (or ROBOGUIDE)

Everything here uses channels a stock R-30iB has: FTP (read/write files), the built-in web server (read `.va`/`.dg` over HTTP), and optionally a small KAREL socket server we ship. Full plan and safety rules in `ROADMAP.md`.

### Read-only (cannot hurt the robot) — shipped 0.2.0, pulled back to on-demand in 0.6.0
- [x] **Robot profiles** with connect/disconnect; passwords in VS Code SecretStorage. Connect now
      only proves the controller answers (one static page) and reads no data at all.
- [x] **Register/I-O values in hovers and editor decorations** — read on **Get Register Values** /
      **Get I/O State**, not polled. Each value carries its age, greys out once stale, and is drawn
      as a muted `{value}` hint on the line.
- [x] **I/O panel** with ON/OFF dots — filled by Get, shows the points that are ON.
- [x] **Running-line marker**: highlights the TP line the robot was on when program state was last
      read (`PRGSTATE.DG`). Status bar says "not read" rather than "idle" until you press Get.
- [x] ~~**Live alarms panel**~~ — **moved to RUKUS** in 0.6.0 (`rukus://alarms` → Error Watcher).
      The extension no longer reads `ERRALL.LS`; `parseAlarms` stays, still unit-tested.
- [x] ~~**Robot dashboard webview**~~ — **moved to RUKUS** in 0.6.0 (`rukus://monitor` →
      Production Dashboard). A live view belongs where the connection can be held.
- [x] **Current position panel**: TCP in world/UF, joints, active UF/UT — on **Get Current
      Position**, one `CURPOS.DG` read per press.
- [x] **Auto-refresh**, off by default, per robot, warned before it is switched on; re-reads only
      the panels already opened.
- [x] **Browse the controller**: `MD:`, `FR:`, `UD1:` as a virtual file tree; open programs read-only tagged with the robot name; diff robot copy vs local copy.
- [x] **Pull backup**: one click "download all `.ls` + `.va`" into a dated folder (or trigger RUKUS to do it).
- [x] **Watch mode** — answered in 0.7.0 by **Get Fresh Copy from Robot** instead (superseded by **Fetch**/**Compare** in 26.91.24012). Reads the open
      program off the controller once, on the editor title bar, saves the robot's copy to
      `.robot-history/<robot>/` when it differs, opens the diff and names the difference
      ("only taught positions differ (3)") — which is the pendant-touch-up question. Still no
      watch: a watch is a poll wearing a different hat.

### Writes (opt-in per robot, confirmed, logged, blocked while running in AUTO)
- [ ] **Send program to robot**: validate locally (zero errors) → FTP PUT → read back → refresh; previous version saved to `robot-history/`.
- [x] **Touch-up from robot** (0.7.0) — and it turned out **not to belong in this section at all**.
      Teaching replaces `P[n]` *in the editor* from one `CURPOS.DG` read: the file changes, the
      controller does not, so it costs exactly what the Get Position button costs and crosses none
      of the write guards below. Refuses a frame mismatch, a representation mismatch and a missing
      extended axis rather than writing a valid-looking point the robot has never been to.
      Also shipped: **Record New Position from Robot** (next free `P[n]` + optional motion line)
      and **Teach from PR[n]**, which needs no robot at all.
- [ ] **Write registers / I/O** from the Registers table (KCL over HTTP or the KAREL server); simulate/unsimulate I/O.
- [ ] **Comment sync to controller**: push inline comments as register/I-O comments.
- [ ] **Run / abort / pause a program**, select program, cycle start via UOP or the KAREL server.
- [ ] **Deploy `.pc`**: ktrans then FTP the compiled KAREL, clear/reload the program.

### Real-time (ships a small KAREL server `.pc` on the robot)
- [ ] Sub-100 ms register/I-O/position updates instead of polling.
- [ ] **Debug adapter**: VS Code Run/Debug UI shows the running task and line, pause/abort/start from the standard buttons, step for KAREL.
- [ ] **Event stream**: alarms, program start/stop, I/O edges → an Output channel and optional notifications.
- [ ] **Multi-robot dashboard**: one webview with every cell robot's state, alarms and cycle counter.

### Test bench without a robot
- [ ] ROBOGUIDE virtual controllers expose the same FTP/HTTP on `127.0.0.1`, so every runtime feature is developable and testable on the PC first.

## 4. Open questions / notes

- [ ] Low-power mode (single setting) instead of a separate lite build: slower poll, no inlay hints/CodeLens, skip dated backup folders when indexing. Only if a weak PC actually struggles (Sam, 2026-09-12).

- [x] Robot Connections form with Test connection, hints, name suggestions from backups (0.4.1) — not yet eyeballed in the UI; Sam to test.
- [x] Multi-robot workspaces (several robots / dated backups side by side) — data and program lookups scoped per robot folder (0.4.0). Test tree: `C:\Users\you\Documents\RUKUS\Backups\Testing` (Latest + dated folders, 5 robots, 1707 programs).

- [x] Program Flow flowchart of a single program with branches/merges/loops + Copy as Mermaid (0.5.0). Call-graph Mermaid export still open if wanted.

- [ ] Verify PRGSTATE.DG shape for a RUNNING TP task (virtual robots were all ABORTED when checked 2026-09-12; run a program in ROBOGUIDE and hit Refresh) (only ABORTED tasks were in the sample backup; the mock generates the RUNNING form from the same layout).
- [x] Web server listings: /MD/ is 404 on R-30iB Plus V9.40 but INDEX_TP/VR/OT/ER.HTM list everything; file responses are HTML-wrapped (<PRE>) and are unwrapped (0.5.3, verified on 5 ROBOGUIDE controllers). Anonymous FTP works too.
- [x] ktrans output format verified with KTRANS V9.40-1 (fixtures in test/); parser rewritten (0.5.3). Note: ktrans does not flag undeclared variables — our own "undeclared" check would add value (open).
- [ ] **Teaching has not been done against real hardware** — only ROBOGUIDE and the mock. The
      formatting is proven (2363/2363 positions round-trip byte-identical across the whole backup
      tree), but nobody has yet jogged a real robot, pressed Teach, sent the program back and
      watched it go to the right place. That loop is the actual acceptance test.
- [ ] **`CURPOS.DG` and multiple motion groups**: the file has `Group #: 1` and teaching uses the
      first group in the block. A two-group position (GP1 + GP2) can be targeted in the plan layer
      (`opts.group`) but no command exposes the choice yet, and a two-group robot has not been seen.
- [ ] **Send the taught program back**: teaching changes the file, and the file gets to the robot
      by hand today. That is the guarded upload in "Writes" above — still not built, and still the
      thing that would make teach a full loop rather than half of one.
- [x] The big backup tree (`C:\Users\you\Documents\RUKUS\Backups\Testing`) ran **150
      corpus-test failures; now 0** (0.8.0). 84 were the flow builder dropping every
      `ELSE`/`ENDIF` - invisible because reference-backup contains no `IF ... THEN` at all -
      12 were `LINE_COUNT` vs a line written without its number, and the rest were the
      test's own S002R01 value assertions being run against 22 different robots. Those are
      now scoped with `isRefRobot` / `isRefBackup`; **run the corpus test against this tree,
      not just reference-backup, or a whole class of bug stays invisible.**
- [ ] Identifier length limit on newer KAREL versions (setting exists: robotCode.karel.maxIdentifierLength).
