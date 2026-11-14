// Editing checks run inside a real VS Code (test/runEditing.mjs writes the workspace):
// snippets and block tails, extended comments and wrapped instructions under the renumber,
// program / file rename, the bracket guard, the Knowledge view's blocks, and the clean compare.
// Each one is something that only shows up with the editor in the loop - the pure logic has
// its own unit tests (test/*.test.ts).
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

const OUT = process.env.ROBOT_CODE_TEST_OUT || path.join(require('os').tmpdir(), 'robot-code-editing.json');
const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail: detail === undefined ? undefined : String(detail).slice(0, 700) });
  fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const labelOf = i => (typeof i.label === 'string' ? i.label : i.label.label);
const insertOf = i => (typeof i.insertText === 'string' ? i.insertText : i.insertText?.value ?? labelOf(i));
const SN = vscode.CompletionItemKind.Snippet;
let ws;
const U = (...p) => vscode.Uri.file(path.join(ws, ...p));
const open = async (...p) => { const doc = await vscode.workspace.openTextDocument(U(...p)); const ed = await vscode.window.showTextDocument(doc); return { doc, ed }; };
const linesOf = doc => doc.getText().split(/\r?\n/);
const mnOf = doc => { const l = linesOf(doc); return l.slice(l.indexOf('/MN') + 1, l.indexOf('/POS')); };
const caret = (ed, line, col) => { const p = new vscode.Position(line, col); ed.selection = new vscode.Selection(p, p); };
const revert = () => vscode.commands.executeCommand('workbench.action.files.revert');
/** keys one at a time, as typing does: a character, or <tab> (accept the suggestion), <left>, <bs>, <wait> */
async function type(keys) {
  await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
  for (const k of keys) {
    if (k === '<tab>') { await sleep(900); await vscode.commands.executeCommand('acceptSelectedSuggestion'); await sleep(500); }
    else if (k === '<left>') await vscode.commands.executeCommand('cursorLeft');
    else if (k === '<bs>') { await vscode.commands.executeCommand('deleteLeft'); await sleep(120); }
    else if (k === '<wait>') await sleep(1000);
    else { await vscode.commands.executeCommand('type', { text: k }); await sleep(k === '\n' ? 900 : 110); }
  }
  await sleep(600);
}
const keys = s => [...s];
async function listAt(doc, lineText) {
  const line = linesOf(doc).findIndex(l => l.includes(lineText));
  if (line < 0) throw new Error(`no line with ${lineText}`);
  const pos = new vscode.Position(line, doc.lineAt(line).text.indexOf(lineText) + lineText.length);
  const r = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', doc.uri, pos);
  return { items: r?.items ?? [], pos };
}

async function snippets() {
  for (const [file, lang, mid, fresh, want] of [
    ['sniptest.ls', 'fanuc-tp', 'IF (R[1]=1) TH', '3:  IF', /2:  IF \(R\[1\]=1\) THEN ;\r?\n\s*3:\s*;\r?\n\s*4:  ENDIF ;\r?\n\s*5:  IF/],
    ['sniptest.kl', 'fanuc-karel', 'IF done TH', '  if', /IF done THEN\r?\n\s*\r?\n\s*ENDIF\r?\n/],
    ['SnipTest.mod', 'abb-rapid', 'IF reg1 > 5 TH', '    if', /IF reg1 > 5 THEN\r?\n\s*\r?\n\s*ENDIF\r?\n/],
  ]) {
    const { doc, ed } = await open(file);
    check(`${file} is ${lang}`, doc.languageId === lang, doc.languageId);
    await sleep(1500);
    const m = await listAt(doc, mid);
    const snips = m.items.filter(i => i.kind === SN);
    check(`${file}: mid-statement offers no whole IF statement`, !m.items.some(i => /^\s*IF\b.+/i.test(insertOf(i))), m.items.filter(i => /^\s*IF\b.+/i.test(insertOf(i))).map(labelOf).join(','));
    check(`${file}: mid-statement snippets are only the block tails`, snips.length > 0 && snips.every(i => /^(THEN|DO|OF)\b/.test(insertOf(i))), snips.map(labelOf).join(' | '));
    check(`${file}: THEN … ENDIF is offered`, snips.some(i => labelOf(i) === 'THEN … ENDIF'), snips.map(labelOf).join(' | '));
    const f = await listAt(doc, fresh);
    check(`${file}: a fresh statement still gets the IF ... ENDIF snippet`, f.items.some(i => i.kind === SN && /^IF\b[\s\S]*ENDIF/.test(insertOf(i))), f.items.filter(i => i.kind === SN).map(labelOf).join(' | ').slice(0, 300));
    // through the real suggest widget: what is on top is what gets written
    caret(ed, m.pos.line, m.pos.character);
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    await vscode.commands.executeCommand('editor.action.triggerSuggest');
    await sleep(1800);
    await vscode.commands.executeCommand('acceptSelectedSuggestion');
    await sleep(700);
    check(`${file}: accepting the top suggestion finishes the block in place`, want.test(doc.getText()) && (doc.getText().match(/\bIF\b/gi) ?? []).length === 2, JSON.stringify(linesOf(doc).filter(l => /IF|THEN/i.test(l))));
    await revert();
  }
  const tp = (await open('sniptest.ls')).doc;
  const op = await listAt(tp, 'R[2]=DO');
  check('TP: `R[2]=DO` offers the DO[] operand and no statement snippet', op.items.some(i => labelOf(i) === 'DO[]') && !op.items.some(i => i.kind === SN), op.items.filter(i => i.kind === SN).map(labelOf).join(','));
  const end = linesOf(tp).findIndex(l => l.startsWith('/END'));
  await vscode.window.activeTextEditor.edit(b => b.insert(new vscode.Position(end, 0), 'pos\n'));
  const pr = (await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', tp.uri, new vscode.Position(end, 3)))?.items ?? [];
  check('TP: under /POS the position record snippets are offered, the instruction ones are not', pr.some(i => /^P\[/.test(insertOf(i))) && !pr.some(i => /ENDIF/.test(insertOf(i))), pr.map(labelOf).join(',').slice(0, 300));
  await revert();
  const kl = (await open('sniptest.kl')).doc;
  check('KAREL: no snippets in the middle of an expression', !(await listAt(kl, 'i = sel')).items.some(i => i.kind === SN));
  check('KAREL: FOR ... D offers DO … ENDFOR', (await listAt(kl, 'FOR i = 1 TO 10 D')).items.some(i => labelOf(i) === 'DO … ENDFOR'));
}

async function comments() {
  const { doc, ed } = await open('egtest.ls');
  await sleep(2500);
  const original = mnOf(doc);
  const base = linesOf(doc).indexOf('/MN') + 1;
  const diags = () => vscode.languages.getDiagnostics(doc.uri).map(d => d.message);
  check('a long --eg line and a long IF line are not flagged for length', !diags().some(d => /columns|characters/.test(d)), diags().join(' | '));
  caret(ed, base, doc.lineAt(base).text.length);
  await type(['\n', ...keys('inserted words')]);
  let now = mnOf(doc);
  check('Enter inside the comment gives a `:` line, typed text lands on it', /^\s+:\s+inserted words\s*$/.test(now[1]) && /^\s+:\s+second line of it$/.test(now[2]), JSON.stringify(now.slice(0, 5)));
  caret(ed, base + 5, 0);
  await sleep(1500);
  now = mnOf(doc);
  check('after the caret leaves: still one comment, no line of it numbered, nothing re-wrapped', now.length === original.length + 1 && now[0] === original[0] && /^\s+:\s+inserted words$/.test(now[1]) && now[2] === original[1] && now[3] === original[2] && /^\s+2:/.test(now[4]), JSON.stringify(now.slice(0, 6)));
  caret(ed, base + 3, doc.lineAt(base + 3).text.length);
  await type(['\n', ...keys('last words')]);
  caret(ed, base + 7, 0);
  await sleep(1500);
  now = mnOf(doc);
  check('Enter after the last line continues the comment', !/;\s*$/.test(now[3]) && /^\s+:\s+last words ;$/.test(now[4]) && /^\s+2:\s+R\[1\]=1 ;$/.test(now[5]), JSON.stringify(now.slice(2, 7)));
  check('the long IF line is untouched', now.some(l => l.endsWith(original[4].replace(/^\s*\d+:/, ''))), JSON.stringify(now.slice(-2)));
  await revert();

  // a controller-written file with wrapped instructions and a multi-language comment: an edit
  // elsewhere, and the renumber that follows, must not touch them
  const w = await open('wrapped.ls');
  await sleep(2500);
  const before = mnOf(w.doc);
  const wb = linesOf(w.doc).indexOf('/MN') + 1;
  const last = wb + before.length - 1;   // the empty `   6:   ;`
  caret(w.ed, last, 7);
  await type(keys('R[1]=1'));
  caret(w.ed, wb, 0);
  await sleep(1800);
  const after = mnOf(w.doc);
  check('wrapped instructions and a --kn comment survive an edit and its renumber', after.slice(0, 9).join('\n') === before.slice(0, 9).join('\n') && /^\s+6:\s+R\[1\]=1 ;$/.test(after[9]), JSON.stringify(after));
  const wd = vscode.languages.getDiagnostics(w.doc.uri).filter(d => /terminator|out of sequence|no line number/.test(d.message));
  check('...and are not reported as missing terminators or numbers', wd.length === 0, wd.map(d => `${d.range.start.line - wb + 1}: ${d.message.slice(0, 40)}`).join(' | '));
  await revert();
}

async function rename() {
  const head = async n => (await vscode.workspace.openTextDocument(U(n))).lineAt(0).text;
  const disk = n => fs.readFileSync(path.join(ws, n), 'utf8').split(/\r?\n/);
  await open('main.ls');
  await sleep(2500);
  let e = new vscode.WorkspaceEdit(); e.renameFile(U('pick.ls'), U('grab.ls'));
  check('file rename applied', await vscode.workspace.applyEdit(e));
  await sleep(800); await vscode.workspace.saveAll(); await sleep(500);
  check('pick.ls -> grab.ls: /PROG is GRAB', fs.existsSync(path.join(ws, 'grab.ls')) && !fs.existsSync(path.join(ws, 'pick.ls')) && /^\/PROG\s+GRAB$/.test(disk('grab.ls')[0]), disk('grab.ls')[0]);
  e = new vscode.WorkspaceEdit(); e.renameFile(U('vac.kl'), U('vacuum.kl'));
  await vscode.workspace.applyEdit(e); await sleep(800); await vscode.workspace.saveAll(); await sleep(500);
  check('vac.kl -> vacuum.kl: PROGRAM and END follow', disk('vacuum.kl')[0] === 'PROGRAM vacuum' && disk('vacuum.kl')[2] === 'END vacuum', disk('vacuum.kl').join(' | '));

  const old = (await open('place_old.ls')).doc;
  await sleep(2500);
  const isName = x => x.code === 'tp.programName' || x.code?.value === 'tp.programName';
  const d = vscode.languages.getDiagnostics(old.uri).find(isName);
  check('place_old.ls with /PROG PLACE is noted', !!d, vscode.languages.getDiagnostics(old.uri).map(x => x.message.slice(0, 50)).join(' | '));
  const acts = d ? (await vscode.commands.executeCommand('vscode.executeCodeActionProvider', old.uri, d.range, vscode.CodeActionKind.QuickFix.value)) ?? [] : [];
  check('quick fixes: rename the file, or change /PROG', acts.some(a => a.title === 'Rename the file to PLACE.ls') && acts.some(a => a.title === 'Change /PROG to PLACE_OLD'), acts.map(a => a.title).join(' | '));
  const fix = acts.find(a => a.title === 'Rename the file to PLACE.ls');
  if (fix?.edit) { await vscode.workspace.applyEdit(fix.edit); await sleep(1500); }
  check('the quick fix renamed the file, /PROG untouched', fs.existsSync(path.join(ws, 'PLACE.ls')) && !fs.existsSync(path.join(ws, 'place_old.ls')) && /^\/PROG\s+PLACE$/.test(await head('PLACE.ls')), fs.readdirSync(ws).join(','));
  check('and the note is gone', !vscode.languages.getDiagnostics(U('PLACE.ls')).some(isName));

  await vscode.workspace.saveAll(); await sleep(2500);   // let the index see GRAB and who calls it
  const grab = (await open('grab.ls')).doc;
  await sleep(1500);
  const col = grab.lineAt(0).text.indexOf('GRAB') + 1;
  const re = await vscode.commands.executeCommand('vscode.executeDocumentRenameProvider', grab.uri, new vscode.Position(0, col), 'take_part');
  check('F2 on /PROG gives an edit', !!re && re.size + (re.entries?.().length ?? 0) > 0);
  const applied = re ? await vscode.workspace.applyEdit(re) : false;
  await sleep(1500);
  check('the F2 edit applies whole', applied === true, applied);
  await vscode.workspace.saveAll(); await sleep(1000);
  const files = fs.readdirSync(ws);
  check('F2: the file is TAKE_PART.ls and /PROG says TAKE_PART', files.includes('TAKE_PART.ls') && !files.includes('grab.ls') && /^\/PROG\s+TAKE_PART$/.test(disk('TAKE_PART.ls')[0]), files.join(','));
  const calls = disk('main.ls').filter(l => /CALL|RUN/.test(l));
  check('F2: CALL and RUN in main.ls follow, CALL GRABBER does not', /CALL TAKE_PART ;/.test(calls[0]) && /RUN TAKE_PART ;/.test(calls[1]) && /CALL GRABBER ;/.test(calls[2]), calls.join(' | '));
  let threw = '';
  try { await vscode.commands.executeCommand('vscode.executeDocumentRenameProvider', U('TAKE_PART.ls'), new vscode.Position(0, col), '2 bad name'); } catch (x) { threw = String(x?.message ?? x); }
  check('F2 refuses a name the controller would not take', /letter/.test(threw), threw);
}

async function brackets() {
  const { doc, ed } = await open('brk.ls');
  await sleep(2500);
  const L = linesOf(doc).findIndex(l => /^\s+3:\s+;$/.test(l));
  for (const [name, k, want] of [
    ['plain typing of an indirect register is untouched', keys('R[R[35]]=1'), '   3:  R[R[35]]=1 ;'],
    ['pick from the list, then type the ] anyway: no extra bracket', [...keys('R[35'), '<tab>', ...keys(']=1')], '   3:  R[35:index]=1 ;'],
    ['indirect: pick the inner register, type ]] - one closes the outer, the other is dropped', [...keys('R[R[35'), '<tab>', ...keys(']]=1')], '   3:  R[R[35:index]]=1 ;'],
    ['one bracket too many at the end of a typed indirect register', keys('R[R[35]]]=1'), '   3:  R[R[35]]=1 ;'],
    ['a ] typed in front of the one already there steps over it', [...keys('R[1]=R[R[35]]'), '<left>', ']', ...keys('+1')], '   3:  R[1]=R[R[35]]+1 ;'],
    ['an extra ) in a condition', keys('IF (R[1]=1)),JMP LBL[1]'), '   3:  IF (R[1]=1),JMP LBL[1] ;'],
    ['a comment line takes any text', keys('!see R[1]] and )'), '   3:  !see R[1]] and ) ;'],
    ['a string takes any text', keys("SR[1]='a]b'"), "   3:  SR[1]='a]b' ;"],
  ]) {
    await ed.edit(b => b.replace(doc.lineAt(L).range, '   3:   ;'));
    caret(ed, L, 7);
    await sleep(300);
    await type(k);
    check(`brackets: ${name}`, doc.lineAt(L).text === want, JSON.stringify(doc.lineAt(L).text));
  }
  // a ; typed where the line already has one: taken out once the caret leaves the line
  await ed.edit(b => b.replace(doc.lineAt(L).range, '   3:   ;'));
  caret(ed, L, 7);
  await type(keys('R[9]=9;'));
  check('a second ; is still there while the line is being typed', /R\[9\]=9;\s*;$/.test(doc.lineAt(L).text), JSON.stringify(doc.lineAt(L).text));
  caret(ed, L - 2, 0);
  await sleep(1500);
  check('...and is taken out when the caret leaves the line', doc.lineAt(L).text === '   3:  R[9]=9 ;', JSON.stringify(doc.lineAt(L).text));
  // a wrapped instruction: the ) that closes a ( opened two lines up is not one too many
  const W = linesOf(doc).findIndex(l => /DI\[2\]=ON $/.test(l));
  caret(ed, W, doc.lineAt(W).text.length - 1);
  await type([')']);
  check('brackets: a ) on a wrapped line closes the ( opened on the line above', /DI\[2\]=ON\) $/.test(doc.lineAt(W).text), JSON.stringify(doc.lineAt(W).text));
  await type([')']);
  check('brackets: ...and a second one there is dropped', /DI\[2\]=ON\) $/.test(doc.lineAt(W).text), JSON.stringify(doc.lineAt(W).text));
  await revert();
}

async function knowledge() {
  const { doc, ed } = await open('bg_intlk.ls');
  await sleep(1500);
  let ok = true;
  try { await vscode.commands.executeCommand('robotCode.knowledge.setKind', 'tp'); } catch (e) { ok = e?.message ?? false; }
  await sleep(2000);
  check('the Knowledge view opens', ok === true, ok);
  const L = linesOf(doc).findIndex(l => /^\s+8:\s+;$/.test(l));
  const insertFirst = async (line, col) => {
    await vscode.window.showTextDocument(doc);
    caret(ed, line, col);
    void vscode.commands.executeCommand('robotCode.knowledge.insertBlock');
    await sleep(1500);
    await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
    await sleep(1200);
  };
  await insertFirst(L, 7);
  check('a block lands in the empty line at the caret', /^\s+8:\s+IF R\[1\]=1,JMP LBL\[1\] ;$/.test(doc.lineAt(L).text), JSON.stringify(doc.lineAt(L).text));
  await vscode.commands.executeCommand('undo'); await sleep(400);
  await insertFirst(L - 6, 9);
  caret(ed, L + 2, 0);
  await sleep(1500);
  const now = linesOf(doc).slice(L - 6, L - 3);
  check('on a line with text the block goes on a new line under it, and is numbered', /^\s+2:\s+DO\[1:clear\]/.test(now[0]) && /^\s+3:\s+IF R\[1\]=1,JMP LBL\[1\] ;$/.test(now[1]) && /^\s+4:\s+IF \(DI\[3/.test(now[2]), JSON.stringify(now));
  await revert();
  // on the first part of a wrapped instruction the block goes under the WHOLE instruction
  const w = await open('wrapped.ls');
  await sleep(1500);
  const head = linesOf(w.doc).findIndex(l => /L P\[3\] 1000mm\/sec FINE$/.test(l));
  caret(w.ed, head, 8);
  void vscode.commands.executeCommand('robotCode.knowledge.insertBlock');
  await sleep(1500);
  await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
  await sleep(1200);
  const wl = linesOf(w.doc);
  check('a block asked for on a wrapped line lands under the whole instruction, not inside it', /SPOT\[S=1 \]/.test(wl[head + 1]) && /IF R\[1\]=1,JMP LBL\[1\]/.test(wl[head + 2]), JSON.stringify(wl.slice(head, head + 4)));
  await revert();
}

async function compare() {
  const diffTab = () => { const t = vscode.window.tabGroups.activeTabGroup.activeTab; return t?.input instanceof vscode.TabInputTextDiff ? t : undefined; };
  const sides = async () => { const t = diffTab(); return t ? [(await vscode.workspace.openTextDocument(t.input.original)).getText(), (await vscode.workspace.openTextDocument(t.input.modified)).getText(), t.label] : []; };
  const A = U('cmp', 'robot', 'cycle.ls');
  await vscode.commands.executeCommand('robotCode.compare.clean', A, [A, U('cmp', 'edited', 'cycle_same.ls')]);
  await sleep(2500);
  let [l, r, label] = await sides();
  const raw = n => fs.readFileSync(path.join(ws, 'cmp', ...n), 'latin1');
  check('compare: two files that differ only in numbering, terminators and line endings compare equal', l !== undefined && l === r && raw(['robot', 'cycle.ls']) !== raw(['edited', 'cycle_same.ls']), label);
  check('compare: the title says what is ignored', /ignoring line numbers, line terminators, spacing and header bookkeeping/.test(label ?? ''), label);
  await vscode.commands.executeCommand('robotCode.compare.clean', A, [A, U('cmp', 'edited', 'cycle.ls')]);
  await sleep(2500);
  [l, r, label] = await sides();
  const Ls = (l ?? '').split('\n'), Rs = (r ?? '').split('\n');
  const onlyR = Rs.filter(x => !Ls.includes(x)), onlyL = Ls.filter(x => !Rs.includes(x));
  check('compare: only the real differences are left', onlyR.join('|') === '!rev B: check the gripper|L P[2] 250mm/sec FINE|WAIT DI[7:gripped]=ON' && onlyL.join('|') === 'L P[2] 500mm/sec FINE|WAIT .50(sec)', `left only: ${onlyL.join('|')} / right only: ${onlyR.join('|')}`);
  check('compare: same file name on both sides - the folder is in the title', /robot\/cycle\.ls ↔ edited\/cycle\.ls/.test(label ?? ''), label);
  const t = diffTab();
  const n = t ? vscode.languages.getDiagnostics(t.input.original).length + vscode.languages.getDiagnostics(t.input.modified).length : -1;
  check('compare: the panes are not linted', n === 0, n);
  // a click into a pane is not an edit of a program: nothing renumbers the view
  if (t) { const ed = await vscode.window.showTextDocument(t.input.modified, { preview: false }); caret(ed, 25, 3); await sleep(400); caret(ed, 27, 3); await sleep(1800); }
  const view = t ? (await vscode.workspace.openTextDocument(t.input.modified)).getText() : '';
  check('compare: a pane stays as cleaned when the caret moves in it', view === r && !/^\s*\d+:/m.test(view.split('/MN')[1] ?? ''), view.split('\n').slice(22, 26).join(' | '));
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
}

exports.run = async () => {
  ws = vscode.workspace.workspaceFolders[0].uri.fsPath;
  for (const [name, part] of [['snippets', snippets], ['comments', comments], ['brackets', brackets], ['knowledge', knowledge], ['compare', compare], ['rename', rename]]) {
    try { await part(); } catch (e) { check(`${name}: ran to the end`, false, e?.stack ?? e); }
  }
};
