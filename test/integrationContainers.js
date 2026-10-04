// Containers smoke test, run inside a real VS Code extension host against a COPY of
// test/fixtures-cell. Observes only what a user-facing API shows: the sync state hook,
// workspace symbols (the program index), hovers, the diff editor.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const OUT = process.env.ROBOT_CODE_TEST_OUT;
const results = [];
function check(name, cond, detail) { results.push({ name, ok: !!cond, detail: detail === undefined ? undefined : String(detail).slice(0, 500) }); fs.writeFileSync(OUT, JSON.stringify(results, null, 2)); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms = 10000, step = 250) { const end = Date.now() + ms; let v; while (Date.now() < end) { try { v = await fn(); } catch { v = undefined; } if (v) return v; await sleep(step); } return v; }

exports.run = async function () {
  const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const at = (...p) => vscode.Uri.file(path.join(root, ...p));
  const symbols = async q => (await vscode.commands.executeCommand('vscode.executeWorkspaceSymbolProvider', q)) ?? [];
  const rel = s => path.relative(root, s.location.uri.fsPath).replace(/\\/g, '/');
  const syncState = () => vscode.commands.executeCommand('robotCode.sync._state');
  const open = async uri => { const d = await vscode.workspace.openTextDocument(uri); await vscode.window.showTextDocument(d); return d; };

  const ext = vscode.extensions.all.find(e => /robot-code$/.test(e.id));
  await ext.activate();
  const cmds = await vscode.commands.getCommands(true);
  for (const c of ['robotCode.containers.initCell', 'robotCode.containers.initRobot', 'robotCode.data.snapshotFromBackup', 'robotCode.data.snapshotFromRobot', 'robotCode.containers.diffWithSnapshot']) check('command registered: ' + c, cmds.includes(c));
  for (const c of ['robotCode.sync.fetchFile', 'robotCode.sync.pullFile', 'robotCode.sync.pushFile', 'robotCode.sync.compareFile', 'robotCode.sync.comparePositions', 'robotCode.sync.compareRegisters', 'robotCode.sync.revertFile', 'robotCode.sync.pullToWorking', 'robotCode.sync.diffOpen', 'robotCode.sync.history', 'robotCode.sync.fetchAll', 'robotCode.sync.fetchPrograms', 'robotCode.sync.fetchData', 'robotCode.sync.fetchFolder', 'robotCode.sync.pullFolder', 'robotCode.sync.fetchCompareAll']) check('command registered: ' + c, cmds.includes(c));

  // ---- the Snapshot view lists the robot containers ----
  // Wait for the SETTLED view: the snapshot rows are a disk listing and appear first, while the
  // Programs rows need the index scan, so sampling when only the snapshot is ready read empty tp rows.
  const views = await waitFor(async () => {
    const v = await vscode.commands.executeCommand('robotCode.views._state');
    return v && v.snapshot && v.snapshot.rows && v.snapshot.rows.length && v.tp && v.tp.rows && v.tp.rows.some(r => /synced/.test(r)) ? v : undefined;
  }, 30000);
  check('snapshot view: lists the robot containers (robotA, robotB)', !!views && /2 robots/.test(views.snapshot.description) && views.snapshot.rows.some(r => /robota/i.test(r)) && views.snapshot.rows.some(r => /robotb/i.test(r)), JSON.stringify(views && views.snapshot));
  check('snapshot view: a robot row carries its snapshot status', !!views && views.snapshot.rows.some(r => /snapshot|robot/.test(r)), JSON.stringify(views && views.snapshot.rows));
  // The Sync view was retired; its state lives on the Programs rows and the robot-row summary.
  check('sync view: retired (state folded into Programs)', views.sync === undefined, JSON.stringify(Object.keys(views)));
  check('programs tree: robot rows carry the snapshot-sync summary', views.tp.rows.some(r => /synced/.test(r)), JSON.stringify(views.tp.rows));

  // ---- the index, as the partition says it should be ----
  const indexed = await waitFor(async () => { const s = await symbols(''); return s.some(x => x.name === 'PROGA') && s.some(x => x.name === 'LOOSE') ? s : undefined; }, 20000);
  const files = (indexed || []).map(rel).sort();
  check('index: programs were indexed', files.length > 0, files.join(' | '));
  check('index: working programs are in (robotA/LS)', files.includes('robotA/LS/PROGA.LS') && files.includes('robotA/LS/ONLYWORK.LS'), files.join(' | '));
  check('index: a robot with no programs list indexes its folder (robotB)', files.includes('robotB/PROGB.LS'), files.join(' | '));
  check('index: a folder with no marker behaves as before (unmanaged)', files.includes('unmanaged/LOOSE.LS'), files.join(' | '));
  check('index: a program in an EXCLUDED backups folder is invisible', !files.some(f => f.startsWith('robotA/backups/')), files.join(' | '));
  const snapInSymbols = files.filter(f => f.includes('.robocode-robot/snapshot/'));
  check('Go to Symbol in Workspace does NOT offer the snapshot copy (reference-only, not for editing)', snapInSymbols.length === 0, 'offered: ' + snapInSymbols.join(', '));

  // ---- working vs snapshot: the sync state (the CodeLens was removed; the state hook carries it) ----
  await open(at('robotA', 'LS', 'PROGA.LS'));
  const stProg = await waitFor(async () => { const st = await syncState(); return st && st.state === 'modified' ? st : undefined; });
  check('sync state: a modified working program reads as modified against the snapshot', !!stProg, JSON.stringify(stProg));
  check('sync state: ONE inserted line reads as 1 line, not a cascade of renumbered lines', stProg && stProg.lines === 1, JSON.stringify(stProg));
  check('sync state: a working program is recognized against its snapshot (not "not in snapshot"/"never fetched")', !!stProg && stProg.state !== 'not-in-snapshot' && typeof stProg.ageMs === 'number', JSON.stringify(stProg));
  await open(at('robotA', 'LS', 'ONLYWORK.LS'));
  const stOnly = await syncState();
  check('sync state: a program that is not in the snapshot is not-in-snapshot', !!stOnly && stOnly.state === 'not-in-snapshot', JSON.stringify(stOnly));
  await open(at('unmanaged', 'LOOSE.LS'));
  check('sync state: an unmanaged program has no container state', (await syncState()) === undefined);
  await open(at('robotA', '.robocode-robot', 'snapshot', 'PROGA.LS'));
  check('sync state: the snapshot copy itself is not a working file', (await syncState()) === undefined);

  // ---- opening a file must not smuggle its folder past the partition ----
  // Opening any program indexes the folder it sits in, so CALLs to its neighbours resolve. Under a
  // robot marker that must still obey the partition: a dated backup stays invisible, and a snapshot
  // file's neighbours stay reference copies.
  await open(at('robotA', 'backups', 'OLDCOPY.LS'));
  await sleep(1500);
  const afterOpen = (await symbols('')).map(rel).sort();
  check('opening a file in an EXCLUDED backups folder does not pull that folder into the index', !afterOpen.some(x => x.startsWith('robotA/backups/')), afterOpen.join(' | '));
  await open(at('robotA', 'LS', 'PROGA.LS'));
  const stAfter = await syncState();
  check('after opening the snapshot copy, the working program still reads as differing from it (the snapshot was not re-indexed as a working copy)', !!stAfter && stAfter.state === 'modified', JSON.stringify(stAfter));
  check('... and Go to Symbol still does not offer the snapshot copy', !afterOpen.some(x => x.includes('.robocode-robot/snapshot/')), afterOpen.filter(x => x.includes('snapshot')).join(', '));

  // ---- the snapshot is the data source, not the dated backup beside it ----
  const doc = await open(at('robotA', 'LS', 'PROGA.LS'));
  const line = doc.getText().split(/\r?\n/).findIndex(l => /R\[1\]=1/.test(l));
  const hov = await waitFor(async () => { const h = await vscode.commands.executeCommand('vscode.executeHoverProvider', doc.uri, new vscode.Position(line, doc.lineAt(line).text.indexOf('R[1]') + 1)); const t = (h || []).flatMap(x => x.contents.map(c => typeof c === 'string' ? c : c.value)).join('\n'); return t || undefined; }, 6000);
  check('hover on R[1] answers at all', !!hov, hov);
  check('hover: the R[1] comment comes from the SNAPSHOT, never from the excluded backup beside it', /FROM SNAPSHOT/.test(hov || '') && !/FROM BACKUP/.test(hov || ''), (hov || '').replace(/\s+/g, ' ').slice(0, 300));

  // ---- the diff ----
  await vscode.commands.executeCommand('robotCode.containers.diffWithSnapshot', at('robotA', 'LS', 'PROGA.LS'));
  const tab = await waitFor(() => { const t = vscode.window.tabGroups.activeTabGroup.activeTab; return t && t.input instanceof vscode.TabInputTextDiff ? t : undefined; }, 8000);
  const active = vscode.window.tabGroups.activeTabGroup.activeTab;
  check('diff: the command opens a diff editor', !!tab, active && active.label);
  if (tab) {
    const src = u => { const m = /src=([^&]+)/.exec(u.query); return m ? decodeURIComponent(m[1]) : u.toString(); };
    const left = src(tab.input.original), right = src(tab.input.modified);
    check('diff: snapshot on the LEFT (original), working copy on the RIGHT (modified), so an added line shows as added', /snapshot/.test(left) && !/snapshot/.test(right), 'left=' + left.split('/').slice(-3).join('/') + '  right=' + right.split('/').slice(-3).join('/'));
    const text = (await vscode.workspace.openTextDocument(tab.input.original)).getText() + '\n' + (await vscode.workspace.openTextDocument(tab.input.modified)).getText();
    check('diff: both sides are normalized - no line numbers left in /MN', !/^\s*\d+:/m.test(text), text.split('\n').filter(l => /^\s*\d+:/.test(l)).slice(0, 3).join(' / '));
  }
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');

  // ---- editing robot.json must re-partition the workspace ----
  const rj = path.join(root, 'robotA', '.robocode-robot', 'robot.json');
  const before = fs.readFileSync(rj, 'utf8');
  fs.writeFileSync(rj, JSON.stringify({ name: 'RobotA', programs: ['NOPE'], exclude: ['backups'], controller: 'RobotA' }));
  // Wait for the SETTLED state: PROGA gone and the index not mid-rescan. The rescan empties the
  // index for an instant, and sampling that instant failed the next check two runs in three.
  const gone = await waitFor(async () => { const f = (await symbols('')).map(rel); return f.length && !f.includes('robotA/LS/PROGA.LS') ? f : undefined; }, 8000);
  const still = (await symbols('')).map(rel).filter(f => f.startsWith('robotA/LS'));
  check('robot.json edited (programs: LS -> NOPE): robotA/LS drops out of the index with no manual refresh', !!gone, 'still indexed after 8 s: ' + still.join(', '));
  // only meaningful when it did drop: a momentarily EMPTY index also 'does not include PROGA', and that
  // false pass is exactly what this line caught the first time the test ran
  if (gone) check('... and the rest of the index is still there (it did not just go empty)', (gone || []).includes('unmanaged/LOOSE.LS') && (gone || []).includes('robotB/PROGB.LS'), (gone || []).join(' | '));
  fs.writeFileSync(rj, before);
  if (!gone) { await vscode.commands.executeCommand('robotCode.data.refresh'); await sleep(1500); }
  const back = await waitFor(async () => { const f = (await symbols('')).map(rel); return f.includes('robotA/LS/PROGA.LS') ? f : undefined; }, 8000);
  const afterRestore = (await symbols('')).map(rel).sort();
  check('robot.json restored (programs: NOPE -> LS): robotA/LS comes back into the index with no manual refresh', !!back, 'index 8 s after restoring: ' + afterRestore.join(' | '));
  if (!back) {
    await vscode.commands.executeCommand('robotCode.data.refresh'); await sleep(2500);
    const afterManual = (await symbols('')).map(rel).sort();
    check('... and the manual Refresh command does bring it back', afterManual.includes('robotA/LS/PROGA.LS'), afterManual.join(' | '));
  }

  // ---- the snapshot is indexed even when the file search cannot reach it ----
  // A user files.exclude on .robocode-robot (or an ignore file) used to leave the reference
  // copy unindexed: the program then read as "not in snapshot" / "never fetched" while the
  // Snapshot view - a plain disk listing - showed the file. The index walks snapshot dirs.
  const cfg = vscode.workspace.getConfiguration();
  await cfg.update('files.exclude', { '**/robotA/.robocode-robot/snapshot/**': true }, vscode.ConfigurationTarget.Workspace);
  await vscode.commands.executeCommand('robotCode.data.refresh');
  await sleep(1500);
  await open(at('robotA', 'LS', 'PROGA.LS'));
  const stExcluded = await vscode.commands.executeCommand('robotCode.sync._state');
  check('sync state: still recognized when .robocode-robot is excluded from the file search', !!stExcluded && stExcluded.state !== 'not-in-snapshot' && typeof stExcluded.ageMs === 'number', JSON.stringify(stExcluded));
  await cfg.update('files.exclude', undefined, vscode.ConfigurationTarget.Workspace);
  await vscode.commands.executeCommand('robotCode.data.refresh');
  await sleep(1000);
};
