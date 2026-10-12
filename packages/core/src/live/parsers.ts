/**
 * Parsers for the controller-generated diagnostic files used by the live tier.
 * Formats verified against an R-30iB Plus (V9.40) SpotTool+ backup.
 */
import type { CurrentPosition, CartPosition, TaskState, TaskStatus, TaskFrame, IoPoint, AlarmEntry, ControllerInfo } from './types';

export function parseControllerInfo(text: string): ControllerInfo {
  const info: ControllerInfo = {};
  const f = /^F Number:\s*(\S+)/m.exec(text); if (f) info.fNumber = f[1];
  const v = /^\$VERSION:\s*(.+?)\s*$/m.exec(text); if (v) info.version = v[1].trim();
  const a = /^\s*VERSION\s*:\s*(.+?)\s*$/m.exec(text); if (a) info.application = a[1].trim();
  const d = /^DATE:\s*(.+?)\s*$/m.exec(text); if (d) info.date = d[1].trim();
  const n = /Robot Name\s+(\S+)/.exec(text); if (n) info.robotName = n[1];
  return info;
}

/**
 * CURPOS.DG:
 *   CURRENT JOINT POSITION:  Joint   1:   -101.43 ...  EXTAXS: 1:    100.00
 *   Frame #:   1  Tool #:   1
 *   CURRENT USER FRAME POSITION:  CFG: N U T, 0, 0, 0  X: ... R: ...
 *   CURRENT WORLD POSITION: ...
 */
export function parseCurPos(text: string): CurrentPosition | undefined {
  if (!/CURRENT (ROBOT|JOINT|WORLD|USER FRAME) POSITION/i.test(text)) return undefined;
  const pos: CurrentPosition = { group: 1 };
  const g = /Group #:\s*(\d+)/.exec(text); if (g) pos.group = parseInt(g[1], 10);
  const ft = /Frame #:\s*(\d+)\s+Tool #:\s*(\d+)/.exec(text); if (ft) { pos.frameNo = parseInt(ft[1], 10); pos.toolNo = parseInt(ft[2], 10); }
  const d = /^DATE:\s*(.+?)\s*$/m.exec(text); if (d) pos.timestamp = d[1].trim();

  const sections = text.split(/^(?=CURRENT [A-Z ]+POSITION:)/m);
  for (const sec of sections) {
    const head = /^CURRENT ([A-Z ]+) POSITION:/.exec(sec);
    if (!head) continue;
    const kind = head[1].trim();
    if (kind === 'JOINT') {
      const joints: number[] = [];
      for (const m of sec.matchAll(/Joint\s+(\d+):\s*(-?[\d.]+)/g)) joints[parseInt(m[1], 10) - 1] = parseFloat(m[2]);
      pos.joint = { joints, ext: parseExt(sec) };
    } else if (kind === 'USER FRAME' || kind === 'WORLD') {
      const cart = parseCart(sec);
      if (cart) { if (kind === 'WORLD') pos.world = cart; else pos.userFrame = cart; }
    }
  }
  return pos;
}

function parseExt(sec: string): number[] {
  const ext: number[] = [];
  for (const m of sec.matchAll(/EXTAXS:\s*(\d+):\s*(-?[\d.]+)/g)) ext[parseInt(m[1], 10) - 1] = parseFloat(m[2]);
  return ext;
}

function parseCart(sec: string): CartPosition | undefined {
  const get = (k: string) => { const m = new RegExp(`^\\s*${k}:\\s*(-?[\\d.]+)`, 'm').exec(sec); return m ? parseFloat(m[1]) : undefined; };
  const x = get('X'), y = get('Y'), z = get('Z'), w = get('W'), p = get('P'), r = get('R');
  if ([x, y, z, w, p, r].some(v => v === undefined)) return undefined;
  const cfg = /CFG:\s*(.+?)\s*$/m.exec(sec);
  return { x: x!, y: y!, z: z!, w: w!, p: p!, r: r!, config: cfg?.[1].trim(), ext: parseExt(sec) };
}

/**
 * PRGSTATE.DG:
 *   TASK STATES:
 *   1      MHMENUC status = ABORTED
 *   ******  History Data  ******
 *   Routine depth: 0  Routine: MHMENUC
 *   Line:    75       Program: MHMENUC     Type: PC
 */
export function parsePrgState(text: string): TaskState[] {
  const out: TaskState[] = [];
  // Two head forms. An idle task: "7     LOADCELL status = ABORTED". An active one (V9.40, seen on
  // ROBOGUIDE SpotTool+ and HandlingTool 2026-10-01): "14  TOOL1MNT PAUSED @ 37 in TOOL1MNT of TOOL1MNT"
  // - no "status =", so it used to be skipped and a running or paused program went unseen.
  const blocks = text.split(/^(?=[ \t]*\d+[ \t]+(?:\S*[ \t]*status[ \t]*=|\S+[ \t]+[A-Z]+[ \t]*@[ \t]*\d+[ \t]+in[ \t]))/m);
  for (const b of blocks) {
    const idle = /^[ \t]*(\d+)[ \t]+(\S*?)[ \t]*status[ \t]*=[ \t]*([A-Z]+)/.exec(b);
    const active = idle ? null : /^[ \t]*(\d+)[ \t]+(\S+)[ \t]+([A-Z]+)[ \t]*@[ \t]*(\d+)[ \t]+in[ \t]+(\S+)[ \t]+of[ \t]+(\S+)/.exec(b);
    const head = idle ?? active;
    if (!head) continue;
    const status = normalizeStatus(head[3]);
    const task: TaskState = { taskNo: parseInt(head[1], 10), name: head[2] || '(empty slot)', status, stack: [] };
    let pendingRoutine: { depth: number; routine: string } | undefined;
    for (const line of b.split(/\r?\n/)) {
      const rd = /Routine depth:\s*(\d+)\s+Routine:\s*(\S+)/.exec(line);
      if (rd) { pendingRoutine = { depth: parseInt(rd[1], 10), routine: rd[2] }; continue; }
      const lp = /Line:\s*(\d+)\s+Program:\s*(\S+)\s+Type:\s*(\S+)/.exec(line);
      if (lp) {
        const frame: TaskFrame = { line: parseInt(lp[1], 10), program: lp[2], type: lp[3], routine: pendingRoutine?.routine, depth: pendingRoutine?.depth };
        task.stack.push(frame);
        pendingRoutine = undefined;
      }
    }
    // the active head line already says where it is, for a block that carries no Line: detail
    if (!task.stack.length && active) task.stack.push({ line: parseInt(active[4], 10), program: active[6], routine: active[5], type: 'TP' });
    task.current = task.stack[0];
    out.push(task);
  }
  return out;
}

function normalizeStatus(s: string): TaskStatus {
  const u = s.toUpperCase();
  if (u.startsWith('RUN')) return 'RUNNING';
  if (u === 'PAUSED') return 'PAUSED';
  if (u === 'PAUSING') return 'PAUSING';
  if (u === 'ABORTED') return 'ABORTED';
  if (u.startsWith('ABORT')) return 'ABORTING';
  return 'UNKNOWN';
}

const IO_PREFIX: Record<string, string> = {
  DIN: 'DI', DOUT: 'DO', RI: 'RI', RO: 'RO', RDI: 'RI', RDO: 'RO', GIN: 'GI', GOUT: 'GO', AIN: 'AI', AOUT: 'AO',
  UI: 'UI', UO: 'UO', UOPIN: 'UI', UOPOUT: 'UO', SI: 'SI', SO: 'SO', SOPIN: 'SI', SOPOUT: 'SO', FLG: 'F', MRK: 'M', WDI: 'WI', WDO: 'WO', WSI: 'WSI', WSO: 'WSO',
};

/** IOSTATE.DG:  DIN[  25] OFF  ZONE 1 CLR   /  GIN[   1] 0  PROG SELECT BITS  /  "ON *" or "SIM" marks simulated */
export function parseIoState(text: string): IoPoint[] {
  const out: IoPoint[] = [];
  // [ \t] rather than \s: a trailing \s* would swallow the newline and the next row when the comment is blank
  for (const m of text.matchAll(/^[ \t]*([A-Z]+)\[[ \t]*(\d+)\][ \t]+(SIM[ \t]+)?(ON|OFF|-?\d+)([ \t]*\*)?[ \t]{0,3}([^\r\n]*?)[ \t]*$/gm)) {
    const kind = IO_PREFIX[m[1]];
    if (!kind) continue;
    const raw = m[4];
    const value: 'ON' | 'OFF' | number = raw === 'ON' || raw === 'OFF' ? raw : parseInt(raw, 10);
    out.push({ kind, index: parseInt(m[2], 10), value, simulated: !!m[3] || !!m[5], comment: m[6].trim() });
  }
  return out;
}

/**
 * ERRALL.LS / ERRCURR.LS rows:
 *   798" 23-AUG-26 13:20:34 " INTP-213 TeachMem still ON (-PMC-, 1) UALM[23]    " " WARN     00000000"    "
 */
export function parseAlarms(text: string): AlarmEntry[] {
  const out: AlarmEntry[] = [];
  for (const m of text.matchAll(/^\s*(\d+)"\s*(\d{2}-[A-Z]{3}-\d{2}\s+\d{2}:\d{2}:\d{2})\s*"\s*(.*?)\s*"\s*"\s*([A-Z]*)[^"]*"/gm)) {
    const message = m[3].replace(/\s+/g, ' ').trim();
    const isReset = /^R E S E T$/.test(message);
    const code = /^([A-Z]{2,5}-\d{3})/.exec(message)?.[1];
    out.push({ seq: parseInt(m[1], 10), time: m[2], code, message, severity: m[4] || (isReset ? 'RESET' : ''), isReset });
  }
  return out;
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/** "10-OCT-26 11:02:40" (dd-MMM-yy HH:mm:ss) as a sortable number; NaN when it does not parse */
export function alarmTime(time: string): number {
  const m = /^(\d{2})-([A-Z]{3})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/.exec(time.trim());
  const month = m ? MONTHS.indexOf(m[2]) : -1;
  if (!m || month < 0) return NaN;
  return Date.UTC(2000 + +m[3], month, +m[1], +m[4], +m[5], +m[6]);
}

/**
 * Alarm rows newest first. The file order is not assumed: an R-30iB Plus (V9.40) writes ERRALL.LS
 * newest first, older files oldest first. The first and last rows' own times decide; on equal
 * times the lower row number is the newer one.
 */
export function newestFirst(rows: AlarmEntry[]): AlarmEntry[] {
  if (rows.length < 2) return rows.slice();
  const first = alarmTime(rows[0].time), last = alarmTime(rows[rows.length - 1].time);
  const keep = first !== last && !isNaN(first) && !isNaN(last) ? first > last : rows[0].seq <= rows[rows.length - 1].seq;
  return keep ? rows.slice() : rows.slice().reverse();
}

/** Current errors: the newest rows up to (not including) the latest RESET, alarm codes only. */
export function activeAlarms(rows: AlarmEntry[], max = 8): AlarmEntry[] {
  const out: AlarmEntry[] = [];
  for (const a of newestFirst(rows)) {
    if (a.isReset) break;
    if (a.code) out.push(a);
    if (out.length >= max) break;
  }
  return out;
}

export type AlarmPriority = 'High' | 'Medium' | 'Low' | 'Info';

/** Severity column as a priority: STOP/SERVO/ABORT/SYSTEM high, PAUSE medium, WARN low, else info. */
export function alarmPriority(severity: string): AlarmPriority {
  const s = severity.toUpperCase();
  if (/STOP|SERVO|ABORT|SYSTEM/.test(s)) return 'High';
  if (/PAUSE/.test(s)) return 'Medium';
  if (/WARN/.test(s)) return 'Low';
  return 'Info';
}

/** Priority as a symbol and a word, never colour alone. */
export function alarmPriorityLabel(severity: string): string {
  const p = alarmPriority(severity);
  return `${{ High: '■', Medium: '▲', Low: '●', Info: '○' }[p]} ${p}`;
}

/** Numeric summary for the tree/tooltips */
export function fmtCart(c: CartPosition): string {
  const f = (n: number) => n.toFixed(2);
  return `X ${f(c.x)}  Y ${f(c.y)}  Z ${f(c.z)}  W ${f(c.w)}  P ${f(c.p)}  R ${f(c.r)}${c.ext.length ? '  E' + c.ext.map((e, i) => `${i + 1} ${f(e)}`).join(' E') : ''}`;
}
export function fmtJoints(j: number[]): string { return j.map((v, i) => `J${i + 1} ${v.toFixed(2)}`).join('  '); }
