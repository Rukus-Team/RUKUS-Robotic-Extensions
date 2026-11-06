/**
 * The transfer status item: one persistent line in the status bar for whatever is running or
 * queued, with the technical step (`ftp(session 3): STOR MD:MAIN.LS`) rather than a vague
 * "pushing…". Clicking opens the queue (QuickPick) where a queued entry can be removed and a
 * running entry cancelled (the operation applies its own safe rule).
 *
 * Status bar visibility: foreground operations always; long background work (index/data
 * refreshes, snapshot from backup, container init) only when no foreground item is active;
 * sub-second reads are in the QuickPick only.
 */
import * as vscode from 'vscode';
import type { FanucServices } from '../services';
import type { TransferSnapshot, TransferState } from '@core/transferQueue';
import { commandRegistrar } from '@core/commandBoundary';
import { config } from '@core/util';

function icon(state: TransferState): string {
  switch (state) {
    case 'running': return '$(sync~spin)';
    case 'waiting': return '$(question)';
    case 'cancelling': return '$(circle-slash)';
    case 'queued': return '$(clock)';
    case 'done': return '$(check)';
    case 'failed': return '$(error)';
    case 'cancelled': return '$(circle-slash)';
  }
}

function elapsed(i: TransferSnapshot): string {
  const ms = (i.endedAt ?? Date.now()) - (i.startedAt ?? Date.now());
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}

function describe(i: TransferSnapshot): string {
  const where = i.robot ?? i.key.replace(/^(robot|container):/i, '');
  return `${i.state}${where ? ` · ${where}` : ''}${i.technical ? ` · ${i.technical}` : i.detail ? ` · ${i.detail}` : ''}`;
}

function tooltip(items: TransferSnapshot[]): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.isTrusted = false;
  const active = items.filter(i => !i.endedAt);
  const recent = items.filter(i => i.endedAt).slice(0, 5);
  for (const i of active) {
    md.appendMarkdown(`**${i.label}** — ${i.state}${i.detail ? ` · ${i.detail}` : ''} · ${elapsed(i)}\n\n`);
    if (i.technical) md.appendMarkdown(`\`${i.technical}\`\n\n`);
  }
  if (recent.length) {
    md.appendMarkdown('---\n\n**Recent**\n\n');
    for (const i of recent) md.appendMarkdown(`${icon(i.state)} ${i.label} — ${i.state} · ${elapsed(i)}${i.technical ? ` · \`${i.technical}\`` : ''}\n\n`);
  }
  md.appendMarkdown('Click to open the transfer queue.');
  return md;
}

export function registerTransferStatus(ctx: vscode.ExtensionContext, s: FanucServices) {
  const reg = commandRegistrar(ctx, s.output);
  const setRecent = () => { s.transfers.recentMs = Math.max(0, config<number>('transfers.recentSeconds', 120)) * 1000; };
  setRecent();
  const item = vscode.window.createStatusBarItem('robotCode.transfers', vscode.StatusBarAlignment.Left, 100);
  item.name = 'RUKUS: transfers';
  item.command = 'robotCode.transfers.show';
  ctx.subscriptions.push(
    item,
    s.transfers.onDidChange(() => update()),
    vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('robotCode.transfers.recentSeconds')) setRecent(); }),
  );

  const update = () => {
    const all = s.transfers.items();
    const active = all.filter(i => !i.endedAt);
    const foreground = active.filter(i => i.visibility === 'foreground');
    const background = active.filter(i => i.visibility === 'background');
    const shown = foreground.length ? foreground : background;
    const primary = shown.find(i => i.state === 'running' || i.state === 'waiting' || i.state === 'cancelling') ?? shown[0];
    if (!primary) { item.hide(); return; }
    const queued = active.filter(i => i.state === 'queued').length;
    // A decision/cancel is more important than the last FTP verb.
    const tech = primary.state === 'waiting' || primary.state === 'cancelling'
      ? (primary.detail ?? primary.state)
      : (primary.technical ?? primary.detail ?? primary.state);
    item.text = `${icon(primary.state)} ${primary.label} — ${tech}${queued ? ` · +${queued} queued` : ''}`;
    item.color = primary.state === 'failed' || primary.state === 'cancelling' ? new vscode.ThemeColor('errorForeground') : undefined;
    item.tooltip = tooltip(all);
    item.show();
  };
  update();

  /** the live transfer log; selecting an entry writes its technical lines here */
  let log: vscode.OutputChannel | undefined;
  const showLog = (i: TransferSnapshot) => {
    log ??= vscode.window.createOutputChannel('RUKUS Transfers');
    log.clear();
    log.appendLine(`${i.label}  (${i.state}${i.robot ? ` · ${i.robot}` : ''}${i.file ? ` · ${i.file}` : ''})`);
    log.appendLine(`key: ${i.key}  elapsed: ${elapsed(i)}${i.error ? `  error: ${i.error}` : ''}`);
    log.appendLine('');
    for (const line of i.technicalLog) log.appendLine(line);
    log.show(true);
  };
  ctx.subscriptions.push({ dispose: () => log?.dispose() });

  const openQueue = () => {
    const qp = vscode.window.createQuickPick();
    qp.title = 'Robot transfers';
    qp.placeholder = 'Running, queued and recent operations';
    qp.matchOnDescription = true;
    qp.matchOnDetail = true;
    const build = () => {
      const all = s.transfers.items();
      const active = all.filter(i => !i.endedAt);
      const recent = all.filter(i => i.endedAt);
      const rows: vscode.QuickPickItem[] = [];
      const row = (i: TransferSnapshot): vscode.QuickPickItem => ({
        label: `${icon(i.state)} ${i.label}`,
        description: describe(i),
        detail: `${i.endedAt ? 'ended' : i.startedAt ? 'running' : 'queued'} · ${elapsed(i)}${i.error ? ` · ${i.error}` : ''}`,
        buttons: i.endedAt ? [] : [{ iconPath: new vscode.ThemeIcon('close'), tooltip: i.state === 'queued' ? 'Remove from the queue' : 'Cancel this transfer' }],
        // keep our id on the row
        ...({ id: i.id, ended: !!i.endedAt } as object),
      });
      if (active.length) rows.push({ label: 'Active', kind: vscode.QuickPickItemKind.Separator });
      for (const i of active) rows.push(row(i));
      if (recent.length) {
        rows.push({ label: 'Recent', kind: vscode.QuickPickItemKind.Separator });
        for (const i of recent) rows.push(row(i));
      }
      if (active.length) rows.push({ label: '$(close-all) Cancel all active transfers', ...({ id: -1, ended: false } as object) });
      qp.items = rows;
    };
    build();
    // Technical notes arrive per file/verb; do not rebuild the picker on every one.
    let timer: NodeJS.Timeout | undefined;
    const scheduleBuild = () => { if (timer) return; timer = setTimeout(() => { timer = undefined; build(); }, 150); };
    const sub = s.transfers.onDidChange(scheduleBuild);
    qp.onDidTriggerItemButton(e => {
      const id = (e.item as unknown as { id?: number }).id;
      if (id && id > 0) s.transfers.cancel(id);
    });
    qp.onDidAccept(() => {
      const pick = qp.selectedItems[0] as unknown as { id?: number; ended?: boolean } | undefined;
      if (!pick) return;
      if (pick.id === -1) { s.transfers.cancelAll(); qp.hide(); return; }
      const snap = s.transfers.items().find(i => i.id === pick.id);
      if (snap) showLog(snap);
      qp.hide();
    });
    qp.onDidHide(() => { if (timer) clearTimeout(timer); sub.dispose(); qp.dispose(); });
    qp.show();
  };

  reg('robotCode.transfers.show', () => openQueue());
  reg('robotCode.transfers.cancelAll', () => { s.transfers.cancelAll(); });
}
