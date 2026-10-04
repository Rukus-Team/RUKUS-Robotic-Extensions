/**
 * A per-key promise chain, so two sync operations on the same robot run one after the other
 * instead of interleaving: a Fetch pressed a moment before a Pull used to run two reads and two
 * progress UIs at once. Pure (no VS Code), so it is unit-tested.
 */
const locks = new Map<string, Promise<unknown>>();

/**
 * Run `fn` after anything already running for `key` finishes. The chain continues even when an
 * operation rejects, so a failure does not wedge the queue for that key.
 */
export function withSyncLock<T>(key: string, fn: () => PromiseLike<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  locks.set(key, run.then(() => undefined, () => undefined));
  return run;
}

/** Serialise an operation against anything else running for the same robot container. */
export function withContainerLock<T>(marker: { root: string }, fn: () => PromiseLike<T>): Promise<T> {
  return withSyncLock(marker.root.toLowerCase(), fn);
}

/** How a push reconciles the working copy with the controller's copy (setting `containers.pullAfterPush`). */
export type PullAfterPush = 'always' | 'when-identical' | 'never';
/** What one push will do to the working copy: overwrite it, keep it, or leave it alone entirely. */
export type PullDecision = 'overwrite' | 'keep' | 'off';

/**
 * Whether an explicit push writes the controller's read-back into the working file. Only an
 * explicit push pulls - a live-edit save never rewrites the file being edited. `always` syncs the
 * working copy to the controller even when the read-back differs (it usually will - DATE/MODIFIED,
 * line numbers, variable labels); `when-identical` keeps the local copy on a difference; `never`
 * leaves the working copy alone entirely. Pure (no VS Code), so it is unit-tested.
 */
export function pullAfterPushDecision(explicit: boolean, policy: PullAfterPush, identical: boolean): PullDecision {
  if (!explicit || policy === 'never') return 'off';
  if (identical || policy === 'always') return 'overwrite';
  return 'keep';
}
