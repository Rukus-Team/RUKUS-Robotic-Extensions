// Escape `${pos …}` / `${!pos …}` placeholders that must stay literal inside the dashboard's outer template string.
import * as fs from 'node:fs';
let t = fs.readFileSync('packages/core/src/live/dashboard.ts', 'utf8');
const re = /(?<!\\)\$\{(?=!?pos\b)/g;
const before = (t.match(re) || []).length;
t = t.replace(re, '\\${');
fs.writeFileSync('packages/core/src/live/dashboard.ts', t);
console.log('escaped', before, 'placeholders');
