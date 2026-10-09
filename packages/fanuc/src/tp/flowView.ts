/**
 * Program Flow webview: layered flowchart of one TP program with click-to-reveal,
 * pan/zoom and Mermaid export.
 *
 * Nothing in the drawing is truncated. A box is as wide as its longest line and an edge
 * label wraps onto as many lines as the condition needs, because the condition IS the
 * information: a flowchart that shows `IF (R[1]=1 AND DI[10]=ON AND R[2…` has told you
 * which branch exists and nothing about when it is taken.
 */
import * as vscode from 'vscode';
import { buildFlow, flowToMermaid, edgeCaption, type FlowGraph, type FlowNode } from './flow';
import type { FanucServices } from '../services';
import { buildKarelFlow, karelFlowScopes, scopeAt } from '../karel/flow';
import { escapeHtml } from '@core/util';
import { WEBVIEW_BASE_CSS } from '@core/webviewStyle';

const panels = new Map<string, vscode.WebviewPanel>();

export async function showProgramFlow(ctx: vscode.ExtensionContext, s: FanucServices, uri: vscode.Uri) {
  const doc = await vscode.workspace.openTextDocument(uri);
  const name = s.tp.get(doc).header.name ?? 'Program';
  openFlow(uri.toString(), name, doc, d => buildFlow(s.tp.get(d)));
}

/**
 * The flowchart of the KAREL routine the cursor is in (`line`), or of the main body; with
 * several to choose from and no line, the user picks. Same drawing and Mermaid export as TP.
 */
export async function showKarelFlow(ctx: vscode.ExtensionContext, s: FanucServices, uri: vscode.Uri, line?: number) {
  const doc = await vscode.workspace.openTextDocument(uri);
  const prog = s.karel.get(doc);
  const scopes = karelFlowScopes(prog);
  if (!scopes.length) { vscode.window.showInformationMessage('No routine or main body with BEGIN ... END in this file to draw.'); return; }
  let scope = line !== undefined ? scopeAt(scopes, line) : undefined;
  if (!scope) {
    scope = scopes.length === 1 ? scopes[0] : (await vscode.window.showQuickPick(scopes.map(x => ({ label: x.name, description: x.routine ? 'routine' : 'main program', x })), { title: 'Flowchart of which routine?' }))?.x;
    if (!scope) return;
  }
  const want = scope;
  const title = want.routine ? `${prog.name ?? 'KAREL'} › ${want.name}` : want.name;
  openFlow(`${uri.toString()}#${want.name.toUpperCase()}`, title, doc, d => {
    const p = s.karel.get(d);
    const now = karelFlowScopes(p).find(x => x.name.toUpperCase() === want.name.toUpperCase() && x.routine === want.routine);
    return now ? buildKarelFlow(p, now) : { nodes: [], edges: [], unresolved: [] };
  });
}

/** One flowchart panel per key, redrawn as its document changes; click reveals, Copy as Mermaid copies. */
function openFlow(key: string, name: string, doc: vscode.TextDocument, build: (d: vscode.TextDocument) => FlowGraph) {
  let panel = panels.get(key);
  if (!panel) {
    panel = vscode.window.createWebviewPanel('robotCode.flow', `Flow: ${name}`, vscode.ViewColumn.Beside, { enableScripts: true, retainContextWhenHidden: true });
    panels.set(key, panel);
    panel.onDidDispose(() => panels.delete(key));
    panel.webview.onDidReceiveMessage(async (m: { reveal?: number; mermaid?: boolean }) => {
      if (m.reveal !== undefined) {
        const ed = await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, preserveFocus: false });
        const pos = new vscode.Position(m.reveal, 0);
        ed.selection = new vscode.Selection(pos, doc.lineAt(m.reveal).range.end);
        ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
      }
      if (m.mermaid) {
        await vscode.env.clipboard.writeText(flowToMermaid(build(doc), name));
        vscode.window.setStatusBarMessage('Mermaid flowchart copied to clipboard', 3000);
      }
    });
    const sub = vscode.workspace.onDidChangeTextDocument(e => { if (e.document.uri.toString() === doc.uri.toString() && panels.get(key) === panel) panel!.webview.html = render(build(e.document), name); });
    panel.onDidDispose(() => sub.dispose());
  }
  panel.webview.html = render(build(doc), name);
  panel.reveal(vscode.ViewColumn.Beside, true);
}

// ---------------------------------------------------------------------------
interface Placed { n: FlowNode; x: number; y: number; w: number; h: number; layer: number }

/** monospace at 11px is about 6.6px a character; the title is a little bolder and wider */
const CH = 6.6, MIN_W = 250, MAX_W = 1000, LINE_H = 15, HEAD_H = 24, PAD = 8, MAX_LINES = 8;
/** characters an edge label wraps at - wide enough for most conditions on one line */
const LABEL_WRAP = 48;

function shownLines(n: FlowNode) { return n.lines.filter(l => l.kind !== 'comment'); }

/** wide enough for the title and every line it shows, within reason */
function widthOf(n: FlowNode): number {
  const longest = Math.max(n.title.length * 1.1 + 6, ...shownLines(n).slice(0, MAX_LINES).map(l => `${l.num}: ${l.text}`.length));
  return Math.max(MIN_W, Math.min(MAX_W, Math.round(longest * CH + 24)));
}
function heightOf(n: FlowNode): number {
  const count = shownLines(n).length;
  return HEAD_H + PAD + Math.min(count, MAX_LINES) * LINE_H + (count > MAX_LINES ? LINE_H : 0) + PAD;
}
/** how many characters fit across a box of width w */
function fits(w: number): number { return Math.floor((w - 24) / CH); }

/** the wrapped lines of a label and the box they need */
function labelBox(text: string): { lines: string[]; w: number; h: number } {
  const lines = wrap(text, LABEL_WRAP);
  return { lines, w: Math.max(1, ...lines.map(l => l.length)) * 6.2 + 12, h: lines.length * 13 + 6 };
}

/** wrap on spaces, falling back to a hard cut for a token longer than the line */
function wrap(text: string, max: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (word.length > max) {
      if (line) { out.push(line); line = ''; }
      for (let i = 0; i < word.length; i += max) out.push(word.slice(i, i + max));
      continue;
    }
    if ((line + ' ' + word).trim().length > max) { out.push(line); line = word; }
    else line = (line + ' ' + word).trim();
  }
  if (line) out.push(line);
  return out;
}

function layout(g: FlowGraph): { placed: Placed[]; width: number; height: number } {
  const N = g.nodes.length;
  const layer = new Array<number>(N).fill(0);
  // forward edges only (block order is a topological order for them)
  for (let i = 0; i < N; i++) {
    let best = -1;
    for (const e of g.edges) if (!e.back && e.to === i && e.from < i) best = Math.max(best, layer[e.from]);
    layer[i] = best >= 0 ? best + 1 : i === 0 ? 0 : layer[i - 1] + 1; // unreachable code goes below its predecessor
  }
  const GX = 40;
  // Room between rows for the edge labels. Labels hang below the node an edge LEAVES, one
  // under the other when several edges leave the same node (a branch has two), so the gap
  // after a row is the tallest such stack in it.
  const stackHeightOf = (id: number) => g.edges.filter(e => e.from === id && !e.back).reduce((h, e) => h + labelBox(edgeCaption(g, e)).h + 6, 0);
  const byLayer = new Map<number, number[]>();
  for (let i = 0; i < N; i++) { const arr = byLayer.get(layer[i]) ?? []; arr.push(i); byLayer.set(layer[i], arr); }
  const layers = [...byLayer.keys()].sort((a, b) => a - b);
  const widths = g.nodes.map(widthOf);
  const xpos = new Array<number>(N).fill(0);
  const placed: Placed[] = [];
  let y = 20;
  const rowWidth = (ids: number[]) => ids.reduce((s, id) => s + widths[id], 0) + (ids.length - 1) * GX;
  const totalW = Math.max(...layers.map(l => rowWidth(byLayer.get(l)!)), MIN_W + 2 * GX) + 200;
  let prevIds: number[] = [];
  for (const l of layers) {
    const ids = byLayer.get(l)!;
    if (l > 0) ids.sort((a, b) => bary(a) - bary(b) || a - b);
    const gy = 40 + Math.max(0, ...prevIds.map(stackHeightOf));
    if (l > 0) y += gy;
    prevIds = ids;
    let x = (totalW - rowWidth(ids)) / 2;
    let rowH = 0;
    for (const id of ids) {
      const n = g.nodes[id]; const h = heightOf(n), w = widths[id];
      placed[id] = { n, x, y, w, h, layer: l };
      xpos[id] = x + w / 2; x += w + GX; rowH = Math.max(rowH, h);
    }
    y += rowH;
  }
  function bary(id: number): number {
    const preds = g.edges.filter(e => e.to === id && !e.back).map(e => xpos[e.from]);
    return preds.length ? preds.reduce((a, b) => a + b, 0) / preds.length : xpos[id] || 0;
  }
  return { placed, width: totalW, height: y + 40 };
}

function render(g: FlowGraph, name: string): string {
  const { placed, width, height } = layout(g);
  const nodeSvg = placed.map(p => {
    const n = p.n;
    const shown = shownLines(n);
    const max = fits(p.w);
    const rows = shown.slice(0, MAX_LINES).map((l, i) => {
      const text = `${l.num}: ${l.text.replace(/\s+/g, ' ').trim()}`;
      const cut = text.length > max ? text.slice(0, max - 1) + '…' : text;
      return `<text class="ln ${l.kind}" x="10" y="${HEAD_H + PAD + (i + 1) * LINE_H - 4}"><title>${escapeHtml(text)}</title><tspan class="num">${l.num}:</tspan> ${escapeHtml(cut.slice(String(l.num).length + 2))}</text>`;
    }).join('');
    const more = shown.length > MAX_LINES ? `<text class="ln more" x="10" y="${HEAD_H + PAD + (MAX_LINES + 1) * LINE_H - 4}">… ${shown.length - MAX_LINES} more line${shown.length - MAX_LINES === 1 ? '' : 's'}</text>` : '';
    const inCount = g.edges.filter(e => e.to === n.id).length;
    const titleMax = Math.floor((p.w - 24 - (inCount > 1 ? 40 : 0)) / (CH * 1.1));
    const title = n.title.length > titleMax ? n.title.slice(0, titleMax - 1) + '…' : n.title;
    return `<g class="node ${n.kind}${inCount > 1 ? ' merge' : ''}" transform="translate(${p.x},${p.y})" data-line="${n.docLine}" tabindex="0">
      <title>${escapeHtml(n.title)}</title>
      <rect class="box" width="${p.w}" height="${p.h}" rx="${n.kind === 'entry' || n.kind === 'end' ? p.h / 2 : 6}"/>
      <rect class="stripe" width="5" height="${p.h}" rx="2"/>
      <text class="title" x="12" y="17">${escapeHtml(title)}</text>
      ${inCount > 1 ? `<text class="badge" x="${p.w - 10}" y="17" text-anchor="end">⤵ ${inCount}</text>` : ''}
      ${rows}${more}
    </g>`;
  }).join('');

  const rightRail = width - 60;
  // where the next label leaving each node goes: they stack downwards from the node's foot
  const stackY = new Map<number, number>();
  const edgeSvg = g.edges.map((e, i) => {
    const a = placed[e.from], b = placed[e.to];
    if (!a || !b) return '';
    // every edge says where it lands, the fall-through included
    const text = edgeCaption(g, e);
    if (e.back) {
      // loop: leave source at right edge, go to the rail, up, and enter target's right edge
      const x1 = a.x + a.w, y1 = a.y + a.h - 14, x2 = b.x + b.w, y2 = b.y + 14;
      const rail = rightRail + (i % 5) * 8;
      const d = `M${x1},${y1} H${rail} V${y2} H${x2}`;
      const first = wrap(text, LABEL_WRAP)[0] ?? '';
      return `<path class="edge back ${e.kind}" d="${d}" marker-end="url(#arrow-back)"><title>${escapeHtml(text)}</title></path>${text ? `<text class="elabel" x="${rail + 6}" y="${(y1 + y2) / 2}" transform="rotate(90 ${rail + 6},${(y1 + y2) / 2})"><title>${escapeHtml(text)}</title>${escapeHtml(first)}${first.length < text.length ? '…' : ''}</text>` : ''}`;
    }
    const x1 = a.x + a.w / 2, y1 = a.y + a.h, x2 = b.x + b.w / 2, y2 = b.y;
    const midY = y1 + (y2 - y1) / 2;
    const d = Math.abs(x1 - x2) < 2 ? `M${x1},${y1} V${y2}` : `M${x1},${y1} C${x1},${midY} ${x2},${midY} ${x2},${y2}`;
    let label = '';
    if (text) {
      // Labels of the edges leaving one node stack under it, one below the other, each on
      // its own curve at that height - so a branch's TRUE and FALSE never sit on the same
      // spot, and the layout above has left exactly this much room before the next row.
      // Every line of the condition is drawn; the full text is also the tooltip.
      const { lines, w: bw, h: bh } = labelBox(text);
      const top = stackY.get(e.from) ?? y1 + 8;
      stackY.set(e.from, top + bh + 6);
      const ly = top + 10;
      const f = Math.min(0.95, Math.max(0.02, (top + bh / 2 - y1) / Math.max(1, y2 - y1)));
      const lx = x1 + (x2 - x1) * (3 * f * f - 2 * f * f * f);   // the bezier's x, near enough
      const tspans = lines.map((l, k) => `<tspan x="${lx}" dy="${k === 0 ? 0 : 13}">${escapeHtml(l)}</tspan>`).join('');
      label = `<g class="elabel-g ${e.kind}"><title>${escapeHtml(text)}</title><rect x="${lx - bw / 2}" y="${top}" width="${bw}" height="${bh}" rx="3"/><text class="elabel ${e.kind}" x="${lx}" y="${ly}" text-anchor="middle">${tspans}</text></g>`;
    }
    return `<path class="edge ${e.kind}" d="${d}" marker-end="url(#arrow)"><title>${escapeHtml(text)}</title></path>${label}`;
  }).join('');

  const branches = g.nodes.filter(n => n.kind === 'branch').length, merges = g.nodes.filter(n => g.edges.filter(e => e.to === n.id).length > 1).length, loops = g.edges.filter(e => e.back).length;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${WEBVIEW_BASE_CSS}
  body { overflow: hidden; height: 100vh; display: flex; flex-direction: column }
  .bar { display:flex; gap:10px; align-items:center; padding: 8px 12px; border-bottom: 1px solid var(--vscode-panel-border, #444); font-size: 12px; flex: none; flex-wrap: wrap }
  .bar b { font-size: 13px } .bar .stat { opacity: .7 } .bar button { margin-left: auto; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: 0; padding: 4px 10px; border-radius: 3px; cursor: pointer } .bar button + button { margin-left: 6px }
  .legend { display:flex; gap: 12px; opacity: .75; flex-wrap: wrap } .legend span::before { content: ''; display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 4px; vertical-align: -1px } .legend .b::before { background: var(--vscode-charts-purple, #c678dd) } .legend .l::before { background: var(--vscode-charts-blue, #61afef) } .legend .m::before { background: var(--vscode-charts-yellow, #f6c343) } .legend .e::before { background: var(--vscode-charts-red, #f14c4c) }
  .legend .t::before { background: var(--vscode-charts-purple, #c678dd) } .legend .f::before { background: var(--vscode-charts-orange, #d19a66) }
  #view { flex: 1; cursor: grab } #view:active { cursor: grabbing }
  .node .box { fill: var(--vscode-editorWidget-background); stroke: var(--vscode-panel-border, #555); stroke-width: 1.2 } .node:hover .box, .node:focus .box { stroke: var(--vscode-focusBorder); stroke-width: 2 } .node { cursor: pointer; outline: none }
  .node .stripe { fill: var(--vscode-descriptionForeground) } .node.entry .stripe, .node.entry .box { stroke: var(--vscode-charts-yellow, #f6c343) } .node.entry .stripe { fill: var(--vscode-charts-yellow, #f6c343) }
  .node.end .stripe { fill: var(--vscode-charts-red, #f14c4c) } .node.branch .stripe { fill: var(--vscode-charts-purple, #c678dd) } .node.loop .stripe { fill: var(--vscode-charts-blue, #61afef) } .node.label .stripe { fill: var(--vscode-charts-green, #98c379) }
  .node.merge .box { stroke-dasharray: none; stroke: var(--vscode-charts-green, #98c379) }
  .title { font: 600 12px var(--vscode-font-family); fill: var(--vscode-foreground) } .badge { font: 10px var(--vscode-font-family); fill: var(--vscode-charts-green, #98c379) }
  .ln { font: 11px var(--vscode-editor-font-family, monospace); fill: var(--vscode-foreground) } .ln .num { fill: var(--vscode-descriptionForeground) } .ln.call { fill: var(--vscode-charts-yellow, #f6c343) } .ln.motion { fill: var(--vscode-charts-red, #ff7b72) } .ln.macro { fill: var(--vscode-charts-purple, #c678dd) } .ln.more { fill: var(--vscode-descriptionForeground); font-style: italic }
  .edge { fill: none; stroke: var(--vscode-editorLineNumber-foreground); stroke-width: 1.5 } .edge.true, .edge.case { stroke: var(--vscode-charts-purple, #c678dd) } .edge.false { stroke: var(--vscode-charts-orange, #d19a66); stroke-dasharray: 4 3 } .edge.back { stroke: var(--vscode-charts-blue, #61afef); stroke-dasharray: 6 4 } .edge.timeout, .edge.skip { stroke: var(--vscode-charts-orange, #d19a66); stroke-dasharray: 2 3 }
  .elabel { font: 10.5px var(--vscode-editor-font-family, monospace); fill: var(--vscode-foreground) } .elabel-g rect { fill: var(--vscode-editor-background); stroke: var(--vscode-panel-border, #444); stroke-width: .8 }
  .elabel.true, .elabel.case { fill: var(--vscode-charts-purple, #c678dd) } .elabel-g.true rect, .elabel-g.case rect { stroke: var(--vscode-charts-purple, #c678dd) }
  .elabel.false { fill: var(--vscode-charts-orange, #d19a66) } .elabel-g.false rect { stroke: var(--vscode-charts-orange, #d19a66) }
  marker path { fill: var(--vscode-editorLineNumber-foreground) } marker.back path { fill: var(--vscode-charts-blue, #61afef) }
  .warn { color: var(--vscode-editorWarning-foreground) }
</style></head><body>
<div class="bar"><b>${escapeHtml(name)}</b><span class="stat">${g.nodes.length} blocks · ${branches} branch${branches === 1 ? '' : 'es'} · ${merges} merge${merges === 1 ? '' : 's'} · ${loops} loop${loops === 1 ? '' : 's'}</span>
  <span class="legend"><span class="m">start</span><span class="b">branch</span><span class="l">loop</span><span class="e">end</span><span class="t">TRUE: condition → where it lands</span><span class="f">FALSE: condition → where it lands</span><span>every arrow names its landing line or label</span></span>
  ${g.unresolved.length ? `<span class="warn">⚠ ${g.unresolved.length} jump${g.unresolved.length === 1 ? '' : 's'} to missing label</span>` : ''}
    <button id="fit" aria-label="Fit the flowchart to the view">Fit</button><button id="mermaid" aria-label="Copy the flowchart as Mermaid source">Copy as Mermaid</button></div>
<svg id="view" width="100%" height="100%"><defs>
  <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z"/></marker>
  <marker id="arrow-back" class="back" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z"/></marker>
</defs><g id="root">${edgeSvg}${nodeSvg}</g></svg>
<script>
  const vscode = acquireVsCodeApi();
  const svg = document.getElementById('view'), root = document.getElementById('root');
  const W = ${width}, H = ${height};
  let tx = 0, ty = 0, sc = 1;
  const apply = () => root.setAttribute('transform', 'translate(' + tx + ',' + ty + ') scale(' + sc + ')');
  const fit = () => { const r = svg.getBoundingClientRect(); sc = Math.min(1, (r.width - 20) / W, (r.height - 20) / H); tx = (r.width - W * sc) / 2; ty = 10; apply(); };
  document.getElementById('fit').onclick = fit;
  document.getElementById('mermaid').onclick = () => vscode.postMessage({ mermaid: true });
  let drag = null;
  svg.addEventListener('mousedown', e => { if (e.target.closest('.node')) return; drag = { x: e.clientX - tx, y: e.clientY - ty }; });
  window.addEventListener('mousemove', e => { if (drag) { tx = e.clientX - drag.x; ty = e.clientY - drag.y; apply(); } });
  window.addEventListener('mouseup', () => drag = null);
  svg.addEventListener('wheel', e => { e.preventDefault(); const r = svg.getBoundingClientRect(); const mx = e.clientX - r.left, my = e.clientY - r.top; const f = e.deltaY < 0 ? 1.1 : 1 / 1.1; tx = mx - (mx - tx) * f; ty = my - (my - ty) * f; sc *= f; apply(); }, { passive: false });
  for (const n of document.querySelectorAll('.node')) { const go = () => vscode.postMessage({ reveal: +n.dataset.line }); n.addEventListener('click', go); n.addEventListener('keydown', e => { if (e.key === 'Enter') go(); }); }
  window.addEventListener('resize', fit); fit();
</script></body></html>`;
}
