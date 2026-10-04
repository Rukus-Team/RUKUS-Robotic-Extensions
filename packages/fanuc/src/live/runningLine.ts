/**
 * Highlights the TP line a connected robot was executing when program state was last
 * read, in any open editor whose program matches a running/paused task, and shows the
 * task in the status bar.
 *
 * "was", not "is": program state is only read when the user presses Get (or while
 * auto-refresh is on for that robot), so every label here carries its age. A marker
 * that silently goes stale is worse than no marker - the operator would trust a line
 * number the robot left minutes ago.
 */
import * as vscode from 'vscode';
import type { FanucServices } from '../services';
import type { RobotManager } from '@core/live/robotManager';
import { programNameFromUri } from '@core/util';
import { ageTicked } from '@core/live/views';
import { gated } from '@core/experimental';

function fmtAge(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return `${Math.round(s / 3600)} h ago`;
}

export function registerRunningLine(ctx: vscode.ExtensionContext, s: FanucServices, robots: RobotManager) {
  const running = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('editor.stackFrameHighlightBackground'),
    overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.infoForeground'),
    overviewRulerLane: vscode.OverviewRulerLane.Full,
    gutterIconPath: ctx.asAbsolutePath('media/running.svg'),
    gutterIconSize: 'contain',
  });
  const paused = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('editor.focusedStackFrameHighlightBackground'),
    gutterIconPath: ctx.asAbsolutePath('media/paused.svg'),
    gutterIconSize: 'contain',
  });
  // The running-program status text moved into the connection item on the right
  // (views/statusBar.ts), so the robot is named once. This module keeps only the editor
  // decorations and the reveal command.
  ctx.subscriptions.push(running, paused);

  const apply = () => {
    const active = robots.activeTpTasks();
    for (const ed of vscode.window.visibleTextEditors) {
      if (ed.document.languageId !== 'fanuc-tp') continue;
      const prog = s.tp.get(ed.document);
      const name = (prog.header.name ?? programNameFromUri(ed.document.uri)).toUpperCase();
      const runRanges: vscode.DecorationOptions[] = [];
      const pauseRanges: vscode.DecorationOptions[] = [];
      for (const { robot, task, age } of active) {
        const cur = task.current!;
        if (cur.program.toUpperCase() !== name || cur.type.toUpperCase() !== 'TP') continue;
        const line = prog.lines.find(l => l.num === cur.line);
        if (!line) continue;
        const hover = new vscode.MarkdownString(
          `**${robot}** task ${task.taskNo} (${task.name}) was ${task.status} here — TP line ${cur.line}\n\n` +
          `Program state read **${fmtAge(age)}**. [Read it again](command:robotCode.live.getTasks?${encodeURIComponent(JSON.stringify(robot))})`);
        hover.isTrusted = true;
        (task.status === 'RUNNING' ? runRanges : pauseRanges).push({ range: ed.document.lineAt(line.line).range, hoverMessage: hover });
      }
      ed.setDecorations(running, runRanges);
      ed.setDecorations(paused, pauseRanges);
    }
  };

  ctx.subscriptions.push(
    robots.onDidChange(apply),
    ageTicked.event(apply),   // "(40 s ago)" on the status bar counts up; no read
    vscode.window.onDidChangeVisibleTextEditors(apply),
    vscode.workspace.onDidChangeTextDocument(e => { if (e.document.languageId === 'fanuc-tp') apply(); }),
    vscode.commands.registerCommand('robotCode.live.revealRunning', gated(async () => {
      let first = robots.activeTpTasks()[0];
      if (!first) {
        // Distinguish "nothing running" from "we never looked" - they are not the same
        // answer, and only one of them is about the robot.
        const unread = robots.connected().filter(c => !c.snapshot!.fetchedAt.has('tasks'));
        if (unread.length) {
          const pick = await vscode.window.showInformationMessage(
            `Program state has not been read from ${unread.map(c => c.profile.name).join(', ')} yet.`, 'Read it now');
          if (pick !== 'Read it now') return;
          for (const c of unread) await robots.fetch(c.profile.name, ['tasks']);
          first = robots.activeTpTasks()[0];
        }
        if (!first) { vscode.window.showInformationMessage('No TP program was running on a connected robot.'); return; }
      }
      const cur = first.task.current!;
      const info = s.index.get(cur.program);
      if (!info) { vscode.window.showInformationMessage(`${cur.program} is running on ${first.robot} but is not in the workspace. Open it from the robot via the Robots view.`); return; }
      const doc = await vscode.workspace.openTextDocument(info.uri);
      const ed = await vscode.window.showTextDocument(doc, { preview: false });
      const line = s.tp.get(doc).lines.find(l => l.num === cur.line);
      if (line) { const pos = new vscode.Position(line.line, 0); ed.selection = new vscode.Selection(pos, pos); ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter); }
      apply();
    })),
  );
  apply();
}
