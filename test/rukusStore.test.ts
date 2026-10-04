/**
 * RUKUS's data, read by the extension (beta list 2: containers as clusters, naming that
 * follows RUKUS). The pure half in packages/core/src/rukus/store.ts against a temp folder shaped like
 * Documents\RUKUS, plus the naming cases from RUKUS's own BackupNamingHelperTests, so the
 * two sides resolve a template to the same name. Wired in by test/run.ts.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  resolveDataRoot, readAppSettings, clustersFolder, backupsFolder, listClusters, clusterControllers,
  mergeControllersIntoCluster, dotnetDate, resolveTemplate, templateToRegExp, robotNameFromTemplate, placeBackup,
  clusterOfFolder, deviceOf, backupManifest, auditLine, appendAudit, DEFAULT_BATCH_TEMPLATE, DEFAULT_ROBOT_TEMPLATE, type FsLike,
  newestRobotBackups,
} from '@core/rukus/store';
import { robotNameFromFolder, ROBOT_FOLDER_PATTERNS } from '@fanuc/data/vaParser';
import { looksLikeBackupFolderName } from '@core/robotContainers';

export function run(check: (cond: unknown, msg: string) => void): void {
  // ---- 1. where the data is (PortableModeHelper.Resolve, the four cases) ----
  const mem = (files: Record<string, string>): FsLike => ({ exists: p => p in files, readText: p => files[p] });
  const docs = 'C:\\Users\\sam\\Documents';
  check(resolveDataRoot(undefined, docs, mem({})).root === path.join(docs, 'RUKUS'), 'no RUKUS installed: Documents\\RUKUS (so a shared data folder can still be pointed at)');
  check(resolveDataRoot('C:\\Program Files\\RUKUS', docs, mem({})).root === path.join(docs, 'RUKUS'), 'installed, no marker: Documents\\RUKUS');
  const stick = 'E:\\RUKUS';
  const r1 = resolveDataRoot(stick, docs, mem({ [path.join(stick, 'RUKUS.portable')]: '' }));
  check(r1.portable && r1.root === path.join(stick, 'RUKUS-Data'), `empty marker: RUKUS-Data beside the exe (${r1.root})`);
  const r2 = resolveDataRoot(stick, docs, mem({ [path.join(stick, 'RUKUS.portable')]: '# comment\n\n..\\Data\n' }));
  check(r2.portable && r2.root === path.resolve(stick, '..\\Data'), `relative marker path is relative to the exe (${r2.root})`);
  const r3 = resolveDataRoot(stick, docs, mem({ [path.join(stick, 'RUKUS.portable')]: 'D:\\Shared\\RUKUS' }));
  check(r3.portable && r3.root === 'D:\\Shared\\RUKUS', 'absolute marker path is taken as it is');
  const r4 = resolveDataRoot(stick, docs, { exists: p => p.endsWith('RUKUS.portable'), readText: () => { throw new Error('locked'); } });
  check(r4.portable && r4.root === path.join(stick, 'RUKUS-Data'), 'an unreadable marker still means portable (the host PC is not written to)');

  // ---- 2. a data folder shaped like the real thing ----
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rukus-store-'));
  try {
    const root = path.join(tmp, 'RUKUS');
    fs.mkdirSync(path.join(root, 'Clusters', 'Backups'), { recursive: true });
    fs.mkdirSync(path.join(root, 'Backups'), { recursive: true });
    fs.writeFileSync(path.join(root, 'AppSettings.json'), JSON.stringify({
      DefaultClusterName: 'Testing', CustomBackupsFolderPath: null, CustomClustersFolderPath: path.join(tmp, 'nowhere'),
      BackupBatchFolderTemplate: '{ClusterName}\\{Date:yyyy-MM-dd_HH-mm}', BackupRobotFolderTemplate: '{RobotName}_({BackupType})_{Date:yyMMdd}',
    }, null, 2));
    const testing = {
      ClusterType: 1, SourceAdapterName: 'Localhost (RoboGuide)', SavedUtc: '2026-09-13T01:03:11.5987186Z', SavedBy: 'user@WORKSTATION',
      Robots: [
        { Make: 'Fanuc', KCLUser: null, KCLPassword: '', FTPDirectory: 'MD:/', IsPassive: true, AutoCollectAlarms: false, RobotName: 'S002R01', IPAddress: '127.0.0.5', FTPUser: 'anonymous', FTPPassword: 'secret-1', ExpectedMac: null, ExpectedFNumber: 'F123', SoftwareVersion: null, IsWriteLocked: false, Notes: 'spot 1', IsVirtual: false, IsSelected: false, IsAlive: false },
        { Make: 'Fanuc', KCLUser: 'kcl', KCLPassword: 'k', FTPDirectory: 'UD1:/', IsPassive: false, AutoCollectAlarms: true, RobotName: 'S002R05', IPAddress: '127.0.0.3', FTPUser: 'robot', FTPPassword: '', ExpectedMac: null, ExpectedFNumber: null, SoftwareVersion: null, IsWriteLocked: true, Notes: null, IsVirtual: true, IsSelected: false, IsAlive: false },
        { Make: 'Fanuc', RobotName: '   ', IPAddress: '1.2.3.4' },
      ],
    };
    fs.writeFileSync(path.join(root, 'Clusters', 'Testing.json'), JSON.stringify(testing, null, 2));
    fs.writeFileSync(path.join(root, 'Clusters', 'default.json'), JSON.stringify({ ClusterType: 1, Robots: [] }));
    fs.writeFileSync(path.join(root, 'Clusters', 'broken.json'), '{ not json');
    fs.writeFileSync(path.join(root, 'Clusters', 'notes.txt'), 'not a cluster');

    const s = readAppSettings(root);
    check(s.defaultClusterName === 'Testing' && s.backupRobotFolderTemplate === '{RobotName}_({BackupType})_{Date:yyMMdd}' && s.customClustersFolderPath === path.join(tmp, 'nowhere') && s.customBackupsFolderPath === undefined, `AppSettings read: ${JSON.stringify(s)}`);
    check(clustersFolder(root, s) === path.join(root, 'Clusters'), 'a custom clusters folder that is not reachable falls back to the local one (as RUKUS does)');
    check(backupsFolder(root, s) === path.join(root, 'Backups'), 'no custom backups folder: <root>\\Backups');
    const d = readAppSettings(path.join(tmp, 'missing'));
    check(d.backupBatchFolderTemplate === DEFAULT_BATCH_TEMPLATE && d.backupRobotFolderTemplate === DEFAULT_ROBOT_TEMPLATE, 'no AppSettings.json: RUKUS\'s defaults');

    const clusters = listClusters(path.join(root, 'Clusters'));
    check(clusters.map(c => c.name).join(',') === 'default,Testing', `clusters are the .json files by name, the broken one and the .txt skipped: ${clusters.map(c => c.name).join(',')}`);
    const t = clusters.find(c => c.name === 'Testing')!;
    check(t.robots.length === 2 && t.robots[0].name === 'S002R01' && t.robots[0].host === '127.0.0.5' && t.robots[0].device === 'MD:' && t.robots[0].ftpPassword === 'secret-1' && t.robots[0].expectedFNumber === 'F123' && t.robots[0].notes === 'spot 1', `robots read (a nameless entry dropped): ${JSON.stringify(t.robots.map(r => [r.name, r.host, r.device]))}`);
    check(t.robots[1].device === 'UD1:' && t.robots[1].isVirtual && t.robots[1].isWriteLocked && t.robots[1].ftpPassword === undefined, 'UD1:/ reads as UD1:, flags read, an empty password is none');
    check(t.savedBy === 'user@WORKSTATION' && t.sourceAdapterName === 'Localhost (RoboGuide)', 'cluster header read');
    check(deviceOf('md:/') === 'MD:' && deviceOf('MD:') === 'MD:' && deviceOf('') === 'MD:' && deviceOf('FR') === 'FR:', 'deviceOf spellings');

    const ctrl = clusterControllers(t);
    check(JSON.stringify(ctrl) === JSON.stringify({ S002R01: { host: '127.0.0.5', device: 'MD:', ftpUser: 'anonymous' }, S002R05: { host: '127.0.0.3', device: 'UD1:', ftpUser: 'robot', useFtp: true } }), `cluster -> cell.json controllers, no password, useFtp only for a real FTP user: ${JSON.stringify(ctrl)}`);

    // the other way: the cell's controllers back into the cluster file, RUKUS-only fields kept
    const merged = JSON.parse(mergeControllersIntoCluster(fs.readFileSync(path.join(root, 'Clusters', 'Testing.json'), 'utf8'), {
      S002R01: { host: '10.0.0.5', device: 'MD:', ftpUser: 'anonymous' },
      NEWBOT: { host: '10.0.0.9', device: 'MD:' },
    }, 'sam@pc (Robot Code)', new Date('2026-09-22T12:00:00Z')));
    const m1 = merged.Robots.find((r: any) => r.RobotName === 'S002R01'), m5 = merged.Robots.find((r: any) => r.RobotName === 'S002R05'), mn = merged.Robots.find((r: any) => r.RobotName === 'NEWBOT');
    check(m1.IPAddress === '10.0.0.5' && m1.FTPPassword === 'secret-1' && m1.Notes === 'spot 1' && m1.ExpectedFNumber === 'F123', 'export: the address moves, password/notes/F number stay');
    check(m5 && m5.IPAddress === '127.0.0.3' && m5.KCLUser === 'kcl' && m5.IsWriteLocked === true, 'export: a robot the cell does not name is kept whole (the cell never deletes from RUKUS)');
    check(mn && mn.Make === 'Fanuc' && mn.FTPDirectory === 'MD:/' && mn.FTPUser === 'anonymous' && mn.IsPassive === true && mn.IsVirtual === false && mn.FTPPassword === '', `export: a new controller becomes a Fanuc robot with RUKUS's defaults: ${JSON.stringify(mn)}`);
    check(merged.SavedBy === 'sam@pc (Robot Code)' && merged.SavedUtc === '2026-09-22T12:00:00.000Z' && merged.SourceAdapterName === 'Localhost (RoboGuide)' && merged.ClusterType === 1 && Object.keys(merged).pop() === 'Robots', 'export: header kept, SavedUtc/SavedBy stamped, Robots last as RUKUS writes it');
    const fresh = JSON.parse(mergeControllersIntoCluster(undefined, { R1: { host: '1.1.1.1' } }, 'x'));
    check(fresh.ClusterType === 1 && fresh.Robots.length === 1 && fresh.Robots[0].FTPDirectory === 'MD:/', 'export to a cluster RUKUS does not have yet: a Fanuc cluster with that one robot');

    // ---- 3. naming: the cases from RUKUS.Tests/BackupNamingHelperTests.cs ----
    const when = new Date(2026, 7, 23, 9, 41, 5);   // 23 Aug 2026 09:41:05 local, as RUKUS's `When`
    check(resolveTemplate('{ClusterName}\\{RobotName}_({BackupType})_{Date:yyyyMMdd}', { cluster: 'Cell A', robot: 'S002R01', type: 'MD', now: when }) === path.join('Cell A', 'S002R01_(MD)_20260823'), 'template: the full Sam shape');
    check(resolveTemplate('{clustername}\\{ROBOTNAME}', { cluster: 'Cell A', robot: 'S002R01', type: 'MD', now: when }) === path.join('Cell A', 'S002R01'), 'template: tokens are case-insensitive');
    check(resolveTemplate('{Date:}', { now: when }) === '2026-08-23', 'template: an empty date format is yyyy-MM-dd');
    check(resolveTemplate('{RobotName}', { robot: 'R:01*?<>|"', now: when }) === 'R01', 'template: invalid file name characters are dropped');
    check(resolveTemplate('{ClusterName}/{RobotName}', { cluster: 'Cell A', robot: 'S002R01', now: when }) === path.join('Cell A', 'S002R01'), 'template: / separates like \\');
    check(resolveTemplate('   ', { now: when }) === '' && resolveTemplate('{ClusterName}\\\\{RobotName}', { cluster: 'A', robot: 'B', now: when }) === path.join('A', 'B'), 'template: blank is empty, empty segments dropped');
    check(dotnetDate('yyyy-MM-dd_HH-mm', when) === '2026-08-23_09-41' && dotnetDate('yyMMdd', when) === '260823' && dotnetDate("yyyy'T'HH:mm:ss", when) === '2026T09:41:05' && dotnetDate('d/M/yy h tt', when) === '23/8/26 9 AM', `dotnet date formats: ${dotnetDate('d/M/yy h tt', when)}`);

    // the template as a matcher, and the names the extension reads out of folders with it
    check(robotNameFromTemplate('S002R01_(MD)_260912', '{RobotName}_({BackupType})_{Date:yyMMdd}') === 'S002R01', 'matcher: Sam\'s preset');
    check(robotNameFromTemplate('S002R01_MD_2026-09-12', '{RobotName}_{BackupType}_{Date:yyyy-MM-dd}') === 'S002R01', 'matcher: Rodrigo\'s preset');
    check(robotNameFromTemplate('LINE 2 ROBOT_(Filtered)_260912', '{RobotName}_({BackupType})_{Date:yyMMdd}') === 'LINE 2 ROBOT', 'matcher: a name with spaces');
    check(robotNameFromTemplate('S002R01_(MD)_2026-09-12', '{RobotName}_({BackupType})_{Date:yyMMdd}') === undefined, 'matcher: the wrong date shape does not fit');
    check(robotNameFromTemplate('2026-09-12', '{Date:yyyy-MM-dd}') === undefined && templateToRegExp('{Date:yyyy-MM-dd}').test('2026-09-12'), 'matcher: a template without the robot fits the name but yields no robot');
    check(robotNameFromTemplate('S002R01_(MD)_260912', '{ClusterName}\\{RobotName}_({BackupType})_{Date:yyMMdd}') === 'S002R01', 'matcher: only the last segment of a template names the folder');
    // ... and once RUKUS's own template is registered, the extension reads any preset RUKUS is set to
    const custom = '{RobotName}-{BackupType}-{Date:yyyyMMdd_HHmm}';
    ROBOT_FOLDER_PATTERNS.length = 0; ROBOT_FOLDER_PATTERNS.push(templateToRegExp(custom));
    try {
      check(robotNameFromFolder('Weld Cell 3-MD-20260912_1430') === 'Weld Cell 3', `a folder named by a custom RUKUS template reads its robot name (${robotNameFromFolder('Weld Cell 3-MD-20260912_1430')})`);
      check(looksLikeBackupFolderName('Weld Cell 3-MD-20260912_1430') && !looksLikeBackupFolderName('Weld Cell 3'), 'and the wizard leaves such a folder unticked');
      check(robotNameFromFolder('S002R01_(MD)_260912') === 'S002R01', 'the built-in presets still read');
    } finally { ROBOT_FOLDER_PATTERNS.length = 0; }
    ROBOT_FOLDER_PATTERNS.push(templateToRegExp('{RobotName}'));
    try { check(!looksLikeBackupFolderName('programs'), 'a bare {RobotName} template is not a backup tell'); } finally { ROBOT_FOLDER_PATTERNS.length = 0; }

    // ---- 4. where the extension's own backup goes (BackupLayoutHelper) ----
    const backups = path.join(root, 'Backups');
    const p = placeBackup(backups, s, 'Testing', 'S002R01', 'MD', when);
    check(p.clusterFolder === path.join(backups, 'Testing') && p.batchName === '2026-08-23_09-41' && p.archiveFolder === path.join(backups, 'Testing', 'S002R01', '2026-08-23_09-41') && p.robotFolderName === 'S002R01_(MD)_260823', `placed in the robot's archive, never Latest: ${p.archiveFolder}`);
    const undated = placeBackup(backups, { ...s, backupBatchFolderTemplate: '{ClusterName}' }, 'Testing', 'Latest', 'MD', when);
    check(undated.batchName === '2026-08-23_09-41' && undated.archiveFolder === path.join(backups, 'Testing', 'Latest_robot', '2026-08-23_09-41'), `an undated batch template gets the run stamp; a robot called Latest steps aside: ${undated.archiveFolder}`);
    const nested = placeBackup(backups, { ...s, backupBatchFolderTemplate: 'Plant\\{ClusterName}\\{Date:yyyy-MM-dd}' }, 'Cell A', 'R1', 'Filtered', when);
    check(nested.clusterFolder === path.join(backups, 'Plant', 'Cell A') && nested.batchName === '2026-08-23', 'a deeper batch template: everything but the last segment is the cluster folder');
    check(clusterOfFolder(backups, path.join(backups, 'Testing')) === 'Testing' && clusterOfFolder(backups, path.join(backups, 'Testing', 'Latest', 'S002R01_(MD)_260912')) === 'Testing' && clusterOfFolder(backups, backups) === undefined && clusterOfFolder(backups, tmp) === undefined, 'the cluster a workspace folder belongs to');
    const man = JSON.parse(backupManifest({ robotName: 'S002R01', robotIp: '127.0.0.5', clusterName: 'Testing', batchName: '2026-08-23_09-41', startedUtc: when, finishedUtc: when, backupType: 'Filtered', filterExtensions: ['.ls'], filesListed: 3, filesDownloaded: 3, failedFiles: [], rukusVersion: 'Robot Code 1', machineName: 'PC', windowsUser: 'sam' }));
    check(man.SchemaVersion === 1 && man.RobotName === 'S002R01' && man.BackupType === 'Filtered' && Array.isArray(man.FailedFiles) && typeof man.StartedUtc === 'string', 'the manifest has RUKUS\'s field names (SchemaVersion 1)');
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  // ---- 4b. RUKUS's write audit log: one line in RUKUS's field names ----
  {
    const line = auditLine({ robotName: 'S002R01', robotAddress: '127.0.0.5', targetKind: 'Program', targetAddress: 'MD:UPTEST.LS', targetLabel: 'UPTEST.LS', newValue: '812 bytes sha256:abcd', result: 'Ok', origin: 'RobotCode/UploadProgram', durationMs: 41.6, when: new Date('2026-09-22T20:00:00Z'), machineName: 'PC', windowsUser: 'sam' });
    const o = JSON.parse(line);
    check(Object.keys(o).join(',') === 'TimestampUtc,MachineName,WindowsUser,RukusUser,RukusRole,RobotName,RobotAddress,TargetKind,TargetAddress,TargetLabel,OldValue,NewValue,Reason,Result,Error,Origin,DurationMs', `audit line has RUKUS's AuditEntry fields in order: ${Object.keys(o).join(',')}`);
    check(o.TimestampUtc === '2026-09-22T20:00:00.000Z' && o.RukusUser === null && o.OldValue === null && o.Error === null && o.DurationMs === 42 && o.Result === 'Ok' && o.TargetKind === 'Program' && !line.includes('\n'), `audit line values: ${line}`);
    const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'rukus-audit-'));
    try {
      const f = path.join(tmp2, 'WriteAuditLog.jsonl');
      fs.writeFileSync(f, '﻿{"TimestampUtc":"2026-08-15T00:13:54Z","Result":"Ok"}', 'utf8');   // RUKUS's own file: a BOM, and no trailing newline
      appendAudit(tmp2, { robotName: 'R', robotAddress: '1.1.1.1', targetKind: 'Program', targetAddress: 'MD:A.LS', result: 'Refused', error: 'write-locked', origin: 'RobotCode/LiveEdit', durationMs: 0, machineName: 'PC', windowsUser: 'sam' });
      appendAudit(tmp2, { robotName: 'R', robotAddress: '1.1.1.1', targetKind: 'Program', targetAddress: 'MD:B.LS', result: 'Ok', origin: 'RobotCode/UploadProgram', durationMs: 5, machineName: 'PC', windowsUser: 'sam' });
      const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean);
      check(lines.length === 3 && JSON.parse(lines[1]).Result === 'Refused' && JSON.parse(lines[2]).TargetAddress === 'MD:B.LS' && JSON.parse(lines[0].replace(/^﻿/, '')).Result === 'Ok', `appended after a file with no trailing newline, one JSON per line (${lines.length} lines)`);
      appendAudit(path.join(tmp2, 'fresh'), { robotName: 'R', robotAddress: '1.1.1.1', targetKind: 'Program', targetAddress: 'MD:C.LS', result: 'Ok', origin: 'x', durationMs: 1, machineName: 'PC', windowsUser: 'sam' } as any) ;
    } catch (e: any) { check(/ENOENT/.test(String(e?.code ?? e)), `a missing data root is an error, not a silent skip (${e?.code ?? e})`); }
    finally { try { fs.rmSync(tmp2, { recursive: true, force: true }); } catch { /* best effort */ } }
  }

  // ---- 5. the real thing, when this is the PC that has it (nothing printed from it but counts) ----
  const real = path.join(os.homedir(), 'Documents', 'RUKUS');
  if (fs.existsSync(path.join(real, 'Clusters'))) {
    const s = readAppSettings(real);
    const clusters = listClusters(clustersFolder(real, s));
    const robots = clusters.reduce((n, c) => n + c.robots.length, 0);
    check(clusters.length > 0 && robots > 0, `real RUKUS data: ${clusters.length} cluster(s), ${robots} robot(s), robot template ${s.backupRobotFolderTemplate}`);
    check(clusters.every(c => Object.keys(clusterControllers(c)).every(n => c.robots.some(r => r.name === n))), 'real clusters convert to controllers without inventing names');
    console.log(`  rukus store: ${clusters.length} cluster(s), ${robots} robot(s) read from the real Documents\\RUKUS`);
  } else console.log('  rukus store: NOT RUN against a real RUKUS data folder - none at ' + real);

  // the empty Registers view offers each robot's newest RUKUS backup (issue #3, 1c)
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rukus-bk-'));
    try {
      const mk = (rel: string, file?: string) => { fs.mkdirSync(path.join(root, rel), { recursive: true }); if (file) fs.writeFileSync(path.join(root, rel, file), 'x'); };
      mk('Cell A/R1/2026-09-30_10-00', 'numreg.va');
      mk('Cell A/R1/2026-10-01_18-35', 'numreg.va');
      mk('Cell A/R1/2026-10-02_08-00');                        // newer, but empty: not a backup
      mk('Cell A/R1/Latest/x', 'numreg.va');                   // RUKUS's own copy: skipped
      mk('Cell A/R2/2026-09-01_07-00', 'posreg.va');
      mk('Cell A/.robocode-robot/snapshot', 'numreg.va');      // hidden: skipped
      mk('Cell B/R9');                                         // a robot with no backup yet
      const got = newestRobotBackups(root).map(b => `${b.cluster}/${b.robot}@${b.taken}`).join(' ');
      check(got === 'Cell A/R1@2026-10-01_18-35 Cell A/R2@2026-09-01_07-00', `newest backup per robot: ${got}`);
      check(newestRobotBackups(path.join(root, 'nope')).length === 0, 'a missing backups folder offers nothing');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
}
