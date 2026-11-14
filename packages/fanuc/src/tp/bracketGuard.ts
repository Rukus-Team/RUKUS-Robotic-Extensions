/**
 * A closing bracket with nothing to close.
 *
 * Picking a register from the list writes its `]` (`R[35:index]`), and the hand types the `]`
 * it was about to type anyway: `R[35:index]]`. In an indirect register - `R[R[35]]` - it is
 * easy to lose count of which `]` the editor already put there. A TP instruction never has a
 * closer without its opener, so one typed into a line that was balanced is not placed: the
 * caret steps over a closer that is already there, or stays where it is.
 */
import * as vscode from 'vscode';
import { config } from '@core/util';
import type { FanucServices } from '../services';

import { CLOSER_OF as PAIRS, surplusCloser } from './brackets';

export function registerBracketGuard(s: FanucServices): vscode.Disposable {
  let busy = false;
  return vscode.workspace.onDidChangeTextDocument(e => {
    if (busy || e.document.languageId !== 'fanuc-tp' || e.document.uri.scheme === 'robotcode-clean' || e.contentChanges.length !== 1) return;
    if (e.reason === vscode.TextDocumentChangeReason.Undo || e.reason === vscode.TextDocumentChangeReason.Redo) return;
    const ch = e.contentChanges[0];
    if (!ch.range.isEmpty || !PAIRS[ch.text]) return;
    const doc = e.document;
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document !== doc || editor.selections.length !== 1) return;
    if (!config<boolean>('tp.guardBrackets', true, doc)) return;
    const line = ch.range.start.line, col = ch.range.start.character;
    // only in the program's instructions: a comment or remark may hold any text
    const prog = s.tp.get(doc);
    const mn = prog.sections.mn;
    if (mn === undefined || line <= mn || (prog.sections.pos !== undefined && line >= prog.sections.pos)) return;
    const parsed = prog.lines.find(l => l.line === line);
    if (parsed && (parsed.kind === 'comment' || parsed.kind === 'remark')) return;
    const text = doc.lineAt(line).text;
    if (/^\s*\d*:?\s*(!|\/\/|--[a-z]{2}\b)/i.test(text) || text[col] !== ch.text) return;
    // A long instruction is wrapped onto `:` lines, and its brackets close on a later line than
    // they open: the count is over the whole instruction, not the line the key was pressed in.
    const kindAt = (n: number) => prog.lines.find(l => l.line === n)?.kind;
    let from = line, to = line;
    while (from > mn + 1 && kindAt(from) === 'continuation') from--;
    while (to + 1 < doc.lineCount && kindAt(to + 1) === 'continuation') to++;
    let whole = '';
    for (let n = from; n <= to; n++) whole += doc.lineAt(n).text + '\n';
    // ...and an instruction still being typed across lines (no ` ;` on the line above yet) is left alone
    if (from === line && line > mn + 1 && /^\s*:/.test(text) && !/;\s*$/.test(doc.lineAt(line - 1).text)) return;
    if (!surplusCloser(whole, ch.text)) return;
    busy = true;
    const stepOver = text[col + 1] === ch.text;
    void editor.edit(b => b.delete(new vscode.Range(line, col, line, col + 1)), { undoStopBefore: false, undoStopAfter: false }).then(() => {
      busy = false;
      // the closer that was already there is the one the keystroke meant
      const at = new vscode.Position(line, stepOver ? col + 1 : col);
      editor.selection = new vscode.Selection(at, at);
      vscode.window.setStatusBarMessage(`"${ch.text}" not added - every ${PAIRS[ch.text]} on this line is already closed`, 2500);
    }, () => { busy = false; });
  });
}
