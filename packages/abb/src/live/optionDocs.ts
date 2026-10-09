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
      'It also brings Socket Messaging for RAPID. Robot Code\'s Network card uses it to say whether the controller can be reached without the service port.',
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

/** "616-1 PC Interface" -> { code: "616-1", name: "PC Interface" }; a plain name keeps no code. */
export function splitAbbOption(text: string): { code: string; name: string } {
  const m = /^\s*(\d{3,4}-\d+)\s+(.*)$/.exec(text);
  return m ? { code: m[1], name: m[2].trim() } : { code: '', name: text.trim() };
}
