/**
 * Feature profiles in VS Code (the rules are packages/core/src/features.ts):
 * - "Robot Code: Choose Feature Profile..." picks All, FANUC only, ABB only, Auto, or Custom - then
 *   each feature On, Off or Auto;
 * - `robotCode.featureProfile` changed in Settings applies the same way;
 * - a feature setting changed by hand so that it no longer fits the profile turns the profile to
 *   Custom, so the setting never claims a preset that is not in force.
 * Written where the profile is (a workspace's settings when a folder is open, as the brand switches
 * are); a change of brand takes a window reload, which is offered.
 */
import * as vscode from 'vscode';
import { FEATURES, PROFILES, profileWrites, profileOf, modeOf, valueOf, type ProfileId, type FeatureMode } from '@core/features';

const SECTION = 'robotCode';
const cfg = () => vscode.workspace.getConfiguration(SECTION);
const target = () => (vscode.workspace.workspaceFolders ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global);
/** a feature setting as set at any level (unset = Auto) */
const explicit = (key: string) => { const i = cfg().inspect<boolean>(key); return i?.workspaceFolderValue ?? i?.workspaceValue ?? i?.globalValue; };
const current = () => Object.fromEntries(FEATURES.map(f => [f.setting, explicit(f.setting)]));

export function registerFeatureProfiles(ctx: vscode.ExtensionContext): void {
  let applying = false;

  const write = async (writes: { setting: string; value: unknown }[]): Promise<boolean> => {
    const before = current();
    applying = true;
    try { for (const w of writes) await cfg().update(w.setting, w.value, target()); } finally { applying = false; }
    const after = current();
    return FEATURES.some(f => f.reload && before[f.setting] !== after[f.setting]);
  };
  const offerReload = async (needed: boolean) => {
    if (needed && await vscode.window.showInformationMessage('Robot Code: the brands change after a window reload.', 'Reload Window') === 'Reload Window') {
      await vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
  };
  const setProfile = async (id: ProfileId) => { applying = true; try { await cfg().update('featureProfile', id, target()); } finally { applying = false; } };

  ctx.subscriptions.push(vscode.commands.registerCommand('robotCode.chooseFeatureProfile', async (id?: ProfileId, modes?: Record<string, FeatureMode>) => {
    const now = profileOf(current());
    let pick = id;
    if (!pick) {
      const chosen = await vscode.window.showQuickPick(PROFILES.map(p => ({ label: p.label, description: p.id === now ? 'current' : undefined, detail: p.detail, id: p.id })), { title: 'Robot Code: feature profile' });
      if (!chosen) return;
      pick = chosen.id;
    }
    if (pick !== 'custom') { const reload = await write(profileWrites(pick)); await setProfile(pick); await offerReload(reload); return; }
    // Custom: each feature On / Off / Auto, starting from what is set
    const writes: { setting: string; value: unknown }[] = [];
    for (const f of FEATURES) {
      let m = modes?.[f.id];
      if (!m && !modes) {
        const was = modeOf(explicit(f.setting));
        const got = await vscode.window.showQuickPick((['on', 'off', 'auto'] as FeatureMode[]).map(x => ({ label: x === 'on' ? 'On' : x === 'off' ? 'Off' : 'Auto', description: [x === was ? 'current' : '', x === 'auto' ? f.auto : ''].filter(Boolean).join(' · '), x })), { title: `${f.label}` });
        if (!got) return;
        m = got.x;
      }
      if (m) writes.push({ setting: f.setting, value: valueOf(m) });
    }
    const reload = await write(writes);
    await setProfile(profileOf(current()) === 'custom' ? 'custom' : profileOf(current()));
    await offerReload(reload);
  }));

  ctx.subscriptions.push(vscode.workspace.onDidChangeConfiguration(async e => {
    if (applying || !e.affectsConfiguration(SECTION)) return;
    const chosen = cfg().get<ProfileId>('featureProfile', 'auto');
    if (e.affectsConfiguration(`${SECTION}.featureProfile`)) {
      // picked in Settings: apply it, unless the features already amount to it
      if (chosen !== 'custom' && profileOf(current()) !== chosen) await offerReload(await write(profileWrites(chosen)));
      return;
    }
    if (FEATURES.some(f => e.affectsConfiguration(`${SECTION}.${f.setting}`)) && chosen !== 'custom' && profileOf(current()) !== chosen) await setProfile('custom');
  }));
}
