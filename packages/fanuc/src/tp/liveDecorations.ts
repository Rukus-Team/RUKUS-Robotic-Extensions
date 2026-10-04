/**
 * Register / I/O values shown after each reference in TP editors, from the last time
 * the user read them off the robot. Rendered as `{value}` text decorations (not inlay hints)
 * so each value can carry its own colour, muted by the `robotCode.hint*` palette: ON green,
 * OFF dim, numbers amber, strings green, simulated points yellow. Wrapped in braces and flush
 * so the value reads as an editor hint, never as code.
 *
 * Drawing these costs the robot nothing - they come out of the snapshot. But a value
 * read ten minutes ago must not look like one read now, so anything past
 * robotCode.live.staleAfterSeconds is greyed out and the age is always in the hover.
 */
import * as vscode from 'vscode';
import type { FanucServices } from '../services';
import { IO_KINDS } from './parser';
import { config } from '@core/util';

export function registerLiveDecorations(ctx: vscode.ExtensionContext, s: FanucServices) {
  const mk = (color: string, bold = false) => vscode.window.createTextEditorDecorationType({
    after: { color: new vscode.ThemeColor(color), margin: '0', fontWeight: bold ? 'bold' : 'normal' },
  });
  const types = {
    on: mk('robotCode.hintStateOn', true),
    off: mk('robotCode.hintStateOff'),
    num: mk('robotCode.hintValue'),
    str: mk('robotCode.hintString'),
    sim: mk('robotCode.hintSim', true),
    /** read a while ago: the same muted text, dimmer, so it reads as history not as a feed */
    stale: mk('robotCode.hintStale'),
  };
  ctx.subscriptions.push(...Object.values(types));

  const apply = () => {
    const live = s.live;
    const enabled = config<boolean>('live.inlayValues', true) && config<boolean>('tp.inlineHints', true) && !!live?.connected().length;
    for (const ed of vscode.window.visibleTextEditors) {
      if (ed.document.languageId !== 'fanuc-tp') continue;
      const buckets: Record<keyof typeof types, vscode.DecorationOptions[]> = { on: [], off: [], num: [], str: [], sim: [], stale: [] };
      if (enabled) {
        const staleMs = Math.max(5, config<number>('live.staleAfterSeconds', 60)) * 1000;
        const prog = s.tp.get(ed.document);
        for (const d of prog.dataRefs) {
          if (d.kind !== 'R' && d.kind !== 'SR' && !IO_KINDS.has(d.kind)) continue;
          const v = live!.liveValue(d.kind, d.index);
          if (!v) continue;
          const pos = new vscode.Position(d.line, d.span.col + d.span.len);
          const text = v.text;
          const secs = Math.round(v.age / 1000);
          const bucket: keyof typeof types = v.age > staleMs ? 'stale'
            : /\(SIM\)/.test(text) ? 'sim' : text === 'ON' ? 'on' : text === 'OFF' ? 'off' : d.kind === 'SR' ? 'str' : 'num';
          buckets[bucket].push({
            range: new vscode.Range(pos, pos),
            renderOptions: { after: { contentText: `{${text}}` } },
            hoverMessage: `Read from ${v.robot} ${secs < 60 ? `${secs} s` : `${Math.round(secs / 60)} min`} ago${v.age > staleMs ? ' — may be out of date' : ''}`,
          });
        }
      }
      for (const k of Object.keys(types) as Array<keyof typeof types>) ed.setDecorations(types[k], buckets[k]);
    }
  };

  // registerLive() runs before this, so s.live is already set
  if (s.live) ctx.subscriptions.push(s.live.onDidChange(apply));
  ctx.subscriptions.push(
    vscode.window.onDidChangeVisibleTextEditors(apply),
    vscode.workspace.onDidChangeTextDocument(e => { if (e.document.languageId === 'fanuc-tp') apply(); }),
    vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('robotCode.live')) apply(); }),
  );
  apply();
}
