/**
 * FANUC's languages for the linter (core/lint/engine.ts): TP programs and KAREL sources on
 * disk, for Lint Folder and robot-lint. No vscode. The programs of one folder are one robot:
 * a CALL to a program that is not among them is reported (when the folder has more than one).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseTp } from './tp/parser';
import { tpChecks } from './tp/checks';
import { parseKarel } from './karel/parser';
import { karelChecks } from './karel/checks';
import { registerLintLanguage, groupByFolder } from '@core/lint/engine';
import type { LintFinding } from '@core/lint/types';

/** the program name a TP file declares, else its file name */
const tpName = (text: string, file: string) => (/^\/PROG\s+([A-Za-z0-9_-]+)/m.exec(text)?.[1] ?? path.basename(file).replace(/\.[^.]+$/, '')).toUpperCase();

const PROGRAM_FILE = /\.(ls|tp|pc|kl)$/i;

export function registerFanucLint(): void {
  registerLintLanguage({
    id: 'fanuc-tp',
    label: 'FANUC TP',
    extensions: ['.ls'],
    encoding: 'latin1',
    lintGroup(files, settingsOf) {
      const out = new Map<string, LintFinding[]>();
      for (const group of groupByFolder(files)) {
        // every program the robot has: a backup keeps most of them only as .tp/.pc, and KAREL programs are CALL targets too
        const names = new Set(group.map(f => tpName(f.text, f.path)));
        let listing: string[] = [];
        try { listing = fs.readdirSync(path.dirname(group[0].path)); } catch { /* the group's own names only */ }
        for (const n of listing) if (PROGRAM_FILE.test(n)) names.add(n.replace(/\.[^.]+$/, '').toUpperCase());
        const calls = group.length > 1 ? { resolve: (n: string) => (names.has(n.toUpperCase()) ? 'found' as const : 'missing' as const) } : undefined;
        for (const f of group) out.set(f.path, tpChecks(f.text, parseTp(f.text), { settings: settingsOf(f.path), calls }));
      }
      return out;
    },
  });
  registerLintLanguage({
    id: 'fanuc-karel',
    label: 'KAREL',
    extensions: ['.kl'],
    encoding: 'latin1',
    lintGroup(files, settingsOf) {
      return new Map(files.map(f => [f.path, karelChecks(parseKarel(f.text), { settings: settingsOf(f.path), fsPath: f.path })]));
    },
  });
}
