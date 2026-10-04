/**
 * Position diff and the frames table, against reference-backup. Wired in by test/run.ts:
 * `run(check, refBackupDir)`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseTp } from '@fanuc/tp/parser';
import { diffPositions, positionDiffMarkdown } from '@fanuc/tools/positionDiff';
import { parseSysFrames, isIdentityFrame } from '@fanuc/data/sysFrameParser';

export function run(check: (cond: unknown, msg: string) => void, refBackupDir: string): void {
  // ---- position diff ----
  const lsFiles = fs.existsSync(refBackupDir) ? fs.readdirSync(refBackupDir).filter(f => /\.ls$/i.test(f)) : [];
  // a program with a few cartesian positions, taught (not all-zero)
  const pick = lsFiles.map(f => ({ f, prog: parseTp(fs.readFileSync(path.join(refBackupDir, f), 'latin1')) }))
    .find(x => x.prog.positions.length >= 3 && x.prog.positions.some(p => p.groups[0]?.kind === 'cartesian' && Object.values(p.groups[0].values).some(v => v.value !== 0)));
  check(!!pick, `position diff: a program with taught cartesian positions exists in ${refBackupDir}`);
  if (pick) {
    const text = fs.readFileSync(path.join(refBackupDir, pick.f), 'latin1');
    const a = parseTp(text);
    const same = diffPositions(a, parseTp(text));
    check(same.length === a.positions.length && same.every(r => !r.moved && !r.onlyIn && !r.frameChanged && !r.configChanged), `position diff: ${pick.f} against itself - nothing moved (${same.filter(r => r.moved).length} moved of ${same.length})`);
    check(same.every(r => r.groups[0] && r.groups[0].axes.length >= 6), 'position diff: every row carries its six axes');

    // edit one X coordinate by +1.5 mm and diff again: exactly that point moved, by that much
    const target = a.positions.find(p => p.groups[0]?.kind === 'cartesian' && p.groups[0].values.X !== undefined)!;
    const lines = text.split(/\r?\n/);
    let edited = false;
    for (let i = target.line; i <= target.endLine && !edited; i++) {
      const m = /(\bX\s*=\s*)(-?\d*\.?\d+)/.exec(lines[i]);
      if (m) { lines[i] = lines[i].replace(m[0], `${m[1]}${(parseFloat(m[2]) + 1.5).toFixed(3)}`); edited = true; }
    }
    check(edited, `position diff: could edit X of P[${target.index}] in ${pick.f}`);
    const b = parseTp(lines.join('\n'));
    const rows = diffPositions(a, b);
    const movedRows = rows.filter(r => r.moved);
    const row = rows.find(r => r.index === target.index)!;
    const dx = row?.groups[0]?.axes.find(x => x.axis === 'X')?.delta;
    check(movedRows.length === 1 && movedRows[0].index === target.index, `position diff: exactly P[${target.index}] moved (${movedRows.map(r => r.index).join(',')})`);
    check(dx !== undefined && Math.abs(dx - 1.5) < 0.0011, `position diff: ΔX is +1.5 (${dx})`);
    check(row.distance !== undefined && Math.abs(row.distance - 1.5) < 0.0011 && !row.frameChanged && !row.onlyIn, `position diff: distance 1.5 mm, same frame (${row.distance})`);
    const md = positionDiffMarkdown(rows, 'A', 'B');
    check(md.includes('1 moved') && md.indexOf('## Changed') < md.indexOf('## Unchanged') && new RegExp(`\\| P\\[${target.index}[^|]*\\| moved`).test(md), 'position diff: markdown puts the moved row first and says 1 moved');
    check(/\*\*1\.500\*\*/.test(md), 'position diff: the moved axis is bold in the table');

    // a point present on one side only
    const c = parseTp(text.replace(/P\[(\d+)(:"[^"]*")?\]\{/, 'P[999$2]{'));
    const only = diffPositions(a, c).filter(r => r.onlyIn);
    check(only.length === 2 && only.some(r => r.onlyIn === 'a') && only.some(r => r.onlyIn === 'b' && r.index === 999), `position diff: renamed point shows as only-in-A and only-in-B (${only.map(r => `${r.index}:${r.onlyIn}`).join(' ')})`);

    // joint vs cartesian: no distance, kind change flagged
    const jl = text.split(/\r?\n/);
    let swapped = 0;
    for (let i = target.line; i <= target.endLine; i++) {
      if (/\bX\s*=/.test(jl[i])) { jl[i] = '\tJ1=     0.000 deg,\tJ2=     0.000 deg,\tJ3=     0.000 deg,'; swapped++; }
      else if (/\bW\s*=/.test(jl[i])) { jl[i] = '\tJ4=     0.000 deg,\tJ5=     0.000 deg,\tJ6=     0.000 deg'; swapped++; }
    }
    if (swapped === 2) {
      const jb = parseTp(jl.join('\n'));
      const kindRow = diffPositions(a, jb).find(r => r.index === target.index);
      check(!!kindRow && kindRow.kindChanged && kindRow.moved && kindRow.distance === undefined, `position diff: a representation change is moved, flagged, and has no distance (${JSON.stringify(kindRow?.kind)})`);
    } else check(false, `position diff: could not build a joint variant of P[${target.index}] (${swapped} lines swapped)`);
  }

  // ---- frames table ----
  const sysframe = path.join(refBackupDir, 'sysframe.va');
  if (fs.existsSync(sysframe)) {
    const t = parseSysFrames(fs.readFileSync(sysframe, 'latin1'));
    check(t.frames.size >= 9 && t.tools.size >= 9, `frames: sysframe.va lists ${t.frames.size} user frames and ${t.tools.size} tool frames`);
    check(t.activeFrame === 1 && t.activeTool === 1, `frames: selected UF/UT read from $MNUFRAMENUM/$MNUTOOLNUM (${t.activeFrame}/${t.activeTool})`);
    check(isIdentityFrame(t.frames.get(1)) && isIdentityFrame(undefined) && !isIdentityFrame({ x: 1, y: 0, z: 0, w: 0, p: 0, r: 0 }), 'frames: identity test');
    const set = [...t.frames.entries()].filter(([, f]) => !isIdentityFrame(f)).map(([i]) => i);
    const setTools = [...t.tools.entries()].filter(([, f]) => !isIdentityFrame(f)).map(([i]) => i);
    // S002R01 (V9.40 SpotTool+): the frames the cell actually uses are non-zero; the rest are all zeros
    check(set.length + setTools.length > 0, `frames: at least one frame is set (UF ${set.join(',')} · UT ${setTools.join(',')})`);
    check(set.every(i => { const f = t.frames.get(i)!; return [f.x, f.y, f.z, f.w, f.p, f.r].every(v => Number.isFinite(v)); }), 'frames: every set frame has six finite numbers');
  } else check(false, `frames: ${sysframe} missing`);
}
