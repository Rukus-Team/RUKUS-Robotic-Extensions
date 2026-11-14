/**
 * Where a signal is assigned: IOCONFIG.DG's rack / slot / port lines, read from a real V7.70
 * SpotTool+ file (test/fixtures-ioconfig/ioconfig.dg - kept byte for byte) and from a V9.40
 * HandlingTool virtual controller's (ioconfig-v940-roboguide.dg: analog signals, UI / UO), and the
 * text the hover shows for them. Wired in by test/run.ts.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseIoConfig, assignmentOf, describeAssignment, RACK_NAMES, IO_CONFIG_MAX_CHARS } from '@fanuc/data/ioConfig';

type Check = (cond: unknown, msg: string) => void;

export function run(check: Check, root: string): void {
  const real = parseIoConfig(fs.readFileSync(path.join(root, 'test', 'fixtures-ioconfig', 'ioconfig.dg'), 'latin1'));
  const count = (kind: string) => real.filter(r => r.kind === kind).length;
  check(real.length === 233 && count('DI') === 110 && count('DO') === 110 && count('GI') === 3 && count('GO') === 10,
    `the real file gives 233 entries, DI 110, DO 110, GI 3, GO 10: ${real.length} entries, DI ${count('DI')}, DO ${count('DO')}, GI ${count('GI')}, GO ${count('GO')}`);
  check(JSON.stringify(real[0]) === JSON.stringify({ kind: 'DI', first: 1, last: 8, at: { rack: 89, slot: 1, port: 1 } }), `the first entry: ${JSON.stringify(real[0])}`);

  check(parseIoConfig('DOUT 1017 -1024   RACK:   0   SLOT:   0   PORT:   1\r\n').length === 1, 'a last number touching the dash is still a range');
  const none: [string, string | undefined][] = [
    ['undefined', undefined], ['an empty string', ''], ['a signal comment line', 'DIN[   1]  NEW RACK LOADED\n'], ['an unknown signal type', 'XYZ 1 - 8 RACK: 89 SLOT: 1 PORT: 1\n'],
    ['a range that runs backwards', 'DIN 9 - 8 RACK: 89 SLOT: 1 PORT: 1\n'], ['a text over the size bound', 'DIN 1 - 8 RACK: 89 SLOT: 1 PORT: 1\n' + ' '.repeat(IO_CONFIG_MAX_CHARS)],
  ];
  for (const [what, text] of none) check(parseIoConfig(text).length === 0, `${what} gives no entries`);

  const di20 = assignmentOf(real, 'DI', 20);
  check(di20?.rack === 89 && di20.slot === 1 && di20.port === 20, `DI[20] is rack 89, slot 1, port 20: ${JSON.stringify(di20)}`);
  check(assignmentOf(real, 'GI', 1)?.bits === 8, `GI[1] is a group of 8 bits: ${JSON.stringify(assignmentOf(real, 'GI', 1))}`);
  check(assignmentOf(real, 'GI', 2) === undefined && assignmentOf(real, 'AI', 1) === undefined, 'a signal the file does not list has no assignment');

  const v940 = parseIoConfig(fs.readFileSync(path.join(root, 'test', 'fixtures-ioconfig', 'ioconfig-v940-roboguide.dg'), 'latin1'));
  const count940 = (kind: string) => v940.filter(r => r.kind === kind).length;
  check(v940.length === 42 && count940('DI') === 6 && count940('DO') === 6 && count940('AI') === 18 && count940('AO') === 6 && count940('UI') === 3 && count940('UO') === 3,
    `the V9.40 file gives 42 entries, DI 6, DO 6, AI 18, AO 6, UI 3, UO 3: ${v940.length} entries, DI ${count940('DI')}, DO ${count940('DO')}, AI ${count940('AI')}, AO ${count940('AO')}, UI ${count940('UI')}, UO ${count940('UO')}`);
  const ai8 = assignmentOf(v940, 'AI', 8);
  check(ai8?.rack === 0 && ai8.slot === 2 && ai8.port === 2 && ai8.channel === true, `AI[8] is rack 0, slot 2, channel 2: ${JSON.stringify(ai8)}`);
  check(!!ai8 && describeAssignment(ai8) === 'Rack 0 (process I/O boards (also memory image)), slot 2, channel 2', `an analog signal says channel: ${ai8 && describeAssignment(ai8)}`);
  check(assignmentOf(v940, 'UI', 12)?.port === 12 && assignmentOf(v940, 'UO', 20)?.port === 20 && assignmentOf(v940, 'UI', 19) === undefined, 'a UOP signal gets its own port; one outside the ranges has none');
  check(describeAssignment({ rack: 2, slot: 1, port: 5, channel: true }) === 'Rack 2, slot 1, channel 5', 'an analog signal on a rack with no known name');

  check(describeAssignment({ rack: 89, slot: 1, port: 20 }) === 'Rack 89 (EtherNet/IP (ControlNet over Ethernet) I/O), slot 1, port 20', `a named rack: ${describeAssignment({ rack: 89, slot: 1, port: 20 })}`);
  check(describeAssignment({ rack: 33, slot: 3, port: 889, bits: 8 }) === 'Rack 33 (internal relay/register), slot 3, port 889, 8 bits', `a group adds its bits: ${describeAssignment({ rack: 33, slot: 3, port: 889, bits: 8 })}`);
  check(describeAssignment({ rack: 35, slot: 1, port: 1 }) === 'Rack 35, slot 1 (always on)' && describeAssignment({ rack: 35, slot: 0, port: 1 }) === 'Rack 35, slot 0 (always off)', 'rack 35 reads always on / always off');
  check(describeAssignment({ rack: 2, slot: 3, port: 1 }) === 'Rack 2, slot 3, port 1', `a rack with no known name shows its number only: ${describeAssignment({ rack: 2, slot: 3, port: 1 })}`);
  check(RACK_NAMES[99] === 'PROFINET I/O Controller' && RACK_NAMES[100] === 'PROFINET I/O Device' && RACK_NAMES[1] === undefined, 'rack names: 99 and 100 are PROFINET, 1 has none');
}
