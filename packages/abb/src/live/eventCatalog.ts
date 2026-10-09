/**
 * ABB event codes -> title, cause, consequence, remedy. RobotWare's event log already carries all
 * four in every message it lists (desc, causes, conseqs, actions), so the catalogue is what the
 * controllers this PC has read said - kept across sessions (AbbControllers keeps it in
 * globalState) and looked up by code from anywhere: "ABB: Look Up Event Code...", and a hover on
 * a code in the event log page. A code no controller has listed yet gets its event domain (the
 * code's leading digits) and says how to fill it in. Pure.
 */
import type { RwsEvent } from '../rws/client';

export interface CatalogEntry {
  code: number;
  title: string;
  description?: string;
  causes?: string;
  consequences?: string;
  actions?: string;
  /** 1 information, 2 warning, 3 error, as the controller said */
  type?: number;
  /** the controllers it was read from */
  seenOn: string[];
  lastSeen: string;
}

export type EventCatalog = Record<string, CatalogEntry>;

/**
 * The event domains, by code: ABB numbers an event domain * 10000 + the event. Only the domains
 * the RobotWare operating manual lists for every controller; others are named by number.
 */
const DOMAINS: Record<number, string> = {
  1: 'Operational', 2: 'System', 3: 'Hardware', 4: 'Program (RAPID)', 5: 'Motion', 7: 'I/O & Communication', 8: 'User (RAPID ErrWrite / ErrLog)', 11: 'Process', 12: 'Configuration',
};

export function eventDomain(code: number): { number: number; name: string } {
  const n = Math.floor(code / 10000);
  return { number: n, name: DOMAINS[n] ?? `domain ${n}` };
}

const clean = (s: string | undefined) => { const t = (s ?? '').replace(/\s+/g, ' ').trim(); return t || undefined; };

/** Add what a controller's event log said; newer text replaces older for the same code. Returns how many codes were new. */
export function rememberEvents(cat: EventCatalog, events: readonly RwsEvent[], controller: string, now = new Date().toISOString()): number {
  let added = 0;
  for (const e of events) {
    if (!Number.isFinite(e.code) || !e.title) continue;
    const key = String(e.code);
    const old = cat[key];
    if (!old) added++;
    cat[key] = {
      code: e.code, title: e.title,
      description: clean(e.description) ?? old?.description, causes: clean(e.causes) ?? old?.causes,
      consequences: clean(e.consequences) ?? old?.consequences, actions: clean(e.actions) ?? old?.actions,
      type: e.type ?? old?.type,
      seenOn: [...new Set([...(old?.seenOn ?? []), controller])], lastSeen: now,
    };
  }
  return added;
}

/** "Event 50204", "50204", "  E 50204 " -> 50204 */
export function parseEventCode(text: string): number | undefined {
  const m = /\b(\d{5,6})\b/.exec(text);
  return m ? Number(m[1]) : undefined;
}

const TYPE: Record<number, string> = { 1: 'information', 2: 'warning', 3: 'error' };

/** The answer for one code, as Markdown: the catalogue's entry, or what the code alone says. */
export function eventMarkdown(cat: EventCatalog, code: number): string {
  const e = cat[String(code)];
  const d = eventDomain(code);
  if (!e) {
    return [`**${code}** - ${d.name} event (domain ${d.number})`, '',
      'No controller this PC has read has listed this code yet, so its title, cause and remedy are not known here.',
      'Open a controller\'s event log (ABB: Show Event Log) when it has the event, or look it up in ABB\'s operating manual *Troubleshooting* (event log messages).'].join('\n');
  }
  const out = [`**${e.code} ${e.title}**`, '', `${d.name} domain${e.type && TYPE[e.type] ? ` · ${TYPE[e.type]}` : ''}${e.seenOn.length ? ` · seen on ${e.seenOn.join(', ')}` : ''}`];
  if (e.description) out.push('', e.description);
  if (e.causes) out.push('', `**Cause:** ${e.causes}`);
  if (e.consequences) out.push('', `**Consequence:** ${e.consequences}`);
  if (e.actions) out.push('', `**Remedy:** ${e.actions}`);
  if (!e.causes && !e.actions) out.push('', '_The controller gave no cause or remedy for this one._');
  return out.join('\n');
}
