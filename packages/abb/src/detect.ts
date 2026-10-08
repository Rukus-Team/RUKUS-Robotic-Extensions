/**
 * Does a folder tree hold ABB files - a backup (BACKINFO beside RAPID or SYSPAR) or RAPID modules
 * (.mod / .modx / .prg)? Bounded (a few levels, a few thousand entries) so it can run at activation.
 * Pure (node fs only).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const RAPID_FILE = /\.(mod|modx|prg)$/i;
const SKIP = new Set(['node_modules', '.git', '.vscode', '.vscode-test', 'dist', 'out']);

export function looksLikeAbb(roots: string[], maxDepth = 4, maxEntries = 4000): boolean {
  let seen = 0;
  const queue: { dir: string; depth: number }[] = roots.map(dir => ({ dir, depth: 0 }));
  while (queue.length && seen < maxEntries) {
    const { dir, depth } = queue.shift()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    const names = new Set(entries.map(e => e.name.toUpperCase()));
    if (names.has('BACKINFO') && (names.has('RAPID') || names.has('SYSPAR'))) return true;
    for (const e of entries) {
      if (++seen > maxEntries) break;
      if (e.isFile() && RAPID_FILE.test(e.name)) return true;
      if (e.isDirectory() && depth < maxDepth && !SKIP.has(e.name.toLowerCase())) queue.push({ dir: path.join(dir, e.name), depth: depth + 1 });
    }
  }
  return false;
}
