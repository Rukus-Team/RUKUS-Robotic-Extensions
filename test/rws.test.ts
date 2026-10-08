/**
 * The ABB Robot Web Services client: the XHTML reader, Digest auth, and every typed read
 * against a mock that replays a real IRC5's RWS crawl (abb-reference, RobotWare 6.16). Wired
 * in by test/run.ts: `await run(check)`. The crawl half skips without the crawl folder.
 */
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { takeBackup, validBackupName, defaultBackupName } from '@abb/live/backup';
import { parseRwsPage, itemOf, rwsPosition } from '@abb/rws/xhtml';
import { RwsClient, RwsError, parseDigestChallenge, digestAuthorization, retcodeOf } from '@abb/rws/client';
import { targetLiteralAt, formatRobtarget, formatJointtarget, declaredName } from '@abb/live/targets';
// @ts-ignore - plain ESM test helper, bundled by esbuild
import { startMockRws, findRwsCrawl } from './mockRws.mjs';

type Check = (cond: unknown, msg: string) => void;
const near = (a: number, b: number, tol = 1e-3) => Math.abs(a - b) <= tol;

export async function run(check: Check): Promise<void> {
  // ---- the XHTML reader ----
  const page = parseRwsPage(`<?xml version="1.0"?><html><head><title>rapid</title><base href="http://1.2.3.4:80/rw/rapid/"/></head><body><div class="state"><a href="tasks" rel="self"></a><a href= "" rel="next"/><ul>
    <li class="rap-task-li" title="T_ROB1"> <a href="tasks/T_ROB1" rel="self"></a> <span class="name">T_ROB1</span> <span class="motiontask">TRUE</span></li>
    <li class="rap-module" title="T_ROB1/m"><span class="modname">a &amp; b</span><span class="attribute"></span><a href="http://x/rw/retcode?code=-1" rel="error" class="modfilename_ret"/></li>
  </ul></div></body></html>`);
  check(page.title === 'rapid' && page.base === 'http://1.2.3.4:80/rw/rapid/' && page.links.self === 'tasks' && page.links.next === '', `page title/base/links: ${JSON.stringify({ t: page.title, b: page.base, l: page.links })}`);
  const t = itemOf(page, 'rap-task-li');
  check(t?.title === 'T_ROB1' && t.fields.name === 'T_ROB1' && t.fields.motiontask === 'TRUE' && t.links.self === 'tasks/T_ROB1', `an item's spans and links: ${JSON.stringify(t)}`);
  const m = itemOf(page, 'rap-module');
  check(m?.fields.modname === 'a & b' && m.fields.attribute === '' && /retcode/.test(m.links['error:modfilename_ret'] ?? ''), `entities decoded, empty spans kept, a classed error link kept: ${JSON.stringify(m)}`);
  check(rwsPosition('77,6')?.line === 77 && rwsPosition('77,6')?.col === 6 && rwsPosition('') === undefined, 'rwsPosition reads "line,col"');

  // ---- Digest (RFC 2617 section 3.5's worked example) ----
  const ch = parseDigestChallenge('Digest realm="testrealm@host.com", qop="auth,auth-int", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41"');
  check(ch?.realm === 'testrealm@host.com' && ch.nonce === 'dcd98b7102dd2f0e8b11d0f600bfb0c093' && ch.qop === 'auth,auth-int', `parseDigestChallenge: ${JSON.stringify(ch)}`);
  const auth = ch && digestAuthorization(ch, 'Mufasa', 'Circle Of Life', 'GET', '/dir/index.html', 1, '0a4f113b');
  check(/response="6629fae49393a05397450978507c4ef1"/.test(auth ?? '') && /nc=00000001/.test(auth ?? '') && /qop=auth(,|$)/.test(auth ?? ''), `digestAuthorization matches RFC 2617's example: ${auth}`);
  check(parseDigestChallenge('Basic realm="x"') === undefined, 'a Basic challenge is not a Digest one');

  // ---- an RW 6.16 error body (RobotStudio VC, 2026-09-25) ----
  const vcError = Buffer.from('<div class="status"><span class="code">-1073436654</span><span class="msg">C:\\BUILDAGENTS\\SEABB-IS-13906.1\\_work\\76\\s\\RW\\Areas\\RobApi2\\Components\\rws_motionsystem\\rws_resource_motionsystem.cpp[2062] Position outside of reach code:-1073436654 icode:-1</span></div>');
  check(retcodeOf(vcError) === ': Position outside of reach (RWS return code -1073436654)', `retcodeOf keeps the reason, drops the source path: "${retcodeOf(vcError)}"`);

  // ---- jointtarget / robtarget values in RAPID text ----
  const src = 'MODULE M\n  CONST jointtarget jHome := [[0,-34.5867,27.7,+.5,91.8719,-0],[9E+09,9E9,9E+09,9E+09,9E+09,9E+09]]; ! [not, this]\n  CONST robtarget pPick:=[[949.17,-0.02,1274.27],[0.043,0,0.99905,0],[-1,-1,0,0],[9E+09,9E+09,9E+09,9E+09,9E+09,9E+09]];\n  TPWrite "[[1,2]]";\nENDMODULE';
  const jt = targetLiteralAt(src, src.indexOf('-34.5'));
  check(jt?.kind === 'joints' && jt.robax[3] === 0.5 && Object.is(jt.robax[5], -0) && jt.extax[1] === 9e9 && src.slice(jt.start, jt.end).startsWith('[[0,') && src.slice(jt.start, jt.end).endsWith('9E+09]]'), `a jointtarget from the cursor inside it (+.5, -0, 9E9): ${JSON.stringify(jt)}`);
  const rt = targetLiteralAt(src, src.indexOf('[-1,-1'));
  check(rt?.kind === 'pose' && rt.trans[0] === 949.17 && rt.rot[2] === 0.99905 && rt.robconf.join() === '-1,-1,0,0', `a robtarget: ${JSON.stringify(rt)}`);
  check(targetLiteralAt(src, src.indexOf('not, this')) === undefined && targetLiteralAt(src, src.indexOf('[[1,2]]') + 2) === undefined && targetLiteralAt(src, src.indexOf('MODULE')) === undefined, 'no target in a comment, a string, or outside brackets');
  check(targetLiteralAt('x := [[1,2,3],[4,5,6]];', 8) === undefined, 'a [[3],[3]] value is neither');
  check(formatRobtarget({ trans: [2893.389, 591.7706000000001, 1432.974], rot: [0.1740335, 0.4320478, 0.8086733, 0.3592973], robconf: [0, -2, -2, 1] }, [9e9, 9e9, 9e9, 9e9, 9e9, 9e9]) === '[[2893.39,591.77,1432.97],[0.174034,0.432048,0.808673,0.359297],[0,-2,-2,1],[9E+09,9E+09,9E+09,9E+09,9E+09,9E+09]]', 'formatRobtarget writes it as RobotStudio does');
  check(formatJointtarget([10.000004285756797, 19.999968464467937, -9.99996990828909, -0.00001, 40, 50], [100, 9e9, 9e9, 9e9, 9e9, 9e9]) === '[[10,20,-10,0,40,50],[100,9E+09,9E+09,9E+09,9E+09,9E+09]]', 'formatJointtarget trims the controller\'s float noise');
  check(declaredName('  LOCAL CONST jointtarget jHome := [[') === 'jHome' && declaredName('  PERS robtarget pPick:=[') === 'pPick' && declaredName('  MoveJ pPick, v100') === undefined, 'declaredName');

  // ---- against the crawl ----
  const crawl = findRwsCrawl(path.resolve(__dirname, '..'));
  if (!crawl) { console.log('  (abb-reference RWS crawl not found; RWS client checks against it skipped - set RWS_CRAWL)'); return; }
  const mock = await startMockRws(crawl, 0, { user: 'Default User', password: 'robotics' });
  try {
    const c = new RwsClient({ host: '127.0.0.1', port: mock.port, user: 'Default User', password: 'robotics' });
    const sys = await c.system();
    check(sys.name === '6700-805115' && sys.robotWare === '6.16.1028' && sys.robotWareName === '6.16.01.00' && sys.options.some(o => /World Zones/.test(o)), `system: ${JSON.stringify({ ...sys, options: sys.options.length })}`);
    const panel = await c.panel();
    check(panel.ctrlState === 'motoroff' && panel.opMode === 'AUTO' && panel.speedRatio === 100, `panel: ${JSON.stringify(panel)}`);
    const ex = await c.execution();
    check(ex.state === 'stopped' && ex.cycle === 'forever', `execution: ${JSON.stringify(ex)}`);
    const tasks = await c.tasks();
    check(tasks.length === 2 && tasks[0].name === 'T_ROB1' && tasks[0].motion && tasks[0].active === true && !tasks[1].motion, `tasks: ${JSON.stringify(tasks)}`);
    const ptr = await c.pointers('T_ROB1');
    check(ptr.program?.module === 'STYLE_35L' && ptr.program.routine === 'MOV_R01_Pick_35L' && ptr.program.begin?.line === 77 && ptr.program.begin.col === 6, `program pointer (RW spells it "modulemame"): ${JSON.stringify(ptr.program)}`);
    check(ptr.motion?.module === 'MAIN_MODULE' && ptr.motion.routine === 'HomeRobot' && ptr.motion.begin?.line === 259, `motion pointer (RW spells it "begposition"): ${JSON.stringify(ptr.motion)}`);
    const mods = await c.modules('T_ROB1');
    check(mods.some(x => x.name === 'MAIN_MODULE' && x.type === 'ProgMod') && mods.some(x => x.name === 'user' && x.type === 'SysMod'), `modules: ${mods.map(x => `${x.name}:${x.type}`).join(', ')}`);
    const jt = await c.jointTarget();
    check(jt.robax.length === 6 && near(jt.robax[1], -34.5867) && near(jt.robax[4], 91.8719) && jt.extax.every(v => v === 0), `jointtarget: ${JSON.stringify(jt)}`);
    const rt = await c.robTarget();
    check(near(rt.trans[0], 949.17, 0.01) && near(rt.trans[2], 1274.27, 0.01) && near(rt.rot[2], 0.99905, 1e-4) && rt.robconf.join(',') === '-1,-1,0,0' && rt.extax.every(v => v > 8.9e9), `robtarget: ${JSON.stringify(rt)}`);
    const reg1 = await c.symbol('T_ROB1', 'reg1', 'user');
    check(reg1 === '0', `symbol RAPID/T_ROB1/user/reg1 = ${reg1}`);
    const mt = await c.moduleText('T_ROB1', 'MAIN_MODULE');
    check(mt.text.startsWith('\nMODULE MAIN_MODULE\n') && mt.text.includes('a <> b & "c"') && mt.changeCount === 4711 && !mt.viaFile, `module text: kept to the character, entities decoded, change count (${JSON.stringify(mt).slice(0, 90)})`);
    const big = await c.moduleText('T_ROB1', 'BIG');
    check(big.viaFile === '$TEMP/BIG.mod' && big.text.includes('via file é') && mock.stats.deletes === 1, `a module sent as a TEMP file is read as Latin-1 and its copy deleted (${mock.stats.deletes} delete)`);
    let missing: unknown;
    try { await c.moduleText('T_ROB1', 'NOPE'); } catch (e) { missing = e; }
    check(missing instanceof RwsError && missing.status === 400 && /: Unresolved url \(RWS return code -1073445866\)$/.test(missing.message), `a missing module: the controller's reason without its source path: ${missing}`);
    const pose = await c.poseFromJoints([10, 20, 30, 0, 0, 0], { tool: { trans: [0, 0, 500], rot: [1, 0, 0, 0] } });
    const r2d = (r: number) => r * 180 / Math.PI;
    check(near(pose.trans[0], Math.PI / 18 * 1000, 1e-3) && near(pose.trans[2], Math.PI / 6 * 1000, 1e-3) && pose.rot[0] === 1 && pose.robconf.join() === '0,0,0,0', `FK sends radians, reads metres as mm: ${JSON.stringify(pose)}`);
    const ik = await c.jointsFromPose({ trans: [100, 200, 300], rot: [1, 0, 0, 0], robconf: [0, 0, 0, 0] });
    check(near(ik[0], r2d(0.1), 1e-6) && near(ik[2], r2d(0.3), 1e-6) && ik.length === 6, `IK sends metres, reads radians as degrees: ${ik.map(v => v.toFixed(3)).join(',')}`);
    const sols = await c.allJointSolutions({ trans: [100, 200, 300], rot: [1, 0, 0, 0], robconf: [0, 0, 0, 0] });
    check(sols.length === 2 && near(sols[1].joints[1], r2d(0.2), 1e-6) && sols[0].robconf.join() === '0,0,0,0', `all joint solutions, robconf from RW's quarter_rev_j11: ${JSON.stringify(sols[0])}`);
    check(mock.stats.calcs === 3, `three calculations (${mock.stats.calcs})`);
    // ---- backup: the controller writes it to $BACKUP, it comes down to a local folder ----
    const localRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-abb-backup-'));
    try {
      const del0 = mock.stats.deletes;
      const steps: string[] = [];
      const bk = await takeBackup(c, 'MOCK_Backup_1', localRoot, { pollMs: 1, progress: m => { if (!steps.includes(m) && !m.startsWith('Downloading')) steps.push(m); } });
      const got = (p: string) => fs.readFileSync(path.join(bk.local, ...p.split('/')), 'latin1');
      check(bk.files === 8 && got('RAPID/TASK1/PROGMOD/MAIN_MODULE.mod').startsWith('MODULE MAIN_MODULE\n') && got('SYSPAR/MOC.cfg').startsWith('MOC:CFG') && got('system.xml') === '<system/>', `backup: all 8 files, folders kept, bytes as sent (${bk.files} files, ${bk.bytes} bytes; the root listing is paged)`);
      check(mock.stats.backups === 1 && steps.includes('The controller is writing the backup…') && !bk.removed && [...mock.disk.keys()].some((k: string) => k.startsWith('$BACKUP/MOCK_Backup_1/')), `backup: one backup, waited for it, left on the controller like a FlexPendant backup (${steps.join(' / ')})`);
      let dup: unknown;
      try { await takeBackup(c, 'MOCK_Backup_1', fs.mkdtempSync(path.join(os.tmpdir(), 'rc-abb-backup-')), { pollMs: 1 }); } catch (e) { dup = e; }
      check(/already has \$BACKUP\/MOCK_Backup_1/.test(String(dup)) && mock.stats.backups === 1, `backup: a name the controller already has is refused before anything is written: ${dup}`);
      let local: unknown;
      try { await takeBackup(c, 'MOCK_Backup_1', localRoot, { pollMs: 1 }); } catch (e) { local = e; }
      check(/already exists/.test(String(local)) && mock.stats.backups === 1, `backup: an existing local folder is never overwritten: ${local}`);
      const bk2 = await takeBackup(c, 'MOCK_Backup_2', localRoot, { pollMs: 1, remove: true });
      check(bk2.removed && bk2.files === 8 && mock.stats.deletes - del0 === 1 && ![...mock.disk.keys()].some((k: string) => k.startsWith('$BACKUP/MOCK_Backup_2')), `backup, remove after download: one recursive DELETE (${mock.stats.deletes - del0})`);
      check(!validBackupName('../x') && !validBackupName('a b') && !validBackupName('x.') && validBackupName('IRC5_1_Backup_20260925_2231') && /^6700-805115_Backup_\d{8}_\d{4}$/.test(defaultBackupName('6700-805115')), 'backup names: FlexPendant-style default, nothing that escapes the folder');
      let badPath: unknown;
      try { await c.startBackup('$HOME/x'); } catch (e) { badPath = e; }
      check(badPath instanceof RwsError && /: Invalid File Service path \(RWS return code -1073414146\)$/.test(badPath.message), `a fileservice error reads cleanly: ${badPath}`);
    } finally { fs.rmSync(localRoot, { recursive: true, force: true }); }

    let nf: unknown;
    try { await c.page('/rw/does/not/exist'); } catch (e) { nf = e; }
    check(nf instanceof RwsError && nf.status === 404, `a missing resource is an RwsError 404: ${nf}`);

    check(mock.stats.logins === 1 && mock.stats.unauthorized === 1, `one login for all of that: the session cookie carried the rest (${mock.stats.logins} logins, ${mock.stats.unauthorized} challenges, ${mock.stats.requests} requests)`);
    check(mock.stats.actions === 0, `the client sent nothing but reads, calculations, backups and deletes of its own files (${mock.stats.actions} other)`);
    check(c.requests === mock.stats.requests, `the client counts its own requests (${c.requests} vs ${mock.stats.requests})`);
    await c.logout();
    check(mock.stats.logouts === 1 && mock.stats.sessionsOpen() === 0 && !c.hasSession, `logout gives the session back (${mock.stats.sessionsOpen()} open)`);

    const bad = new RwsClient({ host: '127.0.0.1', port: mock.port, user: 'Default User', password: 'wrong' });
    let err: unknown;
    try { await bad.system(); } catch (e) { err = e; }
    check(err instanceof RwsError && err.status === 401 && /refused the login/.test(err.message), `a wrong password is a clear 401: ${err}`);

    // concurrency: ten reads at once go one at a time on one session
    const before = mock.stats.logins;
    const c2 = new RwsClient({ host: '127.0.0.1', port: mock.port, user: 'Default User', password: 'robotics' });
    const all = await Promise.all(Array.from({ length: 10 }, () => c2.execution()));
    check(all.every(x => x.state === 'stopped') && mock.stats.logins - before === 1, `ten reads at once: one login (${mock.stats.logins - before})`);
    await c2.logout();
    console.log(`  rws: ${mock.stats.requests} requests against the ${path.basename(crawl)} crawl, ${mock.stats.logins} logins, ${mock.stats.calcs} calculations, ${mock.stats.deletes} deletes, ${mock.stats.backups} backups`);
  } finally { await mock.close(); }
}
