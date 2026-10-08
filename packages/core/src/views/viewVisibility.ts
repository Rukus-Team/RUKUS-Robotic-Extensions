/**
 * "The user just opened the Robot Code side bar": VS Code only says so per tree view, so the
 * views report here and anything that wants to act on it (the brand question, brandViews.ts)
 * listens to one event.
 */
import * as vscode from 'vscode';

const shown = new vscode.EventEmitter<void>();
export const onDidShowRobotCodeView = shown.event;

/** report a Robot Code tree view's visibility; returns the view for chaining */
export function watchViewVisibility<T>(view: vscode.TreeView<T>): vscode.TreeView<T> {
  view.onDidChangeVisibility(e => { if (e.visible) shown.fire(); });
  if (view.visible) setTimeout(() => shown.fire(), 0);
  return view;
}
