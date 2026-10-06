/**
 * Hand-off to RUKUS.
 *
 * The extension is the EDITOR. Anything that is really cell management - live
 * monitoring, alarm history, scheduled backups - belongs in RUKUS, and the buttons
 * here open RUKUS on the right page instead of duplicating it badly in a webview.
 *
 * The link is a `rukus://` URI registered by the RUKUS installer:
 *     rukus://monitor?robot=S002R01&host=10.0.0.5
 * Routes and parameter names are the contract; see RUKUS-INTEGRATION.md and the
 * matching parser in the RUKUS repo (Helpers/DeepLink.cs).
 */
import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import { config } from '../util';

export const RUKUS_SCHEME = 'rukus';
export const RUKUS_DOWNLOAD_URL = 'https://github.com/Rukus-Team/Robotic-Utility-Kit-User-System/releases';

/** Pages RUKUS knows how to open. Keep in step with the RUKUS side. */
export type RukusRoute = 'home' | 'monitor' | 'alarms' | 'backup' | 'diff' | 'schedule';

export interface RukusTarget {
  route: RukusRoute;
  /** robot display name, so RUKUS can preselect a profile it already knows */
  robot?: string;
  host?: string;
  /** a folder RUKUS should open (backup compare, "use this backup") */
  path?: string;
}

export function rukusUri(t: RukusTarget): vscode.Uri {
  const q = new URLSearchParams();
  if (t.robot) q.set('robot', t.robot);
  if (t.host) q.set('host', t.host);
  if (t.path) q.set('path', t.path);
  const query = q.toString();
  return vscode.Uri.parse(`${RUKUS_SCHEME}://${t.route}${query ? `?${query}` : ''}`);
}

/**
 * Is the rukus: protocol registered on this machine? That is what actually decides
 * whether the link will work - a RUKUS that is installed but predates deep links
 * would leave the user staring at a dialog Windows puts up, so check the handler
 * rather than the install.
 *
 * Cached for the session: the answer only changes when RUKUS is (un)installed, and
 * this is called from tree rendering.
 */
let handlerCache: boolean | undefined;
export function invalidateRukusCache() { handlerCache = undefined; }

export async function rukusHandlerRegistered(): Promise<boolean> {
  if (handlerCache !== undefined) return handlerCache;
  if (process.platform !== 'win32') return (handlerCache = false);
  handlerCache = await new Promise<boolean>(resolve => {
    // HKCU first (per-user install is the default), then HKLM for a machine-wide one.
    execFile('reg.exe', ['query', `HKCU\\Software\\Classes\\${RUKUS_SCHEME}`, '/ve'], { windowsHide: true }, err1 => {
      if (!err1) return resolve(true);
      execFile('reg.exe', ['query', `HKLM\\Software\\Classes\\${RUKUS_SCHEME}`, '/ve'], { windowsHide: true }, err2 => resolve(!err2));
    });
  });
  return handlerCache;
}

/**
 * Where RUKUS is installed, from the same registry key: its open command is
 * `"C:\...\RUKUS.exe" "%1"`, and the reference data it ships sits in `Assets\` beside the
 * exe. Undefined when RUKUS is not installed or this is not Windows.
 */
let installDirCache: string | undefined | null = null;
export async function rukusInstallDir(): Promise<string | undefined> {
  if (installDirCache !== null) return installDirCache;
  if (process.platform !== 'win32') return (installDirCache = undefined);
  const query = (hive: string) => new Promise<string | undefined>(resolve => {
    execFile('reg.exe', ['query', `${hive}\\Software\\Classes\\${RUKUS_SCHEME}\\shell\\open\\command`, '/ve'], { windowsHide: true }, (err, stdout) => {
      if (err) return resolve(undefined);
      const m = /REG_SZ\s+"?([^"\r\n]+?\.exe)"?/i.exec(stdout);
      resolve(m ? m[1].replace(/[\\/][^\\/]+$/, '') : undefined);
    });
  });
  installDirCache = (await query('HKCU')) ?? (await query('HKLM'));
  return installDirCache;
}

/**
 * Open RUKUS at `target`. When the protocol is not registered, say so once and offer
 * the download instead of firing a URI Windows will refuse.
 */
export async function openInRukus(t: RukusTarget): Promise<void> {
  if (!config<boolean>('rukus.enabled', true)) {
    vscode.window.showInformationMessage('RUKUS hand-off is switched off (robotCode.rukus.enabled).');
    return;
  }
  if (!(await rukusHandlerRegistered())) {
    const pick = await vscode.window.showInformationMessage(
      'This opens in RUKUS - the robot utility kit that owns live monitoring, alarm history and scheduled backups. It is not installed on this PC (or is an older build without deep links).',
      'Get RUKUS', 'Not now');
    if (pick === 'Get RUKUS') await vscode.env.openExternal(vscode.Uri.parse(config<string>('rukus.downloadUrl', RUKUS_DOWNLOAD_URL)));
    return;
  }
  const uri = rukusUri(t);
  // openExternal is the supported way to fire a custom scheme; it also works over
  // a remote/SSH window, where a spawned process would run on the wrong machine.
  const ok = await vscode.env.openExternal(uri);
  if (!ok) vscode.window.showWarningMessage(`Windows would not open ${uri.toString()}. Check that RUKUS is installed.`);
}
