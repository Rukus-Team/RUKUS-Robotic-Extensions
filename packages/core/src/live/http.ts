/**
 * Minimal HTTP client for the FANUC controller web server.
 * Files on a device are served as http://<host>/<DEV>/<FILE>  (e.g. /MD/NUMREG.VA).
 * Diagnostic files such as CURPOS.DG and PRGSTATE.DG are generated on each request.
 */
import * as http from 'node:http';
import type { RemoteFile } from './types';
import { unwrapControllerHtml, isTextFile } from './html';

export interface HttpOptions { host: string; port: number; timeoutMs?: number }

export function deviceToPath(device: string): string {
  return '/' + device.replace(/:$/, '').replace(/^\/+|\/+$/g, '') + '/';
}

export function httpGet(opts: HttpOptions, path: string, signal?: AbortSignal): Promise<{ status: number; body: Buffer; contentType?: string }> {
  const timeoutMs = opts.timeoutMs ?? 8000;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('aborted')); return; }
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const settle = (fn: () => void) => { if (settled) return; settled = true; if (timer) clearTimeout(timer); signal?.removeEventListener('abort', onAbort); fn(); };
    const req = http.request({ host: opts.host, port: opts.port, path: encodeURI(path), method: 'GET', headers: { Connection: 'close', Accept: '*/*' } }, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => settle(() => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks), contentType: res.headers['content-type'] })));
      res.on('error', e => settle(() => reject(e)));
    });
    // A cancel (the progress bar, or the extension shutting a transfer down) closes our side
    // deterministically instead of leaving the request - and the controller's session - hanging.
    const onAbort = () => { req.destroy(); settle(() => reject(new Error('aborted'))); };
    signal?.addEventListener('abort', onAbort, { once: true });
    // An absolute deadline, not just a socket-inactivity timeout: a web server that accepts the
    // TCP connection and then never answers (a FANUC controller's server can wedge like this after
    // a transfer is cut mid-flight) must still fail in bounded time, so a connect can't hang.
    timer = setTimeout(() => { req.destroy(); settle(() => reject(new Error(`timeout after ${timeoutMs} ms`))); }, timeoutMs);
    req.on('error', e => settle(() => reject(e)));
    req.end();
  });
}

export async function httpGetText(opts: HttpOptions, device: string, file: string, signal?: AbortSignal): Promise<string> {
  const r = await httpGet(opts, deviceToPath(device) + file, signal);
  if (r.status !== 200) throw new Error(`HTTP ${r.status} for ${device}${file}`);
  return unwrapControllerHtml(r.body.toString('latin1'));
}

/** Raw bytes; text files are unwrapped from the web server's HTML/<XMP> wrapper. */
export async function httpGetBinary(opts: HttpOptions, device: string, file: string, signal?: AbortSignal): Promise<Buffer> {
  const r = await httpGet(opts, deviceToPath(device) + file, signal);
  if (r.status !== 200) throw new Error(`HTTP ${r.status} for ${device}${file}`);
  if (isTextFile(file)) return Buffer.from(unwrapControllerHtml(r.body.toString('latin1')), 'latin1');
  return r.body;
}

/** Index pages the controller publishes instead of a bare directory listing. */
const INDEX_PAGES = ['INDEX_TP.HTM', 'INDEX_VR.HTM', 'INDEX_OT.HTM', 'INDEX_ER.HTM'];

const FILE_RE = /\b([A-Za-z0-9_\-$]+\.(?:LS|VA|DG|TP|PC|VR|SV|IO|DT|CM|CF|TXT|ZIP|XML|HTM|STM|CSV|LOG|DAT|VD|VDA|CAM|GIF|PMC|DF|IPL|KL|TX|FTX|UTX|BMP|JPG|PNG|MN|VD|ZIP))\b/gi;

/** Parse the HTML (or plain text) directory listing the web server returns for /MD/ */
export function parseHttpListing(html: string): RemoteFile[] {
  const out = new Map<string, RemoteFile>();
  // anchors first (keeps original names), then any bare file-looking tokens
  for (const m of html.matchAll(/href\s*=\s*"([^"]+)"/gi)) {
    const target = m[1].split(/[?#]/)[0];
    const name = decodeURIComponent(target.split('/').filter(Boolean).pop() ?? '');
    if (!name || name.includes(':') && !/^[A-Za-z0-9_\-$]+\.\w+$/.test(name)) continue;
    if (/^[A-Za-z0-9_\-$]+\.[A-Za-z0-9]+$/.test(name)) out.set(name.toUpperCase(), { name, isDir: false });
    else if (target.endsWith('/') && /^[A-Za-z0-9_\-$:]+$/.test(name) && !/^\.\.?$/.test(name)) out.set(name.toUpperCase(), { name, isDir: true });
  }
  if (out.size === 0) {
    for (const m of html.replace(/<[^>]+>/g, ' ').matchAll(FILE_RE)) out.set(m[1].toUpperCase(), { name: m[1], isDir: false });
  }
  // sizes from "NAME.EXT   1234" patterns in text listings
  const text = html.replace(/<[^>]+>/g, ' ');
  for (const f of out.values()) {
    const re = new RegExp(`${f.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+(\\d{1,9})\\b`, 'i');
    const m = re.exec(text);
    if (m) f.size = parseInt(m[1], 10);
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function httpList(opts: HttpOptions, device: string, signal?: AbortSignal): Promise<RemoteFile[]> {
  const r = await httpGet(opts, deviceToPath(device), signal);
  if (r.status === 200) {
    const files = parseHttpListing(r.body.toString('latin1'));
    if (files.length) return files;
  }
  // R-30iB: /MD/ itself is 404; the INDEX_*.HTM pages list programs, variable files, others and logs
  const merged = new Map<string, RemoteFile>();
  let any = false;
  for (const page of INDEX_PAGES) {
    try {
      const p = await httpGet(opts, deviceToPath(device) + page, signal);
      if (p.status !== 200) continue;
      any = true;
      for (const f of parseHttpListing(p.body.toString('latin1'))) if (!/^INDEX_.*\.HTM$/i.test(f.name)) merged.set(f.name.toUpperCase(), f);
    } catch { /* try next */ }
  }
  if (!any) throw new Error(`HTTP ${r.status} listing ${device} (and no INDEX_*.HTM pages)`);
  return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
}
