/**
 * The %ENVIRONMENT check without vscode (the editor, Lint Folder and robot-lint share it).
 */
import { KAREL_BUILTIN_DETAILS } from './karelReference';
import type { KProgram } from './parser';

/**
 * The %ENVIRONMENT groups ktrans does not load by itself. KTRANS V9.40-1 (WinOLPC) was asked for
 * every built-in, with and without the directive (2026-10-06): the core groups (REGOPE, SYSTEM,
 * PBCORE, UIF, FLBT ...) translate either way - their .ev files are in WinOLPC's support folder.
 * iRVision (CVIS), Data Transfer Between Robots (RPCC) and data monitoring (DAQ) are options: their
 * .ev comes with the option, so ktrans needs the directive AND a robot.ini pointing at a support
 * folder that has the file; without either it stops at "Id must be defined".
 */
export const ENV_NEEDS_DIRECTIVE = new Set(['CVIS', 'RPCC', 'DAQ']);

/**
 * Built-ins this program calls whose %ENVIRONMENT group it has not named: with `all`, every group;
 * else only those ktrans cannot load by itself. `needed` tells the two apart.
 */
export function missingEnvironment(prog: KProgram, isOwnName: (upper: string, line: number) => boolean, all = false): { upper: string; group: string; needed: boolean; span: KProgram['refs'][number]['span'] }[] {
  const named = new Set(prog.directives.filter(d => d.name === 'ENVIRONMENT').map(d => d.args.split(/\s+/)[0].toUpperCase()));
  const out: { upper: string; group: string; needed: boolean; span: KProgram['refs'][number]['span'] }[] = [];
  for (const r of prog.refs) {
    const group = KAREL_BUILTIN_DETAILS[r.upper]?.env;
    const needed = !!group && ENV_NEEDS_DIRECTIVE.has(group);
    if (!group || (!needed && !all) || named.has(group) || isOwnName(r.upper, r.line)) continue;
    out.push({ upper: r.upper, group, needed, span: r.span });
  }
  return out;
}
