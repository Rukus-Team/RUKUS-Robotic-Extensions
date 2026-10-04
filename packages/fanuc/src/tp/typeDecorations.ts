/**
 * Editor affordances that say what a token IS, in the same colours the sidebar uses.
 *
 * - `CALL X` / `RUN X` / a macro name: tinted by what it resolves to - amber for a TP
 *   program, blue for a PC program, teal for a macro-table entry, red-dotted when nothing
 *   resolves - so a Ctrl+click target reads as one span of one colour before it is clicked.
 * - a motion line's `P[n]`: the representation and frames as separate badges
 *   (`P[1]{JNT}{UF1}{UT2}`) at the end of the reference, tinted by representation. A
 *   decoration rather than an inlay hint so it can carry a colour.
 * - an extended (`--eg`) comment: a faint band across every line of it, so the extent is
 *   visible without reading for the ` ;`.
 * - a register or I/O point being READ: a dotted underline, parentheses or not, so usage is
 *   visible at the line and not only in the cross-reference report.
 *
 * All from the parse and the index; none of it costs a controller anything.
 */
import * as vscode from 'vscode';
import type { FanucServices } from '../services';
import { findPosition, positionMarkdown, frameHintFields, isIndirectLabelIndex, type PositionHintField } from './parser';
import { accessOfRef } from '../tools/xref';
import { config, md, spanToRange } from '@core/util';
import { TYPE_COLOR } from '@core/views/typeStyle';
import { resolveProgram, isPcProgram, robotOf } from '@core/resolve';

export function registerTypeDecorations(ctx: vscode.ExtensionContext, s: FanucServices) {
  const colored = (color: string, extra: vscode.DecorationRenderOptions = {}) => vscode.window.createTextEditorDecorationType({ color: new vscode.ThemeColor(color), ...extra });
  const types = {
    tp: colored(TYPE_COLOR.tp),
    pc: colored(TYPE_COLOR.pc),
    macro: colored(TYPE_COLOR.macro),
    missing: colored(TYPE_COLOR.missing, { textDecoration: 'underline dotted' }),
    frameJoint: vscode.window.createTextEditorDecorationType({ after: { color: new vscode.ThemeColor('robotCode.hintFrameJoint'), margin: '0' } }),
    frameCart: vscode.window.createTextEditorDecorationType({ after: { color: new vscode.ThemeColor('robotCode.hintFrameCart'), margin: '0' } }),
    frameOther: vscode.window.createTextEditorDecorationType({ after: { color: new vscode.ThemeColor('robotCode.hintFrameOther'), margin: '0' } }),
    commentHint: vscode.window.createTextEditorDecorationType({ after: { color: new vscode.ThemeColor('robotCode.hintComment'), margin: '0' } }),
    egBlock: vscode.window.createTextEditorDecorationType({ isWholeLine: true, backgroundColor: new vscode.ThemeColor('editor.findRangeHighlightBackground') }),
    read: vscode.window.createTextEditorDecorationType({ borderStyle: 'none none dotted none', borderWidth: '1px', borderColor: new vscode.ThemeColor('editorLineNumber.foreground') }),
    commentedCont: vscode.window.createTextEditorDecorationType({ color: '#5c6370', fontStyle: 'italic', textDecoration: 'line-through' }),
  };
  ctx.subscriptions.push(...Object.values(types));

  const apply = () => {
    const showCalls = config<boolean>('tp.decorations.callTargets', true);
    const showFrames = config<boolean>('tp.inlineHints', true) && config<boolean>('tp.decorations.positions', true);
    // which badges to draw after P[n]: any of type / userFrame / userTool (empty = none)
    const positionFields = new Set(config<PositionHintField[]>('tp.decorations.positionFields', ['type', 'userFrame', 'userTool']));
    const showComments = config<boolean>('tp.inlineHints', true) && config<boolean>('tp.decorations.comments', true);
    const showEg = config<boolean>('tp.decorations.extendedComments', true);
    const showReads = config<boolean>('tp.decorations.registerReads', true);
    for (const ed of vscode.window.visibleTextEditors) {
      if (ed.document.languageId !== 'fanuc-tp') continue;
      const prog = s.tp.get(ed.document);
      const b: Record<keyof typeof types, vscode.DecorationOptions[]> = { tp: [], pc: [], macro: [], missing: [], frameJoint: [], frameCart: [], frameOther: [], commentHint: [], egBlock: [], read: [], commentedCont: [] };

      if (showCalls) {
        // "missing" is only said when it can be known: a robot file whose device has not
        // been listed yet gets no red until it has
        const robot = robotOf(ed.document.uri);
        const canJudge = !robot || !!s.live?.hasListing(robot);
        for (const c of prog.calls) {
          if (/^(SR|PROG|R|AR)$/.test(c.name)) continue;   // indirect call, nothing to resolve
          const res = resolveProgram(s, c.name, ed.document.uri);
          if (!res && !canJudge) continue;
          const kind = !res ? 'missing' : isPcProgram(res) ? 'pc' : 'tp';
          b[kind].push({ range: spanToRange(c.span), hoverMessage: !res ? undefined : `${kind === 'pc' ? 'PC program' : 'TP program'}${res.kind === 'binary' ? ' (compiled only)' : ''}${res.remote ? ` on ${res.remote.robot}` : ''}` });
        }
        for (const m of prog.macros) {
          const entry = s.data.macro(m.name, ed.document.uri);
          if (!entry) continue;   // not known to be a macro; the diagnostics say so if the table is loaded
          b.macro.push({ range: spanToRange(m.span), hoverMessage: `Macro → ${entry.progName}` });
        }
      }

      if (showFrames) {
        for (const l of prog.lines) {
          const t = l.motion?.target;
          if (!t || t.kind !== 'P') continue;
          // The label belongs on a motion line in /MN and nowhere else. If the text under the
          // span is not the P[ it was parsed from, the parse is not of this text - say nothing
          // rather than write "Cartesian · UF2/UT2" into the middle of a /POS value.
          if (prog.sections.pos !== undefined && l.line >= prog.sections.pos) continue;
          if (l.line >= ed.document.lineCount || !ed.document.lineAt(l.line).text.startsWith('P[', t.span.col)) continue;
          const p = findPosition(prog, t.index);
          const g = p?.groups[0];
          if (!g) continue;
          // one `{ }` per selected piece: P[1]{JNT}{UF1}{UT2}, or P[1]{UF1}{UT2} / P[1]{JNT} /
          // nothing, per `tp.decorations.positionFields`
          const label = frameHintFields(g).filter(part => positionFields.has(part.field)).map(part => `{${part.text}}`).join('');
          if (!label) continue;
          const at = new vscode.Position(l.line, t.span.col + t.span.len);
          const bucket = g.kind === 'joint' ? 'frameJoint' : g.kind === 'cartesian' ? 'frameCart' : 'frameOther';
          b[bucket].push({ range: new vscode.Range(at, at), renderOptions: { after: { contentText: label } }, hoverMessage: md(positionMarkdown(p!)) });
        }
      }

      if (showComments) {
        // The controller comment for a register/IO written without one, drawn as `{comment}`
        // after the token. A decoration, not an inlay hint, so no theme's inlay-hint background
        // can tint it. The hover offers the same one-click insert the inlay hint used to.
        for (const d of prog.dataRefs) {
          if (d.comment) continue;   // already written in the program
          if (d.kind === 'AR' || d.kind === 'GP' || d.kind === 'TIMER' || d.kind === 'UALM' || d.kind === 'VR') continue;
          // R[n] inside LBL[R[n]] is a label index, not data: no comment suggestion
          if (d.kind === 'R' && isIndirectLabelIndex(ed.document.lineAt(d.line).text, d.span.col)) continue;
          const c = s.data.comment(d.kind, d.index, ed.document.uri) ?? s.index.inlineComment(d.kind, d.index, ed.document.uri)?.comment;
          if (!c) continue;
          const at = new vscode.Position(d.line, d.span.col + d.span.len);
          const insert = `command:robotCode.tp.insertRegisterComment?${encodeURIComponent(JSON.stringify([ed.document.uri.toString(), d.line, d.span.col + d.span.len - 1, c]))}`;
          const hover = new vscode.MarkdownString(`Controller comment: **${c}** — not written in the program.\n\n[$(insert) Auto-fill comment](${insert})`);
          hover.isTrusted = true;
          hover.supportThemeIcons = true;
          b.commentHint.push({ range: new vscode.Range(at, at), renderOptions: { after: { contentText: `{${c}}` } }, hoverMessage: hover });
        }
        // PAYLOAD[n] → PAYLOAD[n]{Tool w/o Part}: the schedule's own comment from symotn.va
        const ds = s.data.dataset(ed.document.uri);
        if (ds?.payloads.size) {
          for (const l of prog.lines) {
            if (l.kind !== 'instruction') continue;
            if (prog.sections.pos !== undefined && l.line >= prog.sections.pos) continue;
            const m = /^PAYLOAD\[(\d+)\]/.exec(l.body);
            const p = m ? ds.payloads.get(parseInt(m[1], 10)) : undefined;
            if (!p?.initialized) continue;
            const at = new vscode.Position(l.line, l.bodyCol + l.raw.slice(l.bodyCol).indexOf('PAYLOAD[') + m![0].length);
            b.commentHint.push({ range: new vscode.Range(at, at), renderOptions: { after: { contentText: `{${p.comment}}` } }, hoverMessage: `Payload schedule ${p.index} on ${ds.label}: ${p.mass} kg` });
          }
        }
      }

      if (showEg) {
        for (const l of prog.lines) if (l.ext) b.egBlock.push({ range: ed.document.lineAt(l.line).range });
      }

      if (showReads) {
        for (const d of prog.dataRefs) {
          if (d.kind === 'AR' || d.kind === 'GP') continue;
          const a = accessOfRef(prog, d);
          if (a === 'write' || a === 'motion' || a === 'call-arg') continue;
          b.read.push({ range: spanToRange(d.span), hoverMessage: a === 'condition' ? 'read in a condition' : a === 'wait' ? 'read by WAIT' : 'read' });
        }
      }

      // Style continuation lines as commented when their parent line is commented
      for (let i = 1; i < ed.document.lineCount; i++) {
        const lineText = ed.document.lineAt(i).text;
        if (!lineText.trimStart().startsWith(':')) continue;
        const parentText = ed.document.lineAt(i - 1).text;
        const colonIdx = parentText.indexOf(':');
        if (colonIdx >= 0 && parentText.slice(colonIdx).includes('//')) {
          // Only strike through the instruction body, not the scaffold prefix
          const contColon = lineText.indexOf(':');
          const bodyStart = contColon >= 0 ? contColon + 1 + (lineText.slice(contColon + 1).length - lineText.slice(contColon + 1).trimStart().length) : 0;
          const range = new vscode.Range(i, bodyStart, i, lineText.length);
          b.commentedCont.push({ range });
        }
      }

      for (const k of Object.keys(types) as Array<keyof typeof types>) ed.setDecorations(types[k], b[k]);
    }
  };

  ctx.subscriptions.push(
    vscode.window.onDidChangeVisibleTextEditors(apply),
    vscode.workspace.onDidChangeTextDocument(e => { if (e.document.languageId === 'fanuc-tp') apply(); }),
    vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('robotCode.tp')) apply(); }),
    s.index.onDidChange(apply),
    s.data.onDidChange(apply),
  );
  apply();
}
