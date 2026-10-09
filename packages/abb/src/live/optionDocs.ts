/**
 * ABB RobotWare options, explained for the controller page's option list (core/src/live/optionInfo.ts).
 * RobotWare lists an option by name, often with its order number ("616-1 PC Interface"); entries
 * match the name, so they hold whether or not the number is there.
 */
import type { OptionDoc } from '@core/live/optionInfo';

export const ABB_OPTION_DOCS: readonly OptionDoc[] = [
  {
    match: /pc interface/i, title: 'PC Interface',
    short: 'PC software (Robot Web Services, PC SDK) can reach the controller off the service port.',
    full: [
      'On an IRC5, Robot Web Services and PC SDK applications answer on the WAN (factory network) port only with this option; without it, only on the service port, 192.168.125.1.',
      'It also brings Socket Messaging for RAPID. The Network card of the controller page uses it to say whether the controller can be reached without the service port.',
    ],
  },
  {
    match: /multitasking/i, title: 'Multitasking',
    short: 'More than one RAPID task runs at the same time.',
    full: ['Extra normal, static or semistatic tasks next to the motion task - for supervision, communication or a PLC-like background loop. Tasks share data through PERS variables.'],
  },
  {
    match: /multimove/i, title: 'MultiMove',
    short: 'One controller runs several robots, coordinated or independent.',
    full: ['Up to four robots on one controller, each with its own motion task. Coordinated MultiMove synchronises their moves (SyncMoveOn / SyncMoveOff); Independent lets each run on its own.'],
  },
  {
    match: /world zones/i, title: 'World Zones',
    short: 'Boxes, cylinders or spheres the TCP or axes may not enter, or that set an output.',
    full: ['Defined in RAPID (WZBoxDef, WZLimSup, WZDOSet...). A zone can stop the robot before it enters, or set a signal while the robot is inside - for shared spaces and interlocks.'],
  },
  {
    match: /collision detection/i, title: 'Collision Detection',
    short: 'Stops the robot when the motors feel an unexpected force.',
    full: ['Compares the motor torques with the model and stops and backs off on a collision. Its sensitivity is set in the configuration and can be tuned in RAPID (MotionSup).'],
  },
  {
    match: /path recovery/i, title: 'Path Recovery',
    short: 'Leave the path in an error handler and come back to where the robot was.',
    full: ['StorePath and RestoPath save and restore the current path, so an error handler can move the robot away (to clean a gun, re-grip) and resume exactly where it stopped.'],
  },
  {
    match: /externally guided motion|\begm\b/i, title: 'Externally Guided Motion (EGM)',
    short: 'An external computer steers the robot in real time.',
    full: ['A sensor or PC sends position or path corrections at a high rate (UDP), for tracking and guidance applications.'],
  },
  {
    match: /ethernet\/ip/i, title: 'EtherNet/IP',
    short: 'Talks EtherNet/IP to a PLC or devices (scanner and/or adapter).',
    full: ['The controller as an EtherNet/IP adapter a PLC scans, or as a scanner of its own devices. The signals appear in the I/O system (EIO.cfg) like any other.'],
  },
  {
    match: /profinet/i, title: 'PROFINET',
    short: 'Talks PROFINET to a PLC or devices.',
    full: ['As a PROFINET device under a PLC, or as controller of its own devices. The data is mapped to signals in the I/O system.'],
  },
  {
    match: /devicenet/i, title: 'DeviceNet',
    short: 'Talks DeviceNet to devices or a PLC.',
    full: ['Fieldbus I/O, as master and/or slave. Its signals are configured in the I/O system like any other.'],
  },
  {
    match: /safemove/i, title: 'SafeMove',
    short: 'Safety-rated speed, position and tool supervision.',
    full: ['Safety functions run by the controller\'s safety system: safe zones, speed limits, tool orientation and standstill supervision, configured and signed in RobotStudio.', 'Its configuration is part of the cell\'s risk assessment.'],
  },
  {
    match: /flexpendant interface|fp sdk/i, title: 'FlexPendant Interface',
    short: 'Custom FlexPendant applications can run.',
    full: ['Lets operator screens built with the FlexPendant SDK run on the pendant.'],
  },
  {
    match: /conveyor tracking/i, title: 'Conveyor Tracking',
    short: 'The robot follows a moving conveyor.',
    full: ['Work objects coupled to a conveyor encoder, so the robot picks or works on parts while they move.'],
  },
  {
    match: /robotware base|robotcontrol base/i, title: 'RobotWare base',
    short: 'The base system every controller has.',
    full: ['Not an option you buy: the RobotWare system itself, listed with the options.'],
  },
];

/** What an ABB order number alone says, when no entry matches. */
export function abbCodeNote(code: string): string | undefined {
  return /^\d{3,4}-\d+$/.test(code) ? `${code} is an ABB order number.` : undefined;
}

/**
 * What an entry of the controller's "options" list really is. RWS (/rw/system) and system.xml
 * list everything the system was built with: the options bought (with an order number), but also
 * the robot itself (IRB 6700-300/2.70), its drive system and drive units, the calibration method,
 * the language, the RobotWare base and process hardware. Only the first kind is an option.
 */
export type AbbOptionKind = 'option' | 'robot' | 'hardware' | 'system' | 'other';

export const ABB_OPTION_KINDS: ReadonlyArray<{ kind: AbbOptionKind; title: string; hint: string }> = [
  { kind: 'option', title: 'Options', hint: 'Software options bought for this controller (ABB order number first).' },
  { kind: 'robot', title: 'Robot', hint: 'The robot type and variant this system is configured for: not an option.' },
  { kind: 'hardware', title: 'Hardware', hint: 'Drive system, drive units, calibration method, cabinet and process hardware the system is configured for: not options.' },
  { kind: 'system', title: 'System', hint: 'The RobotWare / RobotControl base, the language and built-in services every system has: not options.' },
  { kind: 'other', title: 'Other', hint: 'Add-ins and entries without an order number that are not recognised here.' },
];

const LANGUAGES = /^(english|german|deutsch|french|fran[cç]ais|spanish|espa[nñ]ol|italian|italiano|portuguese|swedish|svenska|dutch|danish|finnish|norwegian|polish|czech|hungarian|turkish|russian|greek|romanian|slovenian|japanese|chinese|korean|thai|hindi|bulgarian|simplified chinese|traditional chinese)$/i;
const ROBOT = /^(IRB|IRBP|IRT|CRB|YuMi)\s?\d|^(Robots? Base|IRB \d+ Base)$/i;
const SYSTEM = /^(RobotWare|RobotControl) Base$|^Service Info System$|^Statistic functionality$|^System without axis computer$/i;
const HARDWARE = /drive system|^ADU\b|axis computer|main computer|^V\d{3}|^E\d+\b|\bfans?\b|\bfuses?\b|calibration|commutation|\bpump\b|heated|level meter|doser|applicator|\bdrives?\b|\d+\s?ccm\b|in position\b|cabinet|\bkeyless\b/i;

export function classifyAbbOption(text: string): AbbOptionKind {
  const { code, name } = splitAbbOption(text);
  if (ROBOT.test(name)) return 'robot';
  if (SYSTEM.test(name) || LANGUAGES.test(name)) return 'system';
  if (code) return 'option';
  if (HARDWARE.test(name)) return 'hardware';
  if (ABB_OPTION_DOCS.some(d => d.match.test(name) && d.title !== 'RobotWare base')) return 'option';
  return 'other';
}

/** The entries grouped by kind, in {@link ABB_OPTION_KINDS} order, each keeping its index in the list. */
export function groupAbbOptions(list: readonly string[]): Array<{ kind: AbbOptionKind; title: string; hint: string; items: Array<{ text: string; index: number }> }> {
  return ABB_OPTION_KINDS.map(k => ({ ...k, items: list.map((text, index) => ({ text, index })).filter(x => classifyAbbOption(x.text) === k.kind) })).filter(g => g.items.length);
}

/** The robot type from the list (`IRB 7600-150/3.5`): the most specific robot entry, not "IRB 7600 Base". */
export function abbRobotType(list: readonly string[]): string | undefined {
  const robots = list.filter(o => classifyAbbOption(o) === 'robot' && !/base$/i.test(o));
  return robots.sort((a, b) => b.length - a.length)[0];
}

/** "616-1 PC Interface" -> { code: "616-1", name: "PC Interface" }; a plain name keeps no code. */
export function splitAbbOption(text: string): { code: string; name: string } {
  const m = /^\s*(\d{3,4}-\d+)\s+(.*)$/.exec(text);
  return m ? { code: m[1], name: m[2].trim() } : { code: '', name: text.trim() };
}
