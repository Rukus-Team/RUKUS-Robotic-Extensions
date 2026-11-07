/**
 * Where a file opened from a controller (fanuc://<robot>/<DEVICE>/<FILE>) came from, in words.
 * Pure, so tests pin it.
 */

/**
 * VS Code lower-cases a URI's authority, so `fanuc://r1/...` is robot R1: the profile's own
 * spelling when one matches, else the authority as it is.
 */
export function robotDisplayName(authority: string, names: readonly string[]): string {
  const robot = decodeURIComponent(authority);
  return names.find(n => n === robot) ?? names.find(n => n.toLowerCase() === robot.toLowerCase()) ?? robot;
}

/** "12 s ago", "3 min ago", "2 h ago" */
function age(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s} s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
}

/**
 * The hover line for a program opened from a robot: which robot, which device, when it was read,
 * and that the register values shown are read from the controller, not from a backup.
 */
export function robotOriginNote(robot: string, device: string, file: string, readAt: number | undefined, now = Date.now()): string {
  const when = readAt === undefined ? '' : ` ${age(now - readAt)} (${new Date(readAt).toLocaleTimeString()})`;
  return `_Opened from **${robot}** ${device.replace(/:?$/, ':')}${file}, read${when || ' when it was opened'}. This is the controller's copy (read-only); its controller data is read live from ${robot}, not from a backup folder._`;
}
