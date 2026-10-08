/**
 * ABB as a {@link RobotBrand}. What the workspace index keeps per RAPID file: the module is
 * the unit (one file, one MODULE), its routines are what other code calls, and its taught
 * points are the robtarget/jointtarget data it declares.
 *
 * Registered only while `robotCode.abb.enabled` is on (see src/extension.ts); the tests
 * register it themselves.
 */
import * as path from 'node:path';
import type { RobotBrand, ProgramFacts } from '@core/brand';
import { parseRapid, looksEncrypted } from './rapid/parser';
import { RAPID_INSTRUCTIONS } from './rapid/builtins';

/** `.sys` is also the Windows driver extension: only text that opens like a RAPID module is one. */
const LOOKS_LIKE_RAPID = /^\s*(%%%|MODULE\s+\w+)/im;

export const abbBrand: RobotBrand = {
  id: 'abb',
  label: 'ABB',
  programExtensions: ['mod', 'prg', 'sys'],
  languageIds: ['abb-rapid'],

  indexProgram(fsPath: string, text: string): ProgramFacts | undefined {
    const ext = path.extname(fsPath).toLowerCase();
    // About 45% of the system modules in a real backup are encrypted (SpotWare, site
    // libraries). They are real modules the controller runs, but there is nothing to read.
    if (looksEncrypted(text)) {
      return {
        name: path.basename(fsPath, path.extname(fsPath)).toUpperCase(), programType: 'RAPID module (encrypted)',
        lineCount: 0, labels: 0, positions: 0, calls: [], macros: [], inlineComments: new Map(), dataAccess: new Map(), rawTokens: 0, kind: 'rapid-encrypted',
      };
    }
    if (!LOOKS_LIKE_RAPID.test(text)) return undefined;
    const mod = parseRapid(text);
    if (!mod.name) return undefined;
    const system = ext === '.sys' || mod.attributes.some(a => a.toUpperCase() === 'SYSMODULE');
    const access = new Map<string, 'w' | 'r'>();
    for (const r of mod.refs) {
      const key = `DATA:${r.name.toUpperCase()}`;
      if (access.get(key) === 'w') continue;
      access.set(key, r.write ? 'w' : 'r');
    }
    const points = mod.data.filter(d => /^(robtarget|jointtarget)$/i.test(d.type)).length
      + mod.routines.reduce((n, r) => n + r.data.filter(d => /^(robtarget|jointtarget)$/i.test(d.type)).length, 0);
    return {
      name: mod.name.toUpperCase(),
      programType: system ? 'RAPID system module' : 'RAPID program module',
      lineCount: text.split(/\r?\n/).length,
      labels: mod.routines.reduce((n, r) => n + r.labels.length, 0),
      positions: points,
      // routines of the task, not RobotWare's own instructions (MoveJ, TPWrite, SpotL ...)
      calls: [...new Set(mod.calls.filter(c => c.kind === 'proc' && c.name && !RAPID_INSTRUCTIONS.has(c.name.toUpperCase())).map(c => c.name!.toUpperCase()))],
      macros: [],
      inlineComments: new Map(),
      dataAccess: access,
      rawTokens: 0,
      kind: 'rapid',
    };
  },

  /**
   * An IRC5 backup: BACKINFO/ next to RAPID/ or SYSPAR/ (the controller writes all three, plus
   * HOME/ and system.xml). The names arrive lower-cased.
   */
  looksLikeBackup: names => names.has('backinfo') && (names.has('rapid') || names.has('syspar')),
};
