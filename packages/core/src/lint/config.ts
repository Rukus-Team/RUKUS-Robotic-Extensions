/**
 * .robotlint.json: which rules run, at what severity, with what options, and which files
 * are not linted at all. Pure (node fs only); the editor and the command line share it.
 *
 *   {
 *     "rules": {
 *       "tp.unusedLabel": "off",
 *       "tp.style.*": "info",
 *       "rapid.style.routineLength": ["warning", { "max": 150 }]
 *     },
 *     "ignore": ["**\/old/**", "*_bak.ls"]
 *   }
 *
 * A rule key is a code, or a prefix ending in `.*` (`*` alone is every rule). The exact
 * code wins over a prefix, and a longer prefix over a shorter one. The nearest
 * .robotlint.json above a file applies; there is no merging between folders.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { LINT_SEVERITIES, lintRule, type LintFinding, type LintSettings, type LintSeverity } from './types';

export const LINT_CONFIG_FILE = '.robotlint.json';

export type RuleSetting = LintSeverity | 'off' | [LintSeverity | 'off', Record<string, unknown>?];

export interface LintConfig {
  /** where it was read from; undefined = the built-in defaults */
  file?: string;
  rules: Record<string, RuleSetting>;
  ignore: string[];
  /** problems in the file itself, reported by the front end */
  problems: string[];
}

export const EMPTY_CONFIG: LintConfig = { rules: {}, ignore: [], problems: [] };

/** Parse a .robotlint.json's text. Never throws: a bad file is reported and ignored in parts. */
export function parseLintConfig(text: string, file?: string): LintConfig {
  const cfg: LintConfig = { file, rules: {}, ignore: [], problems: [] };
  let raw: any;
  try { raw = JSON.parse(stripJsonComments(text)); } catch (e: any) { cfg.problems.push(`not valid JSON: ${e?.message ?? e}`); return cfg; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { cfg.problems.push('expected an object with "rules" and/or "ignore"'); return cfg; }
  if (raw.rules !== undefined) {
    if (typeof raw.rules !== 'object' || Array.isArray(raw.rules)) cfg.problems.push('"rules" must be an object');
    else for (const [k, v] of Object.entries(raw.rules)) {
      const sev = Array.isArray(v) ? v[0] : v;
      if (sev !== 'off' && !LINT_SEVERITIES.includes(sev as LintSeverity)) { cfg.problems.push(`rule "${k}": "${String(sev)}" is not off/error/warning/info/hint`); continue; }
      if (Array.isArray(v) && v[1] !== undefined && (typeof v[1] !== 'object' || Array.isArray(v[1]))) { cfg.problems.push(`rule "${k}": options must be an object`); continue; }
      if (!k.endsWith('*') && !lintRule(k)) cfg.problems.push(`rule "${k}" is not a known rule (robot-lint --rules lists them)`);
      cfg.rules[k] = v as RuleSetting;
    }
  }
  if (raw.ignore !== undefined) {
    if (!Array.isArray(raw.ignore) || raw.ignore.some((x: unknown) => typeof x !== 'string')) cfg.problems.push('"ignore" must be a list of glob patterns');
    else cfg.ignore = raw.ignore;
  }
  return cfg;
}

/** JSON with // and /* comments, as VS Code's own settings files allow */
function stripJsonComments(text: string): string {
  return text.replace(/^﻿/, '').replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, str) => str ?? '');
}

/** The setting that applies to one code: exact, else the longest matching `prefix.*`, else `*`. */
export function ruleSetting(cfg: LintConfig, code: string): RuleSetting | undefined {
  if (cfg.rules[code] !== undefined) return cfg.rules[code];
  let best: string | undefined;
  for (const k of Object.keys(cfg.rules)) {
    if (!k.endsWith('*')) continue;
    const prefix = k.slice(0, -1);
    if (code.startsWith(prefix) && (!best || prefix.length > best.length - 1)) best = k;
  }
  return best ? cfg.rules[best] : undefined;
}

const severityOf = (s: RuleSetting | undefined) => (Array.isArray(s) ? s[0] : s);

export function settingsFor(cfg: LintConfig): LintSettings {
  return {
    enabled(code) {
      const s = severityOf(ruleSetting(cfg, code));
      if (s !== undefined) return s !== 'off';
      return lintRule(code)?.defaultSeverity !== 'off';
    },
    option<T>(code: string, key: string, fallback: T): T {
      const s = ruleSetting(cfg, code);
      const opts = Array.isArray(s) ? s[1] : undefined;
      if (opts && key in opts) return opts[key] as T;
      return (lintRule(code)?.options?.[key] as T | undefined) ?? fallback;
    },
  };
}

/**
 * The config's last word on what a check found: rules turned off are dropped, a severity
 * set in the config replaces the finding's own. A style rule that is off by default and
 * still reached here (a check that does not ask `enabled`) is dropped as well.
 */
export function applyLintConfig(findings: LintFinding[], cfg: LintConfig): LintFinding[] {
  const out: LintFinding[] = [];
  for (const f of findings) {
    const s = severityOf(ruleSetting(cfg, f.code));
    if (s === 'off') continue;
    if (s === undefined && lintRule(f.code)?.defaultSeverity === 'off') continue;
    out.push(s ? { ...f, severity: s } : f);
  }
  return out;
}

// ---------------------------------------------------------------------------
// finding the config, and ignore globs

/** The nearest .robotlint.json at or above `dir`, cached per folder (pass a cache to share). */
export function findLintConfig(dir: string, cache: Map<string, LintConfig> = new Map()): LintConfig {
  const seen: string[] = [];
  let d = path.resolve(dir);
  let found: LintConfig | undefined;
  for (;;) {
    const hit = cache.get(d);
    if (hit) { found = hit; break; }
    seen.push(d);
    const f = path.join(d, LINT_CONFIG_FILE);
    let text: string | undefined;
    try { text = fs.readFileSync(f, 'utf8'); } catch { /* none here */ }
    if (text !== undefined) { found = parseLintConfig(text, f); break; }
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  const cfg = found ?? EMPTY_CONFIG;
  for (const s of seen) cache.set(s, cfg);
  return cfg;
}

export function readLintConfigFile(file: string): LintConfig {
  try { return parseLintConfig(fs.readFileSync(file, 'utf8'), path.resolve(file)); }
  catch (e: any) { return { ...EMPTY_CONFIG, file, problems: [`cannot read: ${e?.message ?? e}`] }; }
}

/** `**` any folders, `*` within one name, `?` one character; a pattern without `/` matches the file name anywhere. */
export function globToRegExp(glob: string): RegExp {
  let g = glob.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!g.includes('/')) g = `**/${g}`;
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') { re += g[i + 2] === '/' ? '(?:.*/)?' : '.*'; i += g[i + 2] === '/' ? 2 : 1; }
    else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}(?:/.*)?$`, 'i');
}

/** Is `file` ignored by the config? Patterns are relative to the config file's folder. */
export function isLintIgnored(cfg: LintConfig, file: string): boolean {
  if (!cfg.ignore.length) return false;
  const base = cfg.file ? path.dirname(cfg.file) : undefined;
  const rel = (base ? path.relative(base, file) : path.basename(file)).replace(/\\/g, '/');
  return cfg.ignore.some(g => globToRegExp(g).test(rel));
}

/** plain JSON (the editor would flag comments in a .json file); the schema documents every rule */
export const LINT_STARTER_CONFIG = `{
  "rules": {
    "tp.style.waitTimeout": "hint",
    "tp.style.programLength": ["off", { "max": 500 }],
    "karel.style.routineLength": ["off", { "max": 200 }],
    "rapid.style.waitTimeout": "hint",
    "rapid.style.routineLength": ["off", { "max": 200 }]
  },
  "ignore": []
}
`;
