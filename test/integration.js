// Integration smoke test run inside a real VS Code extension host:
//   code --extensionDevelopmentPath=<repo> --extensionTestsPath=<repo>/test/integration.js <workspace>
// Env: ROBOT_CODE_TEST_OUT = results JSON path (written after every check)
//      ROBOT_CODE_SHOT_DIR = if set, the test pauses at interesting states and waits for test/shoot.ps1 to capture the screen
//      ROBOT_CODE_KAREL_SAMPLE = path to a .kl file to open for the KAREL screenshot
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

const OUT = process.env.ROBOT_CODE_TEST_OUT || path.join(require('os').tmpdir(), 'robot-code-integration.json');
const SHOT_DIR = process.env.ROBOT_CODE_SHOT_DIR;
const results = [];
let shotNo = 0;
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail: detail === undefined ? undefined : String(detail).slice(0, 400) });
  fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms = 8000, step = 200) {
  const end = Date.now() + ms; let v;
  while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(step); }
  return v;
}
async function shot(name, settle = 900) {
  if (!SHOT_DIR) return;
  await sleep(settle);
  const base = path.join(SHOT_DIR, `${String(++shotNo).padStart(2, '0')}-${name}`);
  fs.writeFileSync(base + '.ready', '');
  const ok = await waitFor(() => fs.existsSync(base + '.done'), 25000, 200);
  check(`screenshot ${name}`, ok, base + '.png');
}
const hoverText = h => (h ?? []).flatMap(x => x.contents.map(c => (typeof c === 'string' ? c : c.value))).join('\n');

// The mock controller's own record of what was asked of it. Read over HTTP because the
// mock runs in the launcher process and this test runs inside VS Code. Independent of the
// extension's own counters ON PURPOSE: the question is what reached the wire, and a bug
// that skipped the extension's transport would also skip its counter.
const MOCK_PORT = 18080;
async function mockRequests() {
  const res = await fetch(`http://127.0.0.1:${MOCK_PORT}/_stats`);
  return (await res.json()).requests;
}
const since = (log, mark) => log.slice(mark).map(r => r.path);
const labelOf = i => (typeof i.label === 'string' ? i.label : i.label.label);

exports.run = async function run() {
  try {
    await main();
  } catch (e) {
    check('unhandled exception', false, e && (e.stack || e.message || e));
  }
  if (SHOT_DIR) fs.writeFileSync(path.join(SHOT_DIR, 'STOP'), '');
  const failed = results.filter(r => !r.ok);
  if (failed.length) throw new Error(`${failed.length} check(s) failed: ${failed.map(f => f.name).join('; ')}`);
};

async function main() {
  const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  check('workspace open', !!ws, ws);
  check('workspace trusted', vscode.workspace.isTrusted);
  const lsAll = await vscode.workspace.findFiles('**/enterzon.ls', undefined, 50);
  // multi-robot trees have several copies: prefer Latest/S002R01, then any
  const lsFiles = [lsAll.find(u => /latest[\\/]+s002r01/i.test(u.fsPath)) ?? lsAll.find(u => /s002r01/i.test(u.fsPath)) ?? lsAll[0]].filter(Boolean);
  check('sample program found', lsFiles.length === 1, lsAll.map(u => u.fsPath).join());
  const lsUri = lsFiles[0];
  const multiRobot = lsAll.length > 1;

  const ext = vscode.extensions.getExtension('rukus-team.robot-code');
  check('extension found', !!ext);
  await ext.activate();
  check('extension active', ext.isActive);

  // ---- file icons: the Robot Code theme goes on at first activation; the setting takes it off and puts it back ----
  const iconTheme = () => vscode.workspace.getConfiguration('workbench').get('iconTheme');
  const robotCfg = () => vscode.workspace.getConfiguration('robotCode');
  check('file icons: workbench.iconTheme is robot-code-icons after activation', await waitFor(() => iconTheme() === 'robot-code-icons', 5000), iconTheme());
  await robotCfg().update('fileIcons.enabled', false, vscode.ConfigurationTarget.Global);
  check('file icons: setting off puts the previous theme back', await waitFor(() => iconTheme() !== 'robot-code-icons', 5000), iconTheme());
  await robotCfg().update('fileIcons.enabled', true, vscode.ConfigurationTarget.Global);
  check('file icons: setting on again switches back', await waitFor(() => iconTheme() === 'robot-code-icons', 5000), iconTheme());

  // ---- TP document ----
  const doc = await vscode.workspace.openTextDocument(lsUri);
  const editor = await vscode.window.showTextDocument(doc, { preview: false });
  check('language id fanuc-tp', doc.languageId === 'fanuc-tp', doc.languageId);

  const indexed = await waitFor(async () => { const syms = await vscode.commands.executeCommand('vscode.executeWorkspaceSymbolProvider', 'ENTERZON'); return syms && syms.length >= lsAll.length ? syms.length : undefined; }, 90000, 1000);
  check('workspace index has ENTERZON (all copies)', !!indexed, `${indexed} vs ${lsAll.length} files`);

  // ---- sidebar: six sections, each with a header summary and the right rows ----
  for (const v of ['robotCode.robots', 'robotCode.snapshot', 'robotCode.programs', 'robotCode.pcPrograms', 'robotCode.macros', 'robotCode.registers']) {
    let ok = true;
    try { await vscode.commands.executeCommand(`${v}.focus`); } catch (e) { ok = false; }
    check(`sidebar: section ${v} exists`, ok);
  }
  const views = await waitFor(async () => {
    const st = await vscode.commands.executeCommand('robotCode.views._state');
    return st && st.tp.rows.length && st.data.rows.length ? st : undefined;
  }, 30000, 500);
  check('sidebar: sections populated', !!views, JSON.stringify(views && Object.fromEntries(Object.entries(views).map(([k, v]) => [k, v.rows.length]))));
  if (views) {
    const rowText = k => views[k].rows.join('\n');
    check('sidebar: TP programs header is a count', /^\d+/.test(views.tp.description), views.tp.description);
    check('sidebar: TP programs lists ENTERZON (or robot groups when several backups)', /ENTERZON/.test(rowText('tp')) || (multiRobot && views.tp.rows.length > 1), views.tp.rows.slice(0, 4).join(' | '));
    // The Snapshot view replaced the read-only Backup inventory: it lists robot containers
    // (their snapshots), so a plain backup folder with no .robocode marker shows nothing.
    check('sidebar: Snapshot view is container-based (empty without .robocode markers)', views.snapshot.rows.length === 0 || /robot/.test(views.snapshot.description), `${views.snapshot.description} / ${views.snapshot.rows.join(' | ')}`);
    check('sidebar: Data header shows R and I/O totals', /\d+ R · \d+ I\/O/.test(views.data.description), views.data.description);
    check('sidebar: Data rows name registers and I/O kinds (or robot groups)', (/Numeric registers/.test(rowText('data')) && /input|output/i.test(rowText('data'))) || (multiRobot && views.data.rows.length > 1), views.data.rows.slice(0, 6).join(' | '));
    check('sidebar: Macros lists GO TO HOME POS with its target (or robot groups)', /GO TO HOME POS — → \w+/.test(rowText('macros')) || (multiRobot && views.macros.rows.length > 1), views.macros.rows.slice(0, 4).join(' | '));
    check('sidebar: Macros header has a count', /^\d+/.test(views.macros.description), views.macros.description);
    check('sidebar: PC programs header is a count', /^\d+$/.test(views.pc.description), views.pc.description);
    const pcRows = rowText('pc');
    check('sidebar: PC programs rows say source or compiled', views.pc.rows.length === 0 || /source|compiled/.test(pcRows) || multiRobot, views.pc.rows.slice(0, 4).join(' | '));
    const noAmber = rowText('tp').includes('⚠');
    check('sidebar: no raw-token warning on the reference backup', !noAmber, [...views.tp.rows, ...views.snapshot.rows].filter(r => r.includes('⚠')).join(' | '));
  }
  const ctrlView = await vscode.commands.executeCommand('robotCode.live._viewState');
  check('sidebar: Controllers header summarises live count (or is empty with no robots)', !!ctrlView && (ctrlView.rows.length === 0 ? ctrlView.description === '' : /^\d+ of \d+ live/.test(ctrlView.description)), JSON.stringify(ctrlView));

  // ---- multi-robot scoping ----
  if (multiRobot) {
    const folder = path.dirname(lsUri.fsPath);
    await sleep(2500); // let the data store finish and diagnostics settle
    const dg = vscode.languages.getDiagnostics(doc.uri).filter(d => /tp\.commentMismatch|tp\.commentInconsistent/.test(String(d.code)));
    check('multi-robot: no comment-mismatch diagnostics on own robot', dg.length === 0, dg.map(d => d.message).slice(0, 3).join(' | '));
    const missing = vscode.languages.getDiagnostics(doc.uri).filter(d => /tp\.missingProgram/.test(String(d.code)));
    check('multi-robot: CALL targets in own folder are not flagged', missing.length === 0, missing.map(d => d.message).slice(0, 3).join(' | '));
    // a CALL in some program of this folder must resolve into the SAME folder
    let checked = false;
    for (const f of fs.readdirSync(folder).filter(x => /\.ls$/i.test(x))) {
      const t = fs.readFileSync(path.join(folder, f), 'latin1');
      // [ \t], not \s: in a CRLF file ^ also matches between \r and \n, and \s* would then start the match on the line above
      const m = /^([ \t]*\d+:[ \t]*CALL[ \t]+)([A-Z0-9_]+)/m.exec(t);
      if (!m) continue;
      if (!fs.existsSync(path.join(folder, m[2].toLowerCase() + '.ls'))) continue;
      const cdoc = await vscode.workspace.openTextDocument(path.join(folder, f));
      const lineNo = t.slice(0, m.index).split(/\r?\n/).length - 1;
      const col = cdoc.lineAt(lineNo).text.indexOf(m[2]) + 1;
      const defs = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', cdoc.uri, new vscode.Position(lineNo, col));
      const target = defs?.[0]?.uri?.fsPath ?? defs?.[0]?.targetUri?.fsPath;
      check(`multi-robot: CALL ${m[2]} in ${f} resolves inside the same robot folder`, target && path.dirname(target).toLowerCase() === folder.toLowerCase(), target);
      checked = true; break;
    }
    if (!checked) check('multi-robot: found a same-folder CALL to test', false, folder);
  }

  const text = doc.getText();
  const lines = text.split(/\r?\n/);

  // overview screenshot: Robot Code side bar + editor
  await vscode.commands.executeCommand('workbench.view.extension.robotCode');
  await sleep(500);
  editor.selection = new vscode.Selection(13, 0, 13, 0);
  editor.revealRange(new vscode.Range(0, 0, 40, 0), vscode.TextEditorRevealType.AtTop);
  await shot('overview-sidebar', 1500);

  // hover on R[151:...]
  const rLine = lines.findIndex(l => /R\[151:/.test(l));
  const rCol = lines[rLine].indexOf('R[151') + 1;
  const hov = hoverText(await vscode.commands.executeCommand('vscode.executeHoverProvider', doc.uri, new vscode.Position(rLine, rCol)));
  check('hover R[151] has register info', /R\[151\]/.test(hov) && /Numeric register/.test(hov), hov);
  check('hover R[151] shows controller comment from numreg.va', /Controller comment/.test(hov), hov);
  if (multiRobot) check('hover names the matching robot folder', /\(S002R01/.test(hov), hov);
  await vscode.commands.executeCommand('workbench.view.explorer');
  await vscode.commands.executeCommand('outline.focus');
  editor.selection = new vscode.Selection(rLine, rCol, rLine, rCol);
  editor.revealRange(new vscode.Range(rLine, 0, rLine, 0), vscode.TextEditorRevealType.InCenter);
  await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
  await vscode.commands.executeCommand('editor.action.showHover');
  await shot('hover-register');
  await vscode.commands.executeCommand('closeReferenceSearch').then(() => {}, () => {});

  // hover DI[25] shows I/O comment
  const diLine = lines.findIndex(l => /DI\[25/.test(l));
  const diText = hoverText(await vscode.commands.executeCommand('vscode.executeHoverProvider', doc.uri, new vscode.Position(diLine, lines[diLine].indexOf('DI[25') + 1)));
  check('hover DI[25] shows ZONE 1 CLR', /ZONE 1 CLR/.test(diText), diText);

  // hover on motion keyword
  const mLine = lines.findIndex(l => /^\s*\d+:J P\[/.test(l));
  if (mLine >= 0) {
    const mt = hoverText(await vscode.commands.executeCommand('vscode.executeHoverProvider', doc.uri, new vscode.Position(mLine, lines[mLine].indexOf(':J') + 1)));
    check('hover J shows Joint motion doc', /Joint motion/.test(mt), mt);
  }

  // definition: JMP LBL[10] → LBL[10]
  const jLine = lines.findIndex(l => /JMP LBL\[10\]/.test(l));
  const jCol = lines[jLine].indexOf('LBL[10]') + 4;
  const defs = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', doc.uri, new vscode.Position(jLine, jCol));
  const lblLine = lines.findIndex(l => /^\s*\d+:\s*LBL\[10\]/.test(l));
  check('definition JMP LBL[10] → label line', defs && defs.length === 1 && defs[0].range.start.line === lblLine, JSON.stringify(defs?.map(d => d.range.start.line)) + ' expected ' + lblLine);
  editor.selection = new vscode.Selection(jLine, jCol, jLine, jCol);
  editor.revealRange(new vscode.Range(jLine, 0, jLine, 0), vscode.TextEditorRevealType.InCenter);
  await vscode.commands.executeCommand('editor.action.peekDefinition');
  await shot('peek-label-definition', 1300);
  await vscode.commands.executeCommand('closeReferenceSearch').then(() => {}, () => {});

  // references on LBL[10]
  const refs = await vscode.commands.executeCommand('vscode.executeReferenceProvider', doc.uri, new vscode.Position(lblLine, lines[lblLine].indexOf('LBL[10]') + 2));
  check('references LBL[10] ≥ 3', refs && refs.length >= 3, refs?.length);

  // document symbols
  const syms = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', doc.uri);
  check('document symbols: header + main', syms && syms.some(s => s.name === 'ENTERZON') && syms.some(s => s.name === 'Main'), syms?.map(s => s.name).join(','));
  const main = syms?.find(s => s.name === 'Main');
  check('label regions in outline', main && main.children.some(c => /LBL\[10\]/.test(c.name)), main?.children.length);

  // completion after JMP LBL[
  const comp = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', doc.uri, new vscode.Position(jLine, jCol));
  check('label completion offers labels', comp && comp.items.some(i => labelOf(i) === '20'), comp?.items.length);

  // diagnostics clean
  await sleep(1200);
  const diags = vscode.languages.getDiagnostics(doc.uri);
  check('no errors on a clean controller program', !diags.some(d => d.severity === vscode.DiagnosticSeverity.Error), diags.filter(d => d.severity === 0).map(d => d.message).join(' | '));

  const lenses = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', doc.uri, 200);
  check('code lenses on labels', lenses && lenses.some(l => /jump/.test(l.command?.title ?? '')), lenses?.length);
  const folds = await vscode.commands.executeCommand('vscode.executeFoldingRangeProvider', doc.uri);
  check('folding ranges', folds && folds.length > 5, folds?.length);

  // ---- edited copy: renumber + diagnostics + completion screenshots ----
  const broken = text
    .replace(/^(\s*)5:/m, '$19999:')
    .replace(/\/POS/, [
      'IF R[151]=99,JMP LBL[777] ;',
      'LBL[10:duplicate] ;',
      'J P[99] 100% FINE ;',
      'IF (DI[25]=ON) THEN ;',
      'R[151]=R[151]+1 ;',
      'DO[900]=OFF ;',
      'DI[',
      '/POS',
    ].join('\n'));
  const udoc = await vscode.workspace.openTextDocument({ language: 'fanuc-tp', content: broken });
  const ued = await vscode.window.showTextDocument(udoc, { preview: false });
  await sleep(1500); // auto-renumber (debounced) + diagnostics
  await vscode.commands.executeCommand('robotCode.tp.renumber');
  await sleep(1500);
  const after = udoc.getText().split(/\r?\n/);
  const mnIdx = after.findIndex(l => l.startsWith('/MN'));
  const posIdx = after.findIndex(l => l.startsWith('/POS'));
  const numbered = after.slice(mnIdx + 1, posIdx).filter(l => /^\s*\d+:/.test(l));
  check('renumber fixed 9999', !after.some(l => /^\s*9999:/.test(l)), after.find(l => /9999/.test(l)));
  check('renumber numbered the new lines', /^\s*\d+:\s+LBL\[10:duplicate\] ;$/.test(after[posIdx - 6]), after[posIdx - 6]);
  check('renumber sequence intact', numbered.every((l, i) => parseInt(l, 10) === i + 1), numbered.slice(-3).join(' | '));
  check('LINE_COUNT updated', new RegExp(`LINE_COUNT\\s*=\\s*${numbered.length};`).test(udoc.getText()), after.find(l => /LINE_COUNT/.test(l)));
  const udiags = await waitFor(() => { const d = vscode.languages.getDiagnostics(udoc.uri); return d.length >= 4 ? d : undefined; }, 6000);
  const msgs = (udiags ?? []).map(d => d.message);
  check('diagnostic: undefined label', msgs.some(m => /LBL\[777\] is not defined/.test(m)), msgs.join(' | '));
  check('diagnostic: duplicate label', msgs.some(m => /Duplicate LBL\[10\]/.test(m)), msgs.join(' | '));
  check('diagnostic: untaught position', msgs.some(m => /P\[99\] has no data/.test(m)), msgs.join(' | '));
  check('diagnostic: unclosed IF', msgs.some(m => /IF block is never closed/.test(m)), msgs.join(' | '));
  await vscode.commands.executeCommand('workbench.actions.view.problems');
  ued.revealRange(new vscode.Range(posIdx - 8, 0, posIdx, 0), vscode.TextEditorRevealType.InCenter);
  await shot('diagnostics-problems', 1500);
  await vscode.commands.executeCommand('workbench.action.closePanel');

  // ---- pressing Enter scaffolds the new line ----
  // Reported by Sam: a new line stayed bare until you clicked away, because auto-renumber
  // skips the line the cursor is on so it does not fight you while typing. A BLANK cursor
  // line has nothing to fight over, and the scaffold is the whole point of being there.
  {
    const nlLines = udoc.getText().split(/\r?\n/);
    const nlMn = nlLines.findIndex(l => l.startsWith('/MN'));
    const nlTarget = nlLines.findIndex((l, i) => i > nlMn && /^\s*\d+:/.test(l));
    if (nlTarget >= 0) {
      const eol = new vscode.Position(nlTarget, udoc.lineAt(nlTarget).text.length);
      await ued.edit(b => b.insert(eol, '\n'));
      const fresh = new vscode.Position(nlTarget + 1, 0);
      ued.selection = new vscode.Selection(fresh, fresh);
      // Enter after a `!` comment keeps the next line a comment (beta list 2, item 9):
      // `   2:  ! ;` - after an instruction it is the bare `   2:   ;` scaffold. Either way the
      // line got its number and terminator.
      const afterComment = /^\s*\d+:\s*!/.test(udoc.lineAt(nlTarget).text);
      const got = await waitFor(() => {
        const t = udoc.lineAt(nlTarget + 1).text;
        return (afterComment ? /^\s*\d+:\s*!\s*;\s*$/ : /^\s*\d+:\s*;\s*$/).test(t) ? t : undefined;
      }, 6000, 200);
      check('newline gets its line number and terminator', !!got, JSON.stringify(udoc.lineAt(nlTarget + 1).text) + (afterComment ? ' (after a ! comment: continued as a comment)' : ''));
      // The caret must also end up INSIDE the line body - at column 0 the next keystroke
      // would land in front of the number that was just inserted.
      const col = ued.selection.active.character;
      check('newline leaves the caret in the line body',
        ued.selection.active.line === nlTarget + 1 && col > (got ?? '').indexOf(':'),
        `line ${ued.selection.active.line}, col ${col}`);

      // Put the document back. Later checks index into the snapshot taken before this
      // block ran, and an extra line silently shifts every one of them - which is how
      // this test first showed up as a failure somewhere else entirely.
      await ued.edit(b => b.delete(new vscode.Range(nlTarget + 1, 0, nlTarget + 2, 0)));
      await sleep(800); // let auto-renumber settle back
    }
  }

  // completion inside DI[
  const diIdx = after.findIndex((l, i) => i > mnIdx && /DI\[\s*;?\s*$/.test(l));
  if (diIdx >= 0) {
    const col = after[diIdx].indexOf('DI[') + 3;
    const ioComp = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', udoc.uri, new vscode.Position(diIdx, col));
    check('I/O completion lists controller comments', ioComp && ioComp.items.some(i => /ZONE 1 CLR/.test(labelOf(i))), ioComp?.items.length);
    ued.selection = new vscode.Selection(diIdx, col, diIdx, col);
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    await vscode.commands.executeCommand('editor.action.triggerSuggest');
    await shot('completion-io', 1300);
    await vscode.commands.executeCommand('hideSuggestWidget');
  } else check('DI[ line present after renumber', false, after.slice(posIdx - 3, posIdx).join(' | '));

  // snippets and instruction completions at the start of an instruction body ("IF|")
  if (diIdx >= 0) {
    const bodyCol = after[diIdx].search(/DI\[/);
    await ued.edit(b => b.insert(new vscode.Position(diIdx, bodyCol), 'IF'));
    const ifComp = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', udoc.uri, new vscode.Position(diIdx, bodyCol + 2));
    const items = ifComp?.items ?? [];
    check('typing IF offers the IF () THEN instruction', items.some(i => /^IF \(\) THEN/.test(labelOf(i))), items.length);
    check('typing IF offers the IF…ENDIF snippets', items.some(i => i.kind === vscode.CompletionItemKind.Snippet && /ENDIF/.test(typeof i.insertText === 'string' ? i.insertText : i.insertText?.value ?? '')), items.filter(i => i.kind === vscode.CompletionItemKind.Snippet).map(labelOf).join(','));
    await ued.edit(b => b.delete(new vscode.Range(diIdx, bodyCol, diIdx, bodyCol + 2)));
    await sleep(500);

    // typing PR and taking the top entry used to write `PR[1,1]=0` (label order: , before ])
    await ued.edit(b => b.insert(new vscode.Position(diIdx, bodyCol), 'PR'));
    const prComp = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', udoc.uri, new vscode.Position(diIdx, bodyCol + 2));
    const prItems = (prComp?.items ?? []).filter(i => /^PR\[/.test(labelOf(i)) && i.kind === vscode.CompletionItemKind.Keyword).sort((a, b) => (a.sortText ?? labelOf(a)).localeCompare(b.sortText ?? labelOf(b)));
    check('typing PR offers PR[] first, the element assignment last', labelOf(prItems[0] ?? {}) === 'PR[]' && labelOf(prItems[prItems.length - 1] ?? {}) === 'PR[,]=', prItems.map(labelOf).join(' | '));
    await ued.edit(b => b.delete(new vscode.Range(diIdx, bodyCol, diIdx, bodyCol + 2)));
    await sleep(500);
  }

  // 2026-10-03: a double ";" is an error (the controller refuses the program, ASBN-031); CALL / RUN
  // pick the program from a searchable list that includes what options install; "macro" lists macros
  {
    const src = ['/PROG  TESTCALL', '/ATTR', 'OWNER\t\t= MNEDITOR;', 'LINE_COUNT\t= 3;', '/MN', '   1:  R[1]=1 ; ;', '   2:  CALL  ;', '   3:  CA ;', '/POS', '/END', ''].join('\n');
    const cdoc = await vscode.workspace.openTextDocument({ language: 'fanuc-tp', content: src });
    const dbl = await waitFor(() => vscode.languages.getDiagnostics(cdoc.uri).find(d => d.code === 'tp.doubleTerminator'), 6000);
    check('double ";" at the end of a line is an error', dbl && dbl.severity === vscode.DiagnosticSeverity.Error && dbl.range.start.line === 5, dbl?.message);
    if (dbl) {
      const acts = await vscode.commands.executeCommand('vscode.executeCodeActionProvider', cdoc.uri, dbl.range);
      const keep = (acts ?? []).find(a => a.title === 'Keep one " ;"');
      check('... with a quick fix that keeps one', !!keep?.edit, (acts ?? []).map(a => a.title).join(' | '));
      if (keep?.edit) { await vscode.workspace.applyEdit(keep.edit); check('... which leaves "R[1]=1 ;"', cdoc.lineAt(5).text === '   1:  R[1]=1 ;', cdoc.lineAt(5).text); }
    }
    // the CALL entry inserts "CALL " and opens the list at once (no PROGRAM placeholder to type over)
    const caComp = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', cdoc.uri, new vscode.Position(7, 9));
    const callIt = (caComp?.items ?? []).find(i => labelOf(i) === 'CALL');
    const callText = typeof callIt?.insertText === 'string' ? callIt.insertText : callIt?.insertText?.value;
    check('the CALL entry writes "CALL " and opens the program list', callText === 'CALL ' && callIt?.command?.command === 'editor.action.triggerSuggest', `${JSON.stringify(callText)} ${callIt?.command?.command}`);
    // after "CALL ": the workspace's programs first, then the programs options install, searchable
    const progComp = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', cdoc.uri, new vscode.Position(6, 12));
    const progs = progComp?.items ?? [];
    const fanuc = progs.filter(i => /^FANUC/.test(typeof i.label === 'string' ? '' : i.label.description ?? ''));
    check('after CALL: workspace programs are offered', progs.some(i => i.kind === vscode.CompletionItemKind.Module), progs.length);
    const dupes = progs.filter(i => i.kind !== vscode.CompletionItemKind.Snippet).map(labelOf).filter((n, i, a) => a.indexOf(n) !== i);
    check('after CALL: each program once, however many backups hold it', dupes.length === 0, dupes.slice(0, 5).join(' '));
    // an untitled program has no robot and no backup folder: its options are unknown, so only the
    // programs every controller has; fanucPrograms = all offers the whole catalog
    check('after CALL: FANUC programs below them, only the option-free ones when the options are unknown', fanuc.length > 0 && fanuc.every(i => (i.sortText ?? '').startsWith('1') && i.label.description === 'FANUC'), fanuc.length);
    await robotCfg().update('tp.completion.fanucPrograms', 'all', vscode.ConfigurationTarget.Global);
    const allComp = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', cdoc.uri, new vscode.Position(6, 12));
    const allFanuc = (allComp?.items ?? []).filter(i => /^FANUC/.test(typeof i.label === 'string' ? '' : i.label.description ?? ''));
    await robotCfg().update('tp.completion.fanucPrograms', undefined, vscode.ConfigurationTarget.Global);
    check('... and fanucPrograms = all offers every program options install', allFanuc.length > 50 && allFanuc.length > fanuc.length, allFanuc.length);
    // "macro" at the start of a line: an entry that turns the next list into macros only
    const mComp = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', cdoc.uri, new vscode.Position(7, 9));
    const pick = (mComp?.items ?? []).find(i => labelOf(i) === 'Macro…');
    check('"Macro…" is offered at the start of a line', pick?.command?.command === 'robotCode.tp._suggestMacros', pick?.command?.command);
    await vscode.commands.executeCommand('robotCode.tp._suggestMacros', ...(pick?.command?.arguments ?? []));
    // (VS Code adds the extension's snippets to every list; they are not this provider's)
    const macros = ((await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', cdoc.uri, new vscode.Position(7, 9)))?.items ?? []).filter(i => i.kind !== vscode.CompletionItemKind.Snippet);
    check('... and the next list is macros only, the option macros as the manuals spell them', macros.length > 10 && macros.every(i => i.kind === vscode.CompletionItemKind.Event) && macros.some(i => /^Prompt Box/i.test(labelOf(i))), `${macros.length} items, ${macros.filter(i => i.kind !== vscode.CompletionItemKind.Event).length} not macros, prompt: ${macros.filter(i => /prompt/i.test(labelOf(i))).map(labelOf).join('|')}; non-macro: ${macros.filter(i => i.kind !== vscode.CompletionItemKind.Event).slice(0, 3).map(labelOf).join(', ')}`);
  }

  // KAREL tabs: ROBOGUIDE puts real tabs in, drawn 7 wide; a file mixing tabs and spaces is shown at
  // the width it was written with
  {
    const rg = await vscode.workspace.openTextDocument({ language: 'fanuc-karel', content: 'PROGRAM rg\nBEGIN\n\tIF TRUE THEN\n\t\tDELAY 10\n\tENDIF\nEND rg\n' });
    // beside, keeping focus: the TP editor the later checks use must stay open and active
    const rged = await vscode.window.showTextDocument(rg, { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true });
    await sleep(400);
    check('KAREL: a tab-indented file uses ROBOGUIDE\'s layout (real tabs, 7 wide)', rged.options.insertSpaces === false && rged.options.tabSize === 7, `${rged.options.insertSpaces} ${rged.options.tabSize}`);
    const four = ['PROGRAM four', 'BEGIN', '\tx = 1', '    y = 2', '\tz = 3', '    w = 4', '\tv = 5', 'END four', ''].join('\n');
    const fd = await vscode.workspace.openTextDocument({ language: 'fanuc-karel', content: four });
    const fed = await vscode.window.showTextDocument(fd, { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true });
    const fourWide = await waitFor(() => fed.options.tabSize === 4 ? true : undefined, 3000);
    check('KAREL: a file mixing tabs with 4-space lines is shown at tab width 4', !!fourWide, fed.options.tabSize);
  }

  // Enter between a bracket pair (VS Code inserts "\n<indent>\n") must not strand "]=ON ;" below
  {
    const at = mnIdx + 1;
    await ued.edit(b => b.insert(new vscode.Position(at, 0), '  99:  WAIT DI[]=ON ;\n'));
    await sleep(900);
    const idx = [...Array(udoc.lineCount).keys()].find(i => /WAIT DI\[\]=ON ;/.test(udoc.lineAt(i).text));
    if (idx === undefined) check('bracket-split fixture line present', false);
    else {
      const col = udoc.lineAt(idx).text.indexOf('DI[') + 3;
      ued.selection = new vscode.Selection(idx, col, idx, col);
      await ued.edit(b => b.insert(new vscode.Position(idx, col), '\n    \n'));
      await sleep(900);
      const l0 = udoc.lineAt(idx).text, l1 = udoc.lineAt(idx + 1).text;
      check('Enter inside DI[] puts the instruction back together', /WAIT DI\[\]=ON ;$/.test(l0), l0);
      check('...and scaffolds a fresh numbered line below', /^\s*\d+:\s*;\s*$/.test(l1), JSON.stringify(l1));
      await ued.edit(b => b.delete(new vscode.Range(idx, 0, idx + 2, 0)));
      await sleep(800);
    }
  }

  // ---- call graph on the program with the most CALLs ----
  const allLs = await vscode.workspace.findFiles('**/*.ls', undefined, 500);
  let best = { uri: lsUri, n: 0 };
  for (const u of allLs) {
    const t = fs.readFileSync(u.fsPath, 'utf8');
    if (!/^\/PROG/m.test(t)) continue;
    const n = new Set([...t.matchAll(/^\s*\d+:\s*(?:CALL|RUN)\s+([A-Za-z0-9_]+)/gm)].map(m => m[1])).size;
    if (n > best.n) best = { uri: u, n };
  }
  check('found a program with CALLs', best.n > 0, `${path.basename(best.uri.fsPath)} calls ${best.n}`);
  await vscode.window.showTextDocument(best.uri, { preview: false, viewColumn: vscode.ViewColumn.One });
  await vscode.commands.executeCommand('robotCode.tp.showCallGraph', best.uri);
  await shot('call-graph', 2000);
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');

  // ---- register table ----
  await vscode.commands.executeCommand('robotCode.data.openRegisterTable');
  await shot('register-table', 2000);
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');

  // ---- KAREL ----
  const sample = process.env.ROBOT_CODE_KAREL_SAMPLE;
  const kdoc = sample && fs.existsSync(sample)
    ? await vscode.workspace.openTextDocument(vscode.Uri.file(sample))
    : await vscode.workspace.openTextDocument({ language: 'fanuc-karel', content: 'PROGRAM demo\nVAR\n  n : INTEGER\nBEGIN\n  n = STR_LEN(\'abc\')\nEND demo\n' });
  const ked = await vscode.window.showTextDocument(kdoc, { preview: false, viewColumn: vscode.ViewColumn.One });
  check('language id fanuc-karel', kdoc.languageId === 'fanuc-karel', kdoc.languageId);
  const ktext = kdoc.getText().split(/\r?\n/);
  let kLine = ktext.findIndex(l => /\b(GET_VAR|SET_VAR|CNV_INT_STR|STR_LEN|GET_REG|SET_INT_REG|POST_ERR|SQRT|FRAME|ABS|INV|ATAN2|CURPOS|CURJPOS)\s*\(/.test(l) && !/^\s*--/.test(l));
  if (kLine < 0) kLine = 4;
  const kName = /\b(GET_VAR|SET_VAR|CNV_INT_STR|STR_LEN|GET_REG|SET_INT_REG|POST_ERR|SQRT|FRAME|ABS|INV|ATAN2|CURPOS|CURJPOS)\s*\(/.exec(ktext[kLine]);
  const kCol = kName ? ktext[kLine].indexOf(kName[1]) + 2 : 8;
  const kt = hoverText(await vscode.commands.executeCommand('vscode.executeHoverProvider', kdoc.uri, new vscode.Position(kLine, kCol)));
  // the built-in hover (beta list 2, item 11): a title naming what it is, then the signature as
  // a code block - not the one-line signature-plus-text it used to be
  check('karel hover on builtin', /built-in (routine|function)|KAREL statement/.test(kt) && /```karel/.test(kt), kt);
  const ksyms = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', kdoc.uri);
  check('karel document symbols', Array.isArray(ksyms) && ksyms.length > 0, ksyms?.map(s => s.name).slice(0, 8).join(','));
  await vscode.commands.executeCommand('workbench.view.explorer');
  await vscode.commands.executeCommand('outline.focus');
  ked.selection = new vscode.Selection(kLine, kCol, kLine, kCol);
  ked.revealRange(new vscode.Range(kLine, 0, kLine, 0), vscode.TextEditorRevealType.InCenter);
  await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
  await vscode.commands.executeCommand('editor.action.showHover');
  await shot('karel-hover-outline', 1300);

  // signature help on a builtin
  const sigLine = ktext.findIndex(l => /\b[A-Z_]+\(/.test(l) && !/^\s*--/.test(l) && /,/.test(l));
  if (sigLine >= 0) {
    const sigCol = ktext[sigLine].indexOf('(') + 1;
    const sig = await vscode.commands.executeCommand('vscode.executeSignatureHelpProvider', kdoc.uri, new vscode.Position(sigLine, sigCol), '(');
    check('karel signature help', !sig || sig.signatures.length >= 0, sig?.signatures?.[0]?.label);
  }

  // ---- live tier against the mock controller ----
  const mockName = process.env.ROBOT_CODE_MOCK_ROBOT;
  if (mockName) {
    // The sync commands are container-first (issue #12): give the workspace a robot container
    // for the mock so Fetch/Pull/Push have a snapshot to work against.
    const markerDir = path.join(ws, '.robocode-robot');
    fs.mkdirSync(markerDir, { recursive: true });
    fs.writeFileSync(path.join(markerDir, 'robot.json'), JSON.stringify({ name: mockName }) + '\n');
    fs.writeFileSync(path.join(markerDir, '.gitignore'), 'snapshot/\nsnapshot.json\nsnapshot-history/\n');
    await sleep(2000);   // let the container index rescan
    // Connecting must prove the controller answers and read NOTHING else: no .DG file
    // is generated, no register dump is pulled, until a Get command asks for it.
    const connected = await waitFor(async () => {
      const st = await vscode.commands.executeCommand('robotCode.live._state');
      const r = st?.find(x => x.name === mockName);
      return r && r.state === 'connected' ? r : undefined;
    }, 20000, 500);
    check('live: connected to mock robot', !!connected, JSON.stringify((await vscode.commands.executeCommand('robotCode.live._state'))?.[0]?.error));
    const ctrlLive = await vscode.commands.executeCommand('robotCode.live._viewState');
    check('sidebar: Controllers header says "1 of N live" once connected', !!ctrlLive && /^1 of \d+ live/.test(ctrlLive.description), JSON.stringify(ctrlLive));
    check('sidebar: the connected controller row carries the IP and says connected', !!ctrlLive && ctrlLive.rows.some(r => new RegExp(`^${mockName} — .*127\\.0\\.0\\.1.*connected`).test(r)), JSON.stringify(ctrlLive?.rows));
    // Connect pulls the set fetchOnConnect names - registers, I/O and the listing, the
    // things the EDITOR itself needs - once each, and nothing else.
    const loaded = await waitFor(async () => {
      const st = await vscode.commands.executeCommand('robotCode.live._state');
      const r = st?.find(x => x.name === mockName);
      return r && r.numregs > 0 && r.io > 0 ? r : undefined;
    }, 20000, 300);
    check('live: connect fetches the on-connect set', !!loaded, JSON.stringify(connected?.fetched));
    check('live: connect does NOT fetch position or program state',
      !!loaded && loaded.fetched?.position === undefined && loaded.fetched?.tasks === undefined,
      JSON.stringify(loaded?.fetched));

    // ---- what actually reached the controller ----
    // Measured at the mock, not from the extension's own bookkeeping.
    const afterConnect = await mockRequests();
    const connectPaths = afterConnect.map(r => r.path);
    check('traffic: connect reads CURPOS/PRGSTATE not at all',
      !connectPaths.some(pth => /(CURPOS|PRGSTATE)\.DG$/i.test(pth)),
      JSON.stringify(connectPaths.filter(pth => /\.DG$/i.test(pth))));
    check('traffic: connect reads each register file exactly once',
      ['NUMREG.VA', 'STRREG.VA', 'POSREG.VA'].every(f => connectPaths.filter(pth => pth.toUpperCase().endsWith(f)).length === 1),
      JSON.stringify(connectPaths));
    check('live: auto-refresh off by default', connected?.autoRefresh === false, connected?.autoRefresh);

    // THE ONE THAT MATTERS: connected, and nobody touching anything. A reintroduced poll
    // shows up here as requests arriving on their own, which is precisely the regression
    // this whole version exists to prevent.
    const idleMark = afterConnect.length;
    await sleep(20000);
    const idlePaths = since(await mockRequests(), idleMark);
    check('traffic: NO requests at all while connected and idle (20 s)',
      idlePaths.length === 0,
      `${idlePaths.length} unasked-for request(s): ${JSON.stringify(idlePaths.slice(0, 12))}`);

    // A single Get pulls exactly one unit - position, and nothing else.
    const posMark = (await mockRequests()).length;
    await vscode.commands.executeCommand('robotCode.live.getPosition', mockName);
    const posPaths = since(await mockRequests(), posMark);
    check('traffic: Get position is exactly one request for CURPOS.DG',
      posPaths.length === 1 && /CURPOS\.DG$/i.test(posPaths[0]),
      JSON.stringify(posPaths));

    const afterOne = (await vscode.commands.executeCommand('robotCode.live._state'))?.find(x => x.name === mockName);
    check('live: Get position fetches position', !!afterOne?.position, JSON.stringify(afterOne?.fetched));
    // Registers are already loaded by the on-connect set; what matters is that asking for
    // position did not go and re-read them. The traffic check above is the proof - this one
    // says the same thing from the snapshot's side.
    check('live: Get position re-read nothing else',
      afterOne?.fetched?.numregs === loaded?.fetched?.numregs && afterOne?.fetched?.io === loaded?.fetched?.io,
      `numregs ${loaded?.fetched?.numregs} -> ${afterOne?.fetched?.numregs}`);

    // Now read everything, which is what the rest of the live checks need.
    await vscode.commands.executeCommand('robotCode.live.getAll', mockName);
    const state = await waitFor(async () => {
      const st = await vscode.commands.executeCommand('robotCode.live._state');
      const r = st?.find(x => x.name === mockName);
      return r && r.numregs > 0 && r.tasks?.length ? r : undefined;
    }, 20000, 500);
    check('live: Read everything populates the snapshot', !!state, JSON.stringify(state?.errors));
    if (state) {
      check('live: controller info parsed', state.info?.fNumber === 'F368808' && /V9\.40/.test(state.info?.version ?? ''), JSON.stringify(state.info));
      check('live: running TP task ENTERZON', state.tasks.some(t => t.status === 'RUNNING' && t.current?.program === 'ENTERZON'), JSON.stringify(state.tasks[0]));
      check('live: R[151] value', state.live_R151 && /^\d+$/.test(state.live_R151.text), JSON.stringify(state.live_R151));
      check('live: DI[25] state', state.live_DI25?.text === 'OFF', JSON.stringify(state.live_DI25));
      check('live: position parsed', state.position?.joint?.joints?.length === 6, JSON.stringify(state.position?.joint));
      check('live: I/O points', state.io > 3000, state.io);
      check('live: every unit stamped with a fetch time', ['position', 'tasks', 'numregs', 'io'].every(k => typeof state.fetched?.[k] === 'number'), JSON.stringify(state.fetched));

      // The traffic meter in the Robots view reads these. They have to agree with the
      // mock's log, or the number shown to the user is decoration rather than a measurement.
      const wire = await mockRequests();
      check('traffic: the meter counts every request that reached the robot',
        state.traffic?.requests > 0 && state.traffic.requests <= wire.length,
        `meter ${state.traffic?.requests} vs wire ${wire.length}`);
      check('traffic: the meter counts bytes', state.traffic?.bytes > 0, state.traffic?.bytes);
      // hover shows live value
      await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.One });
      const lhov = hoverText(await vscode.commands.executeCommand('vscode.executeHoverProvider', doc.uri, new vscode.Position(rLine, rCol)));
      check('live: hover shows the value and its age', /Read from MOCK/.test(lhov) && /ago/.test(lhov), lhov);
      // Values are drawn as text decorations, which the extension-host API cannot read
      // back, so assert the contract those decorations consume: a value, and an age
      // fresh enough not to be dimmed as stale.
      check('live: value available to draw with a fresh age', !!state.live_R151 && state.live_R151.age >= 0 && state.live_R151.age < 60000, JSON.stringify(state.live_R151));
      check('live: I/O value carries the robot it came from', state.live_DI25?.robot === mockName, JSON.stringify(state.live_DI25));
      // fanuc:// file system
      const rdoc = await vscode.workspace.openTextDocument(vscode.Uri.parse(`fanuc://${mockName}/MD/CURPOS.DG`));
      check('live: fanuc:// read', /CURRENT JOINT POSITION/.test(rdoc.getText()), rdoc.getText().slice(0, 60));

      // A program opened off the robot resolves its CALLs against the robot's own device,
      // not against a folder on disk: the target is there, so it is found, not "missing".
      // Pick the program from the LOCAL copies (no requests), then open that one off the robot.
      const device = await vscode.workspace.fs.readDirectory(vscode.Uri.parse(`fanuc://${mockName}/MD`));
      const onDevice = new Set(device.map(([n]) => n.toUpperCase()));
      let remoteName;
      for (const u of await vscode.workspace.findFiles('**/*.ls', undefined, 300)) {
        const nm = path.basename(u.fsPath).toUpperCase();
        if (!onDevice.has(nm)) continue;
        const txt = Buffer.from(await vscode.workspace.fs.readFile(u)).toString('latin1');
        if (txt.split(/\r?\n/).some(l => { const m = /^\s*\d+:\s*CALL\s+([A-Z0-9_]+)/i.exec(l); return m && onDevice.has(`${m[1].toUpperCase()}.LS`); })) { remoteName = nm; break; }
      }
      const remoteProg = await vscode.workspace.openTextDocument(vscode.Uri.parse(`fanuc://${mockName}/MD/${remoteName ?? 'ENTERZON.LS'}`));
      await vscode.window.showTextDocument(remoteProg, { preview: true });
      check('live: robot program opens as fanuc-tp', remoteProg.languageId === 'fanuc-tp', remoteProg.languageId);
      const rlines = remoteProg.getText().split(/\r?\n/);
      const callLine = rlines.findIndex(l => { const m = /^\s*\d+:\s*CALL\s+([A-Z0-9_]+)/i.exec(l); return m && onDevice.has(`${m[1].toUpperCase()}.LS`); });
      if (callLine >= 0) {
        const callee = /^\s*\d+:\s*CALL\s+([A-Z0-9_]+)/i.exec(rlines[callLine])[1];
        const col = rlines[callLine].indexOf(callee) + 1;
        const rdefs = await waitFor(async () => { const d = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', remoteProg.uri, new vscode.Position(callLine, col)); return d && d.length ? d : undefined; }, 8000, 500);
        check(`live: CALL ${callee} in a robot file resolves on the robot`, !!rdefs && String(rdefs[0].uri ?? rdefs[0].targetUri).startsWith(`fanuc://`), JSON.stringify(rdefs?.map(d => String(d.uri ?? d.targetUri))));
        await sleep(1500);   // diagnostics are debounced
        const rdiags = vscode.languages.getDiagnostics(remoteProg.uri);
        check('live: no "missing program" squiggle on a CALL the robot has', !(rdiags ?? []).some(d => d.code === 'tp.missingProgram' && new RegExp(`"${callee}"`).test(d.message)), JSON.stringify((rdiags ?? []).filter(d => d.code === 'tp.missingProgram').map(d => d.message)));
      } else check('live: a robot program with a CALL to a program on the device', false, `none found (${remoteName ?? 'no candidate'})`);
      // back to the local file, so the checks that follow see the workspace's robot as active
      await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.One });
      // Robots view + running line screenshot: reveal TP line 44 in enterzon
      const tpEd = await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.One });
      const l44 = lines.findIndex(l => /^\s*44:/.test(l));
      tpEd.selection = new vscode.Selection(l44, 0, l44, 0);
      tpEd.revealRange(new vscode.Range(l44, 0, l44, 0), vscode.TextEditorRevealType.InCenter);
      await vscode.commands.executeCommand('robotCode.robots.focus');
      await sleep(1500);
      await shot('live-robots-view-running-line', 2500);
      // Fetch: one read of the open program into the snapshot, and nothing else. The mock
      // serves the workspace's own files back byte for byte, so this takes the "unchanged"
      // path. Fetch never overwrites the working copy.
      const freshMark = (await mockRequests()).length;
      await vscode.commands.executeCommand('robotCode.sync.fetchFile', doc.uri);
      const freshPaths = since(await mockRequests(), freshMark);
      // (26.91.24012+: a fetch also pulls the compiled partner, .LS -> .TP, so the pair stays together)
      check('traffic: Fetch reads the open program exactly once (and its compiled partner)',
        freshPaths.filter(p => /ENTERZON\.LS$/i.test(p)).length === 1
          && freshPaths.every(p => /ENTERZON\.(LS|TP)$/i.test(p)) && freshPaths.length <= 2,
        JSON.stringify(freshPaths));
      check('live: Fetch writes the snapshot and never a .robot-history folder',
        fs.existsSync(path.join(ws, '.robocode-robot', 'snapshot', 'ENTERZON.LS')) && !fs.existsSync(path.join(ws, '.robot-history')),
        `${path.join(ws, '.robocode-robot', 'snapshot')} / ${path.join(ws, '.robot-history')}`);

      // diff against robot copy
      await vscode.commands.executeCommand('vscode.diff', vscode.Uri.parse(`fanuc://${mockName}/MD/ENTERZON.LS`), doc.uri, 'ENTERZON: MOCK ⟷ local');
      await shot('live-compare-with-robot', 2000);
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');

      // ---- teaching: the frame guard, against a real CURPOS.DG rather than a fixture ----
      //
      // The teach flow itself stops on a confirmation, so what runs here is the hidden
      // plan dump - the same code path up to the point of asking. The property worth
      // proving on real controller data is the refusal: the mock reports the robot
      // active in frame 1 / tool 1, and dcs_check.ls happens to hold points taught both
      // in another frame and in the one the robot is standing in.
      const dcsUri = (await vscode.workspace.findFiles('**/dcs_check.ls', undefined, 1))[0];
      check('teach: found a program with taught positions', !!dcsUri, dcsUri?.fsPath);
      if (dcsUri) {
        const dcsDoc = await vscode.workspace.openTextDocument(dcsUri);
        await vscode.window.showTextDocument(dcsDoc, { preview: false, viewColumn: vscode.ViewColumn.One });

        // P[1] is taught UF 11 / UT 2. The robot is in UF 1 / UT 1: different spaces.
        const refused = await vscode.commands.executeCommand('robotCode.tp._teachPlan', 1);
        check('teach: a reading from another user frame is refused',
          !!refused?.blockers?.some(b => /user frame 1;/.test(b)), JSON.stringify(refused?.blockers));
        check('teach: a reading with another tool frame is refused',
          !!refused?.blockers?.some(b => /tool frame 1;/.test(b)), JSON.stringify(refused?.blockers));
        check('teach: the refusal reports the frames the point itself carries',
          refused?.target?.uf === 11 && refused?.target?.ut === 2, JSON.stringify(refused?.target));

        // P[3] is taught UF 0 / UT 1 - world frame, tool 1 - which is where the robot is.
        const allowed = await vscode.commands.executeCommand('robotCode.tp._teachPlan', 3);
        check('teach: a reading taken in the frame the point uses is accepted',
          !!allowed && allowed.blockers.length === 0 && allowed.edits > 0,
          JSON.stringify({ blockers: allowed?.blockers, edits: allowed?.edits }));
        check('teach: a UF 0 point is taught from the WORLD reading, not the user-frame one',
          allowed?.source?.uf === 0 && Math.abs((allowed?.source?.values?.X ?? 0) - -156.83) < 1e-9,
          JSON.stringify(allowed?.source?.values));
        check('teach: every axis the point stores is accounted for, extended axis included',
          ['X', 'Y', 'Z', 'W', 'P', 'R', 'E1'].every(a => allowed?.target?.axes?.includes(a)),
          JSON.stringify(allowed?.target?.axes));
        check('teach: planning changes nothing on disk until it is applied',
          !dcsDoc.isDirty && fs.readFileSync(dcsUri.fsPath, 'latin1').includes('X =   557.424  mm'),
          `dirty=${dcsDoc.isDirty}`);
        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
      }
    }
    // The container above is the test's own: left behind, it turns the reference backup into a
    // robot container and the next run's data views come up empty. Only a marker naming the mock goes.
    try {
      const marker = JSON.parse(fs.readFileSync(path.join(markerDir, 'robot.json'), 'utf8'));
      if (marker.name === mockName) fs.rmSync(markerDir, { recursive: true, force: true });
    } catch { /* not ours, or already gone */ }
  }

  // ---- analysis tools ----
  {
    const backupDir = path.dirname(lsUri.fsPath);
    const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'rc-int-'));
    for (const f of fs.readdirSync(backupDir)) if (/\.(ls|va)$/i.test(f)) fs.copyFileSync(path.join(backupDir, f), path.join(tmp, f));
    const dcs = path.join(tmp, 'dcs_check.ls');
    fs.writeFileSync(dcs, fs.readFileSync(dcs, 'latin1').replace(/X =\s+2220\.302/, 'X =  2235.302').replace(/Z =\s+483\.831/, 'Z =   480.000'), 'latin1');
    const ez = path.join(tmp, 'enterzon.ls');
    fs.writeFileSync(ez, fs.readFileSync(ez, 'latin1').replace('WAIT DI[25:ZONE 1 CLR]=OFF', 'WAIT DI[25:ZONE 1 CLR]=OFF TIMEOUT,LBL[220]'), 'latin1');
    const nr = path.join(tmp, 'numreg.va');
    fs.writeFileSync(nr, fs.readFileSync(nr, 'latin1').replace(/^(\s*\[15\]\s*=\s*)30000/m, '$160000').replace(/^(\s*\[3\]\s*=\s*\S+\s*')Weld Retries'/m, "$1Weld Retry Max'"), 'latin1');
    await vscode.commands.executeCommand('robotCode.tools.diffBackups', vscode.Uri.file(backupDir), vscode.Uri.file(tmp));
    await sleep(1500);
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    check('tools: backup diff panel opened', /Backup diff/.test(tab?.label ?? ''), tab?.label);
    await shot('tools-backup-diff', 1500);
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    fs.rmSync(tmp, { recursive: true, force: true });

    await vscode.commands.executeCommand('robotCode.tools.xrefReport');
    await sleep(2500);
    // any tab group: the panel opens beside whatever column was active, which after the
    // robot-file checks above may not be the one the active tab is read from
    const allTabs = () => vscode.window.tabGroups.all.flatMap(g => g.tabs.map(t => t.label));
    const xrefTab = await waitFor(async () => (allTabs().find(l => /cross-reference/i.test(l)) ? true : undefined), 6000, 300);
    check('tools: cross-reference panel opened', !!xrefTab, JSON.stringify(allTabs()));
    await shot('tools-xref-report', 1500);
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  }

  // ---- commands exist ----
  const cmds = await vscode.commands.getCommands(true);
  for (const c of ['robotCode.tp.renumber', 'robotCode.tp.showCallGraph', 'robotCode.karel.compile', 'robotCode.data.openRegisterTable', 'robotCode.data.refresh', 'robotCode.tp.gotoLabel']) check(`command registered: ${c}`, cmds.includes(c));
  for (const c of ['robotCode.live.getInfo', 'robotCode.live.getPosition', 'robotCode.live.getTasks', 'robotCode.live.getRegisters', 'robotCode.live.getIo', 'robotCode.live.getAll', 'robotCode.live.toggleAutoRefresh']) check(`command registered: ${c}`, cmds.includes(c));
  // ---- one language per file type (each carries its own Explorer icon) ----
  // .va .dt .dg .io used to share fanuc-va, and .cm .cf shared fanuc-cm. They were split so every
  // file type can have an icon of its own; what must NOT have changed is that each still opens
  // as a FANUC language, highlighted, with the $ system-variable hover where it had one.
  {
    const known = await vscode.languages.getLanguages();
    for (const id of ['fanuc-tp', 'fanuc-karel', 'fanuc-va', 'fanuc-dt', 'fanuc-dg', 'fanuc-io', 'fanuc-cm', 'fanuc-cf', 'fanuc-tp-binary', 'fanuc-pc', 'fanuc-vr', 'fanuc-sv',
      'fanuc-df', 'fanuc-vd', 'fanuc-vda', 'fanuc-cam', 'fanuc-pmc', 'fanuc-stm', 'fanuc-utx', 'fanuc-ftx']) check(`language registered: ${id}`, known.includes(id));
    for (const [ext, want] of [['va', 'fanuc-va'], ['dt', 'fanuc-dt'], ['dg', 'fanuc-dg'], ['cm', 'fanuc-cm'], ['ls', 'fanuc-tp']]) {
      const found = await vscode.workspace.findFiles(`**/*.{${ext},${ext.toUpperCase()}}`, null, 1);
      if (!found.length) { check(`a .${ext} file opens as ${want}`, true, 'no such file in this workspace - skipped'); continue; }
      const d = await vscode.workspace.openTextDocument(found[0]);
      check(`a .${ext} file opens as ${want}`, d.languageId === want, `${path.basename(found[0].fsPath)} -> ${d.languageId}`);
    }
    // the hover the old shared id provided must reach a split one: a $ variable in a .va dump
    // Any .va will do - not every backup carries sysvars.va - and never skip quietly: a check
    // that did not run must say so, or "147 passed" means less than it looks.
    let hovered = 0, tried = [];
    for (const u of await vscode.workspace.findFiles('**/*.{va,VA}', null, 40)) {
      const d = await vscode.workspace.openTextDocument(u);
      const lines = d.getText().split(/\r?\n/);
      const li = lines.findIndex(l => /\$[A-Z_][A-Z0-9_]{3,}/.test(l));
      if (li < 0) continue;
      tried.push(path.basename(u.fsPath));
      const col = lines[li].indexOf('$') + 2;
      const h = await waitFor(async () => { const r = await vscode.commands.executeCommand('vscode.executeHoverProvider', d.uri, new vscode.Position(li, col)); return r && r.length ? r : undefined; }, 3000);
      if (h) { hovered++; break; }
      if (tried.length >= 6) break;
    }
    check('a $ system variable in a .va dump still has its hover', hovered > 0, tried.length ? `no hover in: ${tried.join(', ')}` : 'NOT RUN: no .va file with a $ variable in this workspace');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  }

  // Teach / fresh copy are confirmation-driven, so the flows themselves cannot run head-
  // less - every one of them stops on a modal. What is asserted here is that they exist,
  // and the no-poll guarantee above already covers the only thing they could break: both
  // read on a press and neither starts a timer. The text surgery is proven in `npm test`,
  // against every taught position in the backup corpus.
    for (const c of ['robotCode.tp.teachPosition', 'robotCode.tp.teachFromPosReg', 'robotCode.tp.recordPosition', 'robotCode.sync.fetchFile']) check(`command registered: ${c}`, cmds.includes(c));
  for (const c of ['robotCode.tp.offsetPositions', 'robotCode.tp.remapRegister', 'robotCode.tp.extractProgram', 'robotCode.tp.inlineProgram', 'robotCode.tp._teachPlan', 'robotCode.tp.convertFrame', 'robotCode.tp.mirrorPositions', 'robotCode.tp.relabelFrames']) check(`command registered: ${c}`, cmds.includes(c));
  for (const c of ['robotCode.rukus.monitor', 'robotCode.rukus.alarms', 'robotCode.rukus.backup', 'robotCode.rukus.open']) check(`command registered: ${c}`, cmds.includes(c));
  check('command registered: robotCode.live.dashboard', cmds.includes('robotCode.live.dashboard'));
  check('command registered: robotCode.live.getFiles', cmds.includes('robotCode.live.getFiles'));
  check('command registered: robotCode.live.toggleFilesShow', cmds.includes('robotCode.live.toggleFilesShow'));
}
