// ABB smoke test, run inside a real VS Code extension host with robotCode.abb.enabled on and
// one real IRC5 backup as the workspace (read only - nothing here writes to it). Observes only
// what the user-facing APIs show: language ids, outline, definition, hover, completion,
// diagnostics, workspace symbols (the program index).
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const OUT = process.env.ROBOT_CODE_TEST_OUT;
const results = [];
function check(name, cond, detail) { results.push({ name, ok: !!cond, detail: detail === undefined ? undefined : String(detail).slice(0, 600) }); fs.writeFileSync(OUT, JSON.stringify(results, null, 2)); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms = 10000, step = 250) { const end = Date.now() + ms; let v; while (Date.now() < end) { try { v = await fn(); } catch { v = undefined; } if (v) return v; await sleep(step); } return v; }
const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);

exports.run = async function () {
  const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const ext = vscode.extensions.all.find(e => /robot-code$/.test(e.id));
  await ext.activate();
  check('ABB loads by itself in an ABB workspace (robotCode.abb.enabled not set)', vscode.workspace.getConfiguration('robotCode').inspect('abb.enabled').globalValue === undefined && (await vscode.commands.getCommands(true)).includes('robotCode.rapid.refresh'));
  {
    const brands = await vscode.commands.executeCommand('robotCode.views._brands');
    check('side bar: an ABB-only workspace shows ABB, not FANUC', brands && brands.abb === true && brands.fanuc === false && !brands.needsAsk, JSON.stringify(brands));
    check('FANUC does not load in an ABB-only workspace', brands && brands.loaded && brands.loaded.fanuc === false && brands.loaded.abb === true, JSON.stringify(brands && brands.loaded));
    const cmds = await vscode.commands.getCommands(true);
    check('a FANUC command still answers (offers to turn FANUC on) instead of command-not-found', cmds.includes('robotCode.tp.renumber') && cmds.includes('robotCode.data.openRegisterTable'));
  }

  // the task with the most program modules
  const all = walk(path.join(root, 'RAPID'));
  const byTask = new Map();
  for (const f of all.filter(f => /\.mod$/i.test(f))) { const t = path.basename(path.dirname(path.dirname(f))); byTask.set(t, [...(byTask.get(t) ?? []), f]); }
  const [task, mods] = [...byTask.entries()].sort((a, b) => b[1].length - a[1].length)[0] ?? [];
  check('the backup has program modules', !!mods, [...byTask.keys()].join(','));
  if (!mods) return;
  const sys = all.find(f => /[\\/]SYSMOD[\\/][^\\/]+\.sys$/i.test(f) && /^\s*(%%%|MODULE)/m.test(fs.readFileSync(f, 'latin1').slice(0, 400)));

  // ---- language ----
  const doc = await vscode.workspace.openTextDocument(mods[0]);
  await vscode.window.showTextDocument(doc);
  check('a .mod opens as abb-rapid', doc.languageId === 'abb-rapid', doc.languageId);
  if (sys) { const d = await vscode.workspace.openTextDocument(sys); check('a .sys under SYSMOD opens as abb-rapid', d.languageId === 'abb-rapid', `${d.languageId} ${path.basename(sys)}`); }

  // ---- outline ----
  const syms = await waitFor(async () => { const s = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', doc.uri); return s && s.length ? s : undefined; });
  const top = syms && syms[0];
  check('outline: the module is the top symbol, with its routines and data inside', top && top.kind === vscode.SymbolKind.Module && top.children.length > 0, top ? `${top.name}: ${top.children.slice(0, 6).map(c => c.name).join(', ')}` : 'none');

  // ---- definition across the task: an argument-less procedure call resolving into another file ----
  let crossFile = 0, tried = 0, sample = '';
  for (const f of mods.slice(0, 12)) {
    const d = await vscode.workspace.openTextDocument(f);
    for (let i = 0; i < d.lineCount && tried < 60; i++) {
      const m = /^\s*([A-Za-z_]\w*)\s*;/.exec(d.lineAt(i).text);
      if (!m || /^(ENDPROC|ENDFUNC|ENDTRAP|ENDIF|ENDFOR|ENDWHILE|ENDTEST|ENDMODULE|RETURN|EXIT|STOP|ELSE|DEFAULT|BREAK|RETRY|TRYNEXT|RAISE|ENDRECORD|UNDO|ERROR|BACKWARD)$/i.test(m[1])) continue;
      tried++;
      const locs = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', d.uri, new vscode.Position(i, d.lineAt(i).text.indexOf(m[1]) + 1));
      const other = (locs ?? []).find(l => (l.uri ?? l.targetUri).fsPath.toLowerCase() !== d.uri.fsPath.toLowerCase());
      if (other) { crossFile++; if (!sample) sample = `${m[1]} in ${path.basename(f)} -> ${path.basename((other.uri ?? other.targetUri).fsPath)}`; }
    }
  }
  check('definition: procedure calls resolve into other modules of the task', crossFile > 0, `${crossFile} of ${tried} calls resolved into another file in ${task}; e.g. ${sample}`);

  // ---- references, highlights, rename, lenses, Ctrl+T on a routine called from another module ----
  let navDone = false;
  for (const f of mods.slice(0, 12)) {
    if (navDone) break;
    const d = await vscode.workspace.openTextDocument(f);
    for (let i = 0; i < d.lineCount && !navDone; i++) {
      const m = /^\s*([A-Za-z_]\w*)\s*;/.exec(d.lineAt(i).text);
      if (!m) continue;
      const pos = new vscode.Position(i, d.lineAt(i).text.indexOf(m[1]) + 1);
      const defs = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', d.uri, pos);
      const def = (defs ?? []).find(l => (l.uri ?? l.targetUri).fsPath.toLowerCase() !== d.uri.fsPath.toLowerCase());
      if (!def) continue;
      navDone = true;
      const defUri = def.uri ?? def.targetUri;
      const refs = await vscode.commands.executeCommand('vscode.executeReferenceProvider', d.uri, pos) ?? [];
      check('references: a routine\'s uses across the task, its declaration included', refs.length >= 2 && refs.some(r => r.uri.fsPath.toLowerCase() === defUri.fsPath.toLowerCase()) && refs.some(r => r.uri.fsPath.toLowerCase() === d.uri.fsPath.toLowerCase() && r.range.start.line === i), `${m[1]}: ${refs.length} refs in ${new Set(refs.map(r => path.basename(r.uri.fsPath))).size} files`);
      const hl = await vscode.commands.executeCommand('vscode.executeDocumentHighlights', d.uri, pos) ?? [];
      check('highlight: the name under the cursor, every use in this file', hl.length >= 1 && hl.length === refs.filter(r => r.uri.toString() === d.uri.toString()).length, `${hl.length} highlights`);
      const edit = await vscode.commands.executeCommand('vscode.executeDocumentRenameProvider', d.uri, pos, `${m[1]}X`);
      const edits = edit ? edit.entries().reduce((n, [, es]) => n + es.length, 0) : 0;
      check('rename: one edit per reference, across files (not applied: the corpus is read-only)', edits === refs.length, `${edits} edits for ${refs.length} refs`);
      const lenses = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', defUri, 50) ?? [];
      const lens = lenses.find(l => l.range.start.line === (def.range ?? def.targetSelectionRange ?? def.targetRange).start.line);
      check('lens: "N references" above the routine', lens && lens.command && /^\d+ references?/.test(lens.command.title), lens ? lens.command && lens.command.title : `${lenses.length} lenses in ${path.basename(defUri.fsPath)}`);
      const syms = await vscode.commands.executeCommand('vscode.executeWorkspaceSymbolProvider', m[1]) ?? [];
      check('Ctrl+T: the routine is found by name across the workspace', syms.some(s => s.name.toUpperCase() === m[1].toUpperCase() && s.location.uri.fsPath.toLowerCase() === defUri.fsPath.toLowerCase()), `${syms.length} symbols for ${m[1]}`);
    }
  }
  if (!navDone) check('references: found a cross-module call to test with', false, 'none in the first 12 modules');

  // ---- analysis reports: unused routines and the cross-reference for the open module's task, backup compare ----
  {
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(mods[0]));
    const reportAfter = async cmd => {
      await vscode.commands.executeCommand(cmd);
      return waitFor(async () => { const e = vscode.window.activeTextEditor; return e && e.document.languageId === 'markdown' && e.document.isUntitled ? e.document.getText() : undefined; }, 15000);
    };
    const unused = await reportAfter('robotCode.abb.unusedRoutines');
    check('reports: Unused Routines for the open module\'s task', unused && /^# Unused routines - /.test(unused) && /routines? nothing in the task/.test(unused), (unused ?? '').split('\n').slice(0, 3).join(' | '));
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(mods[0]));
    const xref = await reportAfter('robotCode.abb.xrefReport');
    check('reports: Data & Signal Cross-Reference for the task', xref && /^# RAPID cross-reference - /.test(xref) && /data items, \d+ signals/.test(xref), (xref ?? '').split('\n').slice(0, 3).join(' | '));
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    const backupsRoot = path.dirname(root);
    const two = fs.readdirSync(backupsRoot).map(n => path.join(backupsRoot, n)).filter(p => fs.existsSync(path.join(p, 'BACKINFO'))).slice(0, 2);
    if (two.length === 2) {
      await vscode.commands.executeCommand('robotCode.abb.compareBackups', vscode.Uri.file(two[0]), vscode.Uri.file(two[1]));
      const cmp = await waitFor(async () => { const e = vscode.window.activeTextEditor; return e && e.document.languageId === 'markdown' && /^# ABB backup compare/.test(e.document.getText()) ? e.document.getText() : undefined; }, 30000);
      check('reports: Compare Two ABB Backups', cmp && /modules? differ/.test(cmp), (cmp ?? '').split('\n').slice(4, 6).join(' | '));
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    }
  }

  // ---- hover on a built-in and on a robtarget ----
  let moveHover = '', targetHover = '';
  for (const f of mods) {
    const d = await vscode.workspace.openTextDocument(f);
    const text = d.getText();
    if (!moveHover) { const i = text.search(/\bMove[LJ]\b/); if (i >= 0) { const h = await vscode.commands.executeCommand('vscode.executeHoverProvider', d.uri, d.positionAt(i + 2)); moveHover = (h ?? []).flatMap(x => x.contents.map(c => c.value ?? String(c))).join(' '); } }
    if (!targetHover) { const m = /\b(CONST|PERS|VAR)\s+robtarget\s+(\w+)\s*:=/.exec(text); if (m) { const i = m.index + m[0].indexOf(m[2]); const h = await vscode.commands.executeCommand('vscode.executeHoverProvider', d.uri, d.positionAt(i + 1)); targetHover = (h ?? []).flatMap(x => x.contents.map(c => c.value ?? String(c))).join(' '); } }
    if (moveHover && targetHover) break;
  }
  check('hover: a move instruction shows its RAPID doc', /Move[LJ]/.test(moveHover), moveHover.slice(0, 200));
  check('hover: a robtarget shows its X/Y/Z and quaternion', /X · Y · Z/.test(targetHover) && /q1/.test(targetHover), targetHover.slice(0, 300));

  // ---- completion ----
  const list = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', doc.uri, new vscode.Position(0, 0));
  const labels = new Set((list?.items ?? []).map(i => typeof i.label === 'string' ? i.label : i.label.label));
  check('completion: RobotWare instructions in their own spelling, and the task\'s routines', labels.has('MoveL') && labels.has('TPWrite') && labels.size > 300, `${labels.size} items`);

  // ---- diagnostics: production code produces no errors ----
  for (const f of mods) await vscode.workspace.openTextDocument(f);
  await sleep(1500);
  const errs = mods.flatMap(f => vscode.languages.getDiagnostics(vscode.Uri.file(f)).filter(d => d.severity === vscode.DiagnosticSeverity.Error).map(d => `${path.basename(f)}:${d.range.start.line + 1} ${d.message}`));
  const any = mods.reduce((n, f) => n + vscode.languages.getDiagnostics(vscode.Uri.file(f)).length, 0);
  check('diagnostics: no errors on modules a controller runs', errs.length === 0, errs.slice(0, 5).join(' | ') || `${any} hints/infos`);

  // ---- typing RAPID: argument hints, typed completion, snippets, Format, Enter ----
  {
    const src = ['MODULE Scratch', 'VAR robtarget pPick := [[1,2,3],[1,0,0,0],[0,0,0,0],[9E9,9E9,9E9,9E9,9E9,9E9]];', 'PERS tooldata tGrip := [TRUE,[[0,0,100],[1,0,0,0]],[1,[0,0,1],[1,0,0,0],0,0,0]];', 'PROC main()', 'MoveL pPick, ', 'ENDPROC', 'ENDMODULE'].join('\n');
    const d = await vscode.workspace.openTextDocument({ language: 'abb-rapid', content: src });
    const ed = await vscode.window.showTextDocument(d);
    const endOf = l => new vscode.Position(l, d.lineAt(l).text.length);
    const sh = await vscode.commands.executeCommand('vscode.executeSignatureHelpProvider', d.uri, endOf(4), ',');
    const sig = sh && sh.signatures[sh.activeSignature ?? 0];
    const active = sig && sig.parameters[sh.activeParameter];
    const activeText = active && (Array.isArray(active.label) ? sig.label.slice(active.label[0], active.label[1]) : active.label);
    check('hints: on "MoveL pPick, " the signature shows and Speed is the active argument', sig && /MoveL/.test(sig.label) && activeText === 'Speed', `${sig && sig.label} | active ${activeText}`);
    const comp = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', d.uri, endOf(4));
    const sorted = (comp?.items ?? []).slice().sort((a, b) => (a.sortText ?? a.label).localeCompare(b.sortText ?? b.label)).map(i => typeof i.label === 'string' ? i.label : i.label.label);
    check('completion: in the Speed argument, speeddata comes first (v100 ... vmax)', sorted.slice(0, 30).includes('v100') && sorted.slice(0, 30).includes('vmax') && !sorted.slice(0, 30).includes('MoveL'), sorted.slice(0, 12).join(', '));
    await ed.edit(b => b.replace(d.lineAt(4).range, 'MoveL pPick, v100, z10, '));
    const comp2 = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', d.uri, endOf(4));
    const top2 = (comp2?.items ?? []).slice().sort((a, b) => (a.sortText ?? '').localeCompare(b.sortText ?? '')).map(i => typeof i.label === 'string' ? i.label : i.label.label).slice(0, 5);
    check('completion: in the Tool argument, the module\'s own tooldata first, then tool0', top2[0] === 'tGrip' && top2.includes('tool0'), top2.join(', '));
    await ed.edit(b => b.replace(d.lineAt(4).range, 'Mov'));
    const comp3 = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', d.uri, endOf(4));
    const movel = (comp3?.items ?? []).find(i => (typeof i.label === 'string' ? i.label : i.label.label) === 'MoveL');
    const snip = movel && (movel.insertText?.value ?? movel.insertText);
    check('completion: at a statement start, MoveL inserts its required arguments as placeholders', snip === 'MoveL ${1:ToPoint}, ${2:Speed}, ${3:Zone}, ${4:Tool};', String(snip));
    await ed.edit(b => b.replace(d.lineAt(4).range, 'MoveL pPick, v100, z10, tGrip;'));
    // Format Document with a customer base of 4 and step of 2
    await vscode.workspace.getConfiguration('robotCode').update('rapid.format.baseIndent', 4, vscode.ConfigurationTarget.Global);
    await vscode.workspace.getConfiguration('robotCode').update('rapid.format.indentSize', 2, vscode.ConfigurationTarget.Global);
    const fmt = await vscode.commands.executeCommand('vscode.executeFormatDocumentProvider', d.uri, { tabSize: 4, insertSpaces: true });
    const we = new vscode.WorkspaceEdit(); for (const e of fmt ?? []) we.replace(d.uri, e.range, e.newText); await vscode.workspace.applyEdit(we);
    const lines = d.getText().split('\n');
    check('format: MODULE at 0, contents at the customer base (4), blocks one step (2) in', lines[0] === 'MODULE Scratch' && lines[1].startsWith('    VAR') && lines[3] === '    PROC main()' && lines[4] === '      MoveL pPick, v100, z10, tGrip;' && lines[5] === '    ENDPROC' && lines[6] === 'ENDMODULE', JSON.stringify(lines));
    check('format: the editor types with the same step (tab size 2, spaces)', vscode.window.activeTextEditor.options.tabSize === 2 && vscode.window.activeTextEditor.options.insertSpaces === true, JSON.stringify(vscode.window.activeTextEditor.options));
    await vscode.workspace.getConfiguration('robotCode').update('rapid.format.baseIndent', undefined, vscode.ConfigurationTarget.Global);
    await vscode.workspace.getConfiguration('robotCode').update('rapid.format.indentSize', undefined, vscode.ConfigurationTarget.Global);
    // Enter on a comment line keeps writing a comment; on an empty "!" it does not
    await ed.edit(b => b.insert(endOf(4), '\n      ! pick the part'));
    ed.selection = new vscode.Selection(endOf(5), endOf(5));
    // a suggestion list or parameter hint left open by the steps above would take the Enter
    await vscode.commands.executeCommand('hideSuggestWidget');
    await vscode.commands.executeCommand('closeParameterHints');
    await sleep(200);
    await vscode.commands.executeCommand('type', { text: '\n' });
    const afterComment = d.lineAt(6).text;
    check('Enter: after a comment line the next line starts with "!" at the same indent', /^      ! ?$/.test(afterComment), `${JSON.stringify(afterComment)} (line above ${JSON.stringify(d.lineAt(5).text)})`);
    ed.selection = new vscode.Selection(endOf(6), endOf(6));
    await vscode.commands.executeCommand('type', { text: '\n' });
    check('Enter: after an empty "!" the next line is plain code', !/!/.test(d.lineAt(7).text), JSON.stringify(d.lineAt(7).text));
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  }

  // ---- the RAPID sidebar section ----
  const state = await waitFor(async () => { const s = await vscode.commands.executeCommand('robotCode.rapid._state'); return s && s.backups.length && s.routines.length ? s : undefined; }, 20000);
  check('sidebar: one row per backup, named by robot, with the robot type', state && state.backups.length === 1 && /IRB \d+-\d+\//.test(state.backups[0]), state && state.backups.join(' | '));
  check('sidebar: tasks by name, the motion task first and TASK0 as Shared', state && /^T_ROB1 — .*motion task/.test(state.first[0] ?? '') && state.first.some(l => /^Shared — TASK0/.test(l)), state && state.first.join(' | '));
  const hasHome = fs.existsSync(path.join(root, 'HOME')) && walk(path.join(root, 'HOME')).some(f => /\.(mod|sys)$/i.test(f));
  if (hasHome) check('sidebar: the backup\'s HOME disk is one row after the tasks, not a backup of its own', state && /^HOME — controller disk/.test(state.first[state.first.length - 1] ?? ''), state && state.first.join(' | '));
  check('sidebar: modules, program modules before system modules, encrypted last', state && state.modules.length > 0 && (() => {
    const kind = l => /— encrypted/.test(l) ? 2 : /— system/.test(l) ? 1 : 0;
    const k = state.modules.map(kind); return k.every((x, i) => i === 0 || k[i - 1] <= x);
  })(), state && state.modules.slice(0, 8).join(' | '));
  check('sidebar: a module lists its routines', state && state.routines.length > 0 && state.routines.every(l => /(PROC|FUNC|TRAP)/.test(l)), state && state.routines.slice(0, 6).join(' | '));
  check('sidebar: the header counts backups and modules', state && /1 backup · \d+ modules/.test(state.description ?? ''), state && state.description);
  // a routine row opens its module at the routine
  const target = mods.find(f => /^\s*(LOCAL\s+)?PROC\s+\w+/im.test(fs.readFileSync(f, 'latin1')));
  if (target) {
    const lines = fs.readFileSync(target, 'latin1').split(/\r?\n/);
    const line = lines.findIndex(l => /^\s*(LOCAL\s+)?PROC\s+\w+/i.test(l));
    await vscode.commands.executeCommand('robotCode.rapid.open', vscode.Uri.file(target), line);
    const ed = vscode.window.activeTextEditor;
    check('sidebar: clicking a routine opens its module at the routine', ed && ed.document.uri.fsPath.toLowerCase() === target.toLowerCase() && ed.selection.active.line === line, ed ? `${path.basename(ed.document.uri.fsPath)}:${ed.selection.active.line} want ${line}` : 'no editor');
  }

  // ---- ABB Controllers (a mock IRC5 replaying a real controller's RWS answers) ----
  if (process.env.ROBOT_CODE_ABB_MOCK) {
    const name = process.env.ROBOT_CODE_ABB_MOCK;
    const st = async () => vscode.commands.executeCommand('robotCode.abb._state');
    const s0 = await st();
    check('controllers: listed from the setting, not connected, nothing read yet', s0.lines.some(l => l.startsWith(`${name} — `) && /disconnected/.test(l)) && s0.requests.every(r => r.requests === 0), s0.lines.join(' | '));
    await vscode.commands.executeCommand('robotCode.abb.connect', name, 'robotics');
    const s1 = await waitFor(async () => { const s = await st(); return s.lines.some(l => /Program pointer/.test(l)) ? s : undefined; }, 10000) ?? await st();
    const txt = s1.lines.join('\n');
    check('controllers: Connect logs in and reads state (motors, mode, speed, execution)', /MOCK — .*connected · Motors Off · Auto · 100% · RAPID Stopped/.test(txt), s1.lines[0]);
    check('controllers: the controller identity (name, robot type, RobotWare)', /Controller — 6700-805115 · IRB 6700-300\/2\.70 · RobotWare 6\.16\.01\.00/.test(txt), txt.slice(0, 400));
    check('controllers: tasks, the motion task marked', /T_ROB1 — motion task/.test(txt) && /SC_CBC — Semistatic/.test(txt), txt);
    check('controllers: program and motion pointers with module, routine and line', /Program pointer — STYLE_35L › MOV_R01_Pick_35L · line 77/.test(txt) && /Motion pointer — MAIN_MODULE › HomeRobot · line 259/.test(txt), txt);
    check('controllers: position, joints and TCP', /Joints — 0\.00 · -34\.59 · 27\.72/.test(txt) && /TCP — X 949\.1\d · Y -0\.0\d · Z 1274\.27/.test(txt), s1.lines.filter(l => /Joints|TCP|Position/.test(l)).join(' | '));
    const n1 = s1.requests.find(r => r.name === name)?.requests ?? 0;
    // 16 reads + the status subscription (one POST, one event socket)
    check('controllers: a Connect costs a handful of requests, not a stream', n1 > 0 && n1 <= 18, `${n1} requests`);
    await sleep(1500);
    const n2 = (await st()).requests.find(r => r.name === name)?.requests ?? 0;
    check('controllers: nothing is read while idle', n2 === n1, `${n1} -> ${n2}`);
    await vscode.commands.executeCommand('robotCode.abb.refresh', name);
    const n3 = (await st()).requests.find(r => r.name === name)?.requests ?? 0;
    check('controllers: Get reads again, once', n3 > n2 && n3 - n2 <= 14, `${n3 - n2} requests for one Get`);
    const s3 = (await st()).lines.join('\n');
    check('controllers: each task lists its modules, program modules first', /Modules — 9/.test(s3) && s3.indexOf('MAIN_MODULE — program module') >= 0 && s3.indexOf('MAIN_MODULE — program module') < s3.indexOf('BASE — system module'), s3.split('\n').filter(l => /Modules|module/.test(l)).slice(0, 5).join(' | '));
    await vscode.commands.executeCommand('robotCode.abb.openModule', name, 'T_ROB1', 'MAIN_MODULE', 'ProgMod');
    const med = await waitFor(async () => { const e = vscode.window.activeTextEditor; return e && e.document.uri.scheme === 'abb-rws' && e.document.getText().includes('ENDMODULE') ? e : undefined; }, 10000);
    const n4 = (await st()).requests.find(r => r.name === name)?.requests ?? 0;
    check('controllers: a module opens from the controller as read-only RAPID, text to the character, in one read', med && med.document.languageId === 'abb-rapid' && med.document.uri.path === '/MOCK/T_ROB1/MAIN_MODULE.mod' && med.document.getText().startsWith('\nMODULE MAIN_MODULE\n  ! mock text: a <> b & "c"') && n4 - n3 === 1,
      `${med?.document.uri.toString()} ${med?.document.languageId} ${n4 - n3} request(s) ${JSON.stringify(med?.document.getText().slice(0, 40))}`);
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    const bkRoot = fs.mkdtempSync(path.join(require('os').tmpdir(), 'rc-smoke-backup-'));
    try {
      const r = await vscode.commands.executeCommand('robotCode.abb.backup', name, { name: 'SMOKE_Backup', folder: bkRoot, remove: true });
      const f = path.join(bkRoot, 'SMOKE_Backup', 'RAPID', 'TASK1', 'PROGMOD', 'MAIN_MODULE.mod');
      check('controllers: Back Up and Download brings the whole backup to the PC and removes the controller copy when asked', r && r.files === 8 && r.removed && fs.existsSync(f) && fs.readFileSync(f, 'latin1').startsWith('MODULE MAIN_MODULE'), JSON.stringify(r));
    } finally { fs.rmSync(bkRoot, { recursive: true, force: true }); }
    await vscode.commands.executeCommand('robotCode.abb.connect', 'BADPW', 'not-the-password');
    const s4 = await st();
    check('controllers: a wrong password shows as an error on that controller only', s4.lines.some(l => /^BADPW — .*error/.test(l)) && s4.lines.some(l => /^MOCK — .*connected/.test(l)), s4.lines.filter(l => !l.startsWith(' ')).join(' | '));
    await vscode.commands.executeCommand('robotCode.abb.disconnect', name);
    const s5 = await st();
    check('controllers: Disconnect', s5.lines.some(l => /^MOCK — .*disconnected/.test(l)), s5.lines[0]);
  }

  /**
   * The Actions on a real (virtual!) controller, opt-in on top of ROBOT_CODE_ABB_LIVE with
   * ROBOT_CODE_ABB_LIVE_ACTIONS=1: THE ROBOT MOVES (RAPID start). Every setting is put back after:
   * speed, motors, run mode (continuous), the test module unloaded. An OmniCore without write access
   * held by this PC is checked to refuse a write and stay as it was.
   */
  async function liveActions(name, family, st) {
    const run = (cmd, ...a) => vscode.commands.executeCommand(`robotCode.abb.${cmd}`, name, ...a);
    const row = async () => (await st()).lines.find(l => l.startsWith(`${name} — `)) ?? '';
    const speedOf = r => +(/ (\d+)% /.exec(r)?.[1] ?? NaN);
    const before = await row();
    const speed0 = speedOf(before), motors0 = / Motors On /.test(before);
    const L = s => `live ${name} (${family}): ${s}`;
    if (family === 'omnicore' && !(await vscode.commands.executeCommand('robotCode.abb._holdsAccess', name))) {
      const ok = await run('setSpeed', speed0 === 50 ? 75 : 50);
      check(`live ${name}: without write access a write is refused and nothing changes`, ok === false && speedOf(await row()) === speed0, await row());
      // RW 8, as checked by hand: register (braced GUID, numeric PIN), request, the status names this PC's id
      check(L('request write access (control station)'), (await run('requestWriteAccess', true, process.env.ROBOT_CODE_ABB_LIVE_PIN ?? '1234')) === true && (await vscode.commands.executeCommand('robotCode.abb._holdsAccess', name)) === true, await row());
      // one real write while holding it: a virtual digital output, toggled and put back
      const sigs = await vscode.commands.executeCommand('robotCode.abb._signals', name) ?? [];
      // an internal signal (IoPanel, DrvSys, SafeMove) is read-only: only a user's DO can be written
      const out = sigs.find(s => s.type === 'DO' && s.category !== 'internal');
      if (!out) console.log(`  SKIP  ${L('write a digital output')}: ${sigs.length} signals, every DO internal (read-only) - add a virtual DO to test a signal write`);
      if (out) {
        const flip = out.value === '1' ? '0' : '1';
        check(L(`write ${out.name} = ${flip} with write access held`), (await run('setSignal', { path: out.path, value: flip })) === true, out.path);
        if (!(await vscode.commands.executeCommand('robotCode.abb._holdsAccess', name))) await run('requestWriteAccess', true, process.env.ROBOT_CODE_ABB_LIVE_PIN ?? '1234');
        check(L(`put ${out.name} back to ${out.value}`), (await run('setSignal', { path: out.path, value: out.value })) === true, out.path);
      }
    }
    try {
      check(L('speed override 25%'), (await run('setSpeed', 25)) === true && speedOf(await row()) === 25, await row());
      check(L('motors off'), (await run('motorsOff', true)) === true && / Motors Off /.test(await row()), await row());
      check(L('motors on'), (await run('motorsOn', true)) === true && / Motors On /.test(await row()), await row());
      check(L('PP to Main'), (await run('resetProgramPointer', true)) === true && (await st()).lines.some(l => /Program pointer — .* › main\b/i.test(l)), (await st()).lines.filter(l => /pointer/.test(l)).join(' | '));
      check(L('RAPID start once'), (await run('startRapid', 'once')) === true, await row());
      await new Promise(r => setTimeout(r, 1500));
      check(L('RAPID stop'), (await run('stopRapid')) === true && / RAPID Stopped/.test(await row()), await row());
      check(L('RAPID start continuous'), (await run('startRapid', 'forever')) === true && / RAPID Running/.test(await row()), await row());
      await new Promise(r => setTimeout(r, 1000));
      check(L('RAPID stop again'), (await run('stopRapid')) === true && / RAPID Stopped/.test(await row()), await row());
      const file = path.join(require('os').tmpdir(), 'RC_SMOKE_ACT.mod');
      fs.writeFileSync(file, ['MODULE RC_SMOKE_ACT', '  VAR num nSmoke := 1;', '  PROC RcSmokeProc()', '    nSmoke := nSmoke + 1;', '  ENDPROC', 'ENDMODULE', ''].join('\n'));
      try {
        check(L('load a module from a file ($HOME, then load)'), (await run('loadModule', { file, task: 'T_ROB1' })) === true && (await st()).lines.some(l => /^\s*RC_SMOKE_ACT — program module/.test(l)), (await st()).lines.filter(l => /module/.test(l)).join(' | '));
        check(L('write a RAPID variable'), (await run('setRapidData', { task: 'T_ROB1', module: 'RC_SMOKE_ACT', name: 'nSmoke', value: '42' })) === true && (await vscode.commands.executeCommand('robotCode.abb._symbol', name, 'T_ROB1', 'nSmoke', 'RC_SMOKE_ACT')) === '42', String(await vscode.commands.executeCommand('robotCode.abb._symbol', name, 'T_ROB1', 'nSmoke', 'RC_SMOKE_ACT')));
      } finally {
        check(L('unload the module'), (await run('unloadModule', { task: 'T_ROB1', module: 'RC_SMOKE_ACT' })) === true && !(await st()).lines.some(l => /RC_SMOKE_ACT/.test(l)), (await st()).lines.filter(l => /module/.test(l)).join(' | '));
        fs.rmSync(file, { force: true });
      }
      check(L('request write access'), (await run('requestWriteAccess', true)) === true && (await vscode.commands.executeCommand('robotCode.abb._holdsAccess', name)) === true && /write access: this PC/.test(await row()), await row());
      check(L('release write access'), (await run('releaseWriteAccess', true)) === true && (await vscode.commands.executeCommand('robotCode.abb._holdsAccess', name)) === false && /write access free/.test(await row()), await row());
    } finally {
      // OmniCore writes need write access, released above: take it again to put things back
      const regain = family === 'omnicore' && !(await vscode.commands.executeCommand('robotCode.abb._holdsAccess', name));
      if (regain) await run('requestWriteAccess', true, process.env.ROBOT_CODE_ABB_LIVE_PIN ?? '1234');
      await run('stopRapid');
      if (!Number.isNaN(speed0)) await run('setSpeed', speed0);
      if (!motors0) await run('motorsOff', true);
      if (regain) await run('releaseWriteAccess', true);
      const after = await row();
      check(L(`put back: speed ${speed0}%, motors ${motors0 ? 'on' : 'off'}, stopped`), speedOf(after) === speed0 && / Motors On /.test(after) === motors0 && / RAPID Stopped/.test(after), after);
    }
  }

  // ---- real controllers (opt-in, ROBOT_CODE_ABB_LIVE): IRC5 over RWS 1.0, OmniCore over RWS 2.0 ----
  for (const entry of (process.env.ROBOT_CODE_ABB_LIVE_NAMES ?? '').split(',').filter(Boolean)) {
    const [name, family] = entry.split(':');
    const st = async () => vscode.commands.executeCommand('robotCode.abb._state');
    await vscode.commands.executeCommand('robotCode.abb.connect', name, 'robotics');
    const s1 = await waitFor(async () => { const s = await st(); return s.lines.some(l => l.startsWith(`${name} — `) && /connected ·/.test(l)) && s.lines.some(l => /— motion task/.test(l)) ? s : undefined; }, 20000) ?? await st();
    const txt = s1.lines.join('\n');
    check(`live ${name} (${family}): Connect logs in and reads state`, new RegExp(`^${name} — .*connected ·`, 'm').test(txt), s1.lines.find(l => l.startsWith(`${name} — `)));
    check(`live ${name} (${family}): identity and RobotWare`, /Controller — .* · RobotWare \d+\.\d+/.test(txt), s1.lines.find(l => /Controller —/.test(l)));
    check(`live ${name} (${family}): tasks, the motion task marked`, /T_ROB1 — motion task/.test(txt), s1.lines.filter(l => /task/.test(l)).join(' | '));
    check(`live ${name} (${family}): joints read`, /Joints — /.test(txt), s1.lines.filter(l => /Joints|TCP/.test(l)).join(' | '));
    await vscode.commands.executeCommand('robotCode.abb.refresh', name);
    const mods = (await st()).lines.filter(l => /— (program|system) module/.test(l));
    const modName = (mods.find(l => /program module/.test(l)) ?? mods[0] ?? '').trim().split(' — ')[0];
    if (modName) {
      await vscode.commands.executeCommand('robotCode.abb.openModule', name, 'T_ROB1', modName, /program module/.test(mods.find(l => l.trim().startsWith(modName)) ?? '') ? 'ProgMod' : 'SysMod');
      const med = await waitFor(async () => { const e = vscode.window.activeTextEditor; return e && e.document.uri.scheme === 'abb-rws' && /ENDMODULE/i.test(e.document.getText()) ? e : undefined; }, 15000);
      check(`live ${name} (${family}): a module opens from the controller as RAPID`, med && med.document.languageId === 'abb-rapid', `${modName}: ${med?.document.uri.toString()}`);
      if (med) await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    } else check(`live ${name} (${family}): modules listed`, false, (await st()).lines.slice(0, 20).join(' | '));
    await vscode.commands.executeCommand('robotCode.abb.openPage', name);
    const tab = await waitFor(async () => vscode.window.tabGroups.all.flatMap(g => g.tabs).find(x => x.label === name && x.input && x.input.viewType && /abbPage/.test(x.input.viewType)), 10000);
    check(`live ${name} (${family}): the controller page opens`, !!tab, tab ? tab.input.viewType : vscode.window.tabGroups.all.flatMap(g => g.tabs).map(x => x.label).join(', '));
    if (tab) await vscode.window.tabGroups.close(tab);
    await vscode.commands.executeCommand('robotCode.abb.showEventLog', name);
    const elog = await waitFor(async () => { const e = vscode.window.activeTextEditor; return e && e.document.uri.scheme === 'abb-info' && /event log, newest first/.test(e.document.getText()) ? e : undefined; }, 15000);
    check(`live ${name} (${family}): the event log opens, newest first`, elog && /\(\d+ messages/.test(elog.document.getText()) && /^\d{4}-\d\d-\d\d /m.test(elog.document.getText()), elog ? elog.document.getText().split('\n').slice(0, 3).join(' | ') : 'no editor');
    if (elog) await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    await vscode.commands.executeCommand('robotCode.abb.showSignals', name);
    const sig = await waitFor(async () => { const e = vscode.window.activeTextEditor; return e && e.document.uri.scheme === 'abb-info' && /I\/O signals/.test(e.document.getText()) ? e : undefined; }, 15000);
    check(`live ${name} (${family}): the I/O signals open as a table`, sig && /\d+ I\/O signals/.test(sig.document.getText()) && /\s(DO|DI)\s/.test(sig.document.getText()), sig ? sig.document.getText().split('\n').slice(0, 4).join(' | ') : 'no editor');
    if (sig) await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    const bkRoot = fs.mkdtempSync(path.join(require('os').tmpdir(), 'rc-live-backup-'));
    try {
      const r = await vscode.commands.executeCommand('robotCode.abb.backup', name, { name: `SMOKE_${Date.now()}`, folder: bkRoot, remove: true });
      check(`live ${name} (${family}): Back Up and Download, controller copy removed`, r && r.files > 5 && r.removed && fs.readdirSync(bkRoot).length === 1, JSON.stringify(r));
    } catch (e) { check(`live ${name} (${family}): Back Up and Download`, false, String(e && e.message || e)); }
    finally { fs.rmSync(bkRoot, { recursive: true, force: true }); }
    // an Action that throws fails here, and the next controller still runs
    if (process.env.ROBOT_CODE_ABB_LIVE_ACTIONS === '1') await liveActions(name, family, st).catch(e => check(`live ${name} (${family}): the Actions ran to the end`, false, String(e?.stack ?? e).slice(0, 400)));
    await vscode.commands.executeCommand('robotCode.abb.disconnect', name);
    check(`live ${name} (${family}): Disconnect`, (await st()).lines.some(l => new RegExp(`^${name} — .*disconnected`).test(l)), (await st()).lines.find(l => l.startsWith(`${name} — `)));
  }

  // ---- the program index knows RAPID modules ----
  const want = path.basename(mods[0], path.extname(mods[0])).toUpperCase();
  const ws = await waitFor(async () => { const s = await vscode.commands.executeCommand('vscode.executeWorkspaceSymbolProvider', ''); return s && s.some(x => /\.(mod|sys)$/i.test(x.location.uri.fsPath)) ? s : undefined; }, 20000);
  const rapidSyms = (ws ?? []).filter(x => /\.(mod|sys)$/i.test(x.location.uri.fsPath));
  check('index: RAPID modules are in the workspace index (Go to Symbol in Workspace)', rapidSyms.length > 0, `${rapidSyms.length} RAPID entries, e.g. ${rapidSyms.slice(0, 5).map(x => x.name).join(', ')} (looking for ${want})`);
};
