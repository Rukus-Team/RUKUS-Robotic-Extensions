// Gives every still-undescribed system variable a description guessed from its NAME:
// the parent structure's documented name, then the field's words with FANUC's usual
// abbreviations expanded. Written as `source: "inferred"` and never over a description
// that exists, so the hover and RUKUS can both say "this is a guess" - which is the whole
// point of keeping "inferred" apart from "manual".
//
//   node scripts/infer-sysvar-descriptions.mjs <SysVarsReference.json> [--write]
import fs from 'node:fs';

const [jsonPath, ...flags] = process.argv.slice(2);
if (!jsonPath) { console.error('usage: infer-sysvar-descriptions.mjs <SysVarsReference.json> [--write]'); process.exit(2); }
const write = flags.includes('--write');

// Conservative: only expansions that are unambiguous in FANUC's own naming.
const WORDS = {
  ENB: 'enable', ENBL: 'enable', DSBL: 'disable', NUM: 'number', NO: 'number', CNT: 'count', CNTR: 'counter', STAT: 'status', STS: 'status',
  MAX: 'maximum', MIN: 'minimum', TIM: 'time', TIME: 'time', TMR: 'timer', MSK: 'mask', MASK: 'mask', CFG: 'configuration', CONFIG: 'configuration',
  GRP: 'group', POS: 'position', VEL: 'velocity', ACC: 'acceleration', ACCEL: 'acceleration', DECEL: 'deceleration', SPD: 'speed', SPEED: 'speed',
  OVRD: 'override', OVERRIDE: 'override', IDX: 'index', PTR: 'pointer', ERR: 'error', ALM: 'alarm', MSG: 'message', DEF: 'default', DFLT: 'default',
  CUR: 'current', CURR: 'current', PREV: 'previous', TOL: 'tolerance', LIM: 'limit', LMT: 'limit', FLG: 'flag', TYP: 'type', TYPE: 'type', LEN: 'length',
  ADDR: 'address', DI: 'digital input', DO: 'digital output', DIN: 'digital input', DOUT: 'digital output', UF: 'user frame', UT: 'tool frame',
  UFRAME: 'user frame', UTOOL: 'tool frame', JNT: 'joint', CART: 'cartesian', MTN: 'motion', MOTN: 'motion', PRG: 'program', PROG: 'program',
  TP: 'teach pendant', SW: 'switch', VAL: 'value', STR: 'string', CHK: 'check', REQ: 'request', RESP: 'response', DLY: 'delay', INTVL: 'interval',
  AUTO: 'automatic', MAN: 'manual', RMT: 'remote', LCL: 'local', DIST: 'distance', ANG: 'angle', DEG: 'degrees', MM: 'mm', SEC: 'seconds', MS: 'milliseconds',
  PCT: 'percent', PRC: 'percent', TRQ: 'torque', TORQ: 'torque', TEMP: 'temperature', BAT: 'battery', ENC: 'encoder', PLS: 'pulse', SRVO: 'servo', SV: 'servo',
  AMP: 'amplifier', MTR: 'motor', BRK: 'brake', COL: 'collision', DCS: 'DCS', PAYLOAD: 'payload', LOAD: 'load', WT: 'weight', CG: 'centre of gravity',
  IX: 'inertia X', IY: 'inertia Y', IZ: 'inertia Z', ORNT: 'orientation', ROT: 'rotation', TRANS: 'translation', OFS: 'offset', OFST: 'offset', OFFSET: 'offset',
  CAL: 'calibration', CALIB: 'calibration', MSTR: 'master', MAST: 'mastering', REF: 'reference', HIS: 'history', HIST: 'history', LOG: 'log', BUF: 'buffer',
  SZ: 'size', SIZE: 'size', CH: 'channel', PORT: 'port', COMM: 'communication', ENET: 'ethernet', HOST: 'host', DEV: 'device', FILE: 'file', DIR: 'directory',
  SCR: 'screen', DISP: 'display', KEY: 'key', BTN: 'button', LED: 'LED', UI: 'UOP input', UO: 'UOP output', SI: 'SOP input', SO: 'SOP output', GI: 'group input',
  GO: 'group output', AI: 'analog input', AO: 'analog output', RI: 'robot input', RO: 'robot output', WI: 'weld input', WO: 'weld output',
  PL: 'pallet', VIS: 'vision', CAM: 'camera', SNSR: 'sensor', TRK: 'tracking', CNVY: 'conveyor', CONV: 'conveyor', WLD: 'weld', SPOT: 'spot weld', ARC: 'arc weld',
  TCP: 'TCP', ID: 'id', SEQ: 'sequence', STP: 'step', STEP: 'step', TASK: 'task', THRD: 'thread', PRIO: 'priority', OPT: 'option', OPTN: 'option',
  VER: 'version', VERS: 'version', REV: 'revision', DATE: 'date', YR: 'year', MON: 'month', DAY: 'day', HR: 'hour', HOUR: 'hour', MINS: 'minutes',
  X: 'X', Y: 'Y', Z: 'Z', W: 'W', P: 'P', R: 'R', J1: 'J1', J2: 'J2', J3: 'J3', J4: 'J4', J5: 'J5', J6: 'J6', E1: 'E1', E2: 'E2', E3: 'E3',
};

/** `$SCR_GRP[1].$M_POS_ENB` → ['M', 'POS', 'ENB'] of the last segment */
function words(seg) { return seg.replace(/^\$/, '').replace(/\[[^\]]*\]$/, '').split('_').filter(Boolean); }
function humanise(seg) {
  const out = words(seg).map(w => WORDS[w.toUpperCase()] ?? (/^\d+$/.test(w) ? w : w.toLowerCase()));
  const s = out.join(' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const ref = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
const byPath = new Map(ref.map(r => [r.path.toUpperCase(), r]));

/** the nearest ancestor with a described (manual) entry, and its documented Name */
function parentLabel(path) {
  let p = path.toUpperCase();
  for (;;) {
    const dot = p.lastIndexOf('.');
    if (dot < 0) return undefined;
    p = p.slice(0, dot);
    const anc = byPath.get(p) ?? byPath.get(p.replace(/\[[^\]]*\]$/, ''));
    if (anc?.description && anc.source === 'manual') {
      // manual descriptions read "Name — text"; the Name is the useful half here
      const name = anc.description.split(' — ')[0];
      return name.length <= 60 ? name : undefined;
    }
    if (anc?.description) return humanise(p.slice(p.lastIndexOf('.') + 1));
  }
}

let inferred = 0;
for (const r of ref) {
  if (r.description) continue;
  const segs = r.path.split('.');
  const last = segs[segs.length - 1];
  const field = humanise(last);
  const parent = segs.length > 1 ? parentLabel(r.path) : undefined;
  const arrayNote = /\[[^\]]*\]$/.test(last) ? ' (array element)' : '';
  r.description = parent ? `${parent} — ${field}${arrayNote}` : `${field}${arrayNote}`;
  r.source = 'inferred';
  inferred++;
}
console.log(`inferred ${inferred} descriptions; ${ref.filter(r => r.description).length} of ${ref.length} now described (${ref.filter(r => r.source === 'manual').length} manual, ${ref.filter(r => r.source === 'inferred').length} inferred)`);
for (const p of ['$SCR_GRP[1].$M_POS_ENB', '$PARAM_GROUP[1].$PAYLOAD_IX', '$DMR_GRP[1].$MASTER_COUN[1]', '$MRR_GRP[1].$MAX_PAYLOAD', '$AAVM_WRK[1].$EXPOSURE']) {
  const r = byPath.get(p); if (r) console.log(`  ${p} => [${r.source}] ${r.description}`);
}
if (write) { fs.writeFileSync(jsonPath, JSON.stringify(ref, null, 1) + '\n'); console.log(`written ${jsonPath}`); }
else console.log('(dry run - pass --write to save)');
