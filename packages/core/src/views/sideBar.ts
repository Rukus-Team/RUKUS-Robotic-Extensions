/**
 * The side bar's layout (VSC test 2026-11-07, items 2/8/17/22): robot first, few views.
 *
 *   Cell             every robot of the cell: FANUC robots and ABB controllers, a brand badge on each
 *   Backups          Programs · PC programs · Macros · Data · RAPID, one collapsible row each
 *   RUKUS Clusters   (or "RUKUS Studio") the clusters to open as the workspace
 *   Snapshot         the robot containers' last known state
 *
 * The brands add their trees here (addCellSection / addBackupSection) instead of making views of
 * their own; core makes the views. The retired view ids (robotCode.programs, .pcPrograms, .macros,
 * .registers, .rapid, .abbControllers) keep their ".focus" commands, which now focus the view
 * their rows moved to. The merging itself is sectionedTree.ts (no vscode, tested).
 */
import * as vscode from 'vscode';
import { SectionedTreeCore, isGroupNode, liveSummary, type Section } from './sectionedTree';
import { watchViewVisibility } from './viewVisibility';

export type { Section } from './sectionedTree';

// ---- which brands the side bar shows (brandViews.ts decides; context keys robotCode.hideFanuc / hideAbb) ----

const shown = { fanuc: true, abb: true };
const brandChanged = new vscode.EventEmitter<void>();
export const onDidChangeShownBrands = brandChanged.event;
export function shownBrands(): Readonly<{ fanuc: boolean; abb: boolean }> { return shown; }
export function setShownBrands(fanuc: boolean, abb: boolean): void {
  if (shown.fanuc === fanuc && shown.abb === abb) return;
  shown.fanuc = fanuc; shown.abb = abb;
  brandChanged.fire();
}

// ---- the sections the brands contribute ----

const cellSections: Section[] = [];
const backupSections: Section[] = [];
/** rows for the Cell view, beside the FANUC robots (ABB's controllers) */
export function addCellSection(s: Section): void { cellSections.push(s); }
/** a top-level row of the Backups view */
export function addBackupSection(s: Section): void { backupSections.push(s); }
export function contributedCellSections(): Section[] { return [...cellSections]; }

/** the view ids that were folded into Cell and Backups, and where their rows are now */
export const RETIRED_VIEWS: Record<string, string> = {
  'robotCode.programs': 'robotCode.backups',
  'robotCode.pcPrograms': 'robotCode.backups',
  'robotCode.macros': 'robotCode.backups',
  'robotCode.registers': 'robotCode.backups',
  'robotCode.rapid': 'robotCode.backups',
  'robotCode.abbControllers': 'robotCode.cell',
};

type ChangeSource = { onDidChangeTreeData?: vscode.Event<unknown> };

export class SectionedTree implements vscode.TreeDataProvider<unknown>, vscode.Disposable {
  readonly core: SectionedTreeCore;
  private readonly changed = new vscode.EventEmitter<unknown>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly subs: vscode.Disposable[] = [];

  constructor(sections: Section[]) {
    this.core = new SectionedTreeCore(sections);
    for (const s of this.core.all()) {
      const ev = (s.provider as ChangeSource).onDidChangeTreeData;
      // A row that changed is passed on as it is (it is the provider's own element); anything
      // wider redraws the view, which also redraws the group rows' summaries and the badges.
      if (ev) this.subs.push(ev(e => this.changed.fire(e && typeof e === 'object' && !Array.isArray(e) && this.core.ownerOf(e) ? e : undefined)));
    }
    this.subs.push(onDidChangeShownBrands(() => this.refresh()));
  }

  refresh(): void { this.changed.fire(undefined); }
  dispose(): void { for (const d of this.subs) d.dispose(); this.changed.dispose(); }

  getChildren(el?: unknown): Promise<unknown[]> { return this.core.children(el); }

  async getTreeItem(el: unknown): Promise<vscode.TreeItem> {
    return (await this.core.item(el, s => {
      const it = new vscode.TreeItem(s.label ?? s.id, s.expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
      // a stable id: VS Code keeps the user's expanded/collapsed choice per row across reloads
      it.id = `robotCode.sideBar.${s.id}`;
      it.contextValue = `backups-group-${s.id}`;
      it.description = s.description?.() || undefined;
      if (s.tooltip) it.tooltip = s.tooltip;
      if (s.icon) it.iconPath = new vscode.ThemeIcon(s.icon);
      return it;
    })) as unknown as vscode.TreeItem;
  }
}

/** the Cell view: the FANUC robots (`primary`) and every section a brand added, merged */
export function createCellView(ctx: vscode.ExtensionContext, primary: Section): { view: vscode.TreeView<unknown>; tree: SectionedTree; summary: () => string } {
  const tree = new SectionedTree([primary, ...cellSections]);
  const view = vscode.window.createTreeView('robotCode.cell', { treeDataProvider: tree, showCollapseAll: true });
  ctx.subscriptions.push(tree, watchViewVisibility(view));
  return { view, tree, summary: () => liveSummary(tree.core.all() as Section[]) };
}

/** the Backups view, from the sections the brands added; call after every brand has registered */
export function registerBackupsView(ctx: vscode.ExtensionContext): SectionedTree | undefined {
  // retired views: their ".focus" commands still work, and land on the view their rows moved to
  for (const [old, now] of Object.entries(RETIRED_VIEWS)) {
    // (a window still running the old manifest has VS Code's own command of that name until it reloads)
    try { ctx.subscriptions.push(vscode.commands.registerCommand(`${old}.focus`, () => vscode.commands.executeCommand(`${now}.focus`))); } catch { /* VS Code's own */ }
  }
  const declared = ((ctx.extension.packageJSON?.contributes?.views?.robotCode ?? []) as Array<{ id: string }>).some(v => v.id === 'robotCode.backups');
  if (!declared || !backupSections.length) return undefined;
  const tree = new SectionedTree(backupSections);
  const view = vscode.window.createTreeView('robotCode.backups', { treeDataProvider: tree, showCollapseAll: true });
  ctx.subscriptions.push(tree, watchViewVisibility(view),
    // hidden: what the Backups view shows, for the smoke test - the group rows and their summaries
    vscode.commands.registerCommand('robotCode.views._backups', async () => {
      const rows: string[] = [];
      for (const el of await tree.getChildren()) {
        const it = await tree.getTreeItem(el);
        rows.push(`${typeof it.label === 'string' ? it.label : it.label?.label ?? ''}${it.description ? ` — ${it.description}` : ''}${isGroupNode(el) ? '' : ' (row)'}`);
      }
      return rows;
    }));
  return tree;
}
