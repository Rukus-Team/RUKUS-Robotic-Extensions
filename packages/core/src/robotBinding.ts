/**
 * Which robot a file belongs to.
 *
 * A file's robot is not "whichever robot happens to be connected" - it is the one its own
 * container names. A `fanuc://` document belongs to the robot in its authority; a local file
 * inside a robot container belongs to the marker's `controller` (a cell controller) or, when
 * there is none, the marker's own name. Only a file that is in no container is ambiguous
 * enough to be worth asking about.
 *
 * `pinned` marks a binding the user fixed on purpose (a `controller`, or a robot's own file):
 * when no profile matches a pinned name, the action is refused rather than silently aimed at
 * another robot - pushing to the wrong controller is worse than not pushing.
 */
import * as vscode from 'vscode';
import type { Services } from './services';
import type { RobotMarker } from './robotContainers';
import { FANUC_SCHEME } from './live/fs';

export interface BoundRobot {
  /** the robot name the file's container (or URI) declares */
  name: string;
  /** fixed on purpose - never silently substitute another robot */
  pinned: boolean;
}

/** The robot a marker names: its bound controller, else the marker's own name. */
export function markerBoundRobot(marker: RobotMarker): BoundRobot {
  return marker.controller ? { name: marker.controller, pinned: true } : { name: marker.name, pinned: false };
}

/** The robot a file names, from a `fanuc://` authority or its own container. */
export function boundRobot(s: Services, uri: vscode.Uri): BoundRobot | undefined {
  if (uri.scheme === FANUC_SCHEME) return { name: decodeURIComponent(uri.authority), pinned: true };
  if (uri.scheme !== 'file') return undefined;
  const marker = s.containers.markerOf(uri.fsPath);
  return marker ? markerBoundRobot(marker) : undefined;
}

/** The case-insensitive robot profile of a given name, if one is configured. */
export function profileNamed<T extends { profile: { name: string } }>(robots: readonly T[], name: string): T | undefined {
  const n = name.trim().toLowerCase();
  return robots.find(c => c.profile.name.toLowerCase() === n);
}
