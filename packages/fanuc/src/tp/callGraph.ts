import * as vscode from 'vscode';
import * as path from 'node:path';
import { FanucServices } from '../services';
import { programNameFromUri, escapeHtml } from '@core/util';
import { WEBVIEW_BASE_CSS } from '@core/webviewStyle';
import type { ProgramKind } from '@core/brand';

interface Node { name: string; layer: number; exists: boolean; comment?: string; kind: ProgramKind | 'missing'; isRoot: boolean; macro?: boolean }
interface Edge { from: string; to: string; macro?: boolean }

const panels = new Map<string, vscode.WebviewPanel>();

export async function showCallGraph(ctx: vscode.ExtensionContext, s: FanucServices, uri?: vscode.Uri) {
  let root: string | undefined;
  let near: vscode.Uri | undefined = uri;
  if (uri) {
    const doc = await vscode.workspace.openTextDocument(uri);
    root = s.tp.get(doc).header.name?.toUpperCase() ?? programNameFromUri(uri);
  } else {
    const pick = await vscode.window.showQuickPick(s.index.list().map(p => ({ label: p.name, description: [p.comment, path.basename(path.dirname(p.uri.fsPath))].filter(Boolean).join(' · '), uri: p.uri })), { placeHolder: 'Program to graph', matchOnDescription: true });
    if (!pick) return;
    root = pick.label; near = pick.uri;
  }
  const key = `${root}@${near ? s.index.groupOf(near) : ''}`;
  let panel = panels.get(key);
  if (!panel) {
    panel = vscode.window.createWebviewPanel('robotCode.callGraph', `Call graph: ${root}${near && s.index.groups().size > 1 ? ` (${path.basename(path.dirname(near.fsPath))})` : ''}`, vscode.ViewColumn.Beside, { enableScripts: true, retainContextWhenHidden: true });
    panels.set(key, panel);
    panel.onDidDispose(() => panels.delete(key));
    panel.webview.onDidReceiveMessage(async (m: { open?: string }) => {
      if (!m.open) return;
      const info = s.index.get(m.open, near);
      if (info) await vscode.window.showTextDocument(info.uri, { preview: true, viewColumn: vscode.ViewColumn.One });
      else vscode.window.showInformationMessage(`${m.open} is not in the workspace.`);
    });
    const sub = s.index.onDidChange(() => { if (panels.get(key) === panel) panel!.webview.html = render(build(s, root!, near)); });
    panel.onDidDispose(() => sub.dispose());
  }
  panel.webview.html = render(build(s, root, near));
  panel.reveal();
}

function build(s: FanucServices, root: string, near?: vscode.Uri): { nodes: Node[]; edges: Edge[]; root: string } {
  const nodes = new Map<string, Node>();
  const edges: Edge[] = [];
  const edgeSet = new Set<string>();
  const addEdge = (from: string, to: string, macro?: boolean) => { const k = `${from}>${to}`; if (!edgeSet.has(k)) { edgeSet.add(k); edges.push({ from, to, macro }); } };
  const mk = (name: string, layer: number): Node => {
    const info = s.index.get(name, near);
    const n = nodes.get(name) ?? { name, layer, exists: !!info, comment: info?.comment, kind: info ? info.kind : 'missing', isRoot: name === root };
    if (!nodes.has(name)) nodes.set(name, n);
    return n;
  };
  mk(root, 0);
  // callees, BFS, depth-limited
  const queue: Array<{ name: string; depth: number }> = [{ name: root, depth: 0 }];
  const visited = new Set<string>([root]);
  while (queue.length && nodes.size < 160) {
    const { name, depth } = queue.shift()!;
    const info = s.index.get(name, near);
    if (!info || depth >= 5) continue;
    const targets: Array<{ to: string; macro?: boolean }> = info.calls.map(c => ({ to: c }));
    for (const m of info.macros) { const e = s.data.macro(m, near); if (e) targets.push({ to: e.progName.toUpperCase(), macro: true }); }
    for (const t of targets) {
      const n = mk(t.to, depth + 1);
      if (n.layer > depth + 1) n.layer = depth + 1;
      addEdge(name, t.to, t.macro);
      if (!visited.has(t.to)) { visited.add(t.to); queue.push({ name: t.to, depth: depth + 1 }); }
    }
  }
  // direct callers of the root
  for (const c of s.index.callers(root, near)) { mk(c.name, -1); addEdge(c.name, root); }
  for (const p of s.index.list(near)) {
    for (const m of p.macros) { const e = s.data.macro(m, near); if (e && e.progName.toUpperCase() === root && !nodes.has(p.name)) { mk(p.name, -1); addEdge(p.name, root, true); } }
  }
  return { nodes: [...nodes.values()], edges, root };
}

function render(g: { nodes: Node[]; edges: Edge[]; root: string }): string {
  const layers = new Map<number, Node[]>();
  for (const n of g.nodes) { const arr = layers.get(n.layer) ?? []; arr.push(n); layers.set(n.layer, arr); }
  const layerKeys = [...layers.keys()].sort((a, b) => a - b);
  const W = 190, H = 44, GX = 90, GY = 18;
  const pos = new Map<string, { x: number; y: number }>();
  let maxRows = 0;
  for (const arr of layers.values()) maxRows = Math.max(maxRows, arr.length);
  const totalH = maxRows * (H + GY);
  layerKeys.forEach((lk, i) => {
    const arr = layers.get(lk)!.sort((a, b) => a.name.localeCompare(b.name));
    const colH = arr.length * (H + GY);
    arr.forEach((n, j) => pos.set(n.name, { x: 20 + i * (W + GX), y: 20 + (totalH - colH) / 2 + j * (H + GY) }));
  });
  const svgW = 40 + layerKeys.length * (W + GX);
  const svgH = 40 + totalH;
  const edgeSvg = g.edges.map(e => {
    const a = pos.get(e.from), b = pos.get(e.to);
    if (!a || !b) return '';
    const x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x, y2 = b.y + H / 2;
    const dx = Math.max(40, (x2 - x1) / 2);
    const d = x2 > x1 ? `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}` : `M${a.x + W / 2},${a.y + H} C${a.x + W / 2},${a.y + H + 60} ${b.x + W / 2},${b.y - 60} ${b.x + W / 2},${b.y}`;
    return `<path class="edge${e.macro ? ' macro' : ''}" d="${d}" marker-end="url(#arrow)"/>`;
  }).join('');
  const nodeSvg = g.nodes.map(n => {
    const p = pos.get(n.name)!;
    const cls = ['node', n.kind, n.isRoot ? 'root' : ''].join(' ');
    return `<g class="${cls}" transform="translate(${p.x},${p.y})" data-name="${escapeHtml(n.name)}" tabindex="0">
      <rect rx="8" width="${W}" height="${H}"/>
      <text x="12" y="19" class="name">${escapeHtml(n.name)}</text>
      <text x="12" y="35" class="comment">${escapeHtml(n.kind === 'missing' ? 'not in workspace' : n.kind === 'binary' ? 'compiled only (no source)' : n.kind === 'karel' ? 'KAREL' + (n.comment ? ' · ' + n.comment : '') : n.comment ?? '')}</text>
    </g>`;
  }).join('');
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>${WEBVIEW_BASE_CSS}
  body { padding:12px }
  h2 { font-size: 13px; font-weight: 600; margin: 0 0 8px; opacity: .8 }
  .legend { font-size: 11px; opacity: .7; margin-bottom: 8px } .legend span { margin-right: 14px }
  svg { display:block; overflow: visible }
  .edge { fill:none; stroke: var(--vscode-editorLineNumber-foreground); stroke-width: 1.4 }
  .edge.macro { stroke-dasharray: 5 4; stroke: var(--vscode-charts-purple, #c678dd) }
  .node rect { fill: var(--vscode-editorWidget-background); stroke: var(--vscode-panel-border, #444); stroke-width: 1.2; cursor: pointer }
  .node:hover rect, .node:focus rect { stroke: var(--vscode-focusBorder); stroke-width: 2 }
  .node.root rect { stroke: var(--vscode-charts-yellow, #f6c343); stroke-width: 2.2 }
  .node.karel rect { stroke: var(--vscode-charts-blue, #61afef) }
  .node.binary rect { stroke: var(--vscode-charts-blue, #61afef); stroke-dasharray: 2 3 }
  .node.missing rect { stroke-dasharray: 4 3; opacity: .6 }
  .name { font: 600 12px var(--vscode-editor-font-family, monospace); fill: var(--vscode-foreground) }
  .comment { font: 10px var(--vscode-font-family); fill: var(--vscode-descriptionForeground) }
  marker path { fill: var(--vscode-editorLineNumber-foreground) }
</style></head><body>
<h2>Call graph — ${escapeHtml(g.root)}</h2>
<div class="legend"><span>▮ yellow = this program</span><span>▮ blue = KAREL</span><span>┈ dotted blue = compiled only (.pc/.tp)</span><span>┄ dashed box = not found</span><span>┄ dashed edge = via macro table</span><span>click a box to open it</span></div>
<svg width="${svgW}" height="${svgH}" viewBox="0 0 ${svgW} ${svgH}">
  <defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z"/></marker></defs>
  ${edgeSvg}${nodeSvg}
</svg>
<script>
  const vscode = acquireVsCodeApi();
  for (const g of document.querySelectorAll('.node')) {
    const open = () => vscode.postMessage({ open: g.dataset.name });
    g.addEventListener('click', open);
    g.addEventListener('keydown', e => { if (e.key === 'Enter') open(); });
  }
</script></body></html>`;
}
