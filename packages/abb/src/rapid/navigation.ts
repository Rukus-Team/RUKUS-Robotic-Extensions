/**
 * Getting around RAPID the way FANUC TP gets around: Find All References, rename, highlight of
 * the name under the cursor, Ctrl+T over every module in the workspace, "N references" above
 * each routine, quick fixes, Go to Label and the call graph. All of it stands on symbols.ts,
 * which resolves a name the way the controller does (routine, LOCAL, task, shared modules).
 */
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spanToRange, escapeHtml } from '@core/util';
import { WEBVIEW_BASE_CSS } from '@core/webviewStyle';
import { parseRapid, routineAt, type RapidModule } from './parser';
import { RAPID_RESERVED } from './lexer';
import { rapidSymbolAt, rapidOccurrences, resolveName, rapidCallsFrom, RAPID_NAME, type RapidSymbol } from './symbols';

/** a document's task as the providers see it: its own module first */
export interface RapidTaskView { own: RapidModule; others: { uri: vscode.Uri; mod: RapidModule }[]; shared: { uri: vscode.Uri; mod: RapidModule }[] }

const SEL: vscode.DocumentSelector = { language: 'abb-rapid' };
const U = (s: string) => s.toUpperCase();

interface TaskSet { mods: RapidModule[]; uris: vscode.Uri[] }
const taskSet = (doc: vscode.TextDocument, t: RapidTaskView): TaskSet => ({
  mods: [t.own, ...t.others.map(o => o.mod), ...t.shared.map(o => o.mod)],
  uris: [doc.uri, ...t.others.map(o => o.uri), ...t.shared.map(o => o.uri)],
});

export function registerRapidNavigation(ctx: vscode.ExtensionContext, taskOf: (doc: vscode.TextDocument) => RapidTaskView, ownOf: (doc: vscode.TextDocument) => RapidModule): void {
  const symbolAt = (doc: vscode.TextDocument, pos: vscode.Position) => {
    const ts = taskSet(doc, taskOf(doc));
    const sym = rapidSymbolAt(ts.mods, 0, pos.line, pos.character);
    return sym && { ts, sym };
  };
  const locations = (ts: TaskSet, sym: RapidSymbol, includeDecl = true) =>
    rapidOccurrences(ts.mods, sym).filter(o => includeDecl || o.kind !== 'decl').map(o => new vscode.Location(ts.uris[o.module], spanToRange(o.span)));

  // ---- Find All References (Shift+F12) ----
  ctx.subscriptions.push(vscode.languages.registerReferenceProvider(SEL, {
    provideReferences(doc, pos, rc) {
      const r = symbolAt(doc, pos);
      return r ? locations(r.ts, r.sym, rc.includeDeclaration) : undefined;
    },
  }));

  // ---- every use of the name under the cursor, in this file ----
  ctx.subscriptions.push(vscode.languages.registerDocumentHighlightProvider(SEL, {
    provideDocumentHighlights(doc, pos) {
      const r = symbolAt(doc, pos);
      if (!r) return undefined;
      return rapidOccurrences(r.ts.mods, r.sym).filter(o => o.module === 0)
        .map(o => new vscode.DocumentHighlight(spanToRange(o.span), o.write || o.kind === 'decl' ? vscode.DocumentHighlightKind.Write : vscode.DocumentHighlightKind.Read));
    },
  }));

  // ---- rename (F2): the symbol in every module of the task that sees it ----
  ctx.subscriptions.push(vscode.languages.registerRenameProvider(SEL, {
    prepareRename(doc, pos) {
      const r = symbolAt(doc, pos);
      if (!r) throw new Error('Not a RAPID name.');
      if (r.sym.what === 'unknown') throw new Error(`${r.sym.name} is not declared in this task (an instruction, a predefined name or an option's routine): it cannot be renamed here.`);
      const at = rapidOccurrences(r.ts.mods, r.sym).find(o => o.module === 0 && o.span.line === pos.line && pos.character >= o.span.col && pos.character <= o.span.col + o.span.len);
      return at ? { range: spanToRange(at.span), placeholder: r.sym.name } : undefined;
    },
    provideRenameEdits(doc, pos, newName) {
      const r = symbolAt(doc, pos);
      if (!r || r.sym.what === 'unknown') return undefined;
      newName = newName.trim();
      if (!RAPID_NAME.test(newName)) throw new Error(`"${newName}" is not a RAPID name: a letter, then letters, digits or _, 32 characters at most.`);
      if (RAPID_RESERVED.has(U(newName))) throw new Error(`"${newName}" is a RAPID reserved word.`);
      const occ = rapidOccurrences(r.ts.mods, r.sym);
      if (U(newName) !== r.sym.upper) {
        // the new name must not already mean something wherever the symbol is used
        for (const o of occ) {
          const mod = r.ts.mods[o.module];
          const clash = resolveName(r.ts.mods, o.module, U(newName), routineAt(mod, o.span.line)?.name, r.sym.what === 'label');
          if (clash.decl) throw new Error(`"${newName}" is already declared (${path.basename(r.ts.uris[clash.decl.module].fsPath)}, line ${clash.decl.span.line + 1}) where ${r.sym.name} is used.`);
        }
      }
      const edit = new vscode.WorkspaceEdit();
      for (const o of occ) edit.replace(r.ts.uris[o.module], spanToRange(o.span), newName);
      return edit;
    },
  }));

  // ---- Ctrl+T: routines, records and module data in every RAPID file of the workspace ----
  const cache = new Map<string, { mtime: number; mod: RapidModule }>();
  const read = (fsPath: string) => {
    try {
      const st = fs.statSync(fsPath);
      const hit = cache.get(fsPath);
      if (hit && hit.mtime === st.mtimeMs) return hit.mod;
      const mod = parseRapid(fs.readFileSync(fsPath, 'latin1'));
      cache.set(fsPath, { mtime: st.mtimeMs, mod });
      return mod;
    } catch { return undefined; }
  };
  ctx.subscriptions.push(vscode.languages.registerWorkspaceSymbolProvider({
    async provideWorkspaceSymbols(query) {
      const q = query.toLowerCase();
      const files = await vscode.workspace.findFiles('**/*.{mod,MOD,Mod,sys,SYS,Sys,prg,PRG,modx,sysx}', '**/{node_modules,.git}/**', 5000);
      const out: vscode.SymbolInformation[] = [];
      const fuzzy = (name: string) => { let i = 0; const n = name.toLowerCase(); for (const c of n) if (c === q[i]) i++; return i === q.length; };
      for (const f of files) {
        const open = vscode.workspace.textDocuments.find(d => d.uri.toString() === f.toString());
        const mod = open ? ownOf(open) : read(f.fsPath);
        if (!mod || mod.encrypted) continue;
        const container = mod.name ?? path.basename(f.fsPath);
        for (const r of mod.routines) if (fuzzy(r.name)) out.push(new vscode.SymbolInformation(r.name, r.kind === 'FUNC' ? vscode.SymbolKind.Function : r.kind === 'TRAP' ? vscode.SymbolKind.Event : vscode.SymbolKind.Method, container, new vscode.Location(f, spanToRange(r.nameSpan))));
        for (const r of mod.records) if (r.name && fuzzy(r.name)) out.push(new vscode.SymbolInformation(r.name, vscode.SymbolKind.Struct, container, new vscode.Location(f, spanToRange(r.nameSpan))));
        for (const d of mod.data) if (fuzzy(d.name)) out.push(new vscode.SymbolInformation(d.name, d.storage === 'CONST' ? vscode.SymbolKind.Constant : vscode.SymbolKind.Variable, `${container} · ${d.storage} ${d.type}`, new vscode.Location(f, spanToRange(d.nameSpan))));
        if (out.length > 2000) break;
      }
      return out;
    },
  }));

  // ---- "N references" above each routine ----
  const lensChanged = new vscode.EventEmitter<void>();
  ctx.subscriptions.push(lensChanged, vscode.workspace.onDidSaveTextDocument(d => { if (d.languageId === 'abb-rapid') lensChanged.fire(); }));
  ctx.subscriptions.push(vscode.languages.registerCodeLensProvider(SEL, {
    onDidChangeCodeLenses: lensChanged.event,
    provideCodeLenses(doc) {
      const t = taskOf(doc);
      if (t.own.encrypted) return [];
      const ts = taskSet(doc, t);
      return t.own.routines.map(r => {
        const sym = rapidSymbolAt(ts.mods, 0, r.nameSpan.line, r.nameSpan.col);
        const locs = sym ? locations(ts, sym, false) : [];
        const range = spanToRange(r.nameSpan);
        const callers = new Set(locs.map(l => l.uri.toString() + '#' + (routineAt(ts.mods[ts.uris.findIndex(u => u.toString() === l.uri.toString())], l.range.start.line)?.name ?? ''))).size;
        const title = locs.length ? `${locs.length} reference${locs.length === 1 ? '' : 's'}${callers > 1 ? ` from ${callers} routines` : ''}` : (/^main$/i.test(r.name) ? 'entry point' : 'no references');
        return new vscode.CodeLens(range, { title, command: locs.length ? 'editor.action.showReferences' : '', arguments: [doc.uri, range.start, locs] });
      });
    },
  }));

  // ---- quick fixes ----
  ctx.subscriptions.push(vscode.languages.registerCodeActionsProvider(SEL, {
    provideCodeActions(doc, _range, cctx) {
      const out: vscode.CodeAction[] = [];
      const mod = ownOf(doc);
      for (const d of cctx.diagnostics) {
        const line = d.range.start.line;
        if (d.code === 'rapid.unusedLocalRoutine') {
          const r = mod.routines.find(x => x.nameSpan.line === line);
          if (r?.endLine !== undefined) {
            const a = new vscode.CodeAction(`Remove unused routine ${r.name}`, vscode.CodeActionKind.QuickFix);
            let start = r.startLine;
            while (start > 0 && /^\s*!/.test(doc.lineAt(start - 1).text)) start--;   // its comment block goes with it
            a.edit = new vscode.WorkspaceEdit();
            a.edit.delete(doc.uri, new vscode.Range(start, 0, Math.min(r.endLine + 1, doc.lineCount), 0));
            a.diagnostics = [d];
            out.push(a);
          }
        }
        if (d.code === 'rapid.style.unusedLocalData' && /;\s*(!.*)?$/.test(doc.lineAt(line).text) && mod.data.filter(x => x.line === line).length === 1) {
          const a = new vscode.CodeAction('Remove unused declaration', vscode.CodeActionKind.QuickFix);
          a.edit = new vscode.WorkspaceEdit();
          a.edit.delete(doc.uri, doc.lineAt(line).rangeIncludingLineBreak);
          a.diagnostics = [d];
          out.push(a);
        }
        if (d.code === 'rapid.style.waitTimeout') {
          const text = doc.lineAt(line).text;
          const semi = text.search(/;\s*(!.*)?$/);
          if (semi > 0) {
            const a = new vscode.CodeAction('Add \\MaxTime', vscode.CodeActionKind.QuickFix);
            a.edit = new vscode.WorkspaceEdit();
            a.edit.insert(doc.uri, new vscode.Position(line, semi), ' \\MaxTime:=10');
            a.diagnostics = [d];
            out.push(a);
          }
        }
      }
      return out;
    },
  }, { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }));

  // ---- Go to Label ----
  ctx.subscriptions.push(vscode.commands.registerCommand('robotCode.rapid.gotoLabel', async () => {
    const ed = vscode.window.activeTextEditor;
    if (!ed || ed.document.languageId !== 'abb-rapid') { vscode.window.showInformationMessage('Open a RAPID module first.'); return; }
    const mod = ownOf(ed.document);
    const here = routineAt(mod, ed.selection.active.line)?.name;
    const items = mod.routines.flatMap(r => r.labels.map(l => ({
      label: l.name,
      description: `${r.name} · line ${l.line + 1} · ${mod.gotos.filter(g => U(g.label) === U(l.name) && U(g.routine ?? '') === U(r.name)).length} GOTO`,
      line: l.line, col: l.span.col, mine: r.name === here,
    }))).sort((a, b) => Number(b.mine) - Number(a.mine) || a.line - b.line);
    if (!items.length) { vscode.window.showInformationMessage('No labels in this module.'); return; }
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Go to label', matchOnDescription: true });
    if (!pick) return;
    const pos = new vscode.Position(pick.line, pick.col);
    ed.selection = new vscode.Selection(pos, pos);
    ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
  }));

  // ---- call graph ----
  ctx.subscriptions.push(vscode.commands.registerCommand('robotCode.rapid.showCallGraph', async () => {
    const ed = vscode.window.activeTextEditor;
    if (!ed || ed.document.languageId !== 'abb-rapid') { vscode.window.showInformationMessage('Open a RAPID module first.'); return; }
    const doc = ed.document;
    const ts = taskSet(doc, taskOf(doc));
    let root = routineAt(ts.mods[0], ed.selection.active.line);
    if (!root) {
      const pick = await vscode.window.showQuickPick(ts.mods[0].routines.map(r => ({ label: r.name, description: r.kind, r })), { placeHolder: 'Routine to graph' });
      if (!pick) return;
      root = pick.r;
    }
    showRapidCallGraph(ts, 0, root.name);
  }));
}

// ---------------------------------------------------------------- call graph

interface GNode { key: string; name: string; module: string; layer: number; kind: 'routine' | 'unknown' | 'root'; open?: { uri: vscode.Uri; line: number } }

function buildGraph(ts: TaskSet, module: number, routine: string): { nodes: GNode[]; edges: [string, string][] } {
  const nodes = new Map<string, GNode>();
  const edges: [string, string][] = [];
  const keyOf = (m: number, r: string) => `${m}:${U(r)}`;
  const mk = (m: number, r: string, layer: number, kind: GNode['kind']): GNode => {
    const k = keyOf(m, r);
    let n = nodes.get(k);
    if (!n) {
      const rt = ts.mods[m].routines.find(x => U(x.name) === U(r));
      n = { key: k, name: rt?.name ?? r, module: ts.mods[m].name ?? path.basename(ts.uris[m].fsPath), layer, kind, open: rt && { uri: ts.uris[m], line: rt.nameSpan.line } };
      nodes.set(k, n);
    }
    return n;
  };
  mk(module, routine, 0, 'root');
  const queue: { m: number; r: string; depth: number }[] = [{ m: module, r: routine, depth: 0 }];
  const seen = new Set([keyOf(module, routine)]);
  while (queue.length && nodes.size < 160) {
    const { m, r, depth } = queue.shift()!;
    if (depth >= 6) continue;
    for (const e of rapidCallsFrom(ts.mods, m, r)) {
      if ('unknown' in e.to) continue;   // instructions: the graph is about the program's own routines
      const n = mk(e.to.module, e.to.routine, depth + 1, 'routine');
      edges.push([keyOf(m, r), n.key]);
      if (!seen.has(n.key)) { seen.add(n.key); queue.push({ m: e.to.module, r: e.to.routine, depth: depth + 1 }); }
    }
  }
  // who calls the root
  ts.mods.forEach((mod, m) => {
    for (const r of mod.routines) {
      if (seen.has(keyOf(m, r.name)) && !(m === module && U(r.name) === U(routine))) continue;
      if (rapidCallsFrom(ts.mods, m, r.name).some(e => !('unknown' in e.to) && e.to.module === module && U(e.to.routine) === U(routine))) {
        const n = mk(m, r.name, -1, 'routine');
        edges.push([n.key, keyOf(module, routine)]);
      }
    }
  });
  return { nodes: [...nodes.values()], edges: [...new Map(edges.map(e => [e.join('>'), e])).values()] };
}

const graphPanels = new Map<string, vscode.WebviewPanel>();

function showRapidCallGraph(ts: TaskSet, module: number, routine: string): void {
  const g = buildGraph(ts, module, routine);
  const key = `${ts.uris[module].toString()}#${U(routine)}`;
  let panel = graphPanels.get(key);
  if (!panel) {
    panel = vscode.window.createWebviewPanel('robotCode.rapidCallGraph', `Call graph: ${routine}`, vscode.ViewColumn.Beside, { enableScripts: true });
    graphPanels.set(key, panel);
    panel.onDidDispose(() => graphPanels.delete(key));
  }
  const byKey = new Map(g.nodes.map(n => [n.key, n]));
  panel.webview.onDidReceiveMessage(async (m: { open?: string }) => {
    const n = m.open ? byKey.get(m.open) : undefined;
    if (!n?.open) return;
    const ed = await vscode.window.showTextDocument(n.open.uri, { preview: true, viewColumn: vscode.ViewColumn.One });
    const pos = new vscode.Position(n.open.line, 0);
    ed.selection = new vscode.Selection(pos, pos);
    ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
  });
  panel.webview.html = renderGraph(g, routine);
  panel.reveal();
}

function renderGraph(g: { nodes: GNode[]; edges: [string, string][] }, root: string): string {
  const layers = new Map<number, GNode[]>();
  for (const n of g.nodes) { const a = layers.get(n.layer) ?? []; a.push(n); layers.set(n.layer, a); }
  const keys = [...layers.keys()].sort((a, b) => a - b);
  const W = 190, H = 44, GX = 90, GY = 18;
  const maxRows = Math.max(...[...layers.values()].map(a => a.length));
  const totalH = maxRows * (H + GY);
  const pos = new Map<string, { x: number; y: number }>();
  keys.forEach((k, i) => {
    const arr = layers.get(k)!.sort((a, b) => a.name.localeCompare(b.name));
    const colH = arr.length * (H + GY);
    arr.forEach((n, j) => pos.set(n.key, { x: 20 + i * (W + GX), y: 20 + (totalH - colH) / 2 + j * (H + GY) }));
  });
  const svgW = 40 + keys.length * (W + GX), svgH = 40 + totalH;
  const edgeSvg = g.edges.map(([from, to]) => {
    const a = pos.get(from), b = pos.get(to);
    if (!a || !b) return '';
    const x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x, y2 = b.y + H / 2;
    const dx = Math.max(40, (x2 - x1) / 2);
    const d = x2 > x1 ? `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}` : `M${a.x + W / 2},${a.y + H} C${a.x + W / 2},${a.y + H + 60} ${b.x + W / 2},${b.y - 60} ${b.x + W / 2},${b.y}`;
    return `<path class="edge" d="${d}" marker-end="url(#arrow)"/>`;
  }).join('');
  const nodeSvg = g.nodes.map(n => {
    const p = pos.get(n.key)!;
    return `<g class="node ${n.kind}" transform="translate(${p.x},${p.y})" data-key="${escapeHtml(n.key)}" tabindex="0">
      <rect rx="8" width="${W}" height="${H}"/>
      <text x="12" y="19" class="name">${escapeHtml(n.name)}</text>
      <text x="12" y="35" class="comment">${escapeHtml(n.module)}</text>
    </g>`;
  }).join('');
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>${WEBVIEW_BASE_CSS}
  body { padding:12px }
  h2 { font-size: 13px; font-weight: 600; margin: 0 0 8px; opacity: .8 }
  .legend { font-size: 11px; opacity: .7; margin-bottom: 8px } .legend span { margin-right: 14px }
  svg { display:block; overflow: visible }
  .edge { fill:none; stroke: var(--vscode-editorLineNumber-foreground); stroke-width: 1.4 }
  .node rect { fill: var(--vscode-editorWidget-background); stroke: var(--vscode-panel-border, #444); stroke-width: 1.2; cursor: pointer }
  .node:hover rect, .node:focus rect { stroke: var(--vscode-focusBorder); stroke-width: 2 }
  .node.root rect { stroke: var(--vscode-charts-yellow, #f6c343); stroke-width: 2.2 }
  .name { font: 600 12px var(--vscode-editor-font-family, monospace); fill: var(--vscode-foreground) }
  .comment { font: 10px var(--vscode-font-family); fill: var(--vscode-descriptionForeground) }
  marker path { fill: var(--vscode-editorLineNumber-foreground) }
</style></head><body>
<h2>Call graph — ${escapeHtml(root)}</h2>
<div class="legend"><span>▮ yellow = this routine</span><span>left = callers, right = what it calls (the task's own routines; instructions left out)</span><span>click a box to open it</span></div>
<svg width="${svgW}" height="${svgH}" viewBox="0 0 ${svgW} ${svgH}">
  <defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z"/></marker></defs>
  ${edgeSvg}${nodeSvg}
</svg>
<script>
  const vscode = acquireVsCodeApi();
  for (const g of document.querySelectorAll('.node')) {
    const open = () => vscode.postMessage({ open: g.dataset.key });
    g.addEventListener('click', open);
    g.addEventListener('keydown', e => { if (e.key === 'Enter') open(); });
  }
</script></body></html>`;
}
