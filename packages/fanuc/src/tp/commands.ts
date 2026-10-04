import * as vscode from 'vscode';
import * as path from 'node:path';
import { renumber, stripPositions, renumberLabels, commentScaffold, type RenumberOptions } from './renumber';
import { autoRenumberMode, renumberOptions, customOptions, controllerOptions, MODE_LABEL, type AutoRenumberMode } from './renumberSettings';
import { frameLabel, describePosition, type TpProgram } from './parser';
import { findStalePositions, planPositionRemoval } from './cleanup';
import { DEFAULT_HEADER_TEMPLATES, COMMENT_WIDTH, expandHeader, headerPrompts, ruleLine, fanucDate, fanucTime, type HeaderTemplate } from './headers';
import * as os from 'node:os';
import { HEADER_TEMPLATE_KEY, contextChanged } from '../views/statusBar';
import { planOffset, planSetAxes, parsePositionList, parseAxisOffsets, planFrameShift, planMirror, planRelabelFrames } from './teach';
import { frameOrIdentity } from '../data/sysFrameParser';
import { buildProgramText, PROGRAM_SUB_TYPES } from './programTemplates';
import { pickProgramTemplate, resolveTemplateLines, registerInsertTemplate } from './programTemplateCommands';
import type { Xyzwpr } from './frameMath';
import { planRemap, planExtract, planInline, planCombine, applyLineChanges } from './refactor';
import { FanucServices } from '../services';
import { config, spanToRange } from '@core/util';
import { showCallGraph } from './callGraph';
import { planCommentSyncMany, describeSyncPlan } from '@fanuc/tools/commentSync';
import { showProgramFlow } from './flowView';
import { comparePositions } from '@fanuc/tools/positionDiffCommand';
import { callSitesOf } from './providers';

export function registerTpCommands(ctx: vscode.ExtensionContext, s: FanucServices) {
  const auto = new AutoRenumber(s);
  ctx.subscriptions.push(auto);

  const reg = (id: string, fn: (...a: any[]) => any) => ctx.subscriptions.push(vscode.commands.registerCommand(id, fn));

  reg('robotCode.tp.renumber', async () => {
    const ed = tpEditor(); if (!ed) return;
    const n = await auto.apply(ed.document, undefined, true);
    vscode.window.setStatusBarMessage(`Renumbered: ${n} line${n === 1 ? '' : 's'} changed`, 3000);
  });

  // One-shot restyles of the whole program, or of the selected lines when there is a
  // selection. These are the only things that rewrite existing numbering on purpose.
  const selectionRange = (ed: vscode.TextEditor) => ed.selection.isEmpty ? undefined : { start: ed.selection.start.line, end: ed.selection.end.line };
  const oneShot = async (title: string, opts: (ed: vscode.TextEditor) => RenumberOptions) => {
    const ed = tpEditor(); if (!ed) return;
    const n = await auto.apply(ed.document, undefined, true, opts(ed));
    vscode.window.setStatusBarMessage(`${title}: ${n} line${n === 1 ? '' : 's'} changed${selectedLines(ed) ? ' (selection)' : ''}`, 3000);
  };
  reg('robotCode.tp.renumberOnes', () => oneShot('Renumbered to 1:', ed => ({ ...renumberOptions(ed.document), number: 'ones', onlyNew: false, lines: selectionRange(ed) })));
  reg('robotCode.tp.applyCustomStyle', () => oneShot('Custom line style applied', ed => customOptions(ed.document, { onlyNew: false, lines: selectionRange(ed) })));
  reg('robotCode.tp.applyControllerStyle', () => oneShot('Controller numbering applied', ed => controllerOptions(ed.document, { lines: selectionRange(ed) })));

  reg('robotCode.tp.toggleAutoRenumber', async () => {
    // cycles on -> off -> custom -> on
    const cur = autoRenumberMode();
    const next: AutoRenumberMode = cur === 'on' ? 'off' : cur === 'off' ? 'custom' : 'on';
    await vscode.workspace.getConfiguration('robotCode').update('tp.autoRenumber', next, vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage(`Automatic line renumbering: ${MODE_LABEL[next]}.${next === 'custom' ? ' Style is in robotCode.tp.customRenumber.' : ''}`);
  });

  // the positions of this program against another copy of it (another backup, the robot's copy, a file)
  reg('robotCode.tp.comparePositions', () => comparePositions(s));

  // the hover link on a `{controller comment}` decoration inserts it where the controller puts
  // it: R[15]{Speed} becomes R[15:Speed]. Args: [uriString, line, col, comment].
  reg('robotCode.tp.insertRegisterComment', async (uriStr?: string, line?: number, col?: number, comment?: string) => {
    if (!uriStr || line === undefined || col === undefined || !comment) return;
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(uriStr));
    const ed = await vscode.window.showTextDocument(doc, { preserveFocus: false });
    await ed.edit(b => b.insert(new vscode.Position(line, col), `:${comment}`));
  });

  reg('robotCode.tp.gotoLabel', async () => {
    const ed = tpEditor(); if (!ed) return;
    const prog = s.tp.get(ed.document);
    if (!prog.labels.length) { vscode.window.showInformationMessage('No labels in this program.'); return; }
    const pick = await vscode.window.showQuickPick(prog.labels.map(l => ({
      label: `LBL[${l.num}]${l.comment ? `  ${l.comment}` : ''}`,
      description: `line ${l.line + 1} · ${prog.jumps.filter(j => j.num === l.num).length} jumps`,
      line: l.line, col: l.span.col,
    })), { placeHolder: 'Go to label', matchOnDescription: true });
    if (!pick) return;
    const pos = new vscode.Position(pick.line, pick.col);
    ed.selection = new vscode.Selection(pos, pos);
    ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
  });

  reg('robotCode.tp.renumberLabels', async () => {
    const ed = tpEditor(); if (!ed) return;
    const prog = s.tp.get(ed.document);
    if (!prog.labels.length) { vscode.window.showInformationMessage('No labels in this program.'); return; }
    const stepStr = await vscode.window.showInputBox({ prompt: `Renumber ${prog.labels.length} labels in order of appearance. Step:`, value: '10', validateInput: v => /^\d+$/.test(v) && +v >= 1 ? undefined : 'Whole number ≥ 1' });
    if (!stepStr) return;
    const startStr = await vscode.window.showInputBox({ prompt: 'First label number:', value: stepStr, validateInput: v => /^\d+$/.test(v) && +v >= 1 && +v + (prog.labels.length - 1) * +stepStr <= 32767 ? undefined : 'Must fit within 1–32767 for all labels' });
    if (!startStr) return;
    const res = renumberLabels(ed.document.getText(), { start: +startStr, step: +stepStr });
    if (res.indirectJumps) {
      const go = await vscode.window.showWarningMessage(`${res.indirectJumps} indirect jump(s) like JMP LBL[R[n]] cannot be updated automatically; the register values would need changing by hand. Continue?`, { modal: true }, 'Renumber anyway');
      if (!go) return;
    }
    if (!res.edits.length) { vscode.window.showInformationMessage('Labels are already numbered that way.'); return; }
    await ed.edit(b => { for (const e of res.edits) b.replace(new vscode.Range(e.line, e.col, e.line, e.col + e.len), e.newText); });
    vscode.window.setStatusBarMessage(`Renumbered ${res.mapping.length} label(s): ${res.mapping.slice(0, 6).map(m => `${m.from}→${m.to}`).join(', ')}${res.mapping.length > 6 ? '…' : ''}`, 6000);
  });

  reg('robotCode.tp.toggleRemark', async () => {
    const ed = tpEditor(); if (!ed) return;
    const prog = s.tp.get(ed.document);
    const lines = selectedLines(ed);
    await ed.edit(b => {
      for (const ln of lines) {
        const l = prog.lines.find(x => x.line === ln);
        if (!l || !['instruction', 'motion', 'comment', 'remark', 'blank'].includes(l.kind)) continue;
        const text = ed.document.lineAt(ln).text;
        // Skip continuation lines (start with : after whitespace) — parser may not
        // recognise them as continuations when the parent is commented out
        if (text.trimStart().startsWith(':')) continue;
        const afterColon = text.slice(l.bodyCol);
        if (afterColon.startsWith('  //')) b.delete(new vscode.Range(ln, l.bodyCol, ln, l.bodyCol + 4));
        else {
          const oldPos = text.indexOf('//', l.bodyCol);
          if (oldPos >= 0) b.delete(new vscode.Range(ln, oldPos, ln, oldPos + 2));
          else if (l.kind === 'blank') {
            // Blank line: replace spaces before ; with "  // "
            const semiIdx = text.indexOf(';', l.bodyCol);
            const insertAt = semiIdx >= 0 ? semiIdx : text.length;
            b.replace(new vscode.Range(ln, l.bodyCol, ln, insertAt), '  // ');
          } else {
            const bodyStart = l.bodyCol + (afterColon.length - afterColon.trimStart().length);
            const commentPos = Math.max(bodyStart, l.bodyCol + 2);
            if (commentPos > bodyStart) b.insert(new vscode.Position(ln, bodyStart), ' '.repeat(commentPos - bodyStart) + '//');
            else b.insert(new vscode.Position(ln, commentPos), '//');
          }
        }
      }
    });
  });

  /**
   * The `tp.commentMismatch` quick fix for every reference at once - this file, or every
   * program of this robot's backup. One WorkspaceEdit, so it is one undo per file.
   */
  reg('robotCode.tp.syncCommentsFromController', async () => {
    const ed = tpEditor(); if (!ed) return;
    const ds = s.data.dataset(ed.document.uri);
    if (!ds) { vscode.window.showInformationMessage('No controller data (numreg.va, diocfgsv.va…) is matched to this file, so there are no controller comments to sync from.'); return; }
    const where = await vscode.window.showQuickPick([
      { label: '$(file) This file', description: path.basename(ed.document.uri.fsPath), where: 'file' as const },
      { label: '$(files) Every program in this backup', description: ds.label, where: 'backup' as const },
    ], { placeHolder: 'Rewrite inline register / I/O comments to the controller\'s comments in…' });
    if (!where) return;
    const targets = where.where === 'file' ? [{ uri: ed.document.uri, name: path.basename(ed.document.uri.fsPath) }]
      : s.index.list(ed.document.uri).filter(p => p.kind === 'tp' && p.group === s.index.groupOf(ed.document.uri)).map(p => ({ uri: p.uri, name: p.name }));
    const docs: Array<{ name: string; doc: vscode.TextDocument }> = [];
    for (const t of targets) { try { docs.push({ name: t.name, doc: await vscode.workspace.openTextDocument(t.uri) }); } catch { /* skip unreadable */ } }
    const planned = planCommentSyncMany(docs.map(d => ({ name: d.name, prog: s.tp.get(d.doc) })), ds);
    if (!planned.total) { vscode.window.showInformationMessage(`Every inline comment already matches the controller (${docs.length} program${docs.length === 1 ? '' : 's'} checked).`); return; }
    const examples = planned.programs.flatMap(p => p.plan.edits.slice(0, 3).map(e => `${p.name}: ${e.kind}[${e.index}:${e.oldText}] → ${e.newText}`)).slice(0, 6);
    const go = await vscode.window.showWarningMessage(
      `Rewrite ${describeSyncPlan(planned.total, planned.programs.length, planned.byKind)}?`,
      { modal: true, detail: `${examples.join('\n')}${planned.total > examples.length ? `\n… and ${planned.total - examples.length} more` : ''}\n\nOne undo per file reverses it.` },
      'Rewrite');
    if (go !== 'Rewrite') return;
    const we = new vscode.WorkspaceEdit();
    const byName = new Map(docs.map(d => [d.name, d.doc]));
    for (const p of planned.programs) {
      const doc = byName.get(p.name)!;
      for (const e of p.plan.edits) we.replace(doc.uri, new vscode.Range(e.line, e.col, e.line, e.col + e.len), e.newText);
    }
    const ok = await vscode.workspace.applyEdit(we);
    vscode.window.showInformationMessage(ok ? `Rewrote ${describeSyncPlan(planned.total, planned.programs.length, planned.byKind)}. Files are modified, not saved.` : 'The edit could not be applied.');
  });

  reg('robotCode.tp.insertBanner', async () => {
    const ed = tpEditor(); if (!ed) return;
    const text = await vscode.window.showInputBox({ prompt: 'Banner text', placeHolder: 'PICK SEQUENCE', validateInput: v => v.length > 32 ? 'Pendant shows 32 characters per comment' : undefined });
    if (text === undefined) return;
    const line = ed.selection.active.line;
    const width = config<number>('tp.lineNumberWidth', 4);
    const pad = ' '.repeat(width + 1) + '  ';
    const banner = [`${pad}!${'-'.repeat(32)} ;`, `${pad}!${text.toUpperCase()} ;`, `${pad}!${'-'.repeat(32)} ;`, ''].join('\n');
    await ed.edit(b => b.insert(new vscode.Position(line, 0), banner));
    await auto.apply(ed.document, undefined, true);
  });

  /**
   * A customer's header block, from `robotCode.tp.headerTemplates`. The program's own
   * facts fill themselves in; anything else the template names is asked for, once each.
   */
  reg('robotCode.tp.insertHeader', async () => {
    const ed = tpEditor(); if (!ed) return;
    const prog = s.tp.get(ed.document);
    const built = await buildHeader(ctx, s, ed.document.uri, prog.header.name, prog.header.attrs.get('COMMENT')?.value.replace(/^"|"$/g, ''));
    if (!built) return;
    // Into /MN: at the cursor when it is inside the body, else at the top of the body.
    const cursor = ed.selection.active.line;
    const mn = prog.sections.mn;
    const end = prog.sections.pos ?? prog.sections.end ?? ed.document.lineCount;
    const at = mn !== undefined && cursor > mn && cursor < end ? cursor : mn !== undefined ? mn + 1 : cursor;
    const width = config<number>('tp.lineNumberWidth', 4);
    const pad = ' '.repeat(width + 1) + '  ';
    await ed.edit(b => b.insert(new vscode.Position(at, 0), built.map(l => `${pad}!${l} ;`).join('\n') + '\n'));
    await auto.apply(ed.document, undefined, true);
  });

  reg('robotCode.tp.convertMotion', async () => {
    const ed = tpEditor(); if (!ed) return;
    const prog = s.tp.get(ed.document);
    const targets = selectedLines(ed).map(ln => prog.lines.find(l => l.line === ln)).filter(l => l?.motion && (l.motion.type === 'J' || l.motion.type === 'L') && l.kind === 'motion');
    if (!targets.length) { vscode.window.showInformationMessage('Select J or L motion lines first.'); return; }
    const dir = await vscode.window.showQuickPick([
      { label: 'J → L', description: 'Joint to Linear', to: 'L' as const },
      { label: 'L → J', description: 'Linear to Joint', to: 'J' as const },
      { label: 'Swap each', description: 'J becomes L and L becomes J', to: 'swap' as const },
    ], { placeHolder: 'Conversion' });
    if (!dir) return;
    const needsLinear = dir.to === 'L' || dir.to === 'swap';
    const needsJoint = dir.to === 'J' || dir.to === 'swap';
    const linSpeed = needsLinear ? await vscode.window.showInputBox({ prompt: 'Linear speed for converted lines (mm/sec)', value: '500', validateInput: v => /^\d+$/.test(v) ? undefined : 'Enter a whole number' }) : '500';
    if (linSpeed === undefined) return;
    const jntSpeed = needsJoint ? await vscode.window.showInputBox({ prompt: 'Joint speed for converted lines (%)', value: '100', validateInput: v => /^\d+$/.test(v) && +v >= 1 && +v <= 100 ? undefined : '1–100' }) : '100';
    if (jntSpeed === undefined) return;
    await ed.edit(b => {
      for (const l of targets) {
        const m = l!.motion!;
        const to = dir.to === 'swap' ? (m.type === 'J' ? 'L' : 'J') : dir.to;
        if (to === m.type) continue;
        b.replace(new vscode.Range(l!.line, l!.bodyCol, l!.line, l!.bodyCol + 1), to);
        if (m.speed && /^\d/.test(m.speed.value)) b.replace(spanToRange(m.speed.span), to === 'L' ? `${linSpeed}mm/sec` : `${jntSpeed}%`);
      }
    });
  });

  reg('robotCode.tp.scaleSpeeds', async () => {
    const ed = tpEditor(); if (!ed) return;
    const prog = s.tp.get(ed.document);
    const targets = selectedLines(ed).map(ln => prog.lines.find(l => l.line === ln)).filter(l => l?.motion?.speed && /^\d/.test(l.motion.speed.value));
    if (!targets.length) { vscode.window.showInformationMessage('Select motion lines with numeric speeds first.'); return; }
    const factor = await vscode.window.showInputBox({ prompt: `Scale ${targets.length} speed(s) by percent (e.g. 50 halves them, 200 doubles them)`, value: '50', validateInput: v => /^\d+(\.\d+)?$/.test(v) && +v > 0 ? undefined : 'Enter a positive number' });
    if (!factor) return;
    const f = parseFloat(factor) / 100;
    await ed.edit(b => {
      for (const l of targets) {
        const sp = l!.motion!.speed!;
        let v = parseFloat(sp.value) * f;
        if (sp.unit === '%') v = Math.min(100, Math.max(1, Math.round(v)));
        else if (sp.unit === 'sec' || sp.unit === 'msec') v = Math.max(sp.unit === 'sec' ? 0.1 : 1, Math.round(v * 10) / 10);
        else v = Math.max(1, Math.round(v));
        b.replace(spanToRange(sp.span), `${v}${sp.unit}`);
      }
    });
  });

  reg('robotCode.tp.setTermination', async () => {
    const ed = tpEditor(); if (!ed) return;
    const prog = s.tp.get(ed.document);
    const targets = selectedLines(ed).map(ln => prog.lines.find(l => l.line === ln)).filter(l => l?.motion?.speed);
    if (!targets.length) { vscode.window.showInformationMessage('Select motion lines first.'); return; }
    const pick = await vscode.window.showQuickPick(['FINE', 'CNT100', 'CNT50', 'CNT25', 'CNT0', 'Custom…'], { placeHolder: 'Termination type' });
    if (!pick) return;
    let term = pick;
    if (pick === 'Custom…') {
      const v = await vscode.window.showInputBox({ prompt: 'Termination (FINE, CNTn, CDn, CRn)', validateInput: x => /^(FINE|CNT\d{1,3}|CD\d{1,3}|CR\d{1,3})$/.test(x) ? undefined : 'FINE or CNT0–100' });
      if (!v) return; term = v;
    }
    await ed.edit(b => {
      for (const l of targets) {
        const m = l!.motion!;
        if (m.termination) b.replace(spanToRange(m.termination.span), term);
        else if (m.speed) b.insert(new vscode.Position(l!.line, m.speed.span.col + m.speed.span.len), ` ${term}`);
      }
    });
  });

  /**
   * Shift taught positions by a fixed amount — the answer to "the fixture moved 3 mm",
   * which otherwise means re-jogging every point on the pendant.
   *
   * Same byte-exact surgery as teaching, so untouched axes keep their formatting and an
   * offset of zero changes nothing. The offset is applied in each point's OWN user frame;
   * mixed frames in one selection are called out rather than quietly averaged.
   */
  reg('robotCode.tp.offsetPositions', async () => {
    const ed = tpEditor(); if (!ed) return;
    const prog = s.tp.get(ed.document);
    if (!prog.positions.length) { vscode.window.showInformationMessage('This program has no taught positions.'); return; }

    const picked = await pickOffsetTargets(ed, prog);
    if (!picked?.length) return;

    const raw = await vscode.window.showInputBox({
      title: `Offset ${picked.length} position${picked.length === 1 ? '' : 's'}`,
      prompt: 'Offset, in each point’s own user frame. e.g. "X=3 Y=-1.5", "Z 10", "3 0 -1.5" (X Y Z), "E1=250"',
      placeHolder: 'X=0 Y=0 Z=0',
      validateInput: v => (v.trim() === '' || parseAxisOffsets(v) ? undefined : 'Could not read that. Try "X=3 Y=-1.5" or "3 0 -1.5".'),
    });
    if (!raw) return;
    const deltas = parseAxisOffsets(raw);
    if (!deltas) return;

    const text = ed.document.getText();
    const plans = picked.map(i => planOffset(text, i, deltas)).filter(Boolean) as ReturnType<typeof planOffset>[];
    const blocked = plans.filter(p => p!.blockers.length);
    const usable = plans.filter(p => !p!.blockers.length);
    const edits = usable.flatMap(p => p!.edits);
    const frames = new Set(usable.map(p => p!.target.uf));

    if (!edits.length) {
      vscode.window.showInformationMessage(blocked.length
        ? `Nothing to offset: ${blocked[0]!.blockers[0]}`
        : 'That offset changes nothing at the precision these positions are stored with.');
      return;
    }

    const detail = [
      `${usable.filter(p => p!.edits.length).length} position(s) move by ${Object.entries(deltas).map(([a, v]) => `${a} ${v >= 0 ? '+' : ''}${v}`).join(', ')}.`,
      '',
      ...usable.filter(p => p!.edits.length).slice(0, 8).map(p =>
        `P[${p!.target.index}]  UF ${p!.target.uf ?? '?'}  ${p!.changes.map(c => `${c.axis} ${c.from} → ${c.to}`).join('  ')}`),
      ...(usable.filter(p => p!.edits.length).length > 8 ? ['…'] : []),
    ];
    if (frames.size > 1) {
      detail.push('', `These positions are taught in ${frames.size} different user frames (${[...frames].map(f => `UF ${f ?? '?'}`).join(', ')}). The offset is applied in each point’s own frame, so it does NOT move them all the same way in the cell.`);
    }
    if (blocked.length) detail.push('', `${blocked.length} position(s) skipped:`, ...blocked.slice(0, 3).map(p => `  P[${p!.target.index}]: ${p!.blockers[0]}`));
    const warns = usable.flatMap(p => p!.warnings);
    if (warns.length) detail.push('', ...warns.slice(0, 3));
    detail.push('', 'The program file changes; the robot does not. Undo puts it back.');

    const ok = await vscode.window.showWarningMessage(`Offset ${usable.filter(p => p!.edits.length).length} position(s)?`, { modal: true, detail: detail.join('\n') }, 'Offset');
    if (!ok) return;

    const applied = await ed.edit(b => { for (const e of edits) b.replace(new vscode.Range(e.line, e.col, e.line, e.col + e.len), e.newText); });
    if (!applied) { vscode.window.showErrorMessage('Could not apply the offset.'); return; }
    s.output.appendLine(`[${new Date().toLocaleTimeString()}] offset ${usable.filter(p => p!.edits.length).length} position(s) in ${prog.header.name ?? ed.document.fileName} by ${JSON.stringify(deltas)}${blocked.length ? `; ${blocked.length} skipped` : ''}`);
    vscode.window.setStatusBarMessage(`$(move) ${usable.filter(p => p!.edits.length).length} position(s) offset · undo restores them`, 8000);
  });

  /**
   * Set axis values on many positions at once, adding extended axes a position lacks
   * (beta list 4, item 8): "E1=0" on P[1]-P[9] gives each of them an `E1=     0.000  mm`.
   */
  reg('robotCode.tp.setAxisValues', async () => {
    const ed = tpEditor(); if (!ed) return;
    const prog = s.tp.get(ed.document);
    if (!prog.positions.length) { vscode.window.showInformationMessage('This program has no taught positions.'); return; }
    const picked = await pickOffsetTargets(ed, prog);
    if (!picked?.length) return;

    const raw = await vscode.window.showInputBox({
      title: `Set axis values on ${picked.length} position${picked.length === 1 ? '' : 's'}`,
      prompt: 'Axis = value. An extended axis (E1-E3) a position does not have is added. e.g. "E1=0", "E1=0 E2=90", "Z=500"',
      placeHolder: 'E1=0',
      validateInput: v => (v.trim() === '' || (parseAxisOffsets(v) && /[A-Z]/i.test(v)) ? undefined : 'Name the axis: "E1=0", "Z=500".'),
    });
    if (!raw) return;
    const values = parseAxisOffsets(raw);
    if (!values) return;

    const text = ed.document.getText();
    const units: Record<string, 'mm' | 'deg'> = {};
    // only ask the unit for an extended axis that will actually be ADDED somewhere
    for (const axis of Object.keys(values).filter(a => /^E\d+$/.test(a))) {
      const adds = picked.some(i => { const p = planSetAxes(text, i, { [axis]: values[axis] }); return p && !p.blockers.length && !p.target.axes.includes(axis); });
      if (!adds) continue;
      const unit = await vscode.window.showQuickPick([
        { label: 'mm', description: 'linear axis (rail, track)', unit: 'mm' as const },
        { label: 'deg', description: 'rotary axis (turntable, positioner)', unit: 'deg' as const },
      ], { placeHolder: `${axis} is added where a position has none - what kind of axis is it?` });
      if (!unit) return;
      units[axis] = unit.unit;
    }

    const plans = picked.map(i => planSetAxes(text, i, values, units)).filter(Boolean) as NonNullable<ReturnType<typeof planSetAxes>>[];
    const blocked = plans.filter(p => p.blockers.length);
    const usable = plans.filter(p => !p.blockers.length && p.edits.length);
    if (!usable.length) {
      vscode.window.showInformationMessage(blocked.length ? `Nothing to change: ${blocked[0].blockers[0]}` : 'Those positions already have those values.');
      return;
    }
    const detail = [
      ...usable.slice(0, 8).map(p => `P[${p.target.index}]  ${p.changes.map(c => p.target.axes.includes(c.axis) ? `${c.axis} ${c.from} → ${c.to}` : `+ ${c.axis} ${c.to} ${c.unit}`).join('  ')}`),
      ...(usable.length > 8 ? ['…'] : []),
    ];
    if (blocked.length) detail.push('', `${blocked.length} position(s) skipped:`, ...blocked.slice(0, 3).map(p => `  P[${p.target.index}]: ${p.blockers[0]}`));
    const warns = plans.flatMap(p => p.warnings);
    if (warns.length) detail.push('', ...warns.slice(0, 3));
    detail.push('', 'The program file changes; the robot does not. Undo puts it back.');
    const ok = await vscode.window.showWarningMessage(`Change ${usable.length} position(s)?`, { modal: true, detail: detail.join('\n') }, 'Change');
    if (!ok) return;

    const edits = usable.flatMap(p => p.edits);
    const applied = await ed.edit(b => { for (const e of edits) b.replace(new vscode.Range(e.line, e.col, e.line, e.col + e.len), e.newText); });
    if (!applied) { vscode.window.showErrorMessage('Could not change the positions.'); return; }
    s.output.appendLine(`[${new Date().toLocaleTimeString()}] set ${JSON.stringify(values)} on ${usable.length} position(s) in ${prog.header.name ?? ed.document.fileName}${blocked.length ? `; ${blocked.length} skipped` : ''}`);
    vscode.window.setStatusBarMessage(`$(edit) ${usable.length} position(s) changed · undo restores them`, 8000);
  });

  /**
   * Re-express taught positions against a different user or tool frame.
   *
   * The robot does not move and the points do not move in the cell — the same places are
   * written down against a different reference. That is worth stating loudly in the
   * confirmation, because the numbers can change by metres and look alarming.
   *
   * No kinematics involved: the frames come from the robot's own sysframe.va.
   */
  reg('robotCode.tp.convertFrame', async () => {
    const ed = tpEditor(); if (!ed) return;
    const prog = s.tp.get(ed.document);
    if (!prog.positions.length) { vscode.window.showInformationMessage('This program has no taught positions.'); return; }

    const data = s.data.dataset(ed.document.uri);
    if (!data || (!data.frames.size && !data.tools.size)) {
      vscode.window.showWarningMessage(
        'No user or tool frames are loaded for this robot. Frame conversion reads them from sysframe.va — add the robot’s backup folder to robotCode.data.backupFolders, or open the program from inside it.');
      return;
    }

    const picked = await pickOffsetTargets(ed, prog);
    if (!picked?.length) return;

    const describe = (n: number, f: Xyzwpr | undefined) =>
      f ? `X ${f.x.toFixed(1)}  Y ${f.y.toFixed(1)}  Z ${f.z.toFixed(1)}  W ${f.w.toFixed(1)}  P ${f.p.toFixed(1)}  R ${f.r.toFixed(1)}` : 'not set on this controller';

    const what = await vscode.window.showQuickPick([
      { label: 'User frame', description: 'express these points against a different UF', which: 'uf' as const },
      { label: 'Tool frame', description: 'express these points as if a different UT had been active', which: 'ut' as const },
    ], { placeHolder: 'Convert which frame?' });
    if (!what) return;

    const table = what.which === 'uf' ? data.frames : data.tools;
    const label = what.which === 'uf' ? 'UF' : 'UT';
    const items = [
      { label: `${label} 0`, description: what.which === 'uf' ? 'world' : 'the faceplate (no tool)', index: 0 },
      ...[...table.entries()].sort((a, b) => a[0] - b[0]).map(([i, f]) => ({ label: `${label} ${i}`, description: describe(i, f), index: i })),
    ];
    const to = await vscode.window.showQuickPick(items, { placeHolder: `Express the selected positions in which ${what.label.toLowerCase()}?`, matchOnDescription: true });
    if (!to) return;

    const text = ed.document.getText();
    const plans: Array<{ index: number; plan: ReturnType<typeof planFrameShift> }> = [];
    const unknown: number[] = [];
    for (const i of picked) {
      const pos = prog.positions.find(p => p.index === i);
      const g = pos?.groups[0];
      if (!g) continue;
      const fromIdx = what.which === 'uf' ? g.uf : g.ut;
      const fromFrame = frameOrIdentity(table, fromIdx);
      const toFrame = frameOrIdentity(table, to.index);
      if (!fromFrame || !toFrame) { unknown.push(i); continue; }
      const spec = what.which === 'uf'
        ? { fromUf: fromFrame, toUf: toFrame, toUfNumber: to.index }
        : { fromUt: fromFrame, toUt: toFrame, toUtNumber: to.index };
      const plan = planFrameShift(text, i, spec);
      if (plan) plans.push({ index: i, plan });
    }

    const blocked = plans.filter(p => p.plan!.blockers.length);
    const usable = plans.filter(p => !p.plan!.blockers.length && p.plan!.edits.length);
    const edits = usable.flatMap(p => p.plan!.edits);

    if (!edits.length) {
      vscode.window.showInformationMessage(blocked.length
        ? `Nothing to convert: ${blocked[0].plan!.blockers[0]}`
        : `Those positions are already expressed in ${label} ${to.index}.`);
      return;
    }

    const detail = [
      `${usable.length} position(s) re-expressed in ${label} ${to.index}.`,
      '',
      'THE ROBOT DOES NOT MOVE. These points stay exactly where they are in the cell — only',
      'the frame they are written against changes, so the numbers can jump by a long way.',
      '',
      ...usable.slice(0, 6).map(p => {
        const c = p.plan!.changes;
        const get = (a: string) => c.find(x => x.axis === a);
        const f = (a: string) => { const x = get(a); return x ? `${a} ${x.from} → ${x.to}` : ''; };
        return `P[${p.index}]  ${['X', 'Y', 'Z'].map(f).filter(Boolean).join('  ')}`;
      }),
      ...(usable.length > 6 ? ['…'] : []),
    ];
    if (unknown.length) detail.push('', `P[${unknown.join('], P[')}] skipped: their current ${label} is not defined in sysframe.va.`);
    if (blocked.length) detail.push('', `${blocked.length} skipped:`, ...blocked.slice(0, 2).map(p => `  P[${p.index}]: ${p.plan!.blockers[0]}`));
    const warns = [...new Set(usable.flatMap(p => p.plan!.warnings))];
    if (warns.length) detail.push('', ...warns.slice(0, 2));
    detail.push('', 'The program file changes; the robot does not. Undo puts it back.');

    const ok = await vscode.window.showWarningMessage(
      `Re-express ${usable.length} position(s) in ${label} ${to.index}?`, { modal: true, detail: detail.join('\n') }, `Convert to ${label} ${to.index}`);
    if (!ok) return;

    const applied = await ed.edit(b => { for (const e of edits) b.replace(new vscode.Range(e.line, e.col, e.line, e.col + e.len), e.newText); });
    if (!applied) { vscode.window.showErrorMessage('Could not apply the conversion.'); return; }
    s.output.appendLine(`[${new Date().toLocaleTimeString()}] converted ${usable.length} position(s) to ${label} ${to.index} in ${prog.header.name ?? ed.document.fileName}`);
    vscode.window.setStatusBarMessage(`$(references) ${usable.length} position(s) now in ${label} ${to.index} · same place, different frame · undo restores them`, 8000);
  });

  /**
   * Reflect positions across a plane — the left-hand/right-hand cell job.
   *
   * The plane belongs to a frame, and which frame is not a detail: mirroring across a
   * cell's own centreline is a different operation from mirroring across the robot's world
   * plane, so it is asked rather than assumed.
   */
  reg('robotCode.tp.mirrorPositions', async () => {
    const ed = tpEditor(); if (!ed) return;
    const prog = s.tp.get(ed.document);
    if (!prog.positions.length) { vscode.window.showInformationMessage('This program has no taught positions.'); return; }

    const picked = await pickOffsetTargets(ed, prog);
    if (!picked?.length) return;

    const plane = await vscode.window.showQuickPick([
      { label: 'XZ plane', description: 'flips Y — the usual left/right mirror', value: 'XZ' as const },
      { label: 'YZ plane', description: 'flips X', value: 'YZ' as const },
      { label: 'XY plane', description: 'flips Z — up/down', value: 'XY' as const },
    ], { placeHolder: 'Reflect across which plane?' });
    if (!plane) return;

    const data = s.data.dataset(ed.document.uri);
    const frameChoices = [
      { label: 'Each point’s own user frame', description: 'mirror within the frame the point is taught in', index: undefined as number | undefined },
      { label: 'World (UF 0)', description: 'mirror across the robot’s world plane', index: 0 },
      ...[...(data?.frames.entries() ?? [])].sort((a, b) => a[0] - b[0]).map(([i, f]) => ({
        label: `UF ${i}`, description: `X ${f.x.toFixed(1)} Y ${f.y.toFixed(1)} Z ${f.z.toFixed(1)}`, index: i as number | undefined,
      })),
    ];
    const inFrame = await vscode.window.showQuickPick(frameChoices, { placeHolder: `The ${plane.label} of which frame?`, matchOnDescription: true });
    if (!inFrame) return;

    const text = ed.document.getText();
    const plans: Array<{ index: number; plan: ReturnType<typeof planMirror> }> = [];
    for (const i of picked) {
      const g = prog.positions.find(p => p.index === i)?.groups[0];
      if (!g) continue;
      let via: { from: Xyzwpr; to: Xyzwpr } | undefined;
      if (inFrame.index !== undefined) {
        const own = frameOrIdentity(data?.frames, g.uf);
        const other = frameOrIdentity(data?.frames, inFrame.index);
        if (!own || !other) continue;
        via = { from: own, to: other };
      }
      const plan = planMirror(text, i, plane.value, via);
      if (plan) plans.push({ index: i, plan });
    }

    const blocked = plans.filter(p => p.plan!.blockers.length);
    const usable = plans.filter(p => !p.plan!.blockers.length && p.plan!.edits.length);
    const edits = usable.flatMap(p => p.plan!.edits);
    if (!edits.length) {
      vscode.window.showInformationMessage(blocked.length ? `Nothing to mirror: ${blocked[0].plan!.blockers[0]}` : 'Mirroring those positions changes nothing.');
      return;
    }

    const detail = [
      `${usable.length} position(s) reflected across the ${plane.label} of ${inFrame.label.toLowerCase()}.`,
      '',
      'These points MOVE — this is a new path on the other side of the plane, not the same',
      'one described differently.',
      '',
      ...usable.slice(0, 6).map(p => `P[${p.index}]  ${p.plan!.changes.map(c => `${c.axis} ${c.from} → ${c.to}`).join('  ')}`),
      ...(usable.length > 6 ? ['…'] : []),
    ];
    const warns = [...new Set(usable.flatMap(p => p.plan!.warnings))];
    if (warns.length) detail.push('', ...warns.slice(0, 2));
    if (blocked.length) detail.push('', `${blocked.length} skipped:`, ...blocked.slice(0, 2).map(p => `  P[${p.index}]: ${p.plan!.blockers[0]}`));
    detail.push('', 'The program file changes; the robot does not. Undo puts it back.');

    const ok = await vscode.window.showWarningMessage(`Mirror ${usable.length} position(s)?`, { modal: true, detail: detail.join('\n') }, 'Mirror');
    if (!ok) return;
    const applied = await ed.edit(b => { for (const e of edits) b.replace(new vscode.Range(e.line, e.col, e.line, e.col + e.len), e.newText); });
    if (!applied) { vscode.window.showErrorMessage('Could not apply the mirror.'); return; }
    s.output.appendLine(`[${new Date().toLocaleTimeString()}] mirrored ${usable.length} position(s) across ${plane.value} of ${inFrame.label}`);
    vscode.window.setStatusBarMessage(`$(mirror) ${usable.length} position(s) mirrored · check CONFIG on the pendant · undo restores them`, 8000);
  });

  /**
   * Change the UF/UT a position claims, leaving the numbers alone.
   *
   * The opposite of converting, and the confirmation has to make that unmissable: the point
   * WILL be somewhere else in the cell afterwards. It is the right tool for exactly one job —
   * a point whose numbers are right and whose frame label is wrong.
   */
  reg('robotCode.tp.relabelFrames', async () => {
    const ed = tpEditor(); if (!ed) return;
    const prog = s.tp.get(ed.document);
    if (!prog.positions.length) { vscode.window.showInformationMessage('This program has no taught positions.'); return; }

    const picked = await pickOffsetTargets(ed, prog);
    if (!picked?.length) return;

    const ufStr = await vscode.window.showInputBox({
      title: 'Relabel frames — the numbers do NOT change',
      prompt: 'New UF number, or leave empty to keep it',
      validateInput: v => (v === '' || /^\d+$/.test(v) ? undefined : 'A whole number, or empty'),
    });
    if (ufStr === undefined) return;
    const utStr = await vscode.window.showInputBox({
      title: 'Relabel frames — the numbers do NOT change',
      prompt: 'New UT number, or leave empty to keep it',
      validateInput: v => (v === '' || /^\d+$/.test(v) ? undefined : 'A whole number, or empty'),
    });
    if (utStr === undefined) return;
    if (ufStr === '' && utStr === '') return;

    const text = ed.document.getText();
    const plans = picked
      .map(i => ({ index: i, plan: planRelabelFrames(text, i, ufStr === '' ? undefined : +ufStr, utStr === '' ? undefined : +utStr) }))
      .filter(p => p.plan && !p.plan.blockers.length && p.plan.edits.length);
    if (!plans.length) { vscode.window.showInformationMessage('Nothing to relabel — those positions already carry those frames.'); return; }

    const ok = await vscode.window.showWarningMessage(
      `Relabel ${plans.length} position(s) to UF ${ufStr || 'unchanged'} / UT ${utStr || 'unchanged'}?`,
      {
        modal: true,
        detail: [
          'THIS MOVES THE POINTS.',
          '',
          'Not one coordinate changes — only the frame they are measured against. The same numbers',
          'in a different frame describe a different place in the cell, by however far apart those',
          'two frames are.',
          '',
          'This is the right thing to do when a point was taught against the wrong frame and its',
          'numbers are correct. If instead you want the points to stay where they are, cancel and',
          'use "Convert Positions to Another Frame".',
          '',
          `Affected: P[${plans.map(p => p.index).slice(0, 12).join('], P[')}]${plans.length > 12 ? ' …' : ''}`,
        ].join('\n'),
      },
      'Relabel and move them');
    if (!ok) return;

    const edits = plans.flatMap(p => p.plan!.edits);
    const applied = await ed.edit(b => { for (const e of edits) b.replace(new vscode.Range(e.line, e.col, e.line, e.col + e.len), e.newText); });
    if (!applied) { vscode.window.showErrorMessage('Could not relabel.'); return; }
    s.output.appendLine(`[${new Date().toLocaleTimeString()}] relabelled ${plans.length} position(s) to UF ${ufStr || '(kept)'} / UT ${utStr || '(kept)'} - values untouched, so the points now mean different places`);
    vscode.window.setStatusBarMessage(`$(tag) ${plans.length} position(s) relabelled · the points now mean different places · undo restores them`, 8000);
  });

  /**
   * Positions no live line uses - never mentioned, or mentioned only on commented-out
   * lines - reviewed in a list, then removed from /POS. Nothing is deleted without the
   * list being confirmed, and undo puts it all back.
   */
  reg('robotCode.tp.cleanupPositions', async () => {
    const ed = tpEditor(); if (!ed) return;
    const prog = s.tp.get(ed.document);
    const stale = findStalePositions(ed.document.getText());
    if (!stale.length) {
      vscode.window.showInformationMessage(prog.positions.length
        ? `Every one of the ${prog.positions.length} taught positions in this program is used by a live instruction.`
        : 'This program has no taught positions.');
      return;
    }
    const picks = await vscode.window.showQuickPick(
      stale.map(p => {
        const pos = prog.positions.find(x => x.index === p.index);
        return {
          label: `P[${p.index}]${p.comment ? `  ${p.comment}` : ''}`,
          description: p.reason === 'unused'
            ? 'no instruction uses it'
            : `only on commented-out line${p.mentions.length === 1 ? '' : 's'} ${p.mentions.map(l => l + 1).join(', ')}`,
          detail: pos ? describePosition(pos) : '',
          picked: true, index: p.index, reason: p.reason,
        };
      }),
      { canPickMany: true, placeHolder: `Review: ${stale.length} position(s) nothing runs. Unchecked ones are kept.`, matchOnDescription: true, matchOnDetail: true });
    if (!picks?.length) return;

    const remarked = picks.filter(p => p.reason === 'remarked').length;
    const ok = await vscode.window.showWarningMessage(
      `Remove ${picks.length} position${picks.length === 1 ? '' : 's'} from ${prog.header.name ?? 'this program'}?`,
      {
        modal: true,
        detail: [
          `P[${picks.map(p => p.index).join('], P[')}]`,
          '',
          ...(remarked ? [`${remarked} of them ${remarked === 1 ? 'is' : 'are'} still mentioned on commented-out lines. Those lines stay as they are; if one is ever uncommented the point will have to be re-taught.`, ''] : []),
          'The position data is deleted from /POS. The program file changes; the robot does not. Undo puts it back.',
        ].join('\n'),
      },
      `Remove ${picks.length}`);
    if (!ok) return;

    const changes = planPositionRemoval(ed.document.getText(), picks.map(p => p.index));
    const applied = await ed.edit(b => {
      for (const c of changes) b.delete(new vscode.Range(c.from, 0, Math.min(c.to + 1, ed.document.lineCount - 1), c.to + 1 >= ed.document.lineCount ? ed.document.lineAt(c.to).text.length : 0));
    });
    if (!applied) { vscode.window.showErrorMessage('Could not remove the positions.'); return; }
    s.output.appendLine(`[${new Date().toLocaleTimeString()}] removed ${picks.length} unused position(s) from ${prog.header.name ?? ed.document.fileName}: P[${picks.map(p => p.index).join('], P[')}]`);
    vscode.window.setStatusBarMessage(`$(trash) ${picks.length} position${picks.length === 1 ? '' : 's'} removed · undo restores them`, 8000);
  });

  /** R[5] → R[105] everywhere, with a count before it happens. */
  reg('robotCode.tp.remapRegister', async () => {
    const ed = tpEditor(); if (!ed) return;
    const prog = s.tp.get(ed.document);
    const kinds = [...new Set(prog.dataRefs.map(r => r.kind))].sort();
    if (!kinds.length) { vscode.window.showInformationMessage('This program uses no registers or I/O points.'); return; }

    const kind = await vscode.window.showQuickPick(
      kinds.map(k => ({ label: k, description: `${new Set(prog.dataRefs.filter(r => r.kind === k).map(r => r.index)).size} used` })),
      { placeHolder: 'Which kind to renumber?' });
    if (!kind) return;

    const used = [...new Set(prog.dataRefs.filter(r => r.kind === kind.label).map(r => r.index))].sort((a, b) => a - b);
    const fromPick = await vscode.window.showQuickPick(
      used.map(i => ({ label: `${kind.label}[${i}]`, description: `${prog.dataRefs.filter(r => r.kind === kind.label && r.index === i).length} use(s)`, index: i })),
      { placeHolder: `Renumber which ${kind.label}?` });
    if (!fromPick) return;

    const toStr = await vscode.window.showInputBox({
      title: `${kind.label}[${fromPick.index}] becomes`,
      prompt: `New index for ${kind.label}[${fromPick.index}] in this program. Inline comments are kept.`,
      validateInput: v => (/^\d+$/.test(v) && +v > 0 ? undefined : 'A positive whole number'),
    });
    if (!toStr) return;
    const to = parseInt(toStr, 10);
    if (to === fromPick.index) return;

    // A register is shared across every program on the robot, so renaming it in one file
    // is usually the wrong half of the job - the other programs keep using the old number
    // and the two silently mean different things. The whole backup is the default, and
    // "whole" means the tree: programs in subfolders of the backup are the same robot's.
    const backup = s.index.backupOf(ed.document.uri);
    const siblings = backup.programs.filter(p => p.kind === 'tp');
    const scope = siblings.length > 1
      ? await vscode.window.showQuickPick([
        { label: 'Entire backup', description: `${siblings.length} programs under ${path.basename(backup.folder) || backup.folder}`, all: true },
        { label: 'This file only', description: ed.document.fileName.split(/[\\/]/).pop(), all: false },
      ], { placeHolder: `Renumber ${kind.label}[${fromPick.index}] where?` })
      : { all: false };
    if (!scope) return;

    // Gather per file first, so the count and the collisions are known before anything is asked.
    const targets = scope.all ? siblings.map(p => p.uri) : [ed.document.uri];
    const perFile: Array<{ uri: vscode.Uri; name: string; res: ReturnType<typeof planRemap> }> = [];
    for (const uri of targets) {
      const doc = uri.toString() === ed.document.uri.toString() ? ed.document : await vscode.workspace.openTextDocument(uri).then(d => d, () => undefined);
      if (!doc) continue;
      const res = planRemap(doc.getText(), kind.label, fromPick.index, to);
      if (res.count || res.collision) perFile.push({ uri, name: uri.path.split('/').pop() ?? '', res });
    }

    const total = perFile.reduce((n, f) => n + f.res.count, 0);
    if (!total) { vscode.window.showInformationMessage(`No uses of ${kind.label}[${fromPick.index}] found.`); return; }
    const collisions = perFile.filter(f => f.res.collision);

    const detail = [
      `${total} reference(s) across ${perFile.filter(f => f.res.count).length} program(s).`,
      '',
      ...perFile.filter(f => f.res.count).slice(0, 10).map(f => `  ${f.name}  ${f.res.count}`),
      ...(perFile.filter(f => f.res.count).length > 10 ? ['  …'] : []),
      ...(collisions.length ? ['', `WARNING: ${kind.label}[${to}] is ALREADY used in ${collisions.length} of them (${collisions.slice(0, 4).map(f => f.name).join(', ')}). Renumbering MERGES the two — they become the same register.`] : []),
      '',
      scope.all
        ? 'Every program in the backup changes. The controller still holds the old number and its comment, and any KAREL or PLC that touches it is not updated.'
        : 'Only this file changes. Other programs on the robot keep using the old number, which is usually not what you want.',
    ];
    const ok = await vscode.window.showWarningMessage(
      `Renumber ${kind.label}[${fromPick.index}] to ${kind.label}[${to}]?`, { modal: true, detail: detail.join('\n') }, 'Renumber');
    if (!ok) return;

    const wsEdit = new vscode.WorkspaceEdit();
    for (const f of perFile) {
      for (const e of f.res.edits) wsEdit.replace(f.uri, new vscode.Range(e.line, e.col, e.line, e.col + e.len), e.newText);
    }
    if (!await vscode.workspace.applyEdit(wsEdit)) { vscode.window.showErrorMessage('Could not apply the renumbering.'); return; }
    s.output.appendLine(`[${new Date().toLocaleTimeString()}] renumbered ${kind.label}[${fromPick.index}] -> ${kind.label}[${to}]: ${total} reference(s) in ${perFile.length} file(s)${collisions.length ? `; MERGED with an existing ${kind.label}[${to}] in ${collisions.length}` : ''}`);
    vscode.window.setStatusBarMessage(`$(replace-all) ${total} reference(s) in ${perFile.filter(f => f.res.count).length} file(s) renumbered to ${kind.label}[${to}]`, 8000);
  });

  /** Selected lines become their own program, with a CALL left behind. */
  reg('robotCode.tp.extractProgram', async () => {
    const ed = tpEditor(); if (!ed) return;
    const sel = ed.selections.find(x => !x.isEmpty);
    if (!sel) { vscode.window.showInformationMessage('Select the lines to move into a new program.'); return; }
    const endLine = sel.end.character === 0 && sel.end.line > sel.start.line ? sel.end.line - 1 : sel.end.line;

    const name = await vscode.window.showInputBox({
      title: 'Extract to program',
      prompt: 'Name for the new program',
      validateInput: v => (/^[A-Za-z][A-Za-z0-9_]{0,35}$/.test(v) ? (s.index.get(v, ed.document.uri) ? `${v.toUpperCase()} already exists in this robot's folder` : undefined) : 'Start with a letter; letters, digits and _ only'),
    });
    if (!name) return;

    const res = planExtract(ed.document.getText(), sel.start.line, endLine, name);
    if (res.blockers.length) {
      await vscode.window.showWarningMessage(`${name.toUpperCase()} cannot be extracted from this selection.`, { modal: true, detail: res.blockers.join('\n\n') });
      return;
    }

    const detail = [
      `${res.movedLines} line(s) move into ${name.toUpperCase()}, replaced by CALL ${name.toUpperCase()}.`,
      res.positionMap.size ? `${res.positionMap.size} position(s) move with them and are renumbered from P[1].` : 'No taught positions are involved.',
      ...(res.warnings.length ? ['', ...res.warnings] : []),
      '',
      'The new program is written next to this one. Neither is sent to the robot.',
    ];
    const ok = await vscode.window.showWarningMessage(`Extract ${res.movedLines} line(s) to ${name.toUpperCase()}?`, { modal: true, detail: detail.join('\n') }, 'Extract');
    if (!ok) return;

    const target = vscode.Uri.file(path.join(path.dirname(ed.document.uri.fsPath), `${name.toUpperCase()}.LS`));
    await vscode.workspace.fs.writeFile(target, Buffer.from(res.programText, 'latin1'));
    const updated = applyLineChanges(ed.document.getText(), res.lineChanges);
    await ed.edit(b => b.replace(new vscode.Range(0, 0, ed.document.lineCount, 0), updated));
    await auto.apply(ed.document, undefined, true);
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(target), { preview: false, viewColumn: vscode.ViewColumn.Beside });
    s.output.appendLine(`[${new Date().toLocaleTimeString()}] extracted ${res.movedLines} line(s) to ${target.fsPath}`);
  });

  /** CALL X becomes X's body, renumbered so nothing collides. */
  reg('robotCode.tp.inlineProgram', async () => {
    const ed = tpEditor(); if (!ed) return;
    const prog = s.tp.get(ed.document);
    const line = ed.selection.active.line;
    const call = prog.calls.find(c => c.line === line);
    if (!call) { vscode.window.showInformationMessage('Put the cursor on a CALL line.'); return; }
    const info = s.index.get(call.name, ed.document.uri);
    if (!info) { vscode.window.showWarningMessage(`${call.name} was not found in this robot's folder.`); return; }
    if (info.kind !== 'tp') { vscode.window.showWarningMessage(`${call.name} is a ${info.kind === 'binary' ? 'compiled program with no source in this backup' : 'KAREL program'}; only a TP program can be inlined.`); return; }

    const calleeDoc = await vscode.workspace.openTextDocument(info.uri);
    const res = planInline(ed.document.getText(), line, calleeDoc.getText(), call.name.toUpperCase());
    if (res.blockers.length) {
      await vscode.window.showWarningMessage(`${call.name} cannot be inlined here.`, { modal: true, detail: res.blockers.join('\n\n') });
      return;
    }
    const callers = s.index.callers(call.name, ed.document.uri).length;
    const detail = [
      `${call.name.toUpperCase()}'s body is pasted in place of the CALL.`,
      res.labelMap.size ? `${res.labelMap.size} label(s) renumbered to avoid clashing with this program.` : '',
      res.positionMap.size ? `${res.positionMap.size} position(s) copied into this program's /POS and renumbered.` : '',
      callers > 1 ? `\n${call.name.toUpperCase()} is called from ${callers} programs. This inlines ONE of them; the program itself is left alone.` : '',
      ...(res.warnings.length ? ['', ...res.warnings] : []),
    ].filter(Boolean);
    const ok = await vscode.window.showWarningMessage(`Inline ${call.name.toUpperCase()} here?`, { modal: true, detail: detail.join('\n') }, 'Inline');
    if (!ok) return;

    const updated = applyLineChanges(ed.document.getText(), res.lineChanges);
    await ed.edit(b => b.replace(new vscode.Range(0, 0, ed.document.lineCount, 0), updated));
    await auto.apply(ed.document, undefined, true);
    vscode.window.setStatusBarMessage(`$(fold-down) ${call.name.toUpperCase()} inlined`, 6000);
  });

  /**
   * Several programs into one new program, in the order picked (beta list 2, item 8). The
   * picking is one program at a time so the ORDER is the user's, not the list's; Done ends
   * it. The result is written next to the first program and opened; nothing is sent.
   */
  reg('robotCode.tp.combinePrograms', async (uri?: vscode.Uri) => {
    const near = uri instanceof vscode.Uri ? uri : vscode.window.activeTextEditor?.document.uri;
    const candidates = s.index.list(near && near.scheme === 'file' ? near : undefined).filter(p => p.kind === 'tp' && !p.reference && p.uri.scheme === 'file');
    if (candidates.length < 2) { vscode.window.showInformationMessage('Combining needs at least two TP programs (.ls) in the workspace.'); return; }
    const chosen: typeof candidates = [];
    for (;;) {
      const left = candidates.filter(c => !chosen.includes(c));
      const items: Array<vscode.QuickPickItem & { info?: typeof candidates[number]; done?: boolean }> = [];
      if (chosen.length >= 2) items.push({ label: '$(check) Done', description: `combine ${chosen.length} programs in this order: ${chosen.map(c => c.name).join(' → ')}`, done: true });
      items.push(...left.map(c => ({ label: c.name, description: c.comment ?? '', detail: vscode.workspace.asRelativePath(c.uri), info: c })));
      const pick = await vscode.window.showQuickPick(items, { placeHolder: chosen.length ? `Program ${chosen.length + 1} (after ${chosen[chosen.length - 1].name}) - or Done` : 'First program of the combined program', matchOnDescription: true, matchOnDetail: true });
      if (!pick) return;
      if (pick.done) break;
      if (pick.info) chosen.push(pick.info);
    }
    const first = chosen[0];
    const name = await vscode.window.showInputBox({
      title: 'Combine programs',
      prompt: `Name for the combined program (${chosen.map(c => c.name).join(' + ')})`,
      value: `${first.name}_ALL`.slice(0, 36),
      validateInput: v => (/^[A-Za-z][A-Za-z0-9_]{0,35}$/.test(v) ? (s.index.get(v, first.uri) ? `${v.toUpperCase()} already exists in this robot's folder` : undefined) : 'Start with a letter; letters, digits and _ only'),
    });
    if (!name) return;
    const parts = await Promise.all(chosen.map(async c => ({ name: c.name, text: (await vscode.workspace.openTextDocument(c.uri)).getText() })));
    const res = planCombine(parts, name);
    if (res.blockers.length) { await vscode.window.showWarningMessage('These programs cannot be combined.', { modal: true, detail: res.blockers.join('\n\n') }); return; }
    const detail = [
      ...res.parts.map((p, i) => `${i + 1}. ${p.name}: ${p.lines} line(s)${p.positions ? `, ${p.positions} position(s)` : ''}${p.labels ? `, ${p.labels} label(s)` : ''}`),
      '',
      `${res.lineCount} lines in ${name.toUpperCase()}; labels and positions renumbered so nothing collides; a !--- banner marks where each program starts.`,
      ...(res.warnings.length ? ['', ...res.warnings] : []),
      '',
      'The originals are left as they are. Nothing is sent to the robot.',
    ];
    const ok = await vscode.window.showWarningMessage(`Combine ${chosen.length} programs into ${name.toUpperCase()}?`, { modal: true, detail: detail.join('\n') }, 'Combine');
    if (!ok) return;
    const target = vscode.Uri.file(path.join(path.dirname(first.uri.fsPath), `${name.toUpperCase()}.LS`));
    await vscode.workspace.fs.writeFile(target, Buffer.from(res.programText, 'latin1'));
    const doc = await vscode.workspace.openTextDocument(target);
    await vscode.window.showTextDocument(doc, { preview: false });
    await auto.apply(doc, undefined, true);
    s.output.appendLine(`[${new Date().toLocaleTimeString()}] combined ${chosen.map(c => c.name).join(' + ')} into ${target.fsPath}`);
    vscode.window.setStatusBarMessage(`$(combine) ${name.toUpperCase()}: ${chosen.length} programs, ${res.lineCount} lines`, 8000);
  });

  reg('robotCode.tp.stripPositions', async () => {
    const ed = tpEditor(); if (!ed) return;
    const doc = await vscode.workspace.openTextDocument({ language: 'fanuc-tp', content: stripPositions(ed.document.getText()) });
    await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.Beside });
  });

  reg('robotCode.tp.showCallGraph', (uri?: vscode.Uri) => {
    const active = vscode.window.activeTextEditor;
    const target = uri instanceof vscode.Uri ? uri : active?.document.languageId === 'fanuc-tp' ? active.document.uri : undefined;
    return showCallGraph(ctx, s, target);
  });

  reg('robotCode.tp.showFlow', (uri?: vscode.Uri) => {
    const active = vscode.window.activeTextEditor;
    const target = uri instanceof vscode.Uri ? uri : active?.document.languageId === 'fanuc-tp' ? active.document.uri : undefined;
    if (!target) { vscode.window.showInformationMessage('Open a FANUC TP (.ls) file first.'); return; }
    return showProgramFlow(ctx, s, target);
  });

  reg('robotCode.tp.showCallers', async (uri: vscode.Uri, name: string) => {
    const locs = await callSitesOf(s, name, uri);
    const doc = await vscode.workspace.openTextDocument(uri);
    const prog = s.tp.get(doc);
    const pos = prog.header.nameSpan ? new vscode.Position(prog.header.nameSpan.line, prog.header.nameSpan.col) : new vscode.Position(0, 0);
    await vscode.commands.executeCommand('editor.action.showReferences', uri, pos, locs);
  });

  registerInsertTemplate(reg, s, tpEditor, doc => auto.apply(doc, undefined, true));   // Insert Program Template at Cursor…

  reg('robotCode.tp.newProgram', async () => {
    const name = await vscode.window.showInputBox({ prompt: 'Program name (letters, digits, underscore; max 36)', placeHolder: 'MAIN_PICK', validateInput: v => /^[A-Za-z][A-Za-z0-9_]{0,35}$/.test(v) ? undefined : 'Start with a letter; letters, digits and _ only' });
    if (!name) return;
    // the comment is written between double quotes in /ATTR, so a quote inside it ends the value early
    const comment = await vscode.window.showInputBox({ prompt: 'Program comment (16 characters shown on the pendant)', value: '', validateInput: v => v.includes('"') ? 'A double quote cannot be part of a program comment' : undefined });
    if (comment === undefined) return;
    // The pendant's DETAIL screen, in the order it asks: sub type, group mask, write protect.
    const type = await vscode.window.showQuickPick(PROGRAM_SUB_TYPES.map(t => ({ label: t.label, description: t.description, t })), { placeHolder: 'Program type (Sub Type)' });
    if (!type) return;
    const groups = [
      { label: '1,*,*,*,*', description: 'Motion group 1 (robot)' },
      { label: '*,*,*,*,*', description: 'No motion group (logic only, can be RUN as a task)' },
      { label: '1,1,*,*,*', description: 'Groups 1 and 2' },
    ];
    // a condition handler cannot hold a motion group, so it is not asked
    const group = type.t.subType === 'Cond' ? groups[1] : await vscode.window.showQuickPick(groups, { placeHolder: 'Group mask (DEFAULT_GROUP)' });
    if (!group) return;
    const protect = await vscode.window.showQuickPick([
      { label: 'Write protect OFF', description: 'editable on the pendant (the usual)', on: false },
      { label: 'Write protect ON', description: 'the pendant refuses edits until it is switched off', on: true },
    ], { placeHolder: 'Write protect' });
    if (!protect) return;
    const upper = name.toUpperCase();
    // The customer's header goes in at birth, which is when people forget it.
    const folder = vscode.window.activeTextEditor && !vscode.window.activeTextEditor.document.isUntitled ? path.dirname(vscode.window.activeTextEditor.document.uri.fsPath) : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const fileUri = folder ? vscode.Uri.file(path.join(folder, `${upper}.LS`)) : undefined;
    const header = await buildHeader(ctx, s, fileUri, upper, comment, true);
    if (header === undefined) return;
    // Then the body the plant standard starts from (robotCode.tp.programTemplates). A
    // separate pick after the header: the two lists are edited independently in settings.
    const template = await pickProgramTemplate('Program template for the body');
    if (!template) return;
    const bodyLines = template.lines.length ? await resolveTemplateLines(s, template, upper, comment, fileUri) : [];
    if (!bodyLines) return;
    const content = buildProgramText({ name: upper, comment, group: group.label, headerLines: header, bodyLines, date: fanucDate(), time: fanucTime(), subType: type.t.subType, writeProtect: protect.on });
    const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(folder ?? '', `${upper}.LS`)), filters: { 'TP program': ['ls', 'LS'] }, title: 'Create TP program' });
    if (!target) return;
    await vscode.workspace.fs.writeFile(target, Buffer.from(content, 'utf8'));
    const doc = await vscode.workspace.openTextDocument(target);
    await vscode.window.showTextDocument(doc);
  });

}

/**
 * Which positions the offset applies to.
 *
 * A selection is taken at its word — both the `/POS` blocks it covers and the `P[n]`
 * referenced by any motion line inside it, because "these moves" and "these points" are
 * the same intent expressed from the two ends of the file. With no selection there is
 * nothing to infer, so it asks.
 */
async function pickOffsetTargets(ed: vscode.TextEditor, prog: TpProgram): Promise<number[] | undefined> {
  const fromSelection = new Set<number>();
  for (const sel of ed.selections) {
    if (sel.isEmpty) continue;
    for (const p of prog.positions) if (p.line <= sel.end.line && p.endLine >= sel.start.line) fromSelection.add(p.index);
    for (const r of prog.posRefs) if (r.line >= sel.start.line && r.line <= sel.end.line) fromSelection.add(r.index);
  }
  if (fromSelection.size) return [...fromSelection].sort((a, b) => a - b);

  const all = { label: `All ${prog.positions.length} positions in this program`, description: 'every taught point', pick: 'all' as const };
  const range = { label: 'By number…', description: 'e.g. 1-9, 12, 15-20', pick: 'range' as const };
  const some = { label: 'Choose positions…', description: 'pick from a list', pick: 'some' as const };
  const choice = await vscode.window.showQuickPick([all, range, some], { placeHolder: 'Nothing selected — which positions?' });
  if (!choice) return undefined;
  if (choice.pick === 'all') return prog.positions.map(p => p.index);
  if (choice.pick === 'range') {
    const have = new Set(prog.positions.map(p => p.index));
    const typed = await vscode.window.showInputBox({
      prompt: 'Position numbers: single numbers and ranges, separated by commas',
      placeHolder: '1-9, 12',
      validateInput: v => parsePositionList(v) ? undefined : 'Try "1-9" or "1-9, 12, 15-20".',
    });
    const wanted = typed ? parsePositionList(typed) : undefined;
    if (!wanted) return undefined;
    const found = wanted.filter(i => have.has(i));
    if (!found.length) vscode.window.showInformationMessage(`None of P[${typed}] is in this program.`);
    return found;
  }

  const chosen = await vscode.window.showQuickPick(
    prog.positions.map(p => ({
      label: `P[${p.index}]${p.comment ? `  ${p.comment}` : ''}`,
      description: frameLabel(p.groups[0]),
      index: p.index,
    })),
    { placeHolder: 'Positions to offset', canPickMany: true, matchOnDescription: true });
  return chosen?.map(c => c.index);
}

function tpEditor(): vscode.TextEditor | undefined {
  const ed = vscode.window.activeTextEditor;
  if (!ed || ed.document.languageId !== 'fanuc-tp') { vscode.window.showInformationMessage('Open a FANUC TP (.ls) file first.'); return undefined; }
  return ed;
}

/**
 * Pick a header template and fill it. Returns the comment lines (without `!`), an empty
 * list for "no header" when `optional`, or undefined when the user backed out.
 *
 * PROGRAM, COMMENT, DATE, TIME, USER, ROBOT and RULE fill themselves; every other
 * `${FIELD}` a template names is asked for, in the order it first appears, and an empty
 * answer leaves the placeholder in the text so it is obvious what was skipped.
 */
async function buildHeader(ctx: vscode.ExtensionContext, s: FanucServices, uri: vscode.Uri | undefined, program: string | undefined, comment: string | undefined, optional = false): Promise<string[] | undefined> {
  const templates = config<HeaderTemplate[]>('tp.headerTemplates', DEFAULT_HEADER_TEMPLATES).filter(t => t && typeof t.name === 'string' && Array.isArray(t.lines));
  if (!templates.length) { if (optional) return []; vscode.window.showInformationMessage('No header templates are configured (robotCode.tp.headerTemplates).'); return undefined; }
  type Item = vscode.QuickPickItem & { t?: HeaderTemplate };
  const items: Item[] = templates.map(t => ({ label: t.name, description: `${t.lines.length} lines${headerPrompts(t).length ? ` · asks for ${headerPrompts(t).join(', ')}` : ''}`, detail: t.lines.slice(0, 3).map(l => `!${l}`).join('  '), t }));
  if (optional) items.unshift({ label: 'No header', description: 'just a one-line comment' });
  const pick = templates.length === 1 && !optional ? items[0] : await vscode.window.showQuickPick(items, { placeHolder: optional ? 'Header template for the new program' : 'Which header?', matchOnDetail: true });
  if (!pick) return undefined;
  if (!pick.t) return [];
  const t = pick.t;
  // the spec in use, for the status bar
  await ctx.workspaceState.update(HEADER_TEMPLATE_KEY, t.name);
  contextChanged.fire();
  const values: Record<string, string | undefined> = {
    PROGRAM: program, COMMENT: comment, DATE: fanucDate(), TIME: fanucTime(),
    USER: (() => { try { return os.userInfo().username; } catch { return undefined; } })(),
    ROBOT: uri ? s.data.dataset(uri)?.name : s.data.datasets.length === 1 ? s.data.datasets[0].name : undefined,
    RULE: ruleLine(t),
  };
  for (const field of headerPrompts(t)) {
    const v = await vscode.window.showInputBox({ title: `${t.name} header`, prompt: field.replace(/_/g, ' ').toLowerCase().replace(/^./, c => c.toUpperCase()), placeHolder: `leave empty to keep \${${field}}` });
    if (v === undefined) return undefined;
    values[field] = v.trim() || undefined;
  }
  const out = expandHeader(t, values);
  if (out.tooLong.length) vscode.window.showWarningMessage(`${out.tooLong.length} header line${out.tooLong.length === 1 ? '' : 's'} run${out.tooLong.length === 1 ? 's' : ''} past the ${COMMENT_WIDTH} characters the pendant shows per comment.`);
  return out.lines;
}

function selectedLines(ed: vscode.TextEditor): number[] {
  const set = new Set<number>();
  for (const sel of ed.selections) for (let l = sel.start.line; l <= sel.end.line; l++) { if (l === sel.end.line && sel.end.character === 0 && !sel.isEmpty) break; set.add(l); }
  return [...set].sort((a, b) => a - b);
}

/**
 * The Vim extension (vscodevim) is running and this editor is in Normal/Visual mode - Vim draws a
 * block cursor there and a line cursor in Insert mode. Only with Vim active: someone who simply
 * prefers a block cursor is still typing on the cursor line.
 */
function vimNormalMode(ed: vscode.TextEditor): boolean {
  if (!vscode.extensions.getExtension('vscodevim.vim')?.isActive) return false;
  const st = ed.options.cursorStyle;
  return st !== undefined && st !== vscode.TextEditorCursorStyle.Line && st !== vscode.TextEditorCursorStyle.LineThin;
}

/**
 * Keeps TP line numbers, terminators and LINE_COUNT correct while editing.
 * The line(s) holding the cursor are left alone until the cursor moves away,
 * and edits merge into the user's undo step so Ctrl+Z still works as expected.
 */
class AutoRenumber implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private applying = false;
  private lastActiveLines = new Map<string, string>();
  /** the text just before and after this class's last renumber edit, per document - to recognise an undo/redo of it */
  private lastRenumber = new Map<string, { before: string; after: string }>();

  constructor(private s: FanucServices) {
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument(e => {
        if (this.applying || e.document.languageId !== 'fanuc-tp' || !e.contentChanges.length) return;
        if (autoRenumberMode(e.document) === 'off') return;
        if (e.reason === vscode.TextDocumentChangeReason.Undo || e.reason === vscode.TextDocumentChangeReason.Redo) { this.afterUndoRedo(e.document, e.reason); return; }
        if (this.healSplitTerminator(e)) return;   // it schedules the renumber itself
        this.schedule(e.document, 350);
      }),
      vscode.window.onDidChangeTextEditorSelection(e => {
        const doc = e.textEditor.document;
        if (this.applying || doc.languageId !== 'fanuc-tp' || autoRenumberMode(doc) === 'off') return;
        const key = doc.uri.toString();
        const lines = [...new Set(e.selections.map(s => s.active.line))].sort().join(',');
        if (this.lastActiveLines.get(key) !== lines) { this.lastActiveLines.set(key, lines); this.schedule(doc, 60); }
      }),
      // Vim's Esc changes the mode, not the line: the cursor shape changing is the only sign (#19)
      vscode.window.onDidChangeTextEditorOptions(e => {
        const doc = e.textEditor.document;
        if (this.applying || doc.languageId !== 'fanuc-tp' || autoRenumberMode(doc) === 'off' || !vimNormalMode(e.textEditor)) return;
        this.schedule(doc, 60);
      }),
    );
  }

  dispose() { for (const d of this.disposables) d.dispose(); for (const t of this.timers.values()) clearTimeout(t); }

  /**
   * An undo or redo is never renumbered on top of - that would put straight back what was just taken
   * out. And when the step undone was only this class's renumber (an editor that closes its undo step
   * after its own edit, as Vim does, leaves the renumber as a step of its own), the undo goes one step
   * further, to the edit that caused it: one Undo takes a paste and its renumber out together. Redo
   * mirrors it. (#19)
   */
  private afterUndoRedo(doc: vscode.TextDocument, reason: vscode.TextDocumentChangeReason) {
    const key = doc.uri.toString();
    const last = this.lastRenumber.get(key);
    const pending = this.timers.get(key); if (pending) { clearTimeout(pending); this.timers.delete(key); }
    if (!last || vscode.window.activeTextEditor?.document !== doc) return;
    const text = doc.getText();
    // the record stays: a Redo back to `before` is what puts the renumber back on top
    if (reason === vscode.TextDocumentChangeReason.Undo && text === last.before) {
      setTimeout(() => { void vscode.commands.executeCommand('undo'); }, 0);
    } else if (reason === vscode.TextDocumentChangeReason.Redo && text === last.before) {
      setTimeout(() => { void vscode.commands.executeCommand('redo'); }, 0);
    }
  }

  /**
   * Enter pressed with the ` ;` still to the right of the caret.
   *
   * Every TP line ends in ` ;`, and the natural place to press Enter is at the end of the
   * instruction - which is BEFORE the terminator. The editor did what editors do and carried
   * the `;` down onto the new line, leaving line N without its terminator and line N+1 as a
   * bare ` ;` that the renumber then treated as the user's typing and left alone: the caret
   * sat in front of a stray semicolon and the scaffold for the new line never appeared.
   *
   * So the split is undone here, in the same undo step as the keystroke: the terminator goes
   * back onto the line it belongs to and the new line becomes genuinely empty, which is the
   * shape the renumber already knows how to turn into `  12:   ;` with the caret placed.
   */
  private healSplitTerminator(e: vscode.TextDocumentChangeEvent): boolean {
    if (e.contentChanges.length !== 1) return false;
    const ch = e.contentChanges[0];
    // A plain Enter - or Enter between a bracket pair, which VS Code turns into TWO
    // newlines with an indented blank line between (`[` + Enter + `]` becomes three lines).
    // A TP instruction is one line; that split leaves `]) ;` stranded below.
    const enter = /^\r?\n[ \t]*(\r?\n[ \t]*)?$/.exec(ch.text);
    if (!ch.range.isEmpty || !enter) return false;
    const doc = e.document;
    const editor = vscode.window.visibleTextEditors.find(x => x.document === doc);
    if (!editor) return false;
    const above = ch.range.start.line;
    const below = above + (enter[1] ? 2 : 1);   // the line that received the tail of the instruction
    if (below >= doc.lineCount) return false;
    const belowText = doc.lineAt(below).text;
    const aboveText = doc.lineAt(above).text;
    if (enter[1]) return this.healBracketSplit(editor, above, below, aboveText, belowText);
    if (!/^[ \t]*;[ \t]*$/.test(belowText)) return false;                     // the new line is not just the orphaned terminator
    // The line above lost its terminator - whether it carries an instruction, is a blank
    // numbered line (`  21:   ;` with Enter pressed before the `;`), or is an unnumbered
    // line still being typed. Only a line that still ends in `;` is left alone.
    if (/;\s*$/.test(aboveText) || /^\s*:/.test(aboveText)) return false;
    const prog = this.s.tp.get(doc);
    const mn = prog.sections.mn;
    if (mn === undefined || above <= mn || (prog.sections.pos !== undefined && above >= prog.sections.pos)) return false;

    this.applying = true;
    // a blank numbered line keeps the controller's own spelling, `  21:   ;`
    const healed = /^\s*\d+:\s*$/.test(aboveText) ? aboveText.trimEnd() + '   ;' : aboveText.trimEnd() + ' ;';
    void editor.edit(b => {
      b.replace(doc.lineAt(above).range, healed);
      b.replace(doc.lineAt(below).range, '');
    }, { undoStopBefore: false, undoStopAfter: false }).then(() => {
      this.applying = false;
      const caret = new vscode.Position(below, 0);
      editor.selection = new vscode.Selection(caret, caret);
      this.schedule(doc, 60);
    }, () => { this.applying = false; });
    return true;
  }

  /**
   * Enter inside `DI[|]` on an instruction line: the instruction is put back together on
   * its line (`... DI[]) ;`) and the caret goes to a fresh line below, which the renumber
   * then scaffolds - the same outcome as Enter at the end of the line, which is what
   * Enter on a one-line instruction can only mean.
   */
  private healBracketSplit(editor: vscode.TextEditor, above: number, below: number, aboveText: string, belowText: string): boolean {
    const doc = editor.document;
    const tail = belowText.trim();
    // A TP line never begins with a closing bracket: whatever follows it is the rest of the
    // instruction that was cut (`]) ;`, `]=ON ;`, `] 100% FINE ;`), and it goes back.
    if (!/^[\])]/.test(tail)) return false;
    if (/^\s*:/.test(aboveText)) return false;
    const prog = this.s.tp.get(doc);
    const mn = prog.sections.mn;
    if (mn === undefined || above <= mn || (prog.sections.pos !== undefined && above >= prog.sections.pos)) return false;
    let healed = aboveText.trimEnd() + tail.replace(/\s*;$/, '');
    if (autoRenumberMode(doc) !== 'custom' || renumberOptions(doc).autoSemicolon) healed += ' ;';
    this.applying = true;
    void editor.edit(b => {
      b.replace(new vscode.Range(above, 0, below, belowText.length), healed + '\n');
    }, { undoStopBefore: false, undoStopAfter: false }).then(() => {
      this.applying = false;
      const caret = new vscode.Position(above + 1, 0);
      editor.selection = new vscode.Selection(caret, caret);
      this.schedule(doc, 60);
    }, () => { this.applying = false; });
    return true;
  }

  private schedule(doc: vscode.TextDocument, ms: number) {
    const key = doc.uri.toString();
    const prev = this.timers.get(key); if (prev) clearTimeout(prev);
    this.timers.set(key, setTimeout(() => { this.timers.delete(key); void this.apply(doc); }, ms));
  }

  /** Returns number of lines changed. */
  async apply(doc: vscode.TextDocument, skip?: Set<number>, force = false, override?: RenumberOptions): Promise<number> {
    if (doc.isClosed) return 0;
    const text = doc.getText();
    if (!/^\/MN\b/m.test(text)) return 0;
    const editor = vscode.window.visibleTextEditors.find(e => e.document === doc);
    // Lines the cursor is on are normally left alone, so renumbering does not fight you
    // while you type. A BLANK cursor line is the exception, and missing it was a real
    // annoyance: press Enter and you are sitting on an empty line with nothing to
    // disturb, and the "  12:   ;" scaffold is precisely what you are waiting for. It
    // used to appear only once you clicked somewhere else.
    const blankAtCursor = editor
      ? editor.selections.filter(sel => doc.lineAt(sel.active.line).text.trim() === '').map(sel => sel.active.line)
      : [];
    // ...and so is the cursor line in Vim's Normal mode (issue #19): after `o ... Esc`, `dd` or `p`
    // the cursor rests on a line nobody is typing into, and leaving it alone left it unnumbered
    // (or numbered twice) until the cursor happened to move.
    if (!force && !skip && editor && !vimNormalMode(editor)) {
      skip = new Set(editor.selections.map(sel => sel.active.line).filter(l => doc.lineAt(l).text.trim() !== ''));
    }
    const res = renumber(text, override ?? renumberOptions(doc, { skipLines: force ? undefined : skip }));
    if (!res.edits.length) return 0;
    const before = text;
    this.applying = true;
    try {
      // A removed line goes with its line break; a multi-line newText (an extended comment
      // that wrapped onto more lines) is one replacement, and the editor writes the
      // document's own line ending for the `\n`s in it.
      if (editor) {
        await editor.edit(b => { for (const e of res.edits) { if (e.remove) b.delete(doc.lineAt(e.line).rangeIncludingLineBreak); else b.replace(doc.lineAt(e.line).range, e.newText); } }, { undoStopBefore: false, undoStopAfter: false });
      } else {
        const we = new vscode.WorkspaceEdit();
        for (const e of res.edits) { if (e.remove) we.delete(doc.uri, doc.lineAt(e.line).rangeIncludingLineBreak); else we.replace(doc.uri, doc.lineAt(e.line).range, e.newText); }
        await vscode.workspace.applyEdit(we);
      }
      if (!doc.isClosed) this.lastRenumber.set(doc.uri.toString(), { before, after: doc.getText() });
    } finally { this.applying = false; }

    // Put the caret where the instruction goes. Replacing the line leaves it at column 0,
    // i.e. in FRONT of the number we just inserted, so the next keystroke would land
    // outside the line body - which would be a worse bug than the one this fixes.
    if (editor && blankAtCursor.length === 1 && editor.selections.length === 1) {
      const line = blankAtCursor[0];
      if (!doc.isClosed && line < doc.lineCount) {
        const text = doc.lineAt(line).text;
        const colon = text.indexOf(':');
        // Only when the line really did become an empty numbered line; if the user got a
        // keystroke in first, leave their caret exactly where they put it.
        if (colon >= 0 && /^\s*(?:\d+|\s+):\s*;\s*$/.test(text)) {
          const cont = await this.continueComment(editor, line, text);
          const col = cont ?? Math.min(colon + 3, text.length);
          const pos = new vscode.Position(line, col);
          editor.selection = new vscode.Selection(pos, pos);
        }
      }
    }

    void this.s.tp.get(doc);
    return res.edits.length;
  }

  /**
   * The fresh scaffold under a comment line becomes a comment line too (beta list 2, item 9):
   * `!` after a `!` comment, a `:` continuation after an `--eg:` line. Same undo step as
   * the scaffold. Returns the caret column, or undefined when the line above is not a
   * comment with text in it (see commentScaffold).
   */
  private async continueComment(editor: vscode.TextEditor, line: number, scaffoldRaw: string): Promise<number | undefined> {
    const doc = editor.document;
    if (line === 0 || !config<boolean>('tp.continueComments', true, doc)) return undefined;
    const prog = this.s.tp.get(doc);
    const prev = prog.lines.find(l => l.line === line - 1);
    const plan = commentScaffold(prev, scaffoldRaw);
    if (!plan) return undefined;
    this.applying = true;
    try {
      await editor.edit(b => {
        b.replace(doc.lineAt(line).range, plan.newText);
        if (plan.stripPrevTerminator) b.replace(doc.lineAt(line - 1).range, doc.lineAt(line - 1).text.replace(/\s*;\s*$/, ''));
      }, { undoStopBefore: false, undoStopAfter: false });
    } finally { this.applying = false; }
    return plan.caretCol;
  }
}
