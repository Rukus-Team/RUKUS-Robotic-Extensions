/**
 * "Compare Positions With…": the active TP program against another copy of itself - any
 * other indexed program of the same name (another backup, the robot's opened copy), or a
 * file picked from disk. Renders a Markdown report in an untitled document and opens the
 * preview, so it can be read, saved or pasted into a ticket.
 */
import * as vscode from 'vscode';
import * as path from 'node:path';
import type { FanucServices } from '../services';
import { parseTp } from '../tp/parser';
import { diffPositions, positionDiffMarkdown } from './positionDiff';
import { programNameFromUri } from '@core/util';

export async function comparePositions(s: FanucServices): Promise<void> {
  const ed = vscode.window.activeTextEditor;
  if (!ed || ed.document.languageId !== 'fanuc-tp') { vscode.window.showInformationMessage('Open a TP program first.'); return; }
  const doc = ed.document;
  const progA = s.tp.get(doc);
  const name = progA.header.name ?? programNameFromUri(doc.uri);
  if (!progA.positions.length) { vscode.window.showInformationMessage(`${name} has no taught positions.`); return; }

  type Pick = vscode.QuickPickItem & { uri?: vscode.Uri; browse?: boolean };
  const others = s.index.all(name).filter(p => p.uri.toString() !== doc.uri.toString());
  const items: Pick[] = others.map(p => {
    const ds = s.data.dataset(p.uri);
    const where = p.uri.scheme === 'file' ? (ds?.label ?? path.basename(path.dirname(p.uri.fsPath))) : `${decodeURIComponent(p.uri.authority)} (robot)`;
    return { label: `$(archive) ${where}`, description: p.kind === 'binary' ? 'compiled only - no positions' : `${p.positions} positions`, detail: `${p.uri.scheme === 'file' ? p.uri.fsPath : p.uri.toString()} · ${new Date(p.mtime).toLocaleString()}`, uri: p.uri };
  }).filter(i => !/compiled only/.test(i.description ?? ''));
  items.push({ label: '$(folder-opened) Choose a file…', description: 'any .ls on disk', browse: true });
  const pick = await vscode.window.showQuickPick(items, { placeHolder: `Compare the positions of ${name} with which copy?`, matchOnDescription: true, matchOnDetail: true });
  if (!pick) return;

  let otherUri = pick.uri;
  if (pick.browse) {
    const chosen = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { 'TP program': ['ls', 'LS'] }, openLabel: 'Compare' });
    otherUri = chosen?.[0];
  }
  if (!otherUri) return;

  const otherDoc = await vscode.workspace.openTextDocument(otherUri);
  const progB = otherDoc.languageId === 'fanuc-tp' ? s.tp.get(otherDoc) : parseTp(otherDoc.getText());
  const labelA = doc.uri.scheme === 'file' ? vscode.workspace.asRelativePath(doc.uri) : doc.uri.toString();
  const labelB = otherUri.scheme === 'file' ? vscode.workspace.asRelativePath(otherUri) : otherUri.toString();
  const rows = diffPositions(progA, progB);
  const report = await vscode.workspace.openTextDocument({ language: 'markdown', content: positionDiffMarkdown(rows, labelA, labelB) });
  await vscode.window.showTextDocument(report, { preview: false, viewColumn: vscode.ViewColumn.Beside });
  await vscode.commands.executeCommand('markdown.showPreview', report.uri);
  const moved = rows.filter(r => r.moved).length;
  vscode.window.setStatusBarMessage(`Positions: ${moved} of ${rows.length} moved between ${labelA} and ${labelB}`, 6000);
}
