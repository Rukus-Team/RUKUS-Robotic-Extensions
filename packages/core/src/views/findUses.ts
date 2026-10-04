/**
 * "Find uses" of one data item (`R[5]`, `DO[12]`) across the program sources of a robot
 * folder, through VS Code's own search panel. Split out of the sidebar trees in monorepo
 * phase 2 so the live dashboard (core) can offer it without importing a brand's views.
 */
import * as vscode from 'vscode';
import * as path from 'node:path';
import { brands } from '../brand';

/** source extensions of every registered brand: compiled programs have nothing to search */
function sourceExtensions(): string[] {
  return [...new Set(brands().flatMap(b => b.programExtensions.filter(e => !b.isBinaryProgram?.(`x.${e}`))))];
}

export function findUses(kind: string, index: number, folder?: string) {
  const rel = folder ? vscode.workspace.asRelativePath(folder, false) : undefined;
  const exts = sourceExtensions().flatMap(e => [e, e.toUpperCase()]);
  return vscode.commands.executeCommand('workbench.action.findInFiles', {
    query: `\\b${kind}\\[${index}(:|\\]|,)`,
    isRegex: true,
    triggerSearch: true,
    filesToInclude: rel && !path.isAbsolute(rel) ? `${rel}/*.{${exts.join(',')}}` : exts.map(e => `*.${e}`).join(','),
  });
}
