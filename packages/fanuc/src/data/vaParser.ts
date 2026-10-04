/**
 * Parsers for FANUC controller ASCII variable dumps (.va) that carry the data
 * a programmer wants while editing TP: register comments/values, position
 * register comments, string registers and I/O comments.
 */

export interface NumRegEntry { index: number; value: number | string; comment: string }
export interface PosRegEntry {
  index: number; group: number; comment: string; kind: 'joint' | 'cartesian' | 'uninit';
  summary: string; config?: string; uf?: number; ut?: number;
  /** raw axis values keyed X/Y/Z/W/P/R, J1..Jn, E1..En — `summary` is rounded for display, this is not */
  values: Record<string, number>;
}
export interface StrRegEntry { index: number; value: string; comment: string }
export interface IoEntry { kind: string; index: number; comment: string; typeCode: number }

/** KAREL port type codes (kliotyps.kl) → TP mnemonic */
export const IO_TYPE_TO_KIND: Record<number, string> = {
  1: 'DI', 2: 'DO', 3: 'AI', 4: 'AO', 8: 'RI', 9: 'RO', 11: 'SI', 12: 'SO',
  16: 'WI', 17: 'WO', 18: 'GI', 19: 'GO', 20: 'UI', 21: 'UO', 22: 'LI', 23: 'LO',
  26: 'WSI', 27: 'WSO', 35: 'F', 36: 'M',
};

const RE_ARRAY_ITEM = /^\s*\[(\d+)\]\s*=\s*(.*)$/;

/** numreg.va:  [3] = 0  'Weld Retries' */
export function parseNumReg(text: string): NumRegEntry[] {
  const out: NumRegEntry[] = [];
  if (!/\$NUMREG\b/.test(text)) return out;
  for (const line of text.split(/\r?\n/)) {
    const m = RE_ARRAY_ITEM.exec(line);
    if (!m) continue;
    const rest = m[2];
    const vm = /^(-?[\d.]+(?:[eE][+-]?\d+)?|\S+)\s*(?:'([^']*)')?/.exec(rest);
    if (!vm) continue;
    const raw = vm[1];
    const num = Number(raw);
    out.push({ index: parseInt(m[1], 10), value: Number.isNaN(num) ? raw : num, comment: (vm[2] ?? '').trim() });
  }
  return out;
}

/** strreg.va:  [1] =   'value'  'comment'  — or just one quoted string */
export function parseStrReg(text: string): StrRegEntry[] {
  const out: StrRegEntry[] = [];
  if (!/\$STRREG\b/.test(text)) return out;
  for (const line of text.split(/\r?\n/)) {
    const m = RE_ARRAY_ITEM.exec(line);
    if (!m) continue;
    const strings = [...m[2].matchAll(/'([^']*)'/g)].map(x => x[1]);
    out.push({ index: parseInt(m[1], 10), value: strings[0] ?? '', comment: (strings[1] ?? '').trim() });
  }
  return out;
}

/**
 * posreg.va:
 *     [1,1] =   'Home 1'   Group: 1
 *   J1 =   -16.808 deg   J2 = ...
 *   EXT1:  4139.882 mm
 *     [1,3] =   'Pounce'
 *   (cartesian:)  Config: N D B, 0, 0, 0   X: ...   Y: ...
 */
export function parsePosReg(text: string): PosRegEntry[] {
  const out: PosRegEntry[] = [];
  if (!/\$POSREG\b/.test(text)) return out;
  let cur: PosRegEntry | undefined;
  const vals: string[] = [];
  const flush = () => {
    if (!cur) return;
    cur.summary = vals.join('  ');
    if (cur.kind === 'uninit' && vals.length) cur.kind = /\bJ1\b/.test(cur.summary) ? 'joint' : 'cartesian';
    out.push(cur);
    cur = undefined; vals.length = 0;
  };
  for (const line of text.split(/\r?\n/)) {
    const head = /^\s*\[(\d+),(\d+)\]\s*=\s*'([^']*)'\s*(.*)$/.exec(line);
    if (head) {
      flush();
      cur = { group: parseInt(head[1], 10), index: parseInt(head[2], 10), comment: head[3].trim(), kind: 'uninit', summary: '', values: {} };
      const rest = head[4];
      if (/Uninit/i.test(rest)) cur.kind = 'uninit';
      const uf = /UF\s*:\s*(\d+)/.exec(rest); if (uf) cur.uf = parseInt(uf[1], 10);
      const ut = /UT\s*:\s*(\d+)/.exec(rest); if (ut) cur.ut = parseInt(ut[1], 10);
      continue;
    }
    if (!cur) continue;
    if (/^\s*$/.test(line)) { flush(); continue; }
    if (/^\s*\[/.test(line) && !/^\s*\[\d+,\d+\]/.test(line)) { flush(); continue; }
    const cfg = /Config:\s*([A-Z ]+,\s*-?\d+,\s*-?\d+,\s*-?\d+)/.exec(line);
    if (cfg) cur.config = cfg[1].trim();
    const uf = /UF\s*:\s*(\d+)/.exec(line); if (uf) cur.uf = parseInt(uf[1], 10);
    const ut = /UT\s*:\s*(\d+)/.exec(line); if (ut) cur.ut = parseInt(ut[1], 10);
    for (const m of line.matchAll(/\b(J\d|X|Y|Z|W|P|R|EXT\d|E\d)\s*[:=]\s*(-?[\d.]+)/g)) {
      vals.push(`${m[1]} ${trimNum(m[2])}`);
      // EXT1 and E1 are the same extended axis under two spellings; teaching keys on E<n>.
      cur.values[m[1].replace(/^EXT/, 'E')] = parseFloat(m[2]);
      if (/^J\d/.test(m[1])) cur.kind = 'joint'; else if (/^[XYZWPR]$/.test(m[1])) cur.kind = 'cartesian';
    }
  }
  flush();
  return out;
}

/**
 * diocfgsv.va: NAME_LOG_PT[i] (port type), NAME_LOG_PN[i] (port number),
 * NAME_NAME[i] + NAME_NAME2[i] (comment, 16 chars each)
 */
export function parseIoComments(text: string): IoEntry[] {
  const out: IoEntry[] = [];
  if (!/NAME_LOG_PT\b/.test(text)) return out;
  const arrays: Record<string, Map<number, string>> = {};
  let cur: Map<number, string> | undefined;
  for (const line of text.split(/\r?\n/)) {
    const head = /^\[MDIO_MAIN\](NAME_LOG_PT|NAME_LOG_PN|NAME_NAME2|NAME_NAME)\b/.exec(line);
    if (head) { cur = new Map(); arrays[head[1]] = cur; continue; }
    if (/^\[/.test(line)) { cur = undefined; continue; }
    if (!cur) continue;
    const m = RE_ARRAY_ITEM.exec(line);
    if (m) cur.set(parseInt(m[1], 10), m[2].trim().replace(/^'|'$/g, ''));
  }
  const pt = arrays.NAME_LOG_PT, pn = arrays.NAME_LOG_PN, n1 = arrays.NAME_NAME, n2 = arrays.NAME_NAME2;
  if (!pt || !pn || !n1) return out;
  for (const [i, typeStr] of pt) {
    const typeCode = parseInt(typeStr, 10);
    const index = parseInt(pn.get(i) ?? '', 10);
    if (Number.isNaN(index)) continue;
    const comment = ((n1.get(i) ?? '') + (n2?.get(i) ?? '')).trim();
    if (!comment) continue;
    out.push({ kind: IO_TYPE_TO_KIND[typeCode] ?? `IO${typeCode}`, index, comment, typeCode });
  }
  return out;
}

export interface MacroEntry { index: number; macroName: string; progName: string }

/**
 * sysmacro.va:
 *   Field: $MACROTABLE[5].$MACRO_NAME Access: RO: STRING[37] = 'GO TO HOME POS'
 *   Field: $MACROTABLE[5].$PROG_NAME Access: RO: STRING[37] = 'MOV_HOME'
 */
export function parseMacroTable(text: string): MacroEntry[] {
  const out = new Map<number, MacroEntry>();
  if (!/\$MACROTABLE\b/.test(text)) return [];
  for (const m of text.matchAll(/\$MACROTABLE\[(\d+)\]\.\$(MACRO_NAME|PROG_NAME)\b[^=]*=\s*'([^']*)'/g)) {
    const idx = parseInt(m[1], 10);
    const e = out.get(idx) ?? { index: idx, macroName: '', progName: '' };
    if (m[2] === 'MACRO_NAME') e.macroName = m[3].trim(); else e.progName = m[3].trim();
    out.set(idx, e);
  }
  return [...out.values()].filter(e => e.macroName && e.progName);
}

export interface PayloadEntry {
  index: number;
  /** the pendant's schedule comment; empty when the schedule was never set up */
  comment: string;
  /** false when $COMMENT reads `Uninitialized` - the schedule still carries the model's default mass */
  initialized: boolean;
  /** kg */
  mass: number;
  /** centre of gravity from the faceplate, mm */
  cg: { x: number; y: number; z: number };
  /** kg·cm² as the controller stores it */
  inertia: { ix: number; iy: number; iz: number };
}

export interface PayloadTable {
  schedules: PayloadEntry[];
  /** $GROUP[1].$PAYLOAD - the mass the controller is using right now, kg */
  activeMass?: number;
}

/**
 * symotn.va (the text form of SYSMOTN.SV):
 *   [*SYSTEM*]$PLST_GRP1  Storage: SHADOW  Access: RO  : ARRAY[10] OF PLST_GRP_T
 *        Field: $PLST_GRP1[2].$COMMENT Access: RO: STRING[17] = 'Tool w/o Part'
 *        Field: $PLST_GRP1[2].$PAYLOAD Access: RO: REAL = 1.107330e+02
 *        Field: $PLST_GRP1[2].$PAYLOAD_X Access: RO: REAL = -2.611000e+00
 *        Field: $PLST_GRP1[2].$PAYLOAD_IX Access: RO: REAL = 9.680537e+04
 *        Field: $PLST_GRP1[4].$COMMENT Access: RO: STRING[17] = Uninitialized
 *
 * `$PLST_GRP1[n]` is payload schedule n for motion group 1 - what `PAYLOAD[n]` in a TP
 * program selects. Group 1 only, like every other reader here.
 */
export function parsePayloads(text: string): PayloadTable {
  const out: PayloadTable = { schedules: [] };
  if (!/\$PLST_GRP1\b/.test(text)) return out;
  const map = new Map<number, PayloadEntry>();
  for (const m of text.matchAll(/\$PLST_GRP1\[(\d+)\]\.\$(COMMENT|PAYLOAD(?:_I?[XYZ])?)\b[^=\r\n]*=\s*(.*?)\s*$/gm)) {
    const idx = parseInt(m[1], 10);
    const e = map.get(idx) ?? { index: idx, comment: '', initialized: false, mass: 0, cg: { x: 0, y: 0, z: 0 }, inertia: { ix: 0, iy: 0, iz: 0 } };
    const v = m[3];
    switch (m[2]) {
      case 'COMMENT': { const q = /^'(.*)'$/.exec(v); e.comment = q ? q[1].trim() : ''; e.initialized = !!q; break; }
      case 'PAYLOAD': e.mass = parseFloat(v); break;
      case 'PAYLOAD_X': e.cg.x = parseFloat(v); break;
      case 'PAYLOAD_Y': e.cg.y = parseFloat(v); break;
      case 'PAYLOAD_Z': e.cg.z = parseFloat(v); break;
      case 'PAYLOAD_IX': e.inertia.ix = parseFloat(v); break;
      case 'PAYLOAD_IY': e.inertia.iy = parseFloat(v); break;
      case 'PAYLOAD_IZ': e.inertia.iz = parseFloat(v); break;
    }
    map.set(idx, e);
  }
  out.schedules = [...map.values()].sort((a, b) => a.index - b.index);
  const active = /\$GROUP\[1\]\.\$PAYLOAD\b[^=\r\n]*=\s*(-?[\d.]+(?:e[+-]?\d+)?)/i.exec(text);
  if (active) out.activeMass = parseFloat(active[1]);
  return out;
}

/** "110.7 kg · CoG -2.6 / 29.6 / 26.4 mm" - the one-line form for trees and hovers */
export function describePayload(p: PayloadEntry): string {
  if (!p.initialized) return `${trimNum(String(p.mass))} kg · not set up`;
  return `${trimNum(String(p.mass))} kg · CoG ${trimNum(String(p.cg.x))} / ${trimNum(String(p.cg.y))} / ${trimNum(String(p.cg.z))} mm`;
}

function trimNum(s: string): string {
  const n = parseFloat(s);
  if (Number.isNaN(n)) return s;
  return Number.isInteger(n) ? String(n) : n.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}

export { robotNameFromFolder, ROBOT_FOLDER_PATTERNS, folderDate } from '@core/backupFolders';

/** Which .va file names we know how to read, lower-cased. */
export const KNOWN_VA_FILES = ['numreg.va', 'posreg.va', 'strreg.va', 'diocfgsv.va', 'sysmacro.va', 'sysframe.va', 'symotn.va', 'sysmotn.va'] as const;
