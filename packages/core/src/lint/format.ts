/**
 * A lint run as text: the plain listing (one line per finding, `file:line:col` so terminals
 * and editors make them links), JSON for scripts, and SARIF 2.1.0 for code-scanning tools.
 */
import * as path from 'node:path';
import { lintTotals, type LintRun } from './engine';
import { lintRule, lintRules, LINT_SEVERITIES, type LintRule } from './types';

export function formatLintText(run: LintRun, opts: { base?: string; minSeverity?: 'error' | 'warning' | 'info' | 'hint' } = {}): string {
  const rank = (s: string) => LINT_SEVERITIES.indexOf(s as never);
  const limit = rank(opts.minSeverity ?? 'hint');
  const lines: string[] = [];
  for (const c of run.configs) for (const p of c.problems) lines.push(`${c.file}: config: ${p}`);
  for (const f of run.files) {
    const shown = f.findings.filter(x => rank(x.severity) <= limit).sort((a, b) => a.span.line - b.span.line || a.span.col - b.span.col);
    if (!shown.length) continue;
    const name = opts.base ? path.relative(opts.base, f.path) || f.path : f.path;
    for (const x of shown) lines.push(`${name}:${x.span.line + 1}:${x.span.col + 1}: ${x.severity} ${x.code}: ${x.message}`);
  }
  for (const u of run.unreadable) lines.push(`${u.path}: cannot read: ${u.error}`);
  lines.push(lintSummary(run));
  return lines.join('\n');
}

/** "12 files linted: 1 error, 3 warnings, 0 info, 5 hints" */
export function lintSummary(run: LintRun): string {
  const t = lintTotals(run);
  return `${t.files} file${t.files === 1 ? '' : 's'} linted${run.ignored ? ` (${run.ignored} ignored)` : ''}: ${t.error} error${t.error === 1 ? '' : 's'}, ${t.warning} warning${t.warning === 1 ? '' : 's'}, ${t.info} info, ${t.hint} hint${t.hint === 1 ? '' : 's'}`;
}

export function formatLintJson(run: LintRun): string {
  return JSON.stringify({
    totals: lintTotals(run),
    configs: run.configs.map(c => ({ file: c.file, problems: c.problems })),
    unreadable: run.unreadable,
    files: run.files.filter(f => f.findings.length).map(f => ({
      path: f.path, language: f.language,
      findings: f.findings.map(x => ({ code: x.code, severity: x.severity, message: x.message, line: x.span.line + 1, column: x.span.col + 1, length: x.span.len })),
    })),
  }, null, 2);
}

export function formatLintSarif(run: LintRun, tool: { name: string; version: string; uri?: string }): string {
  const used = [...new Set(run.files.flatMap(f => f.findings.map(x => x.code)))].sort();
  const level = (s: string) => (s === 'error' ? 'error' : s === 'warning' ? 'warning' : 'note');
  return JSON.stringify({
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [{
      tool: { driver: { name: tool.name, version: tool.version, informationUri: tool.uri, rules: used.map(code => ({ id: code, shortDescription: { text: lintRule(code)?.description ?? code } })) } },
      results: run.files.flatMap(f => f.findings.map(x => ({
        ruleId: x.code,
        level: level(x.severity),
        message: { text: x.message },
        locations: [{ physicalLocation: { artifactLocation: { uri: 'file:///' + f.path.replace(/\\/g, '/').replace(/^\//, '') }, region: { startLine: x.span.line + 1, startColumn: x.span.col + 1, endColumn: x.span.col + 1 + Math.max(x.span.len, 0) } } }],
      }))),
    }],
  }, null, 2);
}

/** The rule list, for `robot-lint --rules` and the docs. */
export function formatLintRules(language?: string): string {
  const rows = lintRules(language);
  const byLang = new Map<string, LintRule[]>();
  for (const r of rows) { const l = byLang.get(r.language) ?? []; l.push(r); byLang.set(r.language, l); }
  const out: string[] = [];
  for (const [lang, list] of byLang) {
    out.push(`${lang}:`);
    for (const r of list) {
      const opts = r.options ? `  {${Object.entries(r.options).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(', ')}}` : '';
      out.push(`  ${r.code.padEnd(36)} ${r.kind.padEnd(5)} ${r.defaultSeverity.padEnd(7)} ${r.description}${opts}`);
    }
  }
  return out.join('\n');
}

/** JSON schema for .robotlint.json: rule names complete in the editor. */
export function lintConfigSchema(): object {
  const sev = { enum: ['off', 'error', 'warning', 'info', 'hint'] };
  const props: Record<string, object> = {};
  for (const r of lintRules()) {
    const optProps = Object.fromEntries(Object.entries(r.options ?? {}).map(([k, v]) => [k, { type: Array.isArray(v) ? 'array' : typeof v, default: v }]));
    props[r.code] = {
      description: `${r.description} (${r.kind}, default ${r.defaultSeverity})`,
      anyOf: [sev, { type: 'array', items: [sev, { type: 'object', properties: optProps, additionalProperties: false }], minItems: 1, maxItems: 2 }],
    };
  }
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: 'RUKUS lint configuration',
    type: 'object',
    properties: {
      $schema: { type: 'string' },
      rules: {
        type: 'object',
        description: 'Rule code (or a prefix ending in .*) -> off / error / warning / info / hint, or [severity, { options }].',
        properties: props,
        additionalProperties: { anyOf: [sev, { type: 'array', minItems: 1, maxItems: 2 }] },
      },
      ignore: { type: 'array', items: { type: 'string' }, description: 'Glob patterns of files not to lint, relative to this file. A pattern without / matches the file name anywhere.' },
    },
    additionalProperties: false,
  };
}
