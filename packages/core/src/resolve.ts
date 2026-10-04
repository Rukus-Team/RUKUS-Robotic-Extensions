/**
 * "Where is program X, from where I am standing?"
 *
 * The index answers for the workspace and the backup folders. A file opened straight off a
 * controller (`fanuc://robot/MD/X.LS`) stands somewhere else: its neighbours are the files
 * on that robot's device, which the Files panel has already listed. So a CALL in a robot
 * file is resolved against that listing - the program IS there, even though no local
 * folder has it - and only reported missing when the listing is known and lacks it.
 */
import * as vscode from 'vscode';
import type { Services } from './services';
import type { ProgramInfo } from './workspaceIndex';
import type { ProgramKind } from './brand';
import { FANUC_SCHEME } from './live/fs';

export interface ResolvedProgram {
  uri: vscode.Uri;
  kind: ProgramKind;
  /** indexed program, when the answer came from the index */
  info?: ProgramInfo;
  /** on a controller's device, when the answer came from a robot's file listing */
  remote?: { robot: string; device: string; file: string };
}

export function resolveProgram(s: Services, name: string, near?: vscode.Uri): ResolvedProgram | undefined {
  const info = s.index.get(name, near);
  // Standing in a file on a robot, the robot's own copy is the one meant - even when a
  // backup on disk has a program of the same name. An indexed copy from the same robot
  // (opened earlier) beats the listing, because it has been read; a copy from elsewhere
  // only answers when the robot has none.
  if (near?.scheme === FANUC_SCHEME && s.live) {
    if (info && info.group === s.index.groupOf(near)) return { uri: info.uri, kind: info.kind, info };
    const robot = decodeURIComponent(near.authority);
    const r = s.live.resolveRemoteProgram(robot, name);
    if (r) return { uri: r.uri, kind: r.kind, remote: { robot: r.robot, device: r.device, file: r.file } };
    // Until the device has been listed, nothing is known either way - and a Ctrl+click that
    // quietly opened another robot's backup copy would be worse than opening nothing. The
    // diagnostics already hold their "not found" on the same condition.
    if (!s.live.hasListing(robot)) return undefined;
  }
  if (info) return { uri: info.uri, kind: info.kind, info };
  return undefined;
}

/** a compiled KAREL program, wherever it lives */
export function isPcProgram(r: ResolvedProgram): boolean {
  return r.kind === 'karel' || (r.kind === 'binary' && /\.pc$/i.test(r.uri.path));
}

/** the robot a `fanuc://` document belongs to, else undefined */
export function robotOf(uri: vscode.Uri): string | undefined {
  return uri.scheme === FANUC_SCHEME ? decodeURIComponent(uri.authority) : undefined;
}
