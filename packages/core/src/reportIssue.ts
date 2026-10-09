// "Robot Code: Report an Issue" - opens the public repo's bug report form in the browser with the
// versions already filled in (issue forms take a field's value from a query parameter of its id).
// The address comes from package.json's `bugs.url`, so this stays brand-free.
import * as vscode from 'vscode';
import * as os from 'os';

/** The new-issue address with the form's version fields pre-filled. Pure, for the unit tests. */
export function reportIssueUrl(bugsUrl: string, info: { extension: string; vscode: string; os: string }): string {
  const q = new URLSearchParams({ template: 'bug_report.yml', 'extension-version': info.extension, 'vscode-version': info.vscode, os: info.os });
  return `${bugsUrl.replace(/\/+$/, '')}/new?${q.toString()}`;
}

export function registerReportIssue(ctx: vscode.ExtensionContext): void {
  ctx.subscriptions.push(vscode.commands.registerCommand('robotCode.reportIssue', async () => {
    const pkg = ctx.extension.packageJSON as { version?: string; bugs?: { url?: string } };
    const bugs = pkg.bugs?.url;
    if (!bugs) { void vscode.window.showErrorMessage('RUKUS: no issue address is configured.'); return; }
    const url = reportIssueUrl(bugs, { extension: pkg.version ?? '?', vscode: vscode.version, os: `${os.type()} ${os.release()} (${os.arch()})` });
    await vscode.env.openExternal(vscode.Uri.parse(url, true));
  }));
}
