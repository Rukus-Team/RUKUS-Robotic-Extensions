import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { parseTp, type TpProgram, type TpDataRef, type Span, findLabel, findPosition, positionMarkdown, describePosition, IO_KINDS } from './parser';
import { lookupTpDoc, lookupTpDocsAt, DATA_KIND_DOCS, TP_INSTRUCTION_COMPLETIONS, TP_OPERAND_COMPLETIONS, operandContext } from './docs';
import { FANUC_PROGRAMS, CATALOG_MACROS, CATALOG_DOCS } from './syntaxCatalog';
import { renumber } from './renumber';
import { formatPositions } from './teach';
import { renumberOptions } from './renumberSettings';
import { FanucServices } from '../services';
import { spanToRange, spanContains, config, md, programNameFromUri } from '@core/util';
import { resolveProgram } from '@core/resolve';
import { frameHover } from './frameHover';

const SEL = { language: 'fanuc-tp' };

export function registerTpProviders(ctx: vscode.ExtensionContext, s: FanucServices) {
  const completion = new TpCompletion(s);
  ctx.subscriptions.push(
    // "Macro…" in the instruction list: the next suggest list shows only macros (the robot's macro
    // table, then the macros options install), searchable by macro name and by the program it runs
    vscode.commands.registerCommand('robotCode.tp._suggestMacros', async (uri?: string, line?: number) => {
      const ed = vscode.window.activeTextEditor;
      completion.macroMode = { uri: uri ?? ed?.document.uri.toString() ?? '', line: line ?? ed?.selection.active.line ?? -1 };
      await vscode.commands.executeCommand('editor.action.triggerSuggest');
    }),
    vscode.languages.registerHoverProvider(SEL, new TpHover(s)),
    vscode.languages.registerDefinitionProvider(SEL, new TpDefinition(s)),
    vscode.languages.registerReferenceProvider(SEL, new TpReferences(s)),
    vscode.languages.registerDocumentSymbolProvider(SEL, new TpSymbols(s)),
    vscode.languages.registerWorkspaceSymbolProvider(new TpWorkspaceSymbols(s)),
    vscode.languages.registerCompletionItemProvider(SEL, completion, '[', ' ', ':', '$', '.'),
    vscode.languages.registerCodeLensProvider(SEL, new TpCodeLens(s)),
    vscode.languages.registerFoldingRangeProvider(SEL, new TpFolding(s)),
    vscode.languages.registerRenameProvider(SEL, new TpRename(s)),
    vscode.languages.registerDocumentFormattingEditProvider(SEL, new TpFormatter()),
    vscode.languages.registerDocumentHighlightProvider(SEL, new TpHighlights(s)),
  );
}

// ---------------------------------------------------------------------------
// Shared lookups
// ---------------------------------------------------------------------------

type Target =
  | { kind: 'label'; num: number; span: Span; isDef: boolean }
  | { kind: 'position'; index: number; span: Span; isDef: boolean }
  | { kind: 'call'; name: string; span: Span; callKind: 'CALL' | 'RUN' }
  | { kind: 'macro'; name: string; span: Span }
  | { kind: 'data'; ref: TpDataRef }
  | { kind: 'program'; name: string; span: Span };

function targetAt(prog: TpProgram, pos: vscode.Position): Target | undefined {
  for (const l of prog.labels) if (spanContains(l.span, pos)) return { kind: 'label', num: l.num, span: l.span, isDef: true };
  for (const j of prog.jumps) if (spanContains(j.span, pos)) return { kind: 'label', num: j.num, span: j.span, isDef: false };
  for (const c of prog.calls) if (spanContains(c.span, pos)) return { kind: 'call', name: c.name, span: c.span, callKind: c.kind };
  for (const m of prog.macros) if (spanContains(m.span, pos)) return { kind: 'macro', name: m.name, span: m.span };
  for (const p of prog.positions) if (spanContains(p.span, pos)) return { kind: 'position', index: p.index, span: p.span, isDef: true };
  for (const r of prog.posRefs) if (spanContains(r.span, pos)) return { kind: 'position', index: r.index, span: r.span, isDef: false };
  // innermost data ref wins (R[R[1]] → inner)
  const refs = prog.dataRefs.filter(d => spanContains(d.span, pos)).sort((a, b) => a.span.len - b.span.len);
  if (refs.length) return { kind: 'data', ref: refs[0] };
  if (prog.header.nameSpan && spanContains(prog.header.nameSpan, pos)) return { kind: 'program', name: prog.header.name!, span: prog.header.nameSpan };
  return undefined;
}

function labelLocations(prog: TpProgram, uri: vscode.Uri, num: number, includeDef: boolean): vscode.Location[] {
  const out: vscode.Location[] = [];
  if (includeDef) for (const l of prog.labels) if (l.num === num) out.push(new vscode.Location(uri, spanToRange(l.span)));
  for (const j of prog.jumps) if (j.num === num) out.push(new vscode.Location(uri, spanToRange(j.span)));
  return out;
}

function positionLocations(prog: TpProgram, uri: vscode.Uri, index: number, includeDef: boolean): vscode.Location[] {
  const out: vscode.Location[] = [];
  if (includeDef) for (const p of prog.positions) if (p.index === index) out.push(new vscode.Location(uri, spanToRange(p.span)));
  for (const r of prog.posRefs) if (r.index === index) out.push(new vscode.Location(uri, spanToRange(r.span)));
  return out;
}

function dataLocations(prog: TpProgram, uri: vscode.Uri, ref: TpDataRef): vscode.Location[] {
  return prog.dataRefs.filter(d => d.kind === ref.kind && d.index === ref.index).map(d => new vscode.Location(uri, spanToRange(d.span)));
}

/**
 * Every use of `DO[12]` (any register or I/O) in the robot the file belongs to - not just the
 * open program (beta list 4, item 10). "The robot" is the file's backup group in the index
 * plus every .ls beside it on disk, so a program opened straight out of a backup folder that
 * the index has not finished reading still finds its neighbours. An open document is read
 * from the editor, so unsaved edits count; the rest are parsed from disk.
 */
async function dataSitesOf(s: FanucServices, doc: vscode.TextDocument, ref: TpDataRef): Promise<vscode.Location[]> {
  const files = new Map<string, vscode.Uri>();
  const add = (u: vscode.Uri) => { if (!files.has(u.toString().toLowerCase())) files.set(u.toString().toLowerCase(), u); };
  add(doc.uri);
  if (doc.uri.scheme === 'file') {
    const group = s.index.groupOf(doc.uri);
    for (const p of s.index.list(doc.uri)) if (p.kind === 'tp' && !p.reference && p.group === group) add(p.uri);
    try {
      const dir = path.dirname(doc.uri.fsPath);
      for (const f of await fs.promises.readdir(dir)) if (/\.ls$/i.test(f)) add(vscode.Uri.file(path.join(dir, f)));
    } catch { /* folder gone: the index is all there is */ }
  }
  const open = new Map(vscode.workspace.textDocuments.map(d => [d.uri.toString().toLowerCase(), d]));
  const out: vscode.Location[] = [];
  for (const [key, uri] of files) {
    let prog: TpProgram;
    const od = open.get(key);
    if (od) prog = s.tp.get(od);
    else { try { prog = parseTp(await fs.promises.readFile(uri.fsPath, 'latin1')); } catch { continue; } }
    out.push(...dataLocations(prog, uri, ref));
  }
  return out;
}

/** Where a program name resolves: the index, else the robot the file was opened from. */
function programLocation(s: FanucServices, name: string, near?: vscode.Uri): vscode.Location | undefined {
  const r = resolveProgram(s, name, near);
  return r ? new vscode.Location(r.uri, new vscode.Position(0, 0)) : undefined;
}

export async function callSitesOf(s: FanucServices, name: string, near?: vscode.Uri): Promise<vscode.Location[]> {
  const out: vscode.Location[] = [];
  for (const caller of s.index.callers(name, near)) {
    try {
      const doc = await vscode.workspace.openTextDocument(caller.uri);
      const prog = s.tp.get(doc);
      for (const c of prog.calls) if (c.name.toUpperCase() === name.toUpperCase()) out.push(new vscode.Location(caller.uri, spanToRange(c.span)));
    } catch { /* skip */ }
  }
  return out;
}

export function dataHover(s: FanucServices, prog: TpProgram, ref: TpDataRef, uri: vscode.Uri): vscode.MarkdownString {
  const kd = DATA_KIND_DOCS[ref.kind];
  const lines: string[] = [];
  const ds = s.data.dataset(uri);
  const title = `${ref.kind}[${ref.index}${ref.sub !== undefined ? `,${ref.sub}` : ''}]`;
  lines.push(`**${title}** — ${kd?.name ?? ref.kind}`);
  const ctrl = ds?.comment(ref.kind, ref.index);
  const inline = ref.comment;
  const ws = s.index.inlineComment(ref.kind, ref.index, uri);
  const live = s.live?.liveValue(ref.kind, ref.index);
  if (live) {
    const secs = Math.round(live.age / 1000);
    const dot = live.text === 'ON' ? '🟢' : live.text === 'OFF' ? '⚪' : /\(SIM\)/.test(live.text) ? '🟡' : '🟠';
    // "Read from", not "Live on": this is the last value fetched, not a running feed.
    lines.push('', `${dot} **Read from ${live.robot}:** \`${live.text}\` _(${secs < 60 ? `${secs} s` : `${Math.round(secs / 60)} min`} ago)_`);
  }
  if (ctrl) lines.push('', `Controller comment: **${ctrl}**${ds && s.data.datasets.length > 1 ? ` _(${ds.label})_` : ''}`);
  // a clickable link that writes the controller comment into the line: R[15] -> R[15:Speed].
  // This is the hover the reader actually sees over a register, so the link lives here, not
  // only on the decoration.
  if (ctrl && !inline) {
    const col = ref.span.col + ref.span.len - 1;   // just before the closing ]
    const cmd = `command:robotCode.tp.insertRegisterComment?${encodeURIComponent(JSON.stringify([uri.toString(), ref.line, col, ctrl]))}`;
    lines.push('', `[$(insert) Auto-fill comment](${cmd})`);
  }
  if (ref.state !== undefined) lines.push('', `Listing state: \`${ref.state === '*' ? '* (not connected)' : ref.state}\` — what the point was when this .ls was exported, not what it is now.`);
  if (!ds && s.data.datasets.length > 1) lines.push('', '_This file is not inside any robot backup folder, so no controller data is matched to it._');
  if (inline && ctrl && inline !== ctrl) lines.push('', `⚠ Inline comment \`${inline}\` differs from the controller comment.`);
  if (!ctrl && ws) lines.push('', `Comment used in ${ws.programs} program${ws.programs === 1 ? '' : 's'}: **${ws.comment}**`);
  if (ref.kind === 'R') {
    const r = ds?.numregs.get(ref.index);
    if (r && !live) lines.push('', `Value in backup: \`${r.value}\``);
  } else if (ref.kind === 'PR') {
    const pr = ds?.posreg(ref.index);
    if (pr) {
      lines.push('', `Backup: ${pr.kind === 'uninit' ? '_uninitialized_' : pr.kind}${pr.uf !== undefined ? ` UF ${pr.uf}` : ''}${pr.ut !== undefined ? ` UT ${pr.ut}` : ''}${pr.config ? ` · ${pr.config}` : ''}`);
      if (pr.summary) lines.push('', '`' + pr.summary + '`');
      if (ref.sub !== undefined) {
        const names = pr.kind === 'joint' ? ['J1', 'J2', 'J3', 'J4', 'J5', 'J6', 'J7', 'J8', 'J9'] : ['X', 'Y', 'Z', 'W', 'P', 'R', 'E1', 'E2', 'E3'];
        lines.push('', `Element ${ref.sub} = **${names[ref.sub - 1] ?? '?'}**`);
      }
    } else if (ref.sub !== undefined) {
      lines.push('', `Element ${ref.sub}: ${['X / J1', 'Y / J2', 'Z / J3', 'W / J4', 'P / J5', 'R / J6', 'E1 / J7', 'E2 / J8', 'E3 / J9'][ref.sub - 1] ?? '?'}`);
    }
  } else if (ref.kind === 'SR') {
    const sr = ds?.strregs.get(ref.index);
    if (sr?.value) lines.push('', `Value in backup: \`${sr.value}\``);
  }
  const uses = prog.dataRefs.filter(d => d.kind === ref.kind && d.index === ref.index).length;
  lines.push('', `_${uses} use${uses === 1 ? '' : 's'} in this program._`);
  if (kd) lines.push('', kd.description, kd.range ? `\n_${kd.range}_` : '');
  return md(...lines);
}

// ---------------------------------------------------------------------------

class TpHover implements vscode.HoverProvider {
  constructor(private s: FanucServices) {}
  async provideHover(doc: vscode.TextDocument, pos: vscode.Position): Promise<vscode.Hover | undefined> {
    const prog = this.s.tp.get(doc);
    // `$` system variables first: they can contain R[n] indices, and the variable is what
    // the reader is asking about
    const sv = await this.s.sysvars.hover(doc, pos);
    if (sv) return sv;
    const t = targetAt(prog, pos);
    if (t) {
      switch (t.kind) {
        case 'label': {
          const def = findLabel(prog, t.num);
          const jumps = prog.jumps.filter(j => j.num === t.num);
          const lines = [`**LBL[${t.num}${def?.comment ? `:${def.comment}` : ''}]**`];
          lines.push('', def ? `Defined on TP line ${prog.lines.find(l => l.line === def.line)?.num ?? '?'} (editor line ${def.line + 1}).` : '⚠ No LBL[' + t.num + '] in this program.');
          lines.push('', `${jumps.length} jump${jumps.length === 1 ? '' : 's'} to this label.`);
          return new vscode.Hover(md(...lines), spanToRange(t.span));
        }
        case 'position': {
          const p = findPosition(prog, t.index);
          if (!p) return new vscode.Hover(md(`**P[${t.index}]** — ⚠ not present in /POS`), spanToRange(t.span));
          const uses = prog.posRefs.filter(r => r.index === t.index).length;
          return new vscode.Hover(md(positionMarkdown(p), '', `_Used by ${uses} motion instruction${uses === 1 ? '' : 's'}._`), spanToRange(t.span));
        }
        case 'call': return new vscode.Hover(this.programHover(t.name, t.callKind, false, doc.uri), spanToRange(t.span));
        case 'macro': {
          const m = this.s.data.macro(t.name, doc.uri);
          const lines = [`**${t.name}** — Macro instruction`];
          if (m) { lines.push('', `Runs program **${m.progName}** (macro table entry ${m.index}).`); const info = this.s.index.get(m.progName, doc.uri); if (info?.comment) lines.push('', `_${info.comment}_`); }
          else lines.push('', 'The name is looked up in the controller macro table (MENU > SETUP > Macro). Add `sysmacro.va` from a backup to resolve it here.');
          return new vscode.Hover(md(...lines), spanToRange(t.span));
        }
        case 'data': return new vscode.Hover(dataHover(this.s, prog, t.ref, doc.uri), spanToRange(t.ref.span));
        case 'program': return new vscode.Hover(this.programHover(t.name, 'CALL', true, doc.uri), spanToRange(t.span));
      }
    }
    // UFRAME_NUM=3 / UTOOL_NUM=2 / UFRAME[3] / the UF : 3, UT : 2 header of a /POS block: what that frame is
    const fh = frameHover(this.s, doc, pos);
    if (fh) return fh;
    // instruction docs
    const line = prog.lines.find(l => l.line === pos.line);
    if (!line || (line.kind !== 'instruction' && line.kind !== 'motion' && line.kind !== 'continuation' && line.kind !== 'comment' && line.kind !== 'remark')) return undefined;
    const bodyCol = pos.character - line.bodyCol;
    const docs = bodyCol >= 0 ? lookupTpDocsAt(doc.lineAt(pos.line).text.slice(line.bodyCol), bodyCol) : [];
    const primary = lookupTpDoc(line.body);
    const chosen = docs.find(d => d !== primary) && bodyCol > 2 ? docs.filter(d => d !== primary)[0] : primary;
    const use = chosen ?? primary;
    if (!use) return undefined;
    const lines = [`**${use.title}**`, '', '```', use.syntax, '```', '', use.description];
    if (use.notes?.length) lines.push('', ...use.notes.map(n => `- ${n}`));
    if (use.option) lines.push('', `Requires option **${use.option}**.`);
    if (use.verified) lines.push('', `${/^Verified/.test(use.verified) ? '✓' : '◐'} ${use.verified}`);
    if (use.source) lines.push('', `*${use.source}*`);
    if (line.motion && use === primary) lines.push('', this.describeMotion(prog, line.motion, doc.uri));
    // PAYLOAD[n]: what schedule n actually is on this controller, from symotn.va
    const pl = /^PAYLOAD\[(\d+)\]/.exec(line.body);
    if (pl) {
      const ds = this.s.data.dataset(doc.uri);
      const p = ds?.payloads.get(parseInt(pl[1], 10));
      if (p) lines.push('', p.initialized
        ? `**Schedule ${p.index} — "${p.comment}"** _(${ds!.label})_\n\n| | |\n|---|---|\n| Mass | ${p.mass} kg |\n| Centre of gravity | X ${p.cg.x} · Y ${p.cg.y} · Z ${p.cg.z} mm |\n| Inertia | Ix ${p.inertia.ix} · Iy ${p.inertia.iy} · Iz ${p.inertia.iz} kg·cm² |`
        : `⚠ Schedule ${p.index} has never been set up on ${ds!.label}: it still carries the default ${p.mass} kg and no comment.`);
      else if (ds?.payloads.size) lines.push('', `⚠ ${ds.label} has ${ds.payloads.size} payload schedules; there is no schedule ${pl[1]}.`);
    }
    return new vscode.Hover(md(...lines));
  }

  private describeMotion(prog: TpProgram, m: NonNullable<TpProgram['lines'][number]['motion']>, uri: vscode.Uri): string {
    const parts: string[] = [];
    const type = { J: 'Joint', L: 'Linear', C: 'Circular', A: 'Arc', S: 'Spline' }[m.type];
    parts.push(`_${type} move`);
    if (m.target) {
      parts.push(`to ${m.target.kind}[${m.target.index}${m.target.comment ? `:${m.target.comment}` : ''}]`);
      if (m.target.kind === 'P') { const p = findPosition(prog, m.target.index); if (p) parts.push(`(${describePosition(p)})`); }
      else { const pr = this.s.data.posreg(m.target.index, 1, uri); if (pr?.comment && !m.target.comment) parts.push(`"${pr.comment}"`); }
    }
    if (m.speed) parts.push(`at ${m.speed.value}${m.speed.unit}`);
    if (m.termination) parts.push(m.termination.value === 'FINE' ? 'stopping exactly (FINE)' : `blending through (${m.termination.value})`);
    if (m.options) parts.push(`with ${m.options}`);
    return parts.join(' ') + '._';
  }

  private programHover(name: string, kind: 'CALL' | 'RUN', isSelf = false, near?: vscode.Uri): vscode.MarkdownString {
    const res = resolveProgram(this.s, name, near);
    const info = res?.info;
    const copies = this.s.index.all(name).length;
    const lines = [`**${name.toUpperCase()}**${info?.programType ? ` _(${info.programType})_` : ''}`];
    if (res?.remote && !info) {
      lines.push('', `On robot **${res.remote.robot}** as \`${res.remote.device}${res.remote.file}\`${res.kind === 'binary' ? ' (compiled only)' : ''}. Not opened yet, so what it calls is not known here — Ctrl+click opens it from the robot.`);
      return md(...lines);
    }
    if (info) {
      if (info.comment) lines.push('', `_${info.comment}_`);
      lines.push('', info.kind === 'binary'
        ? `Compiled program — only the ${path.extname(info.uri.fsPath).toUpperCase()} binary is in this backup, so there is no source to read here. It resolves because the controller has it.`
        : info.kind === 'karel' ? 'KAREL program' : `${info.lineCount} lines · ${info.labels} labels · ${info.positions} positions`);
      lines.push('', `[${vscode.workspace.asRelativePath(info.uri)}](${info.uri.toString()})${copies > 1 ? ` _(+${copies - 1} other cop${copies === 2 ? 'y' : 'ies'} in other robot folders)_` : ''}`);
      const callers = this.s.index.callers(name, near);
      if (callers.length) lines.push('', `Called from: ${callers.slice(0, 8).map(c => c.name).join(', ')}${callers.length > 8 ? '…' : ''}`);
      else if (isSelf) lines.push('', '_No callers found in the indexed programs._');
    } else if (!isSelf) {
      lines.push('', `⚠ Not found in the workspace or backup folders.`, '', kind === 'RUN' ? 'RUN starts the program as a separate task.' : 'CALL runs the program and waits for it to end.');
    }
    return md(...lines);
  }
}

class TpDefinition implements vscode.DefinitionProvider {
  constructor(private s: FanucServices) {}
  provideDefinition(doc: vscode.TextDocument, pos: vscode.Position): vscode.Definition | vscode.LocationLink[] | undefined {
    const prog = this.s.tp.get(doc);
    const t = targetAt(prog, pos);
    if (!t) return undefined;
    switch (t.kind) {
      case 'label': { const l = findLabel(prog, t.num); return l ? new vscode.Location(doc.uri, spanToRange(l.span)) : undefined; }
      case 'position': { const p = findPosition(prog, t.index); return p ? new vscode.Location(doc.uri, new vscode.Range(p.line, 0, p.endLine, doc.lineAt(p.endLine).text.length)) : undefined; }
      case 'call': return programLocation(this.s, t.name, doc.uri);
      case 'macro': {
        // A LocationLink rather than a Location, for the originSelectionRange: it is what
        // the editor underlines on Ctrl+hover. Without it VS Code falls back to the word
        // under the cursor, and `GO TO HOME POS` is four words that each lit up and
        // navigated on their own. The span the parser already has is the whole name.
        const m = this.s.data.macro(t.name, doc.uri);
        const target = m ? programLocation(this.s, m.progName, doc.uri) : undefined;
        return target ? [{ originSelectionRange: spanToRange(t.span), targetUri: target.uri, targetRange: target.range }] : undefined;
      }
      case 'data': {
        // the "definition" of a register is its first use in this program
        const first = prog.dataRefs.find(d => d.kind === t.ref.kind && d.index === t.ref.index);
        return first && first !== t.ref ? new vscode.Location(doc.uri, spanToRange(first.span)) : undefined;
      }
      default: return undefined;
    }
  }
}

class TpReferences implements vscode.ReferenceProvider {
  constructor(private s: FanucServices) {}
  async provideReferences(doc: vscode.TextDocument, pos: vscode.Position, ctx: vscode.ReferenceContext): Promise<vscode.Location[]> {
    const prog = this.s.tp.get(doc);
    const t = targetAt(prog, pos);
    if (!t) return [];
    switch (t.kind) {
      case 'label': return labelLocations(prog, doc.uri, t.num, ctx.includeDeclaration);
      case 'position': return positionLocations(prog, doc.uri, t.index, ctx.includeDeclaration);
      case 'data': return dataSitesOf(this.s, doc, t.ref);
      case 'call': return callSitesOf(this.s, t.name, doc.uri);
      case 'program': return callSitesOf(this.s, t.name, doc.uri);
      case 'macro': return prog.macros.filter(m => m.name === t.name).map(m => new vscode.Location(doc.uri, spanToRange(m.span)));
    }
  }
}

class TpHighlights implements vscode.DocumentHighlightProvider {
  constructor(private s: FanucServices) {}
  provideDocumentHighlights(doc: vscode.TextDocument, pos: vscode.Position): vscode.DocumentHighlight[] {
    const prog = this.s.tp.get(doc);
    const t = targetAt(prog, pos);
    if (!t) return [];
    let locs: vscode.Location[] = [];
    if (t.kind === 'label') locs = labelLocations(prog, doc.uri, t.num, true);
    else if (t.kind === 'position') locs = positionLocations(prog, doc.uri, t.index, true);
    else if (t.kind === 'data') locs = dataLocations(prog, doc.uri, t.ref);
    else if (t.kind === 'call') locs = prog.calls.filter(c => c.name.toUpperCase() === t.name.toUpperCase()).map(c => new vscode.Location(doc.uri, spanToRange(c.span)));
    return locs.map(l => new vscode.DocumentHighlight(l.range, vscode.DocumentHighlightKind.Read));
  }
}

class TpSymbols implements vscode.DocumentSymbolProvider {
  constructor(private s: FanucServices) {}
  provideDocumentSymbols(doc: vscode.TextDocument): vscode.DocumentSymbol[] {
    const prog = this.s.tp.get(doc);
    const out: vscode.DocumentSymbol[] = [];
    const lastLine = Math.max(doc.lineCount - 1, 0);
    const lineRange = (a: number, b: number) => new vscode.Range(a, 0, Math.min(b, lastLine), doc.lineAt(Math.min(b, lastLine)).text.length);

    if (prog.header.name && prog.header.nameSpan) {
      const comment = prog.header.attrs.get('COMMENT')?.value.replace(/^"|"$/g, '');
      const hdrEnd = (prog.sections.mn ?? 1) - 1;
      const hdr = new vscode.DocumentSymbol(prog.header.name, comment ?? '', vscode.SymbolKind.Module, lineRange(0, Math.max(hdrEnd, 0)), spanToRange(prog.header.nameSpan));
      for (const a of prog.header.attrs.values()) hdr.children.push(new vscode.DocumentSymbol(a.key, a.value, vscode.SymbolKind.Property, lineRange(a.line, a.line), lineRange(a.line, a.line)));
      out.push(hdr);
    }

    if (prog.sections.mn !== undefined) {
      const mnEnd = (prog.sections.pos ?? prog.sections.end ?? doc.lineCount) - 1;
      const main = new vscode.DocumentSymbol('Main', `${prog.numberedLineCount} lines`, vscode.SymbolKind.Namespace, lineRange(prog.sections.mn, mnEnd), lineRange(prog.sections.mn, prog.sections.mn));
      // Labels partition the program into regions; calls/macros are children of their region.
      const regions: vscode.DocumentSymbol[] = [];
      const sortedLabels = [...prog.labels].sort((a, b) => a.line - b.line);
      let regionStart = prog.sections.mn + 1;
      const pre = new vscode.DocumentSymbol('(start)', '', vscode.SymbolKind.Key, lineRange(regionStart, sortedLabels[0] ? sortedLabels[0].line - 1 : mnEnd), lineRange(regionStart, regionStart));
      regions.push(pre);
      for (let i = 0; i < sortedLabels.length; i++) {
        const l = sortedLabels[i];
        const end = i + 1 < sortedLabels.length ? sortedLabels[i + 1].line - 1 : mnEnd;
        const jumps = prog.jumps.filter(j => j.num === l.num).length;
        regions.push(new vscode.DocumentSymbol(`LBL[${l.num}]${l.comment ? ` ${l.comment}` : ''}`, `${jumps} jump${jumps === 1 ? '' : 's'}`, vscode.SymbolKind.Key, lineRange(l.line, Math.max(end, l.line)), spanToRange(l.span)));
      }
      const regionFor = (line: number) => regions.filter(r => r.range.start.line <= line).pop() ?? pre;
      for (const c of prog.calls) regionFor(c.line).children.push(new vscode.DocumentSymbol(`${c.kind} ${c.name}`, c.args ?? '', vscode.SymbolKind.Function, spanToRange(c.span), spanToRange(c.span)));
      for (const m of prog.macros) regionFor(m.line).children.push(new vscode.DocumentSymbol(m.name, 'macro', vscode.SymbolKind.Event, spanToRange(m.span), spanToRange(m.span)));
      for (const l of prog.lines) {
        if (l.kind === 'motion' && l.motion?.target) {
          const t = l.motion.target;
          regionFor(l.line).children.push(new vscode.DocumentSymbol(`${l.motion.type} ${t.kind}[${t.index}]`, `${l.motion.speed ? l.motion.speed.value + l.motion.speed.unit : ''} ${l.motion.termination?.value ?? ''}`.trim(), vscode.SymbolKind.Constant, lineRange(l.line, l.line), spanToRange(t.span)));
        }
      }
      main.children = regions.filter(r => r !== pre || r.children.length > 0);
      out.push(main);
    }

    if (prog.sections.pos !== undefined && prog.positions.length) {
      const posEnd = (prog.sections.end ?? doc.lineCount) - 1;
      const posSym = new vscode.DocumentSymbol('Positions', `${prog.positions.length}`, vscode.SymbolKind.Array, lineRange(prog.sections.pos, posEnd), lineRange(prog.sections.pos, prog.sections.pos));
      for (const p of prog.positions) {
        const uses = prog.posRefs.filter(r => r.index === p.index).length;
        posSym.children.push(new vscode.DocumentSymbol(`P[${p.index}]${p.comment ? ` "${p.comment}"` : ''}`, `${describePosition(p)}${uses === 0 ? ' · unused' : ''}`, vscode.SymbolKind.Object, lineRange(p.line, p.endLine), spanToRange(p.span)));
      }
      out.push(posSym);
    }
    return out;
  }
}

class TpWorkspaceSymbols implements vscode.WorkspaceSymbolProvider {
  constructor(private s: FanucServices) {}
  provideWorkspaceSymbols(query: string): vscode.SymbolInformation[] {
    const q = query.toUpperCase();
    // A snapshot (reference) copy is indexed so CALLs to it resolve, but it is never something to
    // open and edit: listing it here put the robot's own copy one Ctrl+T away, next to the working
    // program of the same name and indistinguishable from it.
    return this.s.index.list().filter(p => !p.reference && (!q || p.name.includes(q) || (p.comment ?? '').toUpperCase().includes(q)))
      .slice(0, 200)
      .map(p => new vscode.SymbolInformation(p.name, p.kind === 'karel' ? vscode.SymbolKind.Class : p.kind === 'binary' ? vscode.SymbolKind.File : vscode.SymbolKind.Module, [p.comment ?? (p.kind === 'binary' ? p.programType : undefined), path.basename(path.dirname(p.uri.fsPath))].filter(Boolean).join(' · '), new vscode.Location(p.uri, new vscode.Position(0, 0))));
  }
}

/** after a snippet that leaves the caret inside `R[ ]`: open that bracket's own list straight away */
const SUGGEST_AGAIN: vscode.Command = { command: 'editor.action.triggerSuggest', title: 'Suggest' };

/** CATALOG_MACROS are upper case for matching; offer them as the manuals spell them ("Prompt Box Msg") */
let macroSpellings: Map<string, string> | undefined;
function catalogMacroSpelling(upper: string): string {
  if (!macroSpellings) {
    macroSpellings = new Map();
    for (const d of CATALOG_DOCS) for (const f of d.syntax.split('\n')) {
      const lead = f.replace(/^CALL\s+/i, '').split(/[(\[<]/)[0].trim();
      const key = lead.toUpperCase().replace(/\s+/g, ' ');
      if (lead && !macroSpellings.has(key)) macroSpellings.set(key, lead.replace(/\s+/g, ' '));
    }
  }
  return macroSpellings.get(upper) ?? upper;
}

class TpCompletion implements vscode.CompletionItemProvider {
  /** set by robotCode.tp._suggestMacros: the next list on this document line is macros only. Tied to
   *  the line, not a plain flag - another TP editor asking for suggestions first must not use it up. */
  macroMode: { uri: string; line: number } | undefined;
  constructor(private s: FanucServices) {}
  async provideCompletionItems(doc: vscode.TextDocument, pos: vscode.Position): Promise<vscode.CompletionItem[]> {
    const prog = this.s.tp.get(doc);
    const lineText = doc.lineAt(pos.line).text;
    const before = lineText.slice(0, pos.character);
    const items: vscode.CompletionItem[] = [];

    if (this.macroMode && this.macroMode.uri === doc.uri.toString() && this.macroMode.line === pos.line) {
      this.macroMode = undefined;
      return this.macroItems(doc, pos, before);
    }

    // $SYSVAR and $SYSVAR[1].$FIELD, from the reference
    const sv = await this.s.sysvars.completions(doc, pos);
    if (sv) return sv;
    const ds = this.s.data.dataset(doc.uri);
    const inMain = prog.sections.mn !== undefined && pos.line > prog.sections.mn && (prog.sections.pos === undefined || pos.line < prog.sections.pos);

    // Inside brackets of a data reference: R[ , DI[ , PR[ , P[ , LBL[
    const br = /\b(R|PR|SR|AR|DI|DO|RI|RO|GI|GO|AI|AO|UI|UO|SI|SO|F|M|WI|WO|P|LBL|TIMER|UALM|VR|PAYLOAD)\[(\d*)$/.exec(before);
    if (br) {
      const kind = br[1];
      // Every item below inserts its own `]`. What is already to the right of the caret has
      // to go with it: the `]` the editor auto-closed (else `PR[1:home]]`), and when the
      // index of an existing reference is being retyped, its old `:comment]` as well (else
      // `PR[2:pounce]:home]`). Only up to the first `]`, and never across another `[`.
      const tail = /^[^\[\]]*\]/.exec(lineText.slice(pos.character))?.[0].length ?? 0;
      const replaceRange = new vscode.Range(pos.line, pos.character - br[2].length, pos.line, pos.character + tail);
      if (kind === 'PAYLOAD') {
        for (const p of ds?.payloads.values() ?? []) {
          const it = new vscode.CompletionItem({ label: `${p.index}`, description: p.initialized ? `${p.comment} · ${p.mass} kg` : 'not set up' }, vscode.CompletionItemKind.Value);
          it.insertText = `${p.index}]`; it.range = replaceRange; it.sortText = String(p.index).padStart(6, '0'); it.filterText = `${p.index} ${p.comment}`;
          items.push(it);
        }
        return items;
      }
      if (kind === 'LBL') {
        for (const l of prog.labels) {
          const it = new vscode.CompletionItem({ label: `${l.num}`, description: l.comment }, vscode.CompletionItemKind.Reference);
          it.insertText = `${l.num}]`; it.range = replaceRange; it.sortText = String(l.num).padStart(6, '0'); it.filterText = `${l.num} ${l.comment ?? ''}`;
          it.detail = `LBL[${l.num}] on line ${l.line + 1}`;
          items.push(it);
        }
        return items;
      }
      if (kind === 'P') {
        for (const p of prog.positions) {
          const it = new vscode.CompletionItem({ label: `${p.index}`, description: describePosition(p) }, vscode.CompletionItemKind.Value);
          it.insertText = `${p.index}]`; it.range = replaceRange; it.sortText = String(p.index).padStart(6, '0'); it.filterText = `${p.index}`;
          items.push(it);
        }
        return items;
      }
      if (kind === 'PR') {
        for (const pr of [...(ds?.posregs.values() ?? [])].filter(x => x.group === 1)) {
          if (!pr.comment && pr.kind === 'uninit') continue;
          const it = new vscode.CompletionItem({ label: `${pr.index}${pr.comment ? `:${pr.comment}` : ''}`, description: pr.summary }, vscode.CompletionItemKind.Variable);
          it.insertText = `${pr.index}${pr.comment ? `:${pr.comment}` : ''}]`; it.range = replaceRange; it.sortText = String(pr.index).padStart(6, '0'); it.filterText = `${pr.index} ${pr.comment}`;
          items.push(it);
        }
        this.addInlineCommentCompletions(kind, prog, items, replaceRange);
        return items;
      }
      if (kind === 'R') {
        for (const r of ds?.numregs.values() ?? []) {
          if (!r.comment) continue;
          const it = new vscode.CompletionItem({ label: `${r.index}:${r.comment}`, description: `= ${r.value}` }, vscode.CompletionItemKind.Variable);
          it.insertText = `${r.index}:${r.comment}]`; it.range = replaceRange; it.sortText = String(r.index).padStart(6, '0'); it.filterText = `${r.index} ${r.comment}`;
          items.push(it);
        }
        this.addInlineCommentCompletions(kind, prog, items, replaceRange);
        return items;
      }
      if (kind === 'SR') {
        for (const r of ds?.strregs.values() ?? []) {
          if (!r.comment && !r.value) continue;
          const it = new vscode.CompletionItem({ label: `${r.index}${r.comment ? `:${r.comment}` : ''}`, description: r.value }, vscode.CompletionItemKind.Variable);
          it.insertText = `${r.index}${r.comment ? `:${r.comment}` : ''}]`; it.range = replaceRange; it.sortText = String(r.index).padStart(6, '0');
          items.push(it);
        }
        return items;
      }
      if (IO_KINDS.has(kind)) {
        for (const e of ds?.io.values() ?? []) {
          if (e.kind !== kind) continue;
          const it = new vscode.CompletionItem({ label: `${e.index}:${e.comment}` }, vscode.CompletionItemKind.Interface);
          it.insertText = `${e.index}:${e.comment}]`; it.range = replaceRange; it.sortText = String(e.index).padStart(6, '0'); it.filterText = `${e.index} ${e.comment}`;
          items.push(it);
        }
        this.addInlineCommentCompletions(kind, prog, items, replaceRange);
        return items;
      }
      return items;
    }

    // After CALL / RUN: program names
    const cm = /\b(CALL|RUN)\s+([A-Za-z0-9_\-]*)$/.exec(before);
    if (cm) {
      const replaceRange = new vscode.Range(pos.line, pos.character - cm[2].length, pos.line, pos.character);
      const scoped = this.s.index.list(doc.uri);
      const own = new Set<string>();
      for (const p of scoped.length ? scoped : this.s.index.list()) {
        if (p.name === programNameFromUri(doc.uri)) continue;
        own.add(p.name.toUpperCase());
        const it = new vscode.CompletionItem({ label: p.name, description: p.comment ?? (p.kind === 'binary' ? p.programType : undefined) }, p.kind === 'karel' ? vscode.CompletionItemKind.Class : p.kind === 'binary' ? vscode.CompletionItemKind.File : vscode.CompletionItemKind.Module);
        it.range = replaceRange; it.detail = vscode.workspace.asRelativePath(p.uri); it.filterText = `${p.name} ${p.comment ?? ''}`;
        it.sortText = `0${p.name}`;
        items.push(it);
      }
      // Programs an option installs on the controller (from the manuals): callable, never in the
      // workspace. Below the workspace's own programs; searchable by what they do as well as by name.
      for (const [name, f] of Object.entries(FANUC_PROGRAMS)) {
        if (own.has(name)) continue;
        const it = new vscode.CompletionItem({ label: name, description: f.option ? `FANUC · ${f.option}` : 'FANUC' }, vscode.CompletionItemKind.Function);
        it.range = replaceRange; it.detail = f.option ? `Installed by ${f.option}` : 'Installed on the controller by FANUC';
        it.documentation = f.summary; it.filterText = `${name} ${f.summary}`; it.sortText = `1${name}`;
        items.push(it);
      }
      return items;
    }

    if (!inMain) return items;
    // Start of an instruction body (after "  12:  " or on a fresh line)
    const atBodyStart = /^(\s*\d*:\s*|\s*)[A-Za-z!/]*$/.test(before);
    if (atBodyStart) {
      const wordStart = before.length - (/[A-Za-z!/]*$/.exec(before)?.[0].length ?? 0);
      const replaceRange = new vscode.Range(pos.line, wordStart, pos.line, pos.character);
      TP_INSTRUCTION_COMPLETIONS.forEach((c, i) => {
        const it = new vscode.CompletionItem(c.label, vscode.CompletionItemKind.Keyword);
        it.insertText = new vscode.SnippetString(c.insert); it.detail = c.detail; it.range = replaceRange;
        it.documentation = lookupTpDoc(c.insert.replace(/\$\{\d+(:[^}]*)?\}/g, '1'))?.description;
        // The table's order IS the order. Left to the labels, `PR[,]=` sorted above every
        // other PR entry (a comma sorts before a bracket), so PR + Tab wrote `PR[1,1]=0`.
        it.sortText = `0${String(i).padStart(3, '0')}`;
        if (c.suggest) it.command = SUGGEST_AGAIN;
        items.push(it);
      });
      for (const m of ds?.macros.values() ?? []) {
        const it = new vscode.CompletionItem({ label: m.macroName, description: `→ ${m.progName}` }, vscode.CompletionItemKind.Event);
        it.detail = 'Macro instruction'; it.range = replaceRange; it.sortText = `1${m.macroName}`;
        items.push(it);
      }
      // "macro" + Tab: a list of the macros alone, to search (the macro table can be long and its
      // names are free text, so they get lost among the instructions above)
      const pick = new vscode.CompletionItem({ label: 'Macro…', description: ds?.macros.size ? `${ds.macros.size} in the macro table` : 'pick a macro instruction' }, vscode.CompletionItemKind.Snippet);
      pick.insertText = ''; pick.range = replaceRange; pick.filterText = 'macro'; pick.sortText = '0000';
      pick.detail = 'Pick a macro instruction from the macro table';
      pick.command = { command: 'robotCode.tp._suggestMacros', title: 'Macros', arguments: [doc.uri.toString(), pos.line] };
      items.push(pick);
      return items;
    }

    // An operand further along the line: `R[1]=PR`, `IF DI`, `WAIT (F`, `L P[1] 100mm/sec CN`.
    // Not in a comment or remark, not in a string, and not inside a bracket's `:comment`.
    const operand = operandContext(lineText, pos.character);
    if (operand) {
      const replaceRange = new vscode.Range(pos.line, pos.character - operand.word.length, pos.line, pos.character);
      TP_OPERAND_COMPLETIONS.forEach((c, i) => {
        if (c.motionOnly && !operand.motion) return;
        const it = new vscode.CompletionItem(c.label, c.insert.includes('[') ? vscode.CompletionItemKind.Variable : vscode.CompletionItemKind.Keyword);
        it.insertText = new vscode.SnippetString(c.insert); it.detail = c.detail; it.range = replaceRange;
        it.sortText = `${c.motionOnly ? '0' : '1'}${String(i).padStart(3, '0')}`;
        if (c.suggest) it.command = SUGGEST_AGAIN;
        items.push(it);
      });
    }
    return items;
  }

  /** The macro-only list: this robot's macro table first, then the macros options install (as the manuals spell them) */
  private macroItems(doc: vscode.TextDocument, pos: vscode.Position, before: string): vscode.CompletionItem[] {
    const word = /[A-Za-z0-9_ ]*$/.exec(before.replace(/^\s*\d*:\s*/, ''))?.[0].trimStart() ?? '';
    const range = new vscode.Range(pos.line, pos.character - word.length, pos.line, pos.character);
    const ds = this.s.data.dataset(doc.uri);
    const items: vscode.CompletionItem[] = [];
    const inTable = new Set<string>();
    for (const m of [...(ds?.macros.values() ?? [])].sort((a, b) => a.index - b.index)) {
      inTable.add(m.macroName.toUpperCase().replace(/\s+/g, ' '));
      const it = new vscode.CompletionItem({ label: m.macroName, description: `→ ${m.progName}` }, vscode.CompletionItemKind.Event);
      it.detail = `Macro #${m.index} - runs ${m.progName}`; it.range = range;
      it.filterText = `${m.macroName} ${m.progName}`; it.sortText = `0${String(m.index).padStart(4, '0')}`;
      items.push(it);
    }
    for (const name of CATALOG_MACROS) {
      if (inTable.has(name)) continue;
      const spelled = catalogMacroSpelling(name);
      const it = new vscode.CompletionItem({ label: spelled, description: 'option macro' }, vscode.CompletionItemKind.Event);
      it.detail = ds?.macros.size ? 'Installed by an option - not in this robot\'s macro table' : 'Installed by an option';
      it.documentation = lookupTpDoc(spelled)?.description;
      it.range = range; it.filterText = spelled; it.sortText = `1${name}`;
      items.push(it);
    }
    return items;
  }

  private addInlineCommentCompletions(kind: string, prog: TpProgram, items: vscode.CompletionItem[], range: vscode.Range) {
    const seen = new Set(items.map(i => (typeof i.label === 'string' ? i.label : i.label.label).split(':')[0]));
    const local = new Map<number, string>();
    for (const d of prog.dataRefs) if (d.kind === kind && d.comment && !local.has(d.index)) local.set(d.index, d.comment);
    for (const [index, comment] of local) {
      if (seen.has(String(index))) continue;
      const it = new vscode.CompletionItem({ label: `${index}:${comment}`, description: 'used in this program' }, vscode.CompletionItemKind.Variable);
      it.insertText = `${index}:${comment}]`; it.range = range; it.sortText = String(index).padStart(6, '0');
      items.push(it);
    }
  }
}

class TpCodeLens implements vscode.CodeLensProvider {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChange.event;
  constructor(private s: FanucServices) { s.index.onDidChange(() => this._onDidChange.fire()); }
  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    if (!config<boolean>('tp.codeLens', true)) return [];
    const prog = this.s.tp.get(doc);
    const out: vscode.CodeLens[] = [];
    for (const l of prog.labels) {
      const locs = labelLocations(prog, doc.uri, l.num, false);
      out.push(new vscode.CodeLens(spanToRange(l.span), locs.length
        ? { title: `${locs.length} jump${locs.length === 1 ? '' : 's'}`, command: 'editor.action.showReferences', arguments: [doc.uri, new vscode.Position(l.span.line, l.span.col), locs] }
        : { title: 'no jumps', command: 'robotCode.tp.gotoLabel' }));
    }
    if (prog.header.name && prog.header.nameSpan) {
      const callers = this.s.index.callers(prog.header.name, doc.uri);
      const lens = new vscode.CodeLens(spanToRange(prog.header.nameSpan));
      lens.command = {
        title: callers.length ? `called from ${callers.length} program${callers.length === 1 ? '' : 's'}` : 'no callers indexed',
        command: callers.length ? 'robotCode.tp.showCallers' : 'robotCode.tp.showCallGraph',
        arguments: [doc.uri, prog.header.name],
      };
      out.push(lens);
      const callees = new Set(prog.calls.map(c => c.name.toUpperCase()));
      if (callees.size) out.push(new vscode.CodeLens(spanToRange(prog.header.nameSpan), { title: `calls ${callees.size} program${callees.size === 1 ? '' : 's'}`, command: 'robotCode.tp.showCallGraph', arguments: [doc.uri] }));
    }
    return out;
  }
}

class TpFolding implements vscode.FoldingRangeProvider {
  constructor(private s: FanucServices) {}
  provideFoldingRanges(doc: vscode.TextDocument): vscode.FoldingRange[] {
    const prog = this.s.tp.get(doc);
    const out: vscode.FoldingRange[] = [];
    const sec = prog.sections;
    if (sec.attr !== undefined && sec.mn !== undefined) out.push(new vscode.FoldingRange(sec.prog ?? 0, sec.mn - 1, vscode.FoldingRangeKind.Region));
    if (sec.pos !== undefined) out.push(new vscode.FoldingRange(sec.pos, (sec.end ?? doc.lineCount) - 1, vscode.FoldingRangeKind.Region));
    for (const p of prog.positions) if (p.endLine > p.line) out.push(new vscode.FoldingRange(p.line, p.endLine));
    // label regions
    const labels = [...prog.labels].sort((a, b) => a.line - b.line);
    const mnEnd = (sec.pos ?? sec.end ?? doc.lineCount) - 1;
    for (let i = 0; i < labels.length; i++) {
      const end = (i + 1 < labels.length ? labels[i + 1].line : mnEnd + 1) - 1;
      if (end > labels[i].line) out.push(new vscode.FoldingRange(labels[i].line, end));
    }
    // IF THEN / ENDIF, FOR / ENDFOR
    const stack: number[] = [];
    for (const l of prog.lines) {
      if (l.kind !== 'instruction') continue;
      if (/^IF\b.*\bTHEN\s*$/.test(l.body) || /^FOR\b/.test(l.body)) stack.push(l.line);
      else if (/^(ENDIF|ENDFOR)\b/.test(l.body)) { const start = stack.pop(); if (start !== undefined && l.line > start) out.push(new vscode.FoldingRange(start, l.line)); }
      else if (/^ELSE\s*$/.test(l.body)) { const start = stack.pop(); if (start !== undefined && l.line - 1 > start) out.push(new vscode.FoldingRange(start, l.line - 1)); stack.push(l.line); }
    }
    // comment banners: 3+ consecutive comment lines
    let runStart = -1;
    for (const l of prog.lines) {
      if (l.kind === 'comment') { if (runStart < 0) runStart = l.line; }
      else { if (runStart >= 0 && l.line - runStart >= 3) out.push(new vscode.FoldingRange(runStart, l.line - 1, vscode.FoldingRangeKind.Comment)); runStart = -1; }
    }
    // an extended comment folds to its first line
    let extStart = -1;
    for (const l of prog.lines) {
      if (l.ext && (extStart < 0 || l.seq !== undefined)) { if (extStart >= 0 && l.line - 1 > extStart) out.push(new vscode.FoldingRange(extStart, l.line - 1, vscode.FoldingRangeKind.Comment)); extStart = l.line; }
      else if (!l.ext && extStart >= 0) { if (l.line - 1 > extStart) out.push(new vscode.FoldingRange(extStart, l.line - 1, vscode.FoldingRangeKind.Comment)); extStart = -1; }
    }
    return out;
  }
}

/**
 * F2 on the things TP lets you name.
 *
 * - a label or a position NUMBER: renumbered within the file (they are per-program);
 * - a register / I-O COMMENT: rewritten in every program of the backup, because the register
 *   is one thing on one controller and a comment that says two different things in two
 *   files is exactly the mismatch the diagnostics flag;
 * - a position NAME - the `Home` in `P[1:"Home"]` and `P[1:Home]` - within the file. Not
 *   PR[] names: those come from the controller (posreg.va) and are edited on the pendant.
 */
class TpRename implements vscode.RenameProvider {
  constructor(private s: FanucServices) {}
  prepareRename(doc: vscode.TextDocument, pos: vscode.Position): { range: vscode.Range; placeholder: string } {
    const prog = this.s.tp.get(doc);
    const t = targetAt(prog, pos);
    if (t?.kind === 'label') {
      const m = /LBL\[(\d+)/.exec(doc.getText(spanToRange(t.span)));
      const numStart = t.span.col + (m ? m[0].length - m[1].length : 4);
      return { range: new vscode.Range(pos.line, numStart, pos.line, numStart + String(t.num).length), placeholder: String(t.num) };
    }
    if (t?.kind === 'data') {
      if (t.ref.commentSpan) return { range: spanToRange(t.ref.commentSpan), placeholder: t.ref.comment ?? '' };
      const closeCol = t.ref.span.col + t.ref.span.len - 1;
      return { range: new vscode.Range(pos.line, closeCol, pos.line, closeCol), placeholder: this.s.data.comment(t.ref.kind, t.ref.index, doc.uri) ?? '' };
    }
    if (t?.kind === 'position') {
      // Caret on the name renames the name; on the number, renumbers. A position with no
      // name yet is renumbered, as before - a name is added by typing it.
      const c = positionCommentAt(prog, pos);
      if (c) return { range: spanToRange(c.span), placeholder: c.comment };
      const m = /P\[(\d+)/.exec(doc.getText(spanToRange(t.span)));
      const numStart = t.span.col + 2;
      return { range: new vscode.Range(pos.line, numStart, pos.line, numStart + (m?.[1].length ?? 1)), placeholder: String(t.index) };
    }
    throw new Error('Rename works on labels (renumber), positions (renumber, or rename the P[n:"name"]) and register/I-O comments.');
  }
  async provideRenameEdits(doc: vscode.TextDocument, pos: vscode.Position, newName: string): Promise<vscode.WorkspaceEdit | undefined> {
    const prog = this.s.tp.get(doc);
    const t = targetAt(prog, pos);
    const edit = new vscode.WorkspaceEdit();
    if (t?.kind === 'label') {
      const n = parseInt(newName, 10);
      if (!Number.isInteger(n) || n < 1 || n > 32767) throw new Error('Label numbers are 1–32767.');
      if (prog.labels.some(l => l.num === n && l.num !== t.num)) throw new Error(`LBL[${n}] already exists in this program.`);
      for (const loc of labelLocations(prog, doc.uri, t.num, true)) {
        const text = doc.getText(loc.range);
        edit.replace(doc.uri, loc.range, text.replace(/LBL\[\d+/, `LBL[${n}`));
      }
      return edit;
    }
    if (t?.kind === 'position') {
      if (positionCommentAt(prog, pos)) {
        const name = newName.trim();
        if (/["\]]/.test(name)) throw new Error('A position name cannot contain " or ].');
        if (name.length > 16) throw new Error('The pendant shows 16 characters of a position name.');
        for (const p of prog.positions) {
          if (p.index !== t.index) continue;
          if (p.commentSpan) {
            if (name) edit.replace(doc.uri, spanToRange(p.commentSpan), name);
            else edit.delete(doc.uri, new vscode.Range(p.line, p.commentSpan.col - 2, p.line, p.commentSpan.col + p.commentSpan.len + 1));   // :"name"
          } else if (name) edit.insert(doc.uri, new vscode.Position(p.line, p.span.col + p.span.len - 1), `:"${name}"`);
        }
        for (const r of prog.posRefs) {
          if (r.index !== t.index) continue;
          if (r.commentSpan) {
            if (name) edit.replace(doc.uri, spanToRange(r.commentSpan), name);
            else edit.delete(doc.uri, new vscode.Range(r.line, r.commentSpan.col - 1, r.line, r.commentSpan.col + r.commentSpan.len));   // :name
          } else if (name) edit.insert(doc.uri, new vscode.Position(r.line, r.span.col + r.span.len - 1), `:${name}`);
        }
        return edit;
      }
      const n = parseInt(newName, 10);
      if (!Number.isInteger(n) || n < 1) throw new Error('Position numbers are positive integers.');
      if (prog.positions.some(p => p.index === n && p.index !== t.index)) throw new Error(`P[${n}] already exists in this program.`);
      for (const loc of positionLocations(prog, doc.uri, t.index, true)) {
        const text = doc.getText(loc.range);
        edit.replace(doc.uri, loc.range, text.replace(/P\[\d+/, `P[${n}`));
      }
      return edit;
    }
    if (t?.kind === 'data') {
      const comment = newName.trim();
      if (/\]/.test(comment)) throw new Error('A comment cannot contain ].');
      const key = `${t.ref.kind}:${t.ref.index}`;
      // This file, then every other TP program in the backup that touches the same item.
      // The index already knows which ones do, so only those files are opened.
      const targets: Array<{ uri: vscode.Uri; prog: TpProgram }> = [{ uri: doc.uri, prog }];
      for (const p of this.s.index.backupOf(doc.uri).programs) {
        if (p.kind !== 'tp' || p.uri.toString() === doc.uri.toString() || !p.dataAccess.has(key)) continue;
        try { const d = await vscode.workspace.openTextDocument(p.uri); targets.push({ uri: p.uri, prog: this.s.tp.get(d) }); } catch { /* unreadable, skip */ }
      }
      for (const { uri, prog: pr } of targets) {
        for (const d of pr.dataRefs) {
          if (d.kind !== t.ref.kind || d.index !== t.ref.index) continue;
          if (d.commentSpan) {
            const r = spanToRange(d.commentSpan);
            if (comment) edit.replace(uri, r, comment);
            else edit.delete(uri, new vscode.Range(d.line, d.commentSpan.col - 1, d.line, d.commentSpan.col + d.commentSpan.len));
          } else if (comment) {
            const closeCol = d.span.col + d.span.len - 1;
            edit.insert(uri, new vscode.Position(d.line, closeCol), `:${comment}`);
          }
        }
      }
      return edit;
    }
    return undefined;
  }
}

/** the position name under the caret - `Home` in `P[1:"Home"]{` or `P[1:Home]` - if it is on one */
function positionCommentAt(prog: TpProgram, pos: vscode.Position): { span: Span; comment: string } | undefined {
  for (const p of prog.positions) if (p.commentSpan && spanContains(p.commentSpan, pos)) return { span: p.commentSpan, comment: p.comment ?? '' };
  for (const r of prog.posRefs) if (r.commentSpan && spanContains(r.commentSpan, pos)) return { span: r.commentSpan, comment: r.comment ?? '' };
  return undefined;
}

class TpFormatter implements vscode.DocumentFormattingEditProvider {
  provideDocumentFormattingEdits(doc: vscode.TextDocument): vscode.TextEdit[] {
    const text = doc.getText();
    const res = renumber(text, renumberOptions(doc));
    const out = res.edits.map(e => vscode.TextEdit.replace(doc.lineAt(e.line).range, e.newText));
    // /POS rows laid out the controller's way (beta list 3): floats, three decimals, aligned.
    // Renumbering only rewrites /MN lines, so the two never claim the same line; the check
    // is there so a future change to either cannot produce overlapping edits.
    const taken = new Set(res.edits.map(e => e.line));
    for (const e of formatPositions(text)) if (!taken.has(e.line)) out.push(vscode.TextEdit.replace(doc.lineAt(e.line).range, e.newText));
    return out;
  }
}
