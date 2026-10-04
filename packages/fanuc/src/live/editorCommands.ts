/**
 * Commands that put the open editor and a controller in the same room.
 *
 * Everything in here is one request each, on a button, in the spirit of the rest of the
 * live tier: *Teach* reads `CURPOS.DG` once and edits the local file, *Fresh copy* reads
 * one program once and diffs it against what is on disk, *Download and replace* reads it
 * once and overwrites the local file. *Upload* is the one write to a controller in the
 * whole extension - guarded, confirmed, logged, and read back (see uploadProgram).
 *
 * The teaching itself lives in `../fanuc/tp/teach.ts`, which knows nothing about VS Code
 * or HTTP; this file is the part that asks, confirms and logs.
 */
import * as vscode from 'vscode';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import type { FanucServices } from '../services';
import { appendAudit } from '@core/rukus/store';
import type { RobotManager } from '@core/live/robotManager';
import { connectionHint } from '@core/live/connectionHints';
import { config, showRecoverableError } from '@core/util';
import { findPosition, frameLabel, type TpProgram } from '../tp/parser';
import {
  planTeach, planRewriteBlock, sourceFromCurrentPosition, sourceFromPosRegValues, buildPositionBlock,
  posSectionBounds, nextFreePositionIndex, type TeachPlan, type TeachSource,
} from '../tp/teach';
import { convertUserFrame, convertToolFrame, IDENTITY, type Xyzwpr } from '../tp/frameMath';
import { frameOrIdentity } from '../data/sysFrameParser';
import { boundRobot, profileNamed } from '@core/robotBinding';
import type { CurrentPosition } from '@core/live/types';
import { diffProgram } from '../tools/backupDiff';
import { gated } from '@core/experimental';
import { checkPushGate, captureRobotCopy, completePush, writeWorkingCopy, withSyncLock, type PullAfterPush, type CompletePushResult } from '@core/snapshotSync';
import { isFileDirty } from '@core/gitAware';
import { fetchControllerErrors } from '@core/syncCommands';
import { historyStamp, ROBOT_DIR, SNAPSHOT_HISTORY_DIR, type VerbatimDiff, type RobotMarker } from '@core/robotContainers';
import { ORDER_FILE, ASCII_UPLOAD, ASCII_PROGRAM_LOADER, readControllerOptions, canLoadAscii } from './controllerOptions';

export function registerEditorCommands(ctx: vscode.ExtensionContext, s: FanucServices, robots: RobotManager) {
  const reg = (id: string, fn: (...a: any[]) => any) => ctx.subscriptions.push(vscode.commands.registerCommand(id, fn));

  // Teach from PR[n] reads the backup's posreg.va, not the robot, so it stays on without the
  // experimental switch; everything else here talks to a controller.
  reg('robotCode.tp.teachPosition', gated((arg?: number | vscode.Uri) => teachFromRobot(ctx, s, robots, typeof arg === 'number' ? arg : undefined)));
  reg('robotCode.tp.teachFromPosReg', (arg?: number) => teachFromPosReg(s, typeof arg === 'number' ? arg : undefined));
  reg('robotCode.tp.recordPosition', gated(() => recordPosition(ctx, s, robots)));
  reg('robotCode.sync.pushFile', gated((uri?: vscode.Uri) => uploadProgram(s, robots, uri)));
  const live = new LiveEdit(s, robots);
  ctx.subscriptions.push(live);
  reg('robotCode.live.liveEdit', gated((uri?: vscode.Uri) => live.toggle(uri)));

  /**
   * Hidden: what a teach WOULD do, without doing it or asking.
   *
   * The confirmation dialogs make the teach flow impossible to drive from a test, and the
   * thing most worth testing is the refusal — that a reading taken in the robot's active
   * frame is recognised as not belonging to a point taught in another one. This returns
   * the plan so the smoke test can assert that against a real controller's `CURPOS.DG`
   * instead of a fixture. Also the honest answer to "why won't it let me teach this?".
   */
  reg('robotCode.tp._teachPlan', async (index?: number) => {
    const prepared = await prepareTeach(s, robots, typeof index === 'number' ? index : undefined);
    if (!prepared) return undefined;
    const plan = planTeach(prepared.editor.document.getText(), prepared.index, prepared.source);
    return plan && {
      index: prepared.index, robot: prepared.robot,
      source: { kind: prepared.source.kind, uf: prepared.source.uf, ut: prepared.source.ut, config: prepared.source.config, values: prepared.source.values },
      target: plan.target, blockers: plan.blockers, warnings: plan.warnings,
      changes: plan.changes, configChange: plan.configChange, edits: plan.edits.length,
    };
  });
}

// ---------------------------------------------------------------- teach

async function teachFromRobot(ctx: vscode.ExtensionContext, s: FanucServices, robots: RobotManager, index?: number) {
  const prepared = await prepareTeach(s, robots, index, true);
  if (!prepared) return;
  await applyTeach(prepared.editor, s, robots, prepared.robot, prepared.index, prepared.source, { rewrite: prepared.rewrite, explicitFrames: prepared.explicitFrames });
}

/**
 * Everything a teach needs up to the point of asking: which position, which robot, one
 * `CURPOS.DG` read, and the reading turned into a source. Split out because the plan this
 * produces is worth being able to inspect without applying it — see `robotCode.tp._teachPlan`.
 *
 * Non-interactive (the diagnostic command and the smoke test), the source is in whatever
 * representation and frames the target already has, and the guards in planTeach do the
 * rest. Interactive, the user is asked two things first - cartesian or joint, and which
 * UF/UT to record against - and the reading is converted into that answer.
 */
async function prepareTeach(s: FanucServices, robots: RobotManager, index?: number, interactive = false) {
  const ed = tpEditor(); if (!ed) return undefined;
  const prog = s.tp.get(ed.document);
  const target = await resolvePosition(ed, prog, index);
  if (target === undefined) return undefined;

  const pos = findPosition(prog, target);
  if (!pos) { vscode.window.showWarningMessage(`P[${target}] has no position data in this program.`); return undefined; }
  const group = pos.groups[0];
  const stored: 'joint' | 'cartesian' = group?.kind === 'joint' ? 'joint' : 'cartesian';

  const name = await pickConnected(s, robots, ed.document.uri);
  if (!name) return undefined;

  const current = await readCurrentPosition(robots, name);
  if (!current) return undefined;

  if (!interactive) {
    const source = sourceFromCurrentPosition(current, stored, group?.uf);
    if (!source) {
      vscode.window.showWarningMessage(stored === 'joint'
        ? `${name} did not report joint angles, which P[${target}] is stored as.`
        : `${name} did not report a ${group?.uf === 0 ? 'world' : 'user frame'} position.`);
      return undefined;
    }
    return { editor: ed, robot: name, index: target, source, rewrite: false, explicitFrames: false };
  }

  const choice = await chooseTeachOptions(s, ed.document.uri, target, group, stored, current, name);
  if (!choice) return undefined;
  return { editor: ed, robot: name, index: target, source: choice.source, rewrite: choice.source.kind !== stored, explicitFrames: choice.explicitFrames };
}

/**
 * The two questions: which representation, and which frames.
 *
 * Representation is a real choice because the controller reports both - joint angles and
 * XYZWPR are two readings of the one pose, so no kinematics is involved in picking either.
 * Frames are a real choice because the reading arrives in the robot's ACTIVE UF/UT, and
 * the point may be recorded against any frame the backup knows: converting between two
 * frames in `sysframe.va` is arithmetic (see frameMath.ts), so "keep the point's frames
 * even though the robot is in another one" is an honest option rather than a guess.
 */
async function chooseTeachOptions(
  s: FanucServices, uri: vscode.Uri, index: number,
  group: { kind: 'cartesian' | 'joint' | 'unknown'; uf?: number; ut?: number } | undefined,
  stored: 'joint' | 'cartesian', current: CurrentPosition, robot: string,
): Promise<{ source: TeachSource; explicitFrames: boolean } | undefined> {
  const hasJoint = !!current.joint?.joints.length;
  const hasCart = !!(current.userFrame || current.world);
  // The reading itself, on every choice, so the numbers about to be written are seen
  // before anything is: there is no confirmation step after this.
  const f1 = (n: number) => n.toFixed(1);
  const cartText = (c: { x: number; y: number; z: number; w: number; p: number; r: number; ext: number[] } | undefined) =>
    c ? `X ${f1(c.x)}  Y ${f1(c.y)}  Z ${f1(c.z)}  W ${f1(c.w)}  P ${f1(c.p)}  R ${f1(c.r)}${c.ext.length ? '  E' + c.ext.map((e, i) => `${i + 1} ${f1(e)}`).join(' E') : ''}` : '';
  const jointText = current.joint ? current.joint.joints.map((v, i) => `J${i + 1} ${f1(v)}`).join('  ') + (current.joint.ext.length ? '  E' + current.joint.ext.map((e, i) => `${i + 1} ${f1(e)}`).join(' E') : '') : '';
  const reps = [
    { label: '$(location) Cartesian', description: `X Y Z W P R${stored === 'cartesian' ? ` — how P[${index}] is stored now` : ` — P[${index}] is stored as joint angles and will be REWRITTEN`}`, detail: `robot now (UF ${current.frameNo ?? '?'}/UT ${current.toolNo ?? '?'}): ${cartText(current.userFrame ?? current.world)}`, rep: 'cartesian' as const, ok: hasCart },
    { label: '$(settings) Joint angles', description: `J1…Jn${stored === 'joint' ? ` — how P[${index}] is stored now` : ` — P[${index}] is stored as XYZWPR and will be REWRITTEN`}`, detail: `robot now: ${jointText}`, rep: 'joint' as const, ok: hasJoint },
  ].sort((a, b) => Number(b.rep === stored) - Number(a.rep === stored)).filter(r => r.ok);
  if (!reps.length) { vscode.window.showWarningMessage(`${robot} reported neither joint angles nor a cartesian position.`); return undefined; }
  const rep = await vscode.window.showQuickPick(reps, { title: `Teach P[${index}] from ${robot}`, placeHolder: 'Record the position as…' });
  if (!rep) return undefined;

  if (rep.rep === 'joint') {
    const source = sourceFromCurrentPosition(current, 'joint');
    if (!source) { vscode.window.showWarningMessage(`${robot} did not report joint angles.`); return undefined; }
    return { source, explicitFrames: false };
  }

  const ds = s.data.dataset(uri);
  const frames = ds?.frames, tools = ds?.tools;
  const aUf = current.frameNo, aUt = current.toolNo;
  const known = (uf?: number, ut?: number) => uf !== undefined && ut !== undefined && !!frameOrIdentity(frames, uf) && !!frameOrIdentity(tools, ut);
  type FramePick = vscode.QuickPickItem & { uf?: number; ut?: number; explicit: boolean; choose?: boolean };
  const items: FramePick[] = [];
  // what would be written for a given pair of frames, as a preview line
  const preview = (uf: number, ut: number) => {
    const src = cartesianSourceInFrames(current, uf, ut, frames, tools);
    if ('error' in src) return `cannot convert: ${src.error}`;
    const v = src.values;
    return `writes: X ${f1(v.X)}  Y ${f1(v.Y)}  Z ${f1(v.Z)}  W ${f1(v.W)}  P ${f1(v.P)}  R ${f1(v.R)}`;
  };
  if (group?.uf !== undefined && group.ut !== undefined) {
    const same = group.uf === aUf && group.ut === aUt;
    items.push({
      label: `$(tag) Keep P[${index}]'s frames — UF ${group.uf} / UT ${group.ut}`,
      description: same ? 'the robot is in these frames now'
        : known(aUf, aUt) && known(group.uf, group.ut) ? `converted from the robot's UF ${aUf} / UT ${aUt} using sysframe.va`
        : `needs sysframe.va to convert from the robot's UF ${aUf} / UT ${aUt}`,
      detail: preview(group.uf, group.ut),
      uf: group.uf, ut: group.ut, explicit: false,
    });
  }
  if (aUf !== undefined && aUt !== undefined && (group?.uf !== aUf || group?.ut !== aUt)) {
    items.push({ label: `$(debug-step-into) Robot's active frames — UF ${aUf} / UT ${aUt}`, description: `P[${index}] is relabelled to the frames the robot is in now`, detail: preview(aUf, aUt), uf: aUf, ut: aUt, explicit: true });
  }
  if (frames?.size || tools?.size) items.push({ label: '$(list-selection) Choose UF and UT…', description: 'any frame from sysframe.va; the reading is converted into it', explicit: true, choose: true });
  const fpick = items.length === 1 ? items[0] : await vscode.window.showQuickPick(items, { title: `Teach P[${index}] — frames`, placeHolder: 'Record the position against which frames?' });
  if (!fpick) return undefined;

  let uf = fpick.uf, ut = fpick.ut;
  if (fpick.choose) {
    const describe = (f: Xyzwpr) => `X ${f.x.toFixed(1)}  Y ${f.y.toFixed(1)}  Z ${f.z.toFixed(1)}  W ${f.w.toFixed(1)}  P ${f.p.toFixed(1)}  R ${f.r.toFixed(1)}`;
    const ufPick = await vscode.window.showQuickPick(
      [{ label: 'UF 0', description: 'world', index: 0 }, ...[...(frames?.entries() ?? [])].sort((a, b) => a[0] - b[0]).map(([i, f]) => ({ label: `UF ${i}`, description: `${i === aUf ? 'active now · ' : ''}${describe(f)}`, index: i }))],
      { title: `Teach P[${index}] — user frame`, placeHolder: 'Record against which user frame?', matchOnDescription: true });
    if (!ufPick) return undefined;
    const utPick = await vscode.window.showQuickPick(
      [{ label: 'UT 0', description: 'the faceplate (no tool)', index: 0 }, ...[...(tools?.entries() ?? [])].sort((a, b) => a[0] - b[0]).map(([i, f]) => ({ label: `UT ${i}`, description: `${i === aUt ? 'active now · ' : ''}${describe(f)}`, index: i }))],
      { title: `Teach P[${index}] — tool frame`, placeHolder: 'Record with which tool frame?', matchOnDescription: true });
    if (!utPick) return undefined;
    uf = ufPick.index; ut = utPick.index;
  }
  if (uf === undefined || ut === undefined) return undefined;

  const source = cartesianSourceInFrames(current, uf, ut, frames, tools);
  if ('error' in source) { vscode.window.showWarningMessage(source.error); return undefined; }
  return { source, explicitFrames: fpick.explicit || uf !== group?.uf || ut !== group?.ut };
}

/**
 * The current position expressed in UF `uf` with tool `ut`.
 *
 * Straight from the reading when it is already in those frames (the controller reports the
 * active user frame and world directly). Otherwise through world - `world = UF ∘ P`, so any
 * frame the backup states is one conversion away - and then, if the tool differs, held at
 * the same flange pose and re-expressed for the other tool. Every frame used has to be in
 * `sysframe.va`; a frame the backup does not state is an error, not an identity.
 */
function cartesianSourceInFrames(
  current: CurrentPosition, uf: number, ut: number,
  frames: Map<number, Xyzwpr> | undefined, tools: Map<number, Xyzwpr> | undefined,
): TeachSource | { error: string } {
  const aUf = current.frameNo, aUt = current.toolNo;
  const direct = sourceFromCurrentPosition(current, 'cartesian', uf);
  if (direct && (uf === 0 || uf === aUf) && (aUt === undefined || ut === aUt)) return direct;

  // a base reading in world
  let base = sourceFromCurrentPosition(current, 'cartesian', 0);
  let pose: Xyzwpr;
  if (base) pose = { x: base.values.X, y: base.values.Y, z: base.values.Z, w: base.values.W, p: base.values.P, r: base.values.R };
  else {
    base = sourceFromCurrentPosition(current, 'cartesian', aUf);
    if (!base) return { error: 'The robot did not report a cartesian position.' };
    const active = frameOrIdentity(frames, aUf);
    if (!active) return { error: `The robot is in UF ${aUf}, which is not in sysframe.va for this robot, so the reading cannot be converted out of it.` };
    pose = convertUserFrame({ x: base.values.X, y: base.values.Y, z: base.values.Z, w: base.values.W, p: base.values.P, r: base.values.R }, active, IDENTITY);
  }
  const to = frameOrIdentity(frames, uf);
  if (!to) return { error: `UF ${uf} is not defined in sysframe.va for this robot, so the reading cannot be expressed in it.` };
  pose = convertUserFrame(pose, IDENTITY, to);
  if (aUt !== undefined && ut !== aUt) {
    const from = frameOrIdentity(tools, aUt), toTool = frameOrIdentity(tools, ut);
    if (!from) return { error: `The robot's tool UT ${aUt} is not in sysframe.va for this robot.` };
    if (!toTool) return { error: `UT ${ut} is not defined in sysframe.va for this robot.` };
    pose = convertToolFrame(pose, from, toTool);
  }
  return {
    kind: 'cartesian', uf, ut, config: base.config,
    values: { ...base.values, X: pose.x, Y: pose.y, Z: pose.z, W: pose.w, P: pose.p, R: pose.r },
    origin: `${base.origin.replace(/ \(.*\)$/, '')}, converted to UF ${uf}/UT ${ut} from UF ${aUf ?? '?'}/UT ${aUt ?? '?'}`,
  };
}

async function teachFromPosReg(s: FanucServices, index?: number) {
  const ed = tpEditor(); if (!ed) return;
  const prog = s.tp.get(ed.document);
  const target = await resolvePosition(ed, prog, index);
  if (target === undefined) return;

  // Controller data the editor already has, not a read: this is the path that works with
  // no robot on the network at all.
  const regs = s.data.dataset(ed.document.uri)?.posregs;
  const taught = [...(regs?.values() ?? [])].filter(r => r.group === 1 && r.kind !== 'uninit' && Object.keys(r.values).length);
  if (!taught.length) { vscode.window.showInformationMessage('No taught position registers in the controller data for this program (posreg.va).'); return; }

  const pick = await vscode.window.showQuickPick(
    taught.map(r => ({ label: `PR[${r.index}]${r.comment ? `  ${r.comment}` : ''}`, description: `${r.kind} · UF ${r.uf ?? '?'} UT ${r.ut ?? '?'}`, detail: r.summary, reg: r })),
    { placeHolder: `Teach P[${target}] from which position register?`, matchOnDetail: true });
  if (!pick) return;

  const source = sourceFromPosRegValues(pick.reg);
  if (!source) return;
  await applyTeach(ed, s, undefined, undefined, target, source);
}

/**
 * Confirm and apply. Everything that can make a teach silently wrong has already been
 * turned into a blocker by planTeach; this decides what the user is allowed to wave
 * through and what is simply not possible.
 */
async function applyTeach(
  ed: vscode.TextEditor, s: FanucServices, robots: RobotManager | undefined, robot: string | undefined,
  index: number, source: TeachSource, opts: { rewrite?: boolean; explicitFrames?: boolean } = {},
) {
  if (opts.rewrite) { await rewriteRepresentation(ed, s, robots, robot, index, source, 'representation'); return; }

  // Frames the user chose on purpose are not a mismatch to be caught; the point is
  // relabelled to them and the reading was converted into them upstream.
  let plan = planTeach(ed.document.getText(), index, source, { retargetFrames: opts.explicitFrames });
  if (!plan) { vscode.window.showWarningMessage(`P[${index}] is not in this program.`); return; }

  // An untaught point (`UF : F`, `********`) has nothing to edit in place: the block is
  // written afresh from the reading, which is exactly what teaching it means.
  if (plan.blockers.some(b => /no axis values/.test(b))) { await rewriteRepresentation(ed, s, robots, robot, index, source, 'untaught'); return; }

  // A representation mismatch is not an override, it is an impossibility: turning joint
  // angles into XYZWPR needs the robot's kinematic model, which is not in a backup.
  const impossible = plan.blockers.filter(b => /needs the robot's kinematics|no axis values/.test(b));
  if (impossible.length) { await vscode.window.showWarningMessage(impossible[0], { modal: true }); return; }

  if (plan.blockers.length) {
    const frameOnly = plan.blockers.every(b => /user frame|tool frame/.test(b));
    const choices = frameOnly && source.uf !== undefined && source.ut !== undefined
      ? [`Teach anyway, keep UF ${plan.target.uf}/UT ${plan.target.ut}`, `Teach and retarget to UF ${source.uf}/UT ${source.ut}`]
      : ['Teach anyway'];
    const pick = await vscode.window.showWarningMessage(
      `Teaching P[${index}] from ${source.origin} looks wrong.`,
      { modal: true, detail: plan.blockers.join('\n\n') },
      ...choices);
    if (!pick) return;
    plan = planTeach(ed.document.getText(), index, source, { retargetFrames: pick.startsWith('Teach and retarget') })!;
  }

  if (!plan.edits.length) {
    vscode.window.setStatusBarMessage(`$(check) P[${index}] already matches ${source.origin} to the precision stored in the file`, 5000);
    return;
  }

  // No confirmation here, on purpose: everything that could make the teach WRONG was
  // already refused or asked about above, and what remains is an edit to a text file that
  // one Ctrl+Z reverses. A modal for that was a click on every point. The full change list
  // goes to the output channel and the toast offers Undo.
  const applied = await ed.edit(b => {
    for (const e of plan!.edits) b.replace(new vscode.Range(e.line, e.col, e.line, e.col + e.len), e.newText);
  });
  if (!applied) { vscode.window.showErrorMessage(`Could not edit P[${index}] — the file may have changed.`); return; }

  const line = [
    `taught P[${index}] from ${source.origin}:`,
    ...describeChanges(plan).split('\n').map(l => `  ${l}`),
  ].join('\n');
  if (robots && robot) robots.log(robot, line);
  else s.output.appendLine(`[${new Date().toLocaleTimeString()}] ${line}`);

  const moved = plan.changes.filter(c => c.unit === 'mm');
  const dist = Math.hypot(...['X', 'Y', 'Z'].map(a => moved.find(c => c.axis === a)?.delta ?? 0));
  const brief = plan.changes.slice(0, 6).map(c => `${c.axis} ${c.delta >= 0 ? '+' : ''}${round(c.delta)}`).join('  ') + (plan.changes.length > 6 ? ' …' : '');
  vscode.window.setStatusBarMessage(`$(edit) P[${index}] taught · ${brief}${dist ? ` · moved ${round(dist)} mm` : ''} · undo restores it`, 8000);
  const doc = ed.document;
  void vscode.window.showInformationMessage(
    `P[${index}] taught from ${source.origin.replace(/ \(.*\)$/, '')}: ${brief}${dist ? ` · moved ${round(dist)} mm` : ''}${plan.configChange ? ` · CONFIG → '${plan.configChange.to}'` : ''}${plan.warnings.length ? ` · ${plan.warnings.length} note${plan.warnings.length === 1 ? '' : 's'}` : ''}`,
    'Undo', 'Details',
  ).then(async pick => {
    if (pick === 'Details') s.output.show(true);
    if (pick === 'Undo') { await vscode.window.showTextDocument(doc, { preserveFocus: false }); await vscode.commands.executeCommand('undo'); }
  });
}

/**
 * Cartesian ↔ joint: the block is re-emitted rather than edited, so it gets its own
 * confirmation that shows the whole new block. Nothing is converted - the reading already
 * carries both forms - but the old numbers are gone afterwards, which is worth seeing.
 */
async function rewriteRepresentation(ed: vscode.TextEditor, s: FanucServices, robots: RobotManager | undefined, robot: string | undefined, index: number, source: TeachSource, why: 'representation' | 'untaught') {
  const rw = planRewriteBlock(ed.document.getText(), index, source);
  if (!rw) { vscode.window.showWarningMessage(`P[${index}] is not in this program.`); return; }
  if (rw.blockers.length) { await vscode.window.showWarningMessage(`P[${index}] cannot be rewritten.`, { modal: true, detail: rw.blockers.join('\n\n') }); return; }
  const as = source.kind === 'joint' ? 'joint angles' : 'XYZWPR';
  const ok = await vscode.window.showWarningMessage(
    why === 'untaught' ? `Teach the untaught P[${index}] as ${as} from ${source.origin}?` : `Rewrite P[${index}] as ${as} from ${source.origin}?`,
    {
      modal: true,
      detail: [
        why === 'untaught' ? `P[${index}] has never been taught (UF/UT "F", values "********"). Its block becomes:` : `P[${index}] is stored the other way round today. Its whole block is replaced with:`,
        '',
        rw.newText,
        '',
        source.kind === 'joint'
          ? 'Joint angles describe the arm, not a place: this point no longer follows a user frame. The UF/UT written are the ones the robot reported.'
          : `Recorded against UF ${source.uf ?? '?'} / UT ${source.ut ?? '?'}.`,
        '',
        'The program file changes; the robot does not. Undo puts it back.',
      ].join('\n'),
    },
    `Rewrite P[${index}]`);
  if (!ok) return;
  const applied = await ed.edit(b => b.replace(new vscode.Range(rw.line, 0, rw.endLine, ed.document.lineAt(rw.endLine).text.length), rw.newText));
  if (!applied) { vscode.window.showErrorMessage(`Could not rewrite P[${index}] — the file may have changed.`); return; }
  const line = `rewrote P[${index}] as ${as} from ${source.origin}`;
  if (robots && robot) robots.log(robot, line); else s.output.appendLine(`[${new Date().toLocaleTimeString()}] ${line}`);
  vscode.window.setStatusBarMessage(`$(edit) P[${index}] rewritten as ${as} · undo restores it`, 8000);
}

function describeChanges(plan: TeachPlan): string {
  const rows = plan.changes.map(c =>
    `${c.axis.padEnd(3)} ${String(c.from).padStart(11)}  →  ${String(c.to).padStart(11)}   ${c.delta >= 0 ? '+' : ''}${round(c.delta)} ${c.unit}`);
  const dist = Math.hypot(...['X', 'Y', 'Z'].map(a => plan.changes.find(c => c.axis === a)?.delta ?? 0));
  const out = [
    `UF ${plan.target.uf ?? '?'} · UT ${plan.target.ut ?? '?'} · ${plan.target.kind}`,
    '',
    ...rows,
  ];
  if (dist) out.push('', `Tool centre point moves ${round(dist)} mm.`);
  if (plan.configChange) out.push('', `Arm configuration: '${plan.configChange.from}' → '${plan.configChange.to}'`);
  if (plan.warnings.length) out.push('', ...plan.warnings);
  out.push('', 'The program file changes; the robot does not. Undo puts it back.');
  return out.join('\n');
}

// ---------------------------------------------------------------- record a new position

async function recordPosition(ctx: vscode.ExtensionContext, s: FanucServices, robots: RobotManager) {
  const ed = tpEditor(); if (!ed) return;
  const prog = s.tp.get(ed.document);
  if (!posSectionBounds(ed.document.getText())) { vscode.window.showWarningMessage('This program has no /POS section to record into.'); return; }

  const name = await pickConnected(s, robots, ed.document.uri);
  if (!name) return;

  const current = await readCurrentPosition(robots, name);
  if (!current) return;

  // A new point matches the program it is joining, not the robot's mood: if every other
  // position in the file is joint-taught, so is this one.
  const houseKind = prog.positions[0]?.groups[0]?.kind === 'joint' ? 'joint' : 'cartesian';
  const houseUf = prog.positions[0]?.groups[0]?.uf;
  const source = sourceFromCurrentPosition(current, houseKind, houseUf);
  if (!source) { vscode.window.showWarningMessage(`${name} did not report a ${houseKind} position.`); return; }

  if (houseUf !== undefined && source.uf !== undefined && houseUf !== source.uf) {
    const go = await vscode.window.showWarningMessage(
      `The robot is in user frame ${source.uf}; the other points in this program are taught in UF ${houseUf}.`,
      { modal: true, detail: 'The new point will be recorded in the frame the robot is actually in, so it will not match its neighbours.' },
      'Record anyway');
    if (!go) return;
  }

  const index = nextFreePositionIndex(prog.positions.map(p => p.index));
  const comment = await vscode.window.showInputBox({ prompt: `Comment for P[${index}] (optional, 16 characters on the pendant)`, validateInput: v => v.length > 16 ? 'Pendant shows 16 characters' : undefined });
  if (comment === undefined) return;

  const motion = await vscode.window.showQuickPick([
    { label: `J P[${index}] 100% FINE`, description: 'joint move, insert at the cursor', text: `J P[${index}] 100% FINE` },
    { label: `L P[${index}] 500mm/sec CNT100`, description: 'linear move, insert at the cursor', text: `L P[${index}] 500mm/sec CNT100` },
    { label: 'Position data only', description: 'add the point, do not insert a motion line', text: '' },
  ], { placeHolder: `Record P[${index}] as` });
  if (!motion) return;

  // Re-read the section bounds now, not before the prompts: the user has been through a
  // robot read, an input box and a quick pick, and may well have typed in the file.
  const bounds = posSectionBounds(ed.document.getText());
  if (!bounds) { vscode.window.showWarningMessage('The /POS section has gone; nothing was inserted.'); return; }
  const block = buildPositionBlock(ed.document.getText(), index, source, comment || undefined);
  const cursor = ed.selection.active.line;

  const applied = await ed.edit(b => {
    // Both offsets are against the original document — VS Code applies one edit batch, so
    // inserting above /END does not move the cursor line out from under the other insert.
    // The motion line goes in bare: renumber gives it its number and hugs it to the colon,
    // which is how the controller writes motion lines (`   1:L P[1] 2000mm/sec FINE   ;`).
    if (motion.text) b.insert(new vscode.Position(cursor, 0), `${motion.text} ;\n`);
    b.insert(new vscode.Position(bounds.end, 0), `${block}\n`);
  });
  if (!applied) { vscode.window.showErrorMessage('Could not insert the position.'); return; }

  if (motion.text) await vscode.commands.executeCommand('robotCode.tp.renumber');
  robots.log(name, `recorded P[${index}] from current position (${source.kind}, UF ${source.uf ?? '?'}, UT ${source.ut ?? '?'})`);
  vscode.window.setStatusBarMessage(`$(add) P[${index}] recorded from ${name}`, 6000);
}

// ---------------------------------------------------------------- push (the one write)

/** the open local `.ls`, the connected robot it belongs to, and the program's name on the device */
async function localProgram(s: FanucServices, robots: RobotManager, uri?: vscode.Uri): Promise<{ target: vscode.Uri; doc: vscode.TextDocument; name: string; progName: string } | undefined> {
  const target = uri instanceof vscode.Uri ? uri : vscode.window.activeTextEditor?.document.uri;
  if (!target || !/\.ls$/i.test(target.path)) { vscode.window.showInformationMessage('Open a TP (.ls) program first.'); return undefined; }
  if (target.scheme !== 'file') { vscode.window.showInformationMessage('That program is the robot\'s own copy. Download it (Ctrl+Alt+W) to get a local file to work on.'); return undefined; }
  const name = await pickConnected(s, robots, target);
  if (!name) return undefined;
  const doc = await vscode.workspace.openTextDocument(target);
  const progName = (s.tp.get(doc).header.name ?? path.basename(target.fsPath).replace(/\.[^.]+$/, '')).toUpperCase();
  return { target, doc, name, progName };
}

/**
 * Ctrl+Alt+Shift+U: the open program onto the robot (beta list 2, item 6). The one command
 * in this extension that writes to a controller, and it is guarded three ways: it must be
 * switched on (`robotCode.live.upload`), the file is saved and parsed first, and a modal
 * names the robot, the device and the program before anything is sent. A program the
 * controller reports as running or paused is refused here rather than by the controller.
 * Afterwards the program is read back once and compared, so the message says whether
 * what is on the robot is what was sent.
 */
async function uploadProgram(s: FanucServices, robots: RobotManager, uri?: vscode.Uri) {
  if (!config<boolean>('live.upload', true)) { vscode.window.showInformationMessage('Uploading to robots is switched off (robotCode.live.upload).'); return; }
  const lp = await localProgram(s, robots, uri);
  if (!lp) return;
  await sendProgram(s, robots, lp.doc, lp.name, { confirm: true });
}

/**
 * The upload itself, shared by Upload Program (asks first) and Live Edit (asks once, when
 * switched on). The guards that do not depend on asking are always applied: the file is
 * saved and must read as a TP program; a program the robot reports running or paused is
 * refused before anything is sent; every send is logged; the program is read back once.
 * Returns true when the controller took it.
 */
async function sendProgram(s: FanucServices, robots: RobotManager, doc: vscode.TextDocument, name: string, opts: { confirm: boolean; quiet?: boolean }): Promise<boolean> {
  const target = doc.uri;
  const c = robots.get(name);
  if (!c || c.state !== 'connected') { vscode.window.showWarningMessage(`${name} is not connected.`); return false; }
  const progName = (s.tp.get(doc).header.name ?? path.basename(target.fsPath).replace(/\.[^.]+$/, '')).toUpperCase();
  if (doc.isDirty && !(await doc.save())) { vscode.window.showWarningMessage(`${path.basename(target.fsPath)} could not be saved, so it was not uploaded.`); return false; }
  const prog = s.tp.get(doc);
  if (prog.sections.mn === undefined || !prog.header.name) { vscode.window.showWarningMessage(`${path.basename(target.fsPath)} does not read as a TP program (no /PROG name or no /MN section), so it was not uploaded.`); return false; }
  const diags = vscode.languages.getDiagnostics(target).filter(d => d.severity === vscode.DiagnosticSeverity.Error);
  const file = `${progName}.LS`;
  // RUKUS's write lock on the robot holds here too: a robot locked in RUKUS takes no program
  // from the editor either, and the refusal goes into RUKUS's audit log like RUKUS's own.
  const audit = (result: 'Ok' | 'Failed' | 'Refused', durationMs: number, extra: { error?: string; newValue?: string } = {}) => {
    const r = s.rukus;
    if (!r?.available || !r.dataRoot) return;
    try { appendAudit(r.dataRoot.root, { robotName: name, robotAddress: c.profile.host, targetKind: 'Program', targetAddress: `${c.profile.device}${file}`, targetLabel: vscode.workspace.asRelativePath(target), result, origin: opts.confirm ? 'RobotCode/UploadProgram' : 'RobotCode/LiveEdit', durationMs, machineName: os.hostname(), windowsUser: os.userInfo().username, ...extra }); }
    catch (e: any) { robots.log(name, `audit log: could not write to RUKUS's WriteAuditLog.jsonl: ${e?.message ?? e}`); }
  };
  const locked = s.rukus?.available ? s.rukus.robot(name)?.isWriteLocked : false;
  if (locked) {
    audit('Refused', 0, { error: 'robot is write-locked in RUKUS' });
    robots.log(name, `UPLOAD ${file} REFUSED: ${name} is write-locked in RUKUS`);
    vscode.window.showWarningMessage(`${name} is write-locked in RUKUS, so nothing is uploaded to it. Unlock it in RUKUS (Cluster > Edit robot) first.`);
    return false;
  }
  // Read the task states now (one small file), so the guard does not depend on someone having
  // pressed Get on the robot page; a read that fails leaves the controller's own refusal as the guard.
  await robots.fetch(name, ['tasks']).catch(() => undefined);
  const active = robots.activeTpTasks().find(t => t.robot === name && t.task.stack.some(f => f.program.toUpperCase() === progName));
  if (active) { vscode.window.showWarningMessage(`${progName} is ${active.task.status.toLowerCase()} on ${name} (task ${active.task.taskNo}, line ${active.task.current?.line}). The controller will not take a program that is running or paused; abort it on the pendant first.`); return false; }
  // A .LS only loads on a controller with Ascii Upload (R507) or Ascii Program Loader (R796);
  // without either the upload fails with nothing in the reply that says why. Unknown (the option
  // list could not be read) lets the push go on.
  const options = await readControllerOptions(robots, c.profile);
  if (options && !canLoadAscii(options)) {
    robots.log(name, `UPLOAD ${file} REFUSED: ${ORDER_FILE} lists neither ${ASCII_UPLOAD} (Ascii Upload) nor ${ASCII_PROGRAM_LOADER} (Ascii Program Loader)`);
    vscode.window.showWarningMessage(`${name} has neither Ascii Upload (${ASCII_UPLOAD}) nor Ascii Program Loader (${ASCII_PROGRAM_LOADER}), so it cannot load a .LS program and nothing was sent. Load it as a compiled .TP (e.g. from ROBOGUIDE or a backup), or have one of the options added to the controller.`);
    return false;
  }
  // The push gate: fetch the robot's copy and compare it to the snapshot VERBATIM. If the
  // robot moved since the last fetch, the snapshot has never seen that change and pushing
  // would overwrite it, so the push is refused until it is captured. (The working copy is
  // compared to the snapshot separately, normalized, by the tree and the lens.)
  const marker = s.containers.markerForRobot(name);
  // Serialise the network/snapshot phase per container, so two syncs on the same robot cannot
  // interleave (a Fetch pressed a moment before this push used to run at the same time).
  const lockKey = marker ? marker.root.toLowerCase() : `robot:${name.toLowerCase()}`;
  return withSyncLock(lockKey, async () => {
  let isNew = false;
  if (config<boolean>('containers.guardUpload', true) && marker) {
    const gate = await vscode.window.withProgress(
      { location: opts.quiet ? vscode.ProgressLocation.Window : vscode.ProgressLocation.Notification, title: `Comparing ${progName} with the snapshot` },
      () => checkPushGate(s, marker, c, file, target.fsPath));
    if (gate.kind === 'error') {
      const hint = connectionHint(gate.error, c.profile);
      vscode.window.showWarningMessage(`${name} did not report its copy of ${progName}: ${gate.error}.${hint ? ` ${hint}` : ''} The push is held; nothing is sent until the robot's copy can be read.`);
      return false;
    }
    if (gate.kind === 'conflict') {
      await handlePushConflict(s, marker, name, file, doc, gate.robotText, gate.diff);
      return false;
    }
    // a brand-new program: the robot has nothing of that name, so there is nothing to overwrite
    if (gate.kind === 'not-on-robot') isNew = true;
    // the copy just read says it is write-protected: the controller would refuse it, so say why now
    if ((gate.kind === 'ok' || gate.kind === 'no-snapshot') && WRITE_PROTECTED.test(gate.robotText)) {
      robots.log(name, `UPLOAD ${file} REFUSED: ${progName} is write-protected on ${name} (PROTECT = READ)`);
      vscode.window.showWarningMessage(`${progName} is write-protected on ${name} (PROTECT = READ), so the controller would refuse it and nothing was sent. Turn Write protect OFF on the pendant (SELECT, ${progName}, DETAIL), then push again.`);
      return false;
    }
    if (gate.kind === 'no-snapshot') {
      // no baseline yet: the robot's current copy becomes the first snapshot entry
      captureRobotCopy(s, marker, file, gate.robotText);
      await Promise.all([s.data.refresh(), s.index.refresh()]);
    }
  }
  if (opts.confirm) {
    // `containers.gitAware`: note uncommitted changes in the user's own repository before the
    // push and offer Source Control. The git call never blocks the push on its own - a missing
    // git or a file outside a repository reads as "clean" - it only adds a line and a button.
    const dirty = config<boolean>('containers.gitAware', false) && marker
      ? await isFileDirty(path.dirname(target.fsPath), target.fsPath)
      : false;
    const gitNote = dirty ? '\n\nThis program has uncommitted changes in your git repository.' : '';
    const buttons = dirty ? ['Upload', 'Open Source Control'] : ['Upload'];
    const ok = await vscode.window.showWarningMessage(
      `Upload ${progName} to ${name}?`,
      { modal: true, detail: `${file} goes to ${c.profile.device} on ${name} (${c.profile.host}) over FTP ${isNew ? `as a NEW program - ${name} has no ${progName} yet` : 'and REPLACES the program of that name on the controller'}. The controller compiles it as it lands and refuses it if the program is selected on the pendant or write-protected.${diags.length ? `\n\nThis file has ${diags.length} error${diags.length === 1 ? '' : 's'} in Problems.` : ''}${gitNote}\n\nNothing else on the robot changes.` },
      ...buttons);
    if (ok === 'Open Source Control') { await vscode.commands.executeCommand('workbench.view.scm'); return false; }
    if (ok !== 'Upload') return false;
  }
  const text = doc.getText();
  const data = Buffer.from(text.replace(/\r?\n/g, '\r\n'), 'latin1');   // the controller's own line ending
  const started = Date.now();
  const digest = createHash('sha256').update(data).digest('hex').slice(0, 16);
  const policy = config<PullAfterPush>('containers.pullAfterPush', 'always');
  // Upload, read back, verify and sync as one phased push. The controller's copy wins the round
  // trip: an explicit push (not a live-edit save) also writes it back into the working file, so
  // workspace = snapshot = robot.
  let done: CompletePushResult;
  try {
    done = await vscode.window.withProgress(
      { location: opts.quiet ? vscode.ProgressLocation.Window : vscode.ProgressLocation.Notification, title: `Pushing ${progName} to ${name}`, cancellable: false },
      async progress => {
        progress.report({ message: `Uploading ${file}` });
        await robots.writeBinary(c.profile, file, data);
        audit('Ok', Date.now() - started, { newValue: `${data.length} bytes sha256:${digest}` });
        robots.log(name, `UPLOAD ${file} (${data.length} bytes) to ${c.profile.device} - ${vscode.workspace.asRelativePath(target)}${opts.confirm ? '' : ' (live edit)'}`);
        if (!marker) {
          progress.report({ message: "Verifying the controller's copy" });
          const back = await robots.readText(c.profile, file);
          const change = diffProgram(progName, name, target.fsPath, back, text);
          const verdict = !change ? 'read back identical' : change.kind === 'positions-only' ? `read back: ${change.positions.length} position(s) differ` : `read back: ${change.linesAdded} line(s) added, ${change.linesRemoved} removed on the controller's copy`;
          return { ok: true, identical: !change, metadataOnly: false, normalizedDiffers: !!change, pulled: false, decision: 'off' as const, robotText: back, verdict };
        }
        const res = await completePush(s, marker, c, file, text, {
          pull: policy, explicit: opts.confirm, workingPath: target.fsPath, preserveFocus: !!opts.quiet,
          onPhase: message => progress.report({ message }),
        });
        if (res.ok) await Promise.all([s.data.refresh(), s.index.refresh(), s.containers.refresh()]);
        return res;
      });
  } catch (e: any) {
    audit('Failed', Date.now() - started, { error: e?.message ?? String(e), newValue: `${data.length} bytes sha256:${digest}` });
    robots.log(name, `UPLOAD ${file} FAILED: ${e?.message ?? e}`);
    await reportPushFailure(s, c, file, e?.message ?? String(e));
    return false;
  }
  const { verdict, pulled, decision, robotText } = done;
  robots.log(name, `upload ${file}: ${verdict}${pulled ? ' (workspace updated)' : ''}`);
  const summary = `${progName} is on ${name} - ${verdict}${pulled ? ' · workspace updated' : ''}`;
  if (opts.quiet) {
    // live edit: quiet, status bar only
    vscode.window.setStatusBarMessage(`$(cloud-upload) ${summary}`, 8000);
  } else if (pulled && done.normalizedDiffers) {
    // The controller rewrote something the normalized compare counts (line numbers, variable
    // labels, real edits) - not merely a re-stamped DATE/MODIFIED, which is already reported as
    // identical. The working file was synced to the controller's copy; say so and let them look.
    const pick = await vscode.window.showWarningMessage(
      `${progName} pushed to ${name}. The controller's copy differs from what you sent (${verdict}), so the working file was synced to the controller's copy. Ctrl+Z undoes it.`,
      'Show Diff', 'Compare with Snapshot');
    if (pick === 'Show Diff' && robotText !== undefined) await showSentVsControllerDiff(progName, text, robotText);
    else if (pick === 'Compare with Snapshot') void vscode.commands.executeCommand('robotCode.sync.compareFile', target);
  } else if (pulled) {
    // normalized-identical (a metadata-only round trip is identical too): nothing to report
    vscode.window.setStatusBarMessage(`$(cloud-upload) ${summary}`, 8000);
  } else if (decision === 'keep' && robotText !== undefined) {
    const pick = await vscode.window.showWarningMessage(
      `${progName} is on ${name}, but the controller's copy differs from what you sent (${verdict}). Your working file was left unchanged.`,
      'Pull Robot Copy', 'Show Diff');
    if (pick === 'Pull Robot Copy') {
      await writeWorkingCopy(target, robotText, '\n');
      await Promise.all([s.data.refresh(), s.index.refresh()]);
      vscode.window.setStatusBarMessage(`$(cloud-upload) ${progName}: working copy synced to ${name}'s copy · Ctrl+Z undoes it`, 8000);
    } else if (pick === 'Show Diff') {
      await showSentVsControllerDiff(progName, text, robotText);
    }
  } else {
    vscode.window.setStatusBarMessage(`$(cloud-upload) ${summary}`, 8000);
  }
  return true;
  });
}

/** a program's /ATTR saying the controller will not let it be replaced */
const WRITE_PROTECTED = /^\s*PROTECT\s*=\s*READ\s*;/m;

/** A temp diff of what was sent against what the controller read back, for the post-push warning. */
async function showSentVsControllerDiff(progName: string, sent: string, controller: string): Promise<void> {
  const dir = vscode.Uri.file(path.join(os.tmpdir(), 'robot-code-diffs'));
  await vscode.workspace.fs.createDirectory(dir);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const a = vscode.Uri.joinPath(dir, `${progName}_${stamp}_sent.LS`);
  const b = vscode.Uri.joinPath(dir, `${progName}_${stamp}_controller.LS`);
  await vscode.workspace.fs.writeFile(a, Buffer.from(sent, 'latin1'));
  await vscode.workspace.fs.writeFile(b, Buffer.from(controller, 'latin1'));
  await vscode.commands.executeCommand('vscode.diff', a, b, `${progName}: sent ⟷ controller read-back`);
}

/**
 * A push was refused because the robot's copy differs from the snapshot. Offer to capture
 * the robot's change (the reflog keeps the snapshot's old copy), or to look at it first.
 * Nothing is pushed either way - the user fetches, reviews and pushes again.
 */
async function handlePushConflict(s: FanucServices, marker: RobotMarker, robotName: string, file: string, doc: vscode.TextDocument, robotText: string, diff: VerbatimDiff): Promise<void> {
  const n = diff.changed + diff.added + diff.deleted;
  const what = diff.metadataOnly ? 'only metadata (date/time) differs' : `${n} line${n === 1 ? '' : 's'} differ`;
  const pick = await vscode.window.showWarningMessage(
    `The robot's copy of ${file} differs from the snapshot - it changed on the pendant and was never fetched.`,
    {
      modal: true,
      detail: `Verbatim compare: ${what}. Pushing now would overwrite that change, so it is refused.\n\nFetch the robot's copy into the snapshot, review the diff, then push again.${diff.metadataOnly ? '\n\nOnly metadata lines differ, but the gate is verbatim - look before you push.' : ''}`,
    },
    'Update Snapshot from Robot', 'Show Diff');
  if (pick === 'Show Diff') {
    const dir = vscode.Uri.joinPath(vscode.Uri.file(marker.root), ROBOT_DIR, SNAPSHOT_HISTORY_DIR);
    const tmp = vscode.Uri.joinPath(dir, `${historyStamp()}_${file}`);
    await vscode.workspace.fs.createDirectory(dir);
    await vscode.workspace.fs.writeFile(tmp, Buffer.from(robotText, 'latin1'));
    await vscode.commands.executeCommand('vscode.diff', tmp, doc.uri, `${file}: robot (just read) ⟷ your working copy`);
    return;
  }
  if (pick === 'Update Snapshot from Robot') {
    captureRobotCopy(s, marker, file, robotText);
    await Promise.all([s.data.refresh(), s.index.refresh()]);
    vscode.window.setStatusBarMessage(`$(cloud-download) Snapshot: ${file} captured from ${robotName} - review, then push again`, 8000);
  }
}

/**
 * A push the controller refused: report why, and - over HTTP, where the error log can be
 * read - pull the controller's current errors automatically so the reason is right there.
 * With RUKUS installed the Error Watcher is offered instead of a weaker copy here.
 */
async function reportPushFailure(s: FanucServices, conn: { profile: { name: string; useFtp: boolean } }, file: string, message: string): Promise<void> {
  const alarms = conn.profile.useFtp ? [] : await fetchControllerErrors(s, conn as any).catch(() => []);
  const first = alarms[0];
  // The newest alarm is not necessarily this push's (ROBOGUIDE 2026-10-01: a write-protect 550
  // came back with an unrelated SRVO-408 e-stop on top), so it is labelled as such and the hint
  // from the reply itself is always given.
  const alarm = first ? ` Latest controller alarm (may be unrelated): ${[first.code, first.message].filter(Boolean).join(' ')}.` : '';
  const hint = connectionHint(message, conn.profile);
  const buttons = ['Open Output'];
  if (s.rukus?.available) buttons.push('Error Watcher in RUKUS');
  const pick = await vscode.window.showErrorMessage(`${conn.profile.name} did not take ${file}: ${message.replace(/\.?\s*$/, '.')}${hint ? ` ${hint}` : ''}${alarm}`, ...buttons);
  if (pick === 'Open Output') s.output.show(true);
  if (pick === 'Error Watcher in RUKUS') await vscode.commands.executeCommand('robotCode.rukus.alarms', conn.profile.name);
}

/**
 * Live edit (beta list 2, item 3) - the nearest thing to ABB's hot edit a FANUC controller
 * allows from outside: while it is on for a program, EVERY SAVE sends the program to the
 * robot, so the pendant runs what the editor shows. The controller compiles each upload as
 * it lands, and refuses one while that program is selected or running; there is no
 * changing a line of a running program over FTP, and this does not pretend otherwise. The
 * pairing is asked for once, when it is switched on; each save then goes with the same
 * guards as Upload Program minus the modal, and a failed send says so and keeps live edit
 * on. A status bar item shows the pairing and switches it off on click; disconnecting the
 * robot switches it off too.
 */
class LiveEdit implements vscode.Disposable {
  private readonly pairs = new Map<string, string>();   // document uri -> robot name
  private readonly status: vscode.StatusBarItem;
  private readonly subs: vscode.Disposable[] = [];
  private busy = new Set<string>();

  constructor(private readonly s: FanucServices, private readonly robots: RobotManager) {
    this.status = vscode.window.createStatusBarItem('robotCode.liveEdit', vscode.StatusBarAlignment.Left, 49);
    this.status.command = 'robotCode.live.liveEdit';
    this.subs.push(
      this.status,
      vscode.workspace.onDidSaveTextDocument(d => void this.onSave(d)),
      vscode.window.onDidChangeActiveTextEditor(() => this.render()),
      vscode.workspace.onDidCloseTextDocument(d => { if (this.pairs.delete(d.uri.toString())) this.render(); }),
      robots.onDidChange(() => {
        for (const [uri, robot] of [...this.pairs]) if (robots.get(robot)?.state !== 'connected') { this.pairs.delete(uri); robots.log(robot, `live edit off for ${uri.split('/').pop()}: robot disconnected`); }
        this.render();
      }),
    );
  }

  dispose() { for (const d of this.subs) d.dispose(); }

  isOn(doc: vscode.TextDocument): string | undefined { return this.pairs.get(doc.uri.toString()); }

  async toggle(uri?: vscode.Uri): Promise<void> {
    const target = uri instanceof vscode.Uri ? uri : vscode.window.activeTextEditor?.document.uri;
    if (!target || !/\.ls$/i.test(target.path) || target.scheme !== 'file') { vscode.window.showInformationMessage('Live edit works on a local TP (.ls) program.'); return; }
    const key = target.toString();
    const on = this.pairs.get(key);
    if (on) { this.pairs.delete(key); this.robots.log(on, `live edit off for ${path.basename(target.fsPath)}`); this.render(); vscode.window.setStatusBarMessage(`$(circle-slash) Live edit off - ${path.basename(target.fsPath)} stays local`, 5000); return; }
    if (!config<boolean>('live.upload', true)) { vscode.window.showInformationMessage('Uploading to robots is switched off (robotCode.live.upload), so live edit cannot be.'); return; }
    const name = await pickConnected(this.s, this.robots, target);
    if (!name) return;
    const c = this.robots.get(name)!;
    const doc = await vscode.workspace.openTextDocument(target);
    const progName = (this.s.tp.get(doc).header.name ?? path.basename(target.fsPath).replace(/\.[^.]+$/, '')).toUpperCase();
    // pairing is a push: the same verbatim gate, once, before the pairing is made
    const marker = this.s.containers.markerForRobot(name);
    const file = `${progName}.LS`;
    if (config<boolean>('containers.guardUpload', true) && marker) {
      const gate = await checkPushGate(this.s, marker, c, file, target.fsPath);
      if (gate.kind === 'error') { vscode.window.showWarningMessage(`${name} did not report its copy of ${progName}: ${gate.error}. Live edit was not started.`); return; }
      if (gate.kind === 'conflict') { await handlePushConflict(this.s, marker, name, file, doc, gate.robotText, gate.diff); return; }
      if (gate.kind === 'no-snapshot') {
        captureRobotCopy(this.s, marker, file, gate.robotText);
        await Promise.all([this.s.data.refresh(), this.s.index.refresh()]);
      }
    }
    const ok = await vscode.window.showWarningMessage(
      `Live edit ${progName} on ${name}?`,
      { modal: true, detail: `Every save of ${path.basename(target.fsPath)} is sent to ${name} (${c.profile.host}, ${c.profile.device}) and REPLACES ${progName} on the controller - with no further question until you switch it off.\n\nThe controller refuses a program that is selected or running on the pendant, so a save while it runs is reported and not applied; abort the program first.\n\nThe status bar shows the pairing; click it to stop.` },
      'Start live edit');
    if (!ok) return;
    this.pairs.set(key, name);
    this.robots.log(name, `live edit ON for ${path.basename(target.fsPath)} (${progName})`);
    this.render();
    if (doc.isDirty || !(await this.matchesRobot(doc, name, progName))) await sendProgram(this.s, this.robots, doc, name, { confirm: false, quiet: true });
  }

  /** the copy on the robot already is the local text (so a fresh pairing does not upload for nothing) */
  private async matchesRobot(doc: vscode.TextDocument, name: string, progName: string): Promise<boolean> {
    try { const back = await this.robots.readText(this.robots.get(name)!.profile, `${progName}.LS`); return normalizeEol(back) === normalizeEol(doc.getText()); } catch { return false; }
  }

  private async onSave(doc: vscode.TextDocument): Promise<void> {
    const name = this.pairs.get(doc.uri.toString());
    if (!name) return;
    if (this.busy.has(doc.uri.toString())) return;
    this.busy.add(doc.uri.toString());
    try { await sendProgram(this.s, this.robots, doc, name, { confirm: false, quiet: true }); }
    finally { this.busy.delete(doc.uri.toString()); }
  }

  private render() {
    const doc = vscode.window.activeTextEditor?.document;
    const name = doc ? this.pairs.get(doc.uri.toString()) : undefined;
    void vscode.commands.executeCommand('setContext', 'robotCode.liveEditOn', !!name);
    if (!name) { this.status.hide(); return; }
    this.status.text = `$(broadcast) LIVE → ${name}`;
    this.status.tooltip = `Live edit: every save of ${path.basename(doc!.uri.fsPath)} is sent to ${name}. Click to stop.`;
    this.status.color = new vscode.ThemeColor('statusBarItem.warningForeground');
    this.status.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    this.status.show();
  }
}

// ---------------------------------------------------------------- shared

function tpEditor(): vscode.TextEditor | undefined {
  const ed = vscode.window.activeTextEditor;
  if (!ed || ed.document.languageId !== 'fanuc-tp') { vscode.window.showInformationMessage('Open a FANUC TP (.ls) file first.'); return undefined; }
  return ed;
}

/**
 * One fresh `CURPOS.DG`, or nothing.
 *
 * Always a read, never the cached snapshot: teaching from a position the robot left ten
 * minutes ago is exactly the silent mistake the age stamps everywhere else exist to
 * prevent. And `RobotManager.fetch` returns "no failures" without reading anything when
 * that robot is already busy, so the fetch timestamp is checked rather than trusted —
 * otherwise a teach during a refresh would quietly use whatever was in the snapshot.
 */
async function readCurrentPosition(robots: RobotManager, name: string) {
  const c = robots.get(name)!;
  const before = c.snapshot?.fetchedAt.get('position');
  const failed = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: `Reading current position from ${name}` },
    () => robots.fetch(name, ['position']));
  if (failed.length) { void showRecoverableError(`Could not read CURPOS.DG from ${name}.`, { show: () => robots.showLog() }); return undefined; }

  const after = c.snapshot?.fetchedAt.get('position');
  if (after === undefined || after === before) {
    vscode.window.showWarningMessage(`${name} was busy with another read, so the position was not refreshed. Try again in a moment — teaching from a stale reading is not worth the risk.`);
    return undefined;
  }
  const pos = c.snapshot?.position;
  if (!pos) { vscode.window.showErrorMessage(`${name} returned a position file that could not be read.`); return undefined; }
  return pos;
}

/**
 * Which robot to act on for a file. A `fanuc://` document or a file inside a robot container
 * names its own robot: it is used directly and connected on demand, never asked about. Only a
 * file in no container (or whose container names no known robot) is worth a pick.
 */
async function pickConnected(s: FanucServices, robots: RobotManager, near?: vscode.Uri): Promise<string | undefined> {
  const bound = near ? boundRobot(s, near) : undefined;
  const all = robots.list();
  const match = bound ? profileNamed(all, bound.name) : undefined;
  if (match) {
    const name = match.profile.name;
    if (robots.get(name)?.state === 'connected') return name;
    await vscode.commands.executeCommand('robotCode.live.connect', name);
    return robots.get(name)?.state === 'connected' ? name : undefined;
  }
  if (bound?.pinned) {
    const pick = await vscode.window.showWarningMessage(
      `This file is bound to ${bound.name}, but no robot profile of that name exists. Add it in the Controllers view.`,
      'Open Controllers');
    if (pick) await vscode.commands.executeCommand('robotCode.live.focusView');
    return undefined;
  }
  const wanted = bound?.name;
  const list = robots.connected();
  // The one connected robot is the obvious answer ONLY when the file does not name another.
  if (list.length === 1 && !wanted) return list[0].profile.name;
  if (!all.length) { vscode.window.showInformationMessage('No robots are configured. Add one in the Controllers view (+).'); return undefined; }
  const isWanted = (name: string) => name.toLowerCase() === wanted?.toLowerCase();
  const connected = (name: string) => robots.get(name)?.state === 'connected';
  const pick = await vscode.window.showQuickPick(
    all.map(c => ({
      label: connected(c.profile.name) ? `$(check) ${c.profile.name}` : `$(plug) Connect to ${c.profile.name}`,
      description: `${c.profile.host}${connected(c.profile.name) ? ' · connected' : c.state === 'error' ? ` · last attempt failed: ${c.error}` : ''}${isWanted(c.profile.name) ? ' · this file names it' : ''}`,
      name: c.profile.name,
    })).sort((a, b) => Number(isWanted(b.name)) - Number(isWanted(a.name)) || Number(connected(b.name)) - Number(connected(a.name))),
    { placeHolder: wanted && !connected(wanted) ? `No profile matches "${wanted}". Act on which robot?` : list.length ? 'Act on which robot?' : 'No robot is connected. Connect to which one?' });
  if (!pick) return undefined;
  if (!connected(pick.name)) await vscode.commands.executeCommand('robotCode.live.connect', pick.name);
  return connected(pick.name) ? pick.name : undefined;
}

/** the position the cursor is on or in, else ask */
async function resolvePosition(ed: vscode.TextEditor, prog: TpProgram, index?: number): Promise<number | undefined> {
  if (index !== undefined) return index;
  const line = ed.selection.active.line;
  const inBlock = prog.positions.find(p => line >= p.line && line <= p.endLine);
  if (inBlock) return inBlock.index;
  const ref = prog.posRefs.find(r => r.line === line);
  if (ref) return ref.index;
  if (!prog.positions.length) { vscode.window.showInformationMessage('This program has no taught positions.'); return undefined; }
  const pick = await vscode.window.showQuickPick(
    prog.positions.map(p => ({ label: `P[${p.index}]${p.comment ? `  ${p.comment}` : ''}`, description: describeGroup(p.groups[0]), index: p.index })),
    { placeHolder: 'Which position?', matchOnDescription: true });
  return pick?.index;
}

function describeGroup(g?: { uf?: number; ut?: number; kind: 'cartesian' | 'joint' | 'unknown' }): string {
  return frameLabel(g);
}

function round(n: number): string { return (Math.round(n * 1000) / 1000).toString(); }

function normalizeEol(s: string): string { return s.replace(/\r\n/g, '\n').replace(/\s+$/, ''); }
