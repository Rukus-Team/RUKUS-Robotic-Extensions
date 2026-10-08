/**
 * Robot Web Services 2.0 (OmniCore): the HAL+JSON reader on answers captured from a RobotWare 8.2.1
 * virtual controller, and the client's OmniCore dialect against an in-process stand-in that checks
 * what it is sent - resources, Basic login, Accept/Content-Type, one session, the raw backup form -
 * through to a whole Back Up and Download. Wired in by test/run.ts: `await run(check)`.
 */
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseRwsJson } from '@abb/rws/hal';
import { itemOf, itemsOf } from '@abb/rws/xhtml';
import { RwsClient, RwsError, retcodeOf } from '@abb/rws/client';
import { takeBackup } from '@abb/live/backup';

type Check = (cond: unknown, msg: string) => void;

const SYSTEM = '{ "_links" : { "base": { "href": "https://127.0.0.1:5466/rw/system/" }, "self" : { "href" : "" } }  , "state" : [ { "_type":"sys-system", "_title":"system", "major":"8", "minor":"2", "name":"omni_7_13", "rwversion":"8.2.1+1023", "sysid":"{393C885B-D726-4C43-98B5-B79FE4CE7038}", "starttm":"2026-09-26 T 09:55:57", "rwversionname":"8.2.1" } ], "_embedded" : { "resources" : [ { "_links" : { "self" : { "href" : "options" } }, "_type" : "sys-options-li", "_title" : "options", "options" : [ { "_type" : "sys-options", "_title" : "0", "option" : "RobotControl Base" } , { "_type" : "sys-options", "_title" : "1", "option" : "English" } ] } ] }}';
const TASKS = '{ "_links" : { "base" : { "href" : "https://127.0.0.1:5466/rw/rapid/" }, "self" : { "href" : "tasks" } }  , "_embedded" : { "resources" : [ { "_links" : { "self" : { "href" : "tasks/spy" } }, "_type" : "rap-tasks-spy-li", "_title" : "spy" }, { "_links" : { "self" : { "href" : "tasks/T_ROB1" } }, "_type" : "rap-task-li", "_title" : "T_ROB1" , "name":"T_ROB1" , "type":"normal" , "taskstate":"linked" , "excstate": "ready" , "active":"On" , "motiontask":"TRUE"} ] }}';
const PCP_NONE = '{ "_links" : { "base" : { "href" : "https://127.0.0.1:5466/rw/rapid/" }, "self" : { "href" : "tasks/T_ROB1/pcp" } } ,"status" : {"code":294912} , "state" : [ { "_type" : "pcp-info", "_title" : "progpointer" , "progpointer" : {"_links" : {"error" : { "href" : "https://127.0.0.1:5466/rw/retcode?code=-1073414145" } } } }, { "_type" : "pcp-info", "_title" : "motionpointer" , "motionpointer" : {"_links" : {"error" : { "href" : "https://127.0.0.1:5466/rw/retcode?code=-1073414145" } } } } ]}';
const PCP_AT = '{ "state" : [ { "_type" : "pcp-info", "_title" : "progpointer" , "progpointer" : { "modulename" : "Main", "routinename" : "main", "beginposition" : "12,5", "endposition" : "12,20" } } ]}';
const MODTEXT = '{ "state" : [ { "_type" : "rap-module-text", "_title" : "moduletext", "change-count" : " 46467 " , "module-text" : "\\nMODULE Main\\n  PROC main()\\n  ENDPROC\\nENDMODULE\\n" } ]}';
const JOINTS = '{ "state" : [ { "_type" : "ms-jointtarget", "_title" : "ROB_1", "rax_1" : "10", "rax_2" : "-20", "rax_3" : "30", "rax_4" : "0", "rax_5" : "45", "rax_6" : "0", "eax_a" : "0", "eax_b" : "0", "eax_c" : "0", "eax_d" : "0", "eax_e" : "0", "eax_f" : "0" } ]}';
const FK = '{ "state" : [ { "_type" : "position-from-joint", "_title" : "positionData", "position-x" : "2.672", "position-y" : "0", "position-z" : "2.02", "robtargetorientation-u0" : "0.7071068", "robtargetorientation-u1" : "0", "robtargetorientation-u2" : "0.7071068", "robtargetorientation-u3" : "0", "quarter-rev-j1" : "0", "quarter-rev-j4" : "0", "quarter-rev-j6" : "0", "quarter-rev-jx" : "0" } ]}';
const dir = (entries: { name: string; dir?: boolean; size?: number }[]) => JSON.stringify({ _links: { base: { href: 'https://x/fileservice/' }, self: { href: '' } }, _embedded: { resources: entries.map(e => ({ _links: { self: { href: e.name } }, _type: e.dir ? 'fs-dir' : 'fs-file', _title: e.name, ...(e.dir ? {} : { 'fs-size': String(e.size ?? 0) }) })) } });

export async function run(check: Check): Promise<void> {
  // ---- the HAL+JSON reader ----
  const sys = parseRwsJson(SYSTEM);
  check(sys.base === 'https://127.0.0.1:5466/rw/system/' && sys.links.self === '' && !('base' in sys.links), `base and links: ${JSON.stringify({ b: sys.base, l: sys.links })}`);
  check(itemOf(sys, 'sys-system')?.fields.rwversionname === '8.2.1' && itemsOf(sys, 'sys-options').map(i => i.fields.option).join('|') === 'RobotControl Base|English', 'state items, and a nested list of options as items of their own');
  const tasks = itemsOf(parseRwsJson(TASKS), 'rap-task-li');
  check(tasks.length === 1 && tasks[0].title === 'T_ROB1' && tasks[0].fields.motiontask === 'TRUE' && tasks[0].links.self === 'tasks/T_ROB1', `embedded resources: ${JSON.stringify(tasks)}`);
  const none = parseRwsJson(PCP_NONE).items;
  check(none.length === 2 && !none[0].fields.modulename && /retcode/.test(none[0].links.error ?? ''), 'a pointer that is not set: no fields, its error link kept');
  const at = itemOf(parseRwsJson(PCP_AT), 'pcp-info');
  check(at?.fields.modulename === 'Main' && at.fields.beginposition === '12,5', `a nested object gives its fields to its item: ${JSON.stringify(at)}`);
  check(itemOf(parseRwsJson(MODTEXT), 'rap-module-text')?.fields['module-text'].startsWith('\nMODULE Main'), 'field values kept exactly (module text untrimmed)');
  check(parseRwsJson('not json').items.length === 0 && parseRwsJson('[1,2]').items.length === 0, 'a body that is not a HAL object gives an empty page');
  check(retcodeOf(Buffer.from('{"status":{"code":-1073445879,"msg":"Data parameter is required"}}')) === ': Data parameter is required (RWS return code -1073445879)', `retcodeOf reads an RWS 2.0 error: ${retcodeOf(Buffer.from('{"status":{"code":-1073445879,"msg":"Data parameter is required"}}'))}`);

  // ---- the client against an OmniCore stand-in ----
  const seen: { method: string; url: string; accept?: string; auth?: string; cookie?: string; type?: string; body: string }[] = [];
  const files = new Map<string, Buffer>();
  let backupState = 'Init State';
  let registered = false;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      seen.push({ method: req.method!, url: req.url!, accept: req.headers.accept, auth: req.headers.authorization, cookie: req.headers.cookie, type: req.headers['content-type'], body });
      const json = (s: string, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/hal+json;v=2.0', 'Set-Cookie': ['-http-session-=abc; path=/', 'ABBCX=7; path=/'] }); res.end(s); };
      if (req.headers.authorization !== `Basic ${Buffer.from('Default User:robotics').toString('base64')}`) return json('{}', 401);
      const u = decodeURIComponent(req.url!);
      if (req.method === 'GET' && u === '/rw/system') return json(SYSTEM);
      if (req.method === 'GET' && u === '/rw/panel/ctrl-state') return json('{ "state" : [ { "_type" : "pnl-ctrlstate", "_title" : "ctrl-state", "ctrlstate" : "guardstop" } ]}');
      if (req.method === 'GET' && u === '/rw/panel/opmode') return json('{ "state" : [ { "_type" : "pnl-opmode", "_title" : "opmode", "opmode" : "MANR" } ]}');
      if (req.method === 'GET' && u === '/rw/panel/speedratio') return json('{ "state" : [ { "_type" : "pnl-speedratio", "_title" : "speedratio", "speedratio" : "100" } ]}');
      if (req.method === 'GET' && u === '/rw/rapid/tasks') return json(TASKS);
      if (req.method === 'GET' && u === '/rw/rapid/tasks/T_ROB1/modules') return json('{ "state" : [ { "_type" : "rap-module-info-li", "_title" : "T_ROB1/Main", "name" : "Main", "type" : "ProgMod" } ]}');
      if (req.method === 'GET' && u === '/rw/rapid/tasks/T_ROB1/modules/Main/text') return json(MODTEXT);
      if (req.method === 'GET' && u === '/rw/rapid/tasks/T_ROB1/pcp') return json(PCP_AT);
      if (req.method === 'GET' && u === '/rw/motionsystem/mechunits/ROB_1/jointtarget') return json(JOINTS);
      if (req.method === 'POST' && u === '/rw/motionsystem/mechunits/ROB_1/pose-from-joints') return json(FK);
      if (req.method === 'GET' && u === '/ctrl/backup/state') return json(`{ "state" : [ { "_type" : "ctrl-backup-state", "_title" : "backup-state", "backup-state" : "${backupState}" } ]}`);
      if (req.method === 'POST' && u === '/ctrl/backup/create') {
        files.set('$BACKUP/b1/system.xml', Buffer.from('<system/>'));
        files.set('$BACKUP/b1/SYSPAR/SYS.cfg', Buffer.from('SYS:CFG_1.0:6:0::'));
        backupState = 'Backup Ready';
        res.writeHead(202); return res.end();
      }
      if (u.startsWith('/fileservice/')) {
        const p = u.slice('/fileservice/'.length).replace(/\/$/, '');
        if (req.method === 'DELETE') { for (const k of [...files.keys()]) if (k === p || k.startsWith(`${p}/`)) files.delete(k); res.writeHead(204); return res.end(); }
        if (files.has(p)) { res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); return res.end(files.get(p)); }
        const under = [...files.keys()].filter(k => k.startsWith(`${p}/`)).map(k => k.slice(p.length + 1));
        if (!under.length) return json('{}', 404);
        const names = new Map<string, { name: string; dir?: boolean; size?: number }>();
        for (const r of under) { const [first, ...rest] = r.split('/'); names.set(first, rest.length ? { name: first, dir: true } : { name: first, size: files.get(`${p}/${r}`)!.length }); }
        return json(dir([...names.values()]));
      }
      if (req.method === 'GET' && u === '/rw/iosystem/signals?limit=100') return json('{ "_links" : { "next" : { "href" : "signals?start=1&amp;limit=100" } }, "_embedded" : { "resources" : [ { "_links" : { "self" : { "href" : "signals/Local/DRV_1/DO1" } }, "_type" : "ios-signal-li", "_title" : "Local/DRV_1/DO1", "name" : "DO1", "type" : "DO", "category" : "", "lvalue" : "1", "lstate" : "not simulated" } ] }}');
      if (req.method === 'GET' && u === '/rw/iosystem/signals?start=1&limit=100') return json('{ "_embedded" : { "resources" : [ { "_links" : { "self" : { "href" : "signals/EtherNetIP/Dev1/diPart" } }, "_type" : "ios-signal-li", "_title" : "EtherNetIP/Dev1/diPart", "name" : "diPart", "type" : "DI", "lvalue" : "0" } ] }}');
      if (req.method === 'GET' && u === '/rw/elog?lang=en') return json('{ "_embedded" : { "resources" : [ { "_type" : "elog-domain-li", "_title" : "0", "domain-name" : "Common", "numevts" : "2", "buffsize" : "1000" }, { "_type" : "elog-domain-li", "_title" : "1", "domain-name" : "Operational", "numevts" : "160", "buffsize" : "1000" } ] }}');
      // category 1: 160 messages, oldest first, 50 a page; `start` is the page number, as on RW 8.2
      const page = /^\/rw\/elog\/1\?(?:order=fifo&)?lang=en&(?:limit=50&start=(\d+)|start=(\d+)&limit=50)$/.exec(u);
      if (req.method === 'GET' && page) {
        const p = Number(page[1] ?? page[2]);
        if (p < 1 || (p - 1) * 50 >= 160) return json('{ "status" : { "code" : -1073445883, "msg" : "wrong uri due to invalid page num" } }', 400);
        const items = Array.from({ length: Math.min(50, 160 - (p - 1) * 50) }, (_, k) => (p - 1) * 50 + k + 1)
          .map(n => `{ "_type" : "elog-message-li", "_title" : "/rw/elog/1/${n}", "msgtype" : "1", "code" : "${n}", "tstamp" : "t${n}", "title" : "m${n}" }`);
        const next = p * 50 < 160 ? `, "next" : { "href" : "1?order=fifo&amp;lang=en&amp;start=${p + 1}&amp;limit=50" }` : '';
        return json(`{ "_links" : { "self" : { "href" : "" }${next} }, "_embedded" : { "resources" : [ ${items.join(', ')} ] }}`);
      }
      if (req.method === 'GET' && u === '/rw/elog/0?lang=en&limit=50&start=1') return json('{ "_embedded" : { "resources" : [ { "_type" : "elog-message-li", "_title" : "/rw/elog/0/1", "msgtype" : "1", "code" : "10002", "tstamp" : "2026-09-25 T 22:15:06", "title" : "Program pointer has been reset", "desc" : "The program pointer of task T_ROB1 has been reset." }, { "_type" : "elog-message-li", "_title" : "/rw/elog/0/2", "msgtype" : "3", "code" : "20010", "tstamp" : "2026-09-26 T 08:00:00", "title" : "Emergency stop state", "actions" : "Reset the emergency stop." } ] }}');
      if (req.method === 'GET' && u === '/rw/controlstation/writeaccess/status') return json('{ "state": [ { "_type": "controlstation-write-access-status", "_title": "write-access-status", "held-by-control-station-Id": "a1b2", "held-by-control-station-name": "FlexPendant", "control-station-write-access-held": "false", "control-station-external-control-enabled": "false" } ]}');
      // a remote control station: registered with an allowed id and PIN, then it may ask for write access
      if (req.method === 'POST' && u === '/rw/controlstation/register/remote') { if (/control-station-id=PC1&pincode=1234&/.test(body)) { registered = true; res.writeHead(204); return res.end(); } return json('{ "status" : { "code" : -1073435870, "msg" : "Control station id not allowed" } }', 403); }
      if (req.method === 'POST' && (u === '/rw/controlstation/writeaccess/request' || u === '/rw/controlstation/writeaccess/release')) { if (registered) { res.writeHead(204); return res.end(); } return json('{ "status" : { "code" : -1073435871, "msg" : "Session is not part of a Control Station." } }', 403); }
      if (req.method === 'GET' && u === '/rw/rapid/symbol/RAPID/T_ROB1/Main/nCount/data') return json('{ "state" : [ { "_type" : "rap-data", "_title" : "RAPID/T_ROB1/Main/nCount", "value" : "7" } ]}');
      if (u === '/logout') { res.writeHead(204); return res.end(); }
      json('{ "status" : { "code" : -1073414145, "msg" : "no such resource" } }', 404);
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rws2-'));
  try {
    const c = new RwsClient({ host: '127.0.0.1', port, family: 'omnicore', https: false, user: 'Default User', password: 'robotics' });
    const s = await c.system();
    check(s.name === 'omni_7_13' && s.robotWareName === '8.2.1' && s.options.length === 2, `system over RWS 2.0: ${JSON.stringify(s)}`);
    const p = await c.panel();
    check(p.ctrlState === 'guardstop' && p.opMode === 'MANR' && p.speedRatio === 100, `panel from /rw/panel/ctrl-state: ${JSON.stringify(p)}`);
    const t = await c.tasks();
    check(t.length === 1 && t[0].motion && t[0].execState === 'ready', 'tasks');
    const mods = await c.modules('T_ROB1');
    check(mods.length === 1 && mods[0].name === 'Main' && mods[0].type === 'ProgMod', 'modules from /rw/rapid/tasks/{task}/modules');
    const txt = await c.moduleText('T_ROB1', 'Main');
    check(txt.text === '\nMODULE Main\n  PROC main()\n  ENDPROC\nENDMODULE\n' && txt.changeCount === 46467, `module text exact, change count: ${JSON.stringify(txt)}`);
    const ptr = await c.pointers('T_ROB1');
    check(ptr.program?.module === 'Main' && ptr.program.routine === 'main' && ptr.program.begin?.line === 12 && ptr.program.begin.col === 5, `program pointer: ${JSON.stringify(ptr)}`);
    const jt = await c.jointTarget();
    check(jt.robax.join(',') === '10,-20,30,0,45,0', 'joint target');
    const fk = await c.poseFromJoints(jt.robax);
    check(fk.trans[0] === 2672 && fk.trans[2] === 2020 && fk.rot[0] === 0.7071068, `kinematics at /pose-from-joints: ${JSON.stringify(fk)}`);
    const wa = await c.writeAccess();
    check(!wa.free && wa.holder === 'FlexPendant' && wa.holderId === 'a1b2' && wa.summary === 'held by FlexPendant · remote access off' && wa.externalControl === false, `write access holder (RW 8 control station): ${JSON.stringify(wa)}`);
    let notStation = '';
    try { await c.requestWriteAccess(); } catch (e) { notStation = e instanceof RwsError ? `${e.status} ${e.message}` : String(e); }
    check(/^403 .*not part of a Control Station/.test(notStation), `write access before registering: the controller's reason comes through: ${notStation}`);
    let notAllowed = '';
    try { await c.requestWriteAccess({ name: 'Robot Code PC', id: 'PC9', pin: '0000' }); } catch (e) { notAllowed = String((e as Error).message); }
    check(/id not allowed/.test(notAllowed) && seen[seen.length - 1].url === '/rw/controlstation/register/remote', `an id the controller does not allow stops before the request: ${notAllowed}`);
    await c.requestWriteAccess({ name: 'Robot Code PC', id: 'PC1', pin: '1234' });
    const reg = seen.filter(x => x.url === '/rw/controlstation/register/remote').pop()!;
    check(reg.body === 'control-station-name=Robot%20Code%20PC&control-station-id=PC1&pincode=1234&release-write-access-when-lost=true' && reg.type === 'application/x-www-form-urlencoded;v=2.0', `register/remote form: ${reg.body} | ${reg.type}`);
    check(seen[seen.length - 1].url === '/rw/controlstation/writeaccess/request' && seen[seen.length - 1].method === 'POST', 'then write access is requested');
    await c.releaseWriteAccess();
    check(seen[seen.length - 1].url === '/rw/controlstation/writeaccess/release', 'release posts to writeaccess/release');
    check(await c.symbol('T_ROB1', 'nCount', 'Main') === '7', 'a RAPID value is read at the RWS 2.0 path /rw/rapid/symbol/RAPID/{task}/{module}/{name}/data');
    const sigs = await c.signals();
    check(sigs.length === 2 && sigs[0].path === 'Local/DRV_1/DO1' && sigs[0].value === '1' && sigs[1].name === 'diPart' && sigs[1].type === 'DI', `signals over two pages (the next link's &amp; decoded), each with its path: ${JSON.stringify(sigs)}`);
    const ev = await c.eventLog(0, 50);
    check(ev.length === 2 && ev[0].code === 20010 && ev[0].type === 3 && ev[0].actions === 'Reset the emergency stop.' && ev[1].title.startsWith('Program pointer'), `event log newest first (RW 8 sends oldest first, no order=lifo): ${JSON.stringify(ev.map(e => e.code))}`);
    check(!seen.some(x => /order=lifo/.test(x.url)), 'RW 8 is never asked for order=lifo (it refuses it)');
    const long = await c.eventLog(1, 100);
    check(long.length === 100 && long[0].code === 160 && long[99].code === 61, `a long RW 8 log: start is a page number, the newest 100 kept (${long.length}: ${long[0]?.code}..${long[long.length - 1]?.code})`);
    const r = await takeBackup(c, 'b1', tmp, { remove: true, pollMs: 1 });
    check(r.files === 2 && fs.readFileSync(path.join(tmp, 'b1', 'SYSPAR', 'SYS.cfg'), 'utf8').startsWith('SYS:CFG') && r.removed && files.size === 0, `backup and download over RWS 2.0: ${JSON.stringify(r)}`);
    await c.logout();

    const create = seen.find(x => x.url === '/ctrl/backup/create')!;
    check(create.body === 'backup=/fileservice/$BACKUP/b1' && create.type === 'application/x-www-form-urlencoded;v=2.0', `backup form sent raw, versioned content type: ${create.body} | ${create.type}`);
    check(seen.every(x => x.accept === 'application/hal+json;v=2.0'), 'every request asks for application/hal+json;v=2.0');
    check(seen.slice(1).every(x => /-http-session-=abc/.test(x.cookie ?? '')), 'one session: the cookie is carried after the first answer');
    check(seen[seen.length - 1].url === '/logout', 'logout gives the session back');

    let refused = '';
    try { await new RwsClient({ host: '127.0.0.1', port, family: 'omnicore', user: 'Default User', password: 'wrong' }).system(); } catch (e) { refused = e instanceof RwsError ? `${e.status} ${e.message}` : String(e); }
    check(/^401 .*refused the login/.test(refused), `a wrong password is a clear 401: ${refused}`);
    let missing = '';
    try { await c.page('/rw/nothing'); } catch (e) { missing = String((e as Error).message); }
    check(/404.*no such resource.*-1073414145/.test(missing), `an RWS 2.0 error body is read into the message: ${missing}`);
  } finally {
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
