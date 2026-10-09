/**
 * Which brands the Robot Code side bar shows. A FANUC-only workspace shows the FANUC views, an
 * ABB-only one the ABB views, a mixed one both. An empty workspace shows both and, the first time
 * the side bar is opened, asks which the user works with; the answer is kept for that workspace.
 *
 * `robotCode.views.brands` overrides it: auto (the default) / fanuc / abb / both. The views read the
 * context keys robotCode.hideFanuc and robotCode.hideAbb (unset = shown, so nothing is hidden
 * before this runs).
 *
 * ABB support itself is still behind robotCode.abb.enabled: a workspace with ABB backups while it
 * is off is offered the switch once (it takes a window reload).
 */
import * as vscode from 'vscode';
import type { Services } from '@core/services';
import { config } from '@core/util';
import { onDidShowRobotCodeView } from '@core/views/viewVisibility';

type Choice = 'auto' | 'fanuc' | 'abb' | 'both';
const ASKED = 'robotCode.views.brandsAsked';
const OFFERED_ABB = 'robotCode.views.abbOffered';

async function present(s: Services): Promise<{ fanuc: boolean; abb: boolean }> {
  const list = s.index.list();
  let fanuc = list.some(p => p.brand === 'fanuc');
  let abb = list.some(p => p.brand === 'abb');
  const any = async (glob: string) => (await vscode.workspace.findFiles(glob, '**/{node_modules,.git,.vscode-test}/**', 1)).length > 0;
  if (!fanuc) fanuc = await any('**/*.{ls,LS,tp,TP,va,VA,kl,KL,pc,PC}');
  // ABB brand off: its files are not indexed, so look for them directly
  if (!abb) abb = (await any('**/BACKINFO/backinfo.txt')) || (await any('**/*.{mod,MOD,prg,PRG,modx,sysx}'));
  return { fanuc, abb };
}

export function registerBrandViews(ctx: vscode.ExtensionContext, s: Services, loaded: { fanuc: boolean; abb: boolean }): void {
  const abbLoaded = loaded.abb;
  let needsAsk = false;
  let busy = false;
  /** the side bar has been seen open: ask as soon as the workspace is known to be empty */
  let shown = false;

  let current = { fanuc: true, abb: true };
  const set = async (fanuc: boolean, abb: boolean) => {
    current = { fanuc, abb };
    await vscode.commands.executeCommand('setContext', 'robotCode.hideFanuc', !fanuc);
    await vscode.commands.executeCommand('setContext', 'robotCode.hideAbb', !abb);
  };

  const apply = async () => {
    const choice = config<Choice>('views.brands', 'auto');
    if (choice !== 'auto') { needsAsk = false; await set(choice !== 'abb', choice !== 'fanuc'); return; }
    const p = await present(s);
    needsAsk = !p.fanuc && !p.abb && !!vscode.workspace.workspaceFolders?.length && !ctx.workspaceState.get(ASKED);
    if (p.fanuc || p.abb) await set(p.fanuc, p.abb);
    else await set(true, true);
    // ABB support loads at start when the workspace has ABB files; files that arrive later, or a setting
    // that turned it off, get one offer (loading it takes a window reload)
    if (p.abb && !abbLoaded && !ctx.workspaceState.get(OFFERED_ABB)) {
      await ctx.workspaceState.update(OFFERED_ABB, true);
      const off = vscode.workspace.getConfiguration('robotCode').inspect<boolean>('abb.enabled');
      const explicitlyOff = (off?.workspaceFolderValue ?? off?.workspaceValue ?? off?.globalValue) === false;
      const go = await vscode.window.showInformationMessage(`This workspace has ABB RAPID files${p.fanuc ? ' as well as FANUC ones' : ''}${explicitlyOff ? ', but robotCode.abb.enabled is off' : ''}. Turn on ABB support (RAPID views, controllers, linting)? The window reloads.`, 'Turn on ABB', 'Not now');
      if (go === 'Turn on ABB') {
        await vscode.workspace.getConfiguration('robotCode').update('abb.enabled', true, vscode.workspace.workspaceFolders ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global);
        await vscode.commands.executeCommand('workbench.action.reloadWindow');
      }
    }
  };

  const ask = async () => {
    if (!needsAsk || busy) return;
    busy = true;
    try {
      const pick = await vscode.window.showQuickPick([
        { label: 'FANUC', description: 'TP and KAREL programs, robot backups', value: 'fanuc' as const },
        { label: 'ABB', description: 'RAPID modules, IRC5 / OmniCore backups', value: 'abb' as const },
        { label: 'Both', description: 'a mixed-brand cell', value: 'both' as const },
      ], { title: 'RUKUS: which robots do you work with in this folder?', placeHolder: 'The side bar shows that brand\'s views. Change it later with robotCode.views.brands.', ignoreFocusOut: true });
      await ctx.workspaceState.update(ASKED, true);
      needsAsk = false;
      if (!pick) return;
      const target = vscode.workspace.workspaceFolders ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
      await vscode.workspace.getConfiguration('robotCode').update('views.brands', pick.value, target);
      if (pick.value !== 'fanuc' && !abbLoaded) {
        const go = await vscode.window.showInformationMessage('ABB support is still off. Turn it on? The window reloads.', 'Turn on ABB', 'Not now');
        if (go === 'Turn on ABB') {
          await vscode.workspace.getConfiguration('robotCode').update('abb.enabled', true, target);
          await vscode.commands.executeCommand('workbench.action.reloadWindow');
        }
      }
    } finally { busy = false; }
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const soon = () => { if (timer) clearTimeout(timer); timer = setTimeout(() => void apply(), 1500); };
  ctx.subscriptions.push(
    onDidShowRobotCodeView(() => { shown = true; void ask(); }),
    s.index.onDidChange(soon),
    vscode.workspace.onDidChangeWorkspaceFolders(soon),
    vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('robotCode.views.brands') || e.affectsConfiguration('robotCode.abb.enabled')) void apply(); }),
    { dispose: () => { if (timer) clearTimeout(timer); } },
  );
  // for the smoke tests: which brands the side bar shows, after detection has settled
  ctx.subscriptions.push(vscode.commands.registerCommand('robotCode.views._brands', async () => { await apply(); return { ...current, needsAsk, loaded }; }));
  void apply().then(() => { if (shown) void ask(); });
}
