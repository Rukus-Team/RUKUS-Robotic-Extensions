/**
 * "What Can I Do Here?" - one picker with every feature, grouped by intent, each with its
 * keyboard shortcut. Titles, icons and keys are read from the running manifest, so the list
 * cannot drift from what is actually installed; the grouping is `FEATURE_GROUPS`.
 */
import * as vscode from 'vscode';
import { FEATURE_GROUPS, prettyKey } from './featureGroups';
import { robotConnectionsEnabled } from '../experimental';

/** the commands that talk to a controller: left out while the experimental switch is off */
const ROBOT_COMMAND = /^robotCode\.(live\.|tp\.teachPosition$|tp\.recordPosition$|data\.snapshotFromRobot$)/;

interface ManifestCommand { command: string; title: string; icon?: string }
interface ManifestKey { command: string; key: string }
type Item = vscode.QuickPickItem & { run?: string; args?: unknown[] };

export function registerFeatureFinder(ctx: vscode.ExtensionContext) {
  ctx.subscriptions.push(vscode.commands.registerCommand('robotCode.showFeatures', async () => {
    const contributes = ctx.extension.packageJSON?.contributes ?? {};
    const titles = new Map<string, ManifestCommand>(((contributes.commands ?? []) as ManifestCommand[]).map(c => [c.command, c]));
    const keys = new Map<string, string>();
    for (const k of (contributes.keybindings ?? []) as ManifestKey[]) if (!keys.has(k.command)) keys.set(k.command, prettyKey(k.key));

    const tp = vscode.window.activeTextEditor?.document.languageId === 'fanuc-tp';
    const robots = robotConnectionsEnabled();
    const items: Item[] = [];
    for (const g of FEATURE_GROUPS) {
      const ids = g.commands.filter(id => robots || !ROBOT_COMMAND.test(id));
      if (!ids.length) continue;
      items.push({ label: g.title, kind: vscode.QuickPickItemKind.Separator });
      for (const id of ids) {
        const c = titles.get(id);
        if (!c) continue;   // running against an older manifest until the window is reloaded
        const icon = typeof c.icon === 'string' && /^\$\(/.test(c.icon) ? `${c.icon} ` : '';
        const needsTp = /^robotCode\.tp\./.test(id) && id !== 'robotCode.tp.newProgram' && !tp;
        items.push({ label: `${icon}${c.title}`, description: [keys.get(id), needsTp ? 'open a TP program first' : ''].filter(Boolean).join('  ·  '), detail: undefined, run: id });
      }
    }
    items.push({ label: 'More', kind: vscode.QuickPickItemKind.Separator },
      { label: '$(keyboard) Change these keyboard shortcuts…', run: 'workbench.action.openGlobalKeybindings', args: ['Robot Code'] },
      { label: '$(settings-gear) Robot Code settings…', run: 'workbench.action.openSettings', args: ['@ext:' + ctx.extension.id] },
      { label: '$(mortar-board) Getting started walkthrough', run: 'workbench.action.openWalkthrough', args: [`${ctx.extension.id}#robotCode.gettingStarted`, false] });

    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Type what you want to do - teach, offset, compare, download, renumber…', matchOnDescription: true });
    if (pick?.run) await vscode.commands.executeCommand(pick.run, ...(pick.args ?? []));
  }));
}
