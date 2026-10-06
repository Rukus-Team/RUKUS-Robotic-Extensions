import type { OptionHighlight } from '@core/live/types';

/**
 * The software options a FANUC controller has, from MD:ORDERFIL.DAT - one line per option:
 *   1A05B-2600-R507 ! Ascii Upload
 * A controller with neither Ascii Upload (R507) nor Ascii Program Loader (R796) cannot load a
 * .LS program: the upload fails on the controller with nothing in the reply that says why, so
 * the push checks first. Either option is enough - ROBOGUIDE V9.40 with only R796 compiled a
 * .LS sent over FTP (2026-10-01).
 */
export const ORDER_FILE = 'ORDERFIL.DAT';
export const ASCII_UPLOAD = 'R507';
export const ASCII_PROGRAM_LOADER = 'R796';
/** any one of these lets the controller load a .LS */
export const ASCII_LOAD_OPTIONS = [ASCII_UPLOAD, ASCII_PROGRAM_LOADER] as const;

export interface ControllerOption { code: string; name: string }

/** The options in an ORDERFIL.DAT text; comment lines (`!` first) and anything else are skipped. */
export function parseOrderFile(text: string): ControllerOption[] {
  const out: ControllerOption[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*\S*?-([A-Z]\d{3}|[A-Z0-9]{4})\s*!\s*(.*?)\s*$/i.exec(line);
    if (m && !/^\s*!/.test(line)) out.push({ code: m[1].toUpperCase(), name: m[2] });
  }
  return out;
}

export function hasOption(options: ControllerOption[], code: string): boolean {
  return options.some(o => o.code === code.toUpperCase());
}

/**
 * The options of a robot, read from MD:ORDERFIL.DAT once per session (they change only when the
 * controller is re-licensed). undefined when the file could not be read or listed nothing; that
 * is not cached, so a robot that comes back is asked again. `fresh` reads again regardless.
 */
const optionsCache = new Map<string, ControllerOption[]>();
export async function readControllerOptions(
  reader: { readText(p: { name: string; host: string }, file: string, device?: string): Promise<string> },
  profile: { name: string; host: string },
  fresh = false,
): Promise<ControllerOption[] | undefined> {
  const key = `${profile.name}@${profile.host}`.toUpperCase();
  if (!fresh && optionsCache.has(key)) return optionsCache.get(key);
  try {
    const options = parseOrderFile(await reader.readText(profile, ORDER_FILE, 'MD:'));
    if (!options.length) return undefined;
    optionsCache.set(key, options);
    return options;
  } catch { return undefined; }
}

/** true when the controller can load a .LS (Ascii Upload or Ascii Program Loader) */
export function canLoadAscii(options: ControllerOption[]): boolean {
  return ASCII_LOAD_OPTIONS.some(code => hasOption(options, code));
}

/** What Robot Code (and a cell engineer) usually wants to know first. */
export function optionHighlights(options: ControllerOption[]): OptionHighlight[] {
  const out: OptionHighlight[] = [];
  // H-codes are the application software and the arm; the dictionaries are H-codes too but say nothing
  const base = options.filter(o => /^H\d{3}$/.test(o.code) && !/dictionary/i.test(o.name));
  if (base.length) out.push({ label: base.map(o => o.name).join(' · '), detail: `Application and robot model (${base.map(o => o.code).join(', ')})` });
  const has = (code: string) => hasOption(options, code);
  out.push({
    label: 'Loads .LS programs', ok: canLoadAscii(options),
    detail: canLoadAscii(options)
      ? `${[ASCII_UPLOAD, ASCII_PROGRAM_LOADER].filter(has).join(' + ')} - Push / Live Edit can send a .LS`
      : `No Ascii Upload (${ASCII_UPLOAD}) or Ascii Program Loader (${ASCII_PROGRAM_LOADER}) - a .LS cannot be pushed; load a compiled .TP`,
  });
  out.push({ label: 'KAREL', ok: has('R632'), detail: has('R632') ? 'R632 - runs compiled KAREL (.PC) programs' : 'No R632 - compiled KAREL (.PC) programs will not run' });
  out.push({ label: 'PC Interface', ok: has('R641'), detail: has('R641') ? 'R641 - PC tools built on FANUC\'s PC SDK can talk to it' : 'No R641 - PC SDK based tools cannot connect' });
  out.push({ label: 'Socket Messaging', ok: has('R648'), detail: has('R648') ? 'R648 - KAREL can open TCP sockets' : 'No R648 - no KAREL socket messaging' });
  return out;
}

/**
 * The options last read from a robot, by robot name - what the CALL list asks for a program
 * open from the controller. Only what was already read; undefined when nothing was.
 */
export function cachedOptionsForRobot(name: string): ControllerOption[] | undefined {
  const prefix = `${name}@`.toUpperCase();
  for (const [key, options] of optionsCache) if (key.startsWith(prefix)) return options;
  return undefined;
}

const NAME_NOISE = new Set(['the', 'of', 'and', 'for', 'function', 'package', 'interface', 'option', 'utility']);
const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9+]+/g, ' ').trim().split(' ').filter(w => w && !NAME_NOISE.has(w));

/**
 * Is the option a catalog entry names (syntaxCatalog's FANUC_PROGRAMS `option`, free text from
 * the manuals) installed? By order code when the text has one ("R726 iRCalibration Signature",
 * "iRVision (base: 2DV J901 / 3DL J902 / 3DV J914)": any of them); a code that is only a
 * prerequisite or an aside - "(needs R648 ...)", "(with J950)", after a ";" - does not count.
 * Without a code, by name: every word of one alternative ("A / B", "A or B") is in the name of
 * an installed option ("Collision Guard (Collision Skip)" -> "Collision Guard Pack").
 */
export function catalogOptionInstalled(label: string, installed: ControllerOption[]): boolean {
  const main = label.split(';')[0].replace(/\((needs|with|stated|north america|payload)[^)]*\)/gi, ' ');
  const codes = [...main.matchAll(/\b([A-Z]\d{3})\b/g)].map(m => m[1]);
  if (codes.length) return codes.some(c => hasOption(installed, c));
  const names = installed.map(o => new Set(words(o.name)));
  return main.replace(/\([^)]*\)/g, ' ').split(/\s\/\s|\s+or\s+/i).map(words).filter(w => w.length)
    .some(alt => names.some(n => alt.every(w => n.has(w))));
}
