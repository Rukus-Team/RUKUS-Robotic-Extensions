/**
 * Analysis tools: backup diff and register cross-reference — webview reports with
 * click-through to files and Markdown/CSV export.
 */
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { FanucServices } from '../services';
import { WEBVIEW_BASE_CSS } from '@core/webviewStyle';
import { diffBackups, backupDiffMarkdown, type BackupDiff } from './backupDiff';
import { buildXref, xrefFindings, xrefCsv, xrefMarkdown, type XrefEntry } from './xref';
import { escapeHtml, config, windowFolders } from '@core/util';
import { openInRukus, rukusHandlerRegistered } from '@core/rukus/launch';
import { findUnusedPrograms, unusedProgramsMarkdown } from './unusedPrograms';

export function registerTools(ctx: vscode.ExtensionContext, s: FanucServices) {
  const reg = (id: string, fn: (...a: any[]) => any) => ctx.subscriptions.push(vscode.commands.registerCommand(id, fn));

  reg('robotCode.tools.diffBackups', async (a?: vscode.Uri, b?: vscode.Uri) => {
    const dirA = a instanceof vscode.Uri ? a.fsPath : await pickFolder(s, 'Backup A (older)');
    if (!dirA) return;
    const dirB = b instanceof vscode.Uri ? b.fsPath : await pickFolder(s, 'Backup B (newer)', dirA);
    if (!dirB) return;
    // two ABB backups: the ABB compare knows tasks, modules, routines and robtargets (when ABB support is on)
    const abbBackup = (d: string) => fs.existsSync(path.join(d, 'BACKINFO')) && (fs.existsSync(path.join(d, 'RAPID')) || fs.existsSync(path.join(d, 'SYSPAR')));
    if (abbBackup(dirA) && abbBackup(dirB) && (await vscode.commands.getCommands(true)).includes('robotCode.abb.compareBackups')) {
      await vscode.commands.executeCommand('robotCode.abb.compareBackups', vscode.Uri.file(dirA), vscode.Uri.file(dirB));
      return;
    }
    const diff = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Comparing backups…' }, async () => diffBackups(dirA, dirB));
    showDiffPanel(ctx, diff);
    // Someone comparing two backups is doing backup work, which is where RUKUS is the
    // better tool - it holds the dated history these two folders were pulled out of, and
    // can compare a backup against the live robot. Offered once, after the report is up,
    // so it is a next step rather than something in the way.
    void offerRukusDiff(dirA, dirB);
  });

  /** programs nothing calls, for one robot folder - picked the same way the cross-reference is */
  reg('robotCode.tools.unusedPrograms', async () => {
    const all = s.index.list();
    if (!all.length) { vscode.window.showInformationMessage('No programs indexed. Open a folder with .ls files or add a backup folder.'); return; }
    const active = (vscode.window.activeTextEditor ?? vscode.window.visibleTextEditors.find(e => /^fanuc-/.test(e.document.languageId)))?.document;
    const activeGroup = active && /^fanuc-/.test(active.languageId) ? s.index.groupOf(active.uri) : undefined;
    const groups = new Map([...s.index.groups()].filter(([g]) => !/^[a-z]+:\/\//.test(g) || g === activeGroup));
    let group = activeGroup && groups.has(activeGroup) ? activeGroup : groups.size === 1 ? [...groups.keys()][0] : undefined;
    if (!group) {
      const items = [...groups.entries()].map(([g, ps]) => ({ label: s.data.dataset(ps[0].uri)?.label ?? path.basename(g), description: `${ps.length} programs · ${g}`, group: g })).sort((a, b) => a.label.localeCompare(b.label));
      const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Robot folder to check for programs never called', matchOnDescription: true });
      if (!pick) return;
      group = pick.group;
    }
    const progs = all.filter(p => p.group === group);
    const ds = progs.length ? s.data.dataset(progs[0].uri) : undefined;
    const report = findUnusedPrograms(progs.map(p => ({ name: p.name, kind: p.kind, comment: p.comment, calls: p.calls, macros: p.macros })), [...(ds?.macros.values() ?? [])]);
    const md = unusedProgramsMarkdown(report, ds?.label ?? path.basename(group));
    const doc = await vscode.workspace.openTextDocument({ content: md, language: 'markdown' });
    await vscode.window.showTextDocument(doc, { preview: false });
  });

  reg('robotCode.tools.xrefReport', async () => {
    let progs = s.index.list().filter(p => p.kind === 'tp');
    if (!progs.length) { vscode.window.showInformationMessage('No TP programs indexed. Open a folder with .ls files or add a backup folder.'); return; }
    // The robot of the file being edited is the one meant; ask only when there is no such
    // file. Programs opened off a controller form a group of their own, which is only a
    // candidate when the file in hand came from that controller.
    const active = (vscode.window.activeTextEditor ?? vscode.window.visibleTextEditors.find(e => /^fanuc-/.test(e.document.languageId)))?.document;
    const activeGroup = active && /^fanuc-/.test(active.languageId) ? s.index.groupOf(active.uri) : undefined;
    const groups = new Map([...s.index.groups()].filter(([g]) => !/^[a-z]+:\/\//.test(g) || g === activeGroup));
    progs = progs.filter(p => groups.has(p.group));
    if (groups.size > 1 && activeGroup && groups.has(activeGroup)) progs = progs.filter(p => p.group === activeGroup);
    else if (groups.size > 1) {
      const items = [...groups.entries()].map(([g, ps]) => ({ label: s.data.dataset(ps[0].uri)?.label ?? path.basename(g), description: `${ps.length} programs · ${g}`, group: g })).sort((a, b) => a.label.localeCompare(b.label));
      const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Robot folder to cross-reference', matchOnDescription: true });
      if (!pick) return;
      progs = progs.filter(p => p.group === pick.group);
    }
    const near = progs[0]?.uri;
    const parsed = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Cross-referencing ${progs.length} programs…` }, async () => {
      const out: Array<{ name: string; prog: ReturnType<typeof s.tp.get>; uri: vscode.Uri }> = [];
      for (const p of progs) {
        try { const doc = await vscode.workspace.openTextDocument(p.uri); out.push({ name: p.name, prog: s.tp.get(doc), uri: p.uri }); } catch { /* skip */ }
      }
      return out;
    });
    const entries = buildXref(parsed, (k, i) => s.data.comment(k, i, near));
    const uris = new Map(parsed.map(p => [p.name, p.uri]));
    showXrefPanel(ctx, entries, uris);
  });
}

/**
 * Offers to carry a backup comparison over to RUKUS. Silent when RUKUS is not installed:
 * a suggestion nobody can act on is just noise, and this is unprompted.
 */
async function offerRukusDiff(dirA: string, dirB: string): Promise<void> {
  if (!config<boolean>('rukus.enabled', true)) return;
  if (!(await rukusHandlerRegistered())) return;
  const pick = await vscode.window.showInformationMessage(
    'RUKUS can compare these against the live robot and across its dated backup history.',
    'Compare in RUKUS', 'Not now');
  if (pick === 'Compare in RUKUS') await openInRukus({ route: 'diff', path: dirB || dirA });
}

async function pickFolder(s: FanucServices, title: string, exclude?: string): Promise<string | undefined> {
  const candidates = new Set<string>();
  for (const f of windowFolders('data.backupFolders')) candidates.add(f);
  for (const ds of s.data.datasets) candidates.add(ds.folder);
  for (const wf of vscode.workspace.workspaceFolders ?? []) {
    candidates.add(wf.uri.fsPath);
    try { for (const [name, type] of await vscode.workspace.fs.readDirectory(wf.uri)) if (type === vscode.FileType.Directory) candidates.add(path.join(wf.uri.fsPath, name)); } catch { /* ignore */ }
  }
  const items = [...candidates].filter(c => c !== exclude).sort().map(c => ({ label: path.basename(c), description: c }));
  const pick = await vscode.window.showQuickPick([{ label: '$(folder-opened) Browse…', description: '' }, ...items], { placeHolder: title });
  if (!pick) return undefined;
  if (pick.label.startsWith('$(folder-opened)')) {
    const f = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, title });
    return f?.[0]?.fsPath;
  }
  return pick.description;
}

const CSS = `${WEBVIEW_BASE_CSS}
  body { padding: 10px 16px }
  h1 { font-size: 16px; margin: 4px 0 8px } h2 { font-size: 13px; margin: 18px 0 6px; opacity: .85; text-transform: uppercase; letter-spacing: .04em }
  .bar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; position: sticky; top: 0; background: var(--vscode-editor-background); padding: 6px 0; z-index: 2 }
  .bar input { flex: 1 1 220px }
  button { padding: 4px 10px }
  .tiles { display: flex; gap: 8px; flex-wrap: wrap; margin: 8px 0 } .tile { background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-panel-border, #444); border-radius: 6px; padding: 8px 12px; min-width: 90px } .tile b { display: block; font-size: 20px } .tile span { opacity: .7; font-size: 11px }
  table { width: 100%; border-collapse: collapse } th { text-align: left; padding: 5px 8px; border-bottom: 1px solid var(--vscode-panel-border, #444); font-weight: 600; position: sticky; top: 44px; background: var(--vscode-editor-background) } td { padding: 4px 8px; border-bottom: 1px solid var(--vscode-editorWidget-border, #333); vertical-align: top }
  tr:hover td { background: var(--vscode-list-hoverBackground) } .mono { font-family: var(--vscode-editor-font-family, monospace) } .num { text-align: right; font-family: var(--vscode-editor-font-family, monospace) }
  .added { color: var(--vscode-gitDecoration-addedResourceForeground) } .removed { color: var(--vscode-gitDecoration-deletedResourceForeground) } .changed, .moved, .renamed, .value, .comment, .both { color: var(--vscode-gitDecoration-modifiedResourceForeground) }
  a { color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: none } a:hover { text-decoration: underline } .muted { opacity: .65 } .warn { color: var(--vscode-editorWarning-foreground) }
  .write { color: var(--vscode-charts-orange, #d19a66) } .read { color: var(--vscode-charts-blue, #61afef) } .wait, .condition { color: var(--vscode-charts-purple, #c678dd) } .motion { color: var(--vscode-charts-green, #98c379) }
`;

function showDiffPanel(ctx: vscode.ExtensionContext, d: BackupDiff) {
  const panel = vscode.window.createWebviewPanel('robotCode.backupDiff', `Backup diff: ${path.basename(d.a)} ⟷ ${path.basename(d.b)}`, vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
  ctx.subscriptions.push(panel);
  panel.webview.onDidReceiveMessage(async (m: { diff?: [string, string, string]; open?: string; save?: boolean }) => {
    if (m.diff) await vscode.commands.executeCommand('vscode.diff', vscode.Uri.file(m.diff[0]), vscode.Uri.file(m.diff[1]), m.diff[2]);
    if (m.open) await vscode.window.showTextDocument(vscode.Uri.file(m.open), { preview: true });
    if (m.save) {
      const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(d.b, `backup-diff_${path.basename(d.a)}_vs_${path.basename(d.b)}.md`)), filters: { Markdown: ['md'] } });
      if (target) { await vscode.workspace.fs.writeFile(target, Buffer.from(backupDiffMarkdown(d), 'utf8')); await vscode.window.showTextDocument(target); }
    }
  });
  const f = (n: number) => (Math.abs(n) < 0.0005 ? '<span class="muted">0</span>' : n.toFixed(3));
  const sum = d.summary;
  const tile = (n: number, label: string) => `<div class="tile"><b>${n}</b><span>${label}</span></div>`;
  const progRows = d.programs.map(p => `<tr data-s="${escapeHtml(p.name.toLowerCase())}"><td class="mono">${p.fileA && p.fileB ? `<a data-diff='${escapeHtml(JSON.stringify([p.fileA, p.fileB, `${p.name}: A ⟷ B`]))}'>${escapeHtml(p.name)}</a>` : `<a data-open="${escapeHtml(p.fileA ?? p.fileB ?? '')}">${escapeHtml(p.name)}</a>`}</td><td class="${p.kind}">${p.kind}</td><td class="num">${p.linesA ?? '—'} → ${p.linesB ?? '—'}</td><td class="num"><span class="added">+${p.linesAdded}</span> <span class="removed">−${p.linesRemoved}</span></td><td class="num">${p.positions.length || '<span class="muted">0</span>'}</td><td>${escapeHtml(p.commentA === p.commentB ? p.commentA ?? '' : `${p.commentA ?? ''} → ${p.commentB ?? ''}`)}</td></tr>`).join('');
  const posRows = d.programs.filter(p => p.positions.length).map(p => `<h2>${escapeHtml(p.name)} — ${p.positions.length} position${p.positions.length === 1 ? '' : 's'}</h2><table><thead><tr><th>P</th><th>Change</th><th class="num">ΔX</th><th class="num">ΔY</th><th class="num">ΔZ</th><th class="num">ΔW</th><th class="num">ΔP</th><th class="num">ΔR</th><th class="num">Dist</th><th>Frame</th></tr></thead><tbody>${p.positions.map(q => `<tr><td class="mono">P[${q.index}]</td><td class="${q.kind}">${q.kind}</td><td class="num">${f(q.dx)}</td><td class="num">${f(q.dy)}</td><td class="num">${f(q.dz)}</td><td class="num">${f(q.dw)}</td><td class="num">${f(q.dp)}</td><td class="num">${f(q.dr)}</td><td class="num">${q.kind === 'moved' ? `<b>${q.distance.toFixed(3)}</b>` : ''}</td><td>${q.ufChanged ? `UF ${q.ufChanged[0]}→${q.ufChanged[1]} ` : ''}${q.utChanged ? `UT ${q.utChanged[0]}→${q.utChanged[1]}` : ''}</td></tr>`).join('')}</tbody></table>`).join('');
  const valTable = (title: string, prefix: string, rows: BackupDiff['numregs']) => rows.length ? `<h2>${title} (${rows.length})</h2><table><thead><tr><th>Register</th><th>Change</th><th>A</th><th>B</th><th>Comment A</th><th>Comment B</th></tr></thead><tbody>${rows.map(r => `<tr data-s="${prefix.toLowerCase()}[${r.index}] ${escapeHtml(String(r.commentA ?? '') + ' ' + String(r.commentB ?? '')).toLowerCase()}"><td class="mono">${prefix}[${r.index}]</td><td class="${r.kind}">${r.kind}</td><td class="mono">${escapeHtml(String(r.a ?? ''))}</td><td class="mono">${escapeHtml(String(r.b ?? ''))}</td><td>${escapeHtml(r.commentA ?? '')}</td><td>${escapeHtml(r.commentB ?? '')}</td></tr>`).join('')}</tbody></table>` : '';
  panel.webview.html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body>
  <div class="bar"><h1 style="margin:0">Backup diff</h1><input id="q" type="search" placeholder="Filter…"><button class="primary" id="save">Save as Markdown</button></div>
  <div class="muted mono">A: ${escapeHtml(d.a)}<br>B: ${escapeHtml(d.b)}</div>
  <div class="tiles">${tile(sum.programs, 'programs')}${tile(sum.positions, 'positions moved')}${tile(sum.numregs, 'R changed')}${tile(sum.posregs, 'PR changed')}${tile(sum.strregs, 'SR changed')}${tile(sum.io, 'I/O comments')}${tile(sum.macros, 'macros')}${tile(sum.otherFiles, 'other files')}</div>
  ${d.programs.length ? `<h2>Programs (${d.programs.length}) — click a name to diff A ⟷ B</h2><table><thead><tr><th>Program</th><th>Change</th><th class="num">Lines</th><th class="num">+ / −</th><th class="num">Positions</th><th>Comment</th></tr></thead><tbody>${progRows}</tbody></table>` : '<p class="muted">No program changes.</p>'}
  ${posRows}
  ${valTable('Numeric registers', 'R', d.numregs)}${valTable('Position registers', 'PR', d.posregs as any)}${valTable('String registers', 'SR', d.strregs as any)}
  ${d.io.length ? `<h2>I/O comments (${d.io.length})</h2><table><thead><tr><th>Point</th><th>Change</th><th>A</th><th>B</th></tr></thead><tbody>${d.io.map(i => `<tr data-s="${i.kind.toLowerCase()}[${i.index}] ${escapeHtml((i.a ?? '') + ' ' + (i.b ?? '')).toLowerCase()}"><td class="mono">${i.kind}[${i.index}]</td><td class="${i.change}">${i.change}</td><td>${escapeHtml(i.a ?? '')}</td><td>${escapeHtml(i.b ?? '')}</td></tr>`).join('')}</tbody></table>` : ''}
  ${d.macros.length ? `<h2>Macro table (${d.macros.length})</h2><table><thead><tr><th>#</th><th>A</th><th>B</th></tr></thead><tbody>${d.macros.map(m => `<tr><td>${m.index}</td><td>${escapeHtml(m.a ?? '')}</td><td>${escapeHtml(m.b ?? '')}</td></tr>`).join('')}</tbody></table>` : ''}
  ${d.otherFiles.length ? `<h2>Other files (${d.otherFiles.length})</h2><table><thead><tr><th>File</th><th>Change</th><th class="num">Size A</th><th class="num">Size B</th></tr></thead><tbody>${d.otherFiles.map(o => `<tr data-s="${escapeHtml(o.name)}"><td class="mono">${escapeHtml(o.name)}</td><td class="${o.kind}">${o.kind}</td><td class="num">${o.sizeA ?? ''}</td><td class="num">${o.sizeB ?? ''}</td></tr>`).join('')}</tbody></table>` : ''}
  <script>
    const vscode = acquireVsCodeApi();
    document.body.addEventListener('click', e => { const a = e.target.closest('a'); if (!a) return; if (a.dataset.diff) vscode.postMessage({ diff: JSON.parse(a.dataset.diff) }); if (a.dataset.open) vscode.postMessage({ open: a.dataset.open }); });
    document.getElementById('save').addEventListener('click', () => vscode.postMessage({ save: true }));
    document.getElementById('q').addEventListener('input', e => { const f = e.target.value.toLowerCase().trim(); for (const r of document.querySelectorAll('tr[data-s]')) r.hidden = f && !r.dataset.s.includes(f); });
  </script></body></html>`;
}

function showXrefPanel(ctx: vscode.ExtensionContext, entries: XrefEntry[], uris: Map<string, vscode.Uri>) {
  const panel = vscode.window.createWebviewPanel('robotCode.xref', 'Register & I/O cross-reference', vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
  ctx.subscriptions.push(panel);
  const findings = xrefFindings(entries);
  panel.webview.onDidReceiveMessage(async (m: { open?: { program: string; line: number }; save?: 'csv' | 'md' }) => {
    if (m.open) {
      const uri = uris.get(m.open.program); if (!uri) return;
      const ed = await vscode.window.showTextDocument(uri, { preview: true });
      const pos = new vscode.Position(m.open.line, 0); ed.selection = new vscode.Selection(pos, pos); ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    }
    if (m.save) {
      const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '', `register-xref.${m.save}`)), filters: m.save === 'csv' ? { CSV: ['csv'] } : { Markdown: ['md'] } });
      if (target) { await vscode.workspace.fs.writeFile(target, Buffer.from(m.save === 'csv' ? xrefCsv(entries) : xrefMarkdown(entries, findings), 'utf8')); await vscode.window.showTextDocument(target); }
    }
  });
  const kinds = [...new Set(entries.map(e => e.kind))];
  const rows = entries.map(e => {
    const comment = e.controllerComment ?? [...e.comments.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
    const uses = e.uses.map(u => `<div><a data-open='${escapeHtml(JSON.stringify({ program: u.program, line: u.docLine }))}' class="mono">${escapeHtml(u.program)}:${u.tpLine}</a> <span class="${u.access}">${u.access}</span> <span class="mono muted">${escapeHtml(u.text.slice(0, 70))}</span></div>`).join('');
    const warn = findings.filter(f => f.entry === e).map(f => `<div class="warn">⚠ ${escapeHtml(f.finding)}</div>`).join('');
    return `<tr data-k="${e.kind}" data-s="${escapeHtml(`${e.kind}[${e.index}] ${comment} ${[...e.writers, ...e.readers].join(' ')}`).toLowerCase()}"><td class="mono"><b>${e.kind}[${e.index}]</b></td><td>${escapeHtml(comment)}${warn}</td><td class="num">${e.writers.size}</td><td class="num">${e.readers.size}</td><td class="num">${e.uses.length}</td><td><details><summary>${e.uses.length} use${e.uses.length === 1 ? '' : 's'} in ${new Set(e.uses.map(u => u.program)).size} program${new Set(e.uses.map(u => u.program)).size === 1 ? '' : 's'}</summary>${uses}</details></td></tr>`;
  }).join('');
  panel.webview.html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${CSS} details summary { cursor: pointer; opacity: .8 } details div { padding: 1px 0 1px 12px }</style></head><body>
  <div class="bar"><h1 style="margin:0">Cross-reference</h1><input id="q" type="search" placeholder="Filter by item, comment or program…"><select id="k"><option value="">All kinds</option>${kinds.map(k => `<option>${k}</option>`).join('')}</select><label><input type="checkbox" id="fo"> findings only</label><button id="csv">Export CSV</button><button class="primary" id="md">Save Markdown</button></div>
  <div class="tiles"><div class="tile"><b>${entries.length}</b><span>items</span></div><div class="tile"><b>${entries.reduce((n, e) => n + e.uses.length, 0)}</b><span>uses</span></div><div class="tile"><b>${uris.size}</b><span>programs</span></div><div class="tile"><b class="warn">${findings.length}</b><span>findings</span></div></div>
  <table><thead><tr><th>Item</th><th>Comment / findings</th><th class="num">Writers</th><th class="num">Readers</th><th class="num">Uses</th><th>Where</th></tr></thead><tbody>${rows}</tbody></table>
  <script>
    const vscode = acquireVsCodeApi();
    const q = document.getElementById('q'), k = document.getElementById('k'), fo = document.getElementById('fo');
    const apply = () => { const f = q.value.toLowerCase().trim(), kind = k.value; for (const r of document.querySelectorAll('tr[data-s]')) r.hidden = (f && !r.dataset.s.includes(f)) || (kind && r.dataset.k !== kind) || (fo.checked && !r.querySelector('.warn')); };
    q.addEventListener('input', apply); k.addEventListener('change', apply); fo.addEventListener('change', apply);
    document.body.addEventListener('click', e => { const a = e.target.closest('a[data-open]'); if (a) vscode.postMessage({ open: JSON.parse(a.dataset.open) }); });
    document.getElementById('csv').addEventListener('click', () => vscode.postMessage({ save: 'csv' }));
    document.getElementById('md').addEventListener('click', () => vscode.postMessage({ save: 'md' }));
  </script></body></html>`;
}
