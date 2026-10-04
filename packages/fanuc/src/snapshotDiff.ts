/**
 * Structured diffs between a working copy and its snapshot copy: positions for a TP program
 * (`tools/positionDiff.ts`), numeric registers for a `numreg.va`. Both open a Markdown report
 * beside the editor, the same shape "Compare Positions With…" already uses.
 *
 * These are the questions a raw text diff answers badly: "which taught point moved", "which
 * register comment drifted". The snapshot is the base (A), the working copy is what changed (B).
 */
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import type { FanucServices } from './services';
import { parseTp, type TpProgram } from './tp/parser';
import { diffPositions, positionDiffMarkdown } from './tools/positionDiff';
import { parseNumReg } from './data/vaParser';
import { snapshotCopy, targetFromUri } from '@core/snapshotSync';

export function registerSnapshotDiffCommands(ctx: vscode.ExtensionContext, s: FanucServices): void {
  const reg = (id: string, fn: (...a: any[]) => any) => ctx.subscriptions.push(vscode.commands.registerCommand(id, fn));
  reg('robotCode.sync.comparePositions', (arg?: unknown) => comparePositions(s, arg));
  reg('robotCode.sync.compareRegisters', (arg?: unknown) => compareRegisters(s, arg));
}

function uriOf(arg?: unknown): vscode.Uri | undefined {
  if (arg instanceof vscode.Uri) return arg;
  if (Array.isArray(arg)) {
    const u = arg.find((x): x is vscode.Uri => x instanceof vscode.Uri);
    if (u) return u;
  }
  return vscode.window.activeTextEditor?.document.uri;
}

/** The parsed TP program of a file: the cached parse when it is open, else a fresh read. */
function programOf(s: FanucServices, uri: vscode.Uri): TpProgram | undefined {
  const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
  if (doc && doc.languageId === 'fanuc-tp') return s.tp.get(doc);
  try { return parseTp(fs.readFileSync(uri.fsPath, 'latin1')); } catch { return undefined; }
}

async function openMarkdown(content: string): Promise<void> {
  const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content });
  await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.Beside });
  await vscode.commands.executeCommand('markdown.showPreview', doc.uri);
}

async function comparePositions(s: FanucServices, arg?: unknown): Promise<void> {
  const uri = uriOf(arg);
  if (!uri || uri.scheme !== 'file' || !/\.ls$/i.test(uri.fsPath)) {
    vscode.window.showInformationMessage('Open a TP (.ls) program for a position diff.');
    return;
  }
  const target = targetFromUri(s, uri);
  if (!target) { vscode.window.showInformationMessage('That file is not in a robot container.'); return; }
  const snapText = snapshotCopy(s, target.marker, target.fileName);
  if (snapText === undefined) { vscode.window.showInformationMessage(`The snapshot has no copy of ${target.fileName}.`); return; }
  const snap = parseTp(snapText);
  const working = programOf(s, uri);
  if (!working) { vscode.window.showInformationMessage(`Could not read ${target.fileName} as a TP program.`); return; }
  const date = s.containers.snapshotInfo(target.marker.root)?.date.slice(0, 10);
  const rows = diffPositions(snap, working);
  const report = positionDiffMarkdown(rows, `snapshot${date ? ` ${date}` : ''}`, `working (${vscode.workspace.asRelativePath(uri, false)})`);
  await openMarkdown(report);
  const moved = rows.filter(r => r.moved).length;
  vscode.window.setStatusBarMessage(`Positions: ${moved} of ${rows.length} moved against the snapshot`, 6000);
}

async function compareRegisters(s: FanucServices, arg?: unknown): Promise<void> {
  const uri = uriOf(arg);
  if (!uri || uri.scheme !== 'file') { vscode.window.showInformationMessage('Open a numeric-register file (numreg.va) first.'); return; }
  const target = targetFromUri(s, uri);
  if (!target) { vscode.window.showInformationMessage('That file is not in a robot container.'); return; }
  const snapText = snapshotCopy(s, target.marker, target.fileName);
  if (snapText === undefined) { vscode.window.showInformationMessage(`The snapshot has no copy of ${target.fileName}.`); return; }
  let workingText = '';
  try { workingText = fs.readFileSync(uri.fsPath, 'latin1'); } catch { /* unreadable: compares as empty */ }
  const a = new Map(parseNumReg(snapText).map(r => [r.index, r]));
  const b = new Map(parseNumReg(workingText).map(r => [r.index, r]));
  if (!a.size && !b.size) { vscode.window.showInformationMessage(`${target.fileName} does not read as numeric registers.`); return; }
  const date = s.containers.snapshotInfo(target.marker.root)?.date.slice(0, 10);
  const lines: string[] = [];
  let changed = 0, added = 0, removed = 0;
  const show = (r: { index: number; value: number | string; comment: string }): string => `R[${r.index}] \`${r.comment || '—'}\` = ${r.value}`;
  for (const i of [...new Set([...a.keys(), ...b.keys()])].sort((x, y) => x - y)) {
    const ra = a.get(i), rb = b.get(i);
    if (ra && !rb) { removed++; lines.push(`- **removed** ${show(ra)}`); continue; }
    if (!ra && rb) { added++; lines.push(`- **added** ${show(rb)}`); continue; }
    if (!ra || !rb) continue;
    const value = String(ra.value) !== String(rb.value);
    const comment = ra.comment !== rb.comment;
    if (!value && !comment) continue;
    changed++;
    lines.push(`- R[${i}]: ${comment ? `comment \`${ra.comment || '—'}\` → **\`${rb.comment || '—'}\`**` : `comment \`${rb.comment || '—'}\``} · ${value ? `${ra.value} → **${rb.value}**` : `= ${rb.value}`}`);
  }
  if (!lines.length) { vscode.window.showInformationMessage(`Registers in ${target.fileName} are identical to the snapshot${date ? ` (${date})` : ''}.`); return; }
  const report =
    `# Registers: snapshot${date ? ` ${date}` : ''} → working\n\n` +
    `- snapshot: \`${target.fileName}\`\n- working: \`${vscode.workspace.asRelativePath(uri, false)}\`\n\n` +
    `**${changed} changed · ${added} added · ${removed} removed**\n\n${lines.join('\n')}\n`;
  await openMarkdown(report);
  vscode.window.setStatusBarMessage(`Registers: ${changed} changed, ${added} added, ${removed} removed against the snapshot`, 6000);
}
