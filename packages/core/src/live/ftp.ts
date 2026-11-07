/**
 * Small passive-mode FTP client — enough for FANUC controllers: login, CWD to a
 * device (e.g. "MD:"), NLST/LIST, RETR, STOR. No external dependency.
 *
 * One session, many files. A controller is slow to accept a connection and slower to
 * log one in, and a backup is a few hundred files, so the cost that matters is per
 * SESSION, not per byte. `retrieveMany` is the `prompt off; bin; mget *.*` of a command-line
 * client: log in once, set binary once, then RETR each file on the same control
 * connection. Opening a session per file - which is what this did before - turned a
 * thirty-second backup into a ten-minute one.
 *
 * Timeouts are per operation, not flat: a command reply waits `timeoutMs` (10 s), while a data
 * transfer - and the compile the controller runs after a STOR - waits `transferTimeout(size)`
 * (see below), because a large program can leave both sockets quiet for a minute or more.
 */
import * as net from 'node:net';
import type { RemoteFile } from './types';

export interface FtpOptions { host: string; port: number; user: string; password: string; timeoutMs?: number }

/** Floor for a data transfer or the compile that follows a write, independent of the control timeout. */
const DATA_FLOOR_MS = 30_000;
/** Extra time granted per KiB of payload. A FANUC controller compiles a pushed `.LS` as it lands. */
const PER_KIB_MS = 250;
/** Upper bound, so a controller that has gone away does not hang the operation forever. */
const DATA_CAP_MS = 5 * 60_000;

/**
 * The timeout for moving `size` bytes to or from a controller: never less than `baseMs`, but at
 * least DATA_FLOOR_MS plus a slice proportional to the size, capped. The control channel is
 * quiet for the whole of a transfer - and longer still while the controller compiles a program
 * it just received - so the flat 10 s that suited a command reply ended a large push early.
 */
export function transferTimeout(baseMs: number, size: number): number {
  return Math.min(DATA_CAP_MS, Math.max(baseMs, DATA_FLOOR_MS) + Math.ceil(size / 1024) * PER_KIB_MS);
}

interface Reply { code: number; text: string }

class FtpControl {
  private sock!: net.Socket;
  private buffer = '';
  private waiters: Array<{ resolve: (r: Reply) => void; reject: (e: Error) => void }> = [];
  /**
   * Replies that arrived before anyone asked for them. A server sends `226 Transfer
   * complete` when the data connection closes, which can be before or after the client
   * has noticed - so a reply with nobody waiting is queued, never dropped, or the next
   * command would be answered by the previous one's completion line.
   */
  private unclaimed: Reply[] = [];
  private closed: Error | undefined;
  constructor(private opts: FtpOptions) {}

  /** the error that ended this session, once one has */
  get dead(): Error | undefined { return this.closed; }

  connect(): Promise<Reply> {
    return new Promise((resolve, reject) => {
      this.sock = net.createConnection({ host: this.opts.host, port: this.opts.port });
      this.sock.on('timeout', () => { this.fail(new Error('FTP control timeout')); this.sock.destroy(); });
      this.sock.on('error', e => this.fail(e));
      this.sock.on('close', () => this.fail(new Error('FTP connection closed')));
      this.sock.on('data', d => this.onData(d.toString('latin1')));
      this.waiters.push({ resolve, reject });
      this.arm();
    });
  }

  /**
   * The control timeout runs only while a reply is owed. `setTimeout` on a socket is an IDLE
   * timer, and the control channel is idle by design for the whole of a data transfer - a
   * 2 MB .va over a slow plant link is quiet on this socket for far longer than ten
   * seconds - so a timer that ran all the time ended the whole backup on the first slow file.
   */
  private arm(ms?: number) { this.sock.setTimeout(this.waiters.length ? (ms ?? this.opts.timeoutMs ?? 10000) : 0); }

  private fail(e: Error) {
    if (this.closed) return;
    this.closed = e;
    const w = this.waiters.splice(0); for (const x of w) x.reject(e);
  }

  private deliver(r: Reply) {
    const w = this.waiters.shift();
    if (w) w.resolve(r); else this.unclaimed.push(r);
    this.arm();
  }

  private onData(s: string) {
    this.buffer += s;
    // A reply ends with a line "ddd text\r\n" (multi-line replies use "ddd-" until "ddd ").
    for (;;) {
      const m = /^(\d{3})([ -])([^\r\n]*)\r?\n/.exec(this.buffer);
      if (!m) return;
      if (m[2] === '-') {
        const endRe = new RegExp(`^${m[1]} [^\\r\\n]*\\r?\\n`, 'm');
        const endMatch = endRe.exec(this.buffer);
        if (!endMatch) return;
        const full = this.buffer.slice(0, endMatch.index + endMatch[0].length);
        this.buffer = this.buffer.slice(full.length);
        this.deliver({ code: parseInt(m[1], 10), text: full.trim() });
      } else {
        this.buffer = this.buffer.slice(m[0].length);
        this.deliver({ code: parseInt(m[1], 10), text: m[3] });
      }
    }
  }

  /** the next reply, whether it has already arrived or not; `timeoutMs` overrides the wait */
  reply(timeoutMs?: number): Promise<Reply> {
    const queued = this.unclaimed.shift();
    if (queued) return Promise.resolve(queued);
    if (this.closed) return Promise.reject(this.closed);
    return new Promise((resolve, reject) => { this.waiters.push({ resolve, reject }); this.arm(timeoutMs); });
  }

  cmd(line: string): Promise<Reply> {
    if (this.closed) return Promise.reject(this.closed);
    const p = this.reply();
    this.sock.write(line + '\r\n', 'latin1');
    return p;
  }

  async expect(line: string, ok: (c: number) => boolean): Promise<Reply> {
    const r = await this.cmd(line);
    if (!ok(r.code)) throw new Error(`FTP "${line.split(' ')[0]}" failed: ${r.code} ${r.text}`);
    return r;
  }

  close() { try { this.sock.destroy(); } catch { /* ignore */ } }
}

export class FtpClient {
  private ctl: FtpControl;
  /** how long the login + CWD took, for the transfer log */
  loginMs = 0;
  constructor(private opts: FtpOptions) { this.ctl = new FtpControl(opts); }

  async connect(): Promise<void> {
    const started = Date.now();
    const hello = await this.ctl.connect();
    if (hello.code !== 220) throw new Error(`FTP greeting ${hello.code} ${hello.text}`);
    const u = await this.ctl.cmd(`USER ${this.opts.user || 'anonymous'}`);
    if (u.code === 331) await this.ctl.expect(`PASS ${this.opts.password ?? ''}`, c => c === 230 || c === 202);
    else if (u.code !== 230) throw new Error(`FTP login failed: ${u.code} ${u.text}`);
    await this.ctl.cmd('TYPE I');   // binary, once - it holds for the session
    this.loginMs = Date.now() - started;
  }

  async cwd(device: string): Promise<void> {
    // FANUC accepts "CWD MD:" ; also try without the colon
    const r = await this.ctl.cmd(`CWD ${device}`);
    if (r.code >= 400) await this.ctl.expect(`CWD ${device.replace(/:$/, '')}`, c => c < 400);
  }

  private async pasv(timeoutMs?: number): Promise<net.Socket> {
    const r = await this.ctl.expect('PASV', c => c === 227);
    const m = /(\d+),(\d+),(\d+),(\d+),(\d+),(\d+)/.exec(r.text);
    if (!m) throw new Error(`Bad PASV reply: ${r.text}`);
    const port = parseInt(m[5], 10) * 256 + parseInt(m[6], 10);
    // Use the control host rather than the advertised IP (NAT-safe)
    return new Promise((resolve, reject) => {
      const s = net.createConnection({ host: this.opts.host, port }, () => resolve(s));
      // Destroyed WITH an error: a bare destroy() closes the socket cleanly and whoever is
      // collecting the bytes would take the half a file it had as the whole of it.
      const ms = timeoutMs ?? Math.max(this.opts.timeoutMs ?? 10000, DATA_FLOOR_MS);
      s.setTimeout(ms, () => { const e = new Error('FTP data timeout'); s.destroy(e); reject(e); });
      s.on('error', reject);
    });
  }

  /**
   * One data transfer: PASV, the command, the bytes, and then the completion reply.
   *
   * The `226` after the data has to be READ, not skipped: it is a reply like any other, and
   * leaving it in the stream meant the next command was answered by it. That misalignment
   * is what made a second transfer on the same session fail, and why every file used to
   * get a session of its own.
   */
  private async transfer(command: string, timeoutMs?: number): Promise<Buffer> {
    const data = await this.pasv(timeoutMs);
    const chunks: Buffer[] = [];
    const done = new Promise<void>((resolve, reject) => { data.on('data', c => chunks.push(c)); data.on('end', resolve); data.on('close', resolve); data.on('error', reject); });
    const verb = command.split(' ')[0];
    const start = await this.ctl.cmd(command);
    if (start.code >= 400) { data.destroy(); throw new Error(`FTP ${verb} failed: ${start.code} ${start.text}`); }
    let dataError: Error | undefined;
    try { await done; } catch (e: any) { dataError = e instanceof Error ? e : new Error(String(e)); }
    // 125/150 opened the data connection; the transfer's own result follows once it closes.
    // A server that answered 226 straight away (empty file) has nothing more to say.
    // The completion line is consumed EVEN WHEN the data side failed: the server still
    // sends its 426 (or 226) for that transfer, and leaving it in the stream would answer
    // the next PASV, whose 227 would then answer the next RETR, and so on down the backup.
    if (start.code < 200) {
      const fin = await this.ctl.reply(timeoutMs);
      if (dataError) throw new Error(`FTP ${verb} failed: ${dataError.message} (${fin.code} ${fin.text})`);
      if (fin.code >= 400) throw new Error(`FTP ${verb} failed: ${fin.code} ${fin.text}`);
    } else if (dataError) {
      throw new Error(`FTP ${verb} failed: ${dataError.message}`);
    }
    return Buffer.concat(chunks);
  }

  /** `SIZE NAME` (RFC 3659); undefined when the controller does not support it. */
  async size(name: string): Promise<number | undefined> {
    const r = await this.ctl.cmd(`SIZE ${name}`);
    if (r.code !== 213) return undefined;
    const m = /(\d+)\s*$/.exec(r.text);
    return m ? parseInt(m[1], 10) : undefined;
  }

  /** `MDTM NAME` → the controller's UTC mtime, when it answers with one. */
  async mdtm(name: string): Promise<number | undefined> {
    const r = await this.ctl.cmd(`MDTM ${name}`);
    const m = r.code === 213 ? /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(r.text.trim()) : undefined;
    if (!m) return undefined;
    return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  }

  /** `DELE NAME`: one file off the device; the controller's refusal comes back as the error. */
  async delete(name: string): Promise<void> {
    const r = await this.ctl.cmd(`DELE ${name}`);
    if (r.code >= 400) throw new Error(`FTP DELE failed: ${r.code} ${r.text}`);
  }

  /** Keep an idle session alive across a modal or a slow step. */
  async noop(): Promise<void> { await this.ctl.cmd('NOOP'); }

  async list(): Promise<RemoteFile[]> {
    let text = '';
    try { text = (await this.transfer('LIST')).toString('latin1'); } catch { text = ''; }
    let files = parseFtpListing(text);
    if (files.length === 0) {
      // A server that answers LIST with nothing may still answer NLST with names.
      const names = (await this.transfer('NLST')).toString('latin1');
      const out = new Map<string, RemoteFile>();
      for (const n of names.split(/\r?\n/)) { const t = n.trim(); if (t) out.set(t.toUpperCase(), { name: t, isDir: false }); }
      files = [...out.values()];
    }
    return files.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * `RETR`, with the wait scaled by the file's size when it is known. Without this the data
   * socket used the 30 s floor for every read, so a large `.va` over a slow link was cut off
   * while a write of the same file was not.
   */
  async retrieve(name: string, sizeHint?: number): Promise<Buffer> {
    return this.transfer(`RETR ${name}`, transferTimeout(this.opts.timeoutMs ?? 10000, sizeHint ?? 0));
  }

  /** `SIZE` then `RETR`, so a read is scaled even when the caller has no listing. */
  async retrieveSized(name: string): Promise<Buffer> {
    let size: number | undefined;
    try { size = await this.size(name); } catch { /* SIZE unsupported: use the floor */ }
    return this.retrieve(name, size);
  }

  /**
   * `put`: one file onto the device the session is in (`STOR`). The controller takes an
   * ASCII `.LS` this way and compiles it to the `.TP` of the same name - which it refuses
   * while that program is selected or running, and says so in the completion reply, which
   * is read the same way as after a RETR so the session stays in step.
   */
  async store(name: string, data: Uint8Array): Promise<void> {
    // The controller compiles the .LS into .TP as it receives it, and the transfer can be
    // quiet on both sockets for far longer than a command reply - scale the wait by the size.
    const ms = transferTimeout(this.opts.timeoutMs ?? 10000, data.length);
    const conn = await this.pasv(ms);
    const start = await this.ctl.cmd(`STOR ${name}`);
    if (start.code >= 400) { conn.destroy(); throw new Error(`FTP STOR failed: ${start.code} ${start.text}`); }
    let dataError: Error | undefined;
    await new Promise<void>(resolve => {
      conn.on('error', e => { dataError = e; resolve(); });
      conn.end(data, () => resolve());
    });
    if (start.code < 200) {
      const fin = await this.ctl.reply(ms);
      if (dataError) throw new Error(`FTP STOR failed: ${dataError.message} (${fin.code} ${fin.text})`);
      if (fin.code >= 400) throw new Error(`FTP STOR failed: ${fin.code} ${fin.text}`);
    } else if (dataError) {
      throw new Error(`FTP STOR failed: ${dataError.message}`);
    }
  }

  /**
   * `mget`: every named file over this one session, in order, reporting each as it lands.
   * A file that fails is reported and skipped - one unreadable file must not abandon the
   * other three hundred - unless the session itself has died, which ends the run.
   */
  async retrieveMany(
    names: string[],
    onFile: (name: string, result: { data: Buffer } | { error: string }, index: number) => void,
    isCancelled: () => boolean = () => false,
  ): Promise<void> {
    for (let i = 0; i < names.length; i++) {
      if (isCancelled()) return;
      try { onFile(names[i], { data: await this.retrieveSized(names[i]) }, i); }
      catch (e: any) {
        const error = e?.message ?? String(e);
        onFile(names[i], { error }, i);
        if (this.ctl.dead) throw e;
      }
    }
  }

  async quit(): Promise<void> { try { await this.ctl.cmd('QUIT'); } catch { /* ignore */ } this.ctl.close(); }
}

/** One-shot helpers */
export async function ftpGetText(opts: FtpOptions, device: string, file: string): Promise<string> {
  const c = new FtpClient(opts);
  try { await c.connect(); await c.cwd(device); return (await c.retrieveSized(file)).toString('latin1'); } finally { await c.quit(); }
}
export async function ftpList(opts: FtpOptions, device: string): Promise<RemoteFile[]> {
  const c = new FtpClient(opts);
  try { await c.connect(); await c.cwd(device); return await c.list(); } finally { await c.quit(); }
}

/**
 * Parse an FTP LIST body into files. Kept separate from the socket so it is unit-tested:
 * the Unix form is the one a FANUC controller actually returns
 * (`-rw-r--r-- 1 robot robot 1234 Jan 01 00:00 NAME`).
 */
export function parseFtpListing(text: string): RemoteFile[] {
  const out = new Map<string, RemoteFile>();
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim(); if (!t) continue;
    // Unix style: -rw-r--r-- 1 owner group 1234 Jan 01 12:00 NAME   (or Jan 01 2024)
    const unix = /^([-dl])\S+\s+\d+\s+\S+\s+\S+\s+(\d+)\s+(\S+)\s+(\d{1,2})\s+([\d:]+|(\d{4}))\s+(.+)$/.exec(t);
    if (unix) {
      const name = unix[7];
      if (!name) continue;
      out.set(name.toUpperCase(), { name, size: parseInt(unix[2], 10), mtime: parseUnixDate(unix[3], unix[4], unix[5]), isDir: unix[1] === 'd' });
      continue;
    }
    // DOS style: 01-01-24  12:00PM   1234 NAME   or   <DIR>
    const dos = /^(\d{2})-(\d{2})-(\d{2,4})\s+(\d{2}):(\d{2})(?:([AP]M))?\s+(<DIR>|\d+)\s+(.+)$/i.exec(t);
    if (dos) {
      const name = dos[8];
      if (!name) continue;
      out.set(name.toUpperCase(), { name, size: dos[7] === '<DIR>' ? undefined : parseInt(dos[7], 10), mtime: parseDosDate(dos[1], dos[2], dos[3], dos[4], dos[5], dos[6]), isDir: dos[7] === '<DIR>' });
      continue;
    }
    // FANUC style: "NAME.EXT      1234" or just the name
    const fanuc = /^([A-Za-z0-9_\-$]+\.[A-Za-z0-9]+)\s*(\d+)?/.exec(t);
    if (fanuc) out.set(fanuc[1].toUpperCase(), { name: fanuc[1], size: fanuc[2] ? parseInt(fanuc[2], 10) : undefined, isDir: false });
  }
  return [...out.values()];
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** `Jan 01 12:00` (this year) or `Jan 01 2024` → ms, or undefined when unparseable. */
function parseUnixDate(month: string, day: string, timeOrYear: string): number | undefined {
  const m = MONTHS.indexOf(month.slice(0, 3).toLowerCase());
  if (m < 0) return undefined;
  if (/^\d{4}$/.test(timeOrYear)) return Date.UTC(Number(timeOrYear), m, Number(day));
  const t = /^(\d{1,2}):(\d{2})/.exec(timeOrYear);
  if (!t) return undefined;
  return Date.UTC(new Date().getUTCFullYear(), m, Number(day), Number(t[1]), Number(t[2]));
}

/** `01-01-24 12:00PM` → ms, or undefined when unparseable. */
function parseDosDate(month: string, day: string, year: string, hour: string, minute: string, ampm?: string): number | undefined {
  let y = Number(year);
  if (year.length === 2) y += y >= 70 ? 1900 : 2000;
  let h = Number(hour);
  if (ampm) { if (/pm/i.test(ampm) && h < 12) h += 12; if (/am/i.test(ampm) && h === 12) h = 0; }
  return Date.UTC(y, Number(month) - 1, Number(day), h, Number(minute));
}

/**
 * `*.ls *.va` → a test. The shell-style wildcards people type at an FTP prompt, with a
 * space-separated list meaning any of them; case-insensitive because the controller is.
 */
export function globToRegExp(patterns: string): RegExp {
  const parts = patterns.trim().split(/[\s,;]+/).filter(Boolean);
  if (!parts.length) return /^$/;
  const alts = parts.map(p => '^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
  return new RegExp(alts.join('|'), 'i');
}
