import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { type KProgram, type KSymbol, resolveSymbol, routineSignature, findUnused, findUndeclared, stripCommentAndStrings, KAREL_KEYWORDS } from './parser';
import { KAREL_BUILTINS, KAREL_BUILTIN_LIST, KAREL_SYSVARS, KAREL_PREDEFINED, type KBuiltin } from './builtins';
import { FanucServices } from '../services';
import { spanToRange, config, md, debounce } from '@core/util';
import { lintKarel, identifierLengthIssues, karelNameLimits, karelCoreVersionOf, type KarelCoreVersion, type KarelNameLimits } from './lint';
import { compileKarel, ktransDiagnostics, findKtrans } from './ktrans';
import { detectTabWidth } from './tabWidth';
import { includedNames, karelSupportDirs } from './includes';

const SEL = { language: 'fanuc-karel' };
const WORD = /\$?[A-Za-z_][A-Za-z0-9_]*/;

const STATEMENT_KEYWORDS = ['ABORT', 'ATTACH', 'BEGIN', 'CANCEL', 'CASE', 'CLOSE FILE', 'CLOSE HAND', 'CONDITION', 'CONNECT TIMER', 'CONST', 'CONTINUE', 'DELAY', 'DISABLE CONDITION', 'DISCONNECT TIMER', 'DOWNTO', 'ELSE', 'ENABLE CONDITION', 'END', 'ENDCONDITION', 'ENDFOR', 'ENDIF', 'ENDSELECT', 'ENDSTRUCTURE', 'ENDWHILE', 'FOR', 'FROM', 'GO TO', 'HOLD', 'IF', 'MOVE TO', 'MOVE NEAR', 'MOVE AWAY', 'MOVE RELATIVE', 'NOWAIT', 'OPEN FILE', 'OPEN HAND', 'PAUSE', 'PROGRAM', 'PULSE', 'PURGE CONDITION', 'READ', 'RELEASE', 'REPEAT', 'RESUME', 'RETURN', 'ROUTINE', 'SELECT', 'SIGNAL EVENT', 'SIGNAL SEMAPHORE', 'STOP', 'STRUCTURE', 'THEN', 'TYPE', 'UNHOLD', 'UNPAUSE', 'UNTIL', 'USING', 'VAR', 'WAIT FOR', 'WHEN', 'WHILE', 'WITH', 'WRITE'];
const TYPE_KEYWORDS = ['INTEGER', 'REAL', 'BOOLEAN', 'STRING', 'BYTE', 'SHORT', 'ARRAY', 'POSITION', 'XYZWPR', 'XYZWPREXT', 'JOINTPOS', 'JOINTPOS6', 'VECTOR', 'PATH', 'FILE', 'CONFIG', 'CAM_SETUP', 'MODEL', 'VIS_PROCESS', 'QUEUE_TYPE'];
const DIRECTIVES = ['%ALPHABETIZE', '%CMOSVARS', '%CMOS2SHADOW', "%COMMENT = ''", '%CRTDEVICE', '%DEFGROUP = 1', '%DELAY = 0', '%ENVIRONMENT ', '%INCLUDE ', '%LOCKGROUP = 1', '%NOABORT = ERROR + COMMAND', '%NOBUSYLAMP', '%NOLOCKGROUP', '%NOPAUSE = ERROR + COMMAND + TPENABLE', '%NOPAUSESHFT', '%PRIORITY = 50', '%SHADOWVARS', '%STACKSIZE = 500', '%TIMESLICE = 8', '%TPMOTION', '%UNINITVARS'];
const PORTS = ['DIN', 'DOUT', 'GIN', 'GOUT', 'AIN', 'AOUT', 'RDI', 'RDO', 'OPIN', 'OPOUT', 'TPIN', 'TPOUT', 'WDI', 'WDO', 'UIN', 'UOUT', 'FLG'];

export function registerKarelProviders(ctx: vscode.ExtensionContext, s: FanucServices) {
  // A file that mixes tabs and spaces is drawn at the tab width it was written with (tabWidth.ts):
  // 7 for ROBOGUIDE's editor - the language default - 4 for most others. Once per editor and file
  // version, so a width the user picks by hand afterwards is left alone.
  const sized = new WeakMap<vscode.TextEditor, number>();
  const fitTabs = (ed: vscode.TextEditor | undefined) => {
    if (!ed || ed.document.languageId !== 'fanuc-karel' || sized.get(ed) === ed.document.version) return;
    sized.set(ed, ed.document.version);
    if (!config<boolean>('karel.detectTabWidth', true, ed.document)) return;
    const text = ed.document.getText();
    if (!text.includes('\t')) return;
    const w = detectTabWidth(text.split(/\r?\n/));
    if (w && ed.options.tabSize !== w) ed.options = { ...ed.options, tabSize: w };
  };
  for (const ed of vscode.window.visibleTextEditors) fitTabs(ed);
  ctx.subscriptions.push(
    vscode.window.onDidChangeVisibleTextEditors(eds => eds.forEach(fitTabs)),
    vscode.window.onDidChangeActiveTextEditor(fitTabs),
    vscode.languages.registerHoverProvider(SEL, new KHover(s)),
    vscode.languages.registerDefinitionProvider(SEL, new KDefinition(s)),
    vscode.languages.registerReferenceProvider(SEL, new KReferences(s)),
    vscode.languages.registerDocumentHighlightProvider(SEL, new KHighlights(s)),
    vscode.languages.registerDocumentSymbolProvider(SEL, new KSymbols(s)),
    vscode.languages.registerCompletionItemProvider(SEL, new KCompletion(s), '.', '$', '%'),
    vscode.languages.registerSignatureHelpProvider(SEL, new KSignatureHelp(s), '(', ','),
    vscode.languages.registerFoldingRangeProvider(SEL, new KFolding(s)),
    vscode.languages.registerDocumentFormattingEditProvider(SEL, new KFormatter()),
    vscode.languages.registerRenameProvider(SEL, new KRename(s)),
  );
  registerKarelDiagnostics(ctx, s);
  registerKarelCommands(ctx, s);
}

// ---------------------------------------------------------------------------
function wordAt(doc: vscode.TextDocument, pos: vscode.Position): { word: string; range: vscode.Range } | undefined {
  const range = doc.getWordRangeAtPosition(pos, WORD);
  if (!range) return undefined;
  return { word: doc.getText(range), range };
}

/** Resolve `a.b` member access: returns the field symbol if the word is a structure field. */
function resolveMember(prog: KProgram, doc: vscode.TextDocument, range: vscode.Range): KSymbol | undefined {
  const line = doc.lineAt(range.start.line).text;
  if (line[range.start.character - 1] !== '.') return undefined;
  const before = line.slice(0, range.start.character - 1);
  const m = /([A-Za-z_][A-Za-z0-9_]*)(\[[^\]]*\])?\s*$/.exec(before);
  if (!m) return undefined;
  const v = resolveSymbol(prog, m[1].toUpperCase(), range.start.line);
  if (!v?.type) return undefined;
  const typeName = v.type.replace(/^ARRAY\[[^\]]*\]\s*OF\s*/i, '').trim().toUpperCase();
  const st = prog.symbols.find(x => x.kind === 'structure' && x.upper === typeName);
  return st?.fields?.find(f => f.upper === doc.getText(range).toUpperCase());
}

function symbolMarkdown(sym: KSymbol): vscode.MarkdownString {
  const lines: string[] = [];
  const head = sym.kind === 'routine' ? routineSignature(sym) : sym.kind === 'constant' ? `CONST ${sym.name} = ${sym.value ?? ''}` : sym.kind === 'type' ? `TYPE ${sym.name} = ${sym.type ?? ''}` : sym.kind === 'structure' ? `${sym.name} = STRUCTURE (${sym.fields?.length ?? 0} fields)` : sym.kind === 'program' ? `PROGRAM ${sym.name}` : `${sym.name} : ${sym.type ?? ''}`;
  lines.push('```karel', head, '```');
  const scope = sym.kind === 'parameter' ? `parameter of ${sym.scope}` : sym.scope ? `local to ${sym.scope}` : sym.kind === 'field' ? 'structure field' : sym.kind === 'program' ? '' : 'program scope';
  if (scope) lines.push('', `_${sym.kind}, ${scope}_`);
  if (sym.doc) lines.push('', sym.doc);
  return md(...lines);
}

class KHover implements vscode.HoverProvider {
  constructor(private s: FanucServices) {}
  async provideHover(doc: vscode.TextDocument, pos: vscode.Position): Promise<vscode.Hover | undefined> {
    const w = wordAt(doc, pos); if (!w) return undefined;
    const clean = stripCommentAndStrings(doc.lineAt(pos.line).text);
    if (clean[w.range.start.character] === ' ' && doc.lineAt(pos.line).text[w.range.start.character] !== ' ') return undefined; // inside comment/string
    if (w.word.startsWith('$')) {
      // the whole `$GROUP[1].$UFRAME` path, with the reference's description, type, access
      // and storage; the hand-written note for the common ones goes first
      const karelDoc = (name: string) => { const key = Object.keys(KAREL_SYSVARS).find(k => k.toUpperCase() === name.toUpperCase()); return key ? KAREL_SYSVARS[key] : undefined; };
      return (await this.s.sysvars.hover(doc, pos, karelDoc)) ?? new vscode.Hover(md(`**${w.word}** — system variable`), w.range);
    }
    const upper = w.word.toUpperCase();
    const prog = this.s.karel.get(doc);
    const field = resolveMember(prog, doc, w.range);
    if (field) return new vscode.Hover(symbolMarkdown(field), w.range);
    const sym = resolveSymbol(prog, upper, pos.line);
    if (sym) return new vscode.Hover(symbolMarkdown(sym), w.range);
    const b = KAREL_BUILTINS.get(upper);
    if (b) return new vscode.Hover(builtinMarkdown(b), w.range);
    if (PORTS.includes(upper)) return new vscode.Hover(md(`**${upper}[n]** — I/O port array (read/write like a variable)`), w.range);
    return undefined;
  }
}

/**
 * The hover for a built-in, laid out like the TP one (beta list 2, item 11): a title line
 * saying what it is, the signature as code with one parameter per line when there are
 * several (`WRITE_DICT_V(file_var : FILE; dict_name : STRING; ...)` on one line was the
 * "all one liney" popup), the description as its own paragraph, and the return type named.
 * A statement (WRITE, READ, DELAY ...) is called a statement, not a routine.
 */
export function builtinMarkdown(b: KBuiltin): vscode.MarkdownString {
  const isStatement = /^Statement\b/i.test(b.doc) || (!/\(/.test(b.sig) && b.sig.includes(' '));
  const paren = /^([A-Za-z_][A-Za-z0-9_]*)\s*\((.*)\)\s*$/s.exec(b.sig);
  let sigLines: string[];
  if (paren && paren[2].includes(';')) {
    const params = paren[2].split(';').map(p => p.trim()).filter(Boolean);
    sigLines = [`${paren[1]}(`, ...params.map((p, i) => `    ${p}${i < params.length - 1 ? ';' : ''}`), `)${b.ret ? ` : ${b.ret}` : ''}`];
  } else {
    sigLines = [b.sig + (b.ret ? ` : ${b.ret}` : '')];
  }
  const doc = b.doc.replace(/^Statement:\s*/i, '');
  const lines = [`**${b.name}** — ${isStatement ? 'KAREL statement' : b.ret ? `built-in function, returns ${b.ret}` : 'built-in routine'}`, '', '```karel', ...sigLines, '```', '', doc];
  if (paren && paren[2].includes(';')) lines.push('', `_${paren[2].split(';').filter(Boolean).length} parameters; \`VAR\` ones are written by the routine._`);
  return md(...lines);
}

class KDefinition implements vscode.DefinitionProvider {
  constructor(private s: FanucServices) {}
  async provideDefinition(doc: vscode.TextDocument, pos: vscode.Position): Promise<vscode.Definition | undefined> {
    const lineText = doc.lineAt(pos.line).text;
    const inc = /^\s*%INCLUDE\s+([A-Za-z0-9_\-.]+)/i.exec(lineText);
    if (inc) {
      const name = inc[1].replace(/\.kl$/i, '');
      const found = await vscode.workspace.findFiles(`**/${name}.{kl,KL,Kl,kL}`, undefined, 1);
      if (found.length) return new vscode.Location(found[0], new vscode.Position(0, 0));
      const local = vscode.Uri.file(path.join(path.dirname(doc.uri.fsPath), `${name}.kl`));
      try { await vscode.workspace.fs.stat(local); return new vscode.Location(local, new vscode.Position(0, 0)); } catch { return undefined; }
    }
    const w = wordAt(doc, pos); if (!w || w.word.startsWith('$')) return undefined;
    const prog = this.s.karel.get(doc);
    const upper = w.word.toUpperCase();
    const field = resolveMember(prog, doc, w.range);
    if (field) return new vscode.Location(doc.uri, spanToRange(field.span));
    const sym = resolveSymbol(prog, upper, pos.line);
    if (sym) {
      if (sym.kind === 'routine' && sym.from) {
        // external routine: jump into the providing program
        const info = this.s.index.get(sym.from, doc.uri);
        if (info) {
          const other = await vscode.workspace.openTextDocument(info.uri);
          const op = this.s.karel.get(other);
          const r = op.routines.find(x => x.upper === upper && !x.from);
          if (r) return new vscode.Location(info.uri, spanToRange(r.span));
          return new vscode.Location(info.uri, new vscode.Position(0, 0));
        }
      }
      if (sym.kind === 'parameter') {
        const r = prog.routines.find(x => x.upper === sym.scope);
        if (r) { const text = doc.lineAt(r.line).text; const col = text.toUpperCase().indexOf(upper, text.indexOf('(')); if (col >= 0) return new vscode.Location(doc.uri, new vscode.Range(r.line, col, r.line, col + sym.name.length)); }
      }
      return new vscode.Location(doc.uri, spanToRange(sym.span));
    }
    // "ROUTINE x FROM prog" → prog; also CALL_PROG('NAME'
    const fromM = /\bFROM\s+([A-Za-z_][A-Za-z0-9_]*)/i.exec(lineText);
    if (fromM && fromM[1].toUpperCase() === upper) { const info = this.s.index.get(upper, doc.uri); if (info) return new vscode.Location(info.uri, new vscode.Position(0, 0)); }
    return undefined;
  }
}

function refsOf(prog: KProgram, uri: vscode.Uri, upper: string, atLine: number): vscode.Location[] {
  const sym = resolveSymbol(prog, upper, atLine);
  const out: vscode.Location[] = [];
  if (sym && sym.span.len > 0) out.push(new vscode.Location(uri, spanToRange(sym.span)));
  for (const r of prog.refs) {
    if (r.upper !== upper) continue;
    // if symbol is routine-local, only include refs inside that routine
    if (sym?.scope && sym.kind !== 'field') {
      const rt = prog.routines.find(x => x.upper === sym.scope);
      if (rt && (r.line < rt.line || r.line > (rt.endLine ?? Number.MAX_SAFE_INTEGER))) continue;
    }
    out.push(new vscode.Location(uri, spanToRange(r.span)));
  }
  return out;
}

class KReferences implements vscode.ReferenceProvider {
  constructor(private s: FanucServices) {}
  provideReferences(doc: vscode.TextDocument, pos: vscode.Position): vscode.Location[] {
    const w = wordAt(doc, pos); if (!w || w.word.startsWith('$')) return [];
    return refsOf(this.s.karel.get(doc), doc.uri, w.word.toUpperCase(), pos.line);
  }
}
class KHighlights implements vscode.DocumentHighlightProvider {
  constructor(private s: FanucServices) {}
  provideDocumentHighlights(doc: vscode.TextDocument, pos: vscode.Position): vscode.DocumentHighlight[] {
    const w = wordAt(doc, pos); if (!w || w.word.startsWith('$') || KAREL_KEYWORDS.has(w.word.toUpperCase())) return [];
    return refsOf(this.s.karel.get(doc), doc.uri, w.word.toUpperCase(), pos.line).map(l => new vscode.DocumentHighlight(l.range));
  }
}

class KRename implements vscode.RenameProvider {
  constructor(private s: FanucServices) {}
  prepareRename(doc: vscode.TextDocument, pos: vscode.Position): vscode.Range {
    const w = wordAt(doc, pos);
    if (!w || w.word.startsWith('$') || KAREL_KEYWORDS.has(w.word.toUpperCase()) || KAREL_BUILTINS.has(w.word.toUpperCase())) throw new Error('Only user-defined identifiers can be renamed.');
    const prog = this.s.karel.get(doc);
    if (!resolveSymbol(prog, w.word.toUpperCase(), pos.line)) throw new Error('No declaration found for this identifier in this file.');
    return w.range;
  }
  provideRenameEdits(doc: vscode.TextDocument, pos: vscode.Position, newName: string): vscode.WorkspaceEdit {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(newName)) throw new Error('Invalid KAREL identifier.');
    if (newName.length > 12) throw new Error('KAREL identifiers are at most 12 characters.');
    const w = wordAt(doc, pos)!;
    const edit = new vscode.WorkspaceEdit();
    for (const loc of refsOf(this.s.karel.get(doc), doc.uri, w.word.toUpperCase(), pos.line)) edit.replace(doc.uri, loc.range, newName);
    return edit;
  }
}

class KSymbols implements vscode.DocumentSymbolProvider {
  constructor(private s: FanucServices) {}
  provideDocumentSymbols(doc: vscode.TextDocument): vscode.DocumentSymbol[] {
    const prog = this.s.karel.get(doc);
    const out: vscode.DocumentSymbol[] = [];
    const last = doc.lineCount - 1;
    const rng = (a: number, b: number) => new vscode.Range(a, 0, Math.min(b, last), doc.lineAt(Math.min(b, last)).text.length);
    const kindOf = (s: KSymbol) => s.kind === 'routine' ? (s.returnType ? vscode.SymbolKind.Function : vscode.SymbolKind.Method) : s.kind === 'constant' ? vscode.SymbolKind.Constant : s.kind === 'type' ? vscode.SymbolKind.TypeParameter : s.kind === 'structure' ? vscode.SymbolKind.Struct : s.kind === 'field' ? vscode.SymbolKind.Field : s.kind === 'parameter' ? vscode.SymbolKind.TypeParameter : vscode.SymbolKind.Variable;
    const mkSym = (s: KSymbol, range?: vscode.Range) => new vscode.DocumentSymbol(s.name, s.kind === 'routine' ? (s.from ? `FROM ${s.from}` : (s.params ?? []).map(p => p.name).join(', ')) : (s.type ?? s.value ?? ''), kindOf(s), range ?? spanToRange(s.span), spanToRange(s.span));

    if (prog.name && prog.nameSpan) {
      const p = new vscode.DocumentSymbol(prog.name, prog.directives.find(d => d.name === 'COMMENT')?.args.replace(/^=\s*'|'$/g, '') ?? '', vscode.SymbolKind.Module, rng(prog.nameSpan.line, prog.nameSpan.line), spanToRange(prog.nameSpan));
      out.push(p);
    }
    const globals = prog.symbols.filter(s => !s.scope && s.kind !== 'program' && s.kind !== 'routine' && s.kind !== 'field');
    const groups: Array<[string, KSymbol['kind'][], vscode.SymbolKind]> = [['Constants', ['constant'], vscode.SymbolKind.Constant], ['Types', ['type', 'structure'], vscode.SymbolKind.Struct], ['Variables', ['variable'], vscode.SymbolKind.Variable]];
    for (const [title, kinds, k] of groups) {
      const items = globals.filter(s => kinds.includes(s.kind));
      if (!items.length) continue;
      const first = Math.min(...items.map(i => i.line)), lastL = Math.max(...items.map(i => i.endLine ?? i.line));
      const g = new vscode.DocumentSymbol(title, `${items.length}`, k, rng(first, lastL), rng(first, first));
      for (const it of items) {
        const sym = mkSym(it, it.kind === 'structure' ? rng(it.line, it.endLine ?? it.line) : undefined);
        if (it.fields) for (const f of it.fields) sym.children.push(mkSym(f));
        g.children.push(sym);
      }
      out.push(g);
    }
    for (const r of prog.routines) {
      const sym = mkSym(r, rng(r.line, r.endLine ?? r.line));
      for (const l of prog.symbols.filter(s => s.scope === r.upper && s.kind !== 'parameter')) sym.children.push(mkSym(l));
      out.push(sym);
    }
    if (prog.mainBegin !== undefined) out.push(new vscode.DocumentSymbol('BEGIN (main)', '', vscode.SymbolKind.Namespace, rng(prog.mainBegin, prog.mainEnd ?? last), rng(prog.mainBegin, prog.mainBegin)));
    return out;
  }
}

class KCompletion implements vscode.CompletionItemProvider {
  constructor(private s: FanucServices) {}
  async provideCompletionItems(doc: vscode.TextDocument, pos: vscode.Position): Promise<vscode.CompletionItem[]> {
    const line = doc.lineAt(pos.line).text;
    const before = line.slice(0, pos.character);
    const items: vscode.CompletionItem[] = [];
    const prog = this.s.karel.get(doc);

    if (/^\s*%[A-Za-z]*$/.test(before)) {
      const start = before.indexOf('%');
      for (const d of DIRECTIVES) { const it = new vscode.CompletionItem(d, vscode.CompletionItemKind.Keyword); it.range = new vscode.Range(pos.line, start, pos.line, pos.character); items.push(it); }
      return items;
    }
    if (/\$[A-Za-z0-9_]*$/.test(before) || /\$[A-Za-z_][A-Za-z0-9_]*(?:\[[0-9, ]*\])?(?:\.\$?[A-Za-z_][A-Za-z0-9_]*(?:\[[0-9, ]*\])?)*\.\$?[A-Za-z0-9_]*$/.test(before)) {
      // the reference's variables and fields, with the hand-written notes merged in
      const sv = await this.s.sysvars.completions(doc, pos, KAREL_SYSVARS);
      if (sv?.length) return sv;
      const start = before.lastIndexOf('$');
      for (const [k, v] of Object.entries(KAREL_SYSVARS)) { const it = new vscode.CompletionItem(k, vscode.CompletionItemKind.Variable); it.detail = v; it.range = new vscode.Range(pos.line, start, pos.line, pos.character); items.push(it); }
      return items;
    }
    // member access
    const mem = /([A-Za-z_][A-Za-z0-9_]*)(\[[^\]]*\])?\.\s*([A-Za-z_]*)$/.exec(before);
    if (mem) {
      const v = resolveSymbol(prog, mem[1].toUpperCase(), pos.line);
      const typeName = v?.type?.replace(/^ARRAY\[[^\]]*\]\s*OF\s*/i, '').trim().toUpperCase();
      const st = prog.symbols.find(x => x.kind === 'structure' && x.upper === typeName);
      for (const f of st?.fields ?? []) { const it = new vscode.CompletionItem(f.name, vscode.CompletionItemKind.Field); it.detail = f.type; items.push(it); }
      return items;
    }
    if (/^\s*%INCLUDE\s+\S*$/i.test(before)) return items;

    // user symbols in scope
    const routine = prog.routines.find(r => !r.from && r.line <= pos.line && (r.endLine ?? Number.MAX_SAFE_INTEGER) >= pos.line);
    for (const sym of prog.symbols) {
      if (sym.kind === 'program' || sym.kind === 'field') continue;
      if (sym.scope && sym.scope !== routine?.upper) continue;
      const kind = sym.kind === 'routine' ? vscode.CompletionItemKind.Function : sym.kind === 'constant' ? vscode.CompletionItemKind.Constant : sym.kind === 'type' || sym.kind === 'structure' ? vscode.CompletionItemKind.Struct : vscode.CompletionItemKind.Variable;
      const it = new vscode.CompletionItem(sym.name, kind);
      it.detail = sym.kind === 'routine' ? routineSignature(sym) : sym.detail;
      it.documentation = sym.doc;
      if (sym.kind === 'routine' && sym.params?.length) it.insertText = new vscode.SnippetString(`${sym.name}(${sym.params.map((p, i) => `\${${i + 1}:${p.name}}`).join(', ')})`);
      it.sortText = '0' + sym.name;
      items.push(it);
    }
    for (const b of KAREL_BUILTIN_LIST) {
      if (b.sig.includes(' ') && !b.sig.includes('(')) continue; // statements documented as builtins
      const it = new vscode.CompletionItem(b.name, vscode.CompletionItemKind.Function);
      it.detail = b.sig; it.documentation = b.doc; it.sortText = '1' + b.name;
      const params = paramNames(b.sig);
      it.insertText = new vscode.SnippetString(params.length ? `${b.name}(${params.map((p, i) => `\${${i + 1}:${p}}`).join(', ')})` : b.name);
      items.push(it);
    }
    for (const k of STATEMENT_KEYWORDS) { const it = new vscode.CompletionItem(k, vscode.CompletionItemKind.Keyword); it.sortText = '2' + k; items.push(it); }
    for (const k of TYPE_KEYWORDS) { const it = new vscode.CompletionItem(k, vscode.CompletionItemKind.TypeParameter); it.sortText = '2' + k; items.push(it); }
    for (const k of PORTS) { const it = new vscode.CompletionItem(k, vscode.CompletionItemKind.Interface); it.insertText = new vscode.SnippetString(`${k}[\${1:1}]`); it.sortText = '2' + k; items.push(it); }
    return items;
  }
}

function paramNames(sig: string): string[] {
  const m = /\(([^)]*)\)/.exec(sig.replace(/<;([^>]*)>/g, ';$1'));
  if (!m) return [];
  return m[1].split(';').map(p => p.trim()).filter(Boolean).flatMap(p => p.split(':')[0].replace(/^VAR\s+/i, '').split(',').map(x => x.trim()).filter(Boolean));
}

class KSignatureHelp implements vscode.SignatureHelpProvider {
  constructor(private s: FanucServices) {}
  provideSignatureHelp(doc: vscode.TextDocument, pos: vscode.Position): vscode.SignatureHelp | undefined {
    const before = stripCommentAndStrings(doc.lineAt(pos.line).text).slice(0, pos.character);
    // find innermost unclosed "("
    let depth = 0, open = -1;
    for (let i = before.length - 1; i >= 0; i--) {
      const c = before[i];
      if (c === ')') depth++;
      else if (c === '(') { if (depth === 0) { open = i; break; } depth--; }
    }
    if (open < 0) return undefined;
    const nameM = /([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(before.slice(0, open));
    if (!nameM) return undefined;
    const upper = nameM[1].toUpperCase();
    const argIndex = before.slice(open + 1).split(',').length - 1;
    const prog = this.s.karel.get(doc);
    const user = prog.routines.find(r => r.upper === upper);
    const help = new vscode.SignatureHelp();
    if (user) {
      const params = (user.params ?? []).map(p => new vscode.ParameterInformation(`${p.name} : ${p.type}`));
      const si = new vscode.SignatureInformation(routineSignature(user), user.doc);
      si.parameters = params;
      help.signatures = [si]; help.activeSignature = 0; help.activeParameter = Math.min(argIndex, Math.max(params.length - 1, 0));
      return help;
    }
    const b = KAREL_BUILTINS.get(upper);
    if (!b) return undefined;
    const m = /\(([^)]*)\)/.exec(b.sig.replace(/<;([^>]*)>/g, ';$1'));
    const params = (m ? m[1].split(';').map(p => p.trim()).filter(Boolean) : []).flatMap(p => {
      const [names, type] = p.split(':').map(x => x.trim());
      return names.replace(/^VAR\s+/i, '').split(',').map(n => `${n.trim()} : ${type ?? ''}`);
    });
    const si = new vscode.SignatureInformation(b.sig + (b.ret ? ` : ${b.ret}` : ''), b.doc);
    si.parameters = params.map(p => new vscode.ParameterInformation(p));
    help.signatures = [si]; help.activeSignature = 0; help.activeParameter = Math.min(argIndex, Math.max(params.length - 1, 0));
    return help;
  }
}

class KFolding implements vscode.FoldingRangeProvider {
  constructor(private s: FanucServices) {}
  provideFoldingRanges(doc: vscode.TextDocument): vscode.FoldingRange[] {
    const prog = this.s.karel.get(doc);
    const out: vscode.FoldingRange[] = [];
    for (const r of prog.routines) if (r.endLine !== undefined && r.endLine > r.line) out.push(new vscode.FoldingRange(r.line, r.endLine));
    for (const b of prog.blocks) if (b.close && b.close.line > b.open.line && b.kind !== 'ROUTINE') out.push(new vscode.FoldingRange(b.open.line, b.close.line));
    // leading comment banner
    let start = -1;
    for (let i = 0; i < doc.lineCount; i++) {
      const isC = /^\s*--/.test(doc.lineAt(i).text);
      if (isC && start < 0) start = i;
      if (!isC) { if (start >= 0 && i - start >= 3) out.push(new vscode.FoldingRange(start, i - 1, vscode.FoldingRangeKind.Comment)); start = -1; }
    }
    return out;
  }
}

/** Conservative KAREL indenter: re-indents lines by block depth, never touches line contents. */
class KFormatter implements vscode.DocumentFormattingEditProvider {
  provideDocumentFormattingEdits(doc: vscode.TextDocument, options: vscode.FormattingOptions): vscode.TextEdit[] {
    const unit = options.insertSpaces ? ' '.repeat(options.tabSize) : '\t';
    const edits: vscode.TextEdit[] = [];
    let depth = 0;
    let sectionIndent = false; // inside VAR/CONST/TYPE declarations
    let inRoutine = false;
    const OPEN = /^(IF|FOR|WHILE|REPEAT|SELECT|CONDITION|STRUCTURE|USING)$/;
    const CLOSE = /^(ENDIF|ENDFOR|ENDWHILE|UNTIL|ENDSELECT|ENDCONDITION|ENDSTRUCTURE|ENDUSING|ENDMOVE)$/;
    for (let i = 0; i < doc.lineCount; i++) {
      const raw = doc.lineAt(i).text;
      if (raw.trim() === '') continue;
      const clean = stripCommentAndStrings(raw).trim();
      const words = clean.match(/[A-Za-z_][A-Za-z0-9_]*/g)?.map(w => w.toUpperCase()) ?? [];
      const first = words[0] ?? '';
      const isComment = raw.trim().startsWith('--');
      let lineDepth = depth;
      // dedent for closers / ELSE / CASE / END / BEGIN
      if (!isComment) {
        if (CLOSE.test(first) || first === 'ELSE' || first === 'CASE') lineDepth = Math.max(0, depth - 1);
        if (first === 'END') { lineDepth = inRoutine ? 1 : 0; }
        if (first === 'BEGIN') { lineDepth = inRoutine ? 1 : 0; }
        if (/^(VAR|CONST|TYPE)$/.test(first) && words.length === 1) lineDepth = inRoutine ? 1 : 0;
        if (first === 'ROUTINE') lineDepth = 0;
        if (first === 'PROGRAM' || first.startsWith('%') || raw.trim().startsWith('%')) lineDepth = 0;
      }
      const target = unit.repeat(lineDepth) + raw.trimStart();
      if (target !== raw) edits.push(vscode.TextEdit.replace(doc.lineAt(i).range, target));
      if (isComment) continue;
      // update depth for following lines
      if (first === 'ROUTINE') { inRoutine = !/\bFROM\b/.test(clean); depth = inRoutine ? 1 : 0; sectionIndent = false; continue; }
      if (first === 'PROGRAM') { depth = 0; continue; }
      if (/^(VAR|CONST|TYPE)$/.test(first) && words.length === 1) { depth = (inRoutine ? 1 : 0) + 1; sectionIndent = true; continue; }
      if (first === 'BEGIN') { depth = (inRoutine ? 1 : 0) + 1; sectionIndent = false; continue; }
      if (first === 'END') { if (inRoutine) { inRoutine = false; depth = 0; } else depth = 0; continue; }
      void sectionIndent;
      let d = depth;
      // structure declarations inside TYPE
      for (let k = 0; k < words.length; k++) {
        const w = words[k], prev = words[k - 1] ?? '';
        if (OPEN.test(w)) {
          if (w === 'FOR' && (prev === 'WAIT' || words.slice(0, k).includes('PULSE'))) continue;
          if (w === 'CONDITION' && /^(ENABLE|DISABLE|PURGE)$/.test(prev)) continue;
          d++;
        } else if (CLOSE.test(w)) {
          if (w === 'UNTIL' && /\bMOVE\b/.test(clean) && !words.includes('REPEAT')) continue;
          d = Math.max(0, d - 1);
        } else if (w === 'MOVE' && /,\s*$/.test(clean)) d++;
      }
      // ELSE / CASE keep the depth of their block body
      depth = d;
    }
    return edits;
  }
}

// ---------------------------------------------------------------------------
function registerKarelDiagnostics(ctx: vscode.ExtensionContext, s: FanucServices) {
  const coll = vscode.languages.createDiagnosticCollection('fanuc-karel');
  ctx.subscriptions.push(coll);
  const timers = new Map<string, ReturnType<typeof debounce>>();
  // The robot.ini given to ktrans names the core version and the support folder; both are
  // read once and again after a robotCode.karel setting changes, not on every keystroke.
  let iniCache: { text: string | undefined } | undefined;
  const robotIni = () => {
    if (!iniCache) {
      const ini = config<string>('karel.ktransConfig', '').trim();
      let text: string | undefined;
      if (ini) try { text = fs.readFileSync(ini, 'latin1'); } catch { /* unreadable: treated as unset */ }
      iniCache = { text };
    }
    return iniCache.text;
  };
  let supportCache: string[] | undefined;
  const supportDirs = () => (supportCache ??= karelSupportDirs(findKtrans(), robotIni()));
  const nameLimits = (doc: vscode.TextDocument): KarelNameLimits => {
    const max = config<number | null>('karel.maxIdentifierLength', null, doc);
    if (typeof max === 'number') return { identifier: max, program: max, version: '(robotCode.karel.maxIdentifierLength)' };
    const set = config<string>('karel.coreVersion', 'auto', doc);
    const v: KarelCoreVersion = set === 'V6' || set === 'V7-V8' || set === 'V9' ? set : (karelCoreVersionOf(robotIni() ?? '') ?? 'V9');
    return karelNameLimits(v);
  };
  const run = (doc: vscode.TextDocument) => {
    if (doc.languageId !== 'fanuc-karel') return;
    const prog = s.karel.get(doc);
    const out: vscode.Diagnostic[] = [];
    const sevMap = { error: vscode.DiagnosticSeverity.Error, warning: vscode.DiagnosticSeverity.Warning, info: vscode.DiagnosticSeverity.Information, hint: vscode.DiagnosticSeverity.Hint };
    const identLen = config<boolean>('karel.diagnostics.identifierLength', true, doc);
    for (const d of [...prog.diagnostics, ...(identLen ? identifierLengthIssues(prog, nameLimits(doc)) : [])]) {
      const diag = new vscode.Diagnostic(spanToRange(d.span), d.message, sevMap[d.severity]);
      diag.code = d.code; diag.source = 'KAREL';
      out.push(diag);
    }
    if (config<boolean>('karel.diagnostics.unusedVariables', true, doc) && prog.name) {
      for (const u of findUnused(prog)) {
        if (u.span.len === 0) continue;
        const diag = new vscode.Diagnostic(spanToRange(u.span), `${u.kind} "${u.name}" is never used.`, vscode.DiagnosticSeverity.Hint);
        diag.tags = [vscode.DiagnosticTag.Unnecessary]; diag.code = 'karel.unused'; diag.source = 'KAREL';
        out.push(diag);
      }
    }
    // Used but never declared. ktrans does NOT report this (checked against KTRANS
    // V9.40-1), so a mistyped name translates clean and goes wrong on the robot — which
    // makes it one of the few checks here that beats the official compiler rather than
    // repeating it. findUndeclared declines to answer for anything it cannot see all of.
    if (config<boolean>('karel.diagnostics.undeclared', true, doc)) {
      const included = prog.includes.length && !doc.isUntitled ? includedNames(prog, path.dirname(doc.uri.fsPath), supportDirs()) : undefined;
      for (const u of findUndeclared(prog, up => KAREL_BUILTINS.has(up) || KAREL_PREDEFINED.has(up), included)) {
        const diag = new vscode.Diagnostic(spanToRange(u.span), `"${prog.lines[u.line]?.slice(u.span.col, u.span.col + u.span.len) ?? u.upper}" is used but never declared. ktrans does not report this — it translates and then misbehaves on the robot.`, vscode.DiagnosticSeverity.Warning);
        diag.code = 'karel.undeclared'; diag.source = 'KAREL';
        out.push(diag);
      }
    }

    // The lint: what ktrans refuses and what it lets through (lint.ts). One rule can be
    // switched off by its code in robotCode.karel.diagnostics.lintIgnore.
    if (config<boolean>('karel.diagnostics.lint', true, doc)) {
      const ignore = new Set(config<string[]>('karel.diagnostics.lintIgnore', [], doc).map(x => x.trim()));
      for (const d of lintKarel(prog)) {
        if (ignore.has(d.code) || ignore.has(d.code.replace(/^karel\.lint\./, ''))) continue;
        const diag = new vscode.Diagnostic(spanToRange(d.span), d.message, sevMap[d.severity]);
        diag.code = d.code; diag.source = 'KAREL';
        out.push(diag);
      }
    }

    if (prog.name && prog.nameSpan && !doc.isUntitled) {
      const file = path.basename(doc.uri.fsPath).replace(/\.[^.]+$/, '');
      if (file.toUpperCase() !== prog.name.toUpperCase()) {
        const diag = new vscode.Diagnostic(spanToRange(prog.nameSpan), `Program name "${prog.name}" differs from file name "${file}"; the controller loads ${prog.name}.pc and expects the file to match.`, vscode.DiagnosticSeverity.Warning);
        diag.code = 'karel.fileName'; diag.source = 'KAREL';
        out.push(diag);
      }
    }
    coll.set(doc.uri, out);
  };
  const schedule = (doc: vscode.TextDocument) => {
    if (doc.languageId !== 'fanuc-karel') return;
    const key = doc.uri.toString();
    let t = timers.get(key); if (!t) { t = debounce(() => run(doc), 300); timers.set(key, t); }
    t();
  };
  ctx.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(run),
    vscode.workspace.onDidChangeTextDocument(e => schedule(e.document)),
    vscode.workspace.onDidCloseTextDocument(d => { coll.delete(d.uri); ktransDiagnostics.delete(d.uri); }),
    vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('robotCode.karel')) { iniCache = undefined; supportCache = undefined; for (const d of vscode.workspace.textDocuments) run(d); } }),
    vscode.workspace.onDidSaveTextDocument(d => { if (d.languageId === 'fanuc-karel' && config<boolean>('karel.compileOnSave', false, d)) void compileKarel(d, s); }),
  );
  for (const d of vscode.workspace.textDocuments) run(d);

  /**
   * Pre-compile check (beta list 2, item 10): the lint and the parser's own findings, run
   * now, plus the one check that needs the file system - every %INCLUDE must exist - and a
   * plain verdict. Clean, and it offers ktrans; not clean, it opens Problems on the file.
   */
  ctx.subscriptions.push(vscode.commands.registerCommand('robotCode.karel.precheck', async () => {
    const ed = vscode.window.activeTextEditor;
    if (!ed || ed.document.languageId !== 'fanuc-karel') { vscode.window.showInformationMessage('Open a KAREL (.kl) file first.'); return; }
    const doc = ed.document;
    run(doc);
    const found = [...(coll.get(doc.uri) ?? [])];
    const prog = s.karel.get(doc);
    for (const inc of prog.includes) {
      const name = inc.replace(/\.kl$/i, '');
      const hits = await vscode.workspace.findFiles(`**/${name}.{kl,KL,Kl,kL}`, undefined, 1);
      let local = false;
      try { await vscode.workspace.fs.stat(vscode.Uri.file(path.join(path.dirname(doc.uri.fsPath), `${name}.kl`))); local = true; } catch { /* not beside the file */ }
      if (!hits.length && !local) {
        const line = prog.directives.find(d => /^INCLUDE$/i.test(d.name) && d.args.split(/\s+/)[0] === inc)?.line ?? 0;
        const diag = new vscode.Diagnostic(doc.lineAt(line).range, `%INCLUDE ${inc}: no ${name}.kl in the workspace or beside this file; ktrans needs it on its include path.`, vscode.DiagnosticSeverity.Error);
        diag.code = 'karel.includeMissing'; diag.source = 'KAREL';
        found.push(diag);
      }
    }
    coll.set(doc.uri, found);
    const errors = found.filter(d => d.severity === vscode.DiagnosticSeverity.Error).length;
    const warnings = found.filter(d => d.severity === vscode.DiagnosticSeverity.Warning).length;
    const name = prog.name ?? path.basename(doc.uri.fsPath);
    if (!errors && !warnings) {
      const pick = await vscode.window.showInformationMessage(`${name}: nothing to fix before compiling${found.length ? ` (${found.length} hint${found.length === 1 ? '' : 's'} in Problems)` : ''}.`, 'Compile with ktrans');
      if (pick) await vscode.commands.executeCommand('robotCode.karel.compile');
      return;
    }
    const first = found.filter(d => d.severity <= vscode.DiagnosticSeverity.Warning).sort((a, b) => a.severity - b.severity || a.range.start.line - b.range.start.line)[0];
    const pick = await vscode.window.showWarningMessage(`${name}: ${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'} before compiling. First: line ${first.range.start.line + 1}, ${first.message}`, 'Show Problems', errors ? 'Compile anyway' : 'Compile with ktrans');
    if (pick === 'Show Problems') { await vscode.commands.executeCommand('workbench.actions.view.problems'); ed.revealRange(first.range, vscode.TextEditorRevealType.InCenter); ed.selection = new vscode.Selection(first.range.start, first.range.start); }
    else if (pick) await vscode.commands.executeCommand('robotCode.karel.compile');
  }));
}

function registerKarelCommands(ctx: vscode.ExtensionContext, s: FanucServices) {
  ctx.subscriptions.push(
    vscode.commands.registerCommand('robotCode.karel.compile', async () => {
      const ed = vscode.window.activeTextEditor;
      if (!ed || ed.document.languageId !== 'fanuc-karel') { vscode.window.showInformationMessage('Open a KAREL (.kl) file first.'); return; }
      if (ed.document.isDirty) await ed.document.save();
      await compileKarel(ed.document, s);
    }),
    vscode.commands.registerCommand('robotCode.karel.newProgram', async () => {
      const name = await vscode.window.showInputBox({ prompt: 'KAREL program name (max 12 characters)', placeHolder: 'my_prog', validateInput: v => /^[A-Za-z_][A-Za-z0-9_]{0,11}$/.test(v) ? undefined : 'Letters, digits, underscore; max 12; start with a letter' });
      if (!name) return;
      const comment = await vscode.window.showInputBox({ prompt: '%COMMENT (16 characters)', value: '' });
      if (comment === undefined) return;
      const content = [
        `PROGRAM ${name}`, '%NOLOCKGROUP', '%NOPAUSE = ERROR + COMMAND + TPENABLE', `%COMMENT = '${comment.slice(0, 16)}'`, '',
        'VAR', '  status : INTEGER', '', 'BEGIN', '  status = 0', `END ${name}`, '',
      ].join('\n');
      const folder = vscode.window.activeTextEditor && !vscode.window.activeTextEditor.document.isUntitled ? path.dirname(vscode.window.activeTextEditor.document.uri.fsPath) : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(folder ?? '', `${name}.kl`)), filters: { 'KAREL source': ['kl'] }, title: 'Create KAREL program' });
      if (!target) return;
      await vscode.workspace.fs.writeFile(target, Buffer.from(content, 'utf8'));
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(target));
    }),
  );
}
