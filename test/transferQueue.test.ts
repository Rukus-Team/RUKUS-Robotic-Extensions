/**
 * The transfer queue: per-key ordering, the cancel rules, technical logs and recent retention.
 * Pure (no VS Code), wired in by test/run.ts.
 */
import { TransferQueue } from '@core/transferQueue';

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export async function run(check: (cond: unknown, msg: string) => void): Promise<void> {
  // ---- per-key ordering: the second waits for the first ----
  {
    const q = new TransferQueue();
    const order: string[] = [];
    let release!: () => void;
    const first = q.enqueue({ key: 'robot:R1', kind: 'fetch', label: 'first', run: async () => { order.push('first:start'); await new Promise<void>(r => { release = r; }); order.push('first:end'); return 1; } });
    const second = q.enqueue({ key: 'robot:R1', kind: 'fetch', label: 'second', run: async () => { order.push('second'); return 2; } });
    await sleep(5);
    check(order.join(',') === 'first:start' && q.items().filter(i => !i.endedAt).length === 2, `queue: the second entry is queued while the first runs (${JSON.stringify(q.items().map(i => [i.label, i.state]))})`);
    release();
    check(await first === 1 && await second === 2, 'queue: both runs return their values');
    check(order.join(',') === 'first:start,first:end,second', `queue: the same key runs in order (${order.join(',')})`);
    check(q.items().every(i => i.state === 'done'), 'queue: both are done');
  }

  // ---- queued cancel: the run is never invoked ----
  {
    const q = new TransferQueue();
    let ran = false;
    let release!: () => void;
    const first = q.enqueue({ key: 'robot:R1', kind: 'fetch', label: 'hold', run: async () => { await new Promise<void>(r => { release = r; }); return 1; } });
    const second = q.enqueue({ key: 'robot:R1', kind: 'fetch', label: 'cancel me', run: async () => { ran = true; return 2; } });
    await sleep(5);
    const queued = q.items().find(i => i.label === 'cancel me');
    check(q.cancel(queued!.id), 'queue: a queued item can be cancelled');
    release();
    await first; check(await second === undefined && !ran, 'queue: a cancelled queued item never runs');
    check(q.items().find(i => i.label === 'cancel me')?.state === 'cancelled', 'queue: it is marked cancelled');
  }

  // ---- running cancel: the operation sees its signal ----
  {
    const q = new TransferQueue();
    let seen = false;
    const p = q.enqueue({ key: 'robot:R1', kind: 'fetch', label: 'abort', run: async signal => {
      await new Promise<void>((_, reject) => signal.addEventListener('abort', () => { seen = true; reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); }, { once: true }));
    } });
    await sleep(5);
    const active = q.items().find(i => i.label === 'abort')!;
    check(q.cancel(active.id) && active.state === 'running', 'queue: an active item can be cancelled');
    let failed = false;
    try { await p; } catch { failed = true; }
    check(seen && failed, 'queue: the running operation receives the abort');
    check(q.items().find(i => i.label === 'abort')?.state === 'cancelled', 'queue: it is marked cancelled, not failed');
  }

  // ---- waiting, technical log and note ----
  {
    const q = new TransferQueue(20);
    let handleWaiting = false;
    const p = q.enqueue({ key: 'robot:R1', kind: 'push', label: 'push MAIN.LS', robot: 'R1', file: 'MAIN.LS', run: async (_s, item) => {
      item.technical('ftp(s3): login R1');
      item.technical('ftp(s3): RETR MD:MAIN.LS');
      item.waiting('Waiting for your decision');
      handleWaiting = q.items().find(i => i.label === 'push MAIN.LS')?.state === 'waiting';
      item.running('Uploading');
      item.report('Uploading', 0.5);
      item.technical('ftp(s3): STOR MD:MAIN.LS');
      return true;
    } });
    await p;
    const item = q.items().find(i => i.label === 'push MAIN.LS')!;
    check(handleWaiting, 'queue: waiting is visible to the status');
    check(item.state === 'done' && item.technical === 'ftp(s3): STOR MD:MAIN.LS' && item.technicalLog.length === 3, `queue: the technical log keeps the steps (${item.technicalLog.join(' | ')})`);
    check(item.fraction === 0.5, 'queue: fraction is reported');
    await sleep(30);
    check(q.items().length === 0, 'queue: a finished entry is pruned after recentMs');
  }

  // ---- note() attaches to the active robot entry ----
  {
    const q = new TransferQueue();
    let line: string | undefined;
    const p = q.enqueue({ key: 'robot:R1', kind: 'fetch', label: 'fetch', robot: 'R1', run: async () => { q.note('R1', 'ftp(s4): RETR MD:PROG.LS'); line = q.items()[0].technical; } });
    await p;
    check(line === 'ftp(s4): RETR MD:PROG.LS', `queue: note() reaches the active entry (${line})`);
  }

  // ---- busy and visibility ordering ----
  {
    const q = new TransferQueue();
    let release!: () => void;
    const p = q.enqueue({ key: 'robot:R1', kind: 'fetch', label: 'fg', run: async () => { await new Promise<void>(r => { release = r; }); } });
    const b = q.enqueue({ key: 'container:C1', kind: 'snapshot', label: 'bg', visibility: 'background', run: async () => undefined });
    await sleep(5);
    check(q.isBusy('R1') && q.isBusy('robot:R1') && !q.isBusy('R2'), 'queue: isBusy finds the running robot');
    const items = q.items();
    check(items[0].label === 'fg' && items.find(i => i.label === 'bg')?.state === 'done', `queue: foreground first, background after (${JSON.stringify(items.map(i => [i.label, i.state, i.visibility]))})`);
    release(); await p; await b;
  }
}
