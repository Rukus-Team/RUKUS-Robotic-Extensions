/**
 * robot-lint - the extension's linter from a command line: FANUC TP (.ls), KAREL (.kl) and
 * ABB RAPID (.mod/.sys/.prg) under any folders or backups, with the same checks and the same
 * .robotlint.json as the editor. For CI, RUKUS, or a quick look at a backup.
 *
 *   node robot-lint.js [paths...] [options]        (default: the current folder)
 *
 *   --config <file>        use this config for every file (default: nearest .robotlint.json)
 *   --format text|json|sarif
 *   --output <file>        write the report to a file instead of the terminal
 *   --quiet                list errors only (the totals still count everything)
 *   --max-warnings <n>     also fail when there are more than n warnings
 *   --rules [language]     list every rule (fanuc-tp, fanuc-karel, abb-rapid)
 *   --schema               print the JSON schema of .robotlint.json
 *   --init                 write a starter .robotlint.json in the current folder
 *
 * Exit code 0 = no errors, 1 = errors (or warnings over --max-warnings), 2 = could not run.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { lintPaths, lintTotals } from '@core/lint/engine';
import { readLintConfigFile, LINT_CONFIG_FILE, LINT_STARTER_CONFIG } from '@core/lint/config';
import { formatLintText, formatLintJson, formatLintSarif, formatLintRules, lintConfigSchema, lintSummary } from '@core/lint/format';
import { registerFanucLint } from '@fanuc/lint';
import { registerAbbLint } from '@abb/lint';

declare const ROBOT_CODE_VERSION: string;
const VERSION = typeof ROBOT_CODE_VERSION === 'string' ? ROBOT_CODE_VERSION : 'dev';

const USAGE = `robot-lint ${VERSION} - lint FANUC TP (.ls), KAREL (.kl) and ABB RAPID (.mod/.sys/.prg)

usage: robot-lint [paths...] [options]     (default path: the current folder)

  --config <file>        use this config for every file (default: nearest ${LINT_CONFIG_FILE})
  --format text|json|sarif
  --output <file>        write the report to a file
  --quiet                list errors only
  --max-warnings <n>     also fail when there are more than n warnings
  --rules [language]     list the rules (fanuc-tp, fanuc-karel, abb-rapid)
  --schema               print the JSON schema of ${LINT_CONFIG_FILE}
  --init                 write a starter ${LINT_CONFIG_FILE} in the current folder

exit code: 0 no errors, 1 errors (or warnings over --max-warnings), 2 could not run`;

export function main(argv: string[]): number {
  registerFanucLint();
  registerAbbLint();

  const paths: string[] = [];
  let format = 'text', output: string | undefined, configFile: string | undefined, quiet = false, maxWarnings = -1;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    switch (a) {
      case '-h': case '--help': console.log(USAGE); return 0;
      case '-v': case '--version': console.log(VERSION); return 0;
      case '--rules': {
        const lang = argv[i + 1] && !argv[i + 1].startsWith('-') ? argv[++i] : undefined;
        console.log(formatLintRules(lang));
        return 0;
      }
      case '--schema': console.log(JSON.stringify(lintConfigSchema(), null, 2)); return 0;
      case '--init': {
        const f = path.resolve(LINT_CONFIG_FILE);
        if (fs.existsSync(f)) { console.error(`robot-lint: ${f} already exists`); return 2; }
        fs.writeFileSync(f, LINT_STARTER_CONFIG);
        console.log(`wrote ${f}`);
        return 0;
      }
      case '--config': configFile = value(); break;
      case '--format': format = value(); break;
      case '--output': case '-o': output = value(); break;
      case '--quiet': case '-q': quiet = true; break;
      case '--max-warnings': maxWarnings = Number(value()); break;
      default:
        if (a.startsWith('-')) { console.error(`robot-lint: unknown option ${a}\n\n${USAGE}`); return 2; }
        paths.push(a);
    }
  }
  if (!['text', 'json', 'sarif'].includes(format)) { console.error(`robot-lint: --format is text, json or sarif, not "${format}"`); return 2; }
  if (!Number.isFinite(maxWarnings)) { console.error('robot-lint: --max-warnings needs a number'); return 2; }
  if (!paths.length) paths.push('.');
  for (const p of paths) if (!fs.existsSync(p)) { console.error(`robot-lint: ${p} does not exist`); return 2; }

  const config = configFile ? readLintConfigFile(configFile) : undefined;
  if (config?.problems.length && config.problems.some(p => p.startsWith('cannot read'))) { console.error(`robot-lint: ${configFile}: ${config.problems.join('; ')}`); return 2; }
  const run = lintPaths(paths, { config });
  if (config?.file) run.configs = [config];

  const base = paths.length === 1 && fs.statSync(paths[0]).isDirectory() ? path.resolve(paths[0]) : process.cwd();
  const report = format === 'json' ? formatLintJson(run)
    : format === 'sarif' ? formatLintSarif(run, { name: 'robot-lint', version: VERSION, uri: 'https://github.com/Rukus-Team/RUKUS-Robotic-Extensions' })
    : formatLintText(run, { base, minSeverity: quiet ? 'error' : 'hint' });
  if (output) fs.writeFileSync(output, report + '\n');
  else console.log(report);
  if (output) console.error(lintSummary(run));

  const t = lintTotals(run);
  if (t.error > 0) return 1;
  if (maxWarnings >= 0 && t.warning > maxWarnings) return 1;
  return 0;
}

