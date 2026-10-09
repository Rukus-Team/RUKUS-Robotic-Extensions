/**
 * Just enough of a WebSocket client (RFC 6455) for RWS subscriptions: text and binary messages
 * in, ping answered with pong, close both ways, client frames masked. No dependency: the
 * extension ships without node_modules, and the extension host's Node has no WebSocket of its
 * own before Node 22.
 *
 * Built on ClientRequest with its own agent, like the RWS client, so VS Code's proxy patch on
 * http.request never routes a controller connection through a proxy.
 *
 * A dead peer (a cable pulled, a controller powered off) does not close a TCP socket by itself,
 * so the client pings every `pingMs`; once the server has answered a ping, a ping left
 * unanswered for `pongTimeoutMs` counts as a drop. A server that never answers pings is not
 * held to it: TCP keep-alive is the only check then.
 */
import * as http from 'node:http';
import * as https from 'node:https';
import { EventEmitter } from 'node:events';
import { createHash, randomBytes } from 'node:crypto';
import type { Socket } from 'node:net';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export interface MiniWebSocketOptions {
  /** ws:// or wss:// */
  url: string;
  protocol?: string;
  headers?: Record<string, string>;
  /** the opening handshake, ms */
  timeoutMs?: number;
  pingMs?: number;
  pongTimeoutMs?: number;
}

/** The accept key a server must answer the handshake with. */
export const acceptKey = (key: string) => createHash('sha1').update(key + GUID).digest('base64');

/** One frame, masked as a client must send it. */
export function encodeFrame(opcode: number, payload: Buffer, mask = randomBytes(4)): Buffer {
  const len = payload.length;
  const head = len < 126 ? Buffer.alloc(2) : len < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
  head[0] = 0x80 | opcode;
  if (len < 126) head[1] = 0x80 | len;
  else if (len < 65536) { head[1] = 0x80 | 126; head.writeUInt16BE(len, 2); }
  else { head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(len), 2); }
  const body = Buffer.alloc(len);
  for (let i = 0; i < len; i++) body[i] = payload[i] ^ mask[i & 3];
  return Buffer.concat([head, mask, body]);
}

export interface Frame { fin: boolean; opcode: number; payload: Buffer }

/** The frames complete in `buf`, and how many bytes they took. Masked frames are unmasked. */
export function decodeFrames(buf: Buffer): { frames: Frame[]; used: number } {
  const frames: Frame[] = [];
  let at = 0;
  for (;;) {
    if (buf.length - at < 2) break;
    const b0 = buf[at], b1 = buf[at + 1];
    let len = b1 & 0x7f, p = at + 2;
    if (len === 126) { if (buf.length - p < 2) break; len = buf.readUInt16BE(p); p += 2; }
    else if (len === 127) { if (buf.length - p < 8) break; len = Number(buf.readBigUInt64BE(p)); p += 8; }
    const masked = (b1 & 0x80) !== 0;
    const mask = masked ? buf.subarray(p, p + 4) : undefined;
    if (masked) p += 4;
    if (buf.length - p < len) break;
    const payload = Buffer.from(buf.subarray(p, p + len));
    if (mask) for (let i = 0; i < len; i++) payload[i] ^= mask[i & 3];
    frames.push({ fin: (b0 & 0x80) !== 0, opcode: b0 & 0x0f, payload });
    at = p + len;
  }
  return { frames, used: at };
}

/**
 * Events: `message` (text: string), `close` (reason: string, byUs: boolean) - once, whatever ended it.
 */
export class MiniWebSocket extends EventEmitter {
  private socket: Socket | undefined;
  private buf: Buffer = Buffer.alloc(0);
  private parts: Buffer[] = [];
  private closed = false;
  private closing = false;
  private pinger: NodeJS.Timeout | undefined;
  private pongDue: NodeJS.Timeout | undefined;
  private pongSeen = false;

  constructor(private readonly o: MiniWebSocketOptions) { super(); }

  /** Open the connection; resolves when the handshake is accepted. */
  open(): Promise<void> {
    const u = new URL(this.o.url);
    const secure = u.protocol === 'wss:';
    const key = randomBytes(16).toString('base64');
    return new Promise((resolve, reject) => {
      const req = new http.ClientRequest({
        protocol: secure ? 'https:' : 'http:', host: u.hostname, port: u.port || (secure ? 443 : 80), path: u.pathname + u.search, method: 'GET',
        agent: new (secure ? https : http).Agent(),
        ...(secure ? { rejectUnauthorized: false } : {}),
        timeout: this.o.timeoutMs ?? 5000,
        headers: {
          Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': key,
          ...(this.o.protocol ? { 'Sec-WebSocket-Protocol': this.o.protocol } : {}),
          ...this.o.headers,
        },
      });
      req.on('timeout', () => req.destroy(new Error(`${u.host} did not open the event connection within ${(this.o.timeoutMs ?? 5000) / 1000} s`)));
      req.on('error', reject);
      req.on('response', res => { res.resume(); reject(new Error(`${u.host} refused the event connection: HTTP ${res.statusCode}`)); });
      req.on('upgrade', (res, socket, head) => {
        if (res.headers['sec-websocket-accept'] !== acceptKey(key)) { socket.destroy(); reject(new Error(`${u.host} answered the event connection with a bad handshake`)); return; }
        this.socket = socket;
        socket.setNoDelay(true);
        socket.setKeepAlive(true, 10_000);
        socket.on('data', d => this.onData(d));
        socket.on('close', () => this.finish(this.closing ? 'closed' : 'the controller closed the event connection', this.closing));
        socket.on('error', e => this.finish(e.message, false));
        if (head.length) this.onData(head);
        this.startPinging();
        resolve();
      });
      req.end();
    });
  }

  get isOpen(): boolean { return !!this.socket && !this.closed; }

  /** Close from our side: a close frame, then the socket. */
  close(): void {
    if (this.closed) return;
    this.closing = true;
    try { this.socket?.write(encodeFrame(0x8, Buffer.from([0x03, 0xe8]))); } catch { /* already gone */ }
    this.socket?.end();
    setTimeout(() => this.socket?.destroy(), 1000).unref?.();
    this.finish('closed', true);
  }

  private startPinging(): void {
    const every = this.o.pingMs ?? 15_000;
    if (every <= 0) return;
    this.pinger = setInterval(() => {
      if (!this.isOpen) return;
      try { this.socket!.write(encodeFrame(0x9, Buffer.alloc(0))); } catch { return; }
      if (this.pongSeen && !this.pongDue) {
        this.pongDue = setTimeout(() => { this.socket?.destroy(); this.finish('the controller stopped answering', false); }, this.o.pongTimeoutMs ?? 10_000);
      }
    }, every);
    this.pinger.unref?.();
  }

  private onData(d: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    const { frames, used } = decodeFrames(this.buf);
    this.buf = this.buf.subarray(used);
    for (const f of frames) {
      if (f.opcode === 0x9) { try { this.socket?.write(encodeFrame(0xa, f.payload)); } catch { /* gone */ } continue; }
      if (f.opcode === 0xa) { this.pongSeen = true; if (this.pongDue) { clearTimeout(this.pongDue); this.pongDue = undefined; } continue; }
      if (f.opcode === 0x8) {
        const reason = f.payload.length > 2 ? f.payload.subarray(2).toString('utf8') : '';
        if (!this.closing) { try { this.socket?.write(encodeFrame(0x8, f.payload.subarray(0, 2))); } catch { /* gone */ } }
        this.socket?.end();
        this.finish(this.closing ? 'closed' : `the controller closed the event connection${reason ? `: ${reason}` : ''}`, this.closing);
        continue;
      }
      // any frame from the server is a sign of life
      if (this.pongDue) { clearTimeout(this.pongDue); this.pongDue = undefined; }
      if (f.opcode === 0x1 || f.opcode === 0x2 || f.opcode === 0x0) {
        this.parts.push(f.payload);
        if (f.fin) { const text = Buffer.concat(this.parts).toString('utf8'); this.parts = []; this.emit('message', text); }
      }
    }
  }

  private finish(reason: string, byUs: boolean): void {
    if (this.closed) return;
    this.closed = true;
    if (this.pinger) clearInterval(this.pinger);
    if (this.pongDue) clearTimeout(this.pongDue);
    this.emit('close', reason, byUs);
  }
}
