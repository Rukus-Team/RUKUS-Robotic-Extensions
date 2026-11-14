// Runs test/integrationEditing.js inside a downloaded VS Code against a workspace this script
// writes itself - so it needs no backup, no corpus and no robot, and runs on any machine.
//   node test/runEditing.mjs [cacheDir]        (npm run smoke:editing)
// The workspace is made fresh each run in the temp folder: the tests rename and edit its files.
import { downloadAndUnzipVSCode, runTests } from '@vscode/test-electron';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const cacheDir = path.resolve(process.argv[2] ?? path.join(repo, '.vscode-test'));

// ---- the workspace ----
const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'robot-code-editing-'));
const attr = (group = '1,*,*,*,*') => ['/ATTR', 'OWNER\t\t= MNEDITOR;', 'COMMENT\t\t= "editing test";', 'PROG_SIZE\t= 0;', 'CREATE\t\t= DATE 26-11-13  TIME 10:00:00;', 'MODIFIED\t= DATE 26-11-13  TIME 10:00:00;',
  'FILE_NAME\t= ;', 'VERSION\t\t= 0;', 'LINE_COUNT\t= 0;', 'MEMORY_SIZE\t= 0;', 'PROTECT\t\t= READ_WRITE;', 'TCD:  STACK_SIZE\t= 0,', '      TASK_PRIORITY\t= 50,', '      TIME_SLICE\t= 0,',
  '      BUSY_LAMP_OFF\t= 0,', '      ABORT_REQUEST\t= 0,', '      PAUSE_REQUEST\t= 0;', `DEFAULT_GROUP\t= ${group};`, 'CONTROL_CODE\t= 00000000 00000000;'];
const prog = (name, mn, o = {}) => [`/PROG  ${name}${o.subType ? `\t  ${o.subType}` : ''}`, ...attr(o.group).map(l => (o.attr ? o.attr(l) : l)), '/MN', ...mn, '/POS', '/END', ''].join(o.eol ?? '\n');
const put = (rel, text) => { const f = path.join(ws, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text, 'latin1'); };

put('sniptest.ls', prog('SNIPTEST', ['   1:  R[1]=1 ;', '   2:  IF (R[1]=1) TH', '   3:  IF', '   4:  R[2]=DO']));
put('sniptest.kl', ['PROGRAM sniptest', 'VAR', '  done : BOOLEAN', '  i : INTEGER', 'BEGIN', '  IF done TH', '  FOR i = 1 TO 10 D', '  if', '  i = sel', 'END sniptest', ''].join('\n'));
put('SnipTest.mod', ['MODULE SnipTest', '  PROC main()', '    IF reg1 > 5 TH', '    if', '  ENDPROC', 'ENDMODULE', ''].join('\n'));
put('egtest.ls', prog('EGTEST', ['   1:  --eg: first line of the comment', '    :  second line of it', '    :  third line that is quite long and goes on and on well past seventy eight columns of the file without stopping ;', '   2:  R[1]=1 ;',
  '   3:  IF (R[1]=1 AND R[2]=2 AND R[3]=3 AND R[4]=4 AND R[5]=5 AND R[6]=6 AND R[7]=7 AND R[8]=8 AND R[9]=9) THEN ;', '   4:  ENDIF ;']));
// as a controller writes a long instruction: wrapped onto `:` lines, one ` ;` at the end
put('wrapped.ls', prog('WRAPPED', ['   1:  !Move and fire ;', '   2:L P[3] 1000mm/sec FINE', '    :  SPOT[S=1 ]    ;', '   3:  IF ((DI[216:SKIP]=ON OR ', '    :  DI[209:ACPT]=ON) ', '    :  AND DI[210:RJCT]=OFF),JMP LBL[30] ;',
  '   4:  --kn:first', '    :  --eg:Pick first string ;', '   5:  LBL[30] ;', '   6:   ;']));
put('pick.ls', prog('PICK', ['   1:  R[1]=1 ;']));
put('main.ls', prog('MAIN', ['   1:  CALL GRAB ;', '   2:  RUN GRAB ;', '   3:  CALL GRABBER ;']));
put('place_old.ls', prog('PLACE', ['   1:  R[1]=1 ;']));
put('vac.kl', 'PROGRAM vac\nBEGIN\nEND vac\n');
put('brk.ls', prog('BRK', ['   1:  R[35:index]=1 ;', '   2:  R[7:count]=R[35:index] ;', '   3:   ;', '   4:  IF ((DI[1]=ON OR ', '    :  DI[2]=ON ', '    :  AND DI[3]=OFF),JMP LBL[30] ;', '   5:  LBL[30] ;']));
put('bg_intlk.ls', prog('BG_INTLK', ['   1:  !Cell interlocks ;', '   2:  DO[1:clear]=(DI[1:gate] AND !DI[2:fault]) ;', '   3:  IF (DI[3:reset]),F[1:latched]=(OFF) ;', '   4:  LBL[1] ;', '   5:  M[1]=(DI[4]) ;', '   6:  WAIT DI[5]=ON ;', '   7:  JMP LBL[1] ;', '   8:   ;'], { group: '*,*,*,*,*' }));
const cycle = ['   1:  !Pick cycle ;', '   2:  UFRAME_NUM=1 ;', '   3:  UTOOL_NUM=1 ;', '   4:  LBL[10:LOOP] ;', '   5:  WAIT DI[1:part ready]=ON ;', '   6:J P[1] 100% FINE    ;', '   7:L P[2] 500mm/sec FINE    ;', '   8:  RO[1:grip]=ON ;',
  '   9:  WAIT    .50(sec) ;', '  10:L P[1] 500mm/sec CNT50    ;', '  11:  CALL PLACE ;', '  12:  R[5:count]=R[5:count]+1 ;', '  13:  JMP LBL[10] ;'];
const cycleB = ['   1:  !Pick cycle ;', '   2:  !rev B: check the gripper ;', '   3:  UFRAME_NUM=1 ;', '   4:  UTOOL_NUM=1 ;', '   5:  LBL[10:LOOP] ;', '   6:  WAIT DI[1:part ready]=ON ;', '   7:J P[1] 100% FINE    ;', '   8:L P[2] 250mm/sec FINE    ;',
  '   9:  RO[1:grip]=ON ;', '  10:  WAIT DI[7:gripped]=ON ;', '  11:L P[1] 500mm/sec CNT50    ;', '  12:  CALL PLACE ;', '  13:  R[5:count]=R[5:count]+1 ;', '  14:  JMP LBL[10] ;'];
put('cmp/robot/cycle.ls', prog('CYCLE', cycle, { eol: '\r\n' }));
put('cmp/edited/cycle.ls', prog('CYCLE', cycleB, { attr: l => l.replace('26-11-13  TIME 10:00:00', '26-11-14  TIME 08:15:00') }));
put('cmp/edited/cycle_same.ls', prog('CYCLE', cycle.map(l => l.replace(/^ +(\d+):/, '    $1:').replace(/ ;$/, ''))));

// ---- VS Code ----
fs.mkdirSync(cacheDir, { recursive: true });
const userDataDir = path.join(cacheDir, 'editing-user-data');
const extensionsDir = path.join(cacheDir, 'editing-extensions');
fs.mkdirSync(path.join(userDataDir, 'User'), { recursive: true });
fs.writeFileSync(path.join(userDataDir, 'User', 'settings.json'), JSON.stringify({
  'workbench.startupEditor': 'none', 'window.restoreWindows': 'none', 'security.workspace.trust.enabled': false, 'update.mode': 'none',
  'telemetry.telemetryLevel': 'off', 'extensions.ignoreRecommendations': true, 'robotCode.sync.promptOnOpen': false,
}, null, 2));
const vscodeExecutablePath = await downloadAndUnzipVSCode({ version: 'stable', cachePath: path.join(cacheDir, 'vscode') });
const out = path.join(cacheDir, 'editing.json');
try { fs.unlinkSync(out); } catch { /* none */ }
const code = await runTests({
  vscodeExecutablePath, extensionDevelopmentPath: repo, extensionTestsPath: path.join(here, 'integrationEditing.js'),
  launchArgs: [ws, '--disable-extensions', '--disable-workspace-trust', '--user-data-dir', userDataDir, '--extensions-dir', extensionsDir],
  extensionTestsEnv: { ROBOT_CODE_TEST_OUT: out },
}).catch(e => { console.error('runTests failed:', e?.message ?? e); return 1; });

let failed = -1;   // no results file counts as a failure
if (fs.existsSync(out)) {
  const r = JSON.parse(fs.readFileSync(out, 'utf8'));
  for (const x of r) console.log((x.ok ? 'PASS' : 'FAIL').padEnd(5), x.name, x.ok ? '' : '=> ' + x.detail);
  failed = r.filter(x => !x.ok).length;
  console.log(`${failed} failed of ${r.length}`);
} else console.log('no results file written');
try { fs.rmSync(ws, { recursive: true, force: true }); } catch { /* a file still open in the closing window */ }
process.exit(code || (failed === 0 ? 0 : 1));
