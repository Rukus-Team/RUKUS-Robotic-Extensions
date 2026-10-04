# UX/UIX Audit — Robot Code Extension

> Generated 2026-09-19. Covers all user-facing surfaces as of v26.9.2.

## Scope

This audit covers every interactive surface the extension presents to users: sidebar
trees, webviews, status bar, command palette, context menus, keybindings, onboarding,
and feedback mechanisms. It does not cover language features (hover, completion,
diagnostics) which are editor-integrated and follow VS Code's own UX patterns.

---

## 1. Onboarding & Empty States

### Current state

5 `viewsWelcome` entries in `package.json:1102-1122` provide first-run guidance for
each sidebar view. The Robot form (`live/robotForm.ts`) includes inline help text and
chip suggestions derived from backup folder names.

### What works

- Each empty view explains what it needs and provides a direct command button
- Robot form suggests robot names found in backup folders — a nice contextual hint
- Help text in the robot form explains the on-demand model clearly

### Issues

- **Welcome messages are dense paragraphs.** VS Code renders them as markdown, but the
  Robots view welcome is 7 lines long. Users scan, not read.
- **No guided first-run flow.** A new user must know to Add Backup Folder or Add Robot
  — there's no single "get started" entry point.
- **Backup chip suggestions only appear in Robot form.** The Registers view could
  benefit from the same pattern when no data is loaded.

### Improvements

| # | Change | Effort | Impact |
|---|--------|--------|--------|
| 1a | Shorten `viewsWelcome` to 2-3 lines + command buttons only | Low | High |
| 1b | Add a VS Code `walkthrough` contribution (Getting Started page) | Medium | High |
| 1c | Show backup-chip suggestions on empty Registers view | Low | Medium |

---

## 2. Sidebar Tree Views

### Current state

6 tree views, each a `TreeDataProvider`:

| View | File | Provider class |
|------|------|----------------|
| Controllers | `live/views.ts` | `RobotsTree` |
| Backup | `views/trees.ts` | `BackupTree` |
| TP programs | `views/trees.ts` | `TpProgramsTree` |
| PC programs | `views/trees.ts` | `PcProgramsTree` |
| Macros | `views/trees.ts` | `MacrosTree` |
| Data | `views/trees.ts` | `DataTree` |

Color system via `typeStyle.ts`: amber=TP, blue=PC, teal=macro, grey=data, red=missing.
Section headers carry counts. Summary text on view headers updates on index/data changes.

### What works

- Consistent color + icon pairing across all trees — "amber means TP" holds everywhere
- Multi-robot grouping is automatic: flat when one robot, grouped when multiple
- Snapshot status (`= / ≠ / not in`) on every working program — immediate visual cue
- Robots tree sections use `── LABEL ──` separators to group Controller/Device/RUKUS
- Data tree shows live I/O values with ON/OFF dots when connected

### Issues

- **No in-tree filtering.** VS Code's built-in type filter works but isn't discoverable.
  `filterText` on tree items would enable it.
- **TP context menu is flat and deep.** 20+ items mixing editing, position tools,
  analysis, and refactoring. Hard to scan.
- **Robots tree separators are simulated** (`── LABEL ──` on description). They look
  different from native VS Code tree separators.
- **Data tree robot label can be opaque.** `ds.label` is the folder basename, which
  may not match the robot name the user expects.

### Improvements

| # | Change | Effort | Impact |
|---|--------|--------|--------|
| 2a | Add `filterText` to tree items for built-in VS Code filtering | Low | Medium |
| 2b | Split TP context menu into submenus: Edit / Positions / Analysis / Refactor | Medium | Medium |
| 2c | Add a "quick pick" command palette for the 5 most common TP actions | Low | High |
| 2d | Show register count badges on the Data tree item | Low | Low |

---

## 3. Webviews

### Current state

5 webviews, each self-contained with inline HTML/CSS/JS:

| Webview | File | Purpose |
|---------|------|---------|
| Robot Dashboard | `live/dashboard.ts` | Per-robot status cards, Get per card |
| Register Table | `views/registerTable.ts` | Tabs, search, copy-as, find-uses |
| Robot Form | `live/robotForm.ts` | Add/edit/test robot profiles |
| Call Graph | `fanuc/tp/callGraph.ts` | Callee tree, click-to-open |
| Program Flow | `fanuc/tp/flowView.ts` | Layered flowchart, Mermaid export |

### What works

- Dashboard has the most polished UI: responsive grid, card color-coding by section,
  age stamps, stale warnings, pill badges for task status, I/O chip layout
- Register table has tabs per kind, search filter, copy-as-`R[5:Comment]`, find-uses
- Robot form has test connection with timing, error hints, backup-name chips
- Both flow and call graph have click-to-reveal in the editor

### Issues

- **No shared design system.** Each webview re-declares CSS variables (`--ok`, `--bad`,
  `--line`, `--card`). Dashboard defines 120 lines of CSS, register table 20, robot
  form 20 — all different.
- **Register table has no keyboard navigation.** Tab switches tabs but arrow keys do
  nothing in the table. Enter on a row does nothing.
- **Dashboard cards aren't clickable** beyond their Get buttons — clicking the card
  body does nothing.
- **No shared empty-state component.** Each webview handles "no data" differently:
  dashboard shows an off-state div, register table shows a paragraph, robot form
  shows the form itself.

### Improvements

| # | Change | Effort | Impact |
|---|--------|--------|--------|
| 3a | Extract shared CSS into a reusable template or inline constants | Medium | Medium |
| 3b | Add keyboard navigation (arrow keys, Enter) to register table | Medium | Medium |
| 3c | Make dashboard cards clickable (expand detail or trigger Get) | Low | Medium |
| 3d | Shared empty-state component: icon + message + action button | Low | Medium |

---

## 4. Command Palette & Menus

### Current state

~60 commands in `contributes.commands`, ~15 exposed in `commandPalette` with `when`
clauses. Editor title bar has 6 buttons (renumber, flow, call graph, compile, compare,
fresh copy). The TP context submenu has 20+ items.

### What works

- Editor title bar buttons are context-sensitive — only appear for the right language
- `when` clauses prevent command palette pollution — position tools only show for TP
- Keybindings for the 5 most common actions (renumber, remark, goto label, compile, flow)

### Issues

- **Many powerful commands have no keybinding.** Teach position, compare positions,
  clean up positions, sync comments, offset — all require palette or right-click.
- **TP submenu is flat.** Editing (renumber, remark) mixed with analysis (call graph,
  flow) mixed with refactoring (extract, inline) mixed with position tools (teach,
  offset, mirror). 20+ items in one list.
- **Position tools are hidden from palette** until a TP file is open — a user
  exploring the extension can't discover them.

### Improvements

| # | Change | Effort | Impact |
|---|--------|--------|--------|
| 4a | Add keybindings for top 5 undiscovered commands | Low | High |
| 4b | Reorganize TP submenu into nested groups | Medium | Medium |
| 4c | Expose position tools in commandPalette (remove restrictive `when`) | Low | Medium |

---

## 5. Feedback & Progress

### Current state

- `vscode.window.withProgress` for FTP fetch operations (`live/index.ts:68`)
- `setStatusBarMessage` for renumber feedback (3s auto-dismiss)
- Webview errors shown inline within the webview
- Output channel for detailed logs

### What works

- Progress bar on the Controllers view during FTP fetch — visible and contextual
- Status bar messages for renumber — quick, non-intrusive
- Robot form test result shows timing and error hints inline

### Issues

- **No progress indicator for ktrans compile.** Runs silently; errors appear in
  Problems panel but there's no "compiling…" feedback.
- **No progress for snapshot-from-robot.** Multi-file FTP download with no visibility.
- **Status bar messages disappear after 3s.** Easy to miss for slow operations.
- **Error handling is inconsistent.** Some commands use `showErrorMessage`, some
  `showWarningMessage`, some output channel only, some inline in webviews.

### Improvements

| # | Change | Effort | Impact |
|---|--------|--------|--------|
| 5a | Add `withProgress` to ktrans compile and snapshot-from-robot | Low | High |
| 5b | Use notification buttons for recoverable errors (retry, open output) | Low | Medium |
| 5c | Add a "Robot Code: Status" output channel summary after operations | Low | Low |

---

## 6. Keyboard Navigation & Accessibility

### Current state

5 custom keybindings. Standard HTML in webviews. No explicit accessibility attributes.

### What works

- Keybindings for the highest-frequency actions (renumber, remark, goto label,
  compile, flow)
- Webviews use semantic HTML (tables, headings, buttons)

### Issues

- **No aria labels on webview buttons.** Screen readers see button text but not
  context (e.g., "Get" doesn't say "Get register values from S002R01").
- **Register table has no keyboard navigation.** Can't arrow through rows or activate
  with Enter.
- **Flow/call graph rely on mouse** for node interaction — no keyboard alternative.

### Improvements

| # | Change | Effort | Impact |
|---|--------|--------|--------|
| 6a | Add `aria-label` to all webview buttons and interactive elements | Low | Medium |
| 6b | Add keyboard shortcuts for most-used commands | Low | High |
| 6c | Add `role` attributes to webview semantic elements | Low | Low |

---

## Prioritized Roadmap

### Phase 1: Quick Wins (1-2 sessions)

High impact, low effort — visible immediately:

1. **1a** — Shorten `viewsWelcome` messages
2. **4a** — Add keybindings for top 5 commands
3. **5a** — Add progress to ktrans compile + snapshot
4. **3d** — Shared empty-state component for webviews
5. **2a** — Tree item `filterText` for built-in filtering

### Phase 2: Structure (2-3 sessions)

Medium effort, high structural impact:

6. **3a** — Shared CSS across webviews
7. **4b** — Reorganize TP context menu into groups
8. **1b** — Getting Started walkthrough
9. **2b** — Split TP submenu
10. **5b** — Notification buttons for errors

### Phase 3: Polish (1-2 sessions)

Lower priority but improves daily use:

11. **3b** — Keyboard nav in register table
12. **6a** — Aria labels on webview elements
13. **3c** — Dashboard card click-to-expand
14. **1c** — Backup chips on empty Registers view
15. **2c** — Quick-pick for common TP commands

---

## Recommendation

The `.robocode` containers feature (Issue #1) is **feature-complete**. All items from
the issue spec are implemented across 9 commits:

- [x] `.robocode-robot/` containers with `robot.json`, `snapshot.json`, `snapshot/`
- [x] `.robocode-cell/` with `cell.json` and controller definitions
- [x] Marker-partitioned workspace (working / reference / excluded / unmanaged)
- [x] Modified-vs-snapshot marker with normalized diff
- [x] Snapshot commands (from backup, from robot)
- [x] Initialize Robot Container wizard
- [x] Backup view per-robot rows
- [x] Reference-indexed snapshot programs
- [x] Controller binding from cell.json
- [x] Tests, docs, CHANGELOG

The UX improvements in this audit are **quality-of-life refactors** that apply to the
extension broadly — not specific to the containers feature. They should be tracked as
a separate issue/epic.

---

## Follow-ups from the snapshot sync (issue #12, 2026-09-24)

Added when the snapshot became the robot's git-shaped index. Each is its own issue.

- **Full RUKUS integration** — import a RUKUS cluster into a robot cell (the reason the
  containers exist); align the cell/cluster data model with `.robocode` rather than
  `robotCode.robots` / `data.backupFolders`.
- **Container-first migration** — cells and clusters resolved by directory; retire the fixed
  user settings.
- **Per-robot Sync view** — **done 2026-09-25, then folded into Programs**: the Programs rows
  carry the snapshot/robot marker and the `n/n synced` summary, with `Fetch & Compare All` on the
  toolbar (a deliberate read); the separate `robotCode.syncStatus` view was retired.
- **Snapshot diff as a position/register diff** — **done 2026-09-25**:
  `robotCode.sync.comparePositions` / `compareRegisters`, reusing `tools/positionDiff.ts`.
- **Snapshot-history browser** — **done 2026-09-25**: the `Snapshot History…` picker lists kept
  versions with diff, open and restore.
- **Full transient-message standardisation** — one icon per verb and consistent durations
  across all ~20 `setStatusBarMessage` sites (the sync verbs were done in #12).
- **Protected / entry-program affordance** — a visual marker on programs the controller starts
  itself, even though the verbatim gate is the enforcement.
- **Auto-fetch on open** — refresh a container working file's snapshot when it is opened and its
  own robot is connected, so the sync marker reflects the controller without a manual Fetch.
  Opt-in setting (default off) to keep the live tier's **no background requests** guarantee;
  debounce, per-file in-flight guard, skip window-reload / pinned preview. Not scheduled.
