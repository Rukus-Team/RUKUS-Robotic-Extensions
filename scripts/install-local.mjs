// Installs the .vsix that `npm run package` just built into the local VS Code.
//
// A script rather than a line in package.json, because the file name carries the version:
// the inline command used to name robot-code-0.1.0.vsix and had been wrong since 0.2.0, which
// is exactly the kind of thing nobody notices until they try to install.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { name, version } = JSON.parse(readFileSync(path.join(repo, 'package.json'), 'utf8'));
const vsix = path.join(repo, `${name}-${version}.vsix`);

if (!existsSync(vsix)) {
  console.error(`${path.basename(vsix)} is not there - run "npm run package" first.`);
  process.exit(1);
}

// shell: true so Windows finds code.cmd on PATH. With a shell the arguments are joined with
// spaces and NOT quoted, so a repo under "C:\Git Lab Repos" reached VS Code as three words and
// it tried to install an extension called c:\git. The path is quoted here for that reason.
execFileSync('code', ['--install-extension', `"${vsix}"`, '--force'], { stdio: 'inherit', shell: true });
console.log(`Installed ${path.basename(vsix)}. Reload VS Code (Developer: Reload Window) to pick it up.`);
