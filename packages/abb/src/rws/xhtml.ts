/**
 * Reader for Robot Web Services 1.0 responses (IRC5, RobotWare 6). Every resource answers in
 * the same XHTML shape:
 *
 *   <div class="state"> <a href="" rel="self"/> <ul>
 *     <li class="rap-task-li" title="T_ROB1"> <a href="tasks/T_ROB1" rel="self"/>
 *       <span class="name">T_ROB1</span> <span class="taskstate">init</span> ... </li>
 *   </ul></div>
 *
 * so one reader serves all of them: a list of items, each with its class, title, the text of
 * its spans by class, and its links by rel. Items nested in an item (`sys-options-li` inside
 * `sys-system-li`) are items of their own, in document order. Pure, no dependencies.
 */

export interface RwsItem {
  /** the li's class: 'rap-task-li', 'ms-jointtarget', 'pcp-info' */
  cls: string;
  /** the li's title: 'T_ROB1', 'progpointer' */
  title: string;
  /** span class -> text, e.g. { name: 'T_ROB1', taskstate: 'init' } */
  fields: Record<string, string>;
  /** a rel -> href, e.g. { self: 'tasks/T_ROB1', error: '.../retcode?code=-1073414145' } */
  links: Record<string, string>;
}

export interface RwsPage {
  /** from <title> */
  title?: string;
  /** from <base href>, the absolute URL the relative links hang off */
  base?: string;
  items: RwsItem[];
  /** links on the state div itself (self, action, next, prev) */
  links: Record<string, string>;
}

/** XML entities -> text */
export const decodeXml = (s: string) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
  .replace(/&amp;/g, '&');

const attr = (tag: string, name: string) => {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(tag);
  return m ? decodeXml(m[2] ?? m[3] ?? '') : undefined;
};

/**
 * Read one RWS page. Tolerant: RWS writes `<a href= "" rel="self"/>`, self-closing anchors and
 * unclosed ones alike, and the occasional span with no class; those are skipped, not fatal.
 */
export function parseRwsPage(html: string): RwsPage {
  const page: RwsPage = { items: [], links: {} };
  page.title = /<title>([^<]*)<\/title>/i.exec(html)?.[1];
  const base = /<base\s[^>]*>/i.exec(html);
  if (base) page.base = attr(base[0], 'href');

  // A stack of open items: text and links belong to the innermost open li.
  const stack: RwsItem[] = [];
  const tagRe = /<(\/?)(li|span|a)\b([^>]*?)(\/?)>/gi;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(html))) {
    const [whole, closing, nameRaw, attrs, selfClose] = m;
    const name = nameRaw.toLowerCase();
    if (name === 'li') {
      if (closing) { stack.pop(); continue; }
      const item: RwsItem = { cls: attr(whole, 'class') ?? '', title: attr(whole, 'title') ?? '', fields: {}, links: {} };
      page.items.push(item);
      if (!selfClose) stack.push(item);
      continue;
    }
    if (closing) continue;
    if (name === 'a') {
      const rel = attr(attrs, 'rel'), href = attr(attrs, 'href');
      if (!rel || href === undefined) continue;
      const target = stack.length ? stack[stack.length - 1].links : page.links;
      // an `error` link's class says which field failed (modfilename_ret): keep both
      const cls = attr(attrs, 'class');
      if (cls && rel === 'error') target[`error:${cls}`] = href;
      if (!(rel in target)) target[rel] = href;   // the first of a rel wins (a page's own `self` before any nested one)
      continue;
    }
    // span: its text runs to the next tag
    const cls = attr(attrs, 'class');
    if (!cls || selfClose || !stack.length) continue;
    const end = html.indexOf('<', tagRe.lastIndex);
    stack[stack.length - 1].fields[cls] = decodeXml(html.slice(tagRe.lastIndex, end < 0 ? undefined : end)).trim();
  }
  return page;
}

/** The first item of a class, or undefined. */
export function itemOf(page: RwsPage, cls: string): RwsItem | undefined {
  return page.items.find(i => i.cls === cls);
}

/** Every item of a class. */
export function itemsOf(page: RwsPage, cls: string): RwsItem[] {
  return page.items.filter(i => i.cls === cls);
}

/** `"77,6"` -> { line: 77, col: 6 } (1-based, as RWS gives them). */
export function rwsPosition(s: string | undefined): { line: number; col: number } | undefined {
  const m = /^\s*(\d+)\s*,\s*(\d+)\s*$/.exec(s ?? '');
  return m ? { line: +m[1], col: +m[2] } : undefined;
}
