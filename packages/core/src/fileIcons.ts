/**
 * The FANUC file icons, on by default.
 *
 * Every FANUC type has a language icon (contributes.languages[].icon), but a file icon theme's
 * own extension table beats that: Seti and vscode-icons both map `.ls` to LiveScript, and no
 * language may claim `.txt`. So the extension also ships a THEME - Seti with the FANUC types on
 * top (scripts/make-file-icons.mjs) - and, since whoever installs a FANUC extension wants FANUC
 * files to look like FANUC files, switches to it the first time it runs. `robotCode.fileIcons.enabled`
 * (default on) is the way out: off puts back the theme the person had.
 *
 * Rules, so this never fights the person:
 *  - the switch happens ONCE. If they pick another theme afterwards, that stands; turning the
 *    setting off and on again is the deliberate way to come back.
 *  - off restores exactly what was there: the previous user-level value, or none, so VS Code's
 *    default (Seti) shows again. Only the user-level setting is touched; a workspace-level
 *    `workbench.iconTheme` wins over it and is left alone.
 */
import * as vscode from 'vscode';

export const ICON_THEME_ID = 'robot-code-icons';
const SETTING = 'robotCode.fileIcons.enabled';
const KEY_PREVIOUS = 'fileIcons.previousTheme';   // the user-level workbench.iconTheme before we switched (null = none)
const KEY_APPLIED = 'fileIcons.applied';          // we switched once already; a different theme now is their choice

export function registerFileIcons(ctx: vscode.ExtensionContext): void {
  void applyFileIconSetting(ctx, 'activation');
  ctx.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
    if (e.affectsConfiguration(SETTING)) void applyFileIconSetting(ctx, 'setting');
  }));
}

export async function applyFileIconSetting(ctx: vscode.ExtensionContext, reason: 'activation' | 'setting'): Promise<void> {
  const enabled = vscode.workspace.getConfiguration('robotCode').get<boolean>('fileIcons.enabled', true);
  const wb = vscode.workspace.getConfiguration('workbench');
  const current = wb.inspect<string | null>('iconTheme');
  const effective = wb.get<string | null>('iconTheme');
  try {
    if (enabled) {
      if (effective === ICON_THEME_ID) return;
      if (reason === 'activation' && ctx.globalState.get<boolean>(KEY_APPLIED)) return;   // they moved away on purpose
      await ctx.globalState.update(KEY_PREVIOUS, current?.globalValue ?? null);
      await wb.update('iconTheme', ICON_THEME_ID, vscode.ConfigurationTarget.Global);
      await ctx.globalState.update(KEY_APPLIED, true);
    } else {
      await ctx.globalState.update(KEY_APPLIED, false);
      if (current?.globalValue !== ICON_THEME_ID) return;   // not ours to undo
      const previous = ctx.globalState.get<string | null>(KEY_PREVIOUS, null);
      await wb.update('iconTheme', previous ?? undefined, vscode.ConfigurationTarget.Global);
    }
  } catch (e) {
    // settings.json open in another editor with a syntax error, or read-only: say so once, quietly
    console.warn(`Robot Code: could not change workbench.iconTheme: ${(e as Error).message}`);
  }
}
