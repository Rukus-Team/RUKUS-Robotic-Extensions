// A mock IRC5 Robot Web Services 1.0 server that answers from a real controller's RWS crawl
// (abb-reference/rws-crawl-*/, captured 2026-09-24 off an IRC5, RobotWare 6.16). The pages are
// served as they were captured; nothing from the crawl is copied into this repo.
//
//   startMockRws(crawlDir, port, { user, password }) -> { server, port, stats, close() }
//
// It behaves like the controller in the ways a client can get wrong:
//   - HTTP Digest (MD5, qop=auth) on the first request, 401 otherwise;
//   - a session cookie (-http-session-, ABBCX) afterwards, accepted in place of the Digest;
//   - GET only for /rw, except the three kinematics calculations (POST ?action=CalcPoseFromJoints,
//     JointsFromCartesian, AllJointSolutions - counted in stats.calcs). Any other ?action= or
//     method is refused (405) and counted in stats.actions, so a test can assert none was sent.
//     The "robot" is a toy with the controller's units: FK answers the joints (radians) as the
//     position (metres), IK the reverse, so a test sees unit conversion both ways;
//   - ?resource=module-text for any module in the crawl's module list, as RW 6.16 answers it
//     (the crawl has no source, so the text is made up: MODULE <name> ... ENDMODULE). Module BIG
//     answers with a file-path in $TEMP instead, as a module too big to send inline does;
//   - a small controller disk ($HOME, $TEMP, $BACKUP) behind /fileservice: listings (paged 4
//     entries at a time, with a `next` link, to exercise paging), file reads, and a recursive
//     DELETE (stats.deletes) of anything that exists;
//   - backup as RW 6.16 does it: POST /ctrl/backup?action=backup with backup=/fileservice/$BACKUP/x
//     (any other form is "Invalid File Service path"), 202, then GET ?action=backupstate reads
//     "Backup in Progress" twice before "Backup Ready" and the folder appears (stats.backups);
//   - /logout ends the session;
//   - subscriptions as a controller takes them: POST /subscription answers 201 with the event
//     socket in Location, the socket (/poll/<n>, session cookie required) is accepted and kept
//     open without events, DELETE /subscription/<n> ends one (stats.subscriptions, .unsubscriptions).
// A crawl page's file name is its URL with / ? = & turned into _ ; lookups compare names with
// runs of _ collapsed, which is how the crawler wrote them.
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

const md5 = s => createHash('md5').update(s).digest('hex');
const REALM = 'validusers@robapi.abb';

export function startMockRws(crawlDir, port = 0, creds = { user: 'Default User', password: 'robotics' }) {
  const index = new Map();
  for (const f of fs.readdirSync(crawlDir)) if (f.endsWith('.html')) index.set(f.slice(0, -5).replace(/_+/g, '_').replace(/_$/, '').toLowerCase(), path.join(crawlDir, f));
  const nonces = new Set();
  const sessions = new Set();
  const stats = { requests: 0, unauthorized: 0, actions: 0, calcs: 0, deletes: 0, backups: 0, notFound: 0, logins: 0, logouts: 0, subscriptions: 0, unsubscriptions: 0, sessionsOpen: () => sessions.size };
  const eventSockets = new Set();
  // the controller's disk: '$BACKUP/x/SYSPAR/MOC.cfg' -> bytes; folders are implied, plus the roots
  const disk = new Map([['$HOME/user.sys', Buffer.from('MODULE user(SYSMODULE)\nENDMODULE\n')]]);
  const ROOTS = ['$HOME', '$TEMP', '$BACKUP'];
  const isDir = p => ROOTS.includes(p) || [...disk.keys()].some(k => k.startsWith(`${p}/`));
  let backup = { state: 'Init State', polls: 0, dest: undefined };

  const authorized = req => {
    const cookie = req.headers.cookie ?? '';
    const sid = /-http-session-=([^;]+)/.exec(cookie)?.[1];
    if (sid && sessions.has(sid)) return { ok: true };
    const h = req.headers.authorization ?? '';
    if (!/^Digest /.test(h)) return { ok: false };
    const f = {};
    for (const m of h.slice(7).matchAll(/(\w+)\s*=\s*(?:"([^"]*)"|([^,\s]*))/g)) f[m[1]] = m[2] ?? m[3];
    if (!nonces.has(f.nonce) || f.username !== creds.user || f.realm !== REALM || f.uri !== req.url) return { ok: false };
    const ha1 = md5(`${creds.user}:${REALM}:${creds.password}`), ha2 = md5(`${req.method}:${f.uri}`);
    const want = f.qop ? md5(`${ha1}:${f.nonce}:${f.nc}:${f.cnonce}:${f.qop}:${ha2}`) : md5(`${ha1}:${f.nonce}:${ha2}`);
    return { ok: want === f.response, fresh: true };
  };

  const CALCS = ['CalcPoseFromJoints', 'JointsFromCartesian', 'AllJointSolutions'];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => handle(req, res, new URLSearchParams(Buffer.concat(chunks).toString('utf8'))));
  });
  const handle = (req, res, form) => {
    stats.requests++;
    const url = new URL(req.url, 'http://x');
    const action = url.searchParams.get('action');
    const calc = req.method === 'POST' && CALCS.includes(action) && /^\/rw\/motionsystem\/mechunits\/[^/]+$/.test(url.pathname);
    const fsp = url.pathname.startsWith('/fileservice/') ? url.pathname.slice('/fileservice/'.length).split('/').filter(Boolean).map(decodeURIComponent).join('/') : undefined;
    const backupPost = req.method === 'POST' && url.pathname === '/ctrl/backup' && action === 'backup';
    const subscription = (req.method === 'POST' && url.pathname === '/subscription') || (req.method === 'DELETE' && /^\/subscription\/[^/]+$/.test(url.pathname));
    const allowed = calc || backupPost || subscription || (req.method === 'GET' && (!action || (url.pathname === '/ctrl/backup' && action === 'backupstate')))
      || (req.method === 'DELETE' && fsp !== undefined && !ROOTS.includes(fsp) && (disk.has(fsp) || isDir(fsp)));
    if (!allowed) { stats.actions++; res.writeHead(405); res.end(); return; }
    const a = authorized(req);
    if (!a.ok) {
      stats.unauthorized++;
      const nonce = randomBytes(16).toString('hex'); nonces.add(nonce);
      res.writeHead(401, { 'WWW-Authenticate': `Digest realm="${REALM}", nonce="${nonce}", qop="auth", opaque="${randomBytes(8).toString('hex')}", algorithm=MD5` });
      res.end(); return;
    }
    const headers = { 'Content-Type': 'application/xhtml+xml;v=2.0' };
    if (a.fresh) {
      stats.logins++;
      const sid = randomBytes(12).toString('hex'); sessions.add(sid);
      headers['Set-Cookie'] = [`-http-session-=${sid}; path=/; httponly`, `ABBCX=${sessions.size}; path=/; httponly`];
    }
    if (url.pathname === '/logout') {
      const sid = /-http-session-=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
      if (sid) sessions.delete(sid);
      stats.logouts++;
      res.writeHead(204, headers); res.end(); return;
    }
    if (subscription) {
      if (req.method === 'DELETE') { stats.unsubscriptions++; res.writeHead(200, headers); res.end(); return; }
      stats.subscriptions++;
      res.writeHead(201, { ...headers, Location: `ws://${req.headers.host}/poll/${stats.subscriptions}` }); res.end(); return;
    }
    if (calc) {
      stats.calcs++;
      const nums = k => (form.get(k) ?? '').replace(/[[\]\s]/g, '').split(',').map(Number);
      const page = li => `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>motionsystem</title></head><body><div class="state"><ul>${li}</ul></div></body></html>`;
      const span = (c, v) => `<span class="${c}">${v}</span>`;
      if (!form.has('tool_frame_position') || !form.has('robot_fixed_object')) { res.writeHead(400, headers); res.end(page('') + '<span class="msg">robot_fixed_object data parameter is required</span>'); return; }
      res.writeHead(200, headers);
      if (action === 'CalcPoseFromJoints') {
        const j = nums('rob_joints');
        res.end(page(`<li class="position-from-joint" title="positionData">${['x', 'y', 'z'].map((c, i) => span(`position-${c}`, j[i])).join('')}${[1, 0, 0, 0].map((v, i) => span(`robtargetorientation-u${i}`, v)).join('')}${['j1', 'j4', 'j6', 'jx'].map(c => span(`quarter-rev-${c}`, 0)).join('')}</li>`));
      } else {
        const p = nums('curr_position');
        const li = cls => `<li class="${cls}" title="jointData">${[0, 1, 2].map(i => span(`robotjoint${i + 1}`, p[i])).join('')}${[4, 5, 6].map(i => span(`robotjoint${i}`, 0)).join('')}${action === 'AllJointSolutions' ? ['j11', 'j4', 'j6', 'jx'].map(c => span(`quarter_rev_${c}`, 0)).join('') : ''}</li>`;
        res.end(page(action === 'AllJointSolutions' ? li('all-joint-solutions') + li('all-joint-solutions') : li('joints-from-cartesian')));
      }
      return;
    }
    if (url.searchParams.get('resource') === 'module-text') {
      const mod = decodeURIComponent(url.pathname.split('/').pop());
      const list = index.get(`rw_rapid_modules_task_${(url.searchParams.get('task') ?? '').toLowerCase()}`);
      const known = mod === 'BIG' || (list && fs.readFileSync(list, 'utf8').includes(`class="name">${mod}<`));
      if (!known) { res.writeHead(400, headers); res.end('<html><body><div class="status"><span class="code">-1073445866</span><span class="msg">C:\\x\\rws_resource_rapid.cpp[1] Unresolved url code:-1073445866 icode:-1</span></div></body></html>'); return; }
      const text = `\nMODULE ${mod}\n  ! mock text: a <> b & "c"\n  PROC main()\n  ENDPROC\nENDMODULE\n`;
      const esc = t => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      let spans;
      if (mod === 'BIG') { disk.set('$TEMP/BIG.mod', Buffer.from(text.replace('mock text', 'mock text via file \xe9'), 'latin1')); spans = `<span class="file-path">$TEMP/BIG.mod</span><span class="module-text"></span>`; }
      else spans = `<span class="module-text">${esc(text)}</span>`;
      res.writeHead(200, headers);
      res.end(`<html><body><div class="state"><ul><li class="rap-module-text" title="moduletext"><span class="change-count"> 4711 </span>${spans}<span class="module-length">1368</span> </li></ul></div></body></html>`);
      return;
    }
    const fsErr = (status, msg) => { res.writeHead(status, headers); res.end(`<html><body><div class="status"><span class="code">-1073414146</span><span class="msg">C:\\x\\rapi_file_service.cpp[221] ${msg} -1073414146 -1</span></div></body></html>`); };
    if (backupPost) {
      const dest = form.get('backup') ?? '';
      if (!dest.startsWith('/fileservice/$BACKUP/')) { fsErr(400, 'Invalid File Service path'); return; }
      const d = dest.slice('/fileservice/'.length);
      if (isDir(d) || /progress/i.test(backup.state)) { fsErr(400, 'Invalid File Service path'); return; }
      stats.backups++;
      backup = { state: 'Backup in Progress', polls: 0, dest: d };
      res.writeHead(202, headers); res.end(); return;
    }
    if (url.pathname === '/ctrl/backup' && action === 'backupstate') {
      if (/progress/i.test(backup.state) && ++backup.polls > 2) {
        const d = backup.dest;
        for (const [f, text] of [['system.xml', '<system/>'], ['BACKINFO/backinfo.txt', '>>SYSTEM_ID:\nMOCK\n'], ['BACKINFO/system.guid', '{0}'], ['HOME/user.sys', 'MODULE user(SYSMODULE)\nENDMODULE\n'],
          ['RAPID/TASK1/PROGMOD/MAIN_MODULE.mod', 'MODULE MAIN_MODULE\n  PROC main()\n  ENDPROC\nENDMODULE\n'], ['RAPID/TASK1/SYSMOD/user.sys', 'MODULE user(SYSMODULE)\nENDMODULE\n'],
          ['SYSPAR/MOC.cfg', 'MOC:CFG_1.0:6:0::\n'], ['SYSPAR/EIO.cfg', 'EIO:CFG_1.0:6:0::\n']])
          disk.set(`${d}/${f}`, Buffer.from(text, 'latin1'));
        backup.state = 'Backup Ready';
      }
      res.writeHead(200, headers);
      res.end(`<html><body><div class="state"><a href="?action=backupstate" rel="self"></a><ul><li class="ctrl-backup-state" title="backup state"><span class="backup state">${backup.state}</span></li></ul></div></body></html>`);
      return;
    }
    if (fsp !== undefined && fsp !== '' && fsp.startsWith('$')) {
      if (req.method === 'DELETE') {
        stats.deletes++;
        for (const k of [...disk.keys()]) if (k === fsp || k.startsWith(`${fsp}/`)) disk.delete(k);
        res.writeHead(204, headers); res.end(); return;
      }
      const f = disk.get(fsp);
      if (f) { res.writeHead(200, { ...headers, 'Content-Type': 'application/octet-stream' }); res.end(f); return; }
      if (!isDir(fsp)) { stats.notFound++; fsErr(404, 'Resource does not exist'); return; }
      const entries = new Map();
      for (const [k, v] of disk) if (k.startsWith(`${fsp}/`)) { const [first, ...rest] = k.slice(fsp.length + 1).split('/'); if (!entries.has(first)) entries.set(first, rest.length ? null : v); }
      const all = [...entries].sort(([a], [b]) => a.localeCompare(b));
      const start = Number(url.searchParams.get('start') ?? 0);
      const pageOf = all.slice(start, start + 4);
      const next = start + 4 < all.length ? `<a href="?start=${start + 4}" rel="next"></a>` : '';
      const li = ([n, v]) => v === null ? `<li class="fs-dir" title="${n}"><a href="${encodeURIComponent(n)}" rel="self"></a></li>` : `<li class="fs-file" title="${n}"><a href="${encodeURIComponent(n)}" rel="self"></a><span class="fs-size">${v.length}</span></li>`;
      res.writeHead(200, headers);
      res.end(`<html><body><div class="state"><a href="" rel="self"></a>${next}<ul>${pageOf.map(li).join('')}</ul></div></body></html>`);
      return;
    }
    const key = (url.pathname.replace(/^\//, '') + (url.search ? `?${url.search.slice(1)}` : ''))
      .replace(/[/?=&]/g, '_').replace(/_+/g, '_').replace(/_$/, '').toLowerCase();
    const file = index.get(key);
    if (!file) { stats.notFound++; res.writeHead(404, headers); res.end(`<html><body><div class="status"><a href="${req.url}" rel="error"/></div></body></html>`); return; }
    res.writeHead(200, headers);
    res.end(fs.readFileSync(file));
  };
  // the event socket: the handshake for a session, then held open (the mock sends no events)
  server.on('upgrade', (req, socket) => {
    const sid = /-http-session-=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
    if (!/^\/poll\/\d+$/.test(req.url) || !sid || !sessions.has(sid)) { socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n'); return; }
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${accept}`, `Sec-WebSocket-Protocol: ${req.headers['sec-websocket-protocol'] ?? ''}`, '', ''].join('\r\n'));
    eventSockets.add(socket);
    socket.on('data', () => undefined);
    socket.on('error', () => undefined);
    socket.on('close', () => eventSockets.delete(socket));
  });
  const close = () => { for (const s of eventSockets) s.destroy(); return new Promise(r => server.close(() => r())); };
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port, stats, disk, close })));
}

/** the crawl folder next to the repo (the most complete run), or $RWS_CRAWL; undefined when absent */
export function findRwsCrawl(repoDir) {
  if (process.env.RWS_CRAWL && fs.existsSync(process.env.RWS_CRAWL)) return process.env.RWS_CRAWL;
  let dir = repoDir;
  for (let i = 0; i < 6; i++) {
    const c = path.join(path.dirname(dir), 'abb-reference', 'rws-crawl-20260924-1213');
    if (fs.existsSync(c)) return c;
    dir = path.dirname(dir);
  }
  return undefined;
}
