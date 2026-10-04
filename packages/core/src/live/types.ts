/** Live-controller types shared by the read-only tier. */

export interface RobotProfile {
  /** display name, also the SecretStorage key and the fanuc:// authority */
  name: string;
  host: string;
  httpPort: number;
  ftpPort: number;
  ftpUser: string;
  /** device that holds programs and generated diagnostics, e.g. "MD:" */
  device: string;
  /** prefer FTP for file reads (HTTP is the default because it needs no login) */
  useFtp: boolean;
  /** interval used ONLY while auto-refresh is switched on for this robot (off by default) */
  pollIntervalMs: number;
  autoConnect: boolean;
  /**
   * Re-fetch on a timer instead of only when asked. OFF by default and off on every
   * new profile: a controller generates each .DG file on demand, so a background poll
   * is real load on the robot for data nobody is looking at.
   */
  autoRefresh: boolean;
}

export interface JointPosition { joints: number[]; ext: number[] }
export interface CartPosition { x: number; y: number; z: number; w: number; p: number; r: number; config?: string; ext: number[] }
export interface CurrentPosition {
  group: number;
  joint?: JointPosition;
  userFrame?: CartPosition;
  world?: CartPosition;
  frameNo?: number;
  toolNo?: number;
  timestamp?: string;
}

export type TaskStatus = 'RUNNING' | 'PAUSED' | 'ABORTED' | 'ABORTING' | 'PAUSING' | 'UNKNOWN';
export interface TaskFrame { program: string; line: number; type: string; routine?: string; depth?: number }
export interface TaskState {
  taskNo: number;
  name: string;
  status: TaskStatus;
  /** current frame (innermost) */
  current?: TaskFrame;
  stack: TaskFrame[];
}

export interface IoPoint { kind: string; index: number; value: 'ON' | 'OFF' | number; simulated: boolean; comment: string }

export interface AlarmEntry { seq: number; time: string; code?: string; message: string; severity: string; isReset: boolean }

export interface ControllerInfo { fNumber?: string; version?: string; application?: string; robotName?: string; date?: string }

/**
 * One independently fetchable piece of controller state. Nothing is read until the
 * user asks for that piece by name, so opening the Robots view costs the robot nothing.
 */
export type FetchKind = 'info' | 'position' | 'tasks' | 'numregs' | 'io' | 'strregs' | 'posregs';

export const FETCH_KINDS: FetchKind[] = ['info', 'position', 'tasks', 'numregs', 'io', 'strregs', 'posregs'];

export interface LiveSnapshot {
  robot: string;
  /** per-unit time of the last successful fetch; a missing key means "never asked for" */
  fetchedAt: Map<FetchKind, number>;
  info: ControllerInfo;
  numregs: Map<number, { value: number | string; comment: string }>;
  posregs: Map<number, { comment: string; summary: string; kind: string }>;
  strregs: Map<number, { value: string; comment: string }>;
  io: Map<string, IoPoint>;
  tasks: TaskState[];
  position?: CurrentPosition;
  /** fetch unit → last fetch error, for the UI */
  errors: Map<FetchKind, string>;
  /** the controller's installed software options, read by the brand (FANUC: MD:ORDERFIL.DAT) */
  options?: ControllerOptionEntry[];
  /** what the brand thinks is worth calling out about those options (can it load a .LS, KAREL…) */
  optionHighlights?: OptionHighlight[];
  optionsAt?: number;
}

export interface ControllerOptionEntry { code: string; name: string }
/** `ok` true = installed, false = missing, undefined = a plain fact (application, robot model) */
export interface OptionHighlight { label: string; ok?: boolean; detail: string }

export interface RemoteFile { name: string; size?: number; isDir: boolean }

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';
