// Syntax-checks the <script> blocks embedded in webview template strings (after TS template unescaping).
import * as fs from 'node:fs';
const files = ['packages/fanuc/src/live/optionsView.ts', 'packages/core/src/live/dashboard.ts', 'packages/core/src/live/robotForm.ts', 'packages/fanuc/src/tp/flowView.ts', 'packages/fanuc/src/tp/callGraph.ts', 'packages/fanuc/src/data/registerTable.ts', 'packages/fanuc/src/tools/index.ts', 'packages/abb/src/live/dashboard.ts'];
// Shared client-side snippets a page pastes in with ${NAME}: checked in place, as the page gets them
const style = fs.readFileSync('packages/core/src/webviewStyle.ts', 'utf8');
const snippet = name => (new RegExp('export const ' + name + ' = `([\\s\\S]*?)`;').exec(style)?.[1] ?? '')
  .replace(/\$\{LIST_LIMITS\.join\(', '\)\}/g, '10, 50, 100, 250, 0');
const SNIPPETS = { LIST_LIMIT_JS: snippet('LIST_LIMIT_JS') };
let bad = 0;
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  const blocks = [...src.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  for (const [i, raw0] of blocks.entries()) {
    const raw = raw0.replace(/\$\{(LIST_LIMIT_JS)\}/g, (_m, n) => SNIPPETS[n]);
    // undo TS template escaping and neutralise outer-template interpolations (${...} that TS evaluates) by replacing them with placeholders
    let js = raw.replace(/\\\$\{/g, '${').replace(/\\`/g, '`');
    js = js.replace(/\$\{(?![^`]*`)[^{}]*\}/g, m => (raw.includes(m) && !raw.includes('\\' + m) ? '0' : m));
    try { new Function(js); console.log(`${f} script #${i + 1}: ok`); }
    catch (e) { bad++; console.log(`${f} script #${i + 1}: ${e.message}`); }
  }
}
process.exit(bad ? 1 : 0);
