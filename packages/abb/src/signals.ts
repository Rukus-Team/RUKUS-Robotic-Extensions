/**
 * The I/O signals RAPID can name. They are not declared in RAPID: they live in the controller's
 * I/O configuration (SYSPAR/EIO.cfg in a backup, EIO_SIGNAL entries) or come from a connected
 * controller over RWS. Completion offers them where a signal or a condition fits.
 *
 *   EIO_SIGNAL:
 *         -Name "DI_Gripper_Open" -SignalType "DI" -Device "d651" -DeviceMap "0"
 *         -Name "go_Prog" -SignalType "GO" -Device "d651" -DeviceMap "8-15" \
 *               -Access "All"
 *   #
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export type SignalType = 'DI' | 'DO' | 'AI' | 'AO' | 'GI' | 'GO';
export interface IoSignal { name: string; type: SignalType; device?: string; label?: string }

const TYPES = new Set<string>(['DI', 'DO', 'AI', 'AO', 'GI', 'GO']);

/** The EIO_SIGNAL entries of an EIO.cfg, in file order. */
export function parseEioSignals(text: string): IoSignal[] {
  const joined = text.replace(/\\\r?\n\s*/g, ' ');
  const section = /^EIO_SIGNAL:\s*$([\s\S]*?)(?=^#|^[A-Z_]+:\s*$|(?![\s\S]))/m.exec(joined)?.[1] ?? '';
  const out: IoSignal[] = [];
  for (const line of section.split(/\r?\n/)) {
    const name = /-Name\s+"([^"]+)"/.exec(line)?.[1];
    const type = /-SignalType\s+"([^"]+)"/.exec(line)?.[1]?.toUpperCase();
    if (!name || !type || !TYPES.has(type)) continue;
    out.push({
      name, type: type as SignalType,
      device: /-Device\s+"([^"]*)"/.exec(line)?.[1] || /-Unit\s+"([^"]*)"/.exec(line)?.[1] || undefined,
      label: /-Label\s+"([^"]*)"/.exec(line)?.[1] || undefined,
    });
  }
  return out;
}

const cache = new Map<string, { at: number; list: IoSignal[] }>();

/** The signals of the backup at `root` (its SYSPAR/EIO.cfg), re-read when the file changes. */
export function backupSignals(root: string): IoSignal[] {
  let file: string | undefined;
  try { file = fs.readdirSync(path.join(root, 'SYSPAR')).find(n => /^eio\.cfg$/i.test(n)); } catch { /* no SYSPAR */ }
  if (!file) return [];
  const full = path.join(root, 'SYSPAR', file);
  let at = 0;
  try { at = fs.statSync(full).mtimeMs; } catch { return []; }
  const hit = cache.get(full.toLowerCase());
  if (hit && hit.at === at) return hit.list;
  let list: IoSignal[] = [];
  try { list = parseEioSignals(fs.readFileSync(full, 'latin1')); } catch { /* unreadable */ }
  cache.set(full.toLowerCase(), { at, list });
  return list;
}

/** Signals read from connected controllers; the live view registers the source. */
let liveSource: () => IoSignal[] = () => [];
export function setLiveSignalSource(fn: () => IoSignal[]): void { liveSource = fn; }
export function liveSignals(): IoSignal[] { try { return liveSource(); } catch { return []; } }

/** A RAPID argument type a signal of `type` can be passed as. */
export function signalFits(type: SignalType, argType: string): boolean {
  const t = argType.toLowerCase();
  if (t.startsWith('signal')) return t === 'signal' + type.toLowerCase();
  // in an expression a signal reads as its value: digital ones as 0/1, groups and analogs as numbers
  if (t === 'dionum') return type === 'DI' || type === 'DO';
  if (t === 'num' || t === 'dnum') return true;
  return false;
}
