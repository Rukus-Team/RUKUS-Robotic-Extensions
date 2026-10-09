/**
 * RAPID data read off a controller (RwsClient.searchData + dataValue): the order it is shown in
 * and the read-only table the "RAPID data" page shows. Pure, so tests drive it.
 */
import type { RwsDataSymbol } from '../rws/client';

/** One RAPID data declaration and the value the controller gave for it (error: why it gave none). */
export interface RapidDatum extends RwsDataSymbol { value?: string; error?: string }

export const oneLine = (s: string) => s.replace(/\s+/g, ' ');

const DATA_RANK: Record<string, number> = { bool: 0, num: 1, dnum: 2, string: 3, robtarget: 4, jointtarget: 5, tooldata: 6, wobjdata: 7, loaddata: 8 };

/** Simple types first (bool, num, dnum, string), then targets and frames, then the rest; each by module and name. */
export function sortData<T extends RwsDataSymbol>(list: readonly T[]): T[] {
  const rank = (d: RwsDataSymbol) => DATA_RANK[d.type.toLowerCase()] ?? 20;
  return [...list].sort((a, b) => rank(a) - rank(b) || a.type.localeCompare(b.type) || (a.module ?? '').localeCompare(b.module ?? '') || a.name.localeCompare(b.name));
}

/** The RAPID data as a table: task, module, storage, type, name, value; simple types first. */
export function formatRapidData(ctrl: string, data: readonly RapidDatum[], when = new Date()): string {
  const list = sortData(data);
  const cell = (d: RapidDatum) => [d.task, d.module ?? '(task)', d.storage, d.type + (d.dims ? `{${d.dims}}` : ''), d.name];
  const head = ['Task', 'Module', 'Kind', 'Type', 'Name'];
  const w = head.map((h, i) => Math.max(h.length, ...list.map(d => cell(d)[i].length)));
  const row = (cells: string[], value: string) => cells.map((c, i) => c.padEnd(w[i])).join('  ') + '  ' + value;
  const out = [`${ctrl} - ${list.length} RAPID data (read ${when.toLocaleString()})`, '', row(head, 'Value')];
  for (const d of list) out.push(row(cell(d), d.error ? `(not read: ${d.error})` : oneLine(d.value ?? '')));
  if (!list.length) out.push('(no data declared)');
  return out.join('\n') + '\n';
}
