/** robot-lint entry point (dist/robot-lint.js); the tool itself is lintCliMain.ts */
import { main } from './lintCliMain';

let code: number;
try { code = main(process.argv.slice(2)); }
catch (e: any) { console.error(`robot-lint: ${e?.message ?? e}`); code = 2; }
process.exitCode = code;
