/**
 * Does a folder tree hold FANUC files - TP (.ls/.tp), KAREL (.kl/.pc) or controller data (.va,
 * .dg, ORDERFIL.DAT)? Bounded (a few levels, a few thousand entries) so it can run at activation.
 * Pure (node fs only).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const FANUC_FILE = /\.(ls|tp|kl|pc|va|dg)$|^orderfil\.dat$/i;
const SKIP = new Set(['node_modules', '.git', '.vscode', '.vscode-test', 'dist', 'out']);

export function looksLikeFanuc(roots: string[], maxDepth = 4, maxEntries = 4000): boolean {
  let seen = 0;
  const queue: { dir: string; depth: number }[] = roots.map(dir => ({ dir, depth: 0 }));
  while (queue.length && seen < maxEntries) {
    const { dir, depth } = queue.shift()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (++seen > maxEntries) break;
      if (e.isFile() && FANUC_FILE.test(e.name)) return true;
      if (e.isDirectory() && depth < maxDepth && !SKIP.has(e.name.toLowerCase())) queue.push({ dir: path.join(dir, e.name), depth: depth + 1 });
    }
  }
  return false;
}
