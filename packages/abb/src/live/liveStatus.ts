/**
 * Keeps a connected ABB controller's status true: controller state (motors on / off, guard
 * stop...), operating mode and RAPID execution state, and whether the controller answers at all.
 *
 * Primary source: an RWS subscription on those three resources, whose event socket the
 * controller pushes each change down. Fallback: polling the same resources every `pollMs` while
 * there is no socket - when the controller refused the subscription, or the socket dropped. A
 * dropped socket or a poll that gets no answer says "not reachable" at once (the status turns
 * red); a poll that answers says reachable again, and every `resubscribeMs` polling tries to get
 * the socket back.
 *
 * No vscode here: AbbControllers wires the hooks, and the tests drive it against an in-process
 * controller.
 */
import { MiniWebSocket } from '../rws/websocket';
import { RwsError, type RwsEventSocket, type RwsPanel } from '../rws/client';

export interface StatusUpdate { ctrlState?: string; opMode?: string; execState?: string; cycle?: string }

/** The state resources, as each dialect names them (RWS 2.0 spells ctrl-state with a dash). */
export const stateResources = (rws2: boolean): string[] => [
  rws2 ? '/rw/panel/ctrl-state' : '/rw/panel/ctrlstate',
  '/rw/panel/opmode',
  '/rw/rapid/execution;ctrlexecstate',
];

/**
 * One event message: an XHTML list with an `<li class="...-ev">` per change, the value in a
 * `<span class="ctrlstate|opmode|ctrlexecstate">`. Both dialects send it this way.
 */
export function parseStateEvent(xml: string): StatusUpdate {
  const u: StatusUpdate = {};
  for (const m of xml.matchAll(/<span\s+class="([\w-]+)"\s*>([^<]*)<\/span>/g)) {
    const v = m[2].trim();
    switch (m[1].toLowerCase()) {
      case 'ctrlstate': case 'ctrl-state': u.ctrlState = v; break;
      case 'opmode': u.opMode = v; break;
      case 'ctrlexecstate': u.execState = v; break;
    }
  }
  return u;
}

export interface WatchClient {
  readonly rws2: boolean;
  subscribe(resources: string[]): Promise<RwsEventSocket>;
  unsubscribe(group: string): Promise<void>;
  panel(): Promise<RwsPanel>;
  execution(): Promise<{ state?: string; cycle?: string }>;
}

export interface WatchHooks {
  update(u: StatusUpdate, via: 'events' | 'polling'): void;
  /** `why` says what failed when `ok` is false */
  reachable(ok: boolean, why?: string): void;
  log?(msg: string): void;
}

export interface WatchOptions {
  pollMs?: number;
  resubscribeMs?: number;
  /** event socket ping, ms (0: none) */
  pingMs?: number;
  pongTimeoutMs?: number;
}

/** An answer from the controller, even an error one, means it is there; only a network failure does not. */
const answered = (e: unknown) => e instanceof RwsError && e.status > 0;

export class StatusWatch {
  /** where the status comes from right now */
  mode: 'events' | 'polling' | 'stopped' = 'stopped';
  private ws: MiniWebSocket | undefined;
  private group = '';
  private timer: NodeJS.Timeout | undefined;
  private lastTry = 0;
  private stopped = false;
  private polling = false;

  constructor(private readonly client: WatchClient, private readonly hooks: WatchHooks, private readonly o: WatchOptions = {}) {}

  async start(): Promise<void> {
    this.stopped = false;
    if (!(await this.subscribe())) this.startPolling();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.mode = 'stopped';
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    const ws = this.ws; this.ws = undefined;
    ws?.close();
    if (this.group) { const g = this.group; this.group = ''; await this.client.unsubscribe(g); }
  }

  private async subscribe(): Promise<boolean> {
    this.lastTry = Date.now();
    let where: RwsEventSocket;
    try { where = await this.client.subscribe(stateResources(this.client.rws2)); }
    catch (e: any) { this.hooks.log?.(`subscription refused, polling instead: ${e?.message ?? e}`); return false; }
    const ws = new MiniWebSocket({ url: where.url, protocol: where.protocol, headers: where.headers, pingMs: this.o.pingMs, pongTimeoutMs: this.o.pongTimeoutMs });
    try { await ws.open(); }
    catch (e: any) { this.hooks.log?.(`event socket did not open, polling instead: ${e?.message ?? e}`); void this.client.unsubscribe(where.group); return false; }
    if (this.stopped) { ws.close(); void this.client.unsubscribe(where.group); return true; }
    this.ws = ws; this.group = where.group;
    this.mode = 'events';
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    this.hooks.log?.('status: listening to controller events');
    this.hooks.reachable(true);
    ws.on('message', (text: string) => {
      const u = parseStateEvent(text);
      if (Object.keys(u).length) this.hooks.update(u, 'events');
    });
    ws.on('close', (why: string, byUs: boolean) => {
      if (this.ws === ws) this.ws = undefined;
      if (byUs || this.stopped) return;
      this.group = '';
      this.hooks.log?.(`status: event connection dropped (${why}), polling`);
      this.hooks.reachable(false, why);
      this.startPolling();
    });
    return true;
  }

  private startPolling(): void {
    if (this.stopped || this.timer) return;
    this.mode = 'polling';
    const every = this.o.pollMs ?? 5000;
    this.timer = setInterval(() => void this.poll(), every);
    this.timer.unref?.();
    void this.poll();
  }

  private async poll(): Promise<void> {
    if (this.polling || this.stopped || this.mode !== 'polling') return;
    this.polling = true;
    try {
      const p = await this.client.panel();
      const ex = await this.client.execution();
      if (this.stopped) return;
      this.hooks.update({ ctrlState: p.ctrlState, opMode: p.opMode, execState: ex.state, cycle: ex.cycle }, 'polling');
      this.hooks.reachable(true);
      if (Date.now() - this.lastTry >= (this.o.resubscribeMs ?? 30_000)) await this.subscribe();
    } catch (e: any) {
      if (this.stopped) return;
      if (answered(e)) this.hooks.reachable(true);
      else this.hooks.reachable(false, e?.message ?? String(e));
    } finally { this.polling = false; }
  }
}
