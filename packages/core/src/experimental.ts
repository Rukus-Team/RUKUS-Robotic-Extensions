/**
 * Experimental features: everything that talks to a controller.
 *
 * The file tier - backups, the editors, diagnostics, reports, RUKUS's clusters - is the
 * product and is always on. Connecting to a robot (FTP/HTTP reads, the Controllers view,
 * teach from the robot, snapshot from the robot, upload and live edit) is still being proven
 * on real cells, so it waits behind `robotCode.experimental.robotConnections`, off by
 * default. The manifest hides the view and the commands on the `config.` key; this module is
 * the runtime half, so a command reached some other way (a keybinding, a link in a hover,
 * another extension) still stops at the same gate.
 */
import * as vscode from 'vscode';

export const ROBOT_CONNECTIONS_SETTING = 'experimental.robotConnections';

/** true when the user has ticked "Experimental: Robot Connections" */
export function robotConnectionsEnabled(): boolean {
  return vscode.workspace.getConfiguration('robotCode').get<boolean>(ROBOT_CONNECTIONS_SETTING, false);
}

/**
 * The gate a robot command passes first. Off: says why nothing happened, offers the
 * setting, and returns false - the command does nothing, it never half-runs.
 */
export function requireRobotConnections(): boolean {
  if (robotConnectionsEnabled()) return true;
  void vscode.window.showInformationMessage(
    'Talking to a robot is an experimental feature. Tick "Robot Code › Experimental: Robot Connections" in Settings to use it.',
    'Open Setting').then(pick => {
    if (pick) void vscode.commands.executeCommand('workbench.action.openSettings', `robotCode.${ROBOT_CONNECTIONS_SETTING}`);
  });
  return false;
}

/** wraps a command handler in the gate */
export function gated<A extends any[], R>(fn: (...a: A) => R): (...a: A) => R | undefined {
  return (...a: A) => (requireRobotConnections() ? fn(...a) : undefined);
}
