// Live sync test (opt-in): push / pull-after-push / conflict gate against a REAL controller at
// ROBOT_CODE_LIVE_HOST, run by test/runLiveSync.mjs. Writes only its own program RCPUSHT and
// deletes it (and its compiled .TP) at the end. The modal "Upload?" is answered by stubbing
// vscode.window - this file sits in the extension folder, so it shares the extension's API object.
// Robot-side reads and writes go through curl (FTP), so the controller is checked independently
// of the code under test.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const OUT = process.env.ROBOT_CODE_TEST_OUT;
const HOST = process.env.ROBOT_CODE_LIVE_HOST;
const results = [];
function check(name, cond, detail) { results.push({ name, ok: !!cond, detail: detail === undefined ? undefined : String(detail).slice(0, 1500) }); fs.writeFileSync(OUT, JSON.stringify(results, null, 2)); }
function note(name, detail) { results.push({ name: 'NOTE ' + name, ok: true, note: true, detail: String(detail).slice(0, 1500) }); fs.writeFileSync(OUT, JSON.stringify(results, null, 2)); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
// optional screenshots, same handshake as test/integration.js: write .ready, wait for an outside .done
const SHOT_DIR = process.env.ROBOT_CODE_SHOT_DIR;
let shotNo = 0;
async function shot(name) {
  if (!SHOT_DIR) return;
  await sleep(900);
  const base = path.join(SHOT_DIR, `${String(++shotNo).padStart(2, '0')}-${name}`);
  fs.writeFileSync(base + '.ready', '');
  const end = Date.now() + 25000;
  while (Date.now() < end && !fs.existsSync(base + '.done')) await sleep(200);
}

const PROG = 'RCPUSHT';
const ftp = `ftp://${HOST}/md:/`;
const curl = (args, input) => execFileSync('curl', ['-s', '-S', '-m', '30', ...args], { input, encoding: 'latin1' });
const robotList = () => curl(['--list-only', ftp]).split(/\r?\n/).map(s => s.trim().toLowerCase()).filter(Boolean);
const robotHas = () => robotList().includes(`${PROG.toLowerCase()}.ls`);
const robotText = () => curl([`${ftp}${PROG}.LS`]);
const robotPut = text => curl(['-T', '-', `${ftp}${PROG}.LS`], Buffer.from(text.replace(/\r?\n/g, '\r\n'), 'latin1'));
const robotDelete = () => { for (const f of [`${PROG}.LS`, `${PROG}.TP`]) { try { curl([ftp, '-Q', `DELE ${f.toLowerCase()}`, '-o', process.platform === 'win32' ? 'NUL' : '/dev/null']); } catch { /* not there */ } } };
const lf = s => s.replace(/\r\n?/g, '\n').replace(/\n+$/, '');
// R[n]=n in a program, with or without the register comment a controller fills in (R[3:Weld Retries]=3)
const hasReg = (text, n) => new RegExp(`R\\[${n}(:[^\\]]*)?\\]=${n}\\b`).test(text);
// the program lines without numbers or the controller's padding before the terminator
const body = s => lf(s).split('\n').filter(l => /^\s*\d+:/.test(l)).map(l => l.replace(/^\s*\d+:\s*/, '').replace(/\s*;\s*$/, '')).join(' | ');

function program(lines) {
  const mn = lines.map((l, i) => `${String(i + 1).padStart(4)}:  ${l} ;`);
  return ['/PROG  ' + PROG, '/ATTR', 'OWNER\t\t= MNEDITOR;', 'COMMENT\t\t= "live sync test";', 'PROG_SIZE\t= 0;',
    'CREATE\t\t= DATE 26-10-01  TIME 12:00:00;', 'MODIFIED\t= DATE 26-10-01  TIME 12:00:00;', 'FILE_NAME\t= ;', 'VERSION\t\t= 0;',
    `LINE_COUNT\t= ${lines.length};`, 'MEMORY_SIZE\t= 0;', 'PROTECT\t\t= READ_WRITE;',
    'TCD:  STACK_SIZE\t= 0,', '      TASK_PRIORITY\t= 50,', '      TIME_SLICE\t= 0,', '      BUSY_LAMP_OFF\t= 0,', '      ABORT_REQUEST\t= 0,', '      PAUSE_REQUEST\t= 0;',
    'DEFAULT_GROUP\t= 1,*,*,*,*;', 'CONTROL_CODE\t= 00000000 00000000;', '/MN', ...mn, '/POS', '/END', ''].join('\n');
}

exports.run = async function () {
  if (!HOST) { check('ROBOT_CODE_LIVE_HOST is set', false, 'no host'); return; }
  const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const working = vscode.Uri.file(path.join(root, 'live', 'LS', `${PROG}.LS`));
  const snapDir = path.join(root, 'live', '.robocode-robot', 'snapshot');
  const snapshotText = () => {
    const walk = d => fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]) : [];
    const f = walk(snapDir).find(p => path.basename(p).toUpperCase() === `${PROG}.LS`);
    return f ? fs.readFileSync(f, 'latin1') : undefined;
  };
  const cfg = () => vscode.workspace.getConfiguration('robotCode');

  // ---- answer the dialogs: confirm "Upload?", record everything else and dismiss it
  const seen = [];
  const answer = (kind, orig) => async (msg, ...rest) => {
    const opts = rest[0] && typeof rest[0] === 'object' && !Array.isArray(rest[0]) && !('title' in rest[0]) ? rest[0] : undefined;
    const items = rest.filter(r => typeof r === 'string' || (r && typeof r === 'object' && 'title' in r));
    seen.push({ kind, msg, modal: !!opts?.modal, detail: opts?.detail, items: items.map(i => typeof i === 'string' ? i : i.title) });
    if (/^Upload .* to .*\?$/.test(msg) && items.includes('Upload')) return 'Upload';
    return undefined;
  };
  vscode.window.showWarningMessage = answer('warning');
  vscode.window.showInformationMessage = answer('info');
  vscode.window.showErrorMessage = answer('error');
  vscode.window.showQuickPick = async (items, opts) => { const list = await items; seen.push({ kind: 'quickpick', msg: opts?.placeHolder ?? opts?.title ?? '', items: (list ?? []).map(i => typeof i === 'string' ? i : i.label) }); return undefined; };
  const since = () => { const n = seen.length; return () => seen.slice(n); };

  const ext = vscode.extensions.all.find(e => /robot-code$/.test(e.id));
  await ext.activate();
  await sleep(1500);

  const setWorking = async text => {
    const doc = await vscode.workspace.openTextDocument(working);
    const ed = await vscode.window.showTextDocument(doc);
    await ed.edit(b => b.replace(new vscode.Range(0, 0, doc.lineCount, 0), text));
    await doc.save();
    return doc;
  };
  const workingText = () => fs.readFileSync(working.fsPath, 'latin1');
  const push = async () => { const after = since(); await vscode.commands.executeCommand('robotCode.sync.pushFile', working); await sleep(500); return after(); };

  robotDelete();
  check('setup: the robot does not have the test program', !robotHas(), robotList().filter(f => f.startsWith('rc')).join(', '));
  fs.writeFileSync(working.fsPath, program(['R[1]=1']), 'latin1');
  await setWorking(program(['R[1]=1']));

  try {
    // ---- 1. a brand-new program: the robot has no copy yet
    await cfg().update('containers.pullAfterPush', 'always', vscode.ConfigurationTarget.Global);
    let msgs = await push();
    const firstLanded = robotHas();
    check('1. a brand-new program (not on the robot yet) can be pushed', firstLanded, JSON.stringify(msgs));
    if (!firstLanded) {
      // seed it the way a first upload from elsewhere would, so the rest can run
      robotPut(program(['R[1]=1']));
      note('1. seeded the robot over FTP so the remaining checks can run', robotHas());
    }

    // ---- 2. always: working copy = snapshot = robot after the push
    const sent2 = program(['R[1]=1', 'R[2]=2']);
    await setWorking(sent2);
    msgs = await push();
    let robot = robotText();
    check('2. always: the push lands on the robot', hasReg(robot, 2), body(robot));
    check('2. always: snapshot = robot read-back', snapshotText() !== undefined && lf(snapshotText()) === lf(robot), `snapshot ${snapshotText() === undefined ? 'missing' : body(snapshotText())}`);
    check('2. always: working copy = robot read-back', lf(workingText()) === lf(robot), `working:\n${lf(workingText())}\n---- robot:\n${lf(robot)}`);
    check('2. always: no modal besides the Upload confirm', msgs.filter(m => m.modal && !/^Upload /.test(m.msg)).length === 0, JSON.stringify(msgs));
    note('2. messages', JSON.stringify(msgs.map(m => m.msg)));

    // ---- 3. never: the working copy keeps exactly what was sent
    await cfg().update('containers.pullAfterPush', 'never', vscode.ConfigurationTarget.Global);
    const sent3 = program(['R[1]=1', 'R[2]=2', 'R[3]=3']);
    await setWorking(sent3);
    msgs = await push();
    robot = robotText();
    check('3. never: the push lands on the robot', hasReg(robot, 3), body(robot));
    check('3. never: working copy untouched (= what was sent)', lf(workingText()) === lf(sent3), lf(workingText()));
    check('3. never: snapshot still advances to the robot read-back', snapshotText() !== undefined && lf(snapshotText()) === lf(robot), body(snapshotText() ?? ''));

    // ---- 4. when-identical: overwrite only when the read-back matches what was sent (metadata aside)
    await cfg().update('containers.pullAfterPush', 'when-identical', vscode.ConfigurationTarget.Global);
    const sent4 = program(['R[1]=1', 'R[2]=2', 'R[3]=3', 'R[4]=4']);
    await setWorking(sent4);
    msgs = await push();
    robot = robotText();
    const sameBody = body(robot) === body(sent4);
    check('4. when-identical: the push lands on the robot', hasReg(robot, 4), body(robot));
    if (sameBody) check('4. when-identical: identical program body -> working copy = robot read-back', lf(workingText()) === lf(robot), lf(workingText()));
    else check('4. when-identical: different read-back -> working copy kept and a warning shown', lf(workingText()) === lf(sent4) && msgs.some(m => /left unchanged/.test(m.msg)), JSON.stringify(msgs));
    note('4. read-back body same as sent', sameBody);

    // ---- 5. conflict: the program changes on the "pendant" (FTP) after the last sync
    await cfg().update('containers.pullAfterPush', 'always', vscode.ConfigurationTarget.Global);
    const pendant = program(['R[1]=1', 'R[2]=2', 'R[3]=3', 'R[4]=4', 'R[9]=9']);
    robotPut(pendant);
    await sleep(500);
    const pendantOnRobot = robotText();
    await setWorking(program(['R[1]=1', 'R[5]=5']));
    msgs = await push();
    robot = robotText();
    check('5. conflict: the push is refused with the "differs from the snapshot" modal', msgs.some(m => m.modal && /differs from the snapshot/.test(m.msg)), JSON.stringify(msgs));
    check('5. conflict: the pendant change on the robot is NOT overwritten', hasReg(robot, 9) && !hasReg(robot, 5) && lf(robot) === lf(pendantOnRobot), body(robot));
    check('5. conflict: nothing asked to confirm an upload', !msgs.some(m => /^Upload /.test(m.msg)), JSON.stringify(msgs));

    // ---- 7. controller options: the robot page's card and the full list
    const opt = since();
    await vscode.commands.executeCommand('robotCode.live.dashboard', 'LIVE');
    await sleep(1500);
    await vscode.commands.executeCommand('robotCode.live.getOptions', 'LIVE');
    await sleep(1000);
    check('7. options: Get Controller Options reads without a warning', !opt().some(m => m.kind !== 'info' && /options/i.test(m.msg)), JSON.stringify(opt()));
    await shot('options-card');
    await vscode.commands.executeCommand('robotCode.live.showOptions', 'LIVE');
    await sleep(1500);
    const tabs = vscode.window.tabGroups.all.flatMap(g => g.tabs.map(t => t.label));
    check('7. options: Show Controller Options opens "Options: LIVE"', tabs.includes('Options: LIVE'), tabs.join(', '));
    await shot('options-page');

    // ---- 8. refusals on programs set up on the robot (ROBOT_CODE_LIVE_REFUSE=TOOL1MNT,TOOL2MNT):
    // a running/paused one or a write-protected one. Each push sends the robot's OWN copy back, so
    // even an unexpected accept changes nothing but the stamp; these programs are never deleted.
    for (const prog of (process.env.ROBOT_CODE_LIVE_REFUSE || '').split(',').map(x => x.trim().toUpperCase()).filter(Boolean)) {
      const before = curl([`${ftp}${prog}.LS`]);
      const file = vscode.Uri.file(path.join(root, 'live', 'LS', `${prog}.LS`));
      fs.writeFileSync(file.fsPath, lf(before) + '\n', 'latin1');
      const doc = await vscode.workspace.openTextDocument(file); await vscode.window.showTextDocument(doc);
      await vscode.commands.executeCommand('robotCode.live.getTasks', 'LIVE').then(undefined, () => undefined);
      await sleep(500);
      const after = since();
      await vscode.commands.executeCommand('robotCode.sync.pushFile', file);
      await sleep(1500);
      const msgs = after().filter(m => !/^Upload /.test(m.msg));
      const now = curl([`${ftp}${prog}.LS`]);
      check(`8. ${prog}: the push is refused or fails with a message`, msgs.some(m => m.kind === 'warning' || m.kind === 'error'), JSON.stringify(after()));
      check(`8. ${prog}: the program on the robot is unchanged`, lf(now) === lf(before), body(now));
      note(`8. ${prog} messages`, JSON.stringify(after().map(m => (m.modal ? '[modal] ' : '') + m.msg)));
    }

    // ---- 6. a controller nothing answers on (192.0.2.1): Connect names the likely cause
    const dead = since();
    await vscode.commands.executeCommand('robotCode.live.connect', 'DEAD');
    await sleep(500);
    const err = dead().find(m => m.kind === 'error' && /Could not connect to DEAD/.test(m.msg));
    check('6. unreachable robot: Connect says why (refused port or no answer)', err && /Port refused|No answer/.test(err.msg), JSON.stringify(dead()));
    note('6. message', err?.msg ?? '(none)');
  } catch (e) {
    check('no exception', false, e?.stack ?? e);
  } finally {
    robotDelete();
    check('cleanup: the test program is gone from the robot', !robotHas(), robotList().filter(f => f.startsWith(PROG.toLowerCase())).join(', '));
    await cfg().update('containers.pullAfterPush', undefined, vscode.ConfigurationTarget.Global);
  }
};
