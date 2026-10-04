import * as vscode from 'vscode';
import { FanucServices } from '@fanuc/services';
import { registerBrand } from '@core/brand';
import { fanucBrand } from '@fanuc/brand';
import { registerTpProviders } from '@fanuc/tp/providers';
import { registerTpDiagnostics } from '@fanuc/tp/diagnostics';
import { registerTpCommands } from '@fanuc/tp/commands';
import { registerKarelProviders } from '@fanuc/karel/providers';
import { ktransDiagnostics } from '@fanuc/karel/ktrans';
import { registerViews } from '@fanuc/views/trees';
import { openRegisterTable } from '@fanuc/data/registerTable';
import { registerLive } from '@core/live';
import { registerEditorCommands } from '@fanuc/live/editorCommands';
import { registerOptionsView } from '@fanuc/live/optionsView';
import { registerRunningLine } from '@fanuc/live/runningLine';
import { installFanucRegisterReaders } from '@fanuc/live/registerReaders';
import { registerTools } from '@fanuc/tools';
import { registerLiveDecorations } from '@fanuc/tp/liveDecorations';
import { registerTypeDecorations } from '@fanuc/tp/typeDecorations';
import { registerContextStatus } from '@fanuc/views/statusBar';
import { SysVarsReference, registerSysVarProviders } from '@fanuc/data/sysVarsReference';
import { registerContainerCommands } from '@core/containerCommands';
import { registerSyncCommands, registerSyncOnOpen } from '@core/syncCommands';
import { registerSnapshotDiffCommands } from '@fanuc/snapshotDiff';
import { registerFeatureFinder } from '@core/views/featureFinder';
import { registerFileIcons } from '@core/fileIcons';
import { registerRukusClusters } from '@core/rukus/clusters';
import { windowFolders, setWindowFolders } from '@core/util';

const sameFolder = (a: string, b: string) => a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase();

export function activate(ctx: vscode.ExtensionContext) {
  // Brands first: the services' file watchers and indexes are built from what they register.
  registerBrand(fanucBrand);
  installFanucRegisterReaders();
  const s = new FanucServices();
  s.sysvars = new SysVarsReference(ctx.extensionPath, s.output);
  ctx.subscriptions.push(s, ktransDiagnostics);
  registerSysVarProviders(ctx, s.sysvars);

  // FANUC modules. Another robot brand would register its own set here.
  registerTpProviders(ctx, s);
  registerTpDiagnostics(ctx, s);
  registerTpCommands(ctx, s);
  registerKarelProviders(ctx, s);
  s.live = registerLive(ctx, s);
  registerRunningLine(ctx, s, s.live);       // FANUC: the TP line a task was executing
  registerEditorCommands(ctx, s, s.live);   // FANUC: teach from the robot, compare with the controller
  registerOptionsView(ctx, s, s.live);      // FANUC: the controller's software options (ORDERFIL.DAT)
  s.live.cellRootResolver = () => s.containers.cells[0]?.root;
  s.rukus = registerRukusClusters(ctx, s);
  registerViews(ctx, s);
  registerTools(ctx, s);
  registerLiveDecorations(ctx, s);
  registerTypeDecorations(ctx, s);
  registerContextStatus(ctx, s);
  registerContainerCommands(ctx, s);
  registerSyncCommands(ctx, s);
  registerSyncOnOpen(ctx, s);
  registerSnapshotDiffCommands(ctx, s);
  registerFeatureFinder(ctx);
  registerFileIcons(ctx);

  ctx.subscriptions.push(
    vscode.commands.registerCommand('robotCode.data.refresh', async () => {
      await s.containers.refresh();
      // Merge cell-defined controllers into RobotManager
      const defs = s.containers.controllerDefs();
      if (s.live && Object.keys(defs).length) s.live.mergeCellProfiles(defs);
      await Promise.all([s.data.refresh(), s.index.refresh()]);
      const warn = s.containers.warnings.length ? ` (${s.containers.warnings.length} container warning(s))` : '';
      vscode.window.setStatusBarMessage(`Robot Code: ${s.index.programCount} programs in ${s.index.groups().size} folder(s); controller data for ${s.data.datasets.length} robot folder(s)${warn}`, 5000);
    }),
    vscode.commands.registerCommand('robotCode.data.openRegisterTable', () => openRegisterTable(ctx, s)),
    // a folder argument comes from a suggestion row in the empty Registers view (issue #3, 1c)
    vscode.commands.registerCommand('robotCode.data.addBackupFolder', async (given?: string | vscode.Uri) => {
      let folder = typeof given === 'string' ? given : given instanceof vscode.Uri ? given.fsPath : undefined;
      if (!folder) {
        const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, title: 'Select a controller backup folder (contains numreg.va, posreg.va, …)' });
        if (!picked?.[0]) return;
        folder = picked[0].fsPath;
      }
      await setWindowFolders('data.backupFolders', [...windowFolders('data.backupFolders'), folder]);
      // adding a folder back is the way to undo having removed it
      await setWindowFolders('data.hiddenBackupFolders', windowFolders('data.hiddenBackupFolders').filter(h => !sameFolder(h, folder)));
      await Promise.all([s.data.refresh(), s.index.refresh()]);
    }),
    /**
     * Take a backup out of the Backup panel (and its programs out of the program views). A
     * folder added with Add Backup Folder comes off that list; one that is inside the
     * workspace, or inside an added folder, is hidden instead - nothing on disk is touched.
     */
    vscode.commands.registerCommand('robotCode.data.removeBackupFolder', async (node?: { ds?: { folder: string; label: string } }) => {
      let folder = node?.ds?.folder, label = node?.ds?.label;
      if (!folder) {
        const pick = await vscode.window.showQuickPick(s.data.datasets.map(d => ({ label: d.label, description: d.folder, folder: d.folder })), { placeHolder: 'Backup to remove from the Backup panel' });
        if (!pick) return;
        folder = pick.folder; label = pick.label;
      }
      const listed = windowFolders('data.backupFolders');
      if (listed.some(f => sameFolder(f, folder!))) await setWindowFolders('data.backupFolders', listed.filter(f => !sameFolder(f, folder!)));
      else await setWindowFolders('data.hiddenBackupFolders', [...windowFolders('data.hiddenBackupFolders'), folder]);
      await Promise.all([s.data.refresh(), s.index.refresh()]);
      const undo = await vscode.window.showInformationMessage(`${label ?? folder} removed from the Backup panel. The files on disk are untouched.`, 'Undo');
      if (undo) {
        if (listed.some(f => sameFolder(f, folder!))) await setWindowFolders('data.backupFolders', listed);
        else await setWindowFolders('data.hiddenBackupFolders', windowFolders('data.hiddenBackupFolders').filter(h => !sameFolder(h, folder!)));
        await Promise.all([s.data.refresh(), s.index.refresh()]);
      }
    }),
    vscode.commands.registerCommand('robotCode.data.restoreBackupFolders', async () => {
      const hidden = windowFolders('data.hiddenBackupFolders');
      if (!hidden.length) { vscode.window.showInformationMessage('No backups have been removed from the Backup panel in this window.'); return; }
      const picks = await vscode.window.showQuickPick(hidden.map(h => ({ label: h.split(/[\\/]/).pop() ?? h, description: h, folder: h })), { canPickMany: true, placeHolder: 'Backups to show again' });
      if (!picks?.length) return;
      await setWindowFolders('data.hiddenBackupFolders', hidden.filter(h => !picks.some(p => p.folder === h)));
      await Promise.all([s.data.refresh(), s.index.refresh()]);
    }),
  );
  // says once in Output when a user-level folder list is being ignored
  windowFolders('data.backupFolders', s.output);

  // A backup-level note for constructs the parser only guessed at, so it is seen once even
  // when nobody opens the file that has them.
  s.index.onRefreshed = report => { for (const line of report) s.output.appendLine(`[Robot Code] warning: ${line}`); };

  // Initial scan in the background; nothing blocks activation.
  // Containers must refresh first so markers are known before the index runs.
  void s.containers.refresh().then(() => {
    // Merge cell-defined controllers into RobotManager
    const defs = s.containers.controllerDefs();
    if (s.live && Object.keys(defs).length) s.live.mergeCellProfiles(defs);
    return Promise.all([s.data.refresh(), s.index.refresh()]);
  }).then(() => {
    if (s.containers.warnings.length) {
      for (const w of s.containers.warnings) s.output.appendLine(`[Robot Code] container: ${w}`);
    }
    s.output.appendLine(`[Robot Code] indexed ${s.index.programCount} programs in ${s.index.groups().size} folder(s); controller data: ${s.data.datasets.map(d => `${d.label} (${d.sources.length} files)`).join(', ') || 'none'}`);
  }).catch(err => {
    s.output.appendLine(`[Robot Code] initialization error: ${err instanceof Error ? err.message : String(err)}`);
  });
}

export function deactivate() { /* disposables handle cleanup */ }
