# RUKUS Robotic Extensions ⟷ RUKUS

Two directions: RUKUS installs the extension (below), and the extension hands work
back to RUKUS through a `rukus://` link (next section).

## The `rukus://` protocol — extension → RUKUS

The extension is the *editor*. Live monitoring, alarm history and scheduled backups are
cell management, which is RUKUS's job — so instead of building weaker copies of those
screens in a webview, the Robots view has buttons that open the real ones.

### The contract

```
rukus://<route>?robot=<display name>&host=<ip>&path=<folder>
```

| Route      | Opens in RUKUS                  | Fired by |
|------------|---------------------------------|----------|
| `monitor`  | Production Dashboard            | "Live monitor" on a robot |
| `alarms`   | Error Watcher                   | "Alarm history" on a robot |
| `backup`   | Backup Scheduler                | "Scheduled backups", and after a backup pull |
| `schedule` | Backup Scheduler                | (alias of `backup`) |
| `diff`     | Compare Robots                  | reserved, not yet wired to a button |
| `home`     | nothing — just brings RUKUS up  | "Open RUKUS" in the view title bar |

All parameters are optional. `robot` is matched against `RobotName` first, then `host`
against `IPAddress`; a robot RUKUS does not have is logged and the window still opens.

**A route may only ever open a window.** A custom URI scheme is reachable from any web
page the user clicks, so nothing on this list writes to a robot, starts a backup or
changes a setting. If a future route would, it does not belong in a link.

### The two sides

- **Extension**: `packages/core/src/rukus/launch.ts`. Builds the URI and fires it with
  `vscode.env.openExternal`. Before firing it checks that the protocol is registered
  (`HKCU\Software\Classes\rukus`, then `HKLM`); when it is not, the user gets the
  RUKUS download link instead of a Windows "how do you want to open this" dialog.
  Off switch: `robotCode.rukus.enabled`.
- **RUKUS**: `Helpers/DeepLinkHelper.cs` parses, `Models/DeepLink.cs` carries,
  `Views/MainWindow.xaml.cs` (Deep links region) routes through `IAppActionRegistry` —
  the same delegates Ctrl+K runs, so there is one list of how to open each window.
  Registered by `Installer/RUKUS.iss` `[Registry]`, because the app is **unpackaged**
  (`WindowsPackageType=None`) and its appxmanifest is never read.

### Single instance

A link fired while RUKUS is already open **steers the running one**. `Program.cs` in the
RUKUS repo replaces the XAML-generated `Main`: a second launch hands its activation to
the first through `AppInstance.FindOrRegisterForKey` and exits without ever showing a
window. Without it every link gave you a second RUKUS — two windows, two schedulers, two
things holding the same FTP gate.

### Verified

2026-09-13, against a real per-user install of `0.9.0-beta.2`:
`rukus://monitor?robot=S002R01&host=127.0.0.5` opened Production Screen and
`rukus://alarms?robot=S002R05` opened Error Watcher, each with the named robot set
active. The pid did not change across the initial launch and both links.

---

## Installing RUKUS Robotic Extensions from RUKUS

> **Built, 2026-09-13** — RUKUS issue #27, branch `Push/#27-Install-VS-Code-Extension`.
> Settings ▸ Integrations ▸ VS Code, plus a Ctrl+K action. The `.vsix` lives at
> `Assets/VSCode/robot-code.vsix` in the RUKUS repo (LFS) and copies to both the build
> output and the publish folder, so the installer carries it and an offline PC can still
> install the extension. The version is read from `extension/package.json` *inside* the
> archive, so **updating the extension in RUKUS is a straight file swap** — no renaming.
> Since 0.12.8 `npm run release` in this repo does the swap and stages the file by name
> (never `git add -A` in RUKUS: the untracked installer in `Installer/Output/` would go too),
> and creates the GitHub release that keeps the same `.vsix` per version.
>
> `publisher` + `name` (`rukus-team.robot-code`) is the identity RUKUS detects by and
> must stay stable across versions. RUKUS logs a warning if the bundled payload ever
> stops matching what it expects.
>
> What follows is the reference RUKUS was built against.

The deliverable is a single file, `robot-code-<version>.vsix`, produced by
`npm run package`. It has no runtime npm dependencies, so nothing else needs to
be present on the target machine besides VS Code itself.

## What RUKUS has to do

1. **Ship the `.vsix`** as a content file (e.g. `Tools/vscode/robot-code.vsix`).
   Keep it out of git history the same way the installer payload is handled
   (LFS or build output) — it is ~200 KB now but will grow.

2. **Find VS Code.** In order of preference:
   - `code.cmd` on `PATH` (`where code.cmd`).
   - `%LOCALAPPDATA%\Programs\Microsoft VS Code\bin\code.cmd` (user install).
   - `%ProgramFiles%\Microsoft VS Code\bin\code.cmd` (system install).
   - Registry: `HKCU\Software\Classes\Applications\Code.exe\shell\open\command` or the
     `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\{771FD6B0-FA20-440A-A002-3B3BAC16DC50}_is1`
     (system) / `HKCU\...\Uninstall\{771FD6B0-FA20-440A-A002-3B3BAC16DC50}_is1` (user) keys, `InstallLocation`.
   - VS Code Insiders uses `code-insiders.cmd` and a different GUID; support optionally.

3. **Install / update:**
   ```
   code.cmd --install-extension "<path>\robot-code.vsix" --force
   ```
   `--force` upgrades silently when a version is already installed. Exit code 0 = success.
   Run it hidden (`CreateNoWindow`, redirected stdout) and log the output.

4. **Detect what is installed** (for the RUKUS UI):
   ```
   code.cmd --list-extensions --show-versions
   ```
   Look for a line `rukus-team.robot-code@0.1.0`. The publisher/name pair comes from
   `package.json` (`publisher` + `name`) and must stay stable across versions.

5. **Open a backup in VS Code** (nice touch after a backup download):
   ```
   code.cmd "<backup folder>"
   ```
   The extension activates on `.ls/.kl/.va` files and immediately indexes the folder,
   so registers, I/O comments and the macro table light up without any setup.

6. **Uninstall:** `code.cmd --uninstall-extension rukus-team.robot-code`.

## Settings RUKUS may want to pre-seed

Written to `%APPDATA%\Code\User\settings.json` (merge, don't overwrite):

```json
{
  "robotCode.karel.ktransPath": "C:\\Program Files (x86)\\FANUC\\WinOLPC\\bin\\ktrans.exe",
  "robotCode.karel.ktransVersion": "V9.40",
  "robotCode.data.backupFolders": ["D:\\Backups\\S002R01"]
}
```

`data.backupFolders` is how RUKUS can point the extension at its own backup store so
every workspace gets the controller data even when the user opens a single program file.

## Version bumps

`npm run version:id` sets this branch's version id (`YY.MT.DDIII`: `26.92.19005` is a bug fix
for issue #5, started on 19 September 2026; a release is `YY.M9.N`, `26.99.1` - see
`docs/VERSIONING.md`), add a `CHANGELOG.md` entry, `npm run package`. RUKUS uses the same
three-number shape since 2026-09-22 (before that it carried the type as a fourth number,
`26.9.13026.1`). The `.vsix` file name carries the version; RUKUS should compare it to
`--list-extensions` output and only reinstall when different. RUKUS compares the three numbers
numerically, so `26.91.21010` reads as newer than `26.9.21010`, `26.9.1` and the old `0.12.16`.
**It only installs a bundled extension that is newer**, and a working build's id is ordered by
the day the work started, not the day it ships - so `npm run release` refuses a version that is
not higher than every tag already released.

## Clusters and the backup store - extension reads RUKUS's data (2026-09-22)

The extension never keeps its own list of robots when RUKUS is on the PC. It reads RUKUS's
files, and RUKUS is the store of record:

| RUKUS | How the extension finds it |
| --- | --- |
| Data root | `Documents\RUKUS`; for a portable RUKUS the folder its `RUKUS.portable` marker names (empty marker = `RUKUS-Data` beside the exe); `robotCode.rukus.dataFolder` overrides |
| `AppSettings.json` | `CustomClustersFolderPath`, `CustomBackupsFolderPath` (used when reachable, as RUKUS does), `BackupBatchFolderTemplate`, `BackupRobotFolderTemplate` |
| `Clusters\<name>.json` | one cluster; the file name is the cluster's name; `Robots[]` with `RobotName`, `IPAddress`, `FTPUser`, `FTPPassword`, `FTPDirectory` |
| `Backups\<cluster>\Latest\<robot folder>` and `Backups\<cluster>\<robot>\<batch>` | the workspace when a cluster is clicked; Latest first in the views |

What the extension does with it:

- **RUKUS Clusters view**: every cluster and its robots. Click = that cluster's backup
  folder becomes the workspace and its robots go into `.robocode-cell\cell.json` there
  (`name`, `controllers[<RobotName>] = { host, ftpUser, device }`, plus a `rukus` block naming
  the cluster). The FTP password is copied into VS Code secret storage once, never into a file.
- **Watching**: `Clusters\*.json` and `AppSettings.json` are watched; the open cell is re-synced.
- **Send Cell to RUKUS**: the cell's controllers merged into `Clusters\<cell name>.json`.
  Existing robots keep every field the cell does not know; a robot the cell does not name is
  kept; a new controller becomes a Fanuc robot with RUKUS's defaults. A copy of the previous
  file goes to `Clusters\Backups\<name>_backup_<stamp>.json` first, and `SavedUtc`/`SavedBy`
  are stamped (`user@machine (Robot Code)`). RUKUS picks the file up when its cluster list is
  refreshed or at its next start.
- **Backups the extension takes** land in `<backups root>\<cluster>\<robot>\<batch>\` with a
  `rukus-backup.json` (schema 1) inside, `RukusVersion` = `Robot Code <version>`. Never in
  `Latest`.
- **Naming**: the robot-folder template is compiled to a matcher, so folders named by any
  template RUKUS is set to are read by name and treated as backups.

If RUKUS changes the shape of a cluster file or the templates' tokens, `packages/core/src/rukus/store.ts`
is the one place on this side, and `test/rukusStore.test.ts` carries the cases from RUKUS's
`BackupNamingHelperTests`.

## The link into the editor - RUKUS -> extension (2026-09-22)

The other direction of `rukus://`. RUKUS's Cluster menu has **Open Cluster in Robot Code**; it
fires a `vscode://` link that VS Code routes to this extension's URI handler
(`packages/core/src/rukus/clusters.ts`; RUKUS builds it in `RUKUS.Core/Helpers/RobotCodeLinkHelper.cs`):

| Link | Does |
| --- | --- |
| `vscode://rukus-team.robot-code/cluster?name=<cluster>` | that cluster's backup folder becomes the workspace, its robots go into `cell.json` (the same as clicking it in the RUKUS Clusters view) |
| `vscode://rukus-team.robot-code/sync` | the open cell is re-read from RUKUS's cluster file |

Rules, the same as for `rukus://`: a link can be fired from any web page, so a route only opens
or re-reads, the cluster has to be one RUKUS actually has on this PC, and nothing writes to a
robot. RUKUS checks first that VS Code and the extension are installed (`IVsCodeService
.GetStatusAsync`), because a link to an extension VS Code does not have opens a marketplace
search that cannot find a private extension. The extension declares `onUri` so a link wakes it.

## The write lock and the audit log - one record of every write

- **RUKUS's per-robot write lock holds in the editor.** `IsWriteLocked` in the cluster file
  makes Upload Program and Live Edit refuse that robot, with a message naming RUKUS.
- **Every upload from the editor goes into RUKUS's `WriteAuditLog.jsonl`** (in RUKUS's data
  root), one line in `AuditEntry`'s own field names: `TargetKind` `Program`, `TargetAddress`
  `MD:NAME.LS`, `TargetLabel` the local file, `NewValue` the byte count and a SHA-256 prefix,
  `Result` `Ok` / `Failed` / `Refused`, `Origin` `RobotCode/UploadProgram` or
  `RobotCode/LiveEdit`, `RukusUser` and `RukusRole` null (the extension has no RUKUS sign-in).
  RUKUS's audit view, its diagnostics bundle and its `.jsonl` readers see them like RUKUS's own.
