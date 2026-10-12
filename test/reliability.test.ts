/**
 * Reliability and UX fixes (2026-10-11): how a caught failure becomes log text, which failures
 * the process-wide rejection hook keeps, and the RWS client's deadline, size cap and cancel
 * against a local server that misbehaves on purpose, the webview CSP and keyboard script, and
 * the contrast of the contributed colours. No vscode.
 * Wired in by test/run.ts: `await run(check)`.
 */
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { errorMessage, errorDetail, isOwnFailure, commandFailure } from '@core/errors';
import { RwsClient, rwsDeadlineMs } from '@abb/rws/client';
import { withCsp, webviewCsp, webviewNonce, ACTIVATE_JS } from '@core/webviewStyle';

function walkTs(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkTs(p, out); else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

function runCsp(check: (cond: unknown, msg: string) => void): void {
  const src = 'vscode-webview://abc';
  const page = '<!DOCTYPE html><html><head><meta charset="utf-8"><style>b{}</style></head><body><script>go()</script><SCRIPT type="module">x()</SCRIPT><scripts-are-not-this></scripts-are-not-this></body></html>';
  const out = withCsp(page, src, 'N0nce+/=');
  check(out.startsWith('<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy"'), 'withCsp: the policy is the first thing in <head>');
  check(out.includes(`script-src 'nonce-N0nce+/='`) && out.includes(`default-src 'none'`) && out.includes(`style-src ${src} 'unsafe-inline'`) && out.includes(`img-src ${src} data:`) && out.includes(`font-src ${src}`), `withCsp: the policy lists what a page may load (${webviewCsp(src, 'N0nce+/=')})`);
  check(out.includes('<script nonce="N0nce+/=">go()') && out.includes('<script nonce="N0nce+/=" type="module">x()'), 'withCsp: every <script> carries the nonce, any case');
  check(out.includes('<scripts-are-not-this>'), 'withCsp: only real <script> tags are touched');
  check(withCsp('<p>x</p>', src, 'n').startsWith('<meta http-equiv="Content-Security-Policy"'), 'withCsp: a page without <head> still gets the policy');
  check(withCsp('<!DOCTYPE html><p>x</p>', src, 'n').startsWith('<!DOCTYPE html><meta'), 'withCsp: ...after the doctype, so the page stays in standards mode');
  check(webviewNonce() !== webviewNonce() && /^[A-Za-z0-9+/]{22}==$/.test(webviewNonce()), 'webviewNonce: a fresh 128-bit base64 nonce each time');

  // ---- keyboard access (the client script, against a stand-in element) ----
  const el = (tagName: string, attrs: Record<string, string> = {}) => {
    const a = new Map(Object.entries(attrs));
    return {
      tagName, id: '', tabIndex: -1, onclick: null as unknown, onkeydown: null as unknown, classes: new Set<string>(),
      classList: { add(c: string) { this.owner.classes.add(c); }, owner: null as any },
      getAttribute: (n: string) => a.get(n) ?? null, setAttribute: (n: string, v: string) => { a.set(n, v); },
      get attributes() { return [...a].map(([name, value]) => ({ name, value })); },
      focused: false, focus() { this.focused = true; },
    };
  };
  const doc = { activeElement: null as unknown, body: {}, query: '' as string, found: null as unknown, querySelector(q: string) { this.query = q; return this.found; } };
  const kb = new Function('document', 'CSS', `${ACTIVATE_JS}; return { rcActivate, rcFocusKey, rcRestoreFocus };`)(doc, { escape: (s: string) => s }) as { rcActivate: (e: unknown, run: () => void) => void; rcFocusKey: () => string | null; rcRestoreFocus: (k: string | null) => void };
  const chip = el('SPAN'); chip.classList.owner = chip;
  let runs = 0;
  kb.rcActivate(chip, () => { runs++; });
  check(chip.tabIndex === 0 && chip.getAttribute('role') === 'button' && chip.classes.has('rc-activate'), 'rcActivate: a chip is reachable with Tab, is a button, and gets the focus style');
  const press = (key: string, target: unknown = chip) => { let prevented = false; (chip.onkeydown as (e: unknown) => void)({ key, target, preventDefault: () => { prevented = true; } }); return prevented; };
  check(press('Enter') && press(' ') && runs === 2, 'rcActivate: Enter and Space run it (and are not passed on)');
  check(!press('a') && !press('Enter', {}) && runs === 2, 'rcActivate: other keys, and keys meant for something inside it, do nothing');
  (chip.onclick as () => void)();
  check(runs === 3, 'rcActivate: a click still runs it');
  const row = el('TR'); row.classList.owner = row; kb.rcActivate(row, () => undefined);
  check(row.getAttribute('role') === null && row.tabIndex === 0, 'rcActivate: a table row keeps its row role');
  const opt = el('SPAN', { role: 'link' }); opt.classList.owner = opt; kb.rcActivate(opt, () => undefined);
  check(opt.getAttribute('role') === 'link', 'rcActivate: a role already given is kept');
  doc.activeElement = el('TR', { 'data-reg': '5', class: 'x' });
  check(kb.rcFocusKey() === 'tr[data-reg="5"]', `rcFocusKey: a focused row is found again by its data-* (${kb.rcFocusKey()})`);
  doc.activeElement = Object.assign(el('BUTTON'), { id: 'toggle' });
  check(kb.rcFocusKey() === '#toggle', 'rcFocusKey: ...or by its id');
  doc.activeElement = doc.body;
  check(kb.rcFocusKey() === null, 'rcFocusKey: nothing focused, nothing to restore');
  const again = el('TR'); doc.found = again; doc.activeElement = null;
  kb.rcRestoreFocus('tr[data-reg="5"]');
  check(again.focused && doc.query === 'tr[data-reg="5"]', 'rcRestoreFocus: focuses the element drawn in its place');

  // Every page that runs scripts goes through withCsp, and none uses an inline handler
  // attribute (onclick="..."): the policy blocks those, and the page would silently stop working.
  const root = path.resolve(__dirname, '..', 'packages');
  if (!fs.existsSync(root)) return;
  for (const file of walkTs(root)) {
    const text = fs.readFileSync(file, 'utf8');
    if (!/enableScripts: true/.test(text)) continue;
    const rel = path.relative(root, file);
    check(/withCsp\(/.test(text), `${rel}: a webview with scripts sets its HTML through withCsp`);
    check(/localResourceRoots: \[\]/.test(text), `${rel}: a webview loads no local files (localResourceRoots: [])`);
    const handler = /<[a-z][^<>]*\son(?:click|change|input|keydown|keyup|submit|load|dblclick|mouse\w+|focus|blur|wheel)\s*=/i.exec(text);
    check(!handler, `${rel}: no inline event handler attributes${handler ? ` (${handler[0].slice(0, 60)})` : ''}`);
  }
}

/** WCAG 2 contrast ratio of two #rrggbb colours */
function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function runContrast(check: (cond: unknown, msg: string) => void): void {
  check(Math.abs(contrast('#ffffff', '#000000') - 21) < 1e-9 && Math.abs(contrast('#777777', '#ffffff') - 4.48) < 0.01, 'contrast: the WCAG formula');
  // Every colour the extension contributes is text drawn on the editor: 4.5:1 on the default
  // background of each theme kind, and each has its own high-contrast values.
  const pkgPath = path.resolve(__dirname, '..', 'package.json');
  if (!fs.existsSync(pkgPath)) return;
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { contributes: { colors: { id: string; defaults: Record<string, string> }[] } };
  const editorBackground: Record<string, string> = { dark: '#1e1e1e', light: '#ffffff', highContrast: '#000000', highContrastLight: '#ffffff' };
  for (const c of pkg.contributes.colors) {
    check(['dark', 'light', 'highContrast', 'highContrastLight'].every(k => /^#[0-9a-f]{6}$/i.test(c.defaults[k] ?? '')), `${c.id}: a colour for every theme kind, high contrast included`);
    for (const [kind, bg] of Object.entries(editorBackground)) {
      const fg = c.defaults[kind];
      if (!fg || !/^#[0-9a-f]{6}$/i.test(fg)) continue;
      const r = contrast(fg, bg);
      check(r >= 4.5, `${c.id} (${kind}): ${fg} on ${bg} is ${r.toFixed(2)}:1, at least 4.5:1`);
    }
  }
}

/** the message a promise rejects with, or undefined when it resolves */
async function rejection(p: Promise<unknown>): Promise<string | undefined> {
  try { await p; return undefined; } catch (e) { return errorMessage(e); }
}

async function runRws(check: (cond: unknown, msg: string) => void): Promise<void> {
  check(rwsDeadlineMs(5000) === 60_000, 'rwsDeadlineMs: a 60 s floor at the default 5 s inactivity limit');
  check(rwsDeadlineMs(10_000) === 120_000, 'rwsDeadlineMs: twelve times a longer inactivity limit');
  check(rwsDeadlineMs(5000, 1024 * 1024) === 60_000 + 1024 * 50, 'rwsDeadlineMs: an upload adds time per KiB');
  check(rwsDeadlineMs(5000, 1024 * 1024 * 1024) === 10 * 60_000, 'rwsDeadlineMs: capped at 10 minutes');

  // /trickle sends a byte every 50 ms forever (never idle, never done); /big sends 2 KiB;
  // /slow answers after 2 s; /ok answers at once
  const trickles: NodeJS.Timeout[] = [];
  const server = http.createServer((req, res) => {
    if (req.url === '/trickle') { res.writeHead(200); trickles.push(setInterval(() => res.write('x'), 50)); return; }
    if (req.url === '/big') { res.writeHead(200); res.end(Buffer.alloc(2048, 65)); return; }
    if (req.url === '/slow') { setTimeout(() => { res.writeHead(200); res.end('late'); }, 2000); return; }
    res.writeHead(200); res.end('fine');
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const client = (extra: object = {}) => new RwsClient({ host: '127.0.0.1', port, user: 'u', password: 'p', timeoutMs: 1000, ...extra });
  try {
    const t0 = Date.now();
    const trickled = await rejection(client({ deadlineMs: 300 }).bytes('/trickle'));
    check(/did not finish GET \/trickle/.test(trickled ?? '') && Date.now() - t0 < 1500, `RWS: a trickling answer ends at the deadline, not never (${trickled})`);

    const big = await rejection(client({ maxResponseBytes: 1024 }).bytes('/big'));
    check(/sent more than/.test(big ?? ''), `RWS: an answer over the size cap is dropped (${big})`);
    check((await client({ maxResponseBytes: 4096 }).bytes('/big')).length === 2048, 'RWS: an answer under the cap is read whole');

    const ac = new AbortController();
    const c = client({ timeoutMs: 5000 });
    const slow = c.bytes('/slow', ac.signal);
    const queued = c.bytes('/ok', ac.signal);   // waits behind /slow in the client's queue
    setTimeout(() => ac.abort(), 100);
    const t1 = Date.now();
    const [slowErr, queuedErr] = await Promise.all([rejection(slow), rejection(queued)]);
    check(slowErr === 'cancelled' && Date.now() - t1 < 1500, `RWS: a cancel ends the request in flight at once (${slowErr})`);
    check(queuedErr === 'cancelled', `RWS: a cancelled request waiting its turn is never sent (${queuedErr})`);
    check((await rejection(client().bytes('/ok', AbortSignal.abort()))) === 'cancelled', 'RWS: an already-cancelled signal sends nothing');
    check((await c.bytes('/ok')).toString() === 'fine', 'RWS: the client works again after a cancel');
  } finally {
    for (const t of trickles) clearInterval(t);
    server.closeAllConnections();
    await new Promise<void>(r => server.close(() => r()));
  }
}

export async function run(check: (cond: unknown, msg: string) => void): Promise<void> {
  await runRws(check);
  runCsp(check);
  runContrast(check);
  // ---- error text ----
  const err = new Error('socket hang up');
  check(errorMessage(err) === 'socket hang up', 'errorMessage: an Error gives its message');
  check(errorMessage('plain text') === 'plain text', 'errorMessage: a thrown string is itself');
  check(errorMessage({ message: 'shaped' }) === 'shaped', 'errorMessage: an object with a message string');
  check(errorMessage(undefined) === 'undefined' && errorMessage(42) === '42', 'errorMessage: anything else as a string');
  check(errorMessage(new TypeError('')) === 'TypeError', 'errorMessage: an empty message falls back to the error name');
  check(errorDetail(err).startsWith('Error: socket hang up') && errorDetail(err).includes('\n'), 'errorDetail: an Error gives its stack');
  const noStack = new Error('no stack'); noStack.stack = undefined;
  check(errorDetail(noStack) === 'no stack', 'errorDetail: an Error without a stack gives its message');
  check(errorDetail('x') === 'x', 'errorDetail: a non-Error gives its message');

  // ---- a command that threw ----
  const f = commandFailure('robotCode.live.connect', err);
  check(f.message === 'RUKUS: socket hang up', `commandFailure: a short message for the user (${f.message})`);
  check(f.log.startsWith('[command] robotCode.live.connect failed: Error: socket hang up') && f.log.includes('\n'), 'commandFailure: the log line names the command and keeps the stack');
  check(commandFailure('robotCode.abb.backup', 'no session').message === 'ABB: no session', 'commandFailure: ABB commands say ABB, as their other messages do');

  // ---- whose failure ----
  const ours = new Error('ours'); ours.stack = 'Error: ours\n    at tick (C:\\Users\\me\\.vscode\\extensions\\rukus.robot-code-26.109.8\\dist\\extension.js:1:2)';
  const theirs = new Error('theirs'); theirs.stack = 'Error: theirs\n    at x (C:\\Users\\me\\.vscode\\extensions\\other.ext-1.0.0\\out\\main.js:1:2)';
  check(isOwnFailure(ours, 'c:/users/me/.vscode/extensions/rukus.robot-code-26.109.8'), 'isOwnFailure: a stack through our folder is ours (slashes and case ignored)');
  check(!isOwnFailure(theirs, 'C:\\Users\\me\\.vscode\\extensions\\rukus.robot-code-26.109.8'), 'isOwnFailure: another extension\'s stack is not ours');
  check(!isOwnFailure('a string', 'C:\\x') && !isOwnFailure(ours, ''), 'isOwnFailure: no stack or no path: not ours');
}
