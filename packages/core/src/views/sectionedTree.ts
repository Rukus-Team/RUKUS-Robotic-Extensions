/**
 * One side bar view made of several trees (VSC test 2026-11-07, items 2/8/17/22). Nine stacked
 * views each got a sliver, cut their help texts and pushed ABB Controllers off the bottom; now
 *
 *   Cell      FANUC robots and ABB controllers side by side ("flat" sections: their rows merge)
 *   Backups   Programs / PC programs / Macros / Data / RAPID as top-level rows ("grouped"
 *             sections: one collapsible row each, hidden while it has nothing to show)
 *
 * The trees keep their own elements: a row's element is the provider's own object, never a
 * wrapper, so every command a menu passes it to gets what it got before. Which provider owns an
 * element is remembered when the element is handed out. No vscode import: the view half
 * (sideBar.ts) gives it an event emitter and a way to make the group rows, and the tests drive
 * it with plain objects.
 */

export interface ItemLike {
  label?: unknown;
  description?: string | boolean;
}

export interface ProviderLike<T = any> {
  getChildren(element?: T): T[] | null | undefined | Thenable<T[] | null | undefined>;
  getTreeItem(element: T): ItemLike | Thenable<ItemLike>;
}

export interface Section<T = any> {
  /** stable id: the group row's id and contextValue suffix (`backups-group-<id>`) */
  id: string;
  provider: ProviderLike<T>;
  /** grouped: the row's label; flat sections (no label) put their rows straight into the view */
  label?: string;
  /** sort key inside the view; registration order breaks ties */
  order?: number;
  /** shown at all (brand hidden, feature off): default yes */
  visible?: () => boolean;
  /** a grouped row is hidden while this says so; default: the provider has no top-level rows */
  isEmpty?: () => boolean | Promise<boolean>;
  /** the group row's right-hand summary ("12 · ⚠ 2 raw") */
  description?: () => string | undefined;
  tooltip?: string;
  /** codicon id for the group row */
  icon?: string;
  /** a group row starts expanded (VS Code then remembers what the user did with it) */
  expanded?: boolean;
  /** a brand word put in front of a row's description when the view mixes brands ("ABB") */
  badge?: (element: T) => string | undefined;
  /** live / total / failed connections, for the view's header ("2 of 3 live") */
  counts?: () => { live: number; total: number; failed: number };
}

/** the row that stands for a grouped section */
export interface GroupNode { readonly sideBarGroup: string }

export const isGroupNode = (el: unknown): el is GroupNode =>
  !!el && typeof el === 'object' && typeof (el as GroupNode).sideBarGroup === 'string';

/** "1 of 2 live · ⚠ 1 failed" from every section that counts connections; '' when there are none */
export function liveSummary(sections: Section[]): string {
  let live = 0, total = 0, failed = 0;
  for (const s of sections) {
    if (!s.counts || (s.visible && !s.visible())) continue;
    const c = s.counts();
    live += c.live; total += c.total; failed += c.failed;
  }
  return total ? `${live} of ${total} live${failed ? ` · ⚠ ${failed} failed` : ''}` : '';
}

export class SectionedTreeCore {
  private readonly sections: Section[];
  private readonly owner = new WeakMap<object, Section>();
  private readonly groups = new Map<string, GroupNode>();
  /** more than one flat section has rows: the brand badges go on */
  private mixed = false;

  constructor(sections: Section[]) {
    this.sections = sections.map((s, i) => ({ s, i }))
      .sort((a, b) => (a.s.order ?? 0) - (b.s.order ?? 0) || a.i - b.i).map(x => x.s);
  }

  all(): readonly Section[] { return this.sections; }

  section(id: string): Section | undefined { return this.sections.find(s => s.id === id); }

  /** the section an element came from (a group row's own section for a group row) */
  ownerOf(el: unknown): Section | undefined {
    if (isGroupNode(el)) return this.section(el.sideBarGroup);
    return el && typeof el === 'object' ? this.owner.get(el) : undefined;
  }

  private shown(s: Section): boolean { return !s.visible || s.visible(); }

  private claim<T>(s: Section, list: T[] | null | undefined): T[] {
    const out = list ?? [];
    for (const el of out) if (el && typeof el === 'object') this.owner.set(el as object, s);
    return out;
  }

  group(id: string): GroupNode {
    let g = this.groups.get(id);
    if (!g) { g = { sideBarGroup: id }; this.groups.set(id, g); }
    return g;
  }

  private async empty(s: Section): Promise<boolean> {
    if (s.isEmpty) return !!(await s.isEmpty());
    const roots = await s.provider.getChildren();
    return !roots || roots.length === 0;
  }

  async children(el?: unknown): Promise<unknown[]> {
    if (el === undefined) {
      const out: unknown[] = [];
      let flatWithRows = 0;
      for (const s of this.sections) {
        if (!this.shown(s)) continue;
        if (s.label === undefined) {
          const rows = this.claim(s, await s.provider.getChildren());
          if (rows.length) flatWithRows++;
          out.push(...rows);
        } else if (!(await this.empty(s))) out.push(this.group(s.id));
      }
      this.mixed = flatWithRows > 1;
      return out;
    }
    if (isGroupNode(el)) {
      const s = this.section(el.sideBarGroup);
      return s ? this.claim(s, await s.provider.getChildren()) : [];
    }
    const s = this.ownerOf(el);
    return s ? this.claim(s, await s.provider.getChildren(el)) : [];
  }

  /**
   * A row's item: the provider's own, with the brand badge in front of its description in a
   * mixed view; a group row from `makeGroup`.
   */
  async item(el: unknown, makeGroup: (s: Section) => ItemLike): Promise<ItemLike> {
    if (isGroupNode(el)) {
      const s = this.section(el.sideBarGroup);
      return s ? makeGroup(s) : { label: el.sideBarGroup };
    }
    const s = this.ownerOf(el);
    if (!s) return { label: '' };
    const it = await s.provider.getTreeItem(el);
    const badge = this.mixed && s.badge ? s.badge(el) : undefined;
    // a provider that hands back the same item twice keeps one badge
    if (badge && !(typeof it.description === 'string' && (it.description === badge || it.description.startsWith(`${badge} · `)))) {
      it.description = typeof it.description === 'string' && it.description ? `${badge} · ${it.description}` : badge;
    }
    return it;
  }
}
