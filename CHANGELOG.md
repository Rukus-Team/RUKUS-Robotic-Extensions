# Changelog

## 26.109.7 - 2026-10-08 - ABB: write access on OmniCore, live status, virtual controller discovery, feature profiles

Beta list 6. Checked against RobotStudio virtual controllers: IRC5 RobotWare 6.16 (every Action) and OmniCore
RobotWare 8.2.1 (write access, speed, program pointer, module load and unload, RAPID data).

### Added
- **Feature profiles.** `robotCode.featureProfile` (Auto, All, FANUC only, ABB only, Custom) and **Robot Code:
  Choose Feature Profile…** turn FANUC, ABB, robot connections, the RUKUS buttons and the file icons on or off
  together. A profile writes the ordinary settings, so the per-setting view always shows what is on.
- **ABB: Find Virtual Controllers** finds the RobotStudio virtual controllers running on this PC, on whatever
  ports RobotStudio gave them, and adds them.
- **ABB: Look Up Event Code…** shows an event's title, cause, consequence and remedy, from the event logs read.
- **ABB: Set Output Signal…** and **ABB: Write RAPID Data…**.
- **Option explanations** in the robot windows, FANUC and ABB: hover an option for a short one, click it for the whole one.
- **RAPID completion offers I/O signals** (from a backup's EIO.cfg and the connected controller) after IF and
  for signal arguments.
- **KAREL: Ctrl+click on a GOTO / GO TO label** jumps to its `label::` line.
- The ABB controller page says whether the controller can be reached without the service port, and at which IP.

### Changed
- **OmniCore write access** works as checked by hand on RobotWare 8.2.1: the PC registers as a remote
  control station, requests write access and gives it back. Writes to a real OmniCore stay off until
  `robotCode.abb.allowRealOmniCoreWrites` is turned on; virtual controllers always accept them. RobotWare 7
  takes mastership over RWS 2.0.
- **ABB status follows the controller's events** (RWS subscriptions) instead of polling, and falls back to
  polling when the controller refuses them or the socket drops.
- **A failed connection turns the robot's status red**, for every brand.
- **ABB names as on the FlexPendant:** Single Cycle / Continuous, Auto / Manual / Manual Full Speed, Motors On,
  Normal / Semistatic / Static tasks.
- **ABB controllers are told apart by their own name and system id**, not the address: a second controller at
  192.168.125.1 is refused. **ABB: Forget Controller Identity** clears the one remembered.
- The ABB controller page's State card is laid out like the FANUC robot page.
- RAPID is coloured in every generated theme.
- README: the Building section is gone for the public beta.
- Notepad++ files regenerated for this version.

## 26.109.6 - 2026-10-07 - ABB support (RAPID, IRC5 and OmniCore controllers, analysis) and a linter for TP, KAREL and RAPID

Issues #16 and #17 (RUKUS #28). ABB RAPID in the editor
(language, navigation, formatting, linting), ABB controllers over Robot Web Services (IRC5 / RWS 1.0 and OmniCore /
RWS 2.0: reads, backup, controller page, event log, I/O), ABB analysis reports, RUKUS clusters with mixed brands,
a linter for every language with a command line, and a side bar and start-up that load only the brands a
workspace holds. Checked against RobotStudio virtual controllers: IRC5 RobotWare 6.16 and OmniCore RobotWare 8.2.1.

### Added
- **Robot Code: Lint Folder…** (Explorer right-click → Robot Code, or the Command Palette) lints every
  TP, KAREL and RAPID program under a folder or backup. Findings go to Problems (files open in an
  editor keep their live diagnostics), and a summary goes to Output → *Robot Code Lint*.
- **robot-lint**, the same linter on plain Node (`dist/robot-lint.js`, in the .vsix): text, JSON or SARIF
  output, exit code 1 on errors, `--max-warnings`, `--rules`, `--init`. For CI and for checking a backup.
- **.robotlint.json** turns rules off, changes their severity and sets their options. It takes `prefix.*` keys
  and `ignore` globs, and VS Code completes the rule names from `schemas/robotlint.schema.json`. The nearest
  one above a file applies, in the editor and the command line alike. **Robot Code: Create Lint Config** writes a starter.
- **Style rules** (`tp.style.*`, `karel.style.*`, `rapid.style.*`). On as hints: a WAIT / WaitDI / WaitUntil with no
  timeout, a missing program COMMENT / %COMMENT, TODO-FIXME left in, unused LOCAL RAPID data, and BREAK left in (info).
  Off until turned on: program/routine length, line length, keyword case, program naming pattern, RAPID data
  prefixes, fixed-time waits, uncommented I/O, moves before UFRAME_NUM/UTOOL_NUM, plant speed limits, and inline targets.
  None is an error by default. Over the FANUC reference backup and 24 IRC5 backups (5,655 modules), no
  style rule reports an error and RAPID reports no warning.

- **Getting around RAPID like TP** (`rapid/symbols.ts` resolves a name as the controller does: routine,
  LOCAL, task, shared modules; labels apart):
  - **Find All References** (Shift+F12) across every module of the task and the shared modules,
    late-bound `%"Name"%` calls included.
  - **Rename** (F2) in every module that sees the symbol. It refuses instructions and predefined names, and a
    new name that is already declared where the symbol is used.
  - Every use of the name under the cursor is **highlighted** (writes apart from reads), and **Ctrl+T** finds
    routines, records and module data in every RAPID file of the workspace.
  - **"N references" above each routine**; click it to list them. Unused routines say "no references".
  - **Quick fixes**: remove an unused LOCAL routine (with its comment block) or an unused LOCAL declaration,
    or add `\MaxTime` to a wait.
  - **ABB RAPID: Go to Label…** (Ctrl+Alt+L) and **Show Routine Call Graph** (Ctrl+Alt+G, or right-click).
    The graph shows the routine's callers, and what it calls through the task, as clickable boxes.
- Checked live against the RobotStudio IRC5 VC (RobotWare 6.16): system, tasks, modules, module text,
  the program pointer (now seen live for the first time), joints, and Back Up and Download (21 files, 0.8 s).
- **OmniCore controllers connect** (RobotWare 7/8 over Robot Web Services 2.0). Everything the ABB Controllers
  view does for an IRC5 now works on an OmniCore too: state, identity, tasks, modules, opening a module from
  the controller, pointers, joints and TCP, **ABB: Convert Target on Controller**, and **Back Up and Download**.
  The client follows the controller family. An OmniCore gets HTTPS with Basic login, HAL+JSON answers
  (`rws/hal.ts` reads them into the same pages as RWS 1.0's XHTML), and the resources RobotWare 8 moved
  (`/rw/panel/ctrl-state`, `/rw/rapid/tasks/{task}/modules`, `/ctrl/backup/create`,
  `/rw/motionsystem/mechunits/{unit}/pose-from-joints`, ...). Test connection in Robot Connections works for it.
  Checked live against a RobotStudio OmniCore VC (RobotWare 8.2.1): Back Up and Download took 23 files in 1.4 s.
  `ROBOT_CODE_ABB_LIVE="NAME=host:port:omnicore,..." npm run smoke:abb` runs the live checks against real or
  virtual controllers.
- **Event log and I/O signals** under each connected ABB controller (also **ABB: Show Event Log** / **ABB: Show
  I/O Signals**, and on the controller's right-click menu). Each is a read-only page read from the controller
  when opened:
  - the event log shows the newest 100 messages, each with its code, type, title, description, causes and
    actions. RobotWare 8 lists oldest first, refuses the newest-first order and counts `start` in pages, so the
    client starts at the page that holds the oldest message wanted and turns the list round;
  - the signals show every signal with its type, value and network/device path.
- **FANUC loads only where it is needed too.** An ABB-only workspace leaves FANUC out entirely: no TP/KAREL
  language features, FANUC views, tools, live extras or controller-data scan. A folder with FANUC files, an
  empty folder, or `robotCode.fanuc.enabled` true loads it. The side bar's brand choice (`robotCode.views.brands`)
  also decides which brands load on the next start. A brand that is off still answers its commands ("FANUC
  support is off in this workspace - turn it on?") instead of "command not found", and opening one of its files
  offers the same once. Output → Robot Code says which brands loaded and why.
- **ABB support loads by itself in a workspace with ABB files.** It needs no setting and no reload when the
  folder (or a backup folder) holds an ABB backup (BACKINFO with RAPID/SYSPAR) or .mod / .prg modules; a
  FANUC-only workspace does not load it. An explicit `robotCode.abb.enabled` true or false still decides. The
  check is a bounded folder scan at start-up, and views and menus follow the result (context key
  `robotCode.abbActive`), not the setting.
- **The side bar follows the workspace's brands.** A FANUC-only workspace shows the FANUC views, an ABB-only one
  the ABB views (RAPID, ABB Controllers), and a mixed one both. In an empty folder, the first time the Robot Code
  side bar opens, it asks which robots you work with and keeps the answer for that workspace.
  `robotCode.views.brands` (auto / fanuc / abb / both) overrides it. If the workspace has ABB files while ABB
  support is off, it offers to turn ABB on, once.
- **Who holds write access**, on the ABB controller row and the controller page's State card: free, or who has it.
  On OmniCore that is the control station holding write access (name and id); on IRC5, RAPID / configuration /
  motion mastership held by the FlexPendant or a remote client. It is read with the controller state (a read only).
  On OmniCore it also says when the pendant's **Remote Access** is off (then no PC may even ask for write access),
  and how to turn it on: Write Access on the FlexPendant, long-press the hard button with the speech-bubble icon (or
  the E-Device button). The "no write access" error says the same, and who holds write access when someone does.
- **ABB controller page** (click a controller in ABB Controllers, or **ABB: Open Controller Page**). It looks
  like the FANUC robot page but holds what an ABB controller has: state (motors, mode, speed, RAPID execution),
  the controller and its options (searchable), RAPID tasks with program and motion pointers (click to open),
  position (TCP with quaternion and configuration, joints), the loaded modules (click to read one), I/O signals
  (the ones set, or search any by name or network/device), and the event log, newest first. Nothing is read
  until a card's Get is pressed, and each card shows how old its reading is.
- **ABB analysis reports** (Markdown, from the editor; no controller needed):
  - **ABB: Compare Two Backups…** (also used by Compare Two Backups when both folders are ABB backups). Per task
    it lists modules added, removed and changed. Inside a changed module it shows the routines that changed,
    the data declarations that changed, and the robtargets that moved (with mm and re-orientation), then the
    SYSPAR files that changed. Re-indenting is not a change. Encrypted modules get one line per task.
  - **ABB RAPID: Unused Routines** for the open module's task (or a task picked from the backups). Calls from
    the shared modules and from the backup's HOME libraries count; `main`, connected TRAPs and late-bound
    string names count as used.
  - **ABB RAPID: Data & Signal Cross-Reference**: who writes and who reads every PERS/VAR and every I/O signal
    (found from the I/O instructions and functions). Findings: a PERS written from several modules, a VAR
    read but never written, a VAR never used, and a signal set from several modules.
- **ABB Actions**: an Actions card on the controller page and the same commands on a connected controller's
  right-click: **speed override** (5/10/25/50/75/100% or any), **motors on / off**, **RAPID start** (once or
  continuous), **stop**, **PP to Main**, **load a module** from the open editor or a file (uploaded to $HOME, then
  loaded), **unload a module** (also on a module's right-click), **set an output**, **write a RAPID variable**, and
  **Request / Release write access** beside the write access tag. Each asks first and says what will change;
  Stop does not ask. IRC5: write access is mastership of RAPID, configuration and motion, held until released.
  **OmniCore write access is in progress:** this PC registers as a remote control station with the id and PIN
  the controller allows (asked the first time, the PIN kept in secret storage), then asks for write access. That
  path is built and unit-tested but not yet checked on a controller with an allowed id and PIN, so on an OmniCore
  the Actions are refused (with the reason) until write access is granted. The RWS client keeps one connection
  open per controller and goes straight to it (not through VS Code's proxy): an IRC5 drops mastership when the
  connection that took it closes. Checked live on the RobotStudio IRC5 VC (every action, settings put back);
  `ROBOT_CODE_ABB_LIVE_ACTIONS=1` adds these checks to the live smoke test.

- **The open RUKUS cluster's ABB robots appear in ABB Controllers**, with their address, port,
  IRC5 / OmniCore and RWS user as RUKUS keeps them (`packages/abb/src/live/rukusCluster.ts`). They
  follow the cluster - opened, synced, or edited in RUKUS - and nothing is written to settings. A
  controller from RUKUS is edited and removed in RUKUS; the connection form and Remove say so.
  Their RWS password is copied into secret storage the first time, as FANUC FTP passwords are.
- **Encrypted RUKUS passwords are read.** A cluster with RUKUS's "Encrypt robot passwords" on keeps
  them as `dpapi:v1:...` (Windows DPAPI for the account that saved the file). `core/rukus/dpapi.ts`
  decrypts them through Windows PowerShell, for ABB RWS and FANUC FTP passwords alike. One another
  account encrypted cannot be read here and is left for the user to enter. Checked against a value
  RUKUS's own C# code encrypted, non-ASCII password included.
- The RUKUS Clusters view shows an ABB robot as ABB IRC5 / OmniCore with its port and identity.

- **Modules under each task** in ABB Controllers, program modules first. Click one to read its
  source from the controller into a read-only RAPID editor. It is one GET
  (`?resource=module-text`), nothing is saved on the controller, and the line numbers are the
  pointers' line numbers. If the workspace has no copy of the module a pointer names, clicking
  the pointer opens the controller's text.
- **ABB: Convert Target on Controller** (RAPID editor context menu, while a controller is
  connected). It turns the jointtarget under the cursor into a robtarget, or a robtarget into its
  joint solutions, using the controller's own kinematics (tool0, base frame). The solution in the
  robtarget's configuration is listed first. The result can be copied or inserted as a
  declaration under the line. These are calculations only: nothing moves and nothing is stored.

- **ABB: Back Up and Download** (right-click a connected controller). This takes the
  FlexPendant's backup into `$BACKUP/<name>` on the controller (RAPID keeps running), then
  downloads every file of it to a folder you pick. The copy on the controller can be kept, as
  the pendant would, or removed after the download. It is confirmed every time. The default name is `<system>_Backup_<date>_<time>`. An
  existing name on the controller or on the PC is refused before anything is written. The
  download is a normal IRC5 backup folder, so the RAPID view lists it. On the RobotStudio VC
  it took 1.1 s: 18 files, 36 requests. RW 6.16 only accepts the destination as a
  `/fileservice/$BACKUP/...` path.

- **A FANUC / ABB selector in Robot Connections.** ABB controllers are now added, edited, tested
  and connected in the same form as FANUC robots, not through three input boxes. The list shows
  both brands, each tagged, and **New controller** makes one of the brand that is selected. A new
  ABB controller starts at `192.168.125.1`, the service (programming) port on every IRC5 and
  OmniCore, as Default User. Test connection logs in, reads the system name and RobotWare, and
  logs out. The form has a Controller choice of IRC5 (RWS 1.0) or OmniCore (RWS 2.0). An
  OmniCore can be saved and its port checked, but it is not read yet. **ABB: Add Controller…**
  opens the form on the ABB tab, and **ABB: Edit Connection…** is in the controller's
  right-click menu. Core stays brand-free: a brand registers its tab through
  `core/live/connectionKinds.ts`.

- **ABB RAPID, behind `robotCode.abb.enabled` (off by default; reload after turning it on).**
  `.mod`, `.prg` and the `.sys` modules inside a RAPID backup layout open as ABB RAPID with
  highlighting and snippets always; with the setting on they also get an outline, go to
  definition across the task (a backup's `RAPID/TASKn` SYSMOD + PROGMOD, with `TASK0` as the
  shared modules), hover for RobotWare instructions, routines and robtargets (X/Y/Z, quaternion,
  configuration), completion, folding and diagnostics. RAPID modules and IRC5 backups join the
  workspace index. Files are opened as Latin-1, the way the controller writes them.
  Checked against 24 IRC5 backups (RobotWare 6.13, SpotWare): 1045 plain modules parse, 27080
  robtargets decode, no error diagnostics; `npm run smoke:abb` runs the providers in VS Code.
- **A RAPID section in the sidebar** (with the setting on). One row per IRC5 backup, named by
  robot, with its robot type and date (`2V04_V01AR11 - IRB 8700-630/3.50 LeanID - 23-09-16`, read
  from BACKINFO and SYSPAR). Under it the tasks by their controller name, the motion task first
  and open, TASK0 as "Shared", and the backup's HOME disk last, by subfolder. Under a task its
  modules - program modules, then system modules, then the encrypted ones, locked - each with
  its routine and point counts; under a module its routines, one click to the routine.
  Modules outside a backup group by folder.
- **Typing RAPID: argument hints and completion from ABB's manual.** Every RobotWare 6
  instruction, function and data type (from 3HAC050917, the RAPID Instructions, Functions and
  Data Types manual, by `scripts/import-rapid-manual.mjs`) with its syntax and arguments. While a
  call is being written the syntax shows with the current argument highlighted and described
  (the task's own PROCs and FUNCs too). Completion fits the spot: at the start of a statement
  the instructions, inserting their required arguments as placeholders (`MoveL ${1:ToPoint},
  ${2:Speed}, ${3:Zone}, ${4:Tool};`) and the task's routines; in an argument, the task's data
  of that argument's type first, then RobotWare's predefined ones (`v5` ... `vmax`, `fine`,
  `z0` ... `z200`, `tool0`, `wobj0`), then functions returning that type; after a `\` the
  instruction's optional arguments. Hover shows the manual's entry.
- **Enter in RAPID.** On a comment line, Enter starts the next line with `!` at the same indent;
  on an empty `!` line it does not, so two Enters leave comment mode. After PROC, IF ... THEN,
  FOR, WHILE, TEST and CASE the next line is one step in; END... lines step back out.
- **Format Document for RAPID, Visual Basic style, from the customer's base.** MODULE in column
  0, everything inside at `robotCode.rapid.format.baseIndent`, one `robotCode.rapid.format.indentSize`
  step per block (TEST/CASE and ERROR handlers laid out as the controller does), wrapped
  statements keep their continuation offset, only leading whitespace ever changes. Both settings
  are "auto" by default (what the file already uses) and can be set per workspace folder, so a
  customer's cell carries its own; the editor's tab size follows the step. Over the 924 plain
  modules of the IRC5 corpus it never changes code, is idempotent, and leaves 666 files untouched.
- **ABB controllers over Robot Web Services** (with the setting on). Add a controller
  (address, user; the password goes to VS Code's secret storage, never settings), Connect, and the
  section shows the controller's state (motors, AUTO/MANUAL, speed override, RAPID running or
  stopped), who it is (system name, RobotWare), each RAPID task with its program pointer and
  motion pointer (module, routine, line - click to open the module at that line when it is in
  the workspace), and the robot's joints and TCP. Open RAPID modules mark the pointer lines, with
  how old the reading is. Reads happen only when asked: Connect and Get read, nothing reads on
  a timer or a hover.
  The session is given back on Disconnect. Tested against a mock IRC5 that replays a real
  controller's RWS answers (RobotWare 6.16): 11 requests to connect, 9 per Get, 0 while idle.
- **Notepad++: ABB RAPID** next to FANUC TP and KAREL (`notepad++/`, regenerated for this version): colouring,
  folding (MODULE, PROC, FUNC, TRAP, RECORD, FOR, WHILE, TEST), Ctrl+Space completion with call tips for the
  RAPID functions, and the routines in the Function List. `install.ps1` / `uninstall.ps1` cover it too.

### Changed
- **RAPID indentation is yours to set.** `robotCode.rapid.format.indentSize` and `.baseIndent` take any number
  (1-16 / 0-16) or auto. The new `robotCode.rapid.format.insertSpaces` (auto / true / false) indents with tabs:
  one tab per indent size, leftover columns in spaces. A tab size or tabs/spaces picked in the status bar now
  sticks for that file, and Format follows it; the extension no longer resets it when you switch editors.
  **ABB RAPID: Set Indentation…** picks the size, base and tabs/spaces for one file or saves them for the workspace folder.
- The TP and KAREL editor checks moved out of the VS Code code into `tp/checks.ts` and `karel/checks.ts`, so
  the editor, Lint Folder and robot-lint share them. What they report in the editor is unchanged.

- **Core no longer imports FANUC code.** Program indexing, backup detection and usage findings go
  through a brand registry (`packages/core/src/brand.ts`); FANUC's sidebar sections, tools, live
  editor commands and status bar moved to `packages/fanuc`. No behaviour change for FANUC: the
  same 1663 checks and 161-check smoke pass before and after.

### Fixed
- **An ABB robot in a cluster was made a FANUC controller** (FTP, MD:) by the cell sync. The cell's
  controllers are the cluster's FANUC robots only; a file without `Make` is still all FANUC.
- **Send Cell to RUKUS could overwrite an ABB robot** with FTP settings when a cell controller had the
  same name. Only a FANUC robot of that name is updated now; an ABB one is left exactly as it was.

- RWS errors now show the controller's reason ("Position outside of reach", "Unresolved url"),
  not just the return code.
- A World-frame TCP read now works on RW 6.16, which spells the world frame `Word`.

## 26.109.5 - 2026-10-06 - KAREL reference in the editor; alarm codes

### Added
- **What each parameter is for** in the hover over a KAREL built-in (230 of 301 built-ins), with
  notes and related entries. The parameter hints while typing a call describe the current argument.
  `robotCode.karel.hoverDetail`: `verbose` (default) or `simple` (signature and one-line
  description, as before).
- **Hovers for the rest of the KAREL language**: translator directives (`%NOABORT`,
  `%STACKSIZE` ...), statements (`OPEN FILE`, `WAIT FOR`, `CONNECT TIMER` ...), data types,
  conditions, actions and clauses.
- **FANUC KAREL: KAREL Reference…** - any built-in, statement, directive or data type on its own
  page, searchable by name or purpose; every hover links to it.
- **`%ENVIRONMENT` check**: a built-in from iRVision (`CVIS`), robot-to-robot data transfer
  (`RPCC`) or data monitoring (`DAQ`) used without the directive is flagged - ktrans stops at
  "Id must be defined" without it (and without the option's .ev file in its support folder) - with a
  quick fix that adds it to the header. Picking such a built-in from completion adds it too.
  `robotCode.karel.diagnostics.environment`: `needed` (default), `all` (also a note for the groups
  ktrans loads by itself - REGOPE, SYSTEM, UIF ... - checked against KTRANS V9.40-1) or `off`.
- **Alarm codes** (10,524): hover over `SRVO-002` / `FILE-014` in a TP or KAREL program for the
  cause and remedy, and over the number a KAREL program uses for one (`POST_ERR(2014, ...)`,
  `IF status = 2014`). **FANUC: Look Up Alarm Code…** finds one by code or by words from its
  message. The alarm text ships beside the extension and is read on the first lookup.

### Changed
- 89 KAREL built-in signatures corrected: parameter names, and order where ours was wrong -
  `GET_REG(register_no, ...)`, `MODIFY_QUEUE(value, sequence_no, ...)`,
  `XML_ADDTAG(xml_file, tag_name, numchar, caseflag, tag_ident, status)`. Optional parameters are
  written `[group_no : INTEGER]` throughout.
- Hovers no longer cite where their text came from, and TP instruction hovers no longer show an
  example line.
- **Snapshot from Robot** is a Controllers action: right-click a connected robot in the
  Controllers view, or **Snapshot…** on the robot page. It offers **Initialize Robot Container…**
  when the controller has none.
- **Fetch** is one multi-select on the Snapshot view (TP/KAREL source, compiled programs,
  register & position data, I/O), replacing Fetch All / Fetch Programs / Fetch Data & I/O. The
  working copy is never touched.
- **Compare All with Robot** (was Fetch & Compare All) reads and compares, and writes nothing.
- **Get Controller Errors** is on the robot row of the Controllers view.

### Fixed
- Parameter names `file__var`, `attr__mask` and `term__char` in three KAREL signatures.
- Completion of a built-in with an optional parameter put a stray `[` in the inserted name.

## 26.109.4 - 2026-10-05 - Color themes, RUKUS skin themes; CALL list by installed options

### Added
- **26 color themes** next to Robot Code Dark / Light / High Contrast / Light High Contrast:
  - **Purple, Red, Blue and Green**, each as Dark and Light.
  - One Dark and one Light per **RUKUS skin** - RUKUS, Phanook Flakes, All-Berry Bites, Kooka
    Puffs, Ciao Crunch, Kowabunga Krispies, Halloween, Christmas and Pixel - in the skin's own
    backgrounds, text, accent and error / warning / success colors.
  The syntax colors are the same in every theme.
- `robotCode.tp.completion.fanucPrograms`: `installed` (default) or `all` - which FANUC-supplied
  programs the `CALL` / `RUN` name list offers.

### Changed
- The `CALL` / `RUN` name list offers a FANUC-supplied program only when the robot has the
  option that installs it, instead of all ~490 from every option. The robot's options are read
  from the robot when its file comes to the front (a program open from it, or in a container
  bound to it; again when you switch to another robot's file, at most once a minute per robot),
  else from the `orderfil.dat` of the backup folder the program is in. With neither, only the
  programs every controller has are offered. Your own programs are listed as before.

### Fixed
- The `CALL` / `RUN` name list showed a program once per backup holding it when the workspace
  had several backups. Each program is listed once now, from the copy nearest the file you edit.

## 26.109.3 - 2026-10-04 - Report an Issue; public repository; beta badge

### Added
- **Robot Code: Report an Issue** (command palette, and the Robots view's `...` menu) opens the
  bug report form on GitHub with the Robot Code, VS Code and OS versions already filled in.
- **Bug report and feature request forms** on the public repository, with a reminder to keep
  customer programs, plant names and IP addresses out of a public report.

### Changed
- The extension's home is now the public **Rukus-Team/RUKUS-Robotic-Extensions** repository: the
  Marketplace page links its issues and README, and every release there carries the `.vsix`.
- The Marketplace listing shows the **Preview** badge and "(Beta)" while Robot Code is in beta.
- README: install steps (Marketplace or `.vsix`) and a "Feedback & issues" section.

## 26.109.2 - 2026-10-03 - Long lists capped; UX leftovers (#3); Robot Code with Vim (#19)

### Added
- **The empty Registers view offers backups to load** with one click: ones taken out of the panel
  earlier, then the newest RUKUS backup of each robot.
- **Dashboard cards fold away and open again from their title** (chevron; Enter/Space from the
  keyboard); the choice is remembered.
- **Recoverable errors offer Retry and Open Output** - snapshot, download, listing, RUKUS sync,
  pull, restore and reading the position.
- **Long lists are capped and scroll.** The dashboard's Registers, Tasks and I/O cards and the
  Controller Options page show the first 10 / 50 / 100 / 250 / All (a **Show** picker under each list,
  remembered per list) inside a box that scrolls, with "Showing X of Y". In the Registers view a long
  group shows `robotCode.views.listLimit` entries (default 100) and a **Show more…** row.
- **`npm run smoke:vim`** runs Robot Code next to the Vim extension: a shortcut clash report and
  auto-renumber under real Vim keystrokes.

### Changed
- Shorter welcome texts in the Robots, RUKUS and Snapshot views.

### Fixed
- **With Vim, the line the cursor rests on is renumbered too.** After `o … Esc`, `dd` or `p` it was
  left unnumbered (or numbered twice) until the cursor moved; in Vim's Normal mode nobody is typing
  there.
- **Undo goes past a renumber.** An editor that ends its undo step after its own edit (Vim does) left
  the renumber as a step of its own: Undo took back only the renumber, which came straight back.
  Undo/Redo are no longer renumbered on top of, and an Undo of only the renumber continues to the
  edit that caused it. With Vim, map `u` / `Ctrl+R` to VS Code's undo (docs/KEYBOARD-AND-VIM.md).

## 26.109.1 - 2026-10-03 - Option syntax checked on real controllers; KAREL like ROBOGUIDE

FANUC only.

### Added
- **The option syntax was checked on two real controllers.** Every catalog line was loaded as its own
  one-line program on two V9.40 R-30iB Plus controllers in ROBOGUIDE (HandlingTool with iRCalibration,
  Palletizing, Line Tracking, iRPickTool, iRVision; SpotTool+ with Servo Gun, Force Control, Path
  Switching). The hover now says what the controller made of it:
  *✓ Verified on a FANUC controller (HandlingTool, V9.40 …): loaded as written*, or *… the controller
  stores it as `…`* where it writes the line differently, or *◐ Recognised … without the option
  installed*. 532 of 772 items carry a mark; an instruction a controller rejected carries none.
- **149 more option instructions and FANUC programs**, from manuals new to the catalog (Optional
  Function B-83284EN-2/12, Force Sensor B-83934EN/03, Arc Welding Function B-83284EN-3/05, PalletTool):
  TCP Photo Sensor Calibration (`UTool_Start[n]`, `Detect_Point[n] UFrame[-X]`, `UTool_End[..]`,
  `Update_Tool`), the Force Sensor programs (`FSSETHAND`, `FSSETCLB`, `FS_MOV_15DEG`, …), the PalletTool
  Data ID API (`PMCREATEUL`, `PMUPDATEULPATTERN`, …) and fieldbus/process utilities (`DV_ONLN`,
  `PR_ONLN`, `MI_EQ_PL`, `CLSKP`, `TWKSTCHK`, …).
- **CALL / RUN + Tab opens the program list** straight away (no `PROGRAM` placeholder to type over):
  the workspace's programs first, then the programs options install on the controller, searchable by
  name or by what they do.
- **"macro" + Tab** offers **Macro…**, which lists the macros alone: this robot's macro table
  (searchable by macro and by the program it runs), then the macros options install.
- **KAREL files use ROBOGUIDE's layout.** ROBOGUIDE puts real tab characters in a `.kl` and draws them
  7 spaces wide; VS Code drew them 4 wide and Tab typed 4 spaces, so ROBOGUIDE files looked shifted.
  Tab now inserts a tab and tabs are 7 wide; a file that mixes tabs and spaces is shown at the width it
  was written with (most other editors: 4). `robotCode.karel.detectTabWidth` turns that off.

### Changed
- **Pendant abbreviations are no longer offered as program syntax.** The controller rejects them and
  takes the full or underscore spelling: `UTool Start` → `UTool_Start`, `Calib Start` → `Calib_Start`,
  `Detect Point/Circle/Joint` → `Detect_Point/Circle/Joint`, `Update Frame` → `Update_Frame`,
  `END COND` → `END CONDITION`, `TRQ ERROR` → `TORQUE ERROR`, `GET DIAG DATA` → `GET DIAGNOSIS DATA`,
  `Soft Float[n]` → `SOFTFLOAT[n]`. Also corrected from the controllers: `IF PL[i]` compares with
  `[row,col,layer]`, a mixed-logic `IF` needs `,JMP`, `FORCE CTRL[n]` needs `ErrorLBL[n]`, servo-gun
  `SPOT[S=n]` / `TIPDRESS[TD=n]`, `BACKUP[B=OPEN]` (not `BACKUP=OPEN`). The corrections live in
  `data/tp-syntax-overrides.json`, each with what the controller did.
- **KAREL name length follows the controller version** (`robotCode.karel.coreVersion`, auto from the
  ktrans `robot.ini`): V6.40 allows 12 characters for every name, V7.x/V8.x 36 but 12 for the
  `PROGRAM` name, V9.x 36 for all. The fixed 12 flagged long names that compile clean on V9.40.

### Fixed
- **A double `;` at the end of a TP line is an error**, with a *Keep one ;* quick fix: the controller
  refuses to load such a program (ASBN-031).
- **KAREL `name FROM prog : type`** declares `name` - the `FROM` clause was read as part of the name
  (a false length warning on every such variable). `TYPE t FROM p = STRUCTURE` and a `TYPE`/`CONST`
  keyword with its first declaration on the same line are read too.
- **KAREL "used but never declared" works with `%INCLUDE`.** The include files are read from disk
  (relative to the source, then the ktrans support folder), as are the names ktrans predefines (its
  `.ev` environment files: `TSK_STATUS`, `ATR_IA`, `KY_PREV`, …). Before, any program with an include
  was skipped. A compiled `.pc` saved under a `.kl` name gets one note instead of block errors.
- **`!` in a TP condition is the logical NOT operator, not a remark.**
  `IF (!F[103:RecoveryEnabled]),JMP LBL[900]` coloured everything after the `!` as a comment. A
  line-level rule now treats `!` as a remark only when it opens the instruction body; inside an
  expression it is the `!` operator, and the rest of the line (`F[103:…]`, `JMP LBL[900]`) tokenises
  as before. Numbered and numberless bodies are both handled.
- **The robot's `Compare Program with Robot Copy` command is declared again.**
  `robotCode.live.compareWithRobot` was dropped from `contributes.commands` when the snapshot work
  and beta list 4 were merged, while a command-palette entry still referenced it - VS Code logged
  *"Menu item references a command … not defined in the 'commands' section"*. Declared it, and added
  it to the feature groups.

## 26.99.3 - 2026-10-01 - Push completes the sync; Notepad++ fixes

FANUC only.

### Added
- **A push finishes the sync: working copy = snapshot = robot.** The last step of an explicit
  **Upload Program** now pulls the controller's read-back into the working file, so all three match
  without a separate Compare. `robotCode.containers.pullAfterPush` chooses: `always` (default) overwrites the
  working file even when the controller's copy differs from what was sent - it usually will
  (DATE/MODIFIED, line numbers, variable labels), and the difference is reported with a **Show
  Diff** of sent ⟷ read-back; `when-identical` keeps your file on a difference; `never` leaves it
  alone. Live-edit saves never touch the working file. The push is now one phased progress
  (Uploading → Verifying → Syncing) with a completion message.

### Added
- **Syntax for the instructions that come with software options**, taken from the FANUC manuals
  (Basic and Optional Function operator's manuals, Line Tracking, iRPickTool, Coordinated Motion,
  iRVision 2D/3D, HandlingTool, SpotTool+, Servo Gun, ArcTool and the R-30iB Plus arc weld manuals,
  force sensor / 3DL / visual tracking / weld tip inspection, interference check and the option
  description pages): 629 instructions, motion options, operands, functions, option macros and
  FANUC-supplied programs. They are coloured, have a hover that names the option they need
  (e.g. *Requires option J512 Line Tracking*) and the manual it comes from, and are offered in
  completion. Examples: `LINE[1] ON`, `SETTRIG LNSCH[1] R[1]`, `STOP_TRACKING`, `Search Start[1] PR[2]`,
  `Touch Offset End`, `Weld Start[1,1]`, `Weave Sine[1]`, `MP Offset PR[1] RPM[1]`, `TIPDRESS[...]`,
  `SOFTFLOAT[1]`, `TORQ_LIMIT 20%`, `PALLETIZING-B_1`, `VISION GET_READING`, `FORCE CTRL[1]`, `MROT`,
  `CTV100`, `VIA(...)`, `Prompt Box Msg(...)`.
- **No more false "not found" notes for option syntax.** A bare option instruction (`Search End`,
  `STOP_TRACKING`, `STOP ALL ISDT` ...) is no longer taken for a macro call, an option's macro
  (`Prompt Box Msg`, `Status Menu` ...) is not reported as missing from sysmacro.va, and a CALL to
  one of 346 programs an option installs on the controller (`RGETNREG`, `GESNDDAT`, `BINPICK_SEARCH`,
  `VSTKGETQ`, `TW_UPDAT` ...) is not reported as missing from the workspace.
- **KAREL: the V9.40 built-ins.** 89 built-ins added (43 iRVision `V_*`/`VT_*`, 21 Data Transfer
  Between Robots `RGET_*`/`RSET_*`, DAQ and others) and 46 signatures corrected to the KAREL
  Reference Manual V9.40 (e.g. `CREATE_VAR`, `MOVE_FILE`, `VAR_INFO`; `APPROACH`/`ORIENT` return VECTOR).
- **Notepad++**: the option syntax is coloured there too (its own keyword group), and the KAREL
  call tips grow from 228 to 317 built-ins.
- **What options does this robot have?** Like RUKUS's Installed Options. The robot page has an
  **Options** card (press Get): the application and robot model, then whether the controller can
  load a .LS (Ascii Upload R507 / Ascii Program Loader R796), runs KAREL (R632), has PC Interface
  (R641) and Socket Messaging (R648). **Show Controller Options…** (robot right-click, the card's
  All options…, or the Command Palette) lists every option with a filter, Copy and Refresh. It
  reads `MD:ORDERFIL.DAT` from a connected robot, or works offline from the `orderfil.dat` in a
  backup folder.

### Changed
- **One look for every Robot Code page** (issue #3, 3a). The dashboard, robot form, register
  table, call graph, flow view and the tools reports share one stylesheet: the same buttons,
  inputs, tables, links and a visible keyboard focus outline.
- **One empty state** (3d): "Not connected" on the dashboard and "No controller data loaded" on
  the register table use the same centred title, explanation and action.
- **The register table works from the keyboard** (3b). ↓ from the filter goes into the list;
  ↑ ↓ Home End PgUp PgDn move; Enter copies the row's reference, Shift+Enter finds its uses;
  Esc goes back to the filter. The kind tabs are a proper tab list (← → between them), and
  screen readers are now told which tab is selected (it always said the first).

- **Notepad++: the installer sets up the Run menu, and `uninstall.ps1` takes everything out.**
  `install.ps1` now also copies `robotcode.js` and adds five **Robot Code: …** Run menu commands
  (Renumber lines, Renumber labels, Format /POS, Copy without positions, Check program;
  Ctrl+Alt+Shift+R / L / F / S / K) instead of leaving them to set up by hand. Notepad++ 8.9+
  asks once to confirm them (Run > Validate shortcuts.xml). Both scripts refuse to run while
  Notepad++ is open, since it rewrites its settings when it closes. Running the installer again
  updates in place.

### Fixed
- **A `!` in mixed logic is NOT, not a comment.** `DO[1]=(DI[1] AND !DI[2])` was coloured as a
  comment from the `!` on; a `!` starts a comment only where an instruction starts.
- **Multi-group position registers colour fully**: `PR[GP2:5,3]`.
- **Hover corrections**: `Track TAST[i]` / `Track AVC[i]` are arc seam tracking (they said line
  tracking); `VISION OVERRIDE` (the manual's token, not `OVERRIDE_PARAMS`); `TIPDRESS` and
  `Pressure[n]` as current software writes them; `RESUME_PROG[n:comment]=` / `MAINT_PROG[n]=`.
- **Running and paused programs are seen on V9.40 controllers.** Their task list writes an active
  task as `14 TOOL1MNT PAUSED @ 37 in TOOL1MNT of TOOL1MNT` (no `status =`), which was skipped: the
  robot page's Running card, the running-line marker and the push guard never saw a running or
  paused program. Both forms are read now.
- **A push checks the program is not running, paused or write-protected before sending.** It reads
  the task states itself (it used to rely on Get having been pressed on the robot page) and the
  program's protection from the copy it reads anyway, and stops with what to do on the pendant.
  When the controller still refuses, "program is in use" and "protection error" get their own
  hints, and the controller's newest alarm is shown as possibly unrelated (it often is).
- **A robot that cannot be reached says why.** Connect, the push's read of the robot's copy and a
  failed push now add the likely cause to the error, the same hints the robot form's Test button
  gives: no answer (check the IP / network / ping), port refused (is FTP or HTTP enabled on the
  controller), host name not found, the connection dropped mid-transfer, the web server refused
  the file, FTP login failed, the controller refused the upload (program selected or running,
  write-protected, or no Ascii Upload), or no such file on a read. When the controller reports
  its own alarm for a failed push, that is shown instead of a guess.
- **A push to a controller that cannot load a .LS says why.** A `.LS` only loads on a controller
  with Ascii Upload (R507) or Ascii Program Loader (R796); without either, the upload failed with
  nothing that said why. The push now reads the controller's option list (`MD:ORDERFIL.DAT`, once
  per session) and, when both are missing, stops before sending with a message naming them.
- **A brand-new program can be pushed.** The push gate reads the robot's copy first; a program
  the robot did not have yet came back as an error, so the push was held and a new program could
  never be uploaded. When the robot's file listing shows the program is not there, the push goes
  ahead, and the confirmation says it arrives as a NEW program instead of replacing one.
- **A clean push no longer reports "the controller's copy differs".** A V9.40 controller adds
  `LOCAL_REGISTERS = 0,0,0;` to a program sent without it; the round-trip compare now treats
  that line as the controller's default, so `pullAfterPush` `always` stays quiet and
  `when-identical` updates the working copy.
- **Notepad++: KAREL folding no longer drifts.** `END` was tried before `ENDIF`/`ENDFOR`/...,
  so every block closed and then reopened; a file ended several levels deep.
- **Notepad++: Ctrl+Space completion works in an installed Notepad++.** Notepad++ reads
  completion files only from its own program folder; `install.ps1` now copies them there
  (Windows asks for admin once; a portable Notepad++ needs none).
- **Notepad++: TP completion finds every word.** Two-word entries (`TIME AFTER`, `ARC START`)
  broke the sorted list and hid `UTOOL`, `UF`, `LBL` and others.

## 26.99.2 - 2026-09-30 - Snapshot sync (issue #12) on top of 26.99.1

The snapshot sync work (issue #12, PR #13) joins beta list 4. Its two entries below never
shipped on their own; both are part of this version. FANUC only.

### Changed
- **Fetch, pull and push are behind the experimental switch too.** Like every other command that
  talks to a controller since 26.99.1, the sync commands (and their editor, Explorer and view
  menus, and the fetch-on-open prompt) need `Robot Code › Experimental: Robot Connections`.
  Compare, revert, history and pull-to-working work on local files and stay on.
- **Remove from Backup Panel is on the Registers view's backup rows.** The Backup inventory it
  lived on became the Snapshot view; Show Removed Backups Again… is on the Registers title bar.

### Fixed
- **The smoke test cleans up its mock robot container.** Left behind in the reference backup, it
  made the next run's data views come up empty.

## (in 26.99.2) Snapshot sync: correctness, status bar, Explorer (2026-09-25)

Follow-ups on 26.91.24012 (issue #12), same branch.

### Fixed
- **A wedged controller web server no longer dead-ends the connection.** A FANUC controller's HTTP
  server can stop answering after a transfer is cut mid-flight: the TCP port still accepts (a port
  check says "open") but no HTTP byte ever arrives, while FTP on the same controller works. HTTP
  requests now have an absolute deadline (covering connect and a stalled response), so a probe
  fails in bounded time instead of hanging. When an HTTP robot cannot be reached but FTP answers,
  connecting offers **Switch to FTP & Connect**, and the status bar's "not answering" click offers
  the same - so the robot can be read over FTP without rebooting the controller.
- **Bulk reads keep one connection and close it cleanly.** A folder/snapshot fetch or a full
  compare now runs as the robot's only in-flight transfer, so the connection heartbeat and
  auto-refresh cannot open a second session on top of it (the overlap that helps wedge a
  single-session web server). Cancelling the progress bar aborts the request in flight (an
  `AbortSignal` threaded down to the socket) rather than leaving it hanging, and a request that
  never gets an answer fails on an absolute deadline.
- **No comment hint on a label-index register.** `JMP LBL[R[168]]` (an indirect label) is not a
  data reference to comment on, but the register hint ran on it. A `{comment}` hint is now skipped
  when the register is the argument of `LBL[` (`isIndirectLabelIndex`).
- **`robotCode.containers.gitAware` now does what it says.** It was documented in the setting,
  the walkthrough and the README, but no code read it. A confirmed push now checks the file with
  `git status --porcelain -- <file>` and adds a line plus an **Open Source Control** button to
  the confirmation. The check never blocks a push on its own.
- **`↓ robot changed` in the status bar can appear again.** The verbatim robot compare was stored
  under the robot root but read under the working file, so the lookup always missed.
- **"On robot, not in working folders" is no longer a dead node** - it lists its programs, and
  each can be pulled into a working folder.
- **Snapshot programs are always recognized.** The index now walks each container's `snapshot/`
  directory explicitly, instead of trusting `workspace.findFiles` to reach inside
  `.robocode-robot` (a `files.exclude`/`search.exclude`, an ignore file, or the file cap could
  hide it), and the status bar / tree read the snapshot copy from disk when the reference copy is
  not indexed. Before this, a fetched snapshot could sit on disk while the program still read
  "never fetched" / "not in snapshot" - the Snapshot view was a disk listing, the programs were
  not.
- **Snapshot view file rows match their working copy by program name or file name**, so a file
  whose stem is not its `/PROG` name is not mislabelled "on robot only" / "not in snapshot".
- **Controller files served in an `<XMP>` wrapper are unwrapped.** Some controller versions serve
  a text file as a bare `<XMP> … </XMP>`, and R-30iB firmware serves the program as `<PRE>` with
  an `<XMP> … </XMP>` inside it; the unwrap only peeled one container, so Pull, Fetch,
  snapshot-from-robot and the push read-back kept the two `<XMP>` lines. It now peels nested
  containers, finds the opening tag wherever it sits and runs on every text read (not only bodies
  that look like an HTML page), so the push gate no longer reads a clean program as changed.
  The `<XMP>` wrapper's own trailing newline is dropped too, so a fetch no longer gains a blank
  line after `/END`. Snapshots already fetched need one re-fetch.
- **The modified-vs-snapshot marker updates the moment a file is saved.** A save only queued a
  400 ms debounced re-read, so the status bar (and the tree and lens) could still read "✓ synced"
  after a saved edit until the next fetch. The saved buffer is indexed immediately now.
- **A snapshot marker no longer reads `✓` while the working copy was edited.** The compare picked
  the first reference copy of the program, and a container's `snapshot/` can hold a compiled
  `.tp`/`.pc` beside the `.ls`. The binary indexes with no text hash, so the guard treated it as
  identical and *every* edit - including a scaffolded blank line (`   :  ;`) - read "synced". The
  reference is now the same-kind source (falling back to disk when the index has only the binary),
  and a marker reads `✓` only when both hashes are known and equal.
- **Pushing a large program no longer times out.** A `STOR` used the flat 10 s control timeout for
  both the data socket and the completion reply, but a FANUC controller compiles the `.LS` into
  `.TP` as it receives it and can leave both sockets quiet far longer than that - a ~150 KB push
  (`dose_pg21_r1.ls`) failed every time. A data transfer, and the compile after a write, now wait
  `transferTimeout(size)` - never less than 30 s, plus 250 ms/KiB, capped at 5 min - while command
  replies keep the 10 s control timeout. Reads use the 30 s floor as well.
- **A scaffolded new line lines up with the other lines.** The blank prefix was as wide as the
  largest line number's digit count, so in a short program inserting after `  25:` produced `  :`
  - three columns left of the `  25:` it belonged under. The prefix is now the number field: the
  configured `tp.lineNumberWidth` (default 4) or the widest number, whichever is wider. So the
  same insert now gives `    :`, and `    :   ;` for a blank line with terminators on.
- **A line with no number is a normal instruction line.** The scaffold, and the `spaces`/`none`
  numberless styles, write `    :  R[1]=1 ;`; the parser filed those under a separate
  `'unnumbered'` kind, so hover, IF/FOR/ENDIF block matching, folding, macro detection and
  scaffolded `LBL[...]` definitions silently skipped them until a renumber. A `:`-prefixed line
  with no number now parses as the instruction it is (`num` stays undefined, the count uses
  `seq`), so those work while you type as well as after a renumber.
- **"Compare with Snapshot" no longer diffs a program against its compiled bytecode.** A container
  snapshot holds both the editable `.ls` and the controller's compiled `.tp`; the compare could
  pick the `.tp` as the snapshot side and render its bytes (`þï…`). Comparisons are now
  representation-matched - source vs source (normalized) or compiled vs compiled (a byte boolean,
  on demand) - a compiled copy is never read or normalized as text, and a program with no editable
  source shows an honest `compiled only` state instead. A fetch of either representation also
  pulls its partner (`.ls ↔ .tp`, `.kl ↔ .pc`) into the snapshot so the pair stays together, and a
  pull still writes back only the targeted representation.
- **The scaffold's leading `:` is coloured like a numbered line's.** The numberless/scaffold line
  carries `punctuation.separator.continuation.tp`, a different scope from a numbered line's
  `punctuation.separator.line-number.tp`, and no bundled theme painted it - so the `:` read as
  plain text beside the dim `   1:`. The four colour themes now give it the line-number colour, so
  the scaffold, numberless and circular-continuation `:` all match the numbered lines.
### Changed
- **One "Robot Code" entry in the Explorer and editor right-click menus.** The robot actions
  (download, the Snapshot & Robot file actions, folder fetch/pull, snapshot from backup/robot,
  Diff Backups, FANUC TP) used to sit as separate top-level items scattered among VS Code's own
  menu groups. They now live under a single **Robot Code** submenu, still grouped by separators
  inside, and shown only when relevant to the clicked resource.
- **In-line hints are wrapped in `{ }` and muted, so they never read as code.** The controller
  comment, the live value and the frame label are all editor-drawn, so each is now `R[15]{Speed}`,
  `R[151]{2}`, `P[1]{JNT}{UF1}{UT2}` - braces, flush against the token, in a muted colour
  (new `robotCode.hintComment`, `hintStateOn/Off`, `hintValue`, `hintString`, `hintSim`,
  `hintStale` and `hintFrameJoint/Cart/Other` theme tokens; `workbench.colorCustomizations` can
  retune them). They are **decorations, not inlay hints**, so no theme's inlay-hint background can
  tint them and the controller comment follows the hover's **Insert it** link instead of a
  backgrounded click target. A name written in code (`R[15:Speed]`) is part of the variable now -
  upright, the index colour - not a comment. New `robotCode.tp.inlineHints` (on by default) turns
  all line hints off at once.
- **The sync item names the file's type, and its tooltip speaks plainly.** The status bar's open-file
  item is now `[LS] NAME (✓) age` (the extension in brackets), and its tooltip spells the state out
  in words instead of a `✓ ↑ ↓ ↕ ?` legend and an amber/red note - it lists what the file is (TP
  program / KAREL source / data, with lines, labels, positions and the program comment), the
  snapshot (date and last fetch), the robot the file belongs to (and its controller), and the
  controller's compare result.
- **The connected glyph now means "answering now".** While a robot is connected the extension
  re-probes it every `robotCode.live.heartbeatSeconds` (default 10, `0` = off) with the same
  cheapest request connecting uses - a static web page over HTTP, or a bare FTP login, never a
  generated `.DG` file. If the heartbeat gets no answer the status bar shows a red slashed circle
  with the last-check age instead of a green one, so a dropped link is visible without waiting for
  a read to fail. Off (0) restores the strict "never contacts the controller on its own" behaviour.
- **The editor tab uses git icons and one Compare command.** Fetch / Pull / Push are now
  `repo-fetch` / `repo-pull` / `repo-push`, Compare is `git-compare`, and a History button joins
  them; Show Program Flow is `list-tree` instead of a merge glyph. The tab's Push button appears
  only when there is something to send (`robotCode.syncPushable`: a local difference or a program
  the snapshot has never seen) - the right-click menus still show every action. Our buttons are
  ordered (Revert) Fetch Pull (Push) Compare History Flowchart and packed tight, so the Git
  extension's own **Open Changes** button sits to their right instead of interleaving with them.
  The tab, status-bar click and tree inline action all run `robotCode.sync.compareFile` now;
  `sync.diffOpen` and `containers.diffWithSnapshot` are its internals and are hidden from the
  palette. The snapshot CodeLens was removed and Compare always opens the diff, identical or not.
- **Sync operations on one robot no longer interleave.** A Fetch pressed a moment before a Pull
  ran two reads and two progress UIs at once. Single-file fetches now coalesce (a second fetch of
  the same file reuses the one in flight), and the fetch/pull/push/revert/compare operations are
  serialised per container, so the second waits for the first.
- **A push now ends with workspace = snapshot = robot.** The read-back is verified with a
  metadata-insensitive compare - the controller always re-stamps `CREATE`/`MODIFIED` and recomputes
  `PROG_SIZE`/`MEMORY_SIZE`, so a clean upload used to be reported as "read back differs (2 lines)"
  and left a `DATE`-only diff against the snapshot. On an explicit push the controller's read-back
  is written back into the working file (the same undoable pull as `Pull`), so the marker reads
  `(✓)` and "Compare with Snapshot" shows nothing. A real controller-side difference is still
  reported, and then the working copy is left untouched so the diff can be seen. Live edit does not
  pull: there the editor is the source.
- **The robot status follows the focused file's container** as one cell: a connection glyph
  (`$(circle-filled)` green / `$(circle-outline)` grey / `$(error)` red / running) with the robot
  name beside it. The separate left-hand running-program item is gone. Click connects when offline
  (retries after a failure), opens the Controllers view when connected, and reveals the line when
  running; the tooltip has host, device, active UF/UT and payload.
- **The sync item uses git-shaped symbols**, bracketed and tinted by context: `NAME · (✓) age`
  when the working copy matches the snapshot (plain); `(↑n)` amber for local changes to push;
  `(↓n)` amber when the robot changed since the snapshot; `(↕)` red when both diverged; `(?)`
  plain when the file is not in the snapshot. A middot separates the name from the status; the
  counts, words and legend are in the tooltip.
- **Tree rows use git-shaped markers too, and amber only for a snapshot diff**: the kind colours
  (amber TP / blue PC / teal macro) are gone from the tree icons, which are neutral; a program
  whose working copy differs from its snapshot gets the amber marker, like a modified file in git.
- The per-robot **Sync** view (`robotCode.syncStatus`) was **folded into Programs and retired**:
  program rows carry the git-shaped marker and the robot-compare state, robot rows carry the
  `n/n synced` summary, and **Fetch & Compare All** moved to the Programs toolbar and the
  robot-folder context menu. The robot side is only known after that deliberate read, so a row
  says "robot not compared" until then.
- **`Fetch All` is in the Snapshot robot row's context menu** (it was only an inline icon).
- **File Explorer actions**: right-click a `.ls/.kl/.tp/.pc/.va/.sv/.dg/.dt/.io` file (or a
  folder) for the **Snapshot & Robot** submenu and the scope fetches, in a container workspace.
- **The editor tab is trimmed to the robot actions that belong to the open file**: Fetch, Pull,
  Push, Compare, a conditional Revert, Show Program Flow, the Karel Check/Compile pair, and
  Download on a `fanuc://` file. Renumber, Show Call Graph and Live Edit leave the tab (the first
  two are already in the FANUC TP right-click submenu; live edit keeps its shortcut, palette
  entry and status-bar toggle). Renumber/call-graph/live-edit are unchanged everywhere else.
- **Compare with Snapshot** (was "Compare with Robot"): it diffs the working copy against the
  snapshot - normalized for programs, verbatim for data - and, when the file's own robot is
  connected, offers **Update & Compare** first so the diff is against what the controller holds
  now. With no robot it compares against the snapshot on disk.
- **Files bind to the robot of their own container.** Fetch, Pull, Push, Compare, Revert, Teach
  Position, Record Position and Live Edit read the file's robot from its container's `controller`
  (or the `fanuc://` authority) and connect it as needed, so a container file no longer asks
  which robot. A container bound to a controller with no matching profile is refused rather than
  silently aimed at another robot; only a file in no container falls back to the picker. Fetch
  and Pull stay container-only (they need a snapshot); Push outside a container still prompts.

### Added
- **Choose which position badges show** (`robotCode.tp.decorations.positionFields`, default all
  three): after `P[n]` the hint draws one `{ }` per selected piece - `{JNT}`/`{XYZ}` (the
  representation), `{UFn}` (user frame) and `{UTn}` (user tool) - in that order. Narrow it to just
  the type, just the frames, or leave it empty for none.
- **A conditional Revert (discard) button on the editor tab**: `$(discard)` appears only when the
  open container file's saved copy differs from its snapshot, and restores it (modal-confirmed,
  one Ctrl+Z) - the git-shaped "discard changes" version of the row action that was already there.
- **Pull into Working Folder…** (`robotCode.sync.pullToWorking`): copy a snapshot-only program
  into a declared working folder - the snapshot itself is never edited.
- **`robotCode.sync.diffOpen`**, the status bar's click, which diffs indexed programs normalized
  and data files verbatim.
- **A snapshot-history browser**: `Snapshot History…` lists a file's kept versions (newest first)
  and offers **Diff against the working copy**, **Open this version**, and **Restore into the
  working copy…** (one Ctrl+Z).
- **Position and register diffs against the snapshot**: `Compare Positions with Snapshot…`
  reuses the position-diff engine (moved/added/removed/reframed per point), and
  `Compare Registers with Snapshot…` reports changed/added/removed numeric registers in a
  `numreg.va`. Both open a Markdown report beside the editor.
- **Keybindings for the position tools** that had none: `Ctrl+Alt+Shift+O` offset,
  `Ctrl+Alt+Shift+H` mirror, `Ctrl+Alt+Shift+C` convert frame, `Ctrl+Alt+Shift+P` clean up unused
  positions, `Ctrl+Alt+Shift+S` compare positions with the snapshot.
- **`aria-label`s on the webview controls** (dashboard, robot form, register table, flow view),
  so a screen reader hears "read registers" rather than a bare "Get". The RUKUS-not-found welcome
  message is shorter, and `docs/KEYBOARD-AND-VIM.md` lists the new keys.
- **Fetch / pull a whole folder from the robot** (`robotCode.sync.fetchFolder`,
  `robotCode.sync.pullFolder`): right-click a folder in the Explorer (or a robot folder / snapshot
  scope / snapshot sub-folder in the Robot Code views) to read everything at or under it off the
  controller. **Fetch** updates the snapshot only; **Pull** updates the snapshot, then overwrites
  the matching working files (open files undo with Ctrl+Z). Only files the controller actually has
  and that are under the chosen folder are touched, and a compiled `.tp`/`.pc` is never written
  back as text. A cancellable progress bar names each file as it lands, and the final counts go to
  the status bar and the Robot Code output.
- **Fetch on open** (`robotCode.sync.promptOnOpen`, default on): opening a program that belongs to
  a robot container connects that program's robot and offers to fetch the newest copy into the
  snapshot (the working copy is never touched). Asking is once per file per session and is muted
  for 5 minutes after the container's snapshot was last fetched, so a burst of opens is not a
  burst of prompts; the prompt offers **Don't Ask Again**. Off by default in the test harnesses.

## (in 26.99.2) 26.91.24012 - 2026-09-24 - Snapshot UX: git-shaped sync

The snapshot becomes the robot's **index**: the last known state every working copy is compared
against, in a mental model borrowed from git - working folders are the working tree, the snapshot
is the index, backups are remote history, and the controller is the remote. The north star is
keeping the offline working copy synced with the robot so a pendant edit is never silently
overwritten. Design: `docs/design-snapshot-ux.md`; issue #12.

### Added
- **Fetch / Pull / Push / Compare / Revert**, under `robotCode.sync.*` and the editor tab,
  context menu ("Snapshot & Robot") and command palette. Fetch reads the open file from the
  robot into the snapshot; Pull then overwrites the working copy (one Ctrl+Z); Push is the one
  write; Revert restores from the snapshot. The old `Get Fresh Copy`, `Download and Replace`,
  `Upload Program` and `Compare with Robot` are replaced by these.
- **The push gate is verbatim.** Before a push the robot's copy is compared to the snapshot
  with nothing stripped - line numbers, terminators and metadata all count. Any difference
  means the program changed on the pendant and was never fetched, so the push is **refused**
  until you `Update Snapshot from Robot` (or look at the diff) and push again. Metadata-only
  differences still block but are labelled. `robotCode.containers.guardUpload` (default on).
- **Post-push verification.** After a successful push the program is read back, the snapshot is
  set to exactly what the controller now holds, and the message says whether the sent text
  survived the round trip - catching a controller-side mistranslation.
- **Snapshot history** (`.robocode-robot/snapshot-history/<stamp>/`): the copy a fetch replaced
  is kept, so a captured pendant edit stays recoverable after the next push.
  `robotCode.containers.snapshotHistory` (default 50 stamps, 0 = keep everything).
- **A per-file age map** in `snapshot.json` (`files`, plus `updatedAt`), written for every file
  when a snapshot is taken and updated on each fetch, so the tree and status bar can show a
  file's real age.
- **The Snapshot view** replaces the read-only **Backup** view (`robotCode.snapshot`): one row
  per robot container with its date, modified count and "on robot only" count; scope groups
  (Programs, Data & I/O) above and a raw mirror of `snapshot/` below; every file with its age
  and `=`/`≠` state; row actions Fetch, Pull, Compare, Revert, History. A workspace with no
  container sees a welcome offering **Initialize Robot Container…**.
- **A sync status bar item** for the open working file: its name, snapshot age, and state
  (`✓ synced` / `modified +N` / `not in snapshot`, with `↓ robot changed` once compared). The
  connection and snapshot now share one item; the TP lines/labels/positions item is gone.
- **Push failure reporting**: over HTTP the controller's current errors (`ERRCURR.LS`, falling
  back to `ERRALL.LS`) are read automatically; with RUKUS installed the Error Watcher is
  offered. `robotCode.sync.errors` reads them on demand.
- **`robotCode.containers.gitAware`** (default off): on a push, mention uncommitted changes in
  your own git repository and offer Source Control. Taught in a new walkthrough step.

### Changed
- The sidebar's **Backup** section is **Snapshot**; it lists robot containers (the previous
  dataset inventory is superseded). **Add Backup Folder** and **Compare Two Backups** remain
  for a workspace without containers.

### Notes
- Container-scoped: the sync commands bind a robot to its `.robocode-robot` marker, never to
  `robotCode.robots` settings. The move of cells and clusters fully onto containers is a
  follow-up (see `docs/ux-audit.md`).
## 26.99.1 - 2026-09-28 - Robot connections become experimental; beta list 4

FANUC only. Numbers refer to the items in Sam's beta list 4.

### Changed
- **Talking to a robot is an experimental feature, off by default.** Tick
  `Robot Code › Experimental: Robot Connections` to get the Controllers view, connect/read over
  FTP or HTTP, teach and record from the current position, snapshot from robot, download a backup,
  upload and live edit. Off, those commands are hidden and nothing is sent to a controller - every
  request path refuses at one gate, auto-connect is skipped, and unticking it ends open sessions.
  Backups, the editors, diagnostics, reports and RUKUS clusters need no setting.
- **(2, 4) A new window starts with no backup folders.** Backup folders are read from the
  workspace's settings only, so opening a folder shows that folder's backups and nothing else. A
  list in user settings (which every window used to inherit) is ignored and said once in Output.
  In a window with no folder, Add Controller Backup Folder keeps its list while the window is open.

### Added
- **(1) Remove from Backup Panel** on a backup row (the × or right-click): an added folder comes
  off the list, a backup inside the workspace is hidden with its programs. Nothing on disk is
  touched; Show Removed Backups Again… on the panel's title bar puts it back.
- **(3) A cell set up without RUKUS goes to RUKUS later.** Initialize Cell Container… offers to
  create the cluster in RUKUS when RUKUS is installed, and otherwise remembers the cell; when RUKUS
  turns up, the next window offers to send the remembered cells as clusters.
- **(8) Set / Add Axis Values on Positions…** - e.g. `E1=0` on P[1-9]: axes a position has are
  overwritten, a missing E1-E3 is added in the controller's layout (asks mm or deg once). The
  position pickers (this and Offset Positions) take numbers and ranges: `1-9, 12`.

- **(9) Notepad++ support** (not in the vsix; `notepad++/`, zipped as
  `robot-code-notepadpp-<version>.zip` by `npm run notepadpp`): FANUC TP and KAREL colouring and
  folding, word completion with KAREL call tips, Function List (TP labels, KAREL routines), an
  install script, and `robotcode.js` - renumber, label renumber, `/POS` format, strip positions and
  a check - from the same code as the extension, for Notepad++'s Run menu (needs Node.js).

### Fixed
- **(10) Find All References on `DO[12]`** (any register or I/O) lists every program in the
  robot's folder, not only the open one - including a folder opened from outside the workspace.

## 26.92.25015 - 2026-09-25 - Position values and offsets written in the controller's layout

Issue #15. Numbers refer to the items in "RUKUS VS Code Extension - Beta Issues (List 3)".

### Fixed
- **(1) Position values are written the controller's way.** Every value the extension writes into
  `/POS` is a float with three decimals, right-aligned in the controller's ten-character field:
  `J1=     0.000 deg`, `X =   261.855  mm`, zero as `0.000`, `-.098` without the leading zero.
  New blocks (Record Position, rewrite as joint/XYZWPR) no longer copy the style of the file's
  first block, which passed a hand-typed `J1= 0 deg` on to every block added after it; teaching,
  offsetting or converting into a slot typed as an integer writes the controller's layout too.
  Format Document now also lays out `/POS`: integers become floats, values with fewer than three
  decimals are filled out (never rounded), and every row is aligned. A file the controller wrote
  is left byte-for-byte alone (checked over 58 controller files). An axis value written as a bare
  integer gets a warning, `tp.integerAxisValue`, whose quick fix formats the section.

### Notes
- **(2) Shifting positions is already there:** Offset Positions… in the TP editor's right-click
  menu shifts selected points by X/Y/Z/W/P/R, J or E amounts in each point's own user frame.
- **(3) Kinematics:** researched, not built. Where each brand keeps its model, and the suggested
  order to build it, are in `docs/KINEMATICS.md`.

## Unreleased - Sam's beta list 2 (started 2026-09-22)

Local only. Numbers refer to the items in "RUKUS VS Code Extension - Beta Issues (List 2)".

### Changed
- **(4) Version ids, second form - one shape for RUKUS and the extension.** A working build is
  `YY.MT.DDIII`: `26.91.21010` is September, type 1 (feature), started the 21st, issue #10. A
  release is `YY.M9.N`: `26.99.1` is September's first release. The type digit moved from RUKUS's
  fourth number into the second, so both products carry it in three numbers that all fit
  Windows' 65535 cap; type 9 puts a release above every working build of its month and below
  next month's. `npm run version:id` takes `--type` (or reads the branch prefix) and `--release`;
  `--decode` reads the new, the first (`26.9.21010`, `26.9.13026.1`) and the older forms. The
  release guard knows a release blocks the rest of its month. Walkthrough: `docs/VERSIONING.md`.
  This build is re-stamped `26.91.21010` (was `26.9.21010`).

### Added
- **RUKUS's write lock holds here, and every upload is in RUKUS's audit log.** A robot marked
  write-locked in RUKUS takes nothing from Upload Program or Live Edit, and the refusal is
  recorded. Every upload, sent or failed, appends a line to RUKUS's `WriteAuditLog.jsonl` in
  RUKUS's own record shape, so writes to a controller from either program are one record.
- **A link into the editor.** RUKUS's Cluster menu gains "Open Cluster in Robot Code", a
  `vscode://rukus-team.robot-code/cluster?name=<cluster>` link that makes the cluster the
  workspace, the same as clicking it in the RUKUS Clusters view; `/sync` re-reads the open cell.
  The extension wakes on a link (`onUri`) and only ever opens or re-reads from one.
- **Snapshot from Latest by default.** In a cluster workspace, Snapshot from Backup offers the
  robot's Latest backup outright; the list of other backups is one click further.
- **A fresh backup says so.** When RUKUS or its scheduler finishes a backup into the open
  cluster's Latest, the status bar says which robot landed and how many files, and the cell is
  re-read.
- **(3) Live edit on the robot** - the nearest thing to ABB's hot edit a FANUC controller
  allows from outside. **Ctrl+Alt+Shift+E** pairs the open program with a connected robot
  (one question, once); from then on **every save is sent** to the robot and replaces the
  program there, read back, and reported in the status bar. A `LIVE → S002R01` status bar item
  shows the pairing and stops it on click; disconnecting stops it too. What it cannot do, and
  says so: change a line of a program while the controller runs it - the controller refuses an
  upload of a selected or running program, so a save then is reported and not applied. Needs
  `robotCode.live.upload` on.
- **(8) Combine Programs…** (Ctrl+Alt+Shift+M, also on the Programs view): pick programs one
  at a time - the order picked is the order in the result - then a name. The parts follow each
  other under `!--- NAME ---` banners in one new program written next to the first, with
  labels renumbered in tens and positions carried on so nothing collides, every reference
  following, `/POS` blocks copied byte-for-byte. `END` inside a part is warned about;
  different DEFAULT_GROUP masks are refused. The originals are untouched.
- **(10) KAREL lint and Check Before Compile.** The Problems view now shows, before ktrans
  runs, what it will refuse and what it lets through: C-isms (`==`, `!=`, `&&`, `||`, `:=`,
  `++`, `//`, `ELSE IF`/`ELSEIF`), CONST/TYPE/VAR/ROUTINE after BEGIN, a directive after the
  declarations or inside a body, strings over 254 and `STRING[n]` outside 1..254, integers past
  32 bits, reserved words as names, a name declared twice in one scope, assignment to a
  constant, a call to a routine declared here with the wrong number of arguments, `RETURN`
  without a value in a function or with one in a procedure, a function that never returns a
  value, `MOVE` under `%NOLOCKGROUP`, and - as a hint - a program with no motion that could say
  `%NOLOCKGROUP`. `%COMMENT` past 16 characters is a warning (ktrans takes it; the pendant shows
  16). **Check Before Compile** (Ctrl+Alt+Shift+K) runs it with the one check that needs the
  disk - every `%INCLUDE` must exist - and gives a verdict, offering ktrans when clean. Rules
  are switched off by code in `robotCode.karel.diagnostics.lintIgnore`; the whole lint by
  `robotCode.karel.diagnostics.lint`. Measured against the 623 KAREL sources in the corpus:
  no rule reports an error on a program a controller ran. Two rules deliberately stand down
  on a `ROUTINE` line without its parameter list on that line, or declared `FROM` another
  program - the corpus has both spelled in ways the truth is elsewhere.
- **(11) KAREL hovers** for built-ins are laid out like the TP ones: a title saying statement
  or built-in (WRITE is a statement, not a routine), the signature as code with one parameter
  per line when there are several, the description as its own paragraph, the return type
  named. The old one ran the signature and the text together on one line.
- **(1, 5) RUKUS's clusters are the cells.** A new **RUKUS Clusters** view, first in the sidebar,
  lists the clusters straight out of RUKUS's data folder (`Documents\RUKUS\Clusters\*.json`, or a
  portable RUKUS's folder from its `RUKUS.portable` marker, or `robotCode.rukus.dataFolder`).
  **Click a cluster and it becomes the workspace**: its backup folder in RUKUS's store
  (`<backups root>\<cluster>`) is opened as the one workspace folder, and the cluster's robots
  are written into that folder's `.robocode-cell\cell.json` (name, address, FTP user, device),
  so the Controllers view has them and the Programs view shows the backups Latest first. Click
  another cluster and the workspace switches to it. RUKUS's files are watched: a robot added or
  changed in RUKUS reaches the open cell without a step; **Sync from RUKUS** does it on demand.
  FTP passwords, which RUKUS keeps in clear in the cluster file, are copied once into VS Code's
  secret storage when none is stored - never into cell.json. **Send Cell to RUKUS** goes the
  other way: the open cell's controllers into the cluster file, keeping every RUKUS-only field
  (KCL, passwords, notes, write lock) and never deleting a robot; RUKUS's own safety copy is made
  first. RUKUS is the store of record; the Initialize Cell Container wizard stays for a PC
  without RUKUS, and the view says so when RUKUS is not there.
  **Naming follows RUKUS (5):** the robot-folder template RUKUS is set to
  (`BackupRobotFolderTemplate` in its AppSettings) is what the wizard, the Backup view and the
  robot-name lookup read folder names with - any template, not just the two built-in presets -
  and **Download Backup from Robot** files its backup where RUKUS would: the robot's own archive
  `<cluster>\<robot>\<batch>\` named by RUKUS's batch template, with RUKUS's `rukus-backup.json`
  manifest inside, so RUKUS lists it as one of its own. Never into `Latest`, which is RUKUS's to
  rotate. The template resolver is checked against the cases in RUKUS's own
  `BackupNamingHelperTests`, so both sides produce the same names.
- **(2) Latest backup first.** The Programs, PC programs and Backup views list robot folders
  in backup-store order: RUKUS's `Latest` copies first, then the dated backups newest first
  (the date read from the robot folder's name in either preset, or from the batch folder above
  it), then anything undated by name. Each robot row says `· Latest` or its date. The new filter
  button on those views (`robotCode.views.latestBackupsOnly`) hides the dated copies and shows
  only Latest - and shows everything again in a workspace that has no Latest folder, so it can
  never empty the view.
- **(6) Fast download / upload of the open program, PG21-style.** In a local `.ls` with a robot
  connected: **Ctrl+Alt+Shift+D** downloads the robot's copy and replaces the local file in one
  go (the old text is kept in the history folder, and Ctrl+Z brings it back); **Ctrl+Alt+Shift+C**
  is "download and compare" - the existing Get Fresh Copy, which reads to a dated file and opens
  the diff before anything is replaced; **Ctrl+Alt+Shift+U** uploads. Upload is the first and
  only command that writes to a controller: the file goes over FTP (`STOR`) to the robot's
  device, the controller compiles it as it lands. It is guarded: the modal names robot, host,
  device and program and says what is replaced; a program the robot reports as running or paused
  is refused before anything is sent; every upload is logged in the Robots output; the program is
  read back once and the message says whether it came back identical. `robotCode.live.upload`
  (on) hides it. The mock robot in `npm run mock` takes `STOR` too, and refuses the running
  program with a 550, the way a controller does.
- **(9) Enter keeps you in the comment.** Enter at the end of a `!comment` line gives the next
  line as `  N:  ! ;` with the caret after the `!`; Enter at the end of an `--eg:` extended
  comment (or one of its `:` lines) gives a fresh `    :   ;` continuation and moves the ` ;` down
  onto it. Enter on a comment with nothing in it ends the run, so two Enters get you out. It
  reacts to the document changing, so Vim's `o` does the same as Enter. Off with
  `robotCode.tp.continueComments`.
- **(7) Extended comments at the pendant's width.** The renumber (and so auto-renumber, once
  the caret leaves the comment) re-wraps an `--eg:` comment with a line wider than **78
  columns** between words, the way the pendant's comment editor does: 65 characters after
  `--eg: ` on the first line, 71 after `:  ` on every continuation, the ` ;` on the last. A
  comment that grows takes more `:` lines, one that shrinks gives its spare lines back. A line
  over the width is underlined until then. `robotCode.tp.extendedCommentWidth` (0 = off).
  The number is measured, not from the manual: a ROBOGUIDE controller's own EXITZONE.LS, whose
  widest pendant-written line is exactly 78 and wraps wherever one more word would pass it. The
  list said 68; nothing on that controller wraps at 68, so it was not used. A comment the
  pendant wrote is never rewritten, and the controller loads wider lines without complaint
  (`test/fixtures-extended-comment.ls` has a 163-character one) - this is about what the
  pendant will show, not what the controller accepts.

## 26.91.21010 - 2026-09-21 - Sam's beta list (issue #10, 15 items)

Stamped `26.9.21010` on the 21st under the first form of the version id; re-stamped
`26.91.21010` on the 22nd when the type digit moved into the second number (see docs/VERSIONING.md).
Same work, same issue, same start day.

Issue #10, started 21 September. Local only so far: built and installed, not pushed or released.
It sits on the combined branch, so it also carries the containers work that was 26.9.2.

### Fixed
- **"Cartesian · UF2/UT2" written all over `/POS`** when a program was read from a controller
  (after `P[n]{`, after `GP1:`, inside `X = 914.9 … 96`). The parse cache was keyed by uri and
  document version, and a document that is closed and opened again starts over at version 1 -
  so a program re-read from the robot (or pulled over a closed file) was decorated at the line
  numbers of the text it USED to have. The entry is now dropped when the document closes, the
  line count and length are checked as well, and the label refuses to draw unless the text under
  it is the `P[` it was parsed from.
- **`PR[5:home:home]`**: a `J PR[5]` target is a motion target and a data reference, and two
  passes of the inlay-hint provider each drew its comment. One pass now.
- **Completing inside a bracket left `PR[1:home]]`** (the `]` the editor auto-closes was kept)
  and, when the index of an existing reference was retyped, `PR[2:pounce]:home]`. What is right
  of the caret up to the first `]` is replaced along with the rest.
- **Typing `PR` and taking the first suggestion wrote `PR[1,1]=0`.** The list was sorted by
  label, and a comma sorts before a bracket. It is now in table order, plainest first: `PR[]`,
  `PR[]=`, `PR[]=LPOS`, `PR[,]=`. Same for `R`.
- **A PR that no program assigns was reported as "read here but never written".** A position
  register is normally taught on the pendant, like a `P[n]`; the note (and the cross-reference
  report's finding) no longer applies to PR.
- **"12 s ago" never moved** - in the Controllers tree, on the robot page and on the status bar.
  The words are redrawn every 5 s from what is already cached. Nothing is read from the robot;
  the smoke test's zero-requests-while-idle check runs with it on.
- `tp.language-configuration.json` had `lineComment` as an array; VS Code takes one string and
  silently ignores anything else, so Add Line Comment did nothing. Back to `//` (the `!`
  highlighting from #3 is in the grammar and is not affected).

### Added
- **Read-only files look and act read-only.** In a file on a controller the TP menu keeps only
  what works without editing (flow, call graph, compare positions, copy without positions);
  everything that edits is hidden, and the editing shortcuts are off. The tab, the Files row and
  the Explorer entry carry a colour and an `RO` badge (`robotCode.live.markReadOnlyFiles`,
  colour `robotCode.readOnlyFile`).
- **Download** (Ctrl+Alt+W): right-click a file under Files, a tab, the editor or the Explorer,
  or use the icon on the row - one read of that one file, saved where you say, offered to open.
- **New TP Program asks what the pendant's DETAIL screen asks**: type (TP program / Macro /
  Cond), group mask, write protect. A **+** on the Programs section starts it (Ctrl+Alt+N).
  A Cond program gets `*,*,*,*,*` without being asked.
- **A comment line longer than 32 characters is underlined** from the 33rd character
  (`robotCode.tp.diagnostics.commentLength`, 0 = off). 32 is measured, not assumed: the longest
  of 26,157 `!` comments in the real backup store is exactly 32. `--eg:` comments and `//`
  remarks are not measured.
- **Completion past the start of a line**: `R[1]=PR`, `IF DI`, `WAIT (F` offer the data kinds
  (the bracket opens with the register list already up), and the tail of a motion line offers
  `FINE`, `CNT`, `ACC`, `Offset,PR[]`, `Tool_Offset,PR[]`, `Skip,LBL[]`. Never inside a
  comment, a remark, a string or a bracket's `:comment`.
- **What Can I Do Here?** (Ctrl+Alt+H, and a **?** on the Programs and Controllers sections):
  one picker with every feature grouped by what you are trying to do, each with its shortcut.
  A test holds the grouping against `package.json`, so a new command cannot go unlisted.
- **15 more keyboard shortcuts** - `docs/KEYBOARD-AND-VIM.md` has the table and a ready-made
  block of leader mappings for the Vim extension.
- **File icons on by default, `.ls` and `.txt` included.** A language icon is beaten by the
  active theme's own extension table - Seti and vscode-icons both map `.ls` to LiveScript - and
  no language may claim `.txt`. So the extension now ships the **Robot Code** file icon theme:
  Seti (vendored under `media/seti`, MIT) with every FANUC type written over it, so no other file
  loses its icon. The first time the extension runs it switches `workbench.iconTheme` to it.
  `robotCode.fileIcons.enabled` (default on) turns that off and puts the previous theme back;
  a theme you pick yourself afterwards is left alone. `TXT` is grey, theme only, no language.

### Changed
- The sidebar section **TP programs** is **Programs**.

### The linter question
There is one: `src/fanuc/tp/diagnostics.ts`, 22 rules with this one (labels, positions, line
numbers, terminators, IF/FOR blocks, speeds, CNT before an operation, cross-program register
use, missing programs and macros, payload schedules, comment mismatches, comment length), plus
`findUndeclared` for KAREL. Each rule has a `tp.*` code and most have a setting.

### Tests
- `test/betaIssues.test.ts`, 48 checks, all synthetic. Unit total 1512.

## 26.9.19007 - 2026-09-19 - version ids (issue #7)

**A version is a version id from here on: `YY.M.DDIII`.** The year and month the work started,
then the start day and the issue number run together (`day * 1000 + issue`). This one,
`26.9.19007`, is issue #7, started on 19 September 2026. It replaces the build counter
(`YY.M.N`, 26.9.1), and every id reads as newer than 26.9.1 and 0.12.16. **`docs/VERSIONING.md`
is the walkthrough**: reading an id, making one, the rules, and what to do when the release
script says the number is not higher.

Sam asked for a version that says what the work was - year, month, change type, issue, start
day, run together as `26.9.0102614`. That exact shape cannot be used: a leading zero is not
valid semver, RUKUS cannot compile a version part past 65535, and with the type in front every
bug fix would outrank every feature. He picked the reordered form. RUKUS carries a fourth number
for the change type (`26.9.13026.1`); this extension cannot, because semver has three.

### Changed
- **`npm run version:id`** replaces `npm run version:date`. It takes the issue from the `#7` in
  the branch name and the start date from the branch's first commit that `main` does not have,
  and changes the one `"version"` line in `package.json`. `-- --show` only looks; `--issue` and
  `--start` override; `--decode` reads an id back in words, RUKUS's four-number ones included.
- **`npm run release` refuses a version that is not higher than every released tag.** RUKUS only
  installs a bundled extension that is newer, and an id is ordered by the day the work
  *started*, not the day it ships - so work that starts early and ships late comes out lower.
  The message carries the fix: re-stamp with today's date.

### Tests
- `test/versionId.test.ts`: making, reading and ordering ids; that every id is valid semver and
  `26.9.0102614` is not; that 26.9.1 is recognised as the old form, not misread; and the one
  thing the scheme does not promise, start-day order, written down as a test.

The open branches pick up their own ids when they are next touched: the containers work (#1)
would be `26.9.18001`, the smoke fixes (#5) `26.9.19005`.

## Unreleased - file icons, second pass: letters only, and every file type

Sam, on the first set: *"the icons for the file types are incomplete ... and can we just have
the name - if it's say .VA it just shows a purple VA, not a box or anything, just a big VA."*

### Changed
- **The icon is the extension in big coloured letters, and nothing else.** No tile, no outline,
  no folded corner: at 16 px the tile took the room the letters needed. The colour is still the
  family. **A compiled or binary file is underlined**; that replaces the outlined tile. Two
  letters and three are fitted to the same width and height, so a column of them lines up.
  Every icon has its own darker light-theme drawing.
- **Controller data is purple** (`.va` `.dt` `.vr` `.sv` `.df`), so diagnostics moved to red.

### Added
- **Eight more file types**, from a count of a real backup store where six of them had no
  icon: `.cam` (277 files), `.df` (246), `.stm` (127), `.vd` and `.vda` (94 each), `.pmc` (42),
  plus the KAREL dictionary sources `.utx` and `.ftx`. iRVision files are orange. Twenty types
  in all. Generic files (`.xml` `.txt` `.zip` `.gif` `.dat`) are left to your icon theme.
- **One table drives everything**: `FILE_ICONS` in `scripts/make-file-icons.mjs` now also
  yields the `package.json` languages, grammars and activation events
  (`scripts/sync-file-icon-manifest.mjs`), and the tests fail if any of the three drifts.

If an old icon still shows after updating, run *Developer: Reload Window*.

## Unreleased - containers meet RUKUS's backup layout

RUKUS keeps a backup store - `<cluster>\Latest\<robot folder>` for each robot's newest backup,
`<cluster>\<robot name>\<batch>` for its older ones, `.incoming` while one downloads - and a
container lives in a working tree. The two never collide, but nothing connected them either.

### Fixed
- **Initialize Robot Container no longer ticks RUKUS backups as working program folders.** The
  wizard left a folder out only when it was called `backups`, `archive` or `1_MD`, so RUKUS's
  own names - `Latest`, `2026-09-12_14-30`, `S002R01_(MD)_260912` - all came up ticked, and a
  container made inside a RUKUS tree indexed the backups as editable programs: the one thing
  the feature exists to prevent. A folder is left out now when its name says backup (those,
  any date stamp, a robot backup folder in either RUKUS naming preset) **or when it holds
  one**, whatever it is called - including a robot's archive folder that contains nothing but
  batches. Each says `looks like a backup - left out`, and one click puts it back.
- **Ticking a folder by hand in that wizard now works.** The list returned the folders the
  user ended up with, and the code filtered them by their *initial* tick again, so a folder
  ticked by hand was silently dropped.
- **Backups named with RUKUS's "Rodrigo's way" preset are read.** `S002R01_MD_2026-09-12` came
  back whole as the robot's name, so those datasets were labelled with the folder name and
  matched no robot. Both presets read as `S002R01` now; a batch folder (`2026-09-12_14-30`)
  and a robot really called `LINE_2026` keep their names.

### Added
- **Snapshot from Backup Folder finds this robot's backups itself.** RUKUS puts a robot's
  *current* backup in `<cluster>\Latest`, beside the robot's archive folder rather than in it,
  so a container could not find it and you had to browse. The command now lists what it finds
  under the workspace, under `robotCode.data.backupFolders` and in the robot folder's own dated
  archives - **Latest first, then newest by date** - matched on `robot.json`'s name and the
  folder's. Browse is still there. A half-written `.incoming` download is never offered, nor
  the container's own snapshot, nor another robot's backup (`R1` never matches `R10`).
  Archived `.zip` batches are not opened.

## Unreleased - file icons; containers hardening

### Added
- **An icon for every FANUC file type**, in the Explorer, on editor tabs and in Quick Open:
  `.ls` `.tp` `.kl` `.pc` `.cm` `.cf` `.va` `.dt` `.vr` `.sv` `.dg` `.io`. They use
  `contributes.languages[].icon`, not a file icon theme, so they work with whatever theme is
  active and no other file loses its icon. One rule for the set: the letters are the extension,
  the colour is the family (the sidebar's own amber / blue / teal / grey, plus violet for
  diagnostics and green for I/O), a solid tile is readable ASCII and an outlined tile with a
  folded corner is compiled or binary. Outlined icons have their own light-theme stroke.
  Generated by `scripts/make-file-icons.mjs`; the test fails if a committed icon differs.
- To carry an icon each, every file type is its own language id: `fanuc-va` was split into
  `fanuc-va` / `fanuc-dt` / `fanuc-dg` / `fanuc-io`, `fanuc-cm` into `fanuc-cm` / `fanuc-cf`, and
  the binaries got `fanuc-tp-binary` / `fanuc-pc` / `fanuc-vr` / `fanuc-sv`. Same grammar, same
  hovers and completion. `.sv` is matched by file name, so SystemVerilog is left alone. A
  binary language never activates the extension. *A `"[fanuc-va]"` settings block no longer
  reaches `.dt` / `.dg` / `.io` files.*

### Changed (containers hardening)
- **The working-vs-snapshot line count no longer melts on a big program.** It filled a
  table of (lines x lines): 60 ms and 18 MB at 3000 lines, 380 ms and 128 MB at 8000, for every
  modified program on every tree refresh. It now works from the shortest edit distance, in time
  proportional to the size of the *change*; same numbers, checked against the old table on 460
  cases. Two copies with more than 4000 differing lines read `4000+`. Counts are cached.
- The index kept a normalized copy of **every** program's text. Only a program under a robot
  marker has a snapshot to be compared with; it is dropped everywhere else.
- **A failed snapshot swap can no longer cost you the snapshot.** The old one was deleted
  before the new one was renamed into place. It is moved aside first and put back on failure.
- **Snapshot from Backup Folder no longer freezes VS Code.** The copy was synchronous under a
  progress notification that could not move; it is asynchronous and reports as it goes.
- The container `.gitignore` also keeps out `snapshot.json` - it names a local path or the
  robot's address, and describes a snapshot a colleague who clones does not have - and the
  temp / moved-aside folders. An existing file gains the missing lines; yours are kept.
- `test/fixtures-cell` register files are in the controller's real format (they had no
  `$NUMREG` header, so the parser read nothing from them). A launch configuration for the
  fixture cell that works on any machine.

### Fixed
- `npm run package` stopped on a relative link in the README; `npm run install-local` broke on
  a repo path with a space in it.

## Unreleased - containers fixes from the first smoke test of the feature

Found by `npm run smoke:containers` (new): the standard smoke suite had no containers checks,
so this one drives the feature in a real VS Code host against a copy of `test/fixtures-cell`.
27 checks; these three failed and are fixed.

### Fixed
- **Go to Symbol in Workspace no longer offers the snapshot copy of a program.** A snapshot
  copy is indexed so CALLs to it resolve, but it is reference-only; it was listed next to the
  working program of the same name, indistinguishable from it and one Enter from being edited.
- **Diff Working Copy with Snapshot was back to front.** The working copy was on the left and
  the snapshot on the right, so a line added in the working copy read as a deletion. The
  snapshot is the original now, the working copy the modified side.
- **Editing `robot.json` or `cell.json` takes effect without a manual Refresh.** A change was
  only noticed when the *set of marker folders* changed, so a different `programs` list, a new
  `exclude`, another `controller`, or a controller's host changed nothing until Refresh.

### Tests
- `npm run smoke:containers` (`test/integrationContainers.js`, `test/runContainersSmoke.mjs`):
  the partition (working / snapshot / excluded / unmanaged), the differs lens and its line
  count, the data source (register comments come from the snapshot, never the backup beside
  it), the diff, re-partitioning on a `robot.json` edit, and that opening a file does not
  smuggle its folder past the partition. It writes register files in the controller's real
  format: `test/fixtures-cell/**/numreg.va` has no `$NUMREG` header, so the parser reads
  nothing from it.

## Unreleased - fixes from the 26.9.1 smoke pass (issue #5)

No version number yet: 26.9.2 is taken by the containers branch, so this gets its number
when it is merged.

### Fixed
- **Compare Positions: W, P and R are compared the short way round.** The controller reports
  orientation in (-180, 180], so a tool pointing near straight back reads `179.990` one day
  and `-179.990` the next. That is a 0.02 degree touch-up and the report now says so; it used
  to say **-359.980, moved**. Only the orientation of a cartesian point wraps - a joint value
  or an extended axis is real travel and is still subtracted plainly.
- Compare Positions: `CONFIG` that differs only in spacing (`'N U T, 0, 0, 0'` /
  `'N U T,0,0,0'`) is no longer flagged as a configuration change.
- Compare Positions: a `|` in a position comment no longer breaks the report's table.
- **Programs Never Called: a program's call to itself is not a caller.** A loop that
  re-enters itself and that nothing else starts is now listed; a recursive program that
  something else calls is still counted as used.
- New TP Program: a double quote in the program comment is refused at the prompt (and
  replaced if it arrives any other way). It used to write `COMMENT = "say "hi"";`, which
  the controller will not load.

### Tests
- `test/issue5.test.ts`: all of the above, synthetic, so none of it depends on
  reference-backup being on the machine.
- **The frame convention is pinned.** The `Rz(R) . Ry(P) . Rx(W)` measurement needs real
  non-identity CURPOS readings, and the reference backup's one reading sits in an identity
  frame, so a default run measured it against nothing and still passed. There is now a
  longhand composition and its numbers that fail if the ordering is ever changed, a check
  that the pin can tell orderings apart (the alternative lands over 10 mm away), and a NOTE
  line in the run whenever zero real readings were available.
- **And measured, permanently.** Two real readings taken over HTTP from ROBOGUIDE virtual
  controllers on 2026-09-19 (S002R07 in UF2, S002R03 in UF11) are recorded in the test:
  user frame to world lands within 0.022 mm and 0.01 degrees of what the controller itself
  reports, and the same readings reject the Rx.Ry.Rz ordering. Three more robots in that
  cell sat in an identity frame and are left out, because an identity frame proves nothing.
## 26.9.2 - 2026-09-19 - per-robot containers (.robocode)

Structured multi-robot workspaces: working programs in one place, dated backup archives in
another. See `docs/design-robocode-containers.md` for the design discussion and
`docs/ROADMAP.md` Phase 4.

### Added
- **Per-robot containers** (`.robocode-robot/`): a `robot.json` declaration makes a folder
  one robot's area. Working program folders (declared, or every subfolder by default) are
  the editable set; a `snapshot/` holding a complete verbatim robot backup is the robot's
  single data source; everything else under the robot folder — dated backups,
  `.robot-history/` — is invisible to the extension. Workspaces without markers behave
  exactly as before. An optional `.robocode-cell/cell.json` names the cell and is the
  future home for workspace conventions.
- **Snapshot commands**: *Snapshot from Backup Folder…* (wholesale atomic copy of one of
  your dated archives) and *Snapshot from Robot…* (everything listed on a connected
  controller, over the existing FTP/HTTP machinery). Both replace the snapshot wholesale
  and record provenance in `snapshot.json` — date, source, file count, and the
  controller's name, version and F number when it can be read.
- **Initialize Robot Container…** wizard: folder → robot name → working program folders
  (backup-looking subfolders unchecked by default) → git hygiene (writes
  `.robocode-robot/.gitignore` with `snapshot/`, remembered via
  `robotCode.containers.gitignoreSnapshot`) → offers the first snapshot.
- **Which version is where**: every working program carries its status against the
  snapshot — `= snapshot 2026-09-15` / `≠ snapshot · 3 lines` / `not in snapshot` — in the
  TP and PC program trees, plus a `differs from snapshot` CodeLens on the file
  (`robotCode.containers.snapshotCodeLens`). The diff is normalized: line numbers,
  terminators and LINE_COUNT are ignored, so a renumber-only change reads as identical
  and one inserted line shows as one line, not a cascade of renumbered lines.
- **Snapshot programs are reference-indexed**: CALLs to programs that exist only on the
  controller resolve, cross-references see the whole robot, but snapshot copies never
  appear as editable rows and lose to working copies of the same name everywhere
  (resolution, callers, comment tallies, findings — a working copy and its snapshot copy
  are one program, never two).
- The Backup view shows one row per robot — snapshot date and source, TP/PC counts, a
  re-snapshot button, and "N only on robot" for programs that exist in the snapshot but
  not in any working folder. The status bar shows the snapshot's provenance date.

## 26.9.1 - 2026-09-16 - date-based versions; position diff, frames, comment pull, dead programs, templates

**Versions are dates from here on** (Sam: "do date way"): `YY.M.N` - two-digit year, month,
and the build number within that month. 26.9.1 is the first build of September 2026; the next
is 26.9.2; October starts at 26.10.1. `npm run version:date` works out the next number from the
tags and the .vsix files already made. It replaces 0.12.16 (and the never-released local
0.13.0); RUKUS compares the numbers numerically, so it reads as newer.

Sam picked everything on the day's list except sending programs to the robot and the
real-cell verification. Built and installed locally; not released yet.

### Added
- **Compare Positions With…** (FANUC TP menu): the open program against another copy - every
  other backup's copy of the same name is offered first, then any file. One row per P[n]
  with the delta per axis (X Y Z W P R, or J1..J9, plus extended axes), the cartesian
  distance where both points are cartesian in the same UF, and flags for moved / added /
  removed / frame changed / config changed / joint-vs-cartesian. Changed rows first.
- **Frames**: hover on `UFRAME_NUM=3`, `UTOOL_NUM=2`, `UFRAME[3]`, `UTOOL[2]` and on a
  /POS block's `UF : 3, UT : 2` shows that frame's X Y Z W P R from sysframe.va, says
  which frame was selected when the backup was taken, and warns on an all-zeros frame. The
  Data section gains **User frames** and **Tool frames** groups (set or selected frames
  only); the register table gains UF and UT tabs.
- **Sync Inline Comments from Controller…** (FANUC TP menu): every register / I/O / PR
  reference whose inline comment differs from the controller's - the same rule as the
  `tp.commentMismatch` diagnostic - in this file or in every program of the backup, shown
  first (counts per kind, examples), applied as one undo per file. The push direction
  (writing comments TO the controller) is not built: it needs KCL syntax nobody has verified
  on a real cell; the module header says what is needed.
- **Report: Programs Never Called** (TP programs view title, and the palette): programs no
  program calls, minus the entry points a controller starts on its own (macro-table targets,
  `PNSnnnn` / `RSRnnnn` / `STYLEnn`, `MAIN*`), each with what it calls in turn so a dead
  cluster is visible. The caveats come first: condition handlers, KAREL CALL_PROG strings,
  PLC-selected programs and the RSR/PNS tables in sysvars.va are not checked.
- **Program templates** (`robotCode.tp.programTemplates`): New TP Program… offers a body
  template after the header; **Insert Program Template at Cursor…** drops one into an open
  program. Two ship: *Empty* and *Main loop* (banner, `UFRAME_NUM` / `UTOOL_NUM` asked once,
  `LBL[10:MAIN LOOP]`, a comment where the cycle goes, `JMP LBL[10]`). Same `${FIELD}`
  placeholders as header templates.

### Fixed
- Numberless lines (`     :  R[1]=1`) are coloured like any instruction: comments, remarks
  and motion keywords included.
- Every counted line now carries its position in the controller's count whether or not
  the number is written on it, so a program in a numberless style still has every line in
  the flow graph, in extract / inline, in the backup diff and in folding, numbered by count.

## 0.12.16 - 2026-09-16 - `none` keeps the colon too

- `number: none` writes `    :  R[1]=1` - the indent, the colon, and the body with its own
  spacing; only the digits are gone. A blank line keeps its `    :` so it still counts.

## 0.12.15 - 2026-09-16 - the numberless style keeps its colon; licence

- **`number: spaces` keeps the colon**: `     :  R[1]=1` - the digits become spaces, the `:`
  stays, the instruction column does not move. That line is what the controller writes for the
  second half of a circular move, so the parser now decides by context: a `:` line continues
  the line above only when that line left something to continue (a `C` / `A` move or an
  extended comment without its terminator); any other `:` line is an instruction without its
  number - counted, parsed, numbered back by *Apply Controller Numbering*. Checked against
  every program on this PC: no real continuation is classified differently.
- LICENSE is now held by RUKUS Team.

## 0.12.14 - 2026-09-16 - custom touches only what you type; one-shot restyles; published by RUKUS Team

- **Custom mode no longer rewrites the program.** Switching `robotCode.tp.autoRenumber` to
  `custom` used to restyle every line on the next keystroke. Now only the lines you type or
  paste get the custom style; numbered lines and continuations are left exactly as they are.
- **Three one-shot commands** on the FANUC TP menu, each on the whole program or on the
  selected lines when there is a selection: **Renumber Lines to 1:**, **Apply Custom Line
  Style** and **Apply Controller Numbering**. These are the only things that rewrite existing
  numbering on purpose. *Renumber Lines* (Ctrl+Alt+R) is the controller format regardless
  of mode.
- **Publisher is now `rukus-team`** (was `sam-martinez`), author *RUKUS Team*. The extension id
  RUKUS detects by is therefore `rukus-team.robot-code`; RUKUS's `VsCodeService` and its tests
  were changed with it. **On a PC that has the old id installed, uninstall it first**
  (`code --uninstall-extension sam-martinez.robot-code`) or VS Code runs both.

## 0.12.13 - 2026-09-16 - Enter inside brackets, suggestions everywhere on a TP line, 1: on every line

- **Enter pressed inside `DI[|]` no longer strands `]) ;` on its own line.** VS Code's bracket
  rule turns that Enter into three lines; the instruction is put back together on its own
  line and the caret goes to a fresh scaffolded line below, as if Enter had been pressed at
  the end. (Sam's screenshot, 0.12.12.)
- **Suggestions pop up as you type anywhere on a TP line.** VS Code keeps quick suggestions off
  inside anything the grammar calls a comment or a string, and the register comment inside
  `R[1:Speed]` is one, so typing there gave nothing until `[` or `:`. The extension now
  turns quick suggestions on for TP in every scope, and snippets no longer block them.
  Word-based suggestions (random words from the file) are off for TP.
- `robotCode.tp.customRenumber.number` gained **`ones`**: `1:` on every line, the number as a
  marker rather than a count. `LINE_COUNT` still counts the lines.

## 0.12.12 - 2026-09-16 - custom style can leave the number out; IF snippets under `if`

- The four IF snippets (IF…THEN…ENDIF, IF…THEN…ELSE…ENDIF, IF…JMP, IF…CALL) now also answer to
  the prefix `if`, so typing `IF` lists all of them; the old `ifthen` / `ifelse` / `ifjmp` /
  `ifcall` prefixes still work. FOR and SELECT gained `for endfor` and `select case`.
- **`robotCode.tp.customRenumber.number`**: `show` (default), `spaces` or `none`. `spaces` writes
  spaces where the number and colon would have been, so the instruction column does not move:
  `        R[1]=1`. `none` writes only the indent: `    R[1]=1`. Numbered lines lose their
  numbers on the next renumber; a blank line stays blank; `LINE_COUNT` still counts every
  line. Set the mode back to `on` and run *Renumber TP Lines* to put the numbers back. The
  program flow graph and the "line 23" captions use the number written on the line, so
  without numbers they fall back to the document line.

## 0.12.11 - 2026-09-16 - auto-renumber: on, off, or your own style

- **`robotCode.tp.autoRenumber` is now `on`, `off` or `custom`** (`true` / `false` in an older
  settings file still read as on / off). *Toggle Auto-Renumber* cycles through the three and
  the status-bar tooltip says which is active. `on` writes the controller's format as before.
  `custom` writes the style in **`robotCode.tp.customRenumber`** - by default four spaces, the
  number as it is, a colon and no ` ;` added: `    12:  R[1]=1`. A terminator already on the
  line is kept in every mode, and a blank line gets no `   ;` scaffold in custom. *Renumber TP
  Lines* and *Format Document* follow the same setting, so switching back to `on` and
  renumbering restores the controller's four-wide field and terminators.

## 0.12.10 - 2026-09-16 - Dark defines its chart colours too

- *Robot Code Dark* now sets the same nine `charts.*` / `terminal.ansiCyan` colours from its
  own palette (amber, blue, red, purple, green, teal) instead of VS Code's defaults, so the
  call-target tints and sidebar icons match the theme the way the other three do.

## 0.12.9 - 2026-09-16 - call targets are not washed out on a light background

- The editor tints a `CALL` / `RUN` / macro name by what it resolves to, and the sidebar
  icons use the same colours - all through VS Code's `charts.*` theme colours, whose defaults
  are one orange and one blue for every background. On *Robot Code Light* that amber read as
  washed out (Sam, after 0.12.8). The three new themes now define those colours for their own
  background: a deeper amber, blue, red, purple, green and teal on Light; brighter ones on High
  Contrast; darker ones on Light High Contrast. Dark keeps VS Code's defaults, which it was
  designed around.

## 0.12.8 - 2026-09-16 - the grammar works again; themes; the Files panel shows programs

A review of everything since 0.10.1 (three reviewers over the 0.11.0-0.12.7 diff, then the
suites), and the two things asked for on the day.

### Fixed
- **Syntax colouring was broken in every release since 0.11.0.** Eight rules in the TP grammar
  had lost their backslashes on the way into the file (`\\s*` became `s*`, `\\b` became a
  backspace byte). Three of them did not compile at all, so VS Code threw on every `R[…]` /
  `DI[…]` bracket and every `/POS` block; the other five could never match, so `--eg`
  comments, continuation lines and `UF : F` were never coloured. Sam found and
  fixed the same eight rules by hand on GitHub the same afternoon (one `\s*` in the I/O
  rule was still missing its backslash; merged, that one restored too). Nothing tested the
  grammar - `parseTp` never reads it. Now `npm test` compiles every regex of every grammar under the
  same Oniguruma VS Code uses and tokenises the fixtures, checking the scopes each changelog
  entry named (`vscode-oniguruma` and `vscode-textmate` as dev dependencies; the `.vsix` is
  unchanged).
- **Download Backup: one slow file ended the whole run.** The control socket's timeout is an
  idle timer, and the control channel is idle by design for the length of a data transfer -
  a big `.va` over a slow plant link tripped it and every remaining file was abandoned. The
  timer now runs only while a reply is owed.
- **Download Backup: a dropped data connection put the session out of step.** The server's
  `426` for the failed transfer was left in the stream and answered the next `PASV`, whose
  `227` answered the next `RETR`, and so on down the list. The completion reply is consumed
  whether the data side succeeded or not; the file is reported and the run goes on. A data
  socket that times out now fails the file instead of handing over the half it had. The mock
  robot serves a slow file and a reset file so both stay tested.
- **Teach from Robot with a file from S002R05 open and only S002R01 connected read S002R01**
  without saying so. The one connected robot is now the answer only when the file does not
  name a different one; otherwise the pick shows every robot, the file's own first, and says
  which are connected.
- **Ctrl+click in a robot file could open another robot's backup copy** before that robot's
  device had been listed. Navigation now holds back on the same condition the diagnostics
  already did.
- **Opening one program out of a 5,000-file network dump indexed the whole dump** - the
  folder-on-open index now honours `robotCode.data.maxFiles` like the full scan.
- **`$X[2].$F` hovered with older text than `$X[1].$F`.** The manual importers describe the
  variable on its element-1 spelling; the lookup now prefers that spelling. The bundled
  reference keeps one row per variable instead of one per array element: 9,158 rows instead
  of 55,967, 1.3 MB instead of 5.9 MB, and the `.vsix` drops from 661 KB to 477 KB.
- **Extract Program cut a circular move at the selection edge** - stopping just short of the
  continuation line, or starting on it, produced a one-point circular move and an orphan `:`
  line. Both are refused with a message that says which line to include.
- Flow graph: a program whose first block is a `FOR` lost its banner. Terminator check: two
  adjacent one-line `--eg` comments, the first unterminated, were not reported. Status bar:
  two payload schedules at the same mass are listed as "PAYLOAD 1 or 3" instead of naming the
  first. PC programs header counted one `MOV_HOME.pc` across two backups while the rows showed
  two. A robot device group no longer gets a `file:///fanuc:/…` resource URI.

### Added
- **Three more themes**: *Robot Code Light*, *Robot Code High Contrast* and *Robot Code Light
  High Contrast* - the same forty-four scopes as Dark, each colour re-tuned for its
  background. All four now colour untaught position fields and V8.30 I/O state segments.
- **The Files panel under a robot shows programs only**: every `.ls`, and a `.tp` only where no
  `.ls` of that name is on the device. The filter icon on the panel header flips to every file
  (`robotCode.live.filesShow`). Display only - the full listing still resolves CALLs and feeds
  Download Backup. The **TP programs** section does the same on disk: one row per program
  name per robot, the `.tp` only where the `.ls` is missing.
- **`npm run release`** (`scripts/release.mjs`): tags the version, pushes, creates the GitHub
  release with the `.vsix` attached, and bundles the same file into the RUKUS checkout as
  `Assets/VSCode/robot-code.vsix` with a commit staged by name - the two places the `.vsix` is
  kept, since it is not in this repo's history.

## 0.12.7 - 2026-09-15 - programs resolve from where the file is

- **A CALL is resolved from where the file you are in actually lives.** A program opened
  off a controller (`fanuc://robot/MD/X.LS`) looks for its CALL / RUN / macro targets on
  that controller's device - the listing the Files panel already made - so
  `APERA_BIN_OFFSET1` is found on the robot instead of being reported missing because no
  folder on disk has it. Ctrl+click opens the target from the robot; the hover says which
  robot and device it is on. When the robot has a copy AND a backup on disk has one, the
  robot's copy wins for a robot file. "Not found" is only said once the device has been
  listed; before that the honest answer is nothing.
- Programs opened off a robot are indexed from their own text (no extra read), so their
  callers and calls are known and they group under the robot in the Programs sections.
- **A local file outside the workspace and the backup folders indexes its own folder** on
  open, so its neighbours resolve too.
- **Cross-Reference Report** takes the robot of the file you are in instead of asking, and
  never offers a robot's opened files as a "folder" unless you are in one of them.
- **Teach Position from Current Position… is always on the menu**, first, ahead of *Teach
  Position from PR[n]…* It used to be hidden until VS Code had a robot connected, so the
  PR[n] variant was all most people saw. With nothing connected it now offers to connect
  (a file opened off a robot picks that robot), then asks cartesian/joint and which UF/UT.
- **Updating in place no longer throws three "No view is registered" errors**: sections the
  running manifest does not know yet are skipped and one message offers Reload Window.

## 0.12.6 - 2026-09-15 - read against a V8.30 controller

A full pull off a V8.30 SpotTool+ virtual controller (379 files, one FTP session, 45 s) run
through every parser. Everything read - registers, I/O comments, macros, frames, payloads,
CURPOS/PRGSTATE/IOSTATE/VERSION, 89 programs with zero renumber changes - and three things
V8.30 writes differently were found and handled:

- **`DI[45:OFF:BIN 1 TRIG]` is the format, not an oddity.** V8.30 exports every I/O reference
  with its state at export time as a middle segment (`ON`, `OFF`, a number, or `*` for not
  connected) - 468 of them in one backup. That is now a field on the reference: the hover
  says "Listing state: OFF - what the point was when this .ls was exported, not what it is
  now", the grammar colours it, and nothing warns about it. A middle segment that is NOT one
  of those still goes through the general fallback.
- **Untaught positions are recognised.** V8.30 writes `UF : F, UT : F` and `X = ********`
  for a block that was never taught. The hover and outline say "untaught", every motion to
  one gets a warning ("the controller faults when this line runs"), and *Teach Position from
  Robot* rebuilds the block from the reading instead of refusing for want of numbers.
- **Hover docs** for `R[R[n]]=` (indirect assignment), `PR[i,j]=` (element assignment) and
  `TOOL_OFFSET CONDITION`.
- Three of the 8.30 programs are permanent test fixtures (`test/fixtures-v830`), and the
  corpus test's exact `sysframe.va` values are checked only on the S002R01 backup they
  belong to.

## 0.12.5 - 2026-09-15 - flow labels stop piling up; a comment titles one block

- **Edge labels no longer overlap.** The TRUE and FALSE labels of a branch were drawn at the
  same point of two edges leaving the same node, one on top of the other and over the box
  below. Labels of the edges leaving a node now stack under it, each on its own curve, and
  the layout leaves that much room before the next row. Box width cap raised so a long IF
  line is not cut off.
- **A comment titles the block after it, not every block after it.** `!Set Robot
  UFRAME/UTOOL` stayed armed until the next comment, so every later block wore that title.
- **Enter before the ` ;` of a blank numbered line** (`  21:   ;`) is healed like any other:
  the terminator goes back, the new line is scaffolded. It was skipped because the line
  above had nothing after its colon.

## 0.12.4 - 2026-09-15 - every system variable says something, and says what kind of something

- **Two more FANUC manuals merged into the reference**, in order of authority: the R-30iA
  *Software Reference Manual* (MARACSSRF03061E Rev F, V7.20+) - 2,797 paths with FANUC's
  Name and Description, the modern successor of the R-J3 listing - and, on top of it,
  Appendix C of the R-30iB Plus *Operator's Manual* (B-83284EN/09), the newest text for the
  283 everyday variables it covers. Importers: `scripts/import-sysvar-swref.mjs` and
  `scripts/import-sysvar-handling-tool.mjs`.
- The system variables no manual describes now get a description **guessed from the
  name** - the parent structure's documented name, then the field's words with FANUC's
  abbreviations expanded (`$SCR_GRP[1].$M_POS_ENB` → "Group System Configuration Record —
  machine position enable"). Every one is marked `inferred`: the hover adds "_Inferred from
  the name — no manual describes this one yet_", completion says "(inferred from the name)",
  and manual entries sort ahead of guesses. RUKUS carries the same rows with `source:
  "inferred"`, its existing convention. The whole reference is now bundled, so a PC without
  RUKUS gets the guesses too.

## 0.12.3 - 2026-09-15 - the Ford header is Ford's

- The **Ford (GVOSS)** header template now matches the Ford–FANUC GVOSS Robot Programming
  Guide (2024-10) instead of a guess: a 32-star banner, what the program does, an empty
  comment line, `NOTE: This program has <groups> motion`, and the banner again. No
  author/date/rev lines - GVOSS programs do not carry them. GM and Stellantis remain
  starting points to edit until their guides are to hand.

## 0.12.2 - 2026-09-15 - FANUC's own words on 1,300 more system variables

- The system-variable reference now carries the descriptions from FANUC's *System Variable
  Listing* (the R-J3 Software Reference Manual, MARS35GEN09801E): every entry's Name and
  Description, with type and access. `scripts/import-sysvar-manual.mjs` reads the listing's
  text and merges it into RUKUS's `SysVarsReference.json` - filling empty descriptions,
  replacing inferred ones, keeping hand-written ones - and **adds the 1,212 paths the
  controller capture never had**, `$DMR_GRP`, `$MNUFRAME`, the `$SCR_GRP` fields among them.
  Bundled subset: 5,378 entries, 5,153 described (was 3,874). Hover `$MOR_GRP[1].$CURRENTLINE`
  and read "Current Line Number — The line number in the source program that generated the
  current or last motion…".

## 0.12.1 - 2026-09-15 - extract keeps the whole move; the banner reaches the graph

- **Extract / Inline carry continuation lines.** The second half of a circular move (and the
  later lines of a `--eg` comment) went missing from an extracted program, leaving `C P[1]`
  arriving nowhere. They travel with their line now, unnumbered as the controller writes them,
  with the terminator on the last line of the group.
- **Position renumbering no longer swaps points back.** Extract applied its index map one
  entry at a time, so when the map swapped two indices a reference was renumbered twice and
  landed on its original number - an extracted circular move had the same point at both ends.
  One pass now; inline's label and position maps got the same fix.
- **The flow graph shows the program's banner.** Comments ahead of the first block used to be
  dropped (the entry node was just "Start"); they ride on the entry title - or on the opening
  label when the program starts with one.
- **Smoke test covers the sidebar**: all six sections exist, their header summaries count
  what they should, the rows name the right things (ENTERZON, the backup with its date and
  counts, `GO TO HOME POS → MOV_HOME`, register and I/O groups), no raw-token warning on the
  clean reference backup, and "1 of 1 live" with the IP once the mock robot connects.

## 0.12.0 - 2026-09-15 - the sidebar, the editor tints, and where every arrow lands

The implementation brief of 2026-09-15, audited against 0.11.0 first: most of its parser,
navigation, editor and refactor items had shipped there and were left alone. What was new:

### Sidebar (F1-F3)
- **Six labelled sections** instead of four: *Controllers*, *Backup*, *TP programs*,
  *PC programs*, *Macros*, *Data*. Each header carries a right-hand summary - "1 of 2 live",
  "64", "9 · ⚠ 1 missing", "200 R · 397 I/O" - and a count goes amber (with ⚠) when it is a
  problem. Sections are VS Code views, so each is collapsible with a rule between them.
- **Controllers** rows are cards: a status dot coloured by state (green live, dim not
  connected, red failed, yellow connecting), then model (once read), IP, and either what the
  robot is running or the failure reason - readable without opening anything. The
  controller's own files do not report T1/T2/AUTO, so the mode is not shown.
- **Backup** is new: one row per backup folder with its date, TP/PC counts, the data files
  read out of it, and - the backup-level warning A1 asked for - how many bracket arguments
  the parser read on its fallback rule, in which programs.
- **PC programs** lists KAREL sources and compiled `.pc` (one row per name, "source + .pc"),
  **Macros** lists the macro table with whether each target program exists and who uses it.
- **One colour, one icon per kind**, shared with the editor and the status bar: TP amber,
  PC blue, macro teal, data grey; missing red. Never colour alone.

### Editor (F4)
- `CALL` / `RUN` / macro names are **tinted by what they resolve to**, so a Ctrl+click target
  reads as one span of one colour; unresolved ones are red-dotted.
- The frame label after `P[n]` reads **"Joint · UF1/UT2"** / **"Cartesian · UF1/UT2"** and is
  tinted by representation (a decoration now, not an inlay hint).
- `--eg` extended comments carry a faint band across every line; registers and I/O points
  that are **read** - parentheses included - get a dotted underline. Each has a setting under
  `robotCode.tp.decorations`.

### Program flow (F5)
- **Every arrow names where it lands**: `TRUE: R[1]=1 → LBL[10] (line 23)`,
  `FALSE: R[1]=1 → line 12`, `JMP → LBL[30] (line 41)`, and `falls through → line 7` - the
  branch nobody drew is captioned like the ones they did.

### Status bar (F6)
- A connection dot and a context strip: robot, active UF/UT (from the last CURPOS read, with
  its age in the tooltip), active payload (`$GROUP[1].$PAYLOAD` matched to its schedule),
  backup name and date, and the customer spec (header template) last used.

### Teaching (E1)
- Every choice in *Teach Position from Robot* shows the live reading it would write - the
  cartesian and joint values on the representation pick, the converted XYZWPR on each frame
  choice - since there is no confirmation step after it.

### Parser (A)
- `--eg` opens an extended comment with or without the colon. Tests pin DI/DO/PR/AR reads
  inside parentheses, and the per-program count of fallback-read bracket arguments feeds the
  Backup section and the output channel after every scan.

## 0.11.0 - 2026-09-15 - the first field backlog

Eighteen items came back from using 0.10 on real backups, plus one about the backup pull. The
extension now lives in its own private repository (`Scyllasis/robot-code-vscode`); RUKUS keeps
carrying the `.vsix`, nothing else crosses over.

### Teaching and positions

- **Teach Position from Robot asks two things first.** Cartesian or joint - the controller reports
  both readings of the one pose, so either is a straight copy and no kinematics is involved. Then
  which frames to record against: keep the point's own UF/UT (the reading is converted into them
  from the robot's active frames through `sysframe.va`), take the robot's active frames (the point
  is relabelled), or pick any UF and UT the backup states. Choosing the other representation
  rewrites the block, with the whole new block shown before it happens; a block with two motion
  groups is refused rather than silently halved.
- **Clean Up Unused Positions…** lists every position no live line uses - never mentioned, or
  mentioned only on `//` and `!` lines - for review, then removes the checked ones from `/POS`.
  The second kind is the one a text search never finds.
- **Rename (`F2`) works on a position's name** - `P[1:"Home"]` on the block and `P[1:Home]` on
  every reference. Not PR names: those come from the controller.
- **Inlay hints say what they mean.** `Joint UF2/UT6` and `Cartesian UF1/UT1` in place of `JUF2/UT6`,
  and the same wording in every position picker.

- **Teaching no longer asks "are you sure".** Everything that could make a teach wrong is
  refused or asked about beforehand; what is left is a text edit one Ctrl+Z reverses, and a
  modal for that was a click on every point. The toast names the axes that moved and offers
  Undo; the full before/after goes to the output channel. (Rewriting a block in the other
  representation still shows the new block first - the old numbers are gone afterwards.)

### Editing

- **Customer header templates.** `robotCode.tp.headerTemplates` holds named blocks of `!`
  comment lines - Ford, GM, Stellantis and Generic ship as starting points to edit. **Insert
  Program Header…** drops one in at the cursor, and **New TP Program…** offers one at
  creation. `${PROGRAM}`, `${COMMENT}`, `${DATE}`, `${TIME}`, `${USER}`, `${ROBOT}` and `${RULE}`
  fill themselves; any other `${FIELD}` is asked for once.
- **Enter before the ` ;` no longer carries the terminator down.** The natural place to press
  Enter is at the end of the instruction, which is before the ` ;`; the editor moved the `;` to
  the new line, the renumber then treated that stray `;` as your typing and left it alone, and
  the caret sat in front of a semicolon with no scaffold. The terminator now goes back where it
  belongs and the new line is scaffolded and numbered, in the same undo step as the keystroke.
- **Ctrl+click on a macro underlines the whole name.** `GO TO HOME POS` was four words that each
  lit up on their own; the definition provider now hands the editor the span the parser already had.
- **Renumber Register / I-O defaults to the entire backup** - the whole tree, subfolders included,
  not the one folder the file sits in - and **renaming a register comment (`F2`) rewrites it in
  every program of the backup that touches that register.** A register is one thing on one
  controller, and a comment that says two different things in two files is exactly the mismatch
  the diagnostics flag.

### Navigation and parsing

- **`CALL` / `RUN` / macro targets that only exist as a compiled `.pc` or `.tp` now resolve.** A
  backup carries the binaries whether or not the source was exported; they are indexed by name, so
  "not found" is only said when the program really is not there. Source wins over a binary of the
  same name; hover, the Programs view and the call graph all say "compiled only".
- **`--eg:` extended comments are understood.** The controller's multi-line comment - `--eg:`
  on a numbered line, the text carried on over `:` continuation lines, one ` ;` on the last -
  was read as an instruction with a missing terminator, and the auto-renumber then put a ` ;`
  on line 1 and cut the comment in two. Every line of it is a comment now: highlighted as one,
  folded to its first line, hover-documented, left alone by the renumber and the terminator
  check. Continuation lines in general (the second half of a circular move) are highlighted too.
- **Unusual bracket arguments degrade instead of failing.** `GO[10:curr value:name]` (seen in a
  V8.3 backup) reads as `GO[10]` with comment `name`; the extra segment is kept and an information
  diagnostic says what was skipped. One general rule, so the next undocumented shape behaves the
  same way. Registers inside parentheses - `(R[90] >=0)` - were already counted as reads; a test
  now pins that.

### Program flow

- **Conditions are never truncated.** Every edge out of an IF carries the whole condition, labelled
  `TRUE: …` on the branch taken and `FALSE: …` on the other, so either arrow alone tells you the
  decision. Boxes are as wide as their longest line; long labels wrap; the full text is the tooltip
  everywhere; the Mermaid export carries it all.

### Controller data

- **`$` system variables explained, from RUKUS's reference.** Hover any `$MNUFRAME[1,5].$X`
  in a TP program, a KAREL source or a `.va` dump and get the description, type, access and
  storage from `SysVarsReference.json` - the full 53,000-entry file from the RUKUS install on
  the PC (found through the `rukus://` registration, or `robotCode.sysvars.referenceFile`),
  with every described variable bundled in the extension for a PC without RUKUS. Indices are
  normalised, so element 5 is answered by the reference's element 1, and a field with no
  description falls back to its parent's. Completion after `$` lists the variables and after
  `$X[1].` its fields.
- **Payload schedules from `symotn.va`.** Hover on `PAYLOAD[n]` shows the schedule's comment, mass,
  centre of gravity and inertia; an inlay puts the comment after the number; completion lists the
  schedules; a `PAYLOAD[n]` that does not exist, or has never been set up, gets a diagnostic. The
  Registers view and the register table gained a Payloads group.

### Sidebar

- **Reworked for reading at a glance.** A robot row is coloured by state (green connected, dim
  disconnected, red failed, yellow connecting) and says so in words; a disconnected robot shows a
  single *Connect* row instead of five empty panels. Under a connected one, separators group
  *Controller* (Info, Position, Tasks, Registers, I/O), *Device* (Files) and *RUKUS*. A panel is dim
  until read, dated once read, orange once older than `live.staleAfterSeconds`. Programs, Registers
  and I/O use shorter labels with the counts as descriptions, the register table's colours, and a
  red warning on a call target that is not there.

### Backup pull

- **Download Backup is one FTP session, not one per file.** It was logging in, setting binary
  mode, changing device and quitting for every file - a few hundred sessions, on a controller that
  is slower to accept a login than to send a file. It now does what a person does at the prompt:
  `bin`, then `mget` over one session. That needed a real fix underneath: the client was answering
  a transfer's `226 Transfer complete` with the *next* command, which is why a second transfer on
  one session used to fail. Patterns are offered the same way - `*.ls`, `*.ls *.pc *.kl *.va *.dg`,
  `*.*`, or typed.

## 0.10.1 - 2026-09-14 - says it is beta

No behaviour change. The extension now states its own state where people will actually meet it:
`preview: true` so VS Code paints its own badge in the Extensions list, "(Beta)" in the display
name, a banner at the top of the README, a line on the TP status bar tooltip, and a note on the
RUKUS Settings card - which is the screen where somebody decides to put this on a plant PC.

What "beta" means here, specifically: the file-based half is tested hard (every parser runs
against real controller backups on each build, 21502 checks on the full tree), but **teaching a
position has never been done on real hardware** - only against ROBOGUIDE virtual controllers and
a mock. Nothing in it writes to a controller; every edit lands in the file and undo puts it back.

## 0.10.0 - 2026-09-14 - mirror, and relabel

Both are frame maths on the machinery 0.9.0 built, and they are opposites worth keeping
straight: **mirror changes the numbers so the point lands somewhere new; relabel keeps the
numbers so the point moves because its frame changed.**

- **Mirror Positions Across a Plane.** The left-hand/right-hand cell job. Position is the easy
  half - the coordinate normal to the plane changes sign - but orientation is not: a reflection
  has determinant -1, so applying it to a rotation gives something that is not a rotation and
  cannot be written as W/P/R at all. Conjugating instead (`R' = M . R . M`) lands back on a
  proper rotation, which is the mirrored tool orientation; a 90 deg turn about Z mirrors to
  -90 deg, and the tests assert both that and that the result is still a proper rotation.
  **CONFIG is never touched** - a mirrored pose often needs a different arm configuration and
  working out which one needs kinematics, so it warns rather than inventing an answer.
  Which frame's plane is asked, not assumed: mirroring across a cell's own centreline is a
  different operation from mirroring across the robot's world plane.
- **Relabel Position Frames.** Changes the `UF`/`UT` a position claims while leaving every
  coordinate alone - so the point now refers to a different place in the cell, by however far
  apart the two frames are. That is occasionally exactly right (a point taught against the
  wrong frame, whose numbers are correct) and is otherwise a good way to send a robot
  somewhere unexpected, so the confirmation opens with THIS MOVES THE POINTS and offers
  "Convert Positions to Another Frame" as the thing you probably meant.

Mirroring twice through the planner returns the original bytes.

## 0.9.0 - 2026-09-14 - frames are arithmetic, not kinematics

Sam: *"we can do a utool/uframe to a different one since we can read all of that data from the
back up and it's just math - no kinematics needed."* Correct, and the distinction had been
blurred here: turning joint angles into a position needs the robot's link geometry, which a
backup does not contain, but re-expressing a CARTESIAN point in another frame needs only the two
frames - and `sysframe.va` states both exactly.

- **Convert Positions to Another Frame.** Re-express taught points against a different `UF` or
  `UT`. The robot does not move and the points do not move in the cell; only the reference they
  are written against changes, which the confirmation says in as many words because the numbers
  can jump by metres. `UF`/`UT` on the block are relabelled to match, since numbers carrying the
  wrong frame label is the same silent wrongness the teach guards exist to prevent.
- **The rotation convention was measured, not assumed.** `CURPOS.DG` reports one physical pose
  twice - in the active user frame and in world - and `sysframe.va` gives that frame, so world
  must equal `UF o P`. Only `Rz(R) . Ry(P) . Rx(W)` reproduces it, on **9/9 real non-identity
  readings, worst 0.010 mm**. The two plausible alternative orderings miss by up to 5.5 metres on
  that same data. The corpus test keeps that honest.
- **1523 real positions convert to world and back**, worst 0.0010 - one unit of the three decimals
  a `.ls` stores, i.e. quantisation in the file rather than error in the maths.
- **Gimbal lock is left alone rather than re-spelled.** `W/P/R` is not a unique encoding: at
  P = +/-90 the X and Z rotations act on the same axis, and a real program (`aaa_tc_pounce_test`,
  a "HOME TEST" point at P = 90.000) round-tripped to `W 0, P 90, R 90` from `W -90, P 90, R 0` -
  the identical orientation, differently written. Orientation is now compared **as a rotation**,
  and left untouched when it has not actually turned, so a conversion cannot show up in a backup
  diff as a moved point that never moved.
- **Renumber Register / I-O now offers the whole robot folder**, not just the open file - a
  register is shared across every program on the controller, so doing one file was usually the
  wrong half of the job. Counts per file up front, names the programs where the destination number
  is ALREADY used (renumbering merges them), and says plainly that the controller's own copy and
  any KAREL or PLC are not updated.
- **Fixed: mixed line endings were being normalised.** Real backups mix them - `alt123.ls` has 79
  CRLF and two lone LF - and the whole-file rewrite behind Extract and Inline turned every line
  into CRLF, which would have shown as a diff on every line of a file where two lines changed.
- **Fixed: a value could be rewritten to a different spelling of the same number.** FANUC writes
  zero as `.000`, `0.000` and `-.000`; an edit that changes no value must change no bytes.

## 0.8.1 - 2026-09-14 - ktrans could never have used the version setting

- **Fixed: `karel.ktransVersion` broke every compile it was set for.** The wrapper passed
  `ktrans file.kl /ver V9.40`, and ktrans answers that with `Too many arguments: V9.40` and
  translates nothing. `/ver` is a **query** - `ktrans /ver` prints the version banner and
  exits - not a modifier, so there was never an argument order that would have worked. It went
  unnoticed because the setting defaults to empty, and an empty setting skips the flag.
- **Replaced it with `karel.ktransConfig`**, a path to a `robot.ini`, which is how the core
  version is actually selected (`/config`, and the value follows the input file). With no
  config ktrans says *"Unable to find 'robot.ini', using basic KAREL support files"* and
  compiles anyway - fine for syntax checking, which is what the compile button is mostly for.

Found while mapping the WinOLPC translators for a possible `.tp` converter; see FEATURES.md
for what that investigation established about `robot.ini`.

## 0.8.0 - 2026-09-14 - the offset, the checks, and a bug the corpus could not see

A correctness fix first, then the editing tools that ride on the teach engine from 0.7.0.

- **Fixed: the flow builder dropped every `ELSE` and `ENDIF`.** They did their edge
  bookkeeping and then never got added to a block, so Program Flow silently omitted them.
  It went unnoticed because **the reference backup contains no `IF ... THEN` blocks at all** -
  the check only fires on real plant code. On the big tree that was **84 of 150 corpus
  failures**; they now land in the block control flow merges into. (A trailing `ENDIF` after
  an `ABORT` had nowhere to go at all, which is where it showed up worst.)
- **Fixed: `LINE_COUNT` disagreed with `renumber()`.** Real backups contain lines written
  WITHOUT their number - `vmdata*.ls` has a bare `" ;"` sitting where line 4 should be, and
  the controller still counts it. The parser counted only numbered lines, so it reported a
  bogus `LINE_COUNT` mismatch on files that were fine. **150 corpus failures on the real
  tree are now 0**, and the robot-specific value assertions are scoped to the robot they
  were written for so that tree can be used as a test target at all.
- **Offset Positions** - "the fixture moved 3 mm", without re-jogging twenty points. Select
  points (or the motion lines that use them), type `X=3 Y=-1.5` or `3 0 -1.5`, get the same
  preview and the same byte-exact surgery as teaching. **The offset is applied in each
  point's own user frame**; a mixed-frame selection says so rather than pretending otherwise,
  and a cartesian offset onto a joint-taught point is refused, not converted.
- **Cross-reference findings now appear where you edit.** `xrefFindings` has known about
  outputs driven from two programs and registers read but never written since 0.3.0 - it just
  lived in a report nobody has open. The workspace index now records read/write access while
  it is already parsing each file, so this costs one pass over cached data, not a second walk
  of the tree. Reported once per register, at its first use.
- **KAREL: used but never declared.** ktrans does **not** check this, so a mistyped name
  translates cleanly and misbehaves on the robot. Calibrated against the 623-file corpus:
  977 raw hits down to 37 after three real parser fixes and a table of predefined names,
  and the survivors were checked by hand. Programs with `%INCLUDE` are not judged at all.
- **Three KAREL parser fixes found by that calibration**, which also fix hover, rename and
  go-to-definition for the same symbols: `VAR q:XYZWPR` on one line used to register a symbol
  literally called `"VAR q"`; a name list running over several lines (`task_status,` then
  `retries : INTEGER`) declared nothing at all; and binary `.pc` files saved under a `.kl`
  name are no longer read as a page of undeclared identifiers. **+232 symbols recovered
  across the corpus.**
- **Near-duplicate positions** - `P[12] is 0.3 mm from P[19]`, the leftovers that accumulate
  after years of touch-ups. Same user frame only; tolerance is a setting, `0` switches it off.
- **CNT into an operation that needs FINE.** A `CNT` move rounds the corner instead of
  stopping, so if the next line fires a gun or closes a gripper the robot is somewhere else
  when it happens. The rule table is configurable, because what counts as work is per-plant.
- **Extract to Program / Inline Program / Renumber Register.** Extract refuses anything that
  is not self-contained control flow - a jump leaving the selection, a jump into the middle
  of it, an unbalanced `IF` - because TP has no scope to protect the cut. Positions used only
  by the moved lines go with them and are renumbered from `P[1]`; ones used on both sides are
  copied, and it says so. Inline renumbers the callee's labels and positions past the host's.
- Cycle-time estimation was **removed from the backlog** and will not be built.

## 0.7.0 — 2026-09-14 — teach, and ask the robot what it has

Two things the editor could not do: record where the robot actually is, and find out whether
somebody has changed the program since you opened it. Both are one request, on a button, and
**neither writes to a robot** — the file changes, the controller does not.

- **Teach Position from Robot** (right-click a `P[n]`, or the cursor inside its block). Reads
  `CURPOS.DG` once, shows what moves — every axis, from → to, the delta, and how far the tool
  centre point travels — and rewrites only the numbers that changed, as one undo step. There is
  no re-emitting of the `/POS` block: each axis token is replaced in place, keeping the column,
  the decimals and even FANUC's inconsistent leading zero (the same backup writes `Z = 0.000`
  and `P =  .000` in one block). **2363 taught positions across 22 robot folders re-teach to
  byte-identical text**, which is the corpus test that guards it.
- **Teaching refuses more than it accepts.** `CURPOS.DG` reports the *active* user and tool
  frame, and the point in the program carries its own `UF`/`UT`; when they differ the numbers are
  in different spaces and the file looks perfectly valid afterwards. That case is blocked, with
  the choice to teach anyway or to retarget the point's frames explicitly. A joint-taught point
  fed a cartesian reading is refused outright — converting needs kinematics a backup does not
  contain. So is a reading with no value for an extended axis the point stores, because leaving
  the rail where it was while everything else moves is a point the robot has never been to.
- **Record New Position from Robot** — the pendant's SHIFT+RECORD, in the editor. Takes the next
  free `P[n]`, writes a block in the file's own style and in the file's own representation, and
  optionally drops a `J`/`L` motion line at the cursor, then renumbers.
- **Teach Position from PR[n]** — the same surgery with no robot on the network, using the
  position registers already read from `posreg.va`.
- **Get Fresh Copy from Robot** (editor title bar, TP files). Reads the open program off the
  controller once and says what differs: *only taught positions differ (3)* is the answer to
  "has someone touched this up on the pendant?". The robot's copy is saved to
  `.robot-history/<robot>/` (only when it differs — `robotCode.live.historyFolder` to move it),
  the diff opens, and *Replace local with robot copy* is offered behind a confirmation.
  This is deliberately the button that **watch mode** was never allowed to become: a watch is a
  poll wearing a different hat.

## 0.6.2 — 2026-09-13 — the robot page comes back

Corrections from Sam testing 0.6.x, plus the first checks against real ROBOGUIDE controllers.

- **The robot page is back** (`robotCode.live.dashboard`, click a robot in the Robots view).
  Removing it in 0.6.0 went further than asked — the page was fine, it was the *polling* that
  wasn't. So it returns with no timer of any kind: every card is a Get button, each carries the
  age of its own reading, and an unread card says so instead of showing an empty table that
  looks like the robot has nothing. The old version drove a 1 s webview tick on top of a 2 s
  controller poll, so simply leaving it open kept a robot generating `.DG` files.
- **Connect now pulls registers, I/O and the file listing — once each.** Those are what the
  *editor* runs on: hovers, inlay values, completion, the device tree. Position, program state
  and controller info stay on their buttons, because they describe what the robot is doing right
  now and go stale immediately. Configurable via `robotCode.live.fetchOnConnect`; set it to `[]`
  to read nothing on connect. Nothing here repeats — that is still `autoRefresh`, off by default.
- **Fix: pressing Enter now scaffolds the new line** with its number and terminator
  (`  12:   ;`) instead of leaving it bare until you clicked elsewhere. Auto-renumber skips the
  line the cursor is on so it doesn't fight you mid-edit, but a *blank* line has nothing to
  protect. The caret lands inside the line body, not in front of the number. Both behaviours are
  now regression-tested.

Checked against five ROBOGUIDE virtual controllers, which settled two open questions:

- `VERSION.DG` **does** exist and carries F number, `$VERSION`, application and date — plus the
  robot model (R-2000iC/210L). The PRGSTATE fallback is belt-and-braces.
- `HEAD` requests are **broken** on the FANUC web server — it returns a body anyway and the
  response fails to parse. So the connect probe stays a `GET`; the obvious optimisation is a trap.

## 0.6.1 — 2026-09-13 — the claim, measured

Finishing 0.6.0. Same day; 0.6.0 never left this machine.

- **The Files panel was still reading the robot on its own.** Expanding it listed the device —
  four index pages on an R-30iB — with no Get pressed. It is now gated like every other panel
  ("Not listed yet · click to get"), keeps its listing until you ask again, and Refresh re-lists
  only if it had already been listed. It was the last silent read.
- **The no-polling guarantee is now measured, not reviewed.** The mock controller keeps a request
  log the smoke test reads back over HTTP, so the assertions are about what reached the wire
  rather than what the extension believes it did:
  - connect asks for `/` and nothing else, and generates no `.DG`/`.VA`;
  - **zero requests arrive during a 20 s idle window** while connected;
  - Get Position is exactly one request, for `CURPOS.DG`.

  A reintroduced poll now fails the build. 76 checks, all passing.
- **Traffic meter** on each robot in the Robots view: requests and bytes since VS Code started,
  what the last one was and when. Counted at the transport, so anything the extension reads shows
  up — "is this bogging the robot down?" is now a question you can answer by looking.
- **Compare Two Backups offers RUKUS** afterwards (`rukus://diff`), which also wires up the one
  route that was in the contract with nothing firing it. Silent when RUKUS is not installed.
- `ROADMAP.md` no longer describes the 2–5 s refresh timer this release removed.

## 0.6.0 — 2026-09-13 — nothing is read until you ask

Pulling the live tier back. The extension was polling every connected controller every
two seconds, forever, for panels nobody had open — and a FANUC controller *generates*
each `.DG` diagnostic file at the moment it is requested, so that was continuous work
for the robot. Everything is now on demand, and the cell-management screens hand off to
RUKUS instead of being rebuilt here.

**Nothing is read from a controller unless you asked for it.**

- **No background polling.** The poll loop is gone. Each panel — Controller, Position,
  Tasks, Registers, I/O — is its own **Get** button reading exactly one file.
- **Connect reads nothing.** It fetches a static web-server page to prove the controller
  answers, then stops. No position, no version, no register dump. Panels start empty.
- **Auto-refresh is off, per robot,** and switching it on warns you what it costs first.
  When on, it re-reads only the panels you have already opened — never something you
  never asked for. The default interval moved from 2 s to 5 s.
- **Every reading carries its age.** Section headers say "4 min ago"; values in the
  editor grey out past `robotCode.live.staleAfterSeconds` (60 s); hovers say
  "Read from S002R01 12 s ago" instead of "Live on". The status bar says **"not read"**
  rather than "idle" when program state was never fetched — "idle" is a claim about the
  robot, and we had not earned it.
- New commands: Get Controller Info / Current Position / Program State / Register Values
  / I/O State, **Read Everything from Robot Now**, and Toggle Auto-Refresh.

**Handing off to RUKUS.** New `rukus://` buttons on every robot (needs RUKUS with deep
links — the extension offers the download when the protocol is not registered):

- **Live monitor** → RUKUS Production Dashboard. The robot dashboard webview is **gone**
  from the extension; a live view belongs in the app that can hold the connection.
- **Alarm history** → RUKUS Error Watcher. The extension no longer pulls `ERRALL.LS`.
- **Scheduled backups** → RUKUS Backup Scheduler, also offered after a backup pull.

Kept here, unchanged: download backup, browse the controller over `fanuc://`, compare a
program with the robot's copy, the register/I-O table and the cross-reference report
(those read backup files, and cost the robot nothing).

Also: fixed the integration harness writing its results file to a path that resolved
inside VS Code's own install folder, and replaced a live-value assertion that had been
testing inlay hints since the rendering moved to decorations.

## 0.5.4 — 2026-09-12

- **Live values in the editor are coloured**: rendered as decorations instead of inlay hints so each carries its own colour — green bold for ON, dim for OFF, orange for numbers, green for string registers, yellow bold when the point is simulated.
- Register hover shows a coloured dot for the live value.
- **Registers & I/O table** colour-codes item names by kind (R orange, PR blue, SR green, inputs blue, outputs purple, flags green, macros yellow) and values by type (numbers orange, zero dim, strings green, uninitialised italic, macro targets yellow).
- Fix: theme icons in hovers rendered as literal text such as `$(pulse)` because supportThemeIcons was never enabled.

## 0.5.3 — 2026-09-12 — verified against real controller software

- **ktrans output parsing rewritten** from real KTRANS V9.40-1 output: file(line) header, echoed source, caret column, message on the next line; duplicate blocks collapsed; success summary shown in the status bar; error popup offers "Go to first error".
- **Controller web server**: responses are HTML-wrapped (payload inside <PRE>) — now unwrapped for every text file, so live values, program state, alarms and fanuc:// files work on R-30iB Plus. Directory listing uses the INDEX_TP/VR/OT/ER.HTM pages since /MD/ itself returns 404.
- Verified against five ROBOGUIDE virtual controllers (127.0.0.2–6, V9.40): every parser, FTP LIST/RETR (anonymous) and HTTP listing.

## 0.5.2 — 2026-09-12

- Dashboard colour scheme: accent bar and icon per card (green running, blue position, red alarms, purple tasks, green I/O, orange registers), blue X/Y/Z, purple W/P/R, orange joints, green extended axes, coloured task pills, program names in yellow.
- Position is now a full-width section: Cartesian, World (when it differs) and Joints as separate labelled rows of axis tiles that size to the numbers, so values no longer get cut off.

## 0.5.1 — 2026-09-12

- **Robot Dashboard**: click a robot in the Robots view (or the dashboard icon) for a live page: status header with Connect/Refresh/Edit/Registers/Backup/Open file, the running task front and centre with its call stack, position and joints as axis tiles, tasks table with status pills (click a row to open the line), colour-coded alarm log with filter, searchable live I/O chips (ON points glow; click to find uses), register table with search. Updates every second from the poll.
- Robots tree rows now show the running program and line (or idle) and open the dashboard on click.

## 0.5.0 — 2026-09-12 — Program Flow

- **Show Program Flow** (editor title icon, FANUC TP submenu, Ctrl+Alt+F): a flowchart of one program. Blocks are cut at labels, jumps, IF/SELECT branches, IF…THEN/ELSE/ENDIF, FOR/ENDFOR and END/ABORT. Arrows carry the condition ("DI[25:ZONE 1 CLR]=OFF", "= 3", "else", "timeout", "skip"); labels with several arrows in are marked as merge points; loops are drawn back up the right side. Click a block to jump to its first line; pan by dragging, zoom with the wheel, **Copy as Mermaid** puts a Mermaid "flowchart TD" on the clipboard. Re-renders as you edit.

## 0.4.1 — 2026-09-12

- **Robot Connections form** replaces the chain of input boxes: all fields on one page, **Test connection** shows version, F-number and the controller's robot name (auto-fills the name), troubleshooting hints on failure, robot-name suggestions from the backup folders in the workspace, edit/connect/disconnect/remove for existing robots. Opens from the Robots view (+ and gear), the pencil on a robot row, or "Fix connection…" on a failed connect.

## 0.4.0 — 2026-09-12 — multi-robot backup trees

Fixes the false "comment does not match the controller" reports (and wrong CALL targets) in workspaces that hold several robots or several dated backups, e.g. Backups/Latest/S002R01_(MD)_260912 next to S002R02…, plus 2026-08-29_09-15/… copies.

- Controller data is now **scoped per robot folder**: each folder with .va files is its own dataset and a program only ever uses the data from the folder it sits in. No more "newest numreg.va wins".
- Program lookup (CALL/RUN navigation, hover, callers, CodeLens, call graph, missing-program diagnostics) prefers the program in the same robot folder; a CALL that only exists in another robot is reported as such.
- Programs, Registers and I/O views group by robot (label = robot name, plus the parent folder when the same robot appears in several backups). Register table gets a robot selector and defaults to the active file's robot. "Find uses" searches only that robot's programs.
- Cross-reference report asks which robot folder to analyse when there are several.
- Hovers name the robot the controller comment came from, and say so when a file is outside any backup folder.

## 0.3.1 — 2026-09-12

- **Renumber Labels…** (FANUC TP submenu): renumbers every LBL in order of appearance (default 10, 20, 30…) and updates all JMP/TIMEOUT/Skip references; keeps label comments; warns when indirect jumps (JMP LBL[R[n]]) exist.
- Scope decision recorded in FEATURES.md: the extension is the editor; backups, diffs, cross-reference and live-robot belong to RUKUS and will not be extended here.

## 0.3.0 — 2026-09-12 — analysis tools

- **Compare Two Backups…** (`robotCode.tools.diffBackups`, also on a folder's Explorer context menu and the Programs view): compares two backup folders and reports changed/added/removed programs with instruction-line +/− counts, **moved positions with ΔX/ΔY/ΔZ/ΔW/ΔP/ΔR and distance**, UF/UT re-frames, changed numeric/position/string registers (value vs comment), renamed I/O points, macro table changes and other changed files. Header timestamps and sizes are ignored so only real changes show. Click a program to open the A ⟷ B diff; save the report as Markdown.
- **Register & I/O Cross-Reference Report** (`robotCode.tools.xrefReport`, Registers view toolbar): every register and I/O point across all indexed programs with writer/reader programs, each use classified as write / read / wait / condition / motion / call-arg and linked to the line. Findings: inconsistent inline comments, read-but-never-written, written-but-never-read, outputs written from several programs, inline vs controller comment mismatch. Filter by kind, findings-only, export CSV or Markdown.

## 0.2.0 — 2026-09-12 — live controller, read-only tier

Connects to R-30iA/iB controllers (or ROBOGUIDE virtual robots) over the built-in web server or FTP. Nothing is written to the robot.

- **Robots view**: profiles (`robotCode.robots`), connect/disconnect, controller version and F-number, current position (user frame, world, joints), tasks with status/program/line, alarm log, device file listing.
- **Live values**: register and I/O hovers show the current value with age; inlay hints show `(value)` after every reference while connected (`robotCode.live.inlayValues`).
- **Running-line marker**: the TP line a RUNNING/PAUSED task is executing is highlighted in any open editor of that program; status bar shows robot/program/line; "Reveal Running Line" command.
- **Live I/O**: the I/O tree shows ● ON / ○ OFF per point.
- **fanuc:// file system**: open any file on the controller read-only, add a device as a workspace folder, "Compare Program with Robot Copy" opens a diff.
- **Download Backup from Robot**: pulls `*.LS`/`*.VA`/`*.DG` (or everything) into a dated folder and can register it as controller data.
- FTP passwords live in the OS credential store via VS Code SecretStorage.
- Untrusted-workspace support declared; `ktransPath`, `backupFolders`, `compileOnSave` are trusted-only settings.
- Test bench: `test/mockRobot.mjs` serves any backup folder as a fake controller (HTTP + FTP) with a running task and a ticking register; `npm run mock` starts it, `npm run smoke` runs 60 integration checks against it.

## 0.1.0 — 2026-09-12

First build.

- FANUC TP: grammar, hover docs, navigation, references, rename, outline, completion, inlay hints, diagnostics with quick fixes, CodeLens, folding, auto-renumber, editing commands, call graph.
- FANUC KAREL: grammar, built-in docs, navigation, references, rename, outline, completion, signature help, folding, formatter, diagnostics, ktrans compile.
- Controller data: `numreg.va`, `posreg.va`, `strreg.va`, `diocfgsv.va`, `sysmacro.va` read from the workspace or configured backup folders; Registers / I/O / Programs views and a filterable table.
- Grammars for `.va`/`.dt`/`.dg`/`.io` and `.cm`/`.cf`.
- "Robot Code Dark" theme.
