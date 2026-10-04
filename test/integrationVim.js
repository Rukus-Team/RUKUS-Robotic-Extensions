// Robot Code next to the Vim extension (issue #19), run by test/runVim.mjs inside a VS Code that has
// vscodevim.vim installed.
//  1. Keyboard shortcuts: every Robot Code keybinding against Vim's own - a clash is the same key with
//     both able to fire in a focused TP/KAREL editor.
//  2. Auto-renumber under real Vim keystrokes (sent through the `type` command, which Vim handles):
//     o, dd, p, ., u - after each, the /MN lines must number 1..n and LINE_COUNT must say n.
const vscode = require('vscode');
const fs = require('fs');
const OUT = process.env.ROBOT_CODE_TEST_OUT;
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail: detail === undefined ? undefined : String(detail).slice(0, 600) }); fs.writeFileSync(OUT, JSON.stringify(results, null, 2)); };
const info = (name, detail) => { results.push({ name, ok: false, info: true, detail: String(detail).slice(0, 1500) }); fs.writeFileSync(OUT, JSON.stringify(results, null, 2)); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const norm = k => (k || '').toLowerCase().split(' ').map(ch => ch.split('+').map(s => s.trim()).sort((a, b) => {
  const order = ['ctrl', 'shift', 'alt', 'meta', 'cmd', 'win'];
  const ia = order.indexOf(a), ib = order.indexOf(b);
  return (ia < 0 ? 9 : ia) - (ib < 0 ? 9 : ib) || a.localeCompare(b);
}).join('+')).join(' ');
const keyOf = b => process.platform === 'darwin' ? (b.mac || b.key) : process.platform === 'win32' ? (b.win || b.key) : (b.linux || b.key);
// a Robot Code binding that cannot fire while a TP/KAREL editor has focus is no clash
const offEditor = w => /\b(view|focusedView|activeViewlet|sideBarFocus|panelFocus|webviewId|activeWebviewPanelId)\b|!editorTextFocus|terminalFocus|listFocus|inQuickOpen/.test(w || '');
// a Vim binding that only fires in a mode/setting Robot Code's bindings never meet still counts; we only
// drop Vim bindings that exclude text editors outright
const vimOffEditor = w => /!editorTextFocus|terminalFocus|listFocus/.test(w || '') && !/editorTextFocus\b(?!\s*==\s*false)/.test((w || '').replace(/!editorTextFocus/g, ''));

async function lines(doc) {
  const t = doc.getText().split(/\r?\n/);
  const a = t.indexOf('/MN'), b = t.indexOf('/POS');
  const mn = t.slice(a + 1, b);
  const nums = mn.map(l => /^\s*(\d+):/.exec(l)).filter(Boolean).map(m => +m[1]);
  const lc = +(/LINE_COUNT\s*=\s*(\d+)/.exec(doc.getText()) || [])[1];
  return { mn, nums, lc };
}
async function renumberedOk(doc, label, expectCount) {
  await sleep(1200);   // auto-renumber is debounced
  const { mn, nums, lc } = await lines(doc);
  const seq = nums.every((n, i) => n === i + 1);
  const ok = seq && lc === nums.length && (expectCount === undefined || nums.length === expectCount);
  const whole = doc.getText().split(/\r?\n/).join(' | ');
  check(`${label}: lines numbered 1..${nums.length}, LINE_COUNT ${lc}`, ok, ok ? mn.join(' | ') : whole);
}
async function keys(str) {
  for (const part of str.match(/<Esc>|./g)) {
    if (part === '<Esc>') await vscode.commands.executeCommand('extension.vim_escape');
    else await vscode.commands.executeCommand('type', { text: part });
    await sleep(40);
  }
}

exports.run = async function run() {
  const vim = vscode.extensions.getExtension('vscodevim.vim');
  const rc = vscode.extensions.all.find(e => e.packageJSON?.name === 'robot-code' && e.packageJSON?.publisher === 'rukus-team');
  check('the Vim extension is installed', !!vim, vscode.extensions.all.map(e => e.id).filter(i => !i.startsWith('vscode.')).join(', '));
  check('Robot Code is loaded', !!rc);
  if (!vim || !rc) return;
  await vim.activate();
  await rc.activate();

  // ---- 1. shortcut clashes
  const ours = (rc.packageJSON.contributes.keybindings || []).map(b => ({ key: norm(keyOf(b)), when: b.when || '', command: b.command })).filter(b => b.key);
  const theirs = (vim.packageJSON.contributes.keybindings || []).map(b => ({ key: norm(keyOf(b)), when: b.when || '', command: b.command })).filter(b => b.key);
  const vimKeys = new Map();
  for (const b of theirs) if (!vimOffEditor(b.when)) (vimKeys.get(b.key) || vimKeys.set(b.key, []).get(b.key)).push(b);
  const clashes = [], sameKeyElsewhere = [];
  for (const b of ours) {
    // a chord's first key is what Vim would see
    const first = b.key.split(' ')[0];
    const hit = vimKeys.get(b.key) || (b.key.includes(' ') ? vimKeys.get(first) : undefined);
    if (!hit) continue;
    (offEditor(b.when) ? sameKeyElsewhere : clashes).push(`${b.key} → ${b.command} [${b.when || 'always'}] vs Vim ${hit[0].command} [${hit[0].when}]`);
  }
  info(`Robot Code shortcuts: ${ours.length}; Vim shortcuts: ${theirs.length}`, '');
  if (sameKeyElsewhere.length) info('same key, but Robot Code only uses it outside the editor (no clash)', sameKeyElsewhere.join('\n'));
  check('no Robot Code shortcut collides with a Vim shortcut in a TP/KAREL editor', clashes.length === 0, clashes.join('\n'));

  // ---- 2. auto-renumber under Vim edits
  const doc = await vscode.workspace.openTextDocument(process.env.ROBOT_CODE_VIM_FILE);
  const ed = await vscode.window.showTextDocument(doc);
  check('the scratch program opens as TP', doc.languageId === 'fanuc-tp', doc.languageId);
  await sleep(1500);   // Vim attaches to the editor
  await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
  await sleep(300);
  // first prove keystrokes reach the file through Vim at all - else every check below passes vacuously
  const before = doc.getText();
  await keys('<Esc>');
  ed.selection = new vscode.Selection(doc.lineCount - 1, 0, doc.lineCount - 1, 0);
  await keys('ix<Esc>');
  await sleep(300);
  const typed = doc.getText() !== before;
  check('Vim keystrokes reach the file (i x Esc inserts an x)', typed, JSON.stringify(doc.lineAt(doc.lineCount - 1).text));
  if (!typed) return;
  await keys('u');
  await sleep(300);
  const at = (line, col = 9) => { ed.selection = new vscode.Selection(line, col, line, col); };
  const mn0 = doc.getText().split(/\r?\n/).indexOf('/MN');
  // Vim keeps its own cursor: move with Vim motions, not by setting the selection
  await keys('<Esc>gg' + String(mn0 + 2) + 'j');  // on "   2:  R[2]=2 ;", Normal mode
  await keys('oR[9]=9<Esc>');                    // open a line below, type, back to Normal
  await renumberedOk(doc, 'o (open line below) + typing', 5);
  const { mn } = await lines(doc);
  check('... the new line is line 3 and holds what was typed', /^\s*3:\s*R\[9\]=9/.test(mn[2] || ''), mn[2]);
  await keys('dd');                              // delete it
  await renumberedOk(doc, 'dd (delete line)', 4);
  await keys('p');                               // paste it back below the cursor
  await renumberedOk(doc, 'p (paste line)', 5);
  await keys('.');                               // repeat the paste
  await renumberedOk(doc, '. (repeat)', 6);
  await keys('u');                               // undo the repeat
  await renumberedOk(doc, 'u (undo) takes the repeated paste back out', 5);
  await vscode.commands.executeCommand('redo');  // Ctrl+R, mapped to VS Code's redo
  await renumberedOk(doc, 'Ctrl+R (redo) puts it back, numbered', 6);
  await keys('u');
  await renumberedOk(doc, 'u again', 5);
  await keys('yyP');                             // yank and paste above
  await renumberedOk(doc, 'yy P (copy line above)');
  await keys('3dd');                             // delete three lines at once
  await renumberedOk(doc, '3dd (delete three lines)');
  await vscode.commands.executeCommand('workbench.action.files.revert');
};
