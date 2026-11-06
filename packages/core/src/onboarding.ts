/**
 * Onboarding: the tutorial cell and the walkthrough openers.
 *
 * The walkthroughs teach the product; this module opens them from a link (an empty view, the
 * feature finder) and copies the bundled sample cell somewhere the user owns and can write to.
 * It never copies into the extension install folder and never needs administrator rights:
 * `globalStorageUri` sits under the user profile, and a temp folder is the fallback. The
 * sample opens in its own window, so the user's real work is never disturbed.
 */
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** the walkthrough ids contributed in package.json */
export const WALKTHROUGHS = {
  gettingStarted: 'robotCode.gettingStarted',
  robot: 'robotCode.robot',
  rukus: 'robotCode.rukus',
} as const;

/** the sample cell shipped in the VSIX */
const SAMPLE = 'samples/tutorial-cell';

export function registerOnboarding(ctx: vscode.ExtensionContext): void {
  const open = (id: string) =>
    vscode.commands.executeCommand('workbench.action.openWalkthrough', `${ctx.extension.id}#${id}`, false);

  ctx.subscriptions.push(
    vscode.commands.registerCommand('robotCode.openGettingStarted', () => open(WALKTHROUGHS.gettingStarted)),
    vscode.commands.registerCommand('robotCode.openRobotWalkthrough', () => open(WALKTHROUGHS.robot)),
    vscode.commands.registerCommand('robotCode.openRukusWalkthrough', () => open(WALKTHROUGHS.rukus)),
    vscode.commands.registerCommand('robotCode.tutorial.open', () => openTutorialCell(ctx)),
    vscode.commands.registerCommand('robotCode.tutorial.openReadme', () => openTutorialReadme(ctx)),
  );
}

/**
 * Copy the bundled tutorial cell somewhere writable and open it in a new window. Existing
 * copies are offered Open / Reset rather than silently overwritten, so edits survive.
 */
async function openTutorialCell(ctx: vscode.ExtensionContext): Promise<void> {
  const dest = await ensureSample(ctx, true);
  if (!dest) return;
  await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(dest), { forceNewWindow: true });
}

/**
 * Open the tutorial cell's README as a **Markdown preview**, not source - the reader-mode
 * counterpart to `robotCode.tutorial.open`. The sample is copied first if it is not there yet.
 */
async function openTutorialReadme(ctx: vscode.ExtensionContext): Promise<void> {
  const dest = await ensureSample(ctx, false);
  if (!dest) return;
  const readme = path.join(dest, 'README.md');
  if (!fs.existsSync(readme)) {
    vscode.window.showWarningMessage('The tutorial cell has no README to preview.');
    return;
  }
  await vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.file(readme));
}

/**
 * Make sure the tutorial cell exists on disk and return its folder. `prompt` offers Open /
 * Reset when a copy is already there; without it an existing copy is used as-is.
 */
async function ensureSample(ctx: vscode.ExtensionContext, prompt: boolean): Promise<string | undefined> {
  const src = ctx.asAbsolutePath(SAMPLE);
  if (!fs.existsSync(src)) {
    vscode.window.showErrorMessage('The tutorial cell is missing from this build.');
    return undefined;
  }
  const preferred = path.join(ctx.globalStorageUri.fsPath, 'tutorial-cell');
  const fallback = path.join(os.tmpdir(), 'robot-code-tutorial-cell');
  let dest = fs.existsSync(preferred) || writable(path.dirname(preferred)) ? preferred : fallback;

  if (prompt && fs.existsSync(dest)) {
    const pick = await vscode.window.showInformationMessage(
      'The tutorial cell is already here.',
      { modal: true, detail: dest },
      'Open', 'Reset to a clean copy');
    if (pick === 'Reset to a clean copy') {
      try { fs.rmSync(dest, { recursive: true, force: true }); } catch { /* the copy reports a real failure */ }
    } else if (pick !== 'Open') return undefined;
  }

  if (!fs.existsSync(dest)) {
    if (!copySample(src, dest) && dest !== fallback) {
      dest = fallback;
      fs.rmSync(dest, { recursive: true, force: true });
      copySample(src, dest);
    }
    if (!fs.existsSync(dest)) {
      vscode.window.showErrorMessage(`Could not copy the tutorial cell to ${dest}.`);
      return undefined;
    }
  }
  return dest;
}

/** copy the sample tree; true when it landed */
function copySample(src: string, dest: string): boolean {
  try {
    fs.mkdirSync(dest, { recursive: true });
    fs.cpSync(src, dest, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

/** can this process create files in `dir`? (no elevation is ever attempted) */
function writable(dir: string): boolean {
  try { fs.accessSync(dir, fs.constants.W_OK); return true; } catch { return false; }
}
