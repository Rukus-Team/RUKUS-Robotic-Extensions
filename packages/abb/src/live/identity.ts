/**
 * Which ABB controller is this - by its own name and id, never by its address. Every controller's
 * service port is 192.168.125.1, so the address says nothing about which robot the PC is plugged
 * into; a profile is tied to a controller by what the controller says about itself:
 *
 *   /ctrl/identity   ctrl-name, ctrl-id, ctrl-type (VIRTUAL_CONTROLLER or a real one)
 *   /rw/system       name (the system), sysid (the system's GUID), RobotWare version, options
 *
 * The system id is the key: it survives renames and is the same over the service port and the LAN.
 * Pure, so tests pin it.
 */

export interface ControllerIdentity {
  /** ctrl-name: the controller's network identity (what RobotStudio lists) */
  ctrlName?: string;
  ctrlId?: string;
  /** /rw/system name: the RobotWare system */
  systemName?: string;
  /** /rw/system sysid: a GUID, the key */
  systemId?: string;
  virtual?: boolean;
  robotWare?: string;
}

/** What a profile expects to find: set by hand in the profile, or remembered at the first connect. */
export interface ExpectedController { name?: string; id?: string }

const norm = (s: string | undefined) => s?.trim().replace(/^\{|\}$/g, '').toLowerCase() || undefined;

/**
 * The name the UI shows for a controller: its own name, else its system's. A RobotStudio virtual
 * controller's ctrl-name is the PC it runs on ("IRC5VC DESKTOP-9A0FNHB"), which says nothing about
 * which controller it is, so a virtual one is shown by its system name (irc6_testing).
 */
export const controllerLabel = (i: ControllerIdentity | undefined) =>
  i && namedAfterPc(i) ? i.systemName ?? i.ctrlName : i?.ctrlName ?? i?.systemName;

/** RobotStudio names a virtual controller after the PC: "IRC5VC DESKTOP-...", "OmniCoreVC ..." */
const namedAfterPc = (i: ControllerIdentity) => i.virtual === true || /^(IRC5|OmniCore)\s*VC(?![A-Za-z0-9_])/i.test(i.ctrlName ?? '');

/** "6.16.01.00" -> "RW 6.16"; undefined when there is no version */
export const shortRobotWare = (v: string | undefined) => (v ? `RW ${v.split('.').slice(0, 2).join('.')}` : undefined);

/** What to remember for a controller seen for the first time. */
export function expectationOf(i: ControllerIdentity): ExpectedController {
  return { name: controllerLabel(i), id: i.systemId ?? i.ctrlId };
}

/**
 * Is `seen` the controller the profile is for? Undefined when it is (or nothing is expected), else
 * why not, in words. Ids decide when both sides have one; names only when there is no id to compare.
 */
export function identityMismatch(profileName: string, host: string, expected: ExpectedController | undefined, seen: ControllerIdentity): string | undefined {
  if (!expected || (!expected.id && !expected.name)) return undefined;
  const ids = [norm(seen.systemId), norm(seen.ctrlId)].filter(Boolean);
  const want = norm(expected.id);
  if (want && ids.length) {
    if (ids.includes(want)) return undefined;
  } else {
    const names = [seen.ctrlName, seen.systemName].map(n => n?.trim().toLowerCase()).filter(Boolean);
    if (!expected.name || !names.length || names.includes(expected.name.trim().toLowerCase())) return undefined;
  }
  const found = `${controllerLabel(seen) ?? 'another controller'}${seen.systemId ? ` (system id ${seen.systemId})` : ''}`;
  const wanted = `${expected.name ?? profileName}${expected.id ? ` (system id ${expected.id})` : ''}`;
  return `${host} is ${found}, not ${wanted}. Every ABB service port is ${host === '192.168.125.1' ? 'this same address' : 'often the same address'}, so the address cannot tell robots apart: plug into ${expected.name ?? profileName}, add this controller as one of its own, or use "ABB: Forget Controller Identity" if ${profileName} really is this controller now.`;
}
