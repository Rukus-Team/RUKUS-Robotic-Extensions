/**
 * One colour and one icon per kind of thing, used by the sidebar, the editor tints and
 * the status bar alike, so "amber means TP program" holds everywhere at once.
 *
 * Colour is never the only signal: every kind also has its own icon, and text says the
 * kind wherever there is room. The colour ids are VS Code theme tokens, so a light theme
 * and a high-contrast theme each draw them their own way.
 */
import * as vscode from 'vscode';
import { folderDate } from '@core/backupFolders';

export type EntityKind = 'tp' | 'pc' | 'macro' | 'data' | 'missing';

export const TYPE_COLOR: Record<EntityKind, string> = {
  tp: 'charts.orange',           // amber
  pc: 'charts.blue',
  macro: 'terminal.ansiCyan',    // teal
  data: 'descriptionForeground', // neutral grey
  missing: 'charts.red',
};

export const TYPE_ICON: Record<EntityKind, string> = {
  tp: 'file-code',
  pc: 'file-binary',
  macro: 'symbol-event',
  data: 'database',
  missing: 'warning',
};

export const TYPE_LABEL: Record<EntityKind, string> = { tp: 'TP program', pc: 'PC program', macro: 'Macro', data: 'Data', missing: 'Not found' };

/** amber for a count that is a problem, e.g. "31 unused" */
export const PROBLEM_COLOR = 'charts.orange';

export function icon(id: string, color?: string): vscode.ThemeIcon {
  return color ? new vscode.ThemeIcon(id, new vscode.ThemeColor(color)) : new vscode.ThemeIcon(id);
}

export function typeIcon(kind: EntityKind, override?: string): vscode.ThemeIcon {
  return icon(override ?? TYPE_ICON[kind], TYPE_COLOR[kind]);
}

/**
 * "S002R01_full_260823" → "26-08-23"; undefined when the folder name carries no date.
 * The implementation is `folderDate` in fanuc/data/vaParser.ts, where code that must not import
 * vscode can reach it too.
 */
export const backupDate = folderDate;
