/**
 * VSC button test 2026-11-07, batch C (the side bar):
 *   1   RUKUS Studio is found (its workspace, its exe) and its clusters read like RUKUS's
 *   3   Studio's replaced\<time> safety copies and other non-backup folders are not backups
 *   2/8/17/22  nine stacked views folded into Cell (FANUC + ABB) and Backups (one row per kind)
 * Synthetic: nothing here needs RUKUS Studio, a backup or a controller. Wired in by test/run.ts.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  locateStudio, detectRukus, parseStudioWorkspace, studioClusters, splitAddress, isNonBackupFolder, isNeverBackupName,
  STUDIO_WORKSPACE_FILE,
} from '@core/rukus/studio';
import { clusterControllers, clusterAbbRobots, type FsLike } from '@core/rukus/store';
import { SectionedTreeCore, isGroupNode, liveSummary, type Section } from '@core/views/sectionedTree';

type Check = (cond: unknown, msg: string) => void;

const mem = (files: Record<string, string>): FsLike => ({ exists: p => p in files, readText: p => files[p] });

/** the shape of a real Studio workspace file (Documents\RUKUS Studio\Workspace, 2026-11-07) */
const WORKSPACE = JSON.stringify({
  version: 1,
  containers: ['Cell 1', 'Plant A/Line 2'],
  robots: [
    { id: '47656d8ba3c4', name: 'IRC5VC', brandTag: 'abb', address: '127.0.0.1', container: '', model: 'IRB 1200-5/0.9 Type B', software: 'RobotWare 6.16.3007' },
    { id: '775a8629b2ef', name: 'OmniVC', brandTag: 'abb', address: '127.0.0.1:80', container: 'Cell 1', model: 'IRB 1100-4/0.475', software: 'RobotWare 8.2.1+1023' },
    { id: 'bc0de4f1f39d', name: 'R1', brandTag: 'fanuc', address: '127.0.0.9:3080', container: 'Cell 1', software: 'V9.40P/31' },
    { id: 'e2b0ddc4298b', name: 'ROBOT', brandTag: 'FANUC', address: '127.0.0.9', container: 'Cell 1', notes: 'virtual controller', writeLocked: true },
    { id: 'aa', name: 'L2R1', brandTag: 'fanuc', address: '10.0.0.5', container: 'Plant A/Line 2' },
    { id: 'aa', name: 'DUPLICATE', brandTag: 'fanuc', container: 'Cell 1' },
    { name: 'NO ID' },
  ],
}, null, 2);

export function runDetection(check: Check): void {
  const local = 'C:\\Users\\sam\\AppData\\Local';
  const docs = 'C:\\Users\\sam\\Documents';
  const exe = path.join(local, 'Programs', 'RUKUS Studio', 'Rukus.Studio.exe');
  const defWs = path.join(docs, 'RUKUS Studio', 'Workspace');
  const shell = path.join(local, 'RUKUS Studio', 'shell.json');

  // ---- where Studio is ----
  check(!locateStudio({ localAppData: local, documents: docs }, mem({})).installed, 'nothing on the PC: Studio not installed');
  const onlyExe = locateStudio({ localAppData: local, documents: docs }, mem({ [exe]: '' }));
  check(onlyExe.installed && onlyExe.exe === exe && !onlyExe.workspace, 'the exe alone: installed, no workspace');
  const dflt = locateStudio({ localAppData: local, documents: docs }, mem({ [exe]: '', [path.join(defWs, STUDIO_WORKSPACE_FILE)]: '{}' }));
  check(dflt.workspace === defWs, `the default workspace Documents\\RUKUS Studio\\Workspace (${dflt.workspace})`);
  const other = 'D:\\Cells\\Plant';
  const fromShell = locateStudio({ localAppData: local, documents: docs }, mem({
    [shell]: JSON.stringify({ workspace: other }), [path.join(other, STUDIO_WORKSPACE_FILE)]: '{}', [path.join(defWs, STUDIO_WORKSPACE_FILE)]: '{}',
  }));
  check(fromShell.workspace === other, `the workspace Studio had open last (shell.json) comes first (${fromShell.workspace})`);
  const gone = locateStudio({ localAppData: local, documents: docs }, mem({ [shell]: JSON.stringify({ workspace: other }), [path.join(defWs, STUDIO_WORKSPACE_FILE)]: '{}' }));
  check(gone.workspace === defWs, 'a last workspace that is gone falls back to the default one');
  const broken = locateStudio({ localAppData: local, documents: docs }, mem({ [shell]: '{ half', [path.join(defWs, STUDIO_WORKSPACE_FILE)]: '{}' }));
  check(broken.workspace === defWs, 'a half-written shell.json is not fatal');
  const home = 'E:\\Studio';
  const portable = locateStudio({ localAppData: local, documents: docs, studioHome: home }, mem({ [path.join(home, 'shell.json')]: JSON.stringify({ workspace: other }), [path.join(other, STUDIO_WORKSPACE_FILE)]: '{}' }));
  check(portable.workspace === other, 'RUKUS_STUDIO_HOME is where shell.json is read');

  // ---- which of the two is read ----
  const none = { installed: false };
  check(detectRukus({ studio: none, rukusRootExists: false }).found === false, 'neither: not found (the welcome text says so)');
  const old = detectRukus({ studio: none, rukusRootExists: true });
  check(old.source === 'rukus' && old.label === 'RUKUS', 'RUKUS alone: RUKUS');
  const both = detectRukus({ studio: { installed: true, workspace: defWs }, rukusRootExists: true });
  check(both.source === 'studio' && both.label === 'RUKUS Studio' && both.studioWorkspace === defWs, 'both on the PC: Studio wins (it succeeds RUKUS)');
  const noWs = detectRukus({ studio: { installed: true }, rukusRootExists: false });
  check(noWs.found && noWs.source === 'none' && noWs.label === 'RUKUS Studio', 'Studio installed, no workspace yet: found, labelled RUKUS Studio, nothing to read');
  const noWsOld = detectRukus({ studio: { installed: true }, rukusRootExists: true });
  check(noWsOld.source === 'rukus', 'Studio installed without a workspace, RUKUS with data: RUKUS is read');
  const ov = detectRukus({ override: other, overrideIsStudio: true, studio: none, rukusRootExists: false });
  check(ov.source === 'studio' && ov.studioWorkspace === other, 'robotCode.rukus.dataFolder at a Studio workspace folder reads it');
  const ovOld = detectRukus({ override: 'D:\\RUKUS', studio: { installed: true, workspace: defWs }, rukusRootExists: true });
  check(ovOld.source === 'rukus', 'robotCode.rukus.dataFolder at RUKUS data wins over a Studio workspace (the user said so)');

  // ---- the workspace file ----
  check(parseStudioWorkspace('not json', 'C:\\W') === undefined && parseStudioWorkspace('[]', 'C:\\W') === undefined, 'not a workspace file: undefined');
  check(parseStudioWorkspace('{"version":2,"robots":[]}', 'C:\\W') === undefined, 'a newer file version is not guessed at');
  const root = 'C:\\Users\\sam\\Documents\\RUKUS Studio\\Workspace';
  const ws = parseStudioWorkspace(WORKSPACE, root)!;
  check(ws.robots.length === 5, `robots without id or name and duplicate ids are dropped (${ws.robots.map(r => r.name).join(', ')})`);
  check(ws.robots.find(r => r.name === 'ROBOT')?.brand === 'fanuc', 'the brand tag is read lower-case');
  check(JSON.stringify(splitAddress('127.0.0.9:3080')) === '{"host":"127.0.0.9","port":3080}' && splitAddress('10.0.0.5').port === undefined && splitAddress('[::1]:80').host === '::1', 'addresses split into host and port');

  const { clusters, folders } = studioClusters(ws);
  check(JSON.stringify(clusters.map(c => c.name)) === JSON.stringify(['Cell 1', 'Plant A/Line 2', 'Workspace']),
    `one cluster per cluster path, plus the top-level robots under the workspace's name (${clusters.map(c => c.name).join(', ')})`);
  check(folders.get('cell 1') === path.join(root, 'Cell 1') && folders.get('plant a/line 2') === path.join(root, 'Plant A', 'Line 2') && folders.get('workspace') === root,
    'a cluster\'s folder is <workspace>\\<cluster path>; the top-level robots\' is the workspace itself');
  const cell1 = clusters.find(c => c.name === 'Cell 1')!;
  const ctl = clusterControllers(cell1);
  check(Object.keys(ctl).join(',') === 'R1,ROBOT', `the cell's controllers are the FANUC robots (${Object.keys(ctl).join(',')})`);
  check(ctl.R1.host === '127.0.0.9' && ctl.R1.httpPort === 3080 && ctl.ROBOT.httpPort === undefined, 'a FANUC address with a port keeps it as the web server port');
  check(!ctl.R1.useFtp, 'no FTP login from Studio (it keeps logins in the OS store)');
  const abb = clusterAbbRobots(cell1);
  check(abb.length === 1 && abb[0].abb?.family === 'omnicore' && abb[0].abb?.port === 80, 'RobotWare 8 is an OmniCore, its port kept');
  const top = clusters.find(c => c.name === 'Workspace')!;
  check(clusterAbbRobots(top)[0]?.abb?.family === 'irc5', 'RobotWare 6 is an IRC5');
  check(cell1.robots.find(r => r.name === 'ROBOT')?.isWriteLocked === true && cell1.robots.find(r => r.name === 'ROBOT')?.isVirtual === true, 'write lock and virtual are carried');
  check(cell1.raw.studio === true, 'a Studio cluster says so (nothing writes it back as a RUKUS cluster file)');
}

export function runFolderFilter(check: Check): void {
  const root = 'C:\\Users\\sam\\Documents\\RUKUS Studio\\Workspace';
  const f = mem({ [path.join(root, STUDIO_WORKSPACE_FILE)]: '{}' });
  const robot = path.join(root, 'Cell 1', 'R1');
  check(isNonBackupFolder(path.join(robot, 'replaced', '2026-11-07_07-45-00'), f), 'Studio\'s replaced\\<time> is no backup');
  check(isNonBackupFolder(path.join(robot, 'snapshots', 'before teach'), f), 'Studio\'s snapshots\\ is no backup');
  for (const n of ['alarms', 'checks', 'dcs-out', 'reports']) check(isNonBackupFolder(path.join(robot, n), f), `Studio's ${n}\\ is no backup`);
  check(!isNonBackupFolder(path.join(robot, '2026-10-18_20-13'), f), 'a dated backup is a backup');
  check(!isNonBackupFolder(robot, f), 'the robot folder itself is listed');
  check(!isNonBackupFolder(path.join(root, 'Cell 1', 'replaced'), mem({})), 'outside a Studio workspace a folder called replaced is the user\'s own');
  check(!isNonBackupFolder('D:\\Plant\\reports\\R1_backup', mem({})), 'a user\'s "reports" folder elsewhere is left alone');
  check(isNonBackupFolder('D:\\Plant\\Backups\\Cell\\.incoming\\R1', mem({})) && isNonBackupFolder(path.join(robot, '.incoming-2026-11-07_10-00'), f), 'a download in progress (.incoming, .incoming-<name>) is never a backup');
  check(isNonBackupFolder('C:\\Users\\sam\\AppData\\Local\\RUKUS Studio\\edit-on-robot\\bc0de4f1f39d', mem({})), 'Studio\'s edit-on-robot copies are never a backup');
  check(isNeverBackupName('.INCOMING') && !isNeverBackupName('incoming'), 'only the dot names count');
  // the workspace file must be ABOVE the folder: a robot called "replaced" at the top level is a robot
  check(!isNonBackupFolder(path.join(root, 'replaced'), mem({ [path.join(root, 'replaced', STUDIO_WORKSPACE_FILE)]: '{}' })), 'a workspace folder named like one is not hidden');
  // the cache asks the disk once per folder
  let asks = 0;
  const counting: FsLike = { exists: p => { asks++; return p === path.join(root, STUDIO_WORKSPACE_FILE); }, readText: () => undefined };
  const cache = new Map<string, boolean>();
  for (let i = 0; i < 20; i++) isNonBackupFolder(path.join(robot, 'replaced', `t${i}`), counting, cache);
  const first = asks;
  for (let i = 0; i < 20; i++) isNonBackupFolder(path.join(robot, 'replaced', `t${i}`), counting, cache);
  check(asks === first, `the second pass asks the disk nothing (${first} then ${asks})`);

  // on disk: a real temp folder shaped like the workspace
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-studio-'));
  try {
    fs.writeFileSync(path.join(tmp, STUDIO_WORKSPACE_FILE), '{"version":1}');
    const rep = path.join(tmp, 'Cell 1', 'R1', 'replaced', '2026-11-07_07-45-26');
    const bak = path.join(tmp, 'Cell 1', 'R1', '2026-10-18_20-13');
    fs.mkdirSync(rep, { recursive: true }); fs.mkdirSync(bak, { recursive: true });
    check(isNonBackupFolder(rep) && !isNonBackupFolder(bak), 'on disk: replaced hidden, the dated backup kept');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

/** a provider over plain objects: { name, kids? } */
type N = { name: string; kids?: N[]; robot?: boolean };
const provider = (roots: N[]) => ({
  calls: 0,
  getChildren(el?: N) { this.calls++; return el ? el.kids ?? [] : roots; },
  getTreeItem(el: N) { return { label: el.name, description: el.robot ? 'connected' : undefined }; },
});

export async function runTree(check: Check): Promise<void> {
  const r1: N = { name: 'R1', robot: true, kids: [{ name: 'Position' }] };
  const fanuc = provider([{ name: 'Cell 1', kids: [r1] }, r1]);
  const ctrl: N = { name: 'IRC5VC', robot: true, kids: [{ name: 'T_ROB1' }] };
  const abb = provider([ctrl]);
  let abbShown = true;
  const cell = new SectionedTreeCore([
    { id: 'abb', provider: abb, order: 10, badge: (e: N) => (e.robot ? 'ABB' : undefined), visible: () => abbShown, counts: () => ({ live: 1, total: 1, failed: 0 }) },
    { id: 'fanuc', provider: fanuc, badge: (e: N) => (e.robot ? 'FANUC' : undefined), counts: () => ({ live: 0, total: 2, failed: 1 }) },
  ]);
  const roots = await cell.children() as N[];
  check(roots.map(r => r.name).join(',') === 'Cell 1,R1,IRC5VC', `Cell: FANUC rows then ABB rows, by order (${roots.map(r => r.name).join(',')})`);
  check(roots[2] === ctrl, 'a row is the provider\'s own element, not a wrapper (menu commands get what they always got)');
  check((await cell.children(ctrl) as N[])[0]?.name === 'T_ROB1' && (await cell.children(roots[0]) as N[])[0] === r1, 'expanding a row asks the provider that made it');
  check(cell.ownerOf(ctrl)?.id === 'abb' && cell.ownerOf(r1)?.id === 'fanuc', 'each row knows its section');
  const abbItem = await cell.item(ctrl, () => ({}));
  check(abbItem.description === 'ABB · connected', `a mixed cell badges the ABB row (${abbItem.description})`);
  const fItem = await cell.item(r1, () => ({}));
  check(fItem.description === 'FANUC · connected', `and the FANUC robot row in front of its state (${fItem.description})`);
  check((await cell.item(roots[0], () => ({}))).description === undefined, 'the cell row gets no badge');
  check(liveSummary(cell.all() as Section[]) === '1 of 3 live · ⚠ 1 failed', `the header counts both brands (${liveSummary(cell.all() as Section[])})`);
  abbShown = false;
  const fanucOnly = await cell.children() as N[];
  check(fanucOnly.map(r => r.name).join(',') === 'Cell 1,R1', 'ABB hidden: its rows go');
  check((await cell.item(r1, () => ({}))).description === 'connected', 'one brand only: no badges');
  check(liveSummary(cell.all() as Section[]) === '0 of 2 live · ⚠ 1 failed', 'a hidden section is not counted');
  // a provider handing back the same item twice gets one badge
  abbShown = true; await cell.children();
  const same = { label: 'X', description: 'connected' };
  const sticky = new SectionedTreeCore([
    { id: 'a', provider: { getChildren: () => [r1], getTreeItem: () => same }, badge: () => 'FANUC' },
    { id: 'b', provider: { getChildren: () => [ctrl], getTreeItem: () => ({ label: 'Y' }) }, badge: () => 'ABB' },
  ]);
  await sticky.children(); await sticky.item(r1, () => ({})); await sticky.item(r1, () => ({}));
  check(same.description === 'FANUC · connected', `no double badge (${same.description})`);

  // ---- Backups: one row per kind, empty kinds hidden ----
  const programs = provider([{ name: 'R1_backup', kids: [{ name: 'MAIN' }] }]);
  const empty = provider([]);
  let rapidModules = 0;
  const rapid = provider([{ name: 'IRC5 backup' }]);
  const backups = new SectionedTreeCore([
    { id: 'rapid', label: 'RAPID', order: 50, provider: rapid, isEmpty: () => rapidModules === 0, description: () => `${rapidModules} modules` },
    { id: 'programs', label: 'Programs', order: 10, provider: programs, expanded: true, description: () => '12' },
    { id: 'macros', label: 'Macros', order: 30, provider: empty },
  ]);
  let top = await backups.children();
  check(top.length === 1 && isGroupNode(top[0]) && top[0].sideBarGroup === 'programs', 'only the kinds with something to show are rows (Macros and RAPID are empty)');
  rapidModules = 3;
  top = await backups.children();
  check(top.map(g => (g as { sideBarGroup: string }).sideBarGroup).join(',') === 'programs,rapid', 'a kind that fills appears in its place');
  check(top[0] === backups.group('programs'), 'a group row is the same object every time (VS Code keeps its expanded state)');
  const progRows = await backups.children(top[0]) as N[];
  check(progRows[0]?.name === 'R1_backup' && (await backups.children(progRows[0]) as N[])[0]?.name === 'MAIN', 'a group row opens to its tree\'s rows');
  const made: string[] = [];
  const gItem = await backups.item(top[1], s => { made.push(s.id); return { label: s.label, description: s.description?.() }; });
  check(gItem.label === 'RAPID' && gItem.description === '3 modules' && made[0] === 'rapid', 'the group row carries the kind\'s summary');
  check(backups.ownerOf(top[1])?.id === 'rapid', 'a group row belongs to its section');
}

/** the manifest: few views, nothing pointing at a retired one, short welcome texts */
export function runManifest(check: Check, repo: string): void {
  const manifest = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
  const views: Array<{ id: string; name: string; visibility?: string }> = manifest.contributes.views.robotCode;
  check(views.length <= 4, `the side bar has at most 4 views (${views.map(v => v.name).join(', ')})`);
  check(views[0]?.id === 'robotCode.cell', 'robot first: Cell is the top view');
  const ids = new Set(views.map(v => v.id));
  for (const id of ['robotCode.cell', 'robotCode.backups', 'robotCode.rukusClusters', 'robotCode.snapshot']) check(ids.has(id), `${id} is declared`);
  const retired = /\b(view|focusedView) == robotCode\.(programs|pcPrograms|macros|registers|rapid|abbControllers)\b/;
  const whens: string[] = [];
  for (const list of Object.values(manifest.contributes.menus) as Array<Array<{ when?: string }>>) for (const m of list) if (m.when) whens.push(m.when);
  const stale = whens.filter(w => retired.test(w));
  check(stale.length === 0, `no menu points at a retired view: ${stale.join(' | ')}`);
  const abbMenus = (manifest.contributes.menus['view/item/context'] as Array<{ command: string; when?: string }>).filter(m => /viewItem (==|=~) \/?\^?abb-/.test(m.when ?? ''));
  check(abbMenus.length > 10 && abbMenus.every(m => m.when!.includes('view == robotCode.cell')), `the ABB controller menu works in the Cell view (${abbMenus.length} entries)`);
  for (const w of manifest.contributes.viewsWelcome as Array<{ view: string; contents: string }>) {
    check(ids.has(w.view), `welcome text for a declared view: ${w.view}`);
    // a line of plain text, links reduced to their words; the old ones ran 300+ characters and were cut
    const longest = Math.max(...w.contents.split('\n').map(l => l.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').length));
    check(longest <= 60, `${w.view} welcome lines are short enough not to be cut (${longest})`);
  }
  const groups = new Set(whens.flatMap(w => [...w.matchAll(/backups-group-([A-Za-z]+)/g)].map(m => m[1])));
  const src = ['packages/fanuc/src/views/trees.ts', 'packages/abb/src/views/rapidTree.ts'].map(f => fs.readFileSync(path.join(repo, f), 'utf8')).join('\n');
  for (const g of groups) check(src.includes(`id: '${g}'`), `the Backups row "${g}" a menu names is a section the code adds`);
  check((manifest.contributes.viewsWelcome as Array<{ view: string; when?: string }>).some(w => w.view === 'robotCode.rukusClusters' && w.when === '!robotCode.rukusAvailable'),
    'the "not found" text hides when RUKUS or RUKUS Studio is found (robotCode.rukusAvailable)');
}
