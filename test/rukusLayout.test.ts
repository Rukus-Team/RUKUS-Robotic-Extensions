/**
 * The three gaps between RUKUS's backup store and a container's working tree (2026-09-19):
 * reading a robot's name out of either RUKUS naming preset, knowing a backup folder when the
 * wizard sees one, and finding a robot's backups - RUKUS's Latest first - without a Browse
 * dialog. A temp folder shaped like the real thing; no VS Code. Wired in by test/run.ts.
 *
 *   <root>\<cluster>\Latest\<robot folder>\      newest backup of each robot
 *   <root>\<cluster>\<robot name>\<batch>\       that robot's older backups
 *   <root>\<cluster>\.incoming\                  a download in progress
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { robotNameFromFolder, folderDate } from '@fanuc/data/vaParser';
import { looksLikeBackupFolderName, folderHoldsBackup, isBackupLikeDir, findBackupCandidates, backupRank, compareBackupDirs, ROBOT_DIR } from '@core/robotContainers';

export function run(check: (cond: unknown, msg: string) => void): void {
  // ---- 1. the robot's name, from either preset ----
  const names: Array<[string, string]> = [
    ['S002R01_(MD)_260912', 'S002R01'],            // Sam's preset
    ['S002R01_(Filtered)_260912', 'S002R01'],
    ['S002R01_MD_2026-09-12', 'S002R01'],          // Rodrigo's preset - was returned whole
    ['S002R01_Filtered_2026-09-12', 'S002R01'],
    ['S002R01_IMG_2026-09-12', 'S002R01'],
    ['s002r01_md_2026-09-12', 's002r01'],
    ['S002R01_MD_20260912', 'S002R01'],
    ['S002R01_full_260823', 'S002R01'],            // the older hand-made shapes still read
    ['R1_260912', 'R1'],
    ['2026-08-29_09-15', '2026-08-29_09-15'],      // a batch folder is not a robot
    ['Latest', 'Latest'],
    ['LINE_2026', 'LINE_2026'],                    // a robot that really is called that keeps its name
    ['CELL_MD', 'CELL_MD'],                        // no date after the type: not a backup folder name
    ['C:\\Backups\\Plant\\Latest\\S002R07_MD_2026-09-12\\', 'S002R07'],
  ];
  const wrong = names.filter(([f, want]) => robotNameFromFolder(f) !== want).map(([f, want]) => `${f} -> ${robotNameFromFolder(f)} (want ${want})`);
  check(wrong.length === 0, `robotNameFromFolder: both RUKUS presets and the older shapes (${wrong.join('; ') || names.length + ' names'})`);
  check(folderDate('S002R01_(MD)_260912') === '26-09-12' && folderDate('S002R01_MD_2026-09-12') === '26-09-12' && folderDate('2026-09-12_14-30') === '26-09-12' && folderDate('Latest') === undefined, 'folderDate: the same date out of either preset and out of a batch stamp');

  // ---- 2. a backup folder, by its name ----
  const backups = ['backup', 'Backups', 'archive', 'Archives', '1_MD', 'Latest', '.incoming', 'old', '2026-09-12', '2026-09-12_14-30', '2026-09-12 14.30.05', '20260912', '20260912_1430', '260912',
    'S002R01_(MD)_260912', 'S002R01_(Filtered)_260912', 'S002R01_MD_2026-09-12', 'S002R01_full_260823', 'R1_backup', 'R1_bak', 'anything_260912', 'anything_2026-09-12'];
  const working = ['LS', 'KL', 'TP', 'KAREL', 'Programs', '2_Load_LS', '5_KAREL', 'src', 'Weld_Cell_2', 'R1', 'S002R01', 'MD', 'Station12', 'LINE_2026'];
  const missed = backups.filter(n => !looksLikeBackupFolderName(n)), overeager = working.filter(n => looksLikeBackupFolderName(n));
  check(missed.length === 0, `looksLikeBackupFolderName: every backup-looking name is recognised, RUKUS's included (missed: ${missed.join(', ') || 'none'})`);
  check(overeager.length === 0, `looksLikeBackupFolderName: an ordinary working folder name is not (wrongly flagged: ${overeager.join(', ') || 'none'})`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'robocode-rukus-'));
  try {
    const mk = (...p: string[]) => { const d = path.join(tmp, ...p); fs.mkdirSync(d, { recursive: true }); return d; };
    const backup = (...p: string[]) => { const d = mk(...p); fs.writeFileSync(path.join(d, 'numreg.va'), 'x'); fs.writeFileSync(path.join(d, 'MAIN.LS'), '/PROG MAIN'); return d; };

    // a RUKUS store: cluster "Plant", two robots in Sam's preset, one in Rodrigo's, R1 and R10
    const latest01 = backup('Backups', 'Plant', 'Latest', 'S002R01_(MD)_260918');
    backup('Backups', 'Plant', 'Latest', 'S002R02_(MD)_260918');
    const latestRod = backup('Backups', 'Plant', 'Latest', 'S002R07_MD_2026-09-18');
    const arch01a = backup('Backups', 'Plant', 'S002R01', '2026-09-12_14-30');
    const arch01b = backup('Backups', 'Plant', 'S002R01', '2026-09-15_08-00');
    backup('Backups', 'Plant', 'S002R02', '2026-09-12_14-30');
    backup('Backups', 'Plant', '.incoming', 'S002R01_(MD)_260919');        // half-written: never offered
    const old01 = backup('Backups', 'Plant', '2026-08-01_10-00', 'S002R01_(MD)_260801');   // the layout before 2026-09-11
    backup('Backups', 'Plant', 'Latest', 'R1_(MD)_260918'); backup('Backups', 'Plant', 'Latest', 'R10_(MD)_260918');
    fs.writeFileSync(path.join(tmp, 'Backups', 'Plant', 'S002R01', '2026-09-10_09-00.zip'), 'zip');   // an archived batch: a file, ignored

    // a working cell beside it
    const robot = mk('Cell', 'S002R01');
    fs.writeFileSync(path.join(mk('Cell', 'S002R01', '2_Load_LS'), 'PICK.LS'), '/PROG PICK');
    fs.writeFileSync(path.join(mk('Cell', 'S002R01', '5_KAREL'), 'util.kl'), 'PROGRAM util');
    const dated = backup('Cell', 'S002R01', '1_MD', 'S002R01_(MD)_260905');
    const snap = backup('Cell', 'S002R01', ROBOT_DIR, 'snapshot');

    // ---- 2b. a backup folder, by what is in it ----
    check(folderHoldsBackup(latest01) && !folderHoldsBackup(path.join(robot, '2_Load_LS')) && !folderHoldsBackup(path.join(tmp, 'nope')), 'folderHoldsBackup: a folder with numreg.va is a backup; a folder of .ls files, or a missing one, is not');
    const verdict = (d: string) => isBackupLikeDir(d);
    check(!verdict(path.join(robot, '2_Load_LS')) && !verdict(path.join(robot, '5_KAREL')), 'wizard: working program folders stay ticked');
    check(verdict(path.join(robot, '1_MD')), 'wizard: 1_MD is left unticked (by name)');
    check(verdict(path.join(tmp, 'Backups', 'Plant', 'Latest')) && verdict(arch01a) && verdict(latestRod), 'wizard: RUKUS Latest, a date-stamped batch and a Rodrigo-preset robot folder are all left unticked');
    // the case the three literal names missed entirely: a robot's RUKUS archive folder
    check(verdict(path.join(tmp, 'Backups', 'Plant', 'S002R01')), 'wizard: <cluster>\\<robot name> - no programs of its own, only batches - is left unticked');
    const renamed = mk('Cell', 'S002R01', 'FromController'); fs.writeFileSync(path.join(renamed, 'sysvars.sv'), 'x');
    check(verdict(renamed), 'wizard: a backup under a name that says nothing is still caught, by its contents');

    // ---- 3. finding this robot's backups ----
    const found = findBackupCandidates([path.join(tmp, 'Backups'), robot], ['S002R01']);
    const dirs = found.map(c => c.dir);
    check(found[0]?.dir === latest01 && found[0].latest, `candidates: RUKUS's Latest comes first (${found[0] ? path.relative(tmp, found[0].dir) : 'nothing found'})`);
    check([latest01, arch01a, arch01b, old01, dated].every(d => dirs.includes(d)), `candidates: Latest, both archived batches, the old-layout backup and the robot folder's own dated backup are all offered (${dirs.map(d => path.relative(tmp, d)).join(' | ')})`);
    // ... and "FromController" from the wizard check above: an undated backup sitting in the robot's
    // own folder is this robot's too, found because its PARENT is named for the robot
    check(dirs.includes(renamed), 'candidates: a backup with a name that says nothing is still found, by the robot folder it sits in');
    check(found.length === 6, `candidates: and nothing else - 6 (${found.length}: ${dirs.map(d => path.basename(d)).join(', ')})`);
    check(!dirs.some(d => d.includes('.incoming')), 'candidates: a half-written download in .incoming is never offered');
    check(!dirs.includes(snap) && !dirs.some(d => d.includes(ROBOT_DIR)), 'candidates: the container\'s own snapshot is never offered as a source for itself');
    check(!dirs.some(d => /S002R02|S002R07/.test(d)), 'candidates: another robot\'s backups are not');
    const rest = found.slice(1).map(c => c.date ?? '');
    check(JSON.stringify(rest) === JSON.stringify([...rest].sort().reverse()) && rest[rest.length - 1] === '', `candidates: after Latest, newest first by the date in the name, an undated one last (${rest.map(d => d || '(none)').join(', ')})`);
    check(found.find(c => c.dir === arch01b)?.date === '26-09-15', 'candidates: a batch folder\'s date is read from the batch stamp');

    const rod = findBackupCandidates([path.join(tmp, 'Backups')], ['S002R07']);
    check(rod.length === 1 && rod[0].dir === latestRod && rod[0].date === '26-09-18', `candidates: a robot backed up with Rodrigo's preset is found (${rod.map(c => path.basename(c.dir)).join(', ') || 'not found'})`);
    const r1 = findBackupCandidates([path.join(tmp, 'Backups')], ['R1']);
    check(r1.length === 1 && path.basename(r1[0].dir) === 'R1_(MD)_260918', `candidates: R1 never matches R10 (${r1.map(c => path.basename(c.dir)).join(', ')})`);
    check(findBackupCandidates([path.join(tmp, 'Backups')], ['s002r01']).length === 4, 'candidates: the robot name is compared without case');
    check(findBackupCandidates([path.join(tmp, 'Backups')], ['RobotA', 'S002R01']).length === 4, 'candidates: several spellings - robot.json\'s name and the folder\'s - are tried together');
    check(findBackupCandidates([path.join(tmp, 'nope')], ['S002R01']).length === 0 && findBackupCandidates([path.join(tmp, 'Backups')], ['']).length === 0, 'candidates: a missing root, or no name, finds nothing and throws nothing');
    check(findBackupCandidates([path.join(tmp, 'Backups')], ['S002R01'], 1).length === 0, 'candidates: the depth limit holds');
    check(findBackupCandidates([path.join(tmp, 'Backups'), path.join(tmp, 'Backups', 'Plant')], ['S002R01']).length === 4, 'candidates: overlapping roots do not list a folder twice');
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  // ---- beta list 2, item 2: the sidebar lists robot folders Latest first, then newest ----
  const dirs = [
    'C:\\B\\Testing\\S002R01\\2026-08-23_02-50\\S002R01_(MD)_260823',
    'C:\\B\\Testing\\Latest\\S002R01_(MD)_260912',
    'C:\\B\\Testing\\S002R01\\2026-08-29_09-15\\S002R01_(MD)_260829',
    'C:\\B\\Plant\\Latest\\S002R07_MD_2026-09-18',
    'C:\\B\\old\\2026-07-01_10-00\\S002R01',            // older layout: the date is only on the batch folder
    'C:\\B\\somewhere\\cell',                            // no date anywhere
  ];
  const ordered = [...dirs].sort(compareBackupDirs).map(d => d.split('\\').slice(2).join('/'));
  check(ordered.join(' | ') === 'Plant/Latest/S002R07_MD_2026-09-18 | Testing/Latest/S002R01_(MD)_260912 | Testing/S002R01/2026-08-29_09-15/S002R01_(MD)_260829 | Testing/S002R01/2026-08-23_02-50/S002R01_(MD)_260823 | old/2026-07-01_10-00/S002R01 | somewhere/cell',
    `robot folders: Latest first (both presets, newest Latest first), then newest first, undated last:\n    ${ordered.join('\n    ')}`);
  check(backupRank(dirs[4]).date === '26-07-01' && backupRank(dirs[5]).date === undefined && backupRank(dirs[1]).latest && !backupRank(dirs[0]).latest, 'backupRank reads the batch folder\'s date when the robot folder has none, and knows Latest');
  check(compareBackupDirs(dirs[1], dirs[3]) > 0 && compareBackupDirs('C:\\B\\X\\Latest\\R1', 'C:\\B\\Y\\Latest\\R2') === 0, 'among Latest folders the newer sorts first; two undated Latest folders tie for the label to break');
  check(compareBackupDirs('C:/B/Testing/Latest/S002R01_(MD)_260912', 'C:/B/Testing/S002R01/2026-08-29_09-15/S002R01_(MD)_260829') < 0, 'forward slashes read the same');

  // ---- against Sam's real RUKUS store, when this is the PC that has it ----
  const real = path.join(os.homedir(), 'Documents', 'RUKUS', 'Backups');
  if (fs.existsSync(real)) {
    const t0 = performance.now();
    const hits = findBackupCandidates([real], ['S002R01']);
    const ms = performance.now() - t0;
    // a store with no S002R01 in it (a fresh PC, or the backups moved) proves nothing either way
    if (hits.length === 0) console.log('  rukus layout: NOT RUN against the real RUKUS store - no S002R01 backups under ' + real);
    else {
      check(hits.every(h => /s002r01/i.test(h.dir)), `real RUKUS store: ${hits.length} backup(s) of S002R01 found in ${ms.toFixed(0)} ms, first: ${path.relative(real, hits[0].dir)}`);
      check(ms < 3000, `real RUKUS store: the search is quick enough to run when a command is pressed (${ms.toFixed(0)} ms)`);
      console.log(`  rukus layout: ${hits.length} backups of S002R01 in the real store (${ms.toFixed(0)} ms)${hits[0]?.latest ? ', Latest first' : ''}`);
    }
  } else console.log('  rukus layout: NOT RUN against a real RUKUS store - none at ' + real);
}
