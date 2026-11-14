/** Renaming a program's file renames the program inside it (see programName.ts) */
import * as vscode from 'vscode';
import { config } from '@core/util';
import { headerEditsForFileRename, fileBaseName } from './programName';

/**
 * F2 on the /PROG name renames the file itself and writes the header itself; for that one
 * rename the hook below stands aside, or the same span would be edited twice. (Short-lived: a
 * rename that was previewed and cancelled must not switch the hook off for the next one.)
 */
const byProvider = new Map<string, number>();
export function renameHandlesHeader(oldUri: vscode.Uri): void { byProvider.set(oldUri.toString(), Date.now()); }
function handledByRename(oldUri: vscode.Uri): boolean {
  const at = byProvider.get(oldUri.toString());
  byProvider.delete(oldUri.toString());
  return at !== undefined && Date.now() - at < 60_000;
}

export function registerProgramRename(): vscode.Disposable {
  return vscode.workspace.onWillRenameFiles(e => {
    // only a file whose NAME changes: moving a folder of programs opens none of them
    const files = e.files.filter(f => /\.(ls|kl)$/i.test(f.oldUri.path) && /\.(ls|kl)$/i.test(f.newUri.path)
      && fileBaseName(f.oldUri.path).toUpperCase() !== fileBaseName(f.newUri.path).toUpperCase() && !handledByRename(f.oldUri));
    if (!files.length || !config<boolean>('renameProgramWithFile', true)) return;
    // the edit is made in the file under its old name, as part of the rename (one undo)
    e.waitUntil((async () => {
      const edit = new vscode.WorkspaceEdit();
      for (const f of files) {
        try {
          const doc = await vscode.workspace.openTextDocument(f.oldUri);
          for (const x of headerEditsForFileRename(f.oldUri.path, f.newUri.path, doc.getText())) {
            edit.replace(f.oldUri, new vscode.Range(x.line, x.col, x.line, x.col + x.len), x.newText);
          }
        } catch { /* a binary under a .ls name, or gone: nothing to carry over */ }
      }
      return edit;
    })());
  });
}
