// Mock FANUC controller for tests: serves a backup folder over the same HTTP and FTP
// shapes an R-30iB uses (http://host/MD/FILE, FTP CWD MD: + RETR), with a fake
// running TP task and a ticking register so live features can be exercised.
//   node test/mockRobot.mjs <backupDir> [httpPort=18080] [ftpPort=18021]
import * as http from 'node:http';
import * as net from 'node:net';
import * as fs from 'node:fs';
import * as path from 'node:path';

export function startMockRobot(dir, httpPort = 18080, ftpPort = 18021, opts = {}) {
  const files = () => fs.readdirSync(dir).filter(f => fs.statSync(path.join(dir, f)).isFile());
  const find = name => files().find(f => f.toLowerCase() === name.toLowerCase());
  // requests: every HTTP path this controller was asked for, in order, with a timestamp.
  // The point of the whole on-demand rework is that this list stays SHORT and stops growing
  // the moment nobody is pressing anything, and a claim like that is only worth making if
  // something measures it from the outside - see the traffic checks in integration.js.
  const state = { tick: 0, runningProgram: opts.runningProgram ?? 'ENTERZON', runningLine: opts.runningLine ?? 44, r151: 2, requests: [] };

  function generated(name) {
    const n = name.toUpperCase();
    if (n === 'PRGSTATE.DG') {
      const stamp = new Date().toISOString();
      return `F Number: F368808\nVERSION : SpotTool+\n$VERSION: V9.40188      5/27/2022\nDATE:     ${stamp}\n\nTASK STATES:\n\n1      ${state.runningProgram} status = RUNNING\n\n******  History Data  ******\nRoutine depth: 0  Routine: ${state.runningProgram}\nLine:   ${String(state.runningLine + (state.tick % 3)).padStart(3)}       Program: ${state.runningProgram.padEnd(32)} Type: TP\n\n2      MHMENUC status = ABORTED\n\n******  History Data  ******\nRoutine depth: 0  Routine: MHMENUC\nLine:    75       Program: MHMENUC                               Type: PC\n`;
    }
    if (n === 'NUMREG.VA') {
      const real = find('numreg.va');
      let text = real ? fs.readFileSync(path.join(dir, real), 'latin1') : "[*NUMREG*]$NUMREG  Storage: SHADOW  Access: RW  : ARRAY[250] OF Numeric Reg\n";
      // make R[151] tick so "live" is visibly live
      text = text.replace(/^(\s*\[151\]\s*=\s*)\S+/m, `$1${state.r151 + state.tick}`);
      return text;
    }
    return undefined;
  }

  // files STORed by a client, kept in memory (the backup folder on disk is never written)
  const uploads = new Map();
  function body(name) {
    const up = uploads.get(name.toUpperCase());
    if (up) return up;
    const gen = generated(name);
    if (gen !== undefined) return Buffer.from(gen, 'latin1');
    const f = find(name);
    return f ? fs.readFileSync(path.join(dir, f)) : undefined;
  }

  const httpServer = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url ?? '/');

    // The request log, read back over HTTP because the test runs inside VS Code and this
    // server runs in the launcher process. Deliberately NOT counted or ticked itself -
    // the observer must not show up in what it is observing.
    if (url === '/_stats' || url.startsWith('/_stats?')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ count: state.requests.length, requests: state.requests }));
      return;
    }

    state.tick++;
    state.requests.push({ at: Date.now(), path: url });
    // The controller serves a static page at /, which is what the extension probes on
    // connect - it must never have to ask for a generated .DG file just to say hello.
    if (url === '/' || /^\/index\.(htm|html)$/i.test(url)) {
      state.rootHits = (state.rootHits ?? 0) + 1;
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body><h1>FANUC Robot</h1></body></html>');
      return;
    }
    const m = /^\/(MD|FR|UD1|MC)\/?([^/?]*)$/i.exec(url);
    if (!m) { res.writeHead(404); res.end('not found'); return; }
    if (!m[2]) {
      const list = files().map(f => `<tr><td><a href="/MD/${f}">${f}</a></td><td align="right">${fs.statSync(path.join(dir, f)).size}</td></tr>`).join('\n');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<html><body><h2>MD:</h2><table>${list}</table></body></html>`);
      return;
    }
    const b = body(m[2]);
    if (!b) { res.writeHead(404); res.end('no such file'); return; }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(b);
  });
  httpServer.listen(httpPort, '127.0.0.1');

  // ---- tiny FTP server (passive only) ----
  const ftpServer = net.createServer(sock => {
    let cwd = 'MD:';
    let dataServer;
    let pendingConn; // data connection that arrived before the transfer command (normal for passive clients)
    const send = s => sock.write(s + '\r\n');
    send('220 FANUC Robot FTP mock ready');
    const withData = fn => {
      if (!dataServer) { send('425 Use PASV first'); return; }
      const ds = dataServer; dataServer = undefined;
      const run = conn => { fn(conn); conn.on('close', () => ds.close()); };
      if (pendingConn) { const c = pendingConn; pendingConn = undefined; run(c); }
      else ds.once('connection', run);
    };
    sock.on('data', buf => {
      for (const line of buf.toString('latin1').split(/\r?\n/)) {
        if (!line) continue;
        const [cmd, ...rest] = line.split(' '); const arg = rest.join(' ');
        switch (cmd.toUpperCase()) {
          case 'USER': send('331 Password required'); break;
          case 'PASS': send('230 Logged in'); break;
          case 'SYST': send('215 UNIX Type: L8'); break;
          case 'FEAT': send('211 End'); break;
          case 'TYPE': send('200 Type set'); break;
          case 'NOOP': send('200 OK'); break;
          case 'PWD': send(`257 "${cwd}"`); break;
          case 'CWD': cwd = arg || cwd; send('250 CWD ok'); break;
          case 'PASV': {
            dataServer = net.createServer();
            pendingConn = undefined;
            dataServer.on('connection', c => { if (!dataServer || dataServer.listenerCount('connection') > 1) return; pendingConn = c; });
            dataServer.listen(0, '127.0.0.1', () => {
              const port = dataServer.address().port;
              send(`227 Entering Passive Mode (127,0,0,1,${Math.floor(port / 256)},${port % 256})`);
            });
            break;
          }
          case 'LIST': case 'NLST': {
            const listing = files().map(f => cmd.toUpperCase() === 'NLST' ? f : `-rw-r--r-- 1 robot robot ${fs.statSync(path.join(dir, f)).size} Jan 01 00:00 ${f}`).join('\r\n') + '\r\n';
            send('150 Opening data connection');
            withData(conn => { conn.end(listing, 'latin1'); send('226 Transfer complete'); });
            break;
          }
          case 'RETR': {
            const name = arg.replace(/^.*[\\/:]/, '').toUpperCase();
            // Two files a real controller produces and a happy-path mock never did:
            // SLOW.DG dribbles out over ~0.8 s with the control channel silent the whole
            // time (a big .va on a slow plant link); RESET.DG drops the data connection
            // half way and answers 426, after which the session must still be in step.
            if (name === 'SLOW.DG') {
              send('150 Opening data connection');
              withData(conn => {
                let n = 0;
                const tick = setInterval(() => { conn.write(`slow chunk ${n}\r\n`); if (++n >= 8) { clearInterval(tick); conn.end(); send('226 Transfer complete'); } }, 100);
              });
              break;
            }
            if (name === 'RESET.DG') {
              send('150 Opening data connection');
              withData(conn => { conn.write('half a file'); setTimeout(() => { (conn.resetAndDestroy ?? conn.destroy).call(conn); send('426 Connection closed; transfer aborted'); }, 50); });
              break;
            }
            const b = body(name);
            if (!b) { send('550 File not found'); break; }
            send('150 Opening data connection');
            withData(conn => { conn.end(b); send('226 Transfer complete'); });
            break;
          }
          case 'STOR': {
            const name = arg.replace(/^.*[\\/:]/, '').toUpperCase();
            // What a controller does with a program that is selected on the pendant: refuses.
            if (name === `${state.runningProgram.toUpperCase()}.LS`) { send('550 Program is running or selected'); break; }
            send('150 Opening data connection');
            withData(conn => {
              const chunks = [];
              conn.on('data', c => chunks.push(c));
              conn.on('end', () => {
                uploads.set(name, Buffer.concat(chunks));
                // SLOWSTORE.LS mimics the controller compiling a program as it lands: the
                // data is all in, but the 226 takes 1.2 s and the control channel is silent
                // - longer than a flat command timeout, well inside a size-scaled one.
                if (name === 'SLOWSTORE.LS') setTimeout(() => send('226 Transfer complete'), 1200);
                else send('226 Transfer complete');
              });
            });
            break;
          }
          case 'QUIT': send('221 Bye'); sock.end(); break;
          default: send('502 Command not implemented');
        }
      }
    });
    sock.on('error', () => {});
  });
  ftpServer.listen(ftpPort, '127.0.0.1');

  return {
    uploads,
    httpPort, ftpPort, state,
    close: () => new Promise(r => { httpServer.close(() => ftpServer.close(() => r())); }),
  };
}

if (process.argv[1] && /mockRobot\.mjs$/.test(process.argv[1])) {
  const [dir, hp, fp] = process.argv.slice(2);
  if (!dir) { console.error('usage: node test/mockRobot.mjs <backupDir> [httpPort] [ftpPort]'); process.exit(2); }
  const m = startMockRobot(path.resolve(dir), Number(hp) || 18080, Number(fp) || 18021);
  console.log(`mock robot serving ${dir}\n  http://127.0.0.1:${m.httpPort}/MD/  ftp://127.0.0.1:${m.ftpPort}/  (Ctrl+C to stop)`);
}
