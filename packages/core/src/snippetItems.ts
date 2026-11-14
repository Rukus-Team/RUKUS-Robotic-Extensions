/** Completion items for the snippets and block tails of ./snippets - the vscode side of it */
import * as vscode from 'vscode';
import type { Snippet, BlockContinuation } from './snippets';

/** a snippet body as the text it writes: placeholders as their defaults, choices as the first one */
function plain(body: string): string {
  // variables (`${TM_FILENAME_BASE/(.*)/${1:/upcase}/}`, `${CURRENT_YEAR}`) by their name
  let out = body.replace(/\$\{([A-Z_]+)(?:\/(?:[^{}]|\{[^{}]*\})*)?\}/g, '$1'), prev = '';
  while (out !== prev) {
    prev = out;
    out = out.replace(/\$\{\d+\|([^,|}]*)[^}]*\|\}/g, '$1').replace(/\$\{\d+:([^${}]*)\}/g, '$1').replace(/\$\{\d+\}|\$\d+/g, '');
  }
  return out.replace(/\\\$/g, '$');
}

/** The whole-statement snippets, for a caret at the start of a statement. `range` where a prefix is not a plain word (TP's `!`). */
export function snippetCompletions(snippets: readonly Snippet[], languageId: string, sort: string, range?: vscode.Range): vscode.CompletionItem[] {
  return snippets.map(s => {
    const it = new vscode.CompletionItem({ label: s.prefixes[0], description: s.name }, vscode.CompletionItemKind.Snippet);
    it.insertText = new vscode.SnippetString(s.body);
    it.filterText = s.prefixes.join(' ');
    it.detail = s.description ?? s.name;
    it.documentation = new vscode.MarkdownString().appendCodeblock(plain(s.body), languageId);
    it.sortText = `${sort}${s.prefixes[0]}`;
    if (range) it.range = range;
    return it;
  });
}

/**
 * The rest of the block statement the caret is in: `THEN ... ENDIF` first, and (with `keyword`)
 * the keyword on its own, for a list that does not already offer it.
 */
export function continuationCompletions(c: BlockContinuation, pos: vscode.Position, languageId: string, keyword: boolean): vscode.CompletionItem[] {
  const range = new vscode.Range(pos.line, pos.character - c.word.length, pos.line, pos.character + c.tail);
  const items = c.tails.map((t, i) => {
    const it = new vscode.CompletionItem({ label: t.label, description: `finish the ${t.head} block` }, vscode.CompletionItemKind.Snippet);
    it.insertText = new vscode.SnippetString(t.insert);
    it.filterText = t.pivot;
    it.detail = `The rest of the ${t.head} block`;
    it.documentation = new vscode.MarkdownString().appendCodeblock(plain(t.insert), languageId);
    it.sortText = ` ${i}`;
    it.range = range;
    if (i === 0) it.preselect = true;
    return it;
  });
  if (keyword) {
    const word = /^[A-Za-z]+/.exec(c.keyword)![0];
    const it = new vscode.CompletionItem(word, vscode.CompletionItemKind.Keyword);
    it.insertText = c.keyword; it.filterText = word; it.sortText = ' 9'; it.range = range;
    items.push(it);
  }
  return items;
}
