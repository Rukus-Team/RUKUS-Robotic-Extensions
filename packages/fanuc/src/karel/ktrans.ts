/**
 * Runs FANUC's ktrans.exe (from ROBOGUIDE / WinOLPC) on a KAREL source and
 * turns its output into VS Code diagnostics.
 */
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { FanucServices } from '../services';
import { config } from '@core/util';
import { parseKtransIssues } from './ktransOutput';
export { parseKtransIssues } from './ktransOutput';

export const ktransDiagnostics = vscode.languages.createDiagnosticCollection('ktrans');

const DEFAULT_LOCATIONS = [
  'C:\\Program Files (x86)\\FANUC\\WinOLPC\\bin\\ktrans.exe',
  'C:\\Program Files\\FANUC\\WinOLPC\\bin\\ktrans.exe',
  'C:\\Program Files (x86)\\FANUC\\ROBOGUIDE\\WinOLPC\\bin\\ktrans.exe',
  'C:\\Program Files (x86)\\FANUC\\OLPC PRO\\bin\\ktrans.exe',
];

export function findKtrans(): string | undefined {
  const configured = config<string>('karel.ktransPath', '').trim();
  if (configured) return fs.existsSync(configured) ? configured : undefined;
  try {
    const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['ktrans'], { encoding: 'utf8' });
    const first = r.stdout?.split(/\r?\n/).find(l => l.trim());
    if (r.status === 0 && first && fs.existsSync(first.trim())) return first.trim();
  } catch { /* ignore */ }
  return DEFAULT_LOCATIONS.find(p => fs.existsSync(p));
}

export async function compileKarel(doc: vscode.TextDocument, s: FanucServices): Promise<void> {
  const exe = findKtrans();
  if (!exe) {
    const pick = await vscode.window.showWarningMessage('ktrans.exe was not found. It ships with ROBOGUIDE / WinOLPC. Set robotCode.karel.ktransPath.', 'Open Settings', 'Browse…');
    if (pick === 'Open Settings') await vscode.commands.executeCommand('workbench.action.openSettings', 'robotCode.karel.ktransPath');
    if (pick === 'Browse…') {
      const f = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { Executable: ['exe'] }, title: 'Locate ktrans.exe' });
      if (f?.[0]) { await vscode.workspace.getConfiguration('robotCode').update('karel.ktransPath', f[0].fsPath, vscode.ConfigurationTarget.Global); return compileKarel(doc, s); }
    }
    return;
  }
  // `/ver` is a QUERY, not a modifier: `ktrans /ver` prints the version banner and exits,
  // and `ktrans file.kl /ver V9.40` dies with "Too many arguments: V9.40". Passing it
  // alongside a file broke every compile for anyone who set karel.ktransVersion. The core
  // version actually comes from robot.ini, which is what /config selects — and without one
  // ktrans says "Unable to find 'robot.ini', using basic KAREL support files" and compiles
  // anyway, which is why this went unnoticed while the setting was empty.
  const args = [doc.uri.fsPath];
  const iniPath = config<string>('karel.ktransConfig', '').trim();
  if (iniPath) args.push('/config', iniPath);
  const cwd = path.dirname(doc.uri.fsPath);
  s.output.appendLine(`\n[ktrans] ${exe} ${args.map(a => (a.includes(' ') ? `"${a}"` : a)).join(' ')}`);

  const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: `ktrans ${path.basename(doc.uri.fsPath)}` }, () => new Promise<{ code: number | null; out: string }>(resolve => {
    let out = '';
    const p = spawn(exe, args, { cwd, windowsHide: true });
    p.stdout.on('data', d => { out += d.toString(); });
    p.stderr.on('data', d => { out += d.toString(); });
    p.on('error', e => resolve({ code: -1, out: out + `\n${e.message}` }));
    p.on('close', code => resolve({ code, out }));
  }));

  s.output.append(result.out.endsWith('\n') ? result.out : result.out + '\n');
  const diags = parseKtransOutput(result.out, doc);
  const { success, summary } = parseKtransIssues(result.out);
  ktransDiagnostics.set(doc.uri, diags);
  const errors = diags.filter(d => d.severity === vscode.DiagnosticSeverity.Error).length;
  if (result.code === 0 && errors === 0 && success !== false) {
    const pc = path.join(cwd, path.basename(doc.uri.fsPath).replace(/\.kl$/i, '.pc'));
    vscode.window.setStatusBarMessage(`$(check) ktrans: ${summary ?? 'OK'}${fs.existsSync(pc) ? ` → ${path.basename(pc)}` : ''}`, 6000);
  } else {
    const first = diags[0];
    const pick = await vscode.window.showErrorMessage(`ktrans: ${errors} error${errors === 1 ? '' : 's'} in ${path.basename(doc.uri.fsPath)}${first ? ` — line ${first.range.start.line + 1}: ${first.message}` : ''}`, 'Go to first error', 'Show output');
    if (pick === 'Show output') s.output.show(true);
    if (pick === 'Go to first error' && first) {
      const ed = await vscode.window.showTextDocument(doc);
      ed.selection = new vscode.Selection(first.range.start, first.range.end);
      ed.revealRange(first.range, vscode.TextEditorRevealType.InCenter);
    }
  }
}

export function parseKtransOutput(out: string, doc: vscode.TextDocument): vscode.Diagnostic[] {
  const { issues } = parseKtransIssues(out);
  return issues.map(x => {
    const ln = Math.max(0, Math.min(x.line, doc.lineCount - 1));
    const text = doc.lineAt(ln).text;
    const start = Math.min(x.col, Math.max(text.length - 1, 0));
    const wordEnd = /[A-Za-z0-9_$]+/.exec(text.slice(start))?.[0].length ?? 1;
    const range = new vscode.Range(ln, start, ln, Math.min(text.length, start + Math.max(wordEnd, 1)));
    const d = new vscode.Diagnostic(range, x.message, x.severity === 'warning' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Error);
    d.source = 'ktrans';
    return d;
  });
}
