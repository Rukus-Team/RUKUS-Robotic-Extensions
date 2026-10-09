/**
 * Where the system-variable reference comes from, and the hover/completion built on it.
 *
 * Two copies, merged: the subset bundled with the extension (`data/sysvars.json` - every
 * variable that has a description, plus every top-level name, generated from the RUKUS repo
 * by `scripts/build-sysvars.mjs`), and the full `SysVarsReference.json` that RUKUS installs
 * next to itself, which also knows the type, access and storage of the 50,000 fields that
 * have no description. The full file is found through the same registry key the `rukus://`
 * hand-off uses, or pointed at directly with `robotCode.sysvars.referenceFile`.
 *
 * Loaded once, on the first hover that needs it - nine megabytes of JSON is not something
 * to parse at activation for a file that may never be hovered.
 */
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SysVarsIndex, sysVarTokenAt, describeSysVar, type SysVarRow } from './sysVarsIndex';
import { rukusInstallDir } from '@core/rukus/launch';
import { config, md } from '@core/util';

export class SysVarsReference implements vscode.Disposable {
  private index: SysVarsIndex | undefined;
  private loading: Promise<SysVarsIndex> | undefined;
  /** what fed the index, for the output channel and the hover footer */
  sources: string[] = [];
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly extensionPath: string, private readonly output: vscode.OutputChannel) {
    this.disposables.push(vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('robotCode.sysvars')) this.reset(); }));
  }
  dispose() { for (const d of this.disposables) d.dispose(); }

  reset() { this.index = undefined; this.loading = undefined; this.sources = []; }

  get(): Promise<SysVarsIndex> {
    if (this.index) return Promise.resolve(this.index);
    if (!this.loading) this.loading = this.load().then(i => (this.index = i));
    return this.loading;
  }

  private async load(): Promise<SysVarsIndex> {
    const idx = new SysVarsIndex();
    const sources: string[] = [];
    // 1. the bundled subset
    const bundled = path.join(this.extensionPath, 'data', 'sysvars.json');
    try {
      const data = JSON.parse(await fs.promises.readFile(bundled, 'utf8')) as { rows: SysVarRow[] };
      idx.add(data.rows); sources.push(`bundled (${data.rows.length} entries)`);
    } catch { /* no bundled file in a dev build that skipped the script */ }
    // 2. the full file: configured path, else the RUKUS install
    let full = config<string>('sysvars.referenceFile', '').trim();
    if (!full) {
      const dir = await rukusInstallDir();
      if (dir) full = path.join(dir, 'Assets', 'SysVarsReference.json');
    }
    if (full && fs.existsSync(full)) {
      try {
        const before = idx.size;
        const data = JSON.parse(await fs.promises.readFile(full, 'utf8')) as Array<{ path: string; description: string | null; dataType: string | null; access: string | null; storage: string | null; source: string | null }>;
        idx.add(data); sources.push(`${full} (${data.length} entries, ${idx.size - before} new)`);
      } catch (e: any) { this.output.appendLine(`[RUKUS] could not read ${full}: ${e?.message ?? e}`); }
    }
    this.sources = sources;
    this.output.appendLine(`[RUKUS] system variable reference: ${sources.join('; ') || 'none found'}`);
    return idx;
  }

  /**
   * Hover for the `$…` token at `pos`, or undefined when the caret is not on one.
   * `extraDoc` is a hand-written line (the KAREL built-in list) shown ahead of the reference.
   */
  async hover(doc: vscode.TextDocument, pos: vscode.Position, extraDoc?: (name: string) => string | undefined): Promise<vscode.Hover | undefined> {
    const t = sysVarTokenAt(doc.lineAt(pos.line).text, pos.character);
    if (!t) return undefined;
    const idx = await this.get();
    const top = t.token.split(/[.[]/)[0];
    const lines = describeSysVar(t.token, idx.lookup(t.token), extraDoc?.(top));
    if (this.sources.length) lines.push('', `<sub>${this.sources.some(s => /SysVarsReference/.test(s)) ? 'RUKUS system variable reference' : 'bundled system variable reference'}</sub>`);
    return new vscode.Hover(md(...lines), new vscode.Range(pos.line, t.start, pos.line, t.end));
  }

  /**
   * Completion after `$` (top-level variables) or after `$X[1].` / `$X[1].$` (its fields).
   * Returns undefined when the caret is not in a `$…` context.
   */
  async completions(doc: vscode.TextDocument, pos: vscode.Position, extra?: Record<string, string>): Promise<vscode.CompletionItem[] | undefined> {
    const before = doc.lineAt(pos.line).text.slice(0, pos.character);
    const field = /(\$[A-Za-z_][A-Za-z0-9_]*(?:\[[0-9, ]*\])?(?:\.\$?[A-Za-z_][A-Za-z0-9_]*(?:\[[0-9, ]*\])?)*)\.\$?([A-Za-z0-9_]*)$/.exec(before);
    const top = !field && /\$([A-Za-z0-9_]*)$/.exec(before);
    if (!field && !top) return undefined;
    const idx = await this.get();
    const items: vscode.CompletionItem[] = [];
    if (field) {
      const start = pos.character - field[2].length - (before.endsWith(`$${field[2]}`) ? 1 : 0);
      for (const f of idx.fieldsOf(field[1])) {
        const name = f.path.slice(f.path.lastIndexOf('.') + 1);
        const it = new vscode.CompletionItem({ label: name, description: f.dataType }, vscode.CompletionItemKind.Field);
        it.documentation = f.description ? (f.source === 'inferred' ? `${f.description} (inferred from the name)` : f.description) : undefined;
        it.detail = [f.access, f.storage].filter(Boolean).join(' · ');
        it.range = new vscode.Range(pos.line, start, pos.line, pos.character);
        it.sortText = (!f.description ? '2' : f.source === 'inferred' ? '1' : '0') + name;
        items.push(it);
      }
      return items;
    }
    const start = before.lastIndexOf('$');
    const seen = new Set<string>();
    for (const v of idx.topLevel()) {
      seen.add(v.path.toUpperCase());
      const it = new vscode.CompletionItem({ label: v.path, description: v.dataType }, vscode.CompletionItemKind.Variable);
      it.documentation = extra?.[v.path] ?? (v.description ? (v.source === 'inferred' ? `${v.description} (inferred from the name)` : v.description) : undefined);
      it.detail = [v.access, v.storage].filter(Boolean).join(' · ');
      it.range = new vscode.Range(pos.line, start, pos.line, pos.character);
      it.sortText = (!v.description ? '2' : v.source === 'inferred' ? '1' : '0') + v.path;
      items.push(it);
    }
    for (const [k, v] of Object.entries(extra ?? {})) {
      if (seen.has(k.toUpperCase())) continue;
      const it = new vscode.CompletionItem(k, vscode.CompletionItemKind.Variable);
      it.detail = v; it.range = new vscode.Range(pos.line, start, pos.line, pos.character); it.sortText = '0' + k;
      items.push(it);
    }
    return items;
  }
}

/** Hover + completion for `$` variables in the ASCII dumps themselves (`.va`, `.cm`). */
export function registerSysVarProviders(ctx: vscode.ExtensionContext, ref: SysVarsReference) {
  // every ASCII dump and command-file language. They were two ids (fanuc-va covered .va .dt .dg
  // .io, fanuc-cm covered .cm .cf) until each file type got its own, so each can carry its own
  // Explorer icon - same grammar, same providers, a different id. See scripts/make-file-icons.mjs.
  const sel = ['fanuc-va', 'fanuc-dt', 'fanuc-dg', 'fanuc-io', 'fanuc-cm', 'fanuc-cf'].map(language => ({ language }));
  ctx.subscriptions.push(
    vscode.languages.registerHoverProvider(sel, { provideHover: (doc, pos) => ref.hover(doc, pos) }),
    vscode.languages.registerCompletionItemProvider(sel, { provideCompletionItems: (doc, pos) => ref.completions(doc, pos) }, '$', '.'),
  );
}
