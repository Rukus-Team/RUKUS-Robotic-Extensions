/**
 * The look every Robot Code webview shares (issue #3: 3a shared CSS, 3d empty state): theme
 * colours, body, buttons, inputs, tables, links, a visible keyboard focus, and the empty state.
 * A view puts its own layout after this, so anything here can still be overridden locally.
 * Inline (not a file under media/) so it needs no webview resource roots: the CSP (withCsp below)
 * allows inline styles.
 */
import { randomBytes } from 'node:crypto';

export const WEBVIEW_BASE_CSS = `
  :root { --rc-muted: var(--vscode-descriptionForeground); --rc-line: var(--vscode-panel-border, #444); --rc-row-line: var(--vscode-editorWidget-border, #333);
    --rc-ok: var(--vscode-testing-iconPassed, #3fb950); --rc-bad: var(--vscode-testing-iconFailed, #f14c4c); --rc-warn: var(--vscode-charts-yellow, #f6c343);
    --rc-blue: var(--vscode-charts-blue, #61afef); --rc-orange: var(--vscode-charts-orange, #d19a66); --rc-green: var(--vscode-charts-green, #98c379); --rc-purple: var(--vscode-charts-purple, #c678dd) }
  body { font-family: var(--vscode-font-family); font-size: 13px; color: var(--vscode-foreground); background: var(--vscode-editor-background); margin: 0 }
  button { font-family: inherit; font-size: 12px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: 0; padding: 5px 11px; border-radius: 3px; cursor: pointer }
  button:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-button-secondaryBackground)) }
  button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground) }
  button.primary:hover { background: var(--vscode-button-hoverBackground, var(--vscode-button-background)) }
  button:disabled { opacity: .5; cursor: default }
  input, select, textarea { font-family: inherit; font-size: inherit; padding: 5px 8px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); border-radius: 3px }
  input::placeholder { color: var(--vscode-input-placeholderForeground) }
  table { width: 100%; border-collapse: collapse; font-size: 12.5px }
  th { text-align: left; font-weight: 600; padding: 4px 6px; border-bottom: 1px solid var(--rc-line) }
  td { padding: 4px 6px; border-bottom: 1px solid var(--rc-row-line) }
  a { color: var(--vscode-textLink-foreground) } a:hover { color: var(--vscode-textLink-activeForeground) }
  code, .mono { font-family: var(--vscode-editor-font-family, monospace) }
  .muted { color: var(--rc-muted) }
  :focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px }
  tr:focus-visible { outline-offset: -1px }
  .rc-activate:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: -2px }
  .rc-empty { text-align: center; padding: 48px 20px; color: var(--rc-muted) }
  .rc-empty b { display: block; font-size: 15px; font-weight: 600; color: var(--vscode-foreground); margin-bottom: 6px }
  .rc-empty p { margin: 4px auto; max-width: 480px; line-height: 1.5 }
  .rc-empty .rc-actions { margin-top: 14px; display: flex; gap: 8px; justify-content: center; flex-wrap: wrap }
  .rc-scroll { max-height: 420px; overflow: auto }
  .rc-limit { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 6px; font-size: 11.5px; color: var(--rc-muted) }
  .rc-limit select { padding: 1px 4px; font-size: 11.5px }
`;

/**
 * Long lists in a webview (registers, tasks, I/O, options): each list shows the first N - picked
 * per list from 10 / 50 / 100 / 250 / All and remembered in the webview's state - inside a box that
 * scrolls, with "Showing X of Y". Client-side script: paste into a page's <script> after
 * `const vscode = acquireVsCodeApi();`.
 *   rcSlice(id, items, default)          the items to draw
 *   rcLimitBar(id, shown, total, default) the "Showing X of Y · Show [n]" line ('' for a short list)
 *   rcWireLimits(redraw)                 after drawing: the pickers save their choice and redraw
 */
export const LIST_LIMITS = [10, 50, 100, 250, 0];
export const LIST_LIMIT_JS = `
  const RC_LIMITS = [${LIST_LIMITS.join(', ')}];
  const rcLimit = (id, def) => { const v = ((vscode.getState() || {}).limits || {})[id]; return v === undefined ? def : v; };
  const rcSlice = (id, items, def) => { const n = rcLimit(id, def); return n ? items.slice(0, n) : items; };
  function rcLimitBar(id, shown, total, def) {
    if (total <= RC_LIMITS[0]) return '';
    const n = rcLimit(id, def);
    return '<div class="rc-limit"><span>' + (shown < total ? 'Showing ' + shown + ' of ' + total : 'All ' + total) + '</span>'
      + '<label>Show <select data-rc-limit="' + id + '" aria-label="How many to show">'
      + RC_LIMITS.map(v => '<option value="' + v + '"' + (v === n ? ' selected' : '') + '>' + (v || 'All') + '</option>').join('')
      + '</select></label></div>';
  }
  function rcWireLimits(redraw) {
    for (const sel of document.querySelectorAll('select[data-rc-limit]')) sel.onchange = () => {
      const st = vscode.getState() || {};
      vscode.setState({ ...st, limits: { ...(st.limits || {}), [sel.dataset.rcLimit]: +sel.value } });
      redraw();
    };
  }
`;

/**
 * Keyboard access for things that are clicked but are not buttons (an I/O chip, a task or module
 * row, a controller in a list). Client-side script; paste into a page's <script>.
 *   rcActivate(el, run)   Tab reaches it, Enter or Space runs it, as a <button> would; a chip
 *                         or list entry becomes role="button", a table row keeps its row role
 *   rcFocusKey()          before a redraw: what has focus, as a selector (its id or data-*)
 *   rcRestoreFocus(key)   after the redraw: focus the element that took its place
 */
export const ACTIVATE_JS = `
  function rcActivate(el, run) {
    el.tabIndex = 0;
    el.classList.add('rc-activate');
    if (!el.getAttribute('role') && el.tagName !== 'TR') el.setAttribute('role', 'button');
    el.onclick = run;
    el.onkeydown = e => { if ((e.key === 'Enter' || e.key === ' ') && e.target === el) { e.preventDefault(); run(e); } };
  }
  function rcFocusKey() {
    const el = document.activeElement;
    if (!el || el === document.body) return null;
    if (el.id) return '#' + CSS.escape(el.id);
    const data = [...el.attributes].filter(a => a.name.startsWith('data-'));
    return data.length ? el.tagName.toLowerCase() + data.map(a => '[' + a.name + '="' + CSS.escape(a.value) + '"]').join('') : null;
  }
  function rcRestoreFocus(key) {
    if (!key) return;
    let el = null;
    try { el = document.querySelector(key); } catch { /* a key the page no longer parses: leave focus where it is */ }
    if (el && el !== document.activeElement) el.focus({ preventScroll: true });
  }
`;

/** A fresh nonce for one page's scripts: 128 random bits, base64 (what CSP's `nonce-` takes). */
export function webviewNonce(): string { return randomBytes(16).toString('base64'); }

/**
 * The Content-Security-Policy every Robot Code webview runs under: nothing loads unless listed.
 * Scripts run only with the page's nonce (so no inline `onclick=` attributes, and nothing a
 * controller or program name smuggles into the HTML runs), styles may be inline (every view
 * keeps its CSS in the page), images and fonts only from the extension or as data: URIs.
 */
export function webviewCsp(cspSource: string, nonce: string): string {
  return `default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${cspSource} data:; font-src ${cspSource}`;
}

/**
 * A finished page with the CSP put in: the policy as the first thing in `<head>` and the nonce on
 * every `<script>`. Each view builds its HTML as before and hands it through this on the way to
 * `webview.html`, with `webview.cspSource`. A new nonce each time the page is set.
 */
export function withCsp(html: string, cspSource: string, nonce = webviewNonce()): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${esc(webviewCsp(cspSource, nonce))}">`;
  const withScripts = html.replace(/<script(?=[\s>])/gi, `<script nonce="${nonce}"`);
  const head = /<head[^>]*>/i.exec(withScripts);
  if (head) return withScripts.slice(0, head.index + head[0].length) + meta + withScripts.slice(head.index + head[0].length);
  // no <head>: the meta goes right after the doctype, or first
  const doctype = /^\s*<!DOCTYPE[^>]*>/i.exec(withScripts);
  return doctype ? doctype[0] + meta + withScripts.slice(doctype[0].length) : meta + withScripts;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * The empty state: a title, a line of explanation, and optional actions (ready-made HTML, so a
 * view keeps its own wiring - a `command:` link, or a button its script listens to).
 * Webview scripts that draw the same state client-side use the same `rc-empty` markup.
 */
export function emptyState(title: string, text?: string, actionsHtml?: string): string {
  return `<div class="rc-empty" role="status"><b>${esc(title)}</b>${text ? `<p>${esc(text)}</p>` : ''}${actionsHtml ? `<div class="rc-actions">${actionsHtml}</div>` : ''}</div>`;
}
