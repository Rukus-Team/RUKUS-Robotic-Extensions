/**
 * A program the controller refused must not leave the robot without it. Seen on ROBOGUIDE V9.40
 * (2026-11-07): RKEDIT.LS with an undefined instruction on line 23 was refused (ASBN-092,
 * ASBN-002), and the robot no longer had RKEDIT at all - the controller takes the old program
 * away when it starts loading a .LS - while two leftovers, -TMPASC-.LS and -TMPASC-.TP, stayed
 * on MD:. RUKUS Studio fixed the same thing (PR #285, TransferPutBack.cs); this is its logic.
 *
 * Here, without vscode: which copies to keep before a send, whether to put the robot's previous
 * copy back after a refusal (compiled .TP first, then the .LS), which leftovers to delete, and
 * the controller's own reason for the refusal, read from ERRALL.LS (program, line, column,
 * cause). The caller (editorCommands.ts) does the asking and the words on screen.
 */
import { parseAlarms, newestFirst, alarmTime } from '@core/live/parsers';

/** The program a FANUC controller loads a .LS into before it replaces the real one. */
export const FANUC_TEMP_PROGRAM = '-TMPASC-';
const LEFTOVERS = [`${FANUC_TEMP_PROGRAM}.TP`, `${FANUC_TEMP_PROGRAM}.LS`];

const upper = (s: string) => s.toUpperCase();
const ext = (f: string) => /\.[^.]*$/.exec(f)?.[0].toUpperCase() ?? '';
const withExt = (f: string, e: string) => upper(f.replace(/\.[^.]*$/, '') + e);

/** The compiled form the robot holds of a .LS (MAIN.LS -> MAIN.TP); undefined for anything else. */
export function compiledForm(file: string): string | undefined {
  return ext(file) === '.LS' ? withExt(file, '.TP') : undefined;
}

/** The name under which the robot lists `file` (itself, or the .TP of a .LS), or undefined. */
export function onRobot(file: string, names: readonly string[]): string | undefined {
  const set = new Set(names.map(upper));
  if (set.has(upper(file))) return upper(file);
  const tp = compiledForm(file);
  return tp && set.has(tp) ? tp : undefined;
}

/** The controller's leftovers of a refused .LS: -TMPASC-.TP/.LS listed after the send and not before. */
export function leftovers(file: string, before: readonly string[], after: readonly string[]): string[] {
  if (!compiledForm(file)) return [];
  const had = new Set(before.map(upper)), now = new Set(after.map(upper));
  return LEFTOVERS.filter(n => now.has(n) && !had.has(n));
}

/**
 * What to delete for those leftovers: a FANUC program goes by its .TP (its .LS is only the
 * controller's listing of it and goes with it).
 */
export function toDelete(names: readonly string[]): string[] {
  return [...new Set(names.map(n => (ext(n) === '.LS' ? withExt(n, '.TP') : upper(n))))];
}

/** One copy of the robot's program, kept on this PC before it is replaced. */
export interface KeptCopy {
  /** the name on the robot (RKEDIT.TP, RKEDIT.LS) */
  file: string;
  data: Uint8Array;
  /** where it was saved on this PC */
  path?: string;
}

/** The robot's files, as far as a put-back needs them. */
export interface PutBackIo {
  /** the names on the device; throws when it cannot be listed */
  list(): Promise<string[]>;
  write(file: string, data: Uint8Array): Promise<void>;
  /** deletes one file; absent where the transport cannot */
  remove?(file: string): Promise<void>;
}

export interface PutBackResult {
  /** the robot no longer listed the program and a copy had been kept: it had to go back */
  needed: boolean;
  /** the robot lists the program again */
  restored: boolean;
  /** the kept file that brought it back (RKEDIT.TP), or the one a person should send again */
  from?: KeptCopy;
  /** why the put-back failed (the robot NO LONGER HAS the program) */
  error?: string;
  /** whether the program is listed after the refusal (undefined: the listing failed) */
  stillThere?: boolean;
  /** a copy was sent back, but no listing could confirm it landed */
  unconfirmed?: boolean;
  /** leftovers removed / still on the robot */
  removed: string[];
  left: string[];
}

/** The order to try kept copies in: the compiled form first (the program exactly as it was), then the text. */
export function putBackOrder(file: string, kept: readonly KeptCopy[]): KeptCopy[] {
  const tp = compiledForm(file);
  const rank = (k: KeptCopy) => (tp && upper(k.file) === tp ? 0 : upper(k.file) === upper(file) ? 1 : 2);
  return kept.filter(k => rank(k) < 2).sort((a, b) => rank(a) - rank(b));
}

async function names(io: PutBackIo): Promise<string[] | undefined> {
  try { return await io.list(); } catch { return undefined; }
}

/**
 * After a send of `file` failed: when the robot no longer lists the program and a copy was
 * kept, send the kept copies back in turn (compiled first) until a listing shows the program
 * again; then delete -TMPASC- leftovers that appeared during this send (only when the listing
 * before the send is known - a -TMPASC- the robot already had is not ours to delete).
 */
export async function putBackAfterRefusal(io: PutBackIo, file: string, kept: readonly KeptCopy[], before: readonly string[] | undefined): Promise<PutBackResult> {
  let after = await names(io);
  const stillThere = after ? !!onRobot(file, after) : undefined;
  const order = putBackOrder(file, kept);
  const needed = order.length > 0 && !stillThere;
  let restored = false, unconfirmed = false, error: string | undefined, from: KeptCopy | undefined;
  if (needed) {
    for (const copy of order) {
      from = copy;
      try {
        await io.write(copy.file, copy.data);
        after = await names(io);
        if (after && onRobot(file, after)) { restored = true; error = undefined; break; }
        // sent, but nothing can say whether it landed: another write would only replace it
        if (!after) { unconfirmed = true; error = 'the robot could not be listed to confirm it'; break; }
        error = `${upper(file.replace(/\.[^.]*$/, ''))} is still not listed after sending ${copy.file}`;
      } catch (e: any) {
        error = e?.message ?? String(e);
      }
    }
    // the text form is the one a person can open and send again
    if (!restored && !unconfirmed) from = order[order.length - 1];
  }
  const found = before && after ? leftovers(file, before, after) : [];
  let removed: string[] = [], left: string[] = [];
  if (found.length) {
    if (io.remove) for (const n of toDelete(found)) { try { await io.remove(n); } catch { /* still listed below */ } }
    const now = await names(io);
    const set = new Set((now ?? []).map(upper));
    left = now ? found.filter(n => set.has(n)) : found;
    removed = found.filter(n => !left.includes(n));
  }
  return { needed, restored, from, error: needed && !restored ? (error ?? 'no copy was kept') : undefined, stillThere: restored ? true : stillThere, ...(unconfirmed ? { unconfirmed } : {}), removed, left };
}

// ---------------------------------------------------------------- the controller's reason

/** A refusal, taken apart: the controller's own words, the program, and where it stopped. */
export interface Refusal {
  /** the controller's reason in its own words (codes kept): "ASBN-092 Undefined instruction" */
  reason: string;
  /** every alarm the refusal raised, newest first, joined */
  alarms: string;
  program?: string;
  /** the sent file's line (1-based) the loader stopped at */
  line?: number;
  column?: number;
}

/** The loader's and the program store's alarms: these are about the program just sent. */
const LOAD_ALARM = /^(ASBN|MEMO|TPIF|PROG|FILE)-\d{3}/;

/**
 * The alarms a refused upload raised, from ERRALL.LS: the newest rows within 5 s of the
 * newest, up to the last RESET, as "message (cause)". Undefined when the newest alarms are not
 * the loader's or the program store's (ASBN, MEMO, TPIF, PROG, FILE): then nothing here is
 * known to be about this send.
 */
export function refusalFromAlarms(errall: string): Refusal | undefined {
  const rows = newestFirst(parseAlarms(errall));
  if (!rows.length) return undefined;
  const newest = alarmTime(rows[0].time);
  if (isNaN(newest)) return undefined;
  const recent: string[] = [];
  for (const r of rows) {
    const t = alarmTime(r.time);
    if (r.isReset || isNaN(t) || newest - t > 5000) break;
    recent.push(r.cause ? `${r.message} (${r.cause})` : r.message);
    if (recent.length >= 4) break;
  }
  if (!recent.some(m => LOAD_ALARM.test(m))) return undefined;
  return parseRefusal(recent.join('; '));
}

/**
 * Takes the loader's words apart (RUKUS Studio TransferFailures.Parse): "ASBN-009 on line 23,
 * column 28 (ASBN-092 Undefined instruction); ASBN-008 file 'RKEDIT'; ASBN-002 Error occurred
 * during load" -> reason ASBN-092 Undefined instruction, program RKEDIT, line 23, column 28.
 */
export function parseRefusal(text: string): Refusal {
  let reason: string | undefined, line: number | undefined, column: number | undefined;
  const program = /ASBN-008\s+file\s+'([^']+)'/i.exec(text)?.[1].trim();
  const at = /ASBN-009\s+on\s+line\s+(\d+)(?:\s*,\s*column\s+(\d+))?(?:\s*\(([^)]*)\))?/i.exec(text);
  if (at) {
    line = parseInt(at[1], 10);
    if (at[2]) column = parseInt(at[2], 10);
    if (at[3]) reason = at[3].trim();
  }
  reason ??= [...text.matchAll(/\b[A-Z]{3,5}-\d{3}\b[^;()]*/g)].map(m => m[0].trim()).find(v => !/^ASBN-00[289]\b/.test(v));
  return { reason: reason ?? text, alarms: text, program, line, column };
}

/** "ASBN-092 Undefined instruction - line 23, column 28" */
export function refusalSummary(r: Refusal): string {
  return r.line !== undefined ? `${r.reason} - line ${r.line}${r.column !== undefined ? `, column ${r.column}` : ''}` : r.reason;
}

/** The words for a refused send: the controller's reason, and what became of the program on the robot. */
export function refusedWords(robot: string, file: string, r: { error: string; refusal?: Refusal; putBack: PutBackResult }, hint?: string): { text: string; lost: boolean } {
  const prog = file.replace(/\.[^.]*$/, '').toUpperCase();
  const why = r.refusal ? refusalSummary(r.refusal) : r.error.replace(/\.?\s*$/, '');
  const pb = r.putBack;
  const leftovers = (pb.removed.length ? ` The controller's leftovers ${pb.removed.join(', ')} were removed.` : '')
    + (pb.left.length ? ` The controller's leftovers ${pb.left.join(', ')} are still on ${robot}; delete them there.` : '');
  if (pb.needed && pb.unconfirmed) {
    return {
      lost: true,
      text: `WARNING: ${robot} refused ${file} (${why}) and had lost ${prog}. Its previous copy (${pb.from?.file}) was sent back, but ${robot} could not be listed to confirm it is there: check ${prog} on the pendant before the robot runs. `
        + `The previous copy is on this PC: ${pb.from?.path ?? '(it could not be saved)'}.${leftovers}`,
    };
  }
  if (pb.needed && !pb.restored) {
    return {
      lost: true,
      text: `WARNING: ${robot} refused ${file} (${why}) and NO LONGER HAS ${prog}: putting its previous copy back failed (${pb.error}). `
        + `The previous copy is on this PC: ${pb.from?.path ?? '(it could not be saved)'}. Send it to ${robot} again before the robot runs.${leftovers}`,
    };
  }
  const fate = pb.needed ? ` Its previous ${prog} was put back.`
    : pb.stillThere ? ` ${prog} on ${robot} is unchanged.`
    : pb.stillThere === undefined ? ` Whether ${prog} is still on ${robot} could not be checked.` : '';
  // the generic guesses only when the controller gave no reason of its own
  const extra = !r.refusal && hint ? ` ${hint}` : '';
  return { lost: false, text: `${robot} refused ${file}: ${why}.${fate}${extra}${leftovers}` };
}
