/**
 * Robot Web Services 2.0 (OmniCore, RobotWare 7/8) answers in HAL+JSON where RWS 1.0 (IRC5)
 * answers in XHTML. The resources, their `_type`s and their field names are the same ones RWS 1.0
 * puts in `<li class>` and `<span class>`, so a JSON page is turned into the same RwsPage the
 * XHTML parser makes and the client's readers work on both:
 *
 *   { "_links": {...}, "state": [ { "_type": "pnl-ctrlstate", "_title": "ctrl-state", "ctrlstate": "guardstop" } ],
 *     "_embedded": { "resources": [ { "_type": "rap-task-li", "_title": "T_ROB1", "name": "T_ROB1", ... } ] } }
 *
 * A nested object (`"progpointer": { "modulename": ... }`) gives its fields to the item that holds
 * it; a nested list of objects (`"options": [ {...}, ... ]`) becomes items of its own. Field values
 * are kept exactly as sent (module text must not be trimmed).
 */
import type { RwsItem, RwsPage } from './xhtml';

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);

function linksOf(o: unknown, into: Record<string, string>): void {
  if (!isObj(o)) return;
  for (const [rel, v] of Object.entries(o)) {
    const href = isObj(v) ? v.href : undefined;
    if (typeof href === 'string' && !(rel in into)) into[rel] = href;
  }
}

function addItem(o: Json, page: RwsPage): void {
  const item: RwsItem = { cls: String(o._type ?? ''), title: String(o._title ?? ''), fields: {}, links: {} };
  page.items.push(item);
  linksOf(o._links, item.links);
  const nestedLists: Json[] = [];
  for (const [k, v] of Object.entries(o)) {
    if (k.startsWith('_')) continue;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') item.fields[k] = String(v);
    else if (isObj(v)) {
      linksOf(v._links, item.links);
      for (const [k2, v2] of Object.entries(v)) if (!k2.startsWith('_') && (typeof v2 === 'string' || typeof v2 === 'number' || typeof v2 === 'boolean')) item.fields[k2] = String(v2);
    } else if (Array.isArray(v)) for (const x of v) if (isObj(x)) nestedLists.push(x);
  }
  for (const x of nestedLists) addItem(x, page);
}

/** An RWS 2.0 HAL+JSON body as an RwsPage. A body that is not JSON gives an empty page. */
export function parseRwsJson(text: string): RwsPage {
  const page: RwsPage = { items: [], links: {} };
  let j: unknown;
  try { j = JSON.parse(text); } catch { return page; }
  if (!isObj(j)) return page;
  const links: Record<string, string> = {};
  linksOf(j._links, links);
  page.base = links.base;
  delete links.base;
  page.links = links;
  for (const x of Array.isArray(j.state) ? j.state : []) if (isObj(x)) addItem(x, page);
  const emb = isObj(j._embedded) ? j._embedded.resources : undefined;
  for (const x of Array.isArray(emb) ? emb : []) if (isObj(x)) addItem(x, page);
  return page;
}
