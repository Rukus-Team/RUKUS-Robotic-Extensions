/**
 * The linter's shared vocabulary. Pure - no vscode - so the same findings come out of the
 * editor, the "Lint Folder" command and the robot-lint command line.
 *
 * A brand's checks produce LintFindings; a .robotlint.json (config.ts) then turns rules off
 * or changes their severity; the front end only converts what is left.
 */
import type { Span } from '../span';

export type LintSeverity = 'error' | 'warning' | 'info' | 'hint';
export const LINT_SEVERITIES: readonly LintSeverity[] = ['error', 'warning', 'info', 'hint'];

export interface LintRelated { span: Span; message: string }

export interface LintFinding {
  /** the rule, e.g. `tp.undefinedLabel`, `karel.lint.lockGroup`, `rapid.style.routineLength` */
  code: string;
  message: string;
  severity: LintSeverity;
  span: Span;
  related?: LintRelated[];
  /** dead code (unused label, unused variable): editors fade it */
  unnecessary?: boolean;
  /** extra data a quick fix needs (e.g. the controller's comment) */
  data?: unknown;
}

/**
 * One rule. `check` rules say the controller (or the compiler) will refuse or misbehave and
 * are on by default; `style` rules are house rules - most are on as hints, the opinionated
 * ones are off until a .robotlint.json turns them on.
 */
export interface LintRule {
  code: string;
  /** language id: fanuc-tp, fanuc-karel, abb-rapid */
  language: string;
  kind: 'check' | 'style';
  /** 'off' = only runs when a config turns it on; otherwise the severity it reports at */
  defaultSeverity: LintSeverity | 'off';
  description: string;
  /** options the rule reads, with their defaults (shown in --rules and the JSON schema) */
  options?: Record<string, number | string | boolean | string[]>;
}

/** What a check needs to ask about the rules while it runs. */
export interface LintSettings {
  /** is the rule on at all (config, else its default)? Checks skip work for a rule that is off. */
  enabled(code: string): boolean;
  /** a rule option from the config, else the rule's default, else `fallback` */
  option<T>(code: string, key: string, fallback: T): T;
}

/** Every rule on, every option at its default: what a check sees with no config at all. */
export const DEFAULT_SETTINGS: LintSettings = {
  enabled: code => lintRule(code)?.defaultSeverity !== 'off',
  option: <T>(code: string, key: string, fallback: T) => (lintRule(code)?.options?.[key] as T | undefined) ?? fallback,
};

// ---------------------------------------------------------------------------
// the rule catalog: every brand adds its rules at load time

const rules = new Map<string, LintRule>();

export function defineLintRules(list: readonly LintRule[]): void {
  for (const r of list) rules.set(r.code, r);
}

export function lintRule(code: string): LintRule | undefined { return rules.get(code); }

export function lintRules(language?: string): LintRule[] {
  return [...rules.values()].filter(r => !language || r.language === language).sort((a, b) => a.code.localeCompare(b.code));
}

/** span of a whole line, for findings about a line rather than a token in it */
export function lineSpan(lines: readonly string[], line: number): Span {
  const l = Math.max(0, Math.min(line, lines.length - 1));
  return { line: l, col: 0, len: (lines[l] ?? '').length };
}
