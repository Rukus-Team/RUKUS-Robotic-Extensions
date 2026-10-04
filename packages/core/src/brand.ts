/**
 * What core needs from a robot brand, and the registry the brands put themselves in.
 *
 * Core knows robots, cells, backups, controllers and programs - not TP, KAREL or RAPID. Every
 * place core used to call a FANUC parser directly now asks the brand that owns the file
 * instead. The extension registers each brand at activation; the tests register the ones
 * they exercise. Pure: no vscode import, so the containers module and the tests can use it.
 */

/**
 * What kind of program an indexed file is. FANUC has 'tp', 'karel' and 'binary' (a compiled
 * .pc/.tp with no source); another brand adds its own. Typed as an open string so core never
 * has to learn a brand's program kinds, while the known ones still autocomplete.
 */
export type ProgramKind = 'tp' | 'karel' | 'binary' | (string & {});

/** Everything the index keeps about one program that can be read off the file alone. */
export interface ProgramFacts {
  name: string;
  comment?: string;
  programType?: string;
  lineCount: number;
  labels: number;
  positions: number;
  /** upper-case callee names */
  calls: string[];
  /** macro instruction names used (FANUC); empty for a brand without macros */
  macros: string[];
  /** "KIND:index" -> inline comment as written in this program */
  inlineComments: Map<string, string>;
  /** "KIND:index" -> 'w' if this program ever writes it, else 'r' */
  dataAccess: Map<string, 'w' | 'r'>;
  /** best-effort tokens the parser could not fully read, counted per program */
  rawTokens: number;
  kind: ProgramKind;
  /** normalized-text hash and the normalized text, for the modified-vs-snapshot marker */
  textHash?: string;
  normText?: string;
}

export interface RobotBrand {
  /** stable id, lower-case: 'fanuc', 'abb' */
  readonly id: string;
  /** what a person calls it: 'FANUC', 'ABB' */
  readonly label: string;
  /** lower-case extensions, without the dot, of every program file this brand indexes */
  readonly programExtensions: readonly string[];
  /** VS Code language ids of this brand's program editors: 'fanuc-tp', 'fanuc-karel' */
  readonly languageIds: readonly string[];
  /** a compiled program with no source to read; the index records it without reading it */
  isBinaryProgram?(fsPath: string): boolean;
  /** index one program file; undefined when the file is not a program after all */
  indexProgram(fsPath: string, text: string): ProgramFacts | undefined;
  /**
   * Findings about data use across one robot's programs ("R[5] is read but never written"),
   * keyed the same way as {@link ProgramFacts.dataAccess}. Given only this brand's programs.
   */
  usageFindings?(programs: ReadonlyArray<ProgramFacts>): Map<string, string[]>;
  /**
   * The 0-based document line of a program's own line number `n` (FANUC TP numbers its
   * lines; a controller reports the running line that way). Undefined when there is no such line.
   */
  programLine?(text: string, n: number): number | undefined;
  /** does a folder holding these (lower-cased) file names look like one of this brand's controller backups? */
  looksLikeBackup(lowerNames: ReadonlySet<string>): boolean;
  /** a controller data or I/O file (lower-cased name) that a snapshot fetch can pull on its own */
  isDataFile?(lowerName: string): boolean;
}

const registered: RobotBrand[] = [];

/** Add a brand. Registering the same id twice replaces the first (tests re-register freely). */
export function registerBrand(brand: RobotBrand): void {
  const i = registered.findIndex(b => b.id === brand.id);
  if (i >= 0) registered[i] = brand; else registered.push(brand);
  cachedFileRe = undefined;
}

export function brands(): readonly RobotBrand[] { return registered; }

export function brandById(id: string): RobotBrand | undefined { return registered.find(b => b.id === id); }

const extOf = (p: string) => /\.([^.\\/]+)$/.exec(p)?.[1].toLowerCase() ?? '';

/** The brand that indexes this file, by extension; undefined when no brand claims it. */
export function brandForFile(fsPath: string): RobotBrand | undefined {
  const ext = extOf(fsPath);
  return ext ? registered.find(b => b.programExtensions.includes(ext)) : undefined;
}

let cachedFileRe: RegExp | undefined;
/** Matches a file name any registered brand indexes. */
export function programFileRe(): RegExp {
  if (!cachedFileRe) {
    const exts = [...new Set(registered.flatMap(b => b.programExtensions))];
    cachedFileRe = exts.length ? new RegExp(`\\.(${exts.join('|')})$`, 'i') : /$^/;
  }
  return cachedFileRe;
}

/** A file-watcher glob for every registered brand's program files: `**\/*.{ls,LS,kl,KL,...}`. */
export function programFileGlob(): string {
  const exts = [...new Set(registered.flatMap(b => b.programExtensions))];
  return `**/*.{${exts.flatMap(e => [e, e.toUpperCase()]).join(',')}}`;
}

/** Is this a program editor of any registered brand? */
export function isProgramLanguage(languageId: string): boolean {
  return registered.some(b => b.languageIds.includes(languageId));
}

export function isBinaryProgramFile(fsPath: string): boolean {
  return brandForFile(fsPath)?.isBinaryProgram?.(fsPath) ?? false;
}

/** Does any registered brand recognise this folder's files as a controller backup? */
/** is this (lower-cased) file name a data file of any registered brand? */
export function isAnyBrandDataFile(lowerName: string): boolean {
  return registered.some(b => b.isDataFile?.(lowerName) ?? false);
}

export function looksLikeAnyBackup(lowerNames: ReadonlySet<string>): boolean {
  return registered.some(b => b.looksLikeBackup(lowerNames));
}
