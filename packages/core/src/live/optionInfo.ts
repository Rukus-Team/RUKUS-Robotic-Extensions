/**
 * What a controller software option is, for the robot windows' option lists: a short line for the
 * hover, and a panel with the whole explanation on a click (optionPanel.ts). Each brand brings its
 * own table (fanuc/src/live/optionDocs.ts, abb/src/live/optionDocs.ts); an option no table knows
 * still gets a hover and a panel that say what can be said from its code alone. Pure.
 */
import { WEBVIEW_BASE_CSS } from '../webviewStyle';

export interface OptionDoc {
  /** tried against "<code> <name>" as the controller lists it */
  match: RegExp;
  title: string;
  /** the hover: one sentence */
  short: string;
  /** the panel: paragraphs */
  full: string[];
}

export interface OptionInfo { brand: string; code: string; name: string; title: string; short: string; full: string[]; known: boolean }

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

/**
 * The explanation for one option. `codeNote` says what the code alone tells (FANUC: R / J / H
 * codes; ABB: the order number) when no entry matches.
 */
export function describeOption(brand: string, docs: readonly OptionDoc[], code: string, name: string, codeNote?: (code: string) => string | undefined): OptionInfo {
  const text = `${code} ${name}`.trim();
  const d = docs.find(x => x.match.test(text));
  if (d) return { brand, code, name, title: d.title, short: d.short, full: d.full, known: true };
  const note = codeNote?.(code);
  return {
    brand, code, name, title: name || code, known: false,
    short: `${name || code}${code && name ? ` (${code})` : ''}: no explanation here yet.`,
    full: [...(note ? [note] : []), `There is no explanation for this option here yet. The ${brand} option list or the controller's documentation describes it.`],
  };
}

export function optionPanelHtml(info: OptionInfo): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';"><style>${WEBVIEW_BASE_CSS}
  body { padding: 14px 18px; max-width: 760px } h1 { font-size: 17px; margin: 0 0 4px } .sub { color: var(--rc-muted); font-size: 12px; margin-bottom: 14px }
  .short { font-size: 13.5px; margin-bottom: 12px } p { line-height: 1.5 } .unknown { color: var(--rc-muted) }
</style></head><body>
<h1>${esc(info.title)}</h1>
<div class="sub">${esc(info.brand)}${info.code ? ` · ${esc(info.code)}` : ''}${info.name && info.name !== info.title ? ` · ${esc(info.name)}` : ''}</div>
<div class="short${info.known ? '' : ' unknown'}">${esc(info.short)}</div>
${info.full.map(p => `<p>${esc(p)}</p>`).join('\n')}
</body></html>`;
}
