/**
 * The VS Code side of RAPID: outline, go-to-definition, hover, folding, completion and
 * diagnostics, all built on the pure parser in this folder (see docs/ABB_RAPID_WIRING.md).
 *
 * A RAPID name is resolved the way the controller resolves it: inside the routine first
 * (parameters, routine data), then the module, then every module of the same task, then the
 * shared modules. In a backup a task is a `RAPID/TASKn` folder (its SYSMOD and PROGMOD
 * together) and the shared modules sit in `RAPID/TASK0`; anywhere else the folder the file
 * is in stands for the task.
 */
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Services } from '@core/services';
import { ParseCache, spanToRange, debounce } from '@core/util';
import { parseRapid, routineAt, moduleSymbols, robTargetsOf, parseJointTarget, isUnusedAxis, type RapidModule, type RapidRoutine, type Span } from './parser';
import { diagnoseModule, diagnoseTask } from './diagnostics';
import { rapidFindings } from '../lint';
import { lintDiagnostics, lintSettingsFor, onDidChangeLintConfig } from '@core/lint/vscodeLint';
import { lookupRapidDoc, rapidDocMarkdown } from './docs';
import { RAPID_BUILTIN_SPELLINGS } from './builtins';
import { taskFoldersOf } from './task';
import { registerRapidNavigation } from './navigation';
import { formatRapid, detectRapidIndent, type RapidIndent } from './format';
import { rapidRef, rapidRefEntries, rapidRefMarkdown, instructionSnippet, positionalArgs, callContext, PREDEFINED, type RapidRefEntry, type RapidRefArg } from './reference';
import { config } from '@core/util';
import { backupRootOf } from '../backupInfo';
import { backupSignals, liveSignals, signalFits, type IoSignal } from '../signals';

/**
 * The indent a document is formatted and typed with. In order: what was set for this file by
 * hand (ABB RAPID: Set Indentation..., or the tab size picked in the status bar), then
 * `robotCode.rapid.format.baseIndent` / `.indentSize` / `.insertSpaces` (per workspace folder, so
 * each customer's cell can carry its own), each "auto" by default - read off the file itself,
 * falling back to what most controllers in the corpus use.
 */
export interface RapidIndentOverride { base?: number; step?: number; useTabs?: boolean }
const manualIndent = new Map<string, RapidIndentOverride>();
export function setManualRapidIndent(uri: vscode.Uri, o: RapidIndentOverride | undefined): void {
  if (o) manualIndent.set(uri.toString(), { ...manualIndent.get(uri.toString()), ...o });
  else manualIndent.delete(uri.toString());
}

export function rapidIndentFor(doc: vscode.TextDocument): RapidIndent {
  const m = manualIndent.get(doc.uri.toString()) ?? {};
  const b = config<number | 'auto'>('rapid.format.baseIndent', 'auto', doc.uri);
  const s = config<number | 'auto'>('rapid.format.indentSize', 'auto', doc.uri);
  const sp = config<boolean | 'auto'>('rapid.format.insertSpaces', 'auto', doc.uri);
  const det = b === 'auto' || s === 'auto' || sp === 'auto' ? detectRapidIndent(doc.getText()) : {};
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : undefined);
  const step = Math.max(1, m.step ?? num(s) ?? det.step ?? 4);
  return {
    base: m.base ?? num(b) ?? det.base ?? 2,
    step,
    useTabs: m.useTabs ?? (typeof sp === 'boolean' ? !sp : det.useTabs ?? false),
    tabWidth: step,
  };
}

const SEL: vscode.DocumentSelector = { language: 'abb-rapid' };
const RAPID_FILE = /\.(mod|prg|sys)$/i;
const U = (s: string) => s.toUpperCase();

// ---------------------------------------------------------------- task folders

/** Modules read off disk, re-parsed only when the file's mtime moves. */
class DiskModules {
  private readonly cache = new Map<string, { mtime: number; mod: RapidModule }>();
  get(fsPath: string): RapidModule | undefined {
    try {
      const st = fs.statSync(fsPath);
      const hit = this.cache.get(fsPath);
      if (hit && hit.mtime === st.mtimeMs) return hit.mod;
      // controllers write Latin-1; no BOM in any real backup
      const mod = parseRapid(fs.readFileSync(fsPath, 'latin1'));
      this.cache.set(fsPath, { mtime: st.mtimeMs, mod });
      return mod;
    } catch { return undefined; }
  }
  inFolders(folders: string[]): { fsPath: string; mod: RapidModule }[] {
    const out: { fsPath: string; mod: RapidModule }[] = [];
    for (const d of folders) {
      let names: string[] = [];
      try { names = fs.readdirSync(d).filter(n => RAPID_FILE.test(n)); } catch { continue; }
      for (const n of names) { const p = path.join(d, n); const mod = this.get(p); if (mod) out.push({ fsPath: p, mod }); }
    }
    return out;
  }
}

// ---------------------------------------------------------------- registration

export function registerRapidProviders(ctx: vscode.ExtensionContext, _s: Services) {
  const parses = new ParseCache<RapidModule>(text => parseRapid(text));
  const disk = new DiskModules();

  /** this document's module plus the other modules of its task (open editors win over disk) */
  const taskOf = (doc: vscode.TextDocument): { own: RapidModule; others: { uri: vscode.Uri; mod: RapidModule }[]; shared: { uri: vscode.Uri; mod: RapidModule }[] } => {
    const own = parses.get(doc);
    if (doc.uri.scheme !== 'file') return { own, others: [], shared: [] };
    const open = new Map(vscode.workspace.textDocuments.filter(d => d.languageId === 'abb-rapid' && d.uri.scheme === 'file').map(d => [d.uri.fsPath.toLowerCase(), d]));
    const pick = (list: { fsPath: string; mod: RapidModule }[]) => list
      .filter(x => x.fsPath.toLowerCase() !== doc.uri.fsPath.toLowerCase())
      .map(x => { const o = open.get(x.fsPath.toLowerCase()); return { uri: vscode.Uri.file(x.fsPath), mod: o ? parses.get(o) : x.mod }; });
    const f = taskFoldersOf(doc.uri.fsPath);
    return { own, others: pick(disk.inFolders(f.task)), shared: pick(disk.inFolders(f.shared)) };
  };

  // references, rename, highlights, Ctrl+T, lenses, quick fixes, Go to Label, call graph (navigation.ts)
  registerRapidNavigation(ctx, taskOf, doc => parses.get(doc));

  // ---- diagnostics ----
  const diags = vscode.languages.createDiagnosticCollection('abb-rapid');
  const lint = (doc: vscode.TextDocument) => {
    if (doc.languageId !== 'abb-rapid') return;
    const t = taskOf(doc);
    const issues = t.others.length || t.shared.length
      ? diagnoseTask([t.own, ...t.others.map(o => o.mod)], { shared: t.shared.map(o => o.mod) })[0]
      : diagnoseModule(t.own);
    // style rules and .robotlint.json as Lint Folder and robot-lint apply them (../lint.ts)
    diags.set(doc.uri, lintDiagnostics(rapidFindings(t.own, issues, lintSettingsFor(doc.uri)), doc.uri, 'ABB RAPID'));
  };
  const lintSoon = debounce(lint, 300);
  ctx.subscriptions.push(
    diags,
    vscode.workspace.onDidOpenTextDocument(lint),
    vscode.workspace.onDidChangeTextDocument(e => lintSoon(e.document)),
    vscode.workspace.onDidCloseTextDocument(d => { diags.delete(d.uri); parses.drop(d.uri); }),
    { dispose: () => lintSoon.cancel() },
    onDidChangeLintConfig(() => { for (const d of vscode.workspace.textDocuments) lint(d); }),
  );
  for (const d of vscode.workspace.textDocuments) lint(d);

  // ---- outline ----
  const range = (start: number, end: number | undefined, doc: vscode.TextDocument) => new vscode.Range(start, 0, Math.min(end ?? start, doc.lineCount - 1), doc.lineAt(Math.min(end ?? start, doc.lineCount - 1)).text.length);
  ctx.subscriptions.push(vscode.languages.registerDocumentSymbolProvider(SEL, {
    provideDocumentSymbols(doc) {
      const mod = parses.get(doc);
      const dataSym = (d: RapidModule['data'][number]) => new vscode.DocumentSymbol(d.name, `${d.storage} ${d.type}`, /^(robtarget|jointtarget)$/i.test(d.type) ? vscode.SymbolKind.Struct : d.storage === 'CONST' ? vscode.SymbolKind.Constant : vscode.SymbolKind.Variable, spanToRange(d.nameSpan), spanToRange(d.nameSpan));
      const routines = mod.routines.map(r => {
        const s = new vscode.DocumentSymbol(r.name, r.signature, r.kind === 'FUNC' ? vscode.SymbolKind.Function : r.kind === 'TRAP' ? vscode.SymbolKind.Event : vscode.SymbolKind.Method, range(r.startLine, r.endLine, doc), spanToRange(r.nameSpan));
        s.children = r.data.map(dataSym);
        return s;
      });
      const records = mod.records.map(r => new vscode.DocumentSymbol(r.name, 'RECORD', vscode.SymbolKind.Class, range(r.startLine, r.endLine, doc), spanToRange(r.nameSpan)));
      const items = [...mod.data.map(dataSym), ...records, ...routines];
      if (!mod.name || !mod.nameSpan) return items;
      const top = new vscode.DocumentSymbol(mod.name, mod.attributes.join(', '), vscode.SymbolKind.Module, new vscode.Range(0, 0, doc.lineCount - 1, 0), spanToRange(mod.nameSpan));
      top.children = items;
      return [top];
    },
  }));

  // ---- definition ----
  const wordAt = (doc: vscode.TextDocument, pos: vscode.Position) => { const r = doc.getWordRangeAtPosition(pos, /[A-Za-z_][A-Za-z0-9_]*/); return r ? doc.getText(r) : undefined; };
  const inRoutine = (r: RapidRoutine | undefined, name: string): Span | undefined => {
    if (!r) return undefined;
    return r.params.find(p => U(p.name) === name)?.nameSpan ?? r.data.find(d => U(d.name) === name)?.nameSpan ?? r.labels.find(l => U(l.name) === name)?.span;
  };
  ctx.subscriptions.push(vscode.languages.registerDefinitionProvider(SEL, {
    provideDefinition(doc, pos) {
      const w = wordAt(doc, pos); if (!w) return;
      const name = U(w);
      const t = taskOf(doc);
      const local = inRoutine(routineAt(t.own, pos.line), name) ?? moduleSymbols(t.own).find(x => U(x.name) === name)?.span;
      if (local) return new vscode.Location(doc.uri, spanToRange(local));
      const out: vscode.Location[] = [];
      for (const o of [...t.others, ...t.shared]) {
        // LOCAL declarations are invisible outside their own module
        for (const x of moduleSymbols(o.mod)) if (!x.local && U(x.name) === name) out.push(new vscode.Location(o.uri, spanToRange(x.span)));
      }
      return out;
    },
  }));

  // ---- hover ----
  const fmt = (n: number) => (Math.abs(n) < 1e-9 ? '0' : Number(n.toFixed(3)).toString());
  ctx.subscriptions.push(vscode.languages.registerHoverProvider(SEL, {
    provideHover(doc, pos) {
      const w = wordAt(doc, pos); if (!w) return;
      const name = U(w);
      const t = taskOf(doc);
      const r = routineAt(t.own, pos.line);
      const all = [t.own, ...t.others.map(o => o.mod), ...t.shared.map(o => o.mod)];
      const routine = all.flatMap(m => m.routines).find(x => U(x.name) === name);
      if (routine) return new vscode.Hover(new vscode.MarkdownString().appendCodeblock(routine.signature, 'rapid').appendMarkdown(routine.doc ? `\n\n${routine.doc}` : ''));
      const data = [...(r?.data ?? []), ...all.flatMap(m => m.data)].find(d => U(d.name) === name);
      if (data) {
        const md = new vscode.MarkdownString().appendCodeblock(data.detail, 'rapid');
        if (data.doc) md.appendMarkdown(`\n\n${data.doc}`);
        const rt = robTargetsOf(data);
        if (rt?.length === 1) {
          const p = rt[0];
          const ext = p.extax.map((v, i) => (isUnusedAxis(v) ? '' : `${'abcdef'[i]} ${fmt(v)}`)).filter(Boolean);
          md.appendMarkdown(`\n\n| | |\n|---|---|\n| X · Y · Z | ${p.trans.map(fmt).join(' · ')} mm |\n| q1..q4 | ${p.rot.map(v => v.toFixed(5)).join(' · ')} |\n| cf1 cf4 cf6 cfx | ${p.robconf.join(' · ')} |${ext.length ? `\n| external | ${ext.join(' · ')} |` : ''}`);
        } else if (rt && rt.length > 1) md.appendMarkdown(`\n\n${rt.length} robtargets`);
        else if (/^jointtarget$/i.test(data.type) && data.init) {
          const j = parseJointTarget(data.init.text);
          if (j) md.appendMarkdown(`\n\n| | |\n|---|---|\n| rax 1..6 | ${j.robax.map(fmt).join(' · ')} deg |`);
        }
        return new vscode.Hover(md);
      }
      const ref = rapidRef(w);
      if (ref) return new vscode.Hover(new vscode.MarkdownString(rapidRefMarkdown(ref)));
      const d = lookupRapidDoc(w);
      if (d) return new vscode.Hover(new vscode.MarkdownString(rapidDocMarkdown(d)));
      return undefined;
    },
  }));

  // ---- formatting: VB-style indentation from the customer's base (see format.ts) ----
  const toEdits = (doc: vscode.TextDocument, range?: vscode.Range) =>
    formatRapid(doc.getText(), rapidIndentFor(doc), range && { start: range.start.line, end: range.end.line })
      .map(e => vscode.TextEdit.replace(doc.lineAt(e.line).range, e.newText));
  ctx.subscriptions.push(
    vscode.languages.registerDocumentFormattingEditProvider(SEL, { provideDocumentFormattingEdits: doc => toEdits(doc) }),
    vscode.languages.registerDocumentRangeFormattingEditProvider(SEL, { provideDocumentRangeFormattingEdits: (doc, range) => toEdits(doc, range) }),
  );
  // Enter indents by the same step Format uses: the editor's tab size follows it. A tab size or
  // tabs/spaces picked by hand in the status bar is kept for that file, and Format follows it too.
  const applied = new Map<string, { tabSize: number; insertSpaces: boolean }>();
  const tune = (ed: vscode.TextEditor | undefined) => {
    if (!ed || ed.document.languageId !== 'abb-rapid') return;
    const { step, useTabs } = rapidIndentFor(ed.document);
    applied.set(ed.document.uri.toString(), { tabSize: step, insertSpaces: !useTabs });
    if (ed.options.tabSize !== step || ed.options.insertSpaces !== !useTabs) ed.options = { ...ed.options, tabSize: step, insertSpaces: !useTabs, indentSize: step } as vscode.TextEditorOptions;
  };
  ctx.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(tune),
    vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('robotCode.rapid.format')) tune(vscode.window.activeTextEditor); }),
    vscode.window.onDidChangeTextEditorOptions(e => {
      const doc = e.textEditor.document;
      if (doc.languageId !== 'abb-rapid') return;
      const was = applied.get(doc.uri.toString());
      const tabSize = typeof e.options.tabSize === 'number' ? e.options.tabSize : undefined;
      const insertSpaces = typeof e.options.insertSpaces === 'boolean' ? e.options.insertSpaces : undefined;
      if (!was || tabSize === undefined || insertSpaces === undefined) return;
      if (tabSize === was.tabSize && insertSpaces === was.insertSpaces) return;   // our own change
      setManualRapidIndent(doc.uri, { step: tabSize, useTabs: !insertSpaces });
      applied.set(doc.uri.toString(), { tabSize, insertSpaces });
    }),
    vscode.workspace.onDidCloseTextDocument(d => { setManualRapidIndent(d.uri, undefined); applied.delete(d.uri.toString()); }),
    vscode.commands.registerCommand('robotCode.rapid.setIndentation', () => pickRapidIndentation(tune)),
  );
  tune(vscode.window.activeTextEditor);

  // ---- folding ----
  ctx.subscriptions.push(vscode.languages.registerFoldingRangeProvider(SEL, {
    provideFoldingRanges(doc) {
      return parses.get(doc).blocks.filter(b => b.close && b.close.line > b.open.line).map(b => new vscode.FoldingRange(b.open.line, b.close!.line));
    },
  }));

  // ---- what the cursor is in: the statement so far, and the call around it ----
  /**
   * The statement the cursor is in, up to the cursor. A RAPID statement only carries on to the
   * next line after a comma, an operator or an open bracket, so earlier lines join only when
   * they end like that - a block header (`PROC main()`, `IF x THEN`) above never does.
   */
  const textBefore = (doc: vscode.TextDocument, pos: vscode.Position) => {
    const parts = [doc.lineAt(pos.line).text.slice(0, pos.character)];
    for (let ln = pos.line - 1; ln >= Math.max(0, pos.line - 20); ln--) {
      const code = doc.lineAt(ln).text.replace(/"(?:[^"]|"")*"/g, '""').replace(/!.*$/, '').trimEnd();
      if (!/(,|\(|\[|:=|[+\-*/<>=]|\\|\b(AND|OR|XOR|NOT|DIV|MOD))$/i.test(code)) break;
      parts.unshift(doc.lineAt(ln).text);
    }
    return parts.join('\n');
  };
  /** a built-in, or one of the task's own routines turned into the same shape */
  const calleeOf = (doc: vscode.TextDocument, name: string, paren: boolean | undefined): RapidRefEntry | undefined => {
    const ref = rapidRef(name, paren ? 'function' : 'instruction') ?? rapidRef(name);
    if (ref && ref.kind !== 'type') return ref;
    const t = taskOf(doc);
    const r = [t.own, ...t.others.map(o => o.mod), ...t.shared.map(o => o.mod)].flatMap(m => m.routines).find(x => U(x.name) === U(name));
    if (!r) return undefined;
    return {
      name: r.name, kind: r.kind === 'FUNC' ? 'function' : 'instruction', summary: r.doc ?? `${r.kind} in this task`, syntax: r.signature,
      returns: r.returnType, args: r.params.map(p => ({ name: p.name, type: p.type, optional: p.optional, switch: p.switch, alt: p.altGroup })),
    };
  };
  const inComment = (line: string) => /^(?:[^"!]|"(?:[^"]|"")*")*!/.test(line);

  // ---- signature help: the syntax, with the argument being written highlighted ----
  ctx.subscriptions.push(vscode.languages.registerSignatureHelpProvider(SEL, {
    provideSignatureHelp(doc, pos) {
      if (inComment(doc.lineAt(pos).text.slice(0, pos.character))) return undefined;
      const c = callContext(textBefore(doc, pos));
      if (!c) return undefined;
      const e = calleeOf(doc, c.name, c.paren);
      if (!e?.args?.length) return undefined;
      const sig = new vscode.SignatureInformation(e.syntax, new vscode.MarkdownString(e.summary));
      let from = 0;
      sig.parameters = e.args.map(a => {
        // label by offsets into the syntax, so the highlight lands on this argument even when names repeat
        const needle = a.optional || a.switch ? `\\${a.name}` : a.name;
        let at = e.syntax.indexOf(needle, from);
        if (at < 0) at = e.syntax.indexOf(a.name);
        if (at >= 0) from = at + needle.length;
        const doc = `${a.type ? `*${a.type}*` : ''}${a.optional ? ' (optional)' : ''}${a.desc ? ` - ${a.desc}` : ''}`;
        return new vscode.ParameterInformation(at >= 0 ? [at, at + needle.length] : a.name, new vscode.MarkdownString(doc));
      });
      const help = new vscode.SignatureHelp();
      help.signatures = [sig];
      const req = positionalArgs(e);
      const target: RapidRefArg | undefined = c.optional ? e.args.find(a => U(a.name) === U(c.optional!)) : req[c.index];
      help.activeParameter = target ? e.args.indexOf(target) : -1;
      return help;
    },
  }, { triggerCharacters: [' ', ',', '(', '\\'], retriggerCharacters: [','] }));

  // ---- completion: what fits where the cursor is ----
  ctx.subscriptions.push(vscode.languages.registerCompletionItemProvider(SEL, {
    provideCompletionItems(doc, pos) {
      const lineBefore = doc.lineAt(pos).text.slice(0, pos.character);
      if (inComment(lineBefore)) return [];
      const t = taskOf(doc);
      const routine = routineAt(t.own, pos.line);
      const mods = [t.own, ...t.others.map(o => o.mod), ...t.shared.map(o => o.mod)];
      const items: vscode.CompletionItem[] = [];
      const seen = new Set<string>();
      const add = (label: string, kind: vscode.CompletionItemKind, detail: string | undefined, sort: string, extra?: (it: vscode.CompletionItem) => void) => {
        if (seen.has(U(label))) return;
        seen.add(U(label));
        const it = new vscode.CompletionItem(label, kind); it.detail = detail; it.sortText = `${sort}${label.toLowerCase()}`;
        extra?.(it); items.push(it);
      };
      // data visible here: the routine's parameters and data, the module's, the task's global data
      const data = [
        ...(routine?.params ?? []).map(p => ({ name: p.name, type: p.type, detail: `parameter ${p.mode === 'IN' ? '' : p.mode + ' '}${p.type}` })),
        ...(routine?.data ?? []).map(d => ({ name: d.name, type: d.type, detail: d.detail })),
        ...mods.flatMap(m => m.data.filter(d => m === t.own || d.scope !== 'LOCAL').map(d => ({ name: d.name, type: d.type, detail: d.detail }))),
      ];
      const c = callContext(textBefore(doc, pos));
      // I/O signals: the backup's EIO.cfg, then whatever connected controllers have read
      let signals: IoSignal[] | undefined;
      const signalsHere = () => {
        if (signals) return signals;
        const root = doc.uri.scheme === 'file' ? backupRootOf(doc.uri.fsPath) : undefined;
        const names = new Set<string>();
        signals = [...(root ? backupSignals(root) : []), ...liveSignals()].filter(x => !names.has(U(x.name)) && names.add(U(x.name)));
        return signals;
      };
      const addSignal = (x: IoSignal, sort: string) => add(x.name, vscode.CompletionItemKind.Event, `signal${x.type.toLowerCase()}${x.device ? ` on ${x.device}` : ''}${x.label ? ` - ${x.label}` : ''}`, sort);

      // after a backslash: the optional arguments of the call being written
      if (c && /\\\w*$/.test(lineBefore)) {
        const e = calleeOf(doc, c.name, c.paren);
        for (const a of e?.args?.filter(x => x.optional || x.switch) ?? []) {
          add(a.name, vscode.CompletionItemKind.Property, `${a.switch ? 'switch' : a.type ?? ''} - optional argument of ${e!.name}`, '0', it => {
            it.insertText = a.switch || a.type === 'switch' ? a.name : new vscode.SnippetString(`${a.name}:=\${1}`);
            it.documentation = a.desc;
          });
        }
        return items;
      }

      const e = c ? calleeOf(doc, c.name, c.paren) : undefined;
      const arg = e && c && !c.optional ? positionalArgs(e)[c.index] : undefined;
      if (arg?.type) {
        // an argument of a known type: that type's data first, then RobotWare's predefined ones, then functions that return it
        const ty = arg.type.toLowerCase();
        for (const d of data) if (d.type.toLowerCase() === ty) add(d.name, vscode.CompletionItemKind.Variable, d.detail, '0');
        for (const x of signalsHere()) if (signalFits(x.type, ty)) addSignal(x, ty.startsWith('signal') ? '0' : '3');
        // in the order RobotWare lists them (v5 ... vmax, fine z0 ... z200), not alphabetical
        (PREDEFINED[ty] ?? []).forEach((p, i) => add(p, vscode.CompletionItemKind.Constant, `predefined ${arg.type}`, `1${String(i).padStart(3, '0')}`));
        for (const f of rapidRefEntries('function')) if (f.returns?.toLowerCase() === ty) add(f.name, vscode.CompletionItemKind.Function, `${f.returns} - ${f.summary}`, '2', it => { it.insertText = new vscode.SnippetString(`${f.name}(\${1})`); });
        for (const m of mods) for (const r of m.routines) if (r.kind === 'FUNC' && r.returnType?.toLowerCase() === ty && (m === t.own || !r.local)) add(r.name, vscode.CompletionItemKind.Function, r.signature, '2', it => { it.insertText = new vscode.SnippetString(`${r.name}(\${1})`); });
        for (const d of data) add(d.name, vscode.CompletionItemKind.Variable, d.detail, '8');
        return items;
      }

      // the start of a statement: instructions with their required arguments as placeholders, and the task's routines
      const atStart = !c && /^\s*[A-Za-z_]*$/.test(lineBefore);
      if (atStart) {
        for (const i of rapidRefEntries('instruction')) add(i.name, vscode.CompletionItemKind.Keyword, i.syntax, '1', it => { it.insertText = new vscode.SnippetString(instructionSnippet(i)); it.documentation = new vscode.MarkdownString(rapidRefMarkdown(i)); });
        for (const m of mods) for (const r of m.routines) if (r.kind === 'PROC' && (m === t.own || !r.local)) {
          const req = r.params.filter(p => !p.optional);
          add(r.name, vscode.CompletionItemKind.Method, r.signature, '0', it => { it.insertText = new vscode.SnippetString(req.length ? `${r.name} ${req.map((p, i) => `\${${i + 1}:${p.name}}`).join(', ')};` : `${r.name};`); });
        }
      }
      for (const d of data) add(d.name, vscode.CompletionItemKind.Variable, d.detail, '3');
      // in a condition or an expression (IF, WHILE, TEST, :=) a signal reads as its value
      if (!atStart) for (const x of signalsHere()) addSignal(x, '3');
      for (const m of mods) for (const r of m.routines) if (r.kind === 'FUNC' && (m === t.own || !r.local)) add(r.name, vscode.CompletionItemKind.Function, r.signature, '4');
      for (const f of rapidRefEntries('function')) add(f.name, vscode.CompletionItemKind.Function, `${f.returns ?? ''} - ${f.summary}`, '5', it => { it.documentation = new vscode.MarkdownString(rapidRefMarkdown(f)); });
      for (const ty of rapidRefEntries('type')) add(ty.name, vscode.CompletionItemKind.TypeParameter, ty.summary, '6');
      // without the reference (an older build) the plain name lists still work
      for (const n of RAPID_BUILTIN_SPELLINGS.instructions) add(n, vscode.CompletionItemKind.Keyword, 'instruction', '7');
      for (const n of RAPID_BUILTIN_SPELLINGS.functions) add(n, vscode.CompletionItemKind.Function, 'function', '7');
      for (const n of RAPID_BUILTIN_SPELLINGS.types) add(n, vscode.CompletionItemKind.TypeParameter, 'data type', '7');
      return items;
    },
  }, '\\', ' ', ','));
}

/** ABB RAPID: Set Indentation... - step, base and tabs/spaces, for this file or saved for the folder */
async function pickRapidIndentation(tune: (ed: vscode.TextEditor | undefined) => void): Promise<void> {
  const ed = vscode.window.activeTextEditor;
  if (!ed || ed.document.languageId !== 'abb-rapid') { vscode.window.showInformationMessage('Open a RAPID module first.'); return; }
  const doc = ed.document;
  const cur = rapidIndentFor(doc);
  const askNumber = async (title: string, value: number, min: number) => {
    const v = await vscode.window.showInputBox({ title, value: String(value), validateInput: x => (/^\d+$/.test(x.trim()) && +x >= min && +x <= 16 ? undefined : `A whole number from ${min} to 16`) });
    return v === undefined ? undefined : parseInt(v, 10);
  };
  type Item = vscode.QuickPickItem & { value: number | 'auto' | 'custom' };
  const pickNum = async (title: string, current: number, options: number[], min: number): Promise<number | 'auto' | undefined> => {
    const items: Item[] = [
      { label: 'Auto', description: 'read it off the file', value: 'auto' },
      ...options.map((n): Item => ({ label: `${n}`, description: n === current ? 'current' : undefined, value: n })),
      { label: 'Other…', value: 'custom' },
    ];
    const p = await vscode.window.showQuickPick(items, { title, placeHolder: `now ${current}` });
    if (!p) return undefined;
    return p.value === 'custom' ? askNumber(title, current, min) : p.value;
  };
  const step = await pickNum('RAPID indent size (spaces per block level)', cur.step, [2, 3, 4, 8], 1);
  if (step === undefined) return;
  const base = await pickNum('RAPID base indent (spaces before everything inside MODULE)', cur.base, [0, 2, 4], 0);
  if (base === undefined) return;
  const kind = await vscode.window.showQuickPick([
    { label: 'Spaces', value: false, description: cur.useTabs ? undefined : 'current' },
    { label: 'Tabs', value: true, description: cur.useTabs ? 'current' : undefined, detail: 'one tab per indent size; leftover columns in spaces' },
  ], { title: 'Indent with' });
  if (!kind) return;
  const scope = await vscode.window.showQuickPick([
    { label: 'This file', value: 'file', detail: 'until it is closed; nothing is saved' },
    { label: 'This workspace folder', value: 'folder', detail: 'saved in the folder settings as robotCode.rapid.format.*' },
  ], { title: 'Apply to' });
  if (!scope) return;
  setManualRapidIndent(doc.uri, undefined);
  if (scope.value === 'file') {
    const o: RapidIndentOverride = { useTabs: kind.value };
    if (step !== 'auto') o.step = step;
    if (base !== 'auto') o.base = base;
    setManualRapidIndent(doc.uri, o);
  } else {
    const cfg = vscode.workspace.getConfiguration('robotCode', doc.uri);
    const target = vscode.workspace.getWorkspaceFolder(doc.uri) ? vscode.ConfigurationTarget.WorkspaceFolder : vscode.ConfigurationTarget.Global;
    await cfg.update('rapid.format.indentSize', step, target);
    await cfg.update('rapid.format.baseIndent', base, target);
    await cfg.update('rapid.format.insertSpaces', !kind.value, target);
  }
  tune(ed);
  const go = await vscode.window.showInformationMessage('RAPID indentation set. Re-indent this file now?', 'Format Document');
  if (go) await vscode.commands.executeCommand('editor.action.formatDocument');
}
