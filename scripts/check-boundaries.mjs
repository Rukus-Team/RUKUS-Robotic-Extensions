// Package boundary check: packages/core must not import a brand package (@fanuc/..., later @abb/...).
// Brands may import @core freely. Phase 1 of the monorepo split left known core -> fanuc imports;
// BASELINE is a ratchet; phase 2 took it to 0 (2026-09-25), so any core -> brand import now fails.
import * as fs from 'node:fs';
import * as path from 'node:path';

const BASELINE = 0;
const BRAND_IMPORT = /\bfrom\s+['"](@(?:fanuc|abb)\/[^'"]+)['"]|\bimport\s*\(\s*['"](@(?:fanuc|abb)\/[^'"]+)['"]/g;

const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e =>
  e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : []);

const hits = [];
for (const f of walk('packages/core/src')) {
  const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const m of line.matchAll(BRAND_IMPORT)) hits.push(`${f.split(path.sep).join('/')}:${i + 1}  ${m[1] ?? m[2]}`);
  });
}

const verbose = process.argv.includes('--list');
if (verbose) for (const h of hits) console.log(h);
if (hits.length > BASELINE) {
  console.log(`boundaries: ${hits.length} core -> brand imports, baseline is ${BASELINE} - a new one was added:`);
  if (!verbose) for (const h of hits) console.log('  ' + h);
  process.exit(1);
}
console.log(`boundaries: ${hits.length} core -> brand imports (baseline ${BASELINE})` +
  (hits.length < BASELINE ? ` - lower BASELINE to ${hits.length} in scripts/check-boundaries.mjs` : ''));
