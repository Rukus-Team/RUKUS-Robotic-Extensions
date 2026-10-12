/**
 * Which kind of controller a connection reaches: a virtual one running on this PC (ROBOGUIDE,
 * RobotStudio) or a real one on the network. Shown wherever a connection or a write is named, so
 * a virtual controller never looks like a plant robot (and the other way round). A virtual
 * controller is one at a loopback address.
 */
export type TargetKind = 'virtual' | 'live';

export function targetKindOfHost(host: string): TargetKind {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h) ? 'virtual' : 'live';
}

/** "Virtual" or "Live", for labels such as `Live R01`. */
export const targetKindLabel = (kind: TargetKind) => (kind === 'virtual' ? 'Virtual' : 'Live');
