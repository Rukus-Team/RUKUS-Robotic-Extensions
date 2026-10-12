/**
 * Which FANUC controller is this - by its F number, never by its address. Two controllers can
 * answer at the same address (a laptop moved between cells, two cells on the same subnet, a
 * swapped cable), so a profile is tied to the controller it first reached: the F number every
 * controller file header carries is remembered at the first connect and checked on every connect,
 * every read and before every upload. Pure, so tests pin it.
 */
import type { ControllerInfo } from './types';

/** What a profile expects to find, remembered at the first connect. */
export interface ExpectedFanuc { fNumber: string; robotName?: string }

const norm = (s: string | undefined) => s?.trim().toUpperCase() || undefined;

/** What to remember for a controller seen for the first time; undefined when its header has no F number. */
export function fanucExpectationOf(seen: ControllerInfo): ExpectedFanuc | undefined {
  const f = norm(seen.fNumber);
  return f ? { fNumber: f, ...(seen.robotName ? { robotName: seen.robotName } : {}) } : undefined;
}

/**
 * Is `seen` the controller the profile is for? Undefined when it is, when nothing is expected yet,
 * or when the header carries no F number to compare; else why not, in words.
 */
export function fanucIdentityMismatch(profileName: string, host: string, expected: ExpectedFanuc | undefined, seen: ControllerInfo): string | undefined {
  const want = norm(expected?.fNumber), got = norm(seen.fNumber);
  if (!want || !got || want === got) return undefined;
  const found = `${seen.robotName ? `${seen.robotName}, ` : ''}F number ${got}`;
  return `${host} is a different controller (${found}), not ${profileName} (F number ${want}). Two controllers can share an address, so the address cannot tell them apart: connect to ${profileName}'s controller, add this one as a robot of its own, or use "FANUC: Forget Controller Identity" if ${profileName} really is this controller now.`;
}
