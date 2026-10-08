import * as vscode from 'vscode';
import { type TpProgram } from './parser';
import { FanucServices } from '../services';
import { config, debounce } from '@core/util';
import { resolveProgram, robotOf } from '@core/resolve';
import { autoRenumberMode } from './renumberSettings';
import { formatPositions } from './teach';
import { extendedCommentWidth } from './renumberSettings';
import { tpChecks, CODES, type TpCheckEnv } from './checks';
import { lintDiagnostics, lintSettingsFor, onDidChangeLintConfig } from '@core/lint/vscodeLint';

export { CODES };

export function registerTpDiagnostics(ctx: vscode.ExtensionContext, s: FanucServices) {
  const coll = vscode.languages.createDiagnosticCollection('fanuc-tp');
  ctx.subscriptions.push(coll);
  const timers = new Map<string, ReturnType<typeof debounce>>();

  const run = (doc: vscode.TextDocument) => {
    if (doc.languageId !== 'fanuc-tp') return;
    coll.set(doc.uri, computeTpDiagnostics(doc, s));
  };
  const schedule = (doc: vscode.TextDocument) => {
    if (doc.languageId !== 'fanuc-tp') return;
    const key = doc.uri.toString();
    let t = timers.get(key);
    if (!t) { t = debounce(() => run(doc), 350); timers.set(key, t); }
    t();
  };
  const runAllOpen = () => { for (const d of vscode.workspace.textDocuments) run(d); };

  ctx.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(run),
    vscode.workspace.onDidChangeTextDocument(e => schedule(e.document)),
    vscode.workspace.onDidCloseTextDocument(d => { coll.delete(d.uri); timers.delete(d.uri.toString()); }),
    vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('robotCode.tp')) runAllOpen(); }),
    onDidChangeLintConfig(runAllOpen),
    s.index.onDidChange(runAllOpen),
    s.data.onDidChange(runAllOpen),
    vscode.languages.registerCodeActionsProvider({ language: 'fanuc-tp' }, new TpCodeActions(), { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }),
  );
  runAllOpen();
}

/**
 * The checks themselves are in checks.ts (shared with Lint Folder and robot-lint); this
 * hands them what only the editor knows - settings, the robot's other programs, its .va
 * data, the controller's device listing - and the .robotlint.json has the last word.
 */
export function computeTpDiagnostics(doc: vscode.TextDocument, s: FanucServices): vscode.Diagnostic[] {
  const text = doc.getText();
  if (!/^\/PROG\b/m.test(text) && !/^\/MN\b/m.test(text)) return []; // not a program (alarm log etc.)
  const prog: TpProgram = s.tp.get(doc);
  const robot = robotOf(doc.uri);
  const listingKnown = !robot || !!s.live?.hasListing(robot);
  const env: TpCheckEnv = {
    settings: lintSettingsFor(doc.uri),
    setting: (key, fallback) => config(key, fallback, doc),
    autoRenumber: autoRenumberMode(doc) !== 'off',
    extCommentWidth: extendedCommentWidth(doc),
    xref: s.index.programCount > 1 ? { findings: s.index.findings(doc.uri), self: s.index.forUri(doc.uri)?.name } : undefined,
    calls: (s.index.programCount > 0 || robot) && listingKnown ? {
      robot,
      resolve: name => {
        if (!resolveProgram(s, name, doc.uri)) return 'missing';
        const here = robot ? [] : s.index.list(doc.uri);
        return here.length && !here.some(p => p.name === name.toUpperCase()) ? 'elsewhere' : 'found';
      },
    } : undefined,
    dataset: s.data.dataset(doc.uri),
  };
  const out = lintDiagnostics(tpChecks(text, prog, env), doc.uri, 'FANUC TP');
  for (const d of out) {
    const fix = ((d as any).lintData as { fixComment?: string } | undefined)?.fixComment;
    if (fix) (d as any).fixComment = fix;
  }
  return out;
}

class TpCodeActions implements vscode.CodeActionProvider {
  provideCodeActions(doc: vscode.TextDocument, _range: vscode.Range, ctx: vscode.CodeActionContext): vscode.CodeAction[] {
    const out: vscode.CodeAction[] = [];
    for (const d of ctx.diagnostics) {
      if (d.code === CODES.commentMismatch && (d as any).fixComment) {
        const a = new vscode.CodeAction(`Use controller comment "${(d as any).fixComment}"`, vscode.CodeActionKind.QuickFix);
        a.edit = new vscode.WorkspaceEdit(); a.edit.replace(doc.uri, d.range, (d as any).fixComment); a.diagnostics = [d]; a.isPreferred = true;
        out.push(a);
      }
      if (d.code === CODES.lineSeq || d.code === CODES.lineCount || d.code === CODES.terminator) {
        const a = new vscode.CodeAction('Renumber lines', vscode.CodeActionKind.QuickFix);
        a.command = { command: 'robotCode.tp.renumber', title: 'Renumber lines' }; a.diagnostics = [d]; a.isPreferred = true;
        out.push(a);
      }
      if (d.code === CODES.doubleTerminator) {
        const a = new vscode.CodeAction('Keep one " ;"', vscode.CodeActionKind.QuickFix);
        a.edit = new vscode.WorkspaceEdit(); a.edit.replace(doc.uri, d.range, ';'); a.diagnostics = [d]; a.isPreferred = true;
        out.push(a);
      }
      if (d.code === CODES.integerAxis) {
        const a = new vscode.CodeAction("Write position values the controller's way", vscode.CodeActionKind.QuickFix);
        a.edit = new vscode.WorkspaceEdit();
        for (const e of formatPositions(doc.getText())) a.edit.replace(doc.uri, doc.lineAt(e.line).range, e.newText);
        a.diagnostics = [d]; a.isPreferred = true;
        out.push(a);
      }
      if (d.code === CODES.unusedLabel) {
        const a = new vscode.CodeAction('Remove unused label', vscode.CodeActionKind.QuickFix);
        a.edit = new vscode.WorkspaceEdit(); a.edit.delete(doc.uri, doc.lineAt(d.range.start.line).rangeIncludingLineBreak); a.diagnostics = [d];
        out.push(a);
      }
      if (d.code === CODES.unusedPos) {
        const a = new vscode.CodeAction('Remove unused position data', vscode.CodeActionKind.QuickFix);
        // delete from P[n]{ to the closing }; line
        let end = d.range.start.line;
        while (end < doc.lineCount - 1 && !/^\s*\}\s*;/.test(doc.lineAt(end).text)) end++;
        a.edit = new vscode.WorkspaceEdit(); a.edit.delete(doc.uri, new vscode.Range(d.range.start.line, 0, end + 1, 0)); a.diagnostics = [d];
        out.push(a);
      }
    }
    return out;
  }
}
