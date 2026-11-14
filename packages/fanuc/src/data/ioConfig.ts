/**
 * Where a signal is assigned - rack, slot, port - from a backup's IOCONFIG.DG.
 *
 * Pure text in, data out: no vscode import and no file access (the data store reads the file).
 * The file is whatever sits in a backup folder under that name, so it is read as untrusted
 * input: a size bound, patterns anchored to a whole line, and nothing in it is ever run.
 * RUKUS shows the same text for the same signal, so the wording and the rack names here stay
 * as they are.
 */
export interface IoAssignment {
  rack: number; slot: number; port: number; bits?: number;
  /** an analog signal: `port` is its channel, and is said as one */
  channel?: boolean;
}
export interface IoRange { kind: string; first: number; last: number; at: IoAssignment }

/** the most text read: the sample is 40 KB, a file far beyond this is not an IOCONFIG.DG */
export const IO_CONFIG_MAX_CHARS = 4_000_000;

const PREFIX: Record<string, string> = {
  DIN: 'DI', DOUT: 'DO', RI: 'RI', RO: 'RO', RDI: 'RI', RDO: 'RO', GIN: 'GI', GOUT: 'GO', AIN: 'AI', AOUT: 'AO',
  UI: 'UI', UO: 'UO', UOPIN: 'UI', UOPOUT: 'UO', SI: 'SI', SO: 'SO', SOPIN: 'SI', SOPOUT: 'SO', FLG: 'F', MRK: 'M', WDI: 'WI', WDO: 'WO', WSI: 'WSI', WSO: 'WSO',
};

/** FANUC's own names for the rack numbers (vendor vocabulary) */
export const RACK_NAMES: Readonly<Record<number, string>> = {
  0: 'process I/O boards (also memory image)', 16: 'AB or Genius I/O', 32: 'Slave SLC2 I/O', 33: 'internal relay/register',
  34: 'flag marker', 35: 'always on/off port', 36: 'DCS port', 48: 'address mapped I/O for LR Mate Peripheral connectors',
  64: 'ME-NET', 65: 'INTERBUS-S', 66: 'PROFIBUS DP master', 67: 'PROFIBUS DP slave', 68: 'FL-net', 69: 'FL-net status',
  70: 'InterBus-S master', 71: 'InterBus-S slave', 72: 'IO-LINK II master', 73: 'IO-LINK II slave', 74: 'FIPIO master',
  75: 'FIPIO slave', 81: 'first DeviceNet board', 82: 'DeviceNet', 83: 'DeviceNet', 84: 'DeviceNet', 85: 'ControlNet',
  86: 'ControlNet', 87: 'RoboWeld', 88: 'Ethernet Global Data (GE-EGD I/O)', 89: 'EtherNet/IP (ControlNet over Ethernet) I/O',
  90: 'ArcLink', 91: 'WTC Serial Weld Controller I/O', 92: 'CC-Link RD', 93: 'InterBus PxC PCI master',
  94: 'InterBus PxC PCI slave', 95: 'InterBus PxC PCI cmd', 96: 'Modbus TCP', 97: 'TOYOPUC PC3J Interface',
  98: 'InterBus PxC Slave interface', 99: 'PROFINET I/O Controller', 100: 'PROFINET I/O Device',
};

// the file's three line shapes; every other line (header, signal comments) is passed over:
//   DIN    1  -   8   RACK:  89   SLOT:   1   PORT:   1          a range
//   GIN    1   RACK:  89   SLOT:   1   PORT:  17   #NUM:   8     a group and its number of bits
//   AIN    1   RACK:   0   SLOT:   1   CHANNEL:   1              an analog signal (seen on a V9.40 controller)
const RANGE = /^[ \t]*([A-Z]+)[ \t]+(\d{1,6})[ \t]*-[ \t]*(\d{1,6})[ \t]+RACK:[ \t]*(\d{1,6})[ \t]+SLOT:[ \t]*(\d{1,6})[ \t]+PORT:[ \t]*(\d{1,6})[ \t]*\r?$/gm;
const GROUP = /^[ \t]*([A-Z]+)[ \t]+(\d{1,6})[ \t]+RACK:[ \t]*(\d{1,6})[ \t]+SLOT:[ \t]*(\d{1,6})[ \t]+PORT:[ \t]*(\d{1,6})[ \t]+#NUM:[ \t]*(\d{1,6})[ \t]*\r?$/gm;
const CHANNEL = /^[ \t]*([A-Z]+)[ \t]+(\d{1,6})[ \t]+RACK:[ \t]*(\d{1,6})[ \t]+SLOT:[ \t]*(\d{1,6})[ \t]+CHANNEL:[ \t]*(\d{1,6})[ \t]*\r?$/gm;

/** the assignments in IOCONFIG.DG's text; none for text that is not one */
export function parseIoConfig(text: string | undefined): IoRange[] {
  if (!text || text.length > IO_CONFIG_MAX_CHARS) return [];
  const out: IoRange[] = [];
  for (const m of text.matchAll(RANGE)) {
    const kind = PREFIX[m[1]];
    const [first, last, rack, slot, port] = m.slice(2, 7).map(n => parseInt(n, 10));
    if (kind && last >= first) out.push({ kind, first, last, at: { rack, slot, port } });
  }
  for (const m of text.matchAll(GROUP)) {
    const kind = PREFIX[m[1]];
    const [index, rack, slot, port, bits] = m.slice(2, 7).map(n => parseInt(n, 10));
    if (kind) out.push({ kind, first: index, last: index, at: { rack, slot, port, bits } });
  }
  for (const m of text.matchAll(CHANNEL)) {
    const kind = PREFIX[m[1]];
    const [index, rack, slot, port] = m.slice(2, 6).map(n => parseInt(n, 10));
    if (kind) out.push({ kind, first: index, last: index, at: { rack, slot, port, channel: true } });
  }
  return out;
}

/** where signal kind[index] is assigned: its own port inside its range, a group's first port and bits */
export function assignmentOf(ranges: readonly IoRange[], kind: string, index: number): IoAssignment | undefined {
  const r = ranges.find(x => x.kind === kind && index >= x.first && index <= x.last);
  return r ? { ...r.at, port: r.at.port + (index - r.first) } : undefined;
}

/** "Rack 89 (EtherNet/IP ...), slot 1, port 20"; a group adds its bits; an analog signal says channel; rack 35 says the value its slot stands for */
export function describeAssignment(a: IoAssignment): string {
  if (a.rack === 35 && (a.slot === 0 || a.slot === 1)) return `Rack 35, slot ${a.slot} (always ${a.slot === 1 ? 'on' : 'off'})`;
  const name = RACK_NAMES[a.rack];
  const place = `Rack ${a.rack}${name ? ` (${name})` : ''}, slot ${a.slot}, ${a.channel ? 'channel' : 'port'} ${a.port}`;
  return a.bits !== undefined ? `${place}, ${a.bits} bits` : place;
}
