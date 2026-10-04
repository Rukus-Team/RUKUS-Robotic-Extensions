/**
 * Names declared by a program's %INCLUDE files, read from disk the way ktrans finds them:
 * the path as written, relative to the source's folder (`..\SYSTEM\appldict`), then the
 * bare file name in the KAREL support folders (FANUC's own klevkeys, kliotyps ...).
 *
 * findUndeclared stays silent for a program whose includes it cannot see, so this is what
 * lets it answer for the many real programs that include a project's global declarations.
 * `complete` is false as soon as one include, at any depth, cannot be found - and then
 * nothing is reported, exactly as before. No vscode: the unit tests run it on the corpus.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseKarel, type KProgram } from './parser';

export interface IncludedNames { names: Set<string>; complete: boolean; missing: string[] }

const cache = new Map<string, { mtimeMs: number; prog: KProgram }>();

function load(file: string): KProgram | undefined {
  let st: fs.Stats;
  try { st = fs.statSync(file); } catch { return undefined; }
  if (!st.isFile()) return undefined;
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs) return hit.prog;
  let text: string;
  try { text = fs.readFileSync(file, 'latin1'); } catch { return undefined; }
  const prog = parseKarel(text);
  cache.set(file, { mtimeMs: st.mtimeMs, prog });
  return prog;
}

export function resolveInclude(arg: string, fromDir: string, supportDirs: readonly string[]): string | undefined {
  const name = arg.replace(/^['"]|['"]$/g, '').replace(/[\\/]+/g, path.sep);
  const withExt = /\.[A-Za-z0-9]+$/.test(path.basename(name)) ? name : `${name}.kl`;
  const candidates = [path.resolve(fromDir, withExt), ...supportDirs.map(d => path.join(d, path.basename(withExt)))];
  return candidates.find(c => { try { return fs.statSync(c).isFile(); } catch { return false; } });
}

export function includedNames(prog: KProgram, fromDir: string, supportDirs: readonly string[]): IncludedNames {
  const out: IncludedNames = { names: new Set(), complete: true, missing: [] };
  const seen = new Set<string>();
  const walk = (p: KProgram, dir: string, depth: number) => {
    for (const inc of p.includes) {
      const file = resolveInclude(inc, dir, supportDirs);
      if (!file) { out.complete = false; out.missing.push(inc); continue; }
      const key = file.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const sub = load(file);
      if (!sub || sub.compiled) { out.complete = false; out.missing.push(inc); continue; }
      for (const s of sub.symbols) {
        out.names.add(s.upper);
        for (const f of s.fields ?? []) out.names.add(f.upper);
      }
      if (depth < 8) walk(sub, path.dirname(file), depth + 1);
      else out.complete = false;
    }
  };
  walk(prog, fromDir, 0);
  return out;
}

/**
 * KAREL support folders to search for FANUC's include files: the `Support=` folder of the
 * robot.ini given to ktrans, else every Versions\*\support next to ktrans.exe, newest first.
 */
export function karelSupportDirs(ktransExe: string | undefined, robotIniText: string | undefined): string[] {
  const fromIni = robotIniText ? /^\s*Support\s*=\s*(.+?)\s*$/im.exec(robotIniText)?.[1] : undefined;
  if (fromIni) return [fromIni];
  if (!ktransExe) return [];
  const versions = path.join(path.dirname(ktransExe), '..', 'Versions');
  try {
    return fs.readdirSync(versions).sort().reverse().map(v => path.join(versions, v, 'support')).filter(d => fs.existsSync(d));
  } catch { return []; }
}
