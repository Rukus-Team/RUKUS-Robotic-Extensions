/**
 * Alarm codes in the editor: a hover over FILE-014 / SRVO-002 wherever it is written (a comment, a
 * message string, a TP remark), over the number a KAREL program uses for one (POST_ERR(2014, ...),
 * `IF status = 2014`, ERROR[2014]), and the "Look Up FANUC Alarm" command.
 */
import * as vscode from 'vscode';
import { allAlarms, setAlarmDataDir, lookupAlarm, alarmMarkdownLines, type AlarmInfo } from './alarms';
import { md } from '@core/util';

const ALARM_SCHEME = 'robotcode-alarm';

/**
 * The alarm at `col` of a line. FACILITY-NNN anywhere; a bare number only when `numbers` is set
 * (KAREL) and the line is about errors, so a DELAY 2000 or a loop bound is not taken for one.
 */
export function alarmAt(lineText: string, col: number, numbers: boolean): { alarm: AlarmInfo; start: number; end: number } | undefined {
  for (const m of lineText.matchAll(/\b([A-Z][A-Z0-9]{1,4})-(\d{3,4})\b/g)) {
    if (col < m.index! || col > m.index! + m[0].length) continue;
    const alarm = lookupAlarm(m[0]);
    if (alarm) return { alarm, start: m.index!, end: m.index! + m[0].length };
  }
  if (!numbers || !/\bPOST_ERR\w*\b|\bERROR\s*\[|\bstat(us)?\b|\berr\w*\b/i.test(lineText)) return undefined;
  for (const m of lineText.matchAll(/(?<![\w.$])\d{4,6}(?![\w.])/g)) {
    if (col < m.index! || col > m.index! + m[0].length) continue;
    const alarm = lookupAlarm(Number(m[0]));
    if (alarm) return { alarm, start: m.index!, end: m.index! + m[0].length };
  }
  return undefined;
}

export function alarmHover(lineNo: number, hit: { alarm: AlarmInfo; start: number; end: number }): vscode.Hover {
  const lines = alarmMarkdownLines(hit.alarm);
  if (hit.alarm.code !== undefined) lines.splice(1, 0, '', `_KAREL status / POST\\_ERR code ${hit.alarm.code}_`);
  return new vscode.Hover(md(...lines), new vscode.Range(lineNo, hit.start, lineNo, hit.end));
}

function alarmPage(id: string): string {
  const a = lookupAlarm(id);
  if (!a) return `# ${id}\n\nNo entry for this code.`;
  const [head, ...rest] = alarmMarkdownLines(a);
  return [`# ${head.replace(/^\*\*(.*?)\*\*/, '$1')}`, ...(a.code !== undefined ? ['', `KAREL status / POST\\_ERR code **${a.code}**`] : []), ...rest].join('\n');
}

export function registerAlarmLookup(ctx: vscode.ExtensionContext): void {
  setAlarmDataDir(ctx.extensionPath);
  ctx.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(ALARM_SCHEME, {
      provideTextDocumentContent: uri => alarmPage(decodeURIComponent(uri.path.replace(/^\//, '').replace(/\.md$/, ''))),
    }),
    // by code (SRVO-002, 2014) or by words from the message
    vscode.commands.registerCommand('robotCode.lookupAlarm', async (code?: string) => {
      let id = code ? lookupAlarm(code)?.id : undefined;
      if (!id) {
        const items = Object.entries(allAlarms()).map(([k, e]) => ({ label: k, description: e.message, detail: e.cause }));
        const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Alarm code (SRVO-002, FILE-014) or words from the message', matchOnDescription: true, matchOnDetail: true });
        id = pick?.label;
      }
      if (!id) return;
      await vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.from({ scheme: ALARM_SCHEME, path: `/${encodeURIComponent(id)}.md` }));
    }),
  );
}
