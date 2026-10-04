/**
 * FANUC as a {@link RobotBrand}: which files are FANUC programs, how one is indexed, and what
 * a FANUC controller backup looks like. Moved out of core's workspaceIndex.ts and
 * robotContainers.ts in monorepo phase 2, unchanged in behaviour.
 */
import * as path from 'node:path';
import type { RobotBrand, ProgramFacts } from '@core/brand';
import { normalizeAndHash } from '@core/robotContainers';
import { parseTp } from './tp/parser';
import { usageFindings, accessOfRef } from './tools/xref';
import { KNOWN_VA_FILES } from './data/vaParser';

const KNOWN_VA = new Set<string>(KNOWN_VA_FILES);

export const fanucBrand: RobotBrand = {
  id: 'fanuc',
  label: 'FANUC',
  programExtensions: ['ls', 'kl', 'pc', 'tp'],
  languageIds: ['fanuc-tp', 'fanuc-karel'],

  /** compiled KAREL (.pc) or compiled TP (.tp): a program with no source to read */
  isBinaryProgram: fsPath => /\.(pc|tp)$/i.test(fsPath),

  indexProgram(fsPath: string, text: string): ProgramFacts | undefined {
    const ext = path.extname(fsPath).toLowerCase();
    if (ext === '.pc' || ext === '.tp') {
      // The controller loads NAME.PC / NAME.TP, so the file name IS the program name. That is
      // all there is to know from the outside, and it is enough for CALL X to resolve.
      const name = path.basename(fsPath, path.extname(fsPath)).toUpperCase();
      if (!/^[A-Z0-9_\-]+$/.test(name)) return undefined;
      return { name, programType: ext === '.pc' ? 'KAREL (compiled .pc)' : 'TP (compiled .tp)', lineCount: 0, labels: 0, positions: 0, calls: [], macros: [], inlineComments: new Map(), dataAccess: new Map(), rawTokens: 0, kind: 'binary' };
    }
    if (ext === '.kl') {
      const m = /^\s*PROGRAM\s+([A-Za-z_][A-Za-z0-9_]*)/mi.exec(text);
      if (!m) return undefined;
      const c = /^\s*%COMMENT\s*=\s*'([^']*)'/mi.exec(text);
      const nh = normalizeAndHash(text, 'karel');
      return { name: m[1].toUpperCase(), comment: c?.[1], programType: 'KAREL', lineCount: text.split(/\r?\n/).length, labels: 0, positions: 0, calls: [], macros: [], inlineComments: new Map(), dataAccess: new Map(), rawTokens: 0, kind: 'karel', textHash: nh.hash, normText: nh.norm };
    }
    if (!/^\/PROG\b/m.test(text)) return undefined; // alarm logs etc. share the .ls extension
    const prog = parseTp(text);
    const name = (prog.header.name ?? path.basename(fsPath, ext)).toUpperCase();
    const comment = prog.header.attrs.get('COMMENT')?.value.replace(/^"|"$/g, '');
    const inline = new Map<string, string>();
    const access = new Map<string, 'w' | 'r'>();
    for (const r of prog.dataRefs) {
      if (r.comment) inline.set(`${r.kind}:${r.index}`, r.comment);
      if (r.kind === 'AR' || r.kind === 'GP') continue;
      const key = `${r.kind}:${r.index}`;
      // A program that writes a register anywhere counts as a writer, whatever else it does
      // with it, so a single 'w' is never downgraded by a later read.
      if (access.get(key) === 'w') continue;
      access.set(key, accessOfRef(prog, r) === 'write' ? 'w' : 'r');
    }
    const nh = normalizeAndHash(text, 'tp');
    return {
      name, comment: comment || undefined, programType: prog.header.programType,
      lineCount: prog.numberedLineCount, labels: prog.labels.length, positions: prog.positions.length,
      calls: [...new Set(prog.calls.map(c => c.name.toUpperCase()))],
      macros: [...new Set(prog.macros.map(m => m.name))],
      inlineComments: inline, dataAccess: access, rawTokens: prog.dataRefs.filter(r => r.extra?.length).length, kind: 'tp',
      textHash: nh.hash, normText: nh.norm,
    };
  },

  programLine: (text, n) => /^\/PROG\b/m.test(text) ? parseTp(text).lines.find(l => l.num === n)?.line : undefined,

  /** register/I-O findings are about TP programs; KAREL and binaries carry no access map */
  usageFindings: programs => usageFindings(programs.filter(p => p.kind === 'tp')),

  /**
   * A folder HOLDS a FANUC backup at its top level when it has one of the .va dumps the
   * extension reads, or the controller's binary system files. Working program folders hold
   * .ls and .kl and none of these.
   */
  looksLikeBackup: names => [...names].some(l => KNOWN_VA.has(l) || /^(sysvars|sysmast|sysmacro|sysframe|sysservo)\.(sv|va)$/.test(l) || l === 'summary.dg' || l === 'backdate.dt'),

  /** the data and I/O files a snapshot fetch pulls on its own (moved from core's robotContainers) */
  isDataFile: n => /\.io$/.test(n) || n === 'iostate.dg' || KNOWN_VA.has(n)
    || /^(sysvars|sysmast|sysservo|sysmotion)\.(va|sv)$/.test(n) || /^dcs[a-z0-9_]*\.(va|sv)$/.test(n),
};
