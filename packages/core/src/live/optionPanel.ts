/** The panel an option's whole explanation opens in (optionInfo.ts): one, reused by every click. */
import * as vscode from 'vscode';
import { optionPanelHtml, type OptionInfo } from './optionInfo';

let panel: vscode.WebviewPanel | undefined;

export function showOptionPanel(info: OptionInfo): void {
  if (!panel) {
    panel = vscode.window.createWebviewPanel('robotCode.optionInfo', 'Option', { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false }, { enableScripts: false });
    panel.onDidDispose(() => { panel = undefined; });
  } else panel.reveal(undefined, false);
  panel.title = `Option: ${info.title}`;
  panel.webview.html = optionPanelHtml(info);
}
