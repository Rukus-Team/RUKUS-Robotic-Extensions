/**
 * Every KAREL source check, without vscode: the parser's findings, name lengths, unused and
 * undeclared names, %ENVIRONMENT, the lint (lint.ts), the file name, and the style rules. The
 * editor (providers.ts), Lint Folder and robot-lint all run this; what only the editor knows
 * (settings, the robot.ini's core version) comes in through KarelCheckEnv.
 */
import * as path from 'node:path';
import { findUnused, findUndeclared, resolveSymbol, type KProgram } from './parser';
import { KAREL_BUILTINS, KAREL_PREDEFINED } from './builtins';
import { lintKarel, identifierLengthIssues, karelNameLimits, type KarelNameLimits } from './lint';
import { missingEnvironment } from './environment';
import { includedNames } from './includes';
import { karelStyleChecks } from './style';
import { DEFAULT_SETTINGS, type LintFinding, type LintSettings } from '@core/lint/types';

export interface KarelCheckEnv {
  settings?: LintSettings;
  /** robotCode.karel.<key> in the editor; the default everywhere else */
  setting?<T>(key: string, fallback: T): T;
  nameLimits?: KarelNameLimits;
  /** the file on disk: the program name must match it, and %INCLUDEs are looked up beside it */
  fsPath?: string;
  /** ktrans support folders, for %INCLUDE files that are not beside the program */
  supportDirs?: readonly string[];
}

export function karelChecks(prog: KProgram, env: KarelCheckEnv = {}): LintFinding[] {
  const settings = env.settings ?? DEFAULT_SETTINGS;
  const setting = <T>(key: string, fallback: T): T => (env.setting ? env.setting(key, fallback) : fallback);
  const out: LintFinding[] = [];
  const add = (f: LintFinding) => { if (settings.enabled(f.code)) out.push(f); };

  for (const d of prog.diagnostics) add({ code: d.code, message: d.message, severity: d.severity, span: d.span });
  if (prog.compiled) return out;
  if (setting('karel.diagnostics.identifierLength', true)) {
    for (const d of identifierLengthIssues(prog, env.nameLimits ?? karelNameLimits('V9'))) add({ code: d.code, message: d.message, severity: d.severity, span: d.span });
  }
  if (setting('karel.diagnostics.unusedVariables', true) && prog.name) {
    for (const u of findUnused(prog)) {
      if (u.span.len === 0) continue;
      add({ code: 'karel.unused', message: `${u.kind} "${u.name}" is never used.`, severity: 'hint', span: u.span, unnecessary: true });
    }
  }
  // Used but never declared. ktrans does NOT report this (checked against KTRANS
  // V9.40-1), so a mistyped name translates clean and goes wrong on the robot — which
  // makes it one of the few checks here that beats the official compiler rather than
  // repeating it. findUndeclared declines to answer for anything it cannot see all of.
  if (setting('karel.diagnostics.undeclared', true) && settings.enabled('karel.undeclared')) {
    const included = prog.includes.length && env.fsPath ? includedNames(prog, path.dirname(env.fsPath), env.supportDirs ?? []) : undefined;
    for (const u of findUndeclared(prog, up => KAREL_BUILTINS.has(up) || KAREL_PREDEFINED.has(up), included)) {
      add({ code: 'karel.undeclared', severity: 'warning', span: u.span, message: `"${prog.lines[u.line]?.slice(u.span.col, u.span.col + u.span.len) ?? u.upper}" is used but never declared. ktrans does not report this — it translates and then misbehaves on the robot.` });
    }
  }
  // A built-in from a group ktrans loads only with %ENVIRONMENT (environment.ts): without the
  // directive ktrans stops at "Id must be defined"; the editor's quick fix adds it to the header.
  const envMode = setting<string>('karel.diagnostics.environment', 'needed');
  if (envMode !== 'off' && prog.name) {
    for (const m of missingEnvironment(prog, (up, line) => !!resolveSymbol(prog, up, line), envMode === 'all')) {
      add(m.needed
        ? { code: 'karel.environment', severity: 'warning', span: m.span, message: `${m.upper} needs %ENVIRONMENT ${m.group} in the program header; without it ktrans reports "Id must be defined". ktrans also needs the option's ${m.group.toLowerCase()}.ev in the support folder its robot.ini names.` }
        : { code: 'karel.environment', severity: 'info', span: m.span, message: `${m.upper} belongs to %ENVIRONMENT ${m.group}, which is not in the header. ktrans loads this group by itself, so it translates either way.` });
    }
  }
  // The lint: what ktrans refuses and what it lets through (lint.ts). One rule can be
  // switched off by its code in robotCode.karel.diagnostics.lintIgnore, or in .robotlint.json.
  if (setting('karel.diagnostics.lint', true)) {
    const ignore = new Set(setting<string[]>('karel.diagnostics.lintIgnore', []).map(x => x.trim()));
    for (const d of lintKarel(prog)) {
      if (ignore.has(d.code) || ignore.has(d.code.replace(/^karel\.lint\./, ''))) continue;
      add({ code: d.code, message: d.message, severity: d.severity, span: d.span });
    }
  }
  if (prog.name && prog.nameSpan && env.fsPath) {
    const file = path.basename(env.fsPath).replace(/\.[^.]+$/, '');
    if (file.toUpperCase() !== prog.name.toUpperCase()) add({ code: 'karel.fileName', severity: 'warning', span: prog.nameSpan, message: `Program name "${prog.name}" differs from file name "${file}"; the controller loads ${prog.name}.pc and expects the file to match.` });
  }
  out.push(...karelStyleChecks(prog, settings));
  return out;
}
