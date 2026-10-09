/**
 * FANUC software options, explained for the option lists (core/src/live/optionInfo.ts). Matched
 * on "<code> <name>" as ORDERFIL.DAT lists them; an entry names an order code only where Robot
 * Code already relies on it (controllerOptions.ts), otherwise it matches the option's name.
 */
import type { OptionDoc } from '@core/live/optionInfo';

export const FANUC_OPTION_DOCS: readonly OptionDoc[] = [
  {
    match: /\bR507\b|ascii upload/i, title: 'ASCII Upload',
    short: 'The controller can load programs sent as text (.LS).',
    full: [
      'Without it a controller only takes compiled teach pendant programs (.TP); a .LS file copied to it is not turned into a program.',
      'The extension needs it (or ASCII Program Loader) to Push or Live Edit a .LS program. Without either, load the .TP that ROBOGUIDE or a controller with the option compiled.',
    ],
  },
  {
    match: /\bR796\b|ascii program loader/i, title: 'ASCII Program Loader',
    short: 'Loads .LS text programs from a device on the controller.',
    full: [
      'Converts a .LS text program into a teach pendant program on the controller, from a memory device or the controller\'s own file system.',
      'The extension counts it like ASCII Upload: either one lets a .LS be pushed.',
    ],
  },
  {
    match: /\bR632\b|\bkarel\b/i, title: 'KAREL',
    short: 'Runs compiled KAREL programs (.PC).',
    full: [
      'KAREL is FANUC\'s Pascal-like programming language. Programs are compiled with ktrans into .PC files; the controller runs them only with this option.',
      'Without it, KAREL programs can still be written and compiled on the PC, but a .PC copied to the robot does not run.',
    ],
  },
  {
    match: /\bR641\b|pc interface/i, title: 'PC Interface',
    short: 'Lets PC software built on FANUC\'s PC SDK connect to the controller.',
    full: [
      'Tools built on FANUC\'s PC Developer\'s Kit read and write registers, I/O, positions and variables over Ethernet through it.',
      'The extension itself reads the controller over its web server and FTP and does not need it.',
    ],
  },
  {
    match: /\bR648\b|socket messag/i, title: 'User Socket Messaging',
    short: 'KAREL programs can open TCP/IP sockets.',
    full: [
      'Gives KAREL client and server tags (C1:, S1: ...) for TCP/IP connections: talking to a PC, a camera or another controller over plain sockets.',
    ],
  },
  {
    match: /collision guard/i, title: 'Collision Guard',
    short: 'Stops the robot when the motors feel an unexpected force.',
    full: [
      'Watches the motor torque against what the motion model expects and stops the robot when the difference says it hit something. The sensitivity can be set per program.',
    ],
  },
  {
    match: /\bdcs\b|dual check safety/i, title: 'Dual Check Safety (DCS)',
    short: 'Safety-rated position, speed and I/O checks run on two CPUs.',
    full: [
      'Dual Check Safety limits where the robot may go, how fast, and which tool it may carry, with the checks done twice and compared - the basis for fenceless or reduced-fence cells.',
      'Its settings are safety parameters: changed on the teach pendant with the DCS password, and part of the cell\'s risk assessment.',
    ],
  },
  {
    match: /irvision|\b2dv\b|\b3dl\b/i, title: 'iRVision',
    short: 'FANUC\'s built-in machine vision.',
    full: [
      'Camera-based part location and inspection run on the robot controller itself, with vision processes called from TP programs (VISION RUN_FIND, GET_OFFSET...).',
    ],
  },
  {
    match: /ethernet\/ip|ethernetip/i, title: 'EtherNet/IP',
    short: 'Talks EtherNet/IP to a PLC or devices (adapter and/or scanner).',
    full: [
      'As an adapter the robot is a device a PLC scans; as a scanner it reads and writes devices itself. The I/O shows up as DI / DO / GI / GO mapped to a rack and slot.',
    ],
  },
  {
    match: /profinet/i, title: 'PROFINET',
    short: 'Talks PROFINET to a PLC or devices.',
    full: ['Industrial Ethernet I/O, typical with Siemens PLCs. Like EtherNet/IP, the exchanged data is mapped to the robot\'s digital and group I/O.'],
  },
  {
    match: /constant path/i, title: 'Constant Path',
    short: 'The robot keeps the same path when the speed override changes.',
    full: ['Without it, corner rounding (CNT) depends on speed, so a program tested at low override can take a different path at 100%.'],
  },
  {
    match: /multi.?group|multiple motion group/i, title: 'Multi-Group Motion',
    short: 'More than one motion group on one controller.',
    full: ['Several arms, or an arm with positioners or rails as separate groups, each with its own group mask in TP programs.'],
  },
  {
    match: /space check|interference check/i, title: 'Space Check / Interference Check',
    short: 'Stops the robot before it enters a defined space.',
    full: ['Defines boxes the TCP or the robot may not enter (or must stay in), checked while it moves - for shared spaces between robots or with fixtures.'],
  },
];

/** What a FANUC order code alone says, when no entry matches. */
export function fanucCodeNote(code: string): string | undefined {
  if (/^H\d{3}$/.test(code)) return `${code} is an H-code: the application software, the robot model or a language dictionary.`;
  if (/^R\d{3}$/.test(code)) return `${code} is an R-code: a software option.`;
  if (/^J\d{3}$/.test(code)) return `${code} is a J-code: an option tied to hardware or vision.`;
  if (/^[A-Z]\d{3}$/.test(code)) return `${code} is a FANUC order code.`;
  return undefined;
}
