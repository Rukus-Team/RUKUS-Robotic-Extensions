/**
 * Refresh the Extension Development Host's scratch workspace from test/fixtures-cell.
 *
 * The F5 config launches VS Code on a cell that must exist: the old default pointed at
 * `../reference-backup`, which is a machine-specific folder and is absent on a fresh
 * checkout - VS Code then never finishes starting the extension host and times out after
 * 10 s. The fixture cell always exists, and copying it to `.vscode-test/debug-cell`
 * (gitignored) means a debug session can write snapshots, history and robot.json edits
 * there without touching the committed fixtures.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'test', 'fixtures-cell');
const dest = path.join(root, '.vscode-test', 'debug-cell');

if (!fs.existsSync(src)) {
  console.error(`[prepare-debug-cell] fixture cell not found: ${src}`);
  process.exit(1);
}
fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.cpSync(src, dest, { recursive: true });
console.log(`[prepare-debug-cell] ${dest} refreshed from ${src}`);
