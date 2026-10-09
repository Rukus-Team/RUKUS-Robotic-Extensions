/**
 * The VS Code side of a controller search (netScan.ts): read the PC's adapters, ask before a WiFi
 * one is scanned, run the scan behind a cancellable progress notification.
 */
import * as vscode from 'vscode';
import { currentAdapters, adapterLabel, type Adapter } from './netScan';

export interface ScanScope { adapters: Adapter[]; wifi: boolean }

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
