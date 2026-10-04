/**
 * The look every Robot Code webview shares (issue #3: 3a shared CSS, 3d empty state): theme
 * colours, body, buttons, inputs, tables, links, a visible keyboard focus, and the empty state.
 * A view puts its own layout after this, so anything here can still be overridden locally.
 * Inline (not a file under media/) so it needs no webview resource roots or CSP changes.
 */
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

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * The empty state: a title, a line of explanation, and optional actions (ready-made HTML, so a
 * view keeps its own wiring - a `command:` link, or a button its script listens to).
 * Webview scripts that draw the same state client-side use the same `rc-empty` markup.
 */
export function emptyState(title: string, text?: string, actionsHtml?: string): string {
  return `<div class="rc-empty" role="status"><b>${esc(title)}</b>${text ? `<p>${esc(text)}</p>` : ''}${actionsHtml ? `<div class="rc-actions">${actionsHtml}</div>` : ''}</div>`;
}
