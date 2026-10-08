/**
 * Lint files on disk: a folder, a backup, a list of files. Pure (node fs only) and
 * brand-free - each brand registers a LintLanguage, which decides how its files belong
 * together (TP programs of one folder call each other, RAPID modules of one task share
 * their routines) and runs its checks.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { LintFinding, LintSettings } from './types';
import { applyLintConfig, findLintConfig, isLintIgnored, settingsFor, type LintConfig } from './config';

export interface LintFile { path: string; text: string }

export interface LintLanguage {
  /** language id: fanuc-tp, fanuc-karel, abb-rapid */
  id: string;
  label: string;
  /** lower case, with the dot */
  extensions: readonly string[];
  /** read the file (FANUC and IRC5 files are Latin-1) */
  encoding?: BufferEncoding;
  /**
   * Lint a group of this language's files found together. Cross-file rules see the whole
   * group: a call to a program that is not in it is "missing". Returns findings per path.
   */
  lintGroup(files: LintFile[], settingsOf: (file: string) => LintSettings): Map<string, LintFinding[]>;
}

const languages: LintLanguage[] = [];

export function registerLintLanguage(lang: LintLanguage): void {
  const i = languages.findIndex(l => l.id === lang.id);
  if (i >= 0) languages[i] = lang; else languages.push(lang);
}

export function lintLanguages(): readonly LintLanguage[] { return languages; }

export function lintLanguageFor(file: string): LintLanguage | undefined {
  const ext = path.extname(file).toLowerCase();
  return languages.find(l => l.extensions.includes(ext));
}

export interface LintedFile { path: string; language: string; findings: LintFinding[] }

export interface LintRun {
  files: LintedFile[];
  /** every .robotlint.json that was used, with its problems */
  configs: LintConfig[];
  /** files that could not be read */
  unreadable: { path: string; error: string }[];
  ignored: number;
}

export interface LintOptions {
  /** one config for every file (robot-lint --config); otherwise the nearest .robotlint.json */
  config?: LintConfig;
  /** folders not walked into */
  skipDirs?: ReadonlySet<string>;
}

const SKIP = new Set(['node_modules', '.git', '.svn', '.hg', '.vscode', '.vscode-test', 'dist', 'out']);

/** Every lintable file under the given paths (files are taken as given if a language knows them). */
export function collectLintFiles(paths: readonly string[], skipDirs: ReadonlySet<string> = SKIP): string[] {
  const out = new Set<string>();
  const walk = (p: string) => {
    let st: fs.Stats;
    try { st = fs.statSync(p); } catch { return; }
    if (st.isDirectory()) {
      let names: string[];
      try { names = fs.readdirSync(p); } catch { return; }
      for (const n of names.sort()) {
        if (skipDirs.has(n.toLowerCase())) continue;
        walk(path.join(p, n));
      }
    } else if (lintLanguageFor(p)) out.add(path.resolve(p));
  };
  for (const p of paths) walk(p);
  return [...out];
}

/** Lint everything under `paths`. Files of one language in one folder are linted as a group. */
export function lintPaths(paths: readonly string[], opts: LintOptions = {}): LintRun {
  const files = collectLintFiles(paths, opts.skipDirs ?? SKIP);
  const cache = new Map<string, LintConfig>();
  const configOf = (f: string) => opts.config ?? findLintConfig(path.dirname(f), cache);
  const run: LintRun = { files: [], configs: [], unreadable: [], ignored: 0 };

  // group by language + folder; a language that wants a wider group (RAPID tasks) gets
  // the whole set of its files at once and sorts them out itself
  const byLang = new Map<LintLanguage, LintFile[]>();
  for (const f of files) {
    if (isLintIgnored(configOf(f), f)) { run.ignored++; continue; }
    const lang = lintLanguageFor(f)!;
    let text: string;
    try { text = fs.readFileSync(f, lang.encoding ?? 'latin1'); } catch (e: any) { run.unreadable.push({ path: f, error: e?.message ?? String(e) }); continue; }
    const list = byLang.get(lang) ?? [];
    list.push({ path: f, text });
    byLang.set(lang, list);
  }
  for (const [lang, list] of byLang) {
    const found = lang.lintGroup(list, f => settingsFor(configOf(f)));
    for (const f of list) {
      run.files.push({ path: f.path, language: lang.id, findings: applyLintConfig(found.get(f.path) ?? [], configOf(f.path)) });
    }
  }
  run.files.sort((a, b) => a.path.localeCompare(b.path));
  run.configs = [...new Set(files.map(configOf))].filter(c => c.file);
  return run;
}

/** Findings of a run counted by severity. */
export function lintTotals(run: LintRun): Record<'error' | 'warning' | 'info' | 'hint' | 'files' | 'filesWithFindings', number> {
  const t = { error: 0, warning: 0, info: 0, hint: 0, files: run.files.length, filesWithFindings: 0 };
  for (const f of run.files) {
    if (f.findings.length) t.filesWithFindings++;
    for (const x of f.findings) t[x.severity]++;
  }
  return t;
}

/** group files by folder: the default grouping for languages whose cross-file rules are per folder */
export function groupByFolder(files: LintFile[]): LintFile[][] {
  const m = new Map<string, LintFile[]>();
  for (const f of files) {
    const k = path.dirname(f.path).toLowerCase();
    const l = m.get(k) ?? [];
    l.push(f); m.set(k, l);
  }
  return [...m.values()];
}
