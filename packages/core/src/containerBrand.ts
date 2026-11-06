/**
 * The brands a workspace's container markers declare. A marker written by this extension knows
 * its brand, so it is more reliable than the files a folder happens to hold. Bounded (a few
 * levels, a few thousand entries) and pure (node fs only) so the brand decision can use it at
 * activation.
 *
 * No marker brand means "nothing said" - the caller falls back to scanning files, since older
 * containers predate the brand field.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CELL_DIR, CELL_JSON, ROBOT_DIR, ROBOT_JSON, parseCellJson, parseRobotJson } from './robotContainers';

const SKIP = new Set(['node_modules', '.git', '.vscode', '.vscode-test', 'dist', 'out']);

export function markerBrands(roots: string[], maxDepth = 4, maxEntries = 4000): { fanuc: boolean; abb: boolean } {
  let fanuc = false;
  let abb = false;
  let seen = 0;
  const queue: { dir: string; depth: number }[] = roots.map(dir => ({ dir, depth: 0 }));
  while (queue.length && seen < maxEntries) {
    const { dir, depth } = queue.shift()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (++seen > maxEntries) break;
      if (!e.isDirectory()) continue;
      if (e.name === CELL_DIR) {
        const cell = readCell(path.join(dir, e.name));
        if (cell?.brand === 'fanuc' || cell?.brand === 'mixed') fanuc = true;
        if (cell?.brand === 'abb' || cell?.brand === 'mixed') abb = true;
      } else if (e.name === ROBOT_DIR) {
        const robot = readRobot(path.join(dir, e.name));
        if (robot?.brand === 'fanuc') fanuc = true;
        if (robot?.brand === 'abb') abb = true;
      } else if (depth < maxDepth && !SKIP.has(e.name.toLowerCase())) {
        queue.push({ dir: path.join(dir, e.name), depth: depth + 1 });
      }
    }
    if (fanuc && abb) break;
  }
  return { fanuc, abb };
}

/** A marker that cannot be read or parsed says nothing, so a broken file never fails activation. */
function readText(file: string): string | undefined {
  try { return fs.readFileSync(file, 'utf8'); } catch { return undefined; }
}

function readCell(markerDir: string) {
  const text = readText(path.join(markerDir, CELL_JSON));
  if (text === undefined) return undefined;
  try { return parseCellJson(text, path.dirname(markerDir)).cell; } catch { return undefined; }
}

function readRobot(markerDir: string) {
  const text = readText(path.join(markerDir, ROBOT_JSON));
  if (text === undefined) return undefined;
  try { return parseRobotJson(text, path.dirname(markerDir)).marker; } catch { return undefined; }
}
