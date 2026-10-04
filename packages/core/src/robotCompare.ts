/**
 * The last verbatim robot↔snapshot compare, per working file, for the status bar. Pure (no
 * vscode), so `test/run.ts` can exercise the key round-trip without the extension host.
 *
 * Keyed by the WORKING FILE path - the compare is a property of one program, and
 * `checkPushGate`/`completePush` always run on the file being pushed. Keying it by the robot
 * root (the original bug) made every read miss, so `↓ robot changed` never appeared.
 */
export interface RobotCompare {
  /** when the compare happened, ms */
  at: number;
  differs: boolean;
  metadataOnly?: boolean;
  changed?: number;
}

const robotState = new Map<string, RobotCompare>();

function key(fsPath: string): string {
  return fsPath.toLowerCase();
}

/** Record the outcome of a verbatim robot↔snapshot compare for a working file. */
export function noteRobotCompare(fsPath: string, c: Omit<RobotCompare, 'at'>): void {
  robotState.set(key(fsPath), { at: Date.now(), ...c });
}

/** The last verbatim robot compare for a file, if there has been one this session. */
export function robotCompareOf(fsPath: string): RobotCompare | undefined {
  return robotState.get(key(fsPath));
}

export function clearRobotCompare(fsPath?: string): void {
  if (fsPath) robotState.delete(key(fsPath)); else robotState.clear();
}
