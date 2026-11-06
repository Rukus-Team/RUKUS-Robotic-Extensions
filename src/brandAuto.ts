/**
 * Which brands load in this window, decided once at activation by a bounded scan of the workspace
 * and the backup folders (so a large workspace does not slow the start):
 *
 * - an explicit `robotCode.abb.enabled` / `robotCode.fanuc.enabled` (true or false, any level) decides;
 * - else `robotCode.views.brands` (fanuc / abb / both) says which, when it has been chosen;
 * - else what the container markers declare (a robot.json or cell.json brand);
 * - else what the folders hold: ABB files (a backup with BACKINFO, .mod/.prg modules) load ABB, FANUC
 *   files (.ls/.tp/.kl/.pc/.va/.dg) load FANUC;
 * - a folder with neither loads FANUC (the side bar then asks which brand, brandViews.ts), and only
 *   an ABB-only folder leaves FANUC out.
 */
import * as vscode from 'vscode';
import { looksLikeAbb } from '@abb/detect';
import { markerBrands } from '@core/containerBrand';
import { looksLikeFanuc } from '@fanuc/detect';

export type BrandWhy = 'setting' | 'choice' | 'detected' | 'default' | 'none';
export interface BrandDecision { fanuc: { on: boolean; why: BrandWhy }; abb: { on: boolean; why: BrandWhy } }

export function decideBrands(): BrandDecision {
  const cfg = vscode.workspace.getConfiguration('robotCode');
  const explicit = (key: string) => { const i = cfg.inspect<boolean>(key); return i?.workspaceFolderValue ?? i?.workspaceValue ?? i?.globalValue; };
  const choice = cfg.get<string>('views.brands', 'auto');
  const roots = [...(vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath), ...cfg.get<string[]>('data.backupFolders', [])];
  // A marker brand is authoritative: it says what the container is, not what files it happens to
  // hold. Only when no marker names a brand do we fall back to scanning the files.
  const marked = markerBrands(roots);
  const anyMarked = marked.fanuc || marked.abb;
  let abbFiles: boolean | undefined, fanucFiles: boolean | undefined;
  const hasAbb = () => anyMarked ? marked.abb : (abbFiles ??= looksLikeAbb(roots));
  const hasFanuc = () => anyMarked ? marked.fanuc : (fanucFiles ??= looksLikeFanuc(roots));

  const ea = explicit('abb.enabled');
  const abb: BrandDecision['abb'] = ea !== undefined ? { on: ea, why: 'setting' }
    : choice === 'abb' || choice === 'both' ? { on: true, why: 'choice' }
    : choice === 'fanuc' ? { on: false, why: 'choice' }
    : hasAbb() ? { on: true, why: 'detected' } : { on: false, why: 'none' };

  const ef = explicit('fanuc.enabled');
  const fanuc: BrandDecision['fanuc'] = ef !== undefined ? { on: ef, why: 'setting' }
    : choice === 'fanuc' || choice === 'both' ? { on: true, why: 'choice' }
    : choice === 'abb' ? { on: false, why: 'choice' }
    : hasFanuc() ? { on: true, why: 'detected' }
    : hasAbb() ? { on: false, why: 'none' }        // an ABB-only folder
    : { on: true, why: 'default' };                // nothing yet: FANUC, and the side bar asks
  return { fanuc, abb };
}
