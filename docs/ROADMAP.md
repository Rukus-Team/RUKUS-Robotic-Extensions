# Roadmap — live robot features

Everything in 0.1 works from files. The next step is talking to the controller
itself. FANUC R-30iA/iB/iB Plus controllers expose three usable channels without
any option beyond the standard Ethernet interface:

| Channel | What it gives | Needs |
|---|---|---|
| **FTP** (port 21) | Read and write any file on `MD:`, `FR:`, `UD1:` etc. That includes `.ls` (ASCII program export), `.va` dumps, `.tp/.pc` binaries, `.sv/.io/.dt`. Uploading a `.ls` loads the program; the controller returns a translation error if it is bad. | FTP server enabled on the robot (default on), user/pass (often blank). |
| **Web server** (port 80) | `MD:/NUMREG.VA`, `MD:/POSREG.VA`, `MD:/IOSTATE.DG`, `MD:/CURPOS.DG`, `MD:/PRGSTATE.DG`, `MD:/ERRALL.LS` etc. as plain HTTP GET — the same files FTP serves, read-only, no login. Also `/KAREL/<prog>` runs KAREL web programs, and `KCL` commands via `http://robot/KCL/...` when enabled. | HTTP enabled (default). |
| **KAREL socket messaging / PC Interface option** | Real-time register/I/O read/write, program start, alarm stream. Needs the SM option or a KAREL server program on the robot. | Option or custom `.pc` we ship. |

RUKUS already handles backups, so the plan leans on FTP/HTTP first (zero footprint on the robot), then optional KAREL helpers.

> **Status 2026-09-12:** Phase 1 shipped in 0.2.0 (items 1–6 below, plus backup pull from item 8). Verified against a mock controller built from a real V9.40 backup; still to be confirmed on a live cell. Phase 2 (guarded upload) is on hold: Sam decided 2026-09-12 that RUKUS owns cell/robot management and the extension stays the editor. The living backlog is `FEATURES.md`.
>
> **Status 2026-09-13 — read this before item 2 below.** 0.6.0 removed the timer this page
> describes. A controller *generates* each `.DG` file when it is requested, so a background
> poll is permanent load on the robot for data nobody is looking at. **Every read is now an
> explicit Get**, one file per press, with the age of each reading shown; auto-refresh exists
> but is off by default and re-reads only what you already opened. The smoke test asserts
> **zero requests during an idle window**, measured at the mock controller, so a reintroduced
> poll fails the build.
>
> Item 5 (alarm log) **moved out of the extension entirely** — it is `rukus://alarms` now.
> Where an item below says "refresh on a timer", read "on Get".
>
> **Status 2026-09-14 (0.7.0 / 0.8.0).** Teaching a position from `CURPOS.DG` shipped, and it
> did **not** need Phase 2 or 3: it is one on-demand read plus a text edit, so it landed inside
> Phase 1's model. That is the distinction this page had blurred — **"write" here means writing
> to the CONTROLLER, not to the file.** Editing a `.ls` in the editor needs no per-robot opt-in
> and cannot affect a running robot; it needs a different set of guards, about producing a point
> that is wrong rather than a robot that moves. Item 7 (upload) is still the only way an edited
> program reaches a robot, and it is still not built.

## Phase 1 — Read-only connection (biggest payoff, lowest risk)

1. **Robot profiles**: `robotCode.robots: [{ name, host, ftpUser, ftpPass }]` in settings, plus a *Robots* tree in the activity bar with connect/disconnect state. Passwords via the VS Code SecretStorage API, never in settings.json.
2. **Pull controller data live**: on connect, GET `NUMREG.VA`, `POSREG.VA`, `STRREG.VA`, `DIOCFGSV.VA`, `SYSMACRO.VA` over HTTP into an in-memory `DataStore` layer that overrides the backup-file data. Refresh on a timer (2–5 s for registers, on demand for I/O config). Hovers and inlay hints then show **live values**.
3. **Live I/O state**: `IOSTATE.DG` (or `DIOCFGSV.VA` + `IOSTATE`) parsed into DI/DO/RI/RO/UI/UO/F values; the I/O view shows ON/OFF dots that update.
4. **Live program state**: `PRGSTATE.DG` → running task, program, line. Decoration in the editor highlighting the line the robot is executing (like a debugger's current-line marker) when the open file matches the running program. Status bar: `▶ MAIN_PICK line 42 · RUNNING`.
5. **Alarm log**: `ERRALL.LS` / `ERRCURR.LS` → an *Alarms* view with timestamps, severity, and a "jump to program line" action when the alarm names a TP line.
6. **Open program from robot**: browse `MD:` over FTP, open a `.ls` read-only in the editor tagged `[S002R01]`, diff it against the local copy (`vscode.diff`).

## Phase 2 — Write paths (guarded)

7. **Upload program**: right-click a `.ls` → *Send to robot*. Steps: renumber & validate locally (zero errors required) → FTP PUT to `MD:` → read back the response/`.ls` to confirm load → refresh index. Refuse while the program is running or selected (check `PRGSTATE.DG`). Always keep a timestamped copy of the previous version in a local `robot-history/` folder so every push is reversible.
8. **Backup to folder**: one-click *Download all programs* (FTP `MGET *.LS`) plus the `.va` set into a dated folder, which then becomes a `data.backupFolders` entry. This overlaps with RUKUS; expose it so RUKUS can trigger it, or make the extension call RUKUS instead.
9. **Register / I/O write**: edit a value in the Registers table → write via `SETVAR`/KCL over HTTP when enabled, or via a small KAREL server program (see Phase 3). Gate behind a per-robot "allow writes" toggle and a confirmation on the first write per session.
10. **Comment sync**: push inline comments from programs to the controller (register/I-O comments) or pull controller comments into programs — the diagnostics already find the mismatches.

## Phase 3 — Real-time channel

11. Ship a tiny KAREL server (`rkserver.pc`) offering a line protocol over a socket tag: read/write R/PR/SR, DI/DO/F, current position, run/abort a program, subscribe to alarms. The extension talks to it over TCP; latency is milliseconds instead of a 2 s poll.
12. **Position tools**: ~~read `CURPOS`, *Touch up* a `P[n]` in the editor from the robot's current
    position~~ — **shipped in 0.7.0, and it needed none of this phase.** Touch-up is one
    `CURPOS.DG` GET plus a text edit, so it landed in Phase 1's on-demand model rather than here;
    what is left for a real-time channel is *Preview* — joint/cartesian differences between two
    positions and distance to current, which is the thing that wants a live feed.
13. **Debug-adapter shell**: use the DAP so VS Code's Run/Debug UI shows the running task, current line, and lets you pause/abort/step with the standard buttons. Stepping needs KAREL-side support; pause/abort/start work through UOP or the server.

## Cross-cutting

- **Safety**: every write is opt-in per robot, logged to the Output channel, and blocked while the robot is in AUTO with a program running unless explicitly overridden. Nothing in Phase 1 can change the robot.
- **"Write" means the controller, not the file.** Teaching a position (0.7.0) edits the `.ls` in
  the editor and is therefore *not* a write in the sense above — it needs no per-robot opt-in and
  cannot affect a running robot. The guards it does need are different ones, and they are about
  producing a point that is wrong rather than a robot that moves: the reading's active `UF`/`UT`
  must match the point's, the representation (joint vs cartesian) must match, and every axis the
  point stores must be present in the reading. Getting the edited program back onto the
  controller is item 7, and is still a write.
- **Simulation**: ROBOGUIDE virtual robots expose the same FTP/HTTP endpoints on `127.0.0.1`, so all of this is testable without a real cell.
- **Other brands**: ABB (RWS REST API over HTTPS), KUKA (KRL over WorkVisual/FTP, or KUKA.Ethernet KRL), Yaskawa (HSES UDP protocol) each get their own connector behind the same *Robots* view and `DataStore` interface.

## Phase 4 — Per-robot containers (`.robocode`)

> **Status 2026-09-19:** Shipped in 26.9.2. This section is the original plan; see
> `docs/design-robocode-containers.md` for the design discussion as it happened.

14. **`.robocode-robot` containers**: each robot folder contains a hidden `.robocode-robot/`
    directory with a `robot.json` declaration, a `snapshot.json` provenance file, and a
    `snapshot/` subdirectory holding a full verbatim robot backup. Working programs live
    alongside the container in declared program folders. The container is the robot's one
    true dataset — no date heuristics, no newest-wins, no ambiguity.
15. **`.robocode-cell` container**: optional workspace-level hidden directory at the git root
    holding a `cell.json` anchor (name, future conventions). Robot markers work standalone
    without a cell container.
16. **Marker-partitioned workspace**: when robot markers are present, only declared program
    folders are indexed as editable programs. Backups, `.robot-history/`, and container
    config are invisible to the extension. Snapshot programs are reference-indexed (resolve
    CALLs/callers/xref) but hidden from the tree and never edited.
17. **Modified-vs-snapshot marker**: every working program shows its status against the
    snapshot: `= snapshot 2026-09-15` / `≠ snapshot · N lines differ` (click to diff) /
    `not in snapshot`.
18. **Snapshot commands**: *Initialize Robot Container…* (wizard: folder → name → program
    dirs → gitignore → first snapshot), *Snapshot from Backup…* (wholesale folder copy),
    *Snapshot from Robot…* (reuse FTP/HTTP backup-download machinery).

## Suggested order for us

Phase 1 items 1–4 first (one or two sessions): profiles, live registers/I/O into hovers, running-line decoration. That is visible, useful on day one, and cannot hurt a robot. Then 7 (upload with safeguards), then the alarms view. Phase 4 (containers) is independent and can be started at any time — it unblocks structured multi-robot workspaces.
