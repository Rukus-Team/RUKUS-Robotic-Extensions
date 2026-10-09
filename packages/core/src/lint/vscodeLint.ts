/**
 * The linter in VS Code: the .robotlint.json that applies to a document (cached, re-read
 * when one changes), findings as Diagnostics, and "Robot Code: Lint Folder", which lints
 * every program under a folder or backup into the Problems panel and an Output summary.
 * Brand-free: the languages come from the lint registry (engine.ts).
 */
import * as vscode from 'vscode';
import * as path from 'node:path';
import { spanToRange } from '../util';
import { applyLintConfig, findLintConfig, settingsFor, EMPTY_CONFIG, LINT_CONFIG_FILE, LINT_STARTER_CONFIG, type LintConfig } from './config';
import { lintPaths, lintTotals } from './engine';
import { formatLintText } from './format';
import type { LintFinding, LintSettings } from './types';

const cache = new Map<string, LintConfig>();
const changed = new vscode.EventEmitter<void>();
/** fires when a .robotlint.json is created, changed or deleted: re-lint what is open */
export const onDidChangeLintConfig = changed.event;

export function lintConfigFor(uri: vscode.Uri): LintConfig {
  if (uri.scheme !== 'file') return EMPTY_CONFIG;
  return findLintConfig(path.dirname(uri.fsPath), cache);
}

export function lintSettingsFor(uri: vscode.Uri): LintSettings {
  return settingsFor(lintConfigFor(uri));
}

const SEVERITY: Record<LintFinding['severity'], vscode.DiagnosticSeverity> = {
  error: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  info: vscode.DiagnosticSeverity.Information,
  hint: vscode.DiagnosticSeverity.Hint,
};

export function findingToDiagnostic(f: LintFinding, uri: vscode.Uri, source: string): vscode.Diagnostic {
  const d = new vscode.Diagnostic(spanToRange(f.span), f.message, SEVERITY[f.severity]);
  d.code = f.code; d.source = source;
  if (f.unnecessary) d.tags = [vscode.DiagnosticTag.Unnecessary];
  if (f.related?.length) d.relatedInformation = f.related.map(r => new vscode.DiagnosticRelatedInformation(new vscode.Location(uri, spanToRange(r.span)), r.message));
  if (f.data !== undefined) (d as any).lintData = f.data;
  return d;
}

/** a brand's findings for an open document: the config applied, as Diagnostics */
export function lintDiagnostics(findings: LintFinding[], uri: vscode.Uri, source: string): vscode.Diagnostic[] {
  return applyLintConfig(findings, lintConfigFor(uri)).map(f => findingToDiagnostic(f, uri, source));
}

const SOURCE: Record<string, string> = { 'fanuc-tp': 'FANUC TP', 'fanuc-karel': 'KAREL', 'abb-rapid': 'ABB RAPID' };

export function registerLint(ctx: vscode.ExtensionContext): void {
  const folderColl = vscode.languages.createDiagnosticCollection('robot-lint');
  const out = vscode.window.createOutputChannel('RUKUS Lint');
  const watcher = vscode.workspace.createFileSystemWatcher(`**/${LINT_CONFIG_FILE}`);
  const reset = () => { cache.clear(); changed.fire(); };
  ctx.subscriptions.push(folderColl, out, watcher, changed,
    watcher.onDidChange(reset), watcher.onDidCreate(reset), watcher.onDidDelete(reset),
    // a file opened in an editor gets live diagnostics from its language: drop the folder-run copy
    vscode.workspace.onDidOpenTextDocument(d => folderColl.delete(d.uri)),
  );

  ctx.subscriptions.push(vscode.commands.registerCommand('robotCode.lint.folder', async (target?: vscode.Uri) => {
    let folder = target?.scheme === 'file' ? target : undefined;
    if (!folder) {
      const ws = vscode.workspace.workspaceFolders ?? [];
      const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: 'Lint', defaultUri: ws[0]?.uri, title: 'Lint every robot program in a folder' });
      folder = picked?.[0];
    }
    if (!folder) return;
    const run = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Linting ${path.basename(folder.fsPath)}…` }, async () => lintPaths([folder!.fsPath]));
    folderColl.clear();
    const open = new Set(vscode.workspace.textDocuments.map(d => d.uri.toString()));
    for (const f of run.files) {
      const uri = vscode.Uri.file(f.path);
      if (!f.findings.length || open.has(uri.toString())) continue;
      folderColl.set(uri, f.findings.map(x => findingToDiagnostic(x, uri, SOURCE[f.language] ?? f.language)));
    }
    out.clear();
    out.appendLine(`Lint of ${folder.fsPath} - ${new Date().toLocaleString()}`);
    for (const c of run.configs) out.appendLine(`config: ${c.file}`);
    out.appendLine(formatLintText(run, { base: folder.fsPath }));
    const t = lintTotals(run);
    const msg = `${path.basename(folder.fsPath)}: ${t.files} file${t.files === 1 ? '' : 's'} linted - ${t.error} error${t.error === 1 ? '' : 's'}, ${t.warning} warning${t.warning === 1 ? '' : 's'}, ${t.info + t.hint} note${t.info + t.hint === 1 ? '' : 's'}.`;
    const problems = run.configs.flatMap(c => c.problems.map(p => `${c.file}: ${p}`));
    if (problems.length) out.appendLine(problems.join('\n'));
    const pick = await (t.error ? vscode.window.showWarningMessage : vscode.window.showInformationMessage)(problems.length ? `${msg} The lint config has problems - see Output.` : msg, 'Show Problems', 'Show Report');
    if (pick === 'Show Problems') await vscode.commands.executeCommand('workbench.actions.view.problems');
    else if (pick === 'Show Report') out.show(true);
  }));

  ctx.subscriptions.push(vscode.commands.registerCommand('robotCode.lint.clear', () => folderColl.clear()));

  ctx.subscriptions.push(vscode.commands.registerCommand('robotCode.lint.createConfig', async () => {
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) { vscode.window.showInformationMessage('Open a folder first: the lint config lives in it.'); return; }
    const uri = vscode.Uri.joinPath(ws.uri, LINT_CONFIG_FILE);
    try { await vscode.workspace.fs.stat(uri); }
    catch {
      await vscode.workspace.fs.writeFile(uri, Buffer.from(LINT_STARTER_CONFIG, 'utf8'));
    }
    await vscode.window.showTextDocument(uri);
  }));
}
