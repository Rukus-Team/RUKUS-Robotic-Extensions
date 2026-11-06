/**
 * The transfer queue: every operation that talks to a controller (or does long local work for
 * one) gets one visible entry. Entries are serialised per key (`robot:<name>`, `container:<root>`,
 * `index`) so two operations never share the wire, and the status bar/QuickPick can show what is
 * running, what is queued, and the technical steps (`ftp(session 3): RETR MD:MAIN.LS`).
 *
 * Pure (no VS Code), so it is unit-tested. Cancellation follows the product rule: a queued item
 * is only removed; a running item is aborted through its AbortSignal and the operation decides
 * where that is safe (a push never aborts mid-STOR; it offers a revert instead).
 */

export type TransferKind =
  | 'connect' | 'get' | 'fetch' | 'pull' | 'push' | 'snapshot' | 'backup'
  | 'compare' | 'restore' | 'index' | 'data' | 'init' | 'other';

export type TransferState = 'queued' | 'running' | 'waiting' | 'cancelling' | 'done' | 'failed' | 'cancelled';

/** How the entry participates in the status bar. */
export type TransferVisibility =
  /** always shown while active */
  | 'foreground'
  /** shown only when there is no foreground item (index/data refresh, snapshot from backup, init) */
  | 'background'
  /** QuickPick only; sub-second controller reads */
  | 'quick';

export interface TransferSnapshot {
  id: number;
  key: string;
  kind: TransferKind;
  visibility: TransferVisibility;
  label: string;
  robot?: string;
  file?: string;
  state: TransferState;
  /** user-facing phase ("Uploading", "Updating snapshot") */
  detail?: string;
  /** the last technical step (`ftp(s3): STOR MD:MAIN.LS`) */
  technical?: string;
  /** the last N technical steps, oldest first */
  technicalLog: string[];
  /** 0..1 when the operation can report it */
  fraction?: number;
  startedAt?: number;
  endedAt?: number;
  error?: string;
}

export interface TransferHandle {
  readonly id: number;
  readonly cancelled: boolean;
  /** user-facing phase */
  report(detail: string, fraction?: number): void;
  /** a technical step, appended to the item's log */
  technical(line: string): void;
  /** the operation is waiting on a user decision (modal) */
  waiting(detail?: string): void;
  /** back to running after a wait */
  running(detail?: string): void;
  /** mark the entry failed even though the run may resolve normally (a refused program) */
  fail(message?: string): void;
}

export interface TransferOptions<T> {
  key: string;
  kind: TransferKind;
  label: string;
  visibility?: TransferVisibility;
  robot?: string;
  file?: string;
  /** a Promise or any thenable (VS Code's `withProgress` returns a Thenable) */
  run: (signal: AbortSignal, item: TransferHandle) => PromiseLike<T> | T;
}

interface Internal extends TransferSnapshot {
  controller?: AbortController;
  /** cancelled while still queued: the run is never invoked */
  cancelQueued?: boolean;
}

const LOG_LIMIT = 50;

export class TransferQueue {
  private readonly listeners = new Set<() => void>();
  /** one promise chain per key, so two operations on the same robot/container never share the wire */
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly entries = new Map<number, Internal>();
  private nextId = 1;
  /** how long a finished entry stays in the QuickPick */
  recentMs: number;

  constructor(recentMs = 120_000) { this.recentMs = recentMs; }

  onDidChange(listener: () => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => { this.listeners.delete(listener); } };
  }

  /** active first (running/waiting/cancelling, then queued), then recent newest first */
  items(): TransferSnapshot[] {
    this.prune();
    const all = [...this.entries.values()];
    const order = (s: TransferState) => s === 'running' ? 0 : s === 'waiting' ? 1 : s === 'cancelling' ? 2 : s === 'queued' ? 3 : 4;
    const active = all.filter(e => !e.endedAt).sort((a, b) => order(a.state) - order(b.state) || a.id - b.id);
    const recent = all.filter(e => e.endedAt).sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
    return [...active, ...recent].map(e => this.snapshot(e));
  }

  /** is anything active for this robot name or explicit key? */
  isBusy(nameOrKey: string): boolean {
    const lower = nameOrKey.toLowerCase();
    const key = nameOrKey.includes(':') ? lower : `robot:${lower}`;
    return [...this.entries.values()].some(e => !e.endedAt && (e.key.toLowerCase() === key || e.robot?.toLowerCase() === lower));
  }

  /** the active entry for a key, if any (first running/waiting, else first queued) */
  current(key: string): TransferSnapshot | undefined {
    this.prune();
    const lower = key.toLowerCase();
    const list = [...this.entries.values()].filter(e => !e.endedAt && e.key.toLowerCase() === lower);
    const entry = list.find(e => e.state === 'running' || e.state === 'waiting') ?? list[0];
    return entry ? this.snapshot(entry) : undefined;
  }

  /** attach a technical step to the active entry for a robot */
  note(robot: string, line: string): void {
    const lower = robot.toLowerCase();
    const active = [...this.entries.values()]
      .filter(e => !e.endedAt && (e.robot?.toLowerCase() === lower || e.key.toLowerCase() === `robot:${lower}`))
      .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
    const entry = active.find(e => e.state === 'running' || e.state === 'waiting') ?? active[0];
    if (entry) this.appendTechnical(entry, line);
  }

  enqueue<T>(o: TransferOptions<T>): Promise<T | undefined> {
    const entry: Internal = {
      id: this.nextId++, key: o.key, kind: o.kind, visibility: o.visibility ?? 'foreground',
      label: o.label, robot: o.robot, file: o.file, state: 'queued', technicalLog: [],
    };
    this.entries.set(entry.id, entry);
    this.fire();
    const handle = this.handle(entry);
    const prev = this.chains.get(o.key) ?? Promise.resolve();
    const run = prev.then(async (): Promise<T | undefined> => {
      if (entry.cancelQueued) { this.finish(entry, 'cancelled'); return undefined; }
      entry.state = 'running';
      entry.startedAt = Date.now();
      entry.controller = new AbortController();
      this.fire();
      try {
        const result = await o.run(entry.controller.signal, handle);
        const state = this.stateOf(entry);
        if (state === 'cancelling') this.finish(entry, 'cancelled');
        else if (state !== 'done' && state !== 'failed') this.finish(entry, 'done');
        return result;
      } catch (e) {
        const state = this.stateOf(entry);
        if (state === 'cancelling' || (e as { name?: string })?.name === 'AbortError') this.finish(entry, 'cancelled');
        else { entry.error = e instanceof Error ? e.message : String(e); this.finish(entry, 'failed'); }
        throw e;
      }
    });
    this.chains.set(o.key, run.then(() => undefined, () => undefined));
    return run;
  }

  /** queued: remove only. running/waiting: abort; the operation decides where that is safe. */
  cancel(id: number): boolean {
    const entry = this.entries.get(id);
    if (!entry || entry.endedAt) return false;
    if (entry.state === 'queued') {
      entry.cancelQueued = true;
      this.finish(entry, 'cancelled');
      return true;
    }
    if (entry.state === 'running' || entry.state === 'waiting') {
      const wasWaiting = entry.state === 'waiting';
      entry.state = 'cancelling';
      entry.detail = wasWaiting ? 'Cancelling after the decision…' : 'Cancelling…';
      entry.controller?.abort();
      this.fire();
      return true;
    }
    return false;
  }

  cancelAll(): number {
    let n = 0;
    for (const e of [...this.entries.values()]) if (!e.endedAt && this.cancel(e.id)) n++;
    return n;
  }

  private snapshot(e: Internal): TransferSnapshot {
    const { controller: _c, cancelQueued: _q, ...rest } = e;
    return { ...rest, technicalLog: [...e.technicalLog] };
  }

  private handle(e: Internal): TransferHandle {
    const queue = this;
    return {
      get id() { return e.id; },
      get cancelled() { return e.state === 'cancelling' || !!e.controller?.signal.aborted || !!e.cancelQueued; },
      report(detail: string, fraction?: number) { e.detail = detail; if (fraction !== undefined) e.fraction = Math.max(0, Math.min(1, fraction)); queue.fire(); },
      technical(line: string) { queue.appendTechnical(e, line); },
      waiting(detail?: string) { if (e.endedAt) return; e.state = 'waiting'; if (detail) e.detail = detail; queue.fire(); },
      running(detail?: string) { if (e.endedAt) return; e.state = 'running'; if (detail) e.detail = detail; queue.fire(); },
      fail(message?: string) { if (e.endedAt) return; if (message) e.error = message; queue.finish(e, 'failed'); },
    };
  }

  private appendTechnical(e: Internal, line: string): void {
    e.technical = line;
    e.technicalLog.push(line);
    if (e.technicalLog.length > LOG_LIMIT) e.technicalLog.splice(0, e.technicalLog.length - LOG_LIMIT);
    this.fire();
  }

  /** read through a helper, so a later assignment does not narrow the type at a call site */
  private stateOf(e: Internal): TransferState { return e.state; }

  private finish(e: Internal, state: TransferState): void {
    e.state = state;
    e.endedAt = Date.now();
    e.controller = undefined;
    this.fire();
  }

  private prune(): void {
    const now = Date.now();
    for (const [id, e] of this.entries) if (e.endedAt && now - e.endedAt > this.recentMs) this.entries.delete(id);
  }

  private fire(): void {
    for (const listener of [...this.listeners]) {
      try { listener(); } catch { /* a listener must not break the queue */ }
    }
  }
}
