// One-off: colour scheme + full-width position section for the robot dashboard. Idempotent.
import * as fs from 'node:fs';
let t = fs.readFileSync('packages/core/src/live/dashboard.ts', 'utf8');
let n = 0;
function rep(a, b) { if (t.includes(b) && !t.includes(a)) return; if (!t.includes(a)) { console.log('MISSING:', a.slice(0, 80)); return; } t = t.replace(a, b); n++; }

rep(":root { --ok: var(--vscode-testing-iconPassed, #3fb950); --bad: var(--vscode-testing-iconFailed, #f14c4c); --warn: var(--vscode-charts-yellow, #f6c343); --muted: var(--vscode-descriptionForeground); --line: var(--vscode-panel-border, #444); --card: var(--vscode-editorWidget-background) }",
  ":root { --ok: var(--vscode-testing-iconPassed, #3fb950); --bad: var(--vscode-testing-iconFailed, #f14c4c); --warn: var(--vscode-charts-yellow, #f6c343); --blue: var(--vscode-charts-blue, #61afef); --purple: var(--vscode-charts-purple, #c678dd); --orange: var(--vscode-charts-orange, #d19a66); --green: var(--vscode-charts-green, #98c379); --muted: var(--vscode-descriptionForeground); --line: var(--vscode-panel-border, #444); --card: var(--vscode-editorWidget-background) }");

rep(".card { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px; min-width: 0 }",
  ".card { background: var(--card); border: 1px solid var(--line); border-top: 3px solid var(--muted); border-radius: 8px; padding: 12px 14px; min-width: 0 } .card.run { border-top-color: var(--ok) } .card.pos { border-top-color: var(--blue) } .card.alm { border-top-color: var(--bad) } .card.tsk { border-top-color: var(--purple) } .card.io { border-top-color: var(--green) } .card.reg { border-top-color: var(--orange) } .card.err { border-top-color: var(--bad) }\n  .card h2 .ic { width: 8px; height: 8px; border-radius: 2px; display: inline-block; background: var(--muted) } .card.run h2 .ic { background: var(--ok) } .card.pos h2 .ic { background: var(--blue) } .card.alm h2 .ic { background: var(--bad) } .card.tsk h2 .ic { background: var(--purple) } .card.io h2 .ic { background: var(--green) } .card.reg h2 .ic { background: var(--orange) }");

rep(".head h1 { font-size: 20px; margin: 0; display: flex; align-items: center; gap: 10px }",
  ".head h1 { font-size: 20px; margin: 0; display: flex; align-items: center; gap: 10px; color: var(--warn) }");

rep(".axes { display: grid; grid-template-columns: repeat(6, 1fr); gap: 6px } .ax { background: var(--vscode-editor-background); border-radius: 6px; padding: 6px 8px; text-align: center } .ax .l { font-size: 10px; color: var(--muted) } .ax .v { font-family: var(--vscode-editor-font-family, monospace); font-size: 13px }",
  ".axes { display: grid; grid-template-columns: repeat(auto-fit, minmax(96px, 1fr)); gap: 6px } .ax { background: var(--vscode-editor-background); border-radius: 6px; padding: 6px 8px; text-align: center; min-width: 0; border-left: 3px solid var(--muted) } .ax .l { font-size: 10px; color: var(--muted); font-weight: 600; letter-spacing: .04em } .ax .v { font-family: var(--vscode-editor-font-family, monospace); font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis } .ax.xyz { border-left-color: var(--blue) } .ax.xyz .v { color: var(--blue) } .ax.wpr { border-left-color: var(--purple) } .ax.wpr .v { color: var(--purple) } .ax.j { border-left-color: var(--orange) } .ax.j .v { color: var(--orange) } .ax.e { border-left-color: var(--green) } .ax.e .v { color: var(--green) }\n  .poslabel { font-size: 11px; color: var(--muted); margin: 10px 0 4px; text-transform: uppercase; letter-spacing: .05em }");

rep(".pill { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; background: var(--muted); color: var(--vscode-editor-background) }",
  ".pill { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; background: var(--muted); color: #fff }");

rep(".mono { font-family: var(--vscode-editor-font-family, monospace) } .num { text-align: right; font-family: var(--vscode-editor-font-family, monospace) } .muted { color: var(--muted) }",
  ".mono { font-family: var(--vscode-editor-font-family, monospace) } .num { text-align: right; font-family: var(--vscode-editor-font-family, monospace); color: var(--orange) } .muted { color: var(--muted) } .prog { color: var(--warn); font-family: var(--vscode-editor-font-family, monospace) }");

rep(".chip .k { font-family: var(--vscode-editor-font-family, monospace); color: var(--muted) }",
  ".chip .k { font-family: var(--vscode-editor-font-family, monospace); color: var(--blue) } .chip.on .k { color: var(--green) }");

rep(".grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 14px; margin-top: 14px }",
  ".grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 14px; margin-top: 14px }");

// cards
rep('<div class="card"><h2>Running now</h2>', '<div class="card run"><h2><span class="ic"></span>Running now</h2>');
rep(`<span style="margin-left:8px">' + esc(t.current.program) + '</span>`, `<span class="prog" style="margin-left:8px">' + esc(t.current.program) + '</span>`);

const oldPos = t.slice(t.indexOf('<div class="card"><h2>Position'), t.indexOf('</div>\n        <div class="card"><h2>Alarms') + '</div>'.length);
const oldAlm = t.slice(t.indexOf('<div class="card"><h2>Alarms'), t.indexOf('</div>\n        <div class="card wide"><h2>Tasks') + '</div>'.length);
if (oldPos.startsWith('<div class="card"><h2>Position') && oldAlm.startsWith('<div class="card"><h2>Alarms')) {
  const newAlm = oldAlm.replace('<div class="card"><h2>Alarms', '<div class="card alm"><h2><span class="ic"></span>Alarms').replace(`'<div class="big" style="font-size:14px"><span class="' + (a.severity === 'WARN' ? '' : 'err') + '">'`, `'<div class="big" style="font-size:14px"><span class="' + (a.severity === 'WARN' ? '' : 'err') + '" style="' + (a.severity === 'WARN' ? 'color:var(--warn)' : '') + '">'`);
  const tiles = (obj, cls, keys, unit) => `${keys.map(k => `'<div class="ax ${cls}"><div class="l">${k.toUpperCase()} ${unit}</div><div class="v">' + fmt(${obj}.${k}) + '</div></div>'`).join(' + ')}`;
  const newPos = `<div class="card wide pos"><h2><span class="ic"></span>Position <span class="n">\${pos ? 'Group ' + pos.group + (pos.frameNo !== undefined ? ' · UF ' + pos.frameNo + ' · UT ' + pos.toolNo : '') : ''}</span></h2>\${pos && pos.userFrame ? '<div class="poslabel">Cartesian (user frame ' + (pos.frameNo ?? '?') + ')' + (pos.userFrame.config ? ' · CFG ' + esc(pos.userFrame.config) : '') + '</div><div class="axes">' + ${tiles('pos.userFrame', 'xyz', ['x', 'y', 'z'], 'mm')} + ${tiles('pos.userFrame', 'wpr', ['w', 'p', 'r'], 'deg')} + pos.userFrame.ext.map((e, i) => '<div class="ax e"><div class="l">E' + (i + 1) + '</div><div class="v">' + fmt(e) + '</div></div>').join('') + '</div>' : ''}\${pos && pos.world && pos.userFrame && (Math.abs(pos.world.x - pos.userFrame.x) > 0.005 || Math.abs(pos.world.y - pos.userFrame.y) > 0.005 || Math.abs(pos.world.z - pos.userFrame.z) > 0.005) ? '<div class="poslabel">World</div><div class="axes">' + ${tiles('pos.world', 'xyz', ['x', 'y', 'z'], 'mm')} + ${tiles('pos.world', 'wpr', ['w', 'p', 'r'], 'deg')} + '</div>' : ''}\${pos && pos.joint ? '<div class="poslabel">Joints (deg)</div><div class="axes">' + pos.joint.joints.map((j, i) => '<div class="ax j"><div class="l">J' + (i + 1) + '</div><div class="v">' + fmt(j) + '</div></div>').join('') + pos.joint.ext.map((e, i) => '<div class="ax e"><div class="l">EXT' + (i + 1) + '</div><div class="v">' + fmt(e) + '</div></div>').join('') + '</div>' : ''}\${!pos ? '<div class="empty">No position data</div>' : ''}</div>`;
  t = t.replace(oldPos + '\n        ' + oldAlm, newAlm + '\n        ' + newPos);
  n++;
} else console.log('position/alarm cards not found in expected order');

rep('<div class="card wide"><h2>Tasks <span class="n">', '<div class="card wide tsk"><h2><span class="ic"></span>Tasks <span class="n">');
rep(`<td class="mono">' + esc(t.current?.program ?? '') + '</td><td class="num">' + (t.current?.line ?? '')`, `<td class="prog">' + esc(t.current?.program ?? '') + '</td><td class="num">' + (t.current?.line ?? '')`);
rep('<div class="card wide"><h2>Alarm log <span class="n">', '<div class="card wide alm"><h2><span class="ic"></span>Alarm log <span class="n">');
rep('<div class="card wide"><h2>I/O <span class="n">', '<div class="card wide io"><h2><span class="ic"></span>I/O <span class="n">');
rep('<div class="card wide"><h2>Registers <span class="n">', '<div class="card wide reg"><h2><span class="ic"></span>Registers <span class="n">');
rep(`<td class="mono">R[' + r.i + ']</td>`, `<td class="mono" style="color:var(--orange)">R[' + r.i + ']</td>`);
rep(`'<div class="card wide"><h2 class="err">Fetch problems</h2>'`, `'<div class="card wide err"><h2 class="err">Fetch problems</h2>'`);

fs.writeFileSync('packages/core/src/live/dashboard.ts', t);
const p = JSON.parse(fs.readFileSync('package.json', 'utf8')); p.version = '0.5.2'; fs.writeFileSync('package.json', JSON.stringify(p, null, 2) + '\n');
console.log('dashboard patched:', n, 'changes');
