/**
 * The VS Code side of a controller search (netScan.ts): read the PC's adapters, ask before a WiFi
 * one is scanned, run the scan behind a cancellable progress notification, and write down what
 * happened: when a robot is not found, the "Robot Code: Find Robots" output says what was searched
 * and what answered.
 */
import * as os from 'node:os';
import * as vscode from 'vscode';
import { currentAdapters, adapterLabel, describeAdapters, parseScanRange, type Adapter, type ScanMiss } from './netScan';

/** `hosts`: addresses the user typed, searched instead of this PC and its networks. */
export interface ScanScope { adapters: Adapter[]; wifi: boolean; hosts?: readonly string[] }

let channel: vscode.OutputChannel | undefined;
const scanLog = () => (channel ??= vscode.window.createOutputChannel('Robot Code: Find Robots'));

/** A search's result in the log, and a window when nothing was found so it cannot go unseen. */
export function logScanResult(brand: string, s: ScanScope, found: readonly string[], missed: readonly ScanMiss[]): void {
  const log = scanLog();
  log.appendLine(`--- ${brand} search ${new Date().toLocaleString()}: ${s.hosts ? `${s.hosts.length} address(es) typed` : scopeSummary(s)}`);
  for (const line of s.hosts ? [] : describeAdapters(os.networkInterfaces(), s.adapters, s.wifi)) log.appendLine(`  ${line}`);
  for (const f of found) log.appendLine(`  found ${f}`);
  for (const m of missed) log.appendLine(`  open, not a ${brand} controller: ${m.target.host}:${m.target.port} - ${m.why}`);
  log.appendLine(`  ${found.length} found, ${missed.length} other open port(s)`);
  if (!found.length && !missed.length) log.show(true);
}

/** A range to search, typed; undefined when cancelled. */
export async function askScanRange(brand: string): Promise<ScanScope | undefined> {
  const text = await vscode.window.showInputBox({
    title: `Search a range for ${brand} controllers`,
    prompt: 'An address, a range or a subnet (a /22 at most)',
    placeHolder: '192.168.1.0/24, 10.1.2.50-60 or 10.1.2.77',
    ignoreFocusOut: true,
    validateInput: v => { const r = parseScanRange(v); return typeof r === 'string' ? r : undefined; },
  });
  if (!text) return undefined;
  const hosts = parseScanRange(text);
  return typeof hosts === 'string' ? undefined : { adapters: [], wifi: false, hosts };
}

/**
 * The adapters to scan. Wired ones always; WiFi ones only when the user says so, because on a
 * public or office WiFi probing every address is unwelcome and finds no robot. Undefined: cancelled.
 */
export async function chooseScanScope(brand: string): Promise<ScanScope | undefined> {
  const adapters = await currentAdapters();
  const wifi = adapters.filter(a => a.kind === 'wifi');
  if (!wifi.length) return { adapters, wifi: false };
  const yes = 'Search WiFi Too', no = 'Skip WiFi';
  const pick = await vscode.window.showInformationMessage(
    `Search for ${brand} controllers on WiFi as well?`,
    { modal: true, detail: `This PC is on WiFi: ${wifi.map(adapterLabel).join(', ')}.\n\nOnly say yes on a robot or cell network you trust - not on a public, guest or office WiFi. This PC, the default robot addresses and wired networks are searched either way.` },
    yes, no);
  if (!pick) return undefined;
  return { adapters, wifi: pick === yes };
}

/** What was searched, for a "nothing found" message. */
export function scopeSummary(s: ScanScope): string {
  if (s.hosts) return `${s.hosts.length} typed address${s.hosts.length === 1 ? '' : 'es'}`;
  const wired = s.adapters.filter(a => a.kind === 'wired');
  const wifi = s.wifi ? s.adapters.filter(a => a.kind === 'wifi') : [];
  const nets = [...wired, ...wifi].map(adapterLabel);
  return `this PC${nets.length ? `, ${nets.join(', ')}` : ''}${s.adapters.some(a => a.kind === 'wifi') && !s.wifi ? ' (WiFi skipped)' : ''}`;
}

/** Run `work` under a cancellable notification that counts addresses. */
export function withScanProgress<T>(title: string, work: (signal: vscode.CancellationToken, progress: (done: number, total: number) => void) => Promise<T>): Thenable<T> {
  return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, (p, token) => {
    let last = 0;
    return work(token, (done, total) => {
      const pct = Math.floor((done / total) * 100);
      if (pct > last) { p.report({ increment: pct - last, message: `${done} of ${total} addresses` }); last = pct; }
    });
  });
}
