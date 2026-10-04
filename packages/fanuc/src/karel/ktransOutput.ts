/**
 * Pure parser for ktrans (WinOLPC) console output. Verified against KTRANS V9.40-1:
 *
 *   C:\path\prog.kl(10)
 *     10 END ktbad
 *        ^ ERROR
 *   Invalid statement or "ENDxxx" or "UNTIL" expected.
 *
 *   *** Translation successful, 82 bytes of p-code generated, checksum 56493. ***
 *   ===============Translation not successful===============
 */
export interface KtransIssue { line: number; col: number; severity: 'error' | 'warning'; message: string }
export interface KtransResult { issues: KtransIssue[]; success: boolean | undefined; summary?: string; notices: string[] }

export function parseKtransIssues(out: string): KtransResult {
  const issues: KtransIssue[] = [];
  const notices: string[] = [];
  const lines = out.split(/\r?\n/);
  let success: boolean | undefined;
  let summary: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/Translation successful/i.test(l)) { success = true; summary = l.replace(/\*/g, '').trim(); continue; }
    if (/Translation not successful/i.test(l)) { success = false; continue; }
    if (/^Notice:/i.test(l)) { notices.push(l.replace(/^Notice:\s*/i, '').trim() + (lines[i + 1] && !/^\s*$/.test(lines[i + 1]) && !/^Notice|KTRANS|Copyright/i.test(lines[i + 1]) ? ' ' + lines[i + 1].trim() : '')); continue; }
    const head = /^(.*?)\((\d+)\)\s*$/.exec(l);
    if (!head || !/\.kl$/i.test(head[1].trim())) continue;
    const lineNo = parseInt(head[2], 10) - 1;
    const echo = lines[i + 1] ?? '';
    const caret = lines[i + 2] ?? '';
    const em = /^(\s*\d+\s)(.*)$/.exec(echo);
    const cm = /^(\s*)\^\s*(ERROR|WARNING)?/i.exec(caret);
    const col = em && cm ? Math.max(0, cm[1].length - em[1].length) : 0;
    const sevWord = cm?.[2]?.toUpperCase() ?? 'ERROR';
    let msg = '';
    for (let k = i + 3; k < Math.min(lines.length, i + 8); k++) {
      const t = lines[k].trim();
      if (!t) { if (msg) break; continue; }
      if (/^(.*?)\((\d+)\)\s*$/.test(t) || /^={5,}/.test(t)) break;
      msg = msg ? `${msg} ${t}` : t;
    }
    const issue: KtransIssue = { line: lineNo, col, severity: sevWord === 'WARNING' ? 'warning' : 'error', message: msg || sevWord };
    if (!issues.some(x => x.line === issue.line && x.col === issue.col && x.message === issue.message)) issues.push(issue);
    i += 2;
  }
  return { issues, success, summary, notices };
}
