/**
 * What the UI calls ABB controller values: the FlexPendant's own words, not the raw RWS
 * tokens (`forever`, `motoron`, `MANR`, `star`). The tokens stay what is sent and compared;
 * only what is shown goes through here. Pure, so the controller page can take the labels
 * ready-made (dashboard.ts serialize) and tests can pin them.
 */

/** Run mode (RWS `cycle`): the pendant's Run Mode menu. */
const RUN_MODE: Record<string, string> = {
  once: 'Single Cycle',
  forever: 'Continuous',
  oncedone: 'Single Cycle (done)',
  asis: 'As Is',
};

/** Operating mode (RWS `opmode`): the key switch. */
const OP_MODE: Record<string, string> = {
  AUTO: 'Auto',
  MANR: 'Manual',
  MANF: 'Manual Full Speed',
  AUTO_CH: 'Changing to Auto',
  MANF_CH: 'Changing to Manual Full Speed',
  MANR_CH: 'Changing to Manual',
  INIT: 'Initializing',
  UNDEF: 'Undefined',
};

/** Controller state (RWS `ctrlstate`). */
const CTRL_STATE: Record<string, string> = {
  init: 'Initializing',
  motoron: 'Motors On',
  motoroff: 'Motors Off',
  guardstop: 'Guard Stop',
  emergencystop: 'Emergency Stop',
  emergencystopreset: 'Emergency Stop Reset',
  sysfail: 'System Failure',
};

/** RAPID execution state: the controller's (`running` / `stopped`) or a task's (`star` / `stop`). */
const EXEC_STATE: Record<string, string> = {
  running: 'Running',
  stopped: 'Stopped',
  star: 'Running',
  stop: 'Stopped',
  ready: 'Ready',
  stopping: 'Stopping',
};

const pick = (map: Record<string, string>, v: string | undefined, key = (s: string) => s) =>
  v === undefined || v === '' ? undefined : map[key(v)] ?? v;

export const runModeLabel = (cycle: string | undefined) => pick(RUN_MODE, cycle, s => s.toLowerCase());
export const opModeLabel = (mode: string | undefined) => pick(OP_MODE, mode, s => s.toUpperCase());
export const ctrlStateLabel = (state: string | undefined) => pick(CTRL_STATE, state, s => s.toLowerCase());
export const execStateLabel = (state: string | undefined) => pick(EXEC_STATE, state, s => s.toLowerCase());
/** a task's execution state as the pill's class: `running` / `stopped`, so it is coloured like the controller's */
export const execStateClass = (state: string | undefined) => state === 'star' ? 'running' : state === 'stop' ? 'stopped' : state;

/** Task type (RWS `type`: norm / semi / stat, or the full word). */
export const taskTypeLabel = (type: string | undefined) => pick({ norm: 'Normal', normal: 'Normal', semi: 'Semistatic', semistatic: 'Semistatic', stat: 'Static', static: 'Static' }, type, s => s.toLowerCase());
