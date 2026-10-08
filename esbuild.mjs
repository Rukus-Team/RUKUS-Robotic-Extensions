import * as esbuild from 'esbuild';
import * as fs from 'node:fs';
const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');
const test = process.argv.includes('--test');
const version = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;
// robot-lint (src/lintCli.ts): the linter on plain Node, shipped in dist/ beside the extension
const lintCli = { entryPoints: ['src/lintCli.ts'], outfile: 'dist/robot-lint.js', banner: { js: '#!/usr/bin/env node' }, define: { ROBOT_CODE_VERSION: JSON.stringify(version) } };

const common = {
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
};

if (process.argv.includes('--npp')) {
  // the command-line tool for Notepad++ (src/cli.ts): no vscode, one file, runs on plain Node
  await esbuild.build({ ...common, sourcemap: false, minify: true, entryPoints: ['src/cli.ts'], outfile: 'notepad++/robotcode.js', banner: { js: '#!/usr/bin/env node' } });
} else if (process.argv.includes('--lint-cli')) {
  await esbuild.build({ ...common, ...lintCli });
} else if (test) {
  await esbuild.build({ ...common, entryPoints: ['test/run.ts'], outfile: 'dist/test.js', external: ['vscode'] });
} else {
  const ctx = await esbuild.context({ ...common, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js', external: ['vscode'] });
  if (watch) await ctx.watch();
  else { await ctx.rebuild(); await ctx.dispose(); await esbuild.build({ ...common, ...lintCli }); }
}
