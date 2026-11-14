/**
 * The Knowledge view (side bar, under the robot views): what kind of program is being written
 * and the rules of that kind, the program checked against them, and building blocks that go in
 * at the caret. The content is tp/knowledge.ts; this is only the page and its wiring.
 */
import * as vscode from 'vscode';
import { WEBVIEW_BASE_CSS, withCsp } from '@core/webviewStyle';
import { viewDeclared, debounce } from '@core/util';
import type { FanucServices } from '../services';
import { PROGRAM_KINDS, BLOCKS, programKind, kindOfProgram, kindFindings, blockFits, blockPreview, type ProgramKindId, type Block } from '../tp/knowledge';

const VIEW = 'robotCode.knowledge';
const KINDS_KEY = 'robotCode.knowledge.kinds';
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function registerKnowledgeView(ctx: vscode.ExtensionContext, s: FanucServices): void {
  if (!viewDeclared(ctx, VIEW)) return;   // an update awaiting a reload
  const provider = new KnowledgeView(ctx, s);
  ctx.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VIEW, provider),
    vscode.window.onDidChangeActiveTextEditor(ed => provider.editorChanged(ed)),
    vscode.workspace.onDidChangeTextDocument(e => { if (e.document === provider.doc) provider.changed(); }),
    vscode.commands.registerCommand('robotCode.knowledge.insertBlock', () => provider.pickBlock()),
    vscode.commands.registerCommand('robotCode.knowledge.setKind', (kind?: ProgramKindId) => provider.pickKind(kind)),
  );
}

class KnowledgeView implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  /** the TP program the view is about: the last one that had the caret */
  private editor: vscode.TextEditor | undefined;
  private group = BLOCKS[0]?.group ?? '';
  readonly changed = debounce(() => this.render(), 400);

  constructor(private ctx: vscode.ExtensionContext, private s: FanucServices) {
    this.editorChanged(vscode.window.activeTextEditor);
  }

  get doc(): vscode.TextDocument | undefined { return this.editor?.document; }

  editorChanged(ed: vscode.TextEditor | undefined) {
    // a click into the view itself leaves no active editor: the program stays the one it was
    if (ed?.document.uri.scheme === 'robotcode-clean') return;   // a compare pane: the program stays the one it was
    if (!ed || ed.document.languageId !== 'fanuc-tp') { if (ed) { this.editor = undefined; this.render(); } return; }
    this.editor = ed;
    this.render();
  }

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [] };
    view.onDidDispose(() => { this.view = undefined; });
    view.onDidChangeVisibility(() => { if (view.visible) this.render(); });
    view.webview.onDidReceiveMessage((m: { type: string; kind?: ProgramKindId; group?: string; block?: number; line?: number }) => {
      if (m.type === 'kind' && m.kind) void this.setKind(m.kind);
      else if (m.type === 'group' && m.group) { this.group = m.group; this.render(); }
      else if (m.type === 'insert' && m.block !== undefined) void this.insert(BLOCKS[m.block]);
      else if (m.type === 'goto' && m.line !== undefined) void this.reveal(m.line);
    });
    this.render();
  }

  /** the kind this program is written as: what was picked for it here, else what its /PROG line says */
  private kind(): ProgramKindId {
    const doc = this.doc;
    if (!doc) return 'tp';
    const picked = this.ctx.workspaceState.get<Record<string, ProgramKindId>>(KINDS_KEY, {})[doc.uri.toString()];
    return picked ?? kindOfProgram(this.s.tp.get(doc));
  }

  /** FANUC TP: Check This Program As... - the kind of program, from the keyboard */
  async pickKind(kind?: ProgramKindId) {
    if (!kind || !PROGRAM_KINDS.some(k => k.id === kind)) {
      const pick = await vscode.window.showQuickPick(PROGRAM_KINDS.map(k => ({ label: k.label, detail: k.summary, id: k.id })), { title: 'This program is a...' });
      if (!pick) return;
      kind = pick.id;
    }
    await this.setKind(kind);
    await vscode.commands.executeCommand(`${VIEW}.focus`);
  }

  private async setKind(kind: ProgramKindId) {
    const doc = this.doc;
    if (doc) {
      const all = { ...this.ctx.workspaceState.get<Record<string, ProgramKindId>>(KINDS_KEY, {}) };
      // what the file says needs no note; only a choice that differs from it is kept
      if (kind === kindOfProgram(this.s.tp.get(doc))) delete all[doc.uri.toString()]; else all[doc.uri.toString()] = kind;
      await this.ctx.workspaceState.update(KINDS_KEY, all);
    }
    const first = BLOCKS.find(b => blockFits(b, kind));
    if (first && !BLOCKS.some(b => b.group === this.group && blockFits(b, kind))) this.group = first.group;
    this.render();
  }

  private async reveal(line: number) {
    const doc = this.doc;
    if (!doc || line >= doc.lineCount) return;
    const ed = await vscode.window.showTextDocument(doc, { viewColumn: this.editor?.viewColumn, preserveFocus: false });
    const at = new vscode.Position(line, doc.lineAt(line).firstNonWhitespaceCharacterIndex);
    ed.selection = new vscode.Selection(at, at);
    ed.revealRange(new vscode.Range(at, at), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }

  /** the same blocks from the keyboard: Robot Code: Insert a Building Block */
  async pickBlock() {
    const kind = this.kind();
    const pick = await vscode.window.showQuickPick(
      BLOCKS.filter(b => blockFits(b, kind)).map(b => ({ label: b.label, description: b.group, detail: blockPreview(b.insert).split('\n').join('  ⏎  '), block: b })),
      { title: `Insert a building block - ${programKind(kind).label}`, matchOnDescription: true, matchOnDetail: true });
    if (pick) await this.insert(pick.block);
  }

  /**
   * The block goes in at the caret: into the line when it is an empty one (`  12:   ;`), else
   * as new lines under it. Lines are written without numbers - the renumber gives them theirs.
   */
  private async insert(block: Block | undefined) {
    const doc = this.doc;
    if (!block || !doc) { void vscode.window.showInformationMessage('Open a TP program (.ls) and put the caret where the block should go.'); return; }
    const prog = this.s.tp.get(doc);
    const mn = prog.sections.mn;
    const ed = await vscode.window.showTextDocument(doc, { viewColumn: this.editor?.viewColumn, preserveFocus: false });
    let line = ed.selection.active.line;
    if (mn === undefined) { void vscode.window.showInformationMessage('This file has no /MN section to put the block in.'); return; }
    const last = (prog.sections.pos ?? prog.sections.end ?? doc.lineCount) - 1;
    if (line <= mn || line > last) line = Math.max(mn, Math.min(line, last));
    const text = doc.lineAt(line).text;
    // motion lines hug the colon, everything else sits two spaces in
    const first = /^[JLCA]\s/.test(block.insert) ? block.insert : '  ' + block.insert;
    const empty = line > mn ? /^(\s*\d*:)?\s*;?\s*$/.exec(text) : null;
    if (empty) {
      const head = empty[1] ?? '';
      await ed.insertSnippet(new vscode.SnippetString(head ? first : block.insert), new vscode.Range(line, head.length, line, text.length));
    } else {
      // under the whole instruction: not between a wrapped line, a circular move or an extended
      // comment and the `:` lines that belong to it
      const tail = (n: number) => { const l = prog.lines.find(x => x.line === n); return !!l && (l.kind === 'continuation' || (l.ext === true && l.seq === undefined)); };
      while (line < last && tail(line + 1)) line++;
      await ed.insertSnippet(new vscode.SnippetString('\n' + block.insert), new vscode.Position(line, doc.lineAt(line).text.length));
    }
  }

  private render() {
    const view = this.view;
    if (!view?.visible) return;
    const doc = this.doc;
    const kind = this.kind();
    const prog = doc ? this.s.tp.get(doc) : undefined;
    const inFile = prog ? kindOfProgram(prog) : 'tp';
    const findings = prog ? kindFindings(kind, prog) : [];
    const mn = prog?.sections.mn ?? 0;
    const lineLabel = (line: number) => { const n = prog?.lines.find(l => l.line === line)?.num; return n !== undefined && line > mn ? `line ${n}` : `file line ${line + 1}`; };
    const name = doc ? (doc.uri.path.split('/').pop() ?? '') : '';

    const kindOptions = PROGRAM_KINDS.map(k => `<option value="${k.id}"${k.id === kind ? ' selected' : ''}>${esc(k.label)}</option>`).join('');
    const rulesOf = (id: ProgramKindId) => {
      const k = programKind(id);
      return `<div class="h">How it is set up</div><ul>${k.setup.map(x => `<li>${esc(x)}</li>`).join('')}</ul>
        <div class="h">Rules</div><ul class="rules">${k.rules.map(r => `<li class="${r.source ? 'src' : 'todo'}">${esc(r.text)}<span class="tag" title="${esc(r.source ?? 'Written from experience - not yet checked against a manual page')}">${!r.source ? 'to confirm' : /p\.\d|sec\. \d/.test(r.source) ? 'manual' : 'tested'}</span></li>`).join('')}</ul>`;
    };
    const check = !doc ? '' : findings.length
      ? `<ul class="find">${findings.map(f => `<li class="${f.sourced ? 'bad' : 'ask'}"><a href="#" data-line="${f.line}">${esc(lineLabel(f.line))}</a> ${esc(f.message)}</li>`).join('')}</ul>`
      : `<p class="ok">${kind === 'tp' ? 'An ordinary program: nothing kind-specific to check.' : `Nothing in ${esc(name)} breaks the rules above that can be checked from the file.`}</p>`;
    const groups = [...new Set(BLOCKS.map(b => b.group))];
    const groupOptions = groups.map(g => `<option value="${esc(g)}"${g === this.group ? ' selected' : ''}${BLOCKS.some(b => b.group === g && blockFits(b, kind)) ? '' : ' class="off"'}>${esc(g)}</option>`).join('');
    const blocks = BLOCKS.map((b, i) => ({ b, i })).filter(x => x.b.group === this.group).map(({ b, i }) => {
      const fits = blockFits(b, kind);
      return `<button class="block" data-block="${i}"${fits ? '' : ' disabled'} title="${esc(fits ? `Insert at the caret${b.detail ? ' - ' + b.detail : ''}` : `Does not belong in a ${programKind(kind).label.toLowerCase()}`)}"><b>${esc(b.label)}</b><code>${esc(blockPreview(b.insert))}</code></button>`;
    }).join('');
    const others = PROGRAM_KINDS.filter(k => k.id !== kind).map(k => `<details><summary>${esc(k.label)}</summary><p class="sum">${esc(k.summary)}</p>${rulesOf(k.id)}</details>`).join('');

    view.description = doc ? name : undefined;
    view.webview.html = withCsp(`<!DOCTYPE html><html><head><meta charset="utf-8"><style>${WEBVIEW_BASE_CSS}
      body { padding: 8px 12px 16px; background: transparent; line-height: 1.45 }
      select { width: 100%; box-sizing: border-box }
      h3 { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; margin: 16px 0 6px; color: var(--rc-muted); font-weight: 600 }
      .h { font-weight: 600; margin: 8px 0 2px } .sum { margin: 6px 0 }
      ul { margin: 2px 0; padding-left: 18px } li { margin: 3px 0 }
      .tag { font-size: 10px; margin-left: 6px; padding: 0 5px; border-radius: 8px; border: 1px solid var(--rc-line); color: var(--rc-muted); white-space: nowrap; cursor: help }
      li.todo .tag { border-color: var(--rc-warn); color: var(--rc-warn) }
      .find { list-style: none; padding-left: 0 } .find li { padding-left: 14px; position: relative }
      .find li::before { content: ''; position: absolute; left: 0; top: 7px; width: 7px; height: 7px; border-radius: 50% }
      .find li.bad::before { background: var(--rc-bad) } .find li.ask::before { background: var(--rc-warn) }
      .ok { color: var(--rc-muted) } .note { color: var(--rc-muted); font-size: 12px; margin: 4px 0 }
      .block { display: block; width: 100%; text-align: left; margin: 5px 0; padding: 6px 9px }
      .block b { display: block; font-weight: 600; margin-bottom: 2px } .block code { display: block; white-space: pre; overflow: hidden; text-overflow: ellipsis; font-size: 11.5px; opacity: .85 }
      option.off { color: var(--rc-muted) }
      details { margin: 4px 0 } summary { cursor: pointer; font-weight: 600 }
    </style></head><body>
      <h3>This program is a</h3>
      <select id="kind" aria-label="Kind of program">${kindOptions}</select>
      ${doc ? (kind !== inFile ? `<p class="note">${esc(name)} says ${esc(programKind(inFile).label)} on its /PROG line; checked here as ${esc(programKind(kind).label.toLowerCase())}.</p>` : '') : '<p class="note">No TP program open - pick a kind to read its rules.</p>'}
      <p class="sum">${esc(programKind(kind).summary)}</p>
      ${doc ? `<h3>Check of ${esc(name)}</h3>${check}` : ''}
      <h3>Building blocks</h3>
      <select id="group" aria-label="Group of building blocks">${groupOptions}</select>
      <p class="note">Click a block to put it in at the caret.</p>
      ${blocks}
      <h3>Rules: ${esc(programKind(kind).label)}</h3>
      ${rulesOf(kind)}
      <h3>The other kinds</h3>
      ${others}
      <script>
        const vscode = acquireVsCodeApi();
        document.getElementById('kind').addEventListener('change', e => vscode.postMessage({ type: 'kind', kind: e.target.value }));
        document.getElementById('group').addEventListener('change', e => vscode.postMessage({ type: 'group', group: e.target.value }));
        for (const b of document.querySelectorAll('button.block')) b.addEventListener('click', () => vscode.postMessage({ type: 'insert', block: Number(b.dataset.block) }));
        for (const a of document.querySelectorAll('a[data-line]')) a.addEventListener('click', e => { e.preventDefault(); vscode.postMessage({ type: 'goto', line: Number(a.dataset.line) }); });
      </script>
    </body></html>`, view.webview.cspSource);
  }
}
