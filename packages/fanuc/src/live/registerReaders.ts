/**
 * FANUC's readers for the register dumps the live layer pulls off a controller. Moved out of
 * core's robotManager.ts in monorepo phase 2, unchanged: core fetches NUMREG.VA / STRREG.VA /
 * POSREG.VA, these turn the text into the snapshot's maps.
 */
import { registerReaders } from '@core/live/robotManager';
import { parseNumReg, parsePosReg, parseStrReg, parseUserAlarms, ualmSeverityName } from '../data/vaParser';

export function installFanucRegisterReaders(): void {
  registerReaders.numregs = (s, t) => { s.numregs = new Map(parseNumReg(t).map(r => [r.index, { value: r.value, comment: r.comment }])); };
  registerReaders.strregs = (s, t) => { s.strregs = new Map(parseStrReg(t).map(r => [r.index, { value: r.value, comment: r.comment }])); };
  // group 1 only: the Controllers view shows the robot's own registers
  registerReaders.ualarms = (s, t) => { s.ualarms = new Map(parseUserAlarms(t).map(a => [a.index, { message: a.message, severity: ualmSeverityName(a.severity) }])); };
  registerReaders.posregs = (s, t) => { s.posregs = new Map(parsePosReg(t).filter(r => r.group === 1).map(r => [r.index, { comment: r.comment, summary: r.summary, kind: r.kind }])); };
}
