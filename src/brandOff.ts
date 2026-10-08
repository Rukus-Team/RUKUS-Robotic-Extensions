/**
 * A brand that did not load in this window (brandAuto.ts) still has its commands in menus and the
 * Command Palette: each answers with what is going on and offers to turn the brand on, instead of
 * VS Code's "command not found". Opening one of its files offers the same, once per window.
 * Turning a brand on writes robotCode.<brand>.enabled to the workspace and reloads the window.
 */
import * as vscode from 'vscode';

type Brand = 'fanuc' | 'abb';
const LABEL: Record<Brand, string> = { fanuc: 'FANUC', abb: 'ABB' };
const brandOf = (command: string): Brand => (/^robotCode\.(abb|rapid)\./.test(command) ? 'abb' : 'fanuc');

async function offer(brand: Brand, why: string): Promise<void> {
  const go = await vscode.window.showInformationMessage(`${why} ${LABEL[brand]} support is off in this workspace. Turn it on? The window reloads.`, `Turn on ${LABEL[brand]}`, 'Not now');
  if (!go || go === 'Not now') return;
  const target = vscode.workspace.workspaceFolders ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
  await vscode.workspace.getConfiguration('robotCode').update(`${brand}.enabled`, true, target);
  await vscode.commands.executeCommand('workbench.action.reloadWindow');
}

export function registerBrandOffStubs(ctx: vscode.ExtensionContext, on: Record<Brand, boolean>): void {
  void vscode.commands.executeCommand('setContext', 'robotCode.fanucOff', !on.fanuc);
  if (on.fanuc && on.abb) return;
  const contributed: string[] = (ctx.extension.packageJSON?.contributes?.commands ?? []).map((c: { command: string }) => c.command);
  void vscode.commands.getCommands(true).then(registered => {
    const have = new Set(registered);
    for (const id of contributed) {
      const brand = brandOf(id);
      if (on[brand] || have.has(id)) continue;
      ctx.subscriptions.push(vscode.commands.registerCommand(id, () => offer(brand, `That is a ${LABEL[brand]} command.`)));
    }
  });
  const offered = new Set<Brand>();
  const onOpen = (d: vscode.TextDocument) => {
    const brand: Brand | undefined = /^fanuc-(tp|karel)$/.test(d.languageId) ? 'fanuc' : d.languageId === 'abb-rapid' ? 'abb' : undefined;
    if (!brand || on[brand] || offered.has(brand) || d.uri.scheme === 'git') return;
    offered.add(brand);
    void offer(brand, `${d.uri.path.split('/').pop()} is a ${LABEL[brand]} program.`);
  };
  ctx.subscriptions.push(vscode.workspace.onDidOpenTextDocument(onOpen));
  for (const d of vscode.workspace.textDocuments) onOpen(d);
}
