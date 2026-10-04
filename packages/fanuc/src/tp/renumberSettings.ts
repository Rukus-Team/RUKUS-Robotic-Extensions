/**
 * The one place the renumber settings are read.
 *
 * `robotCode.tp.autoRenumber` is `on`, `off` or `custom` (older settings files still say
 * `true` / `false`, which read as on / off). `on` writes what the controller writes:
 * `   1:  R[1]=1 ;` - a four-wide number field, ` ;` on every instruction. `custom` writes
 * the style in `robotCode.tp.customRenumber`, whose default is what Sam asked for: four
 * spaces, the number as it is, a colon, and no terminator added (`    1:  R[1]=1`). A
 * terminator that is already there is left alone in every mode. The manual Renumber
 * command and Format Document use the controller style unless the mode is custom.
 */
import * as vscode from 'vscode';
import { config } from '@core/util';
import type { RenumberOptions } from './renumber';
import { EXT_COMMENT_WIDTH } from './extendedComment';

export type AutoRenumberMode = 'on' | 'off' | 'custom' | 'scaffold';

export interface CustomRenumber { indent: string; width: number; terminator: boolean; number: 'show' | 'ones' | 'spaces' | 'none' }
export const DEFAULT_CUSTOM: CustomRenumber = { indent: '    ', width: 0, terminator: false, number: 'show' };

export function autoRenumberMode(scope?: vscode.ConfigurationScope): AutoRenumberMode {
  const v = config<string | boolean>('tp.autoRenumber', 'on', scope);
  if (v === true || v === 'on') return 'on';
  if (v === false || v === 'off') return 'off';
  if (v === 'custom') return 'custom';
  if (v === 'scaffold') return 'scaffold';
  return 'on';
}

/** the controller's own format: `   1:  R[1]=1 ;` (robotCode.tp.lineNumberWidth / autoSemicolon) */
export function controllerOptions(scope?: vscode.ConfigurationScope, extra: Partial<RenumberOptions> = {}): RenumberOptions {
  return { width: config<number>('tp.lineNumberWidth', 4, scope), autoSemicolon: config<boolean>('tp.autoSemicolon', true, scope), updateLineCount: true, extendedCommentWidth: extendedCommentWidth(scope), ...extra };
}

/** robotCode.tp.extendedCommentWidth: the pendant's 78 columns unless changed; 0 = off */
export function extendedCommentWidth(scope?: vscode.ConfigurationScope): number {
  const v = config<number>('tp.extendedCommentWidth', EXT_COMMENT_WIDTH, scope);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

/** the style in robotCode.tp.customRenumber, whatever the mode; `onlyNew` unless `extra` says otherwise */
export function customOptions(scope?: vscode.ConfigurationScope, extra: Partial<RenumberOptions> = {}): RenumberOptions {
  const c = { ...DEFAULT_CUSTOM, ...config<Partial<CustomRenumber>>('tp.customRenumber', {}, scope) };
  const number = c.number === 'spaces' || c.number === 'none' || c.number === 'ones' ? c.number : 'show';
  return { indent: typeof c.indent === 'string' ? c.indent : DEFAULT_CUSTOM.indent, width: Math.max(0, Number(c.width) || 0), number, autoSemicolon: !!c.terminator, updateLineCount: true, onlyNew: true, ...extra };
}

/** scaffold mode: only formats new lines with a blank prefix (spaces + colon); respects autoSemicolon */
export function scaffoldOptions(scope?: vscode.ConfigurationScope, extra: Partial<RenumberOptions> = {}): RenumberOptions {
  return { number: 'scaffold', autoSemicolon: config<boolean>('tp.autoSemicolon', true, scope), updateLineCount: true, onlyNew: true, width: config<number>('tp.lineNumberWidth', 4, scope), ...extra };
}

/**
 * The options `renumber()` needs for the current mode. In `custom` and `scaffold` only the
 * lines being typed get the style (`onlyNew`): the program's existing numbering is never
 * rewritten just because the mode changed - that is what the one-shot commands are for.
 */
export function renumberOptions(scope?: vscode.ConfigurationScope, extra: Partial<RenumberOptions> = {}): RenumberOptions {
  const mode = autoRenumberMode(scope);
  if (mode === 'custom') return customOptions(scope, extra);
  if (mode === 'scaffold') return scaffoldOptions(scope, extra);
  return controllerOptions(scope, extra);
}

export const MODE_LABEL: Record<AutoRenumberMode, string> = { on: 'on (controller format)', off: 'off', custom: 'custom', scaffold: 'scaffold' };
