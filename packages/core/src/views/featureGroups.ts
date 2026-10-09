/**
 * Every command the extension contributes, sorted by what somebody is trying to DO.
 *
 * There are eighty-odd commands and the Command Palette lists them alphabetically under
 * three category names, which is how a feature goes unfound. This table is the map: the
 * "What Can I Do Here?" picker draws it, and a unit test holds it against package.json, so
 * a command added to the manifest without a place here fails the build rather than
 * disappearing into the palette.
 *
 * Pure - no vscode - so the test can read it.
 */
export interface FeatureGroup {
  title: string;
  /** one line under the group's name: when to look here */
  hint: string;
  commands: string[];
}

export const FEATURE_GROUPS: FeatureGroup[] = [
  {
    title: 'Start here', hint: 'a new program, a backup to read comments from, a robot to connect to',
    commands: ['robotCode.tp.newProgram', 'robotCode.karel.newProgram', 'robotCode.data.addBackupFolder', 'robotCode.live.addRobot', 'robotCode.containers.initCell', 'robotCode.containers.initRobot'],
  },
  {
    title: 'Edit this TP program', hint: 'numbering, comments, motion lines',
    commands: ['robotCode.tp.renumber', 'robotCode.tp.toggleAutoRenumber', 'robotCode.tp.renumberOnes', 'robotCode.tp.applyCustomStyle', 'robotCode.tp.applyControllerStyle', 'robotCode.tp.renumberLabels', 'robotCode.tp.gotoLabel', 'robotCode.tp.toggleRemark', 'robotCode.tp.insertBanner', 'robotCode.tp.insertHeader', 'robotCode.tp.insertTemplate', 'robotCode.tp.syncCommentsFromController', 'robotCode.tp.convertMotion', 'robotCode.tp.scaleSpeeds', 'robotCode.tp.setTermination'],
  },
  {
    title: 'Positions and frames', hint: 'teach, offset, convert, mirror, clean up',
    commands: ['robotCode.tp.teachPosition', 'robotCode.tp.recordPosition', 'robotCode.tp.teachFromPosReg', 'robotCode.tp.offsetPositions', 'robotCode.tp.setAxisValues', 'robotCode.tp.convertFrame', 'robotCode.tp.mirrorPositions', 'robotCode.tp.relabelFrames', 'robotCode.tp.comparePositions', 'robotCode.tp.cleanupPositions', 'robotCode.tp.stripPositions'],
  },
  {
    title: 'Restructure', hint: 'move lines into a program, pull one in, renumber a register everywhere',
    commands: ['robotCode.tp.extractProgram', 'robotCode.tp.inlineProgram', 'robotCode.tp.combinePrograms','robotCode.tp.remapRegister'],
  },
  {
    title: 'Understand the cell', hint: 'flow, who calls what, who uses which register, what changed',
    commands: ['robotCode.tp.showFlow', 'robotCode.tp.showCallGraph', 'robotCode.tools.xrefReport', 'robotCode.tools.unusedPrograms', 'robotCode.data.openRegisterTable', 'robotCode.tools.diffBackups', 'robotCode.lookupAlarm'],
  },
  {
    title: 'Robot - only when you ask', hint: 'connect, read, open and download files; push is the one write',
    commands: ['robotCode.live.connect', 'robotCode.live.disconnect', 'robotCode.live.dashboard', 'robotCode.live.getAll', 'robotCode.live.refresh', 'robotCode.live.getPosition', 'robotCode.live.getTasks', 'robotCode.live.getRegisters', 'robotCode.live.getIo', 'robotCode.live.getInfo', 'robotCode.live.getOptions', 'robotCode.live.showOptions', 'robotCode.live.getFiles', 'robotCode.live.openRobotFile', 'robotCode.live.compareWithRobot', 'robotCode.live.downloadFile', 'robotCode.live.liveEdit','robotCode.live.pullBackup', 'robotCode.data.snapshotFromRobot', 'robotCode.live.openAsWorkspaceFolder', 'robotCode.live.revealRunning', 'robotCode.live.toggleFilesShow', 'robotCode.live.toggleAutoRefresh', 'robotCode.live.manageRobots', 'robotCode.live.setPassword', 'robotCode.live.removeRobot', 'robotCode.live.focusView'],
  },
  {
    title: 'Keep it in sync', hint: 'the snapshot is the last known robot state: fetch it, pull it into your file, push your file back',
    commands: ['robotCode.sync.fetch', 'robotCode.sync.fetchFile', 'robotCode.sync.pullFile', 'robotCode.sync.pushFile', 'robotCode.sync.compareFile', 'robotCode.sync.comparePositions', 'robotCode.sync.compareRegisters', 'robotCode.sync.revertFile', 'robotCode.sync.pullToWorking', 'robotCode.sync.history', 'robotCode.sync.fetchFolder', 'robotCode.sync.pullFolder', 'robotCode.sync.fetchCompareAll', 'robotCode.sync.errors'],
  },
  {
    title: 'Backups and robot containers', hint: 'controller data, snapshots, working copy against snapshot',
    commands: ['robotCode.data.refresh', 'robotCode.data.removeBackupFolder', 'robotCode.data.restoreBackupFolders', 'robotCode.data.snapshotFromBackup', 'robotCode.views.toggleLatestOnly'],
  },
  { title: 'Lint', hint: 'every TP, KAREL and RAPID program in a folder at once; rules in .robotlint.json (robot-lint runs the same from a command line)', commands: ['robotCode.lint.folder', 'robotCode.lint.clear', 'robotCode.lint.createConfig'] },
  { title: 'KAREL', hint: 'check, then compile with ktrans; look up any built-in, statement or directive', commands: ['robotCode.karel.precheck', 'robotCode.karel.compile', 'robotCode.karel.showReference'] },
  { title: 'ABB RAPID (experimental)', hint: 'on in workspaces with ABB files (or robotCode.abb.enabled): modules, navigation, reports, controllers', commands: ['robotCode.rapid.refresh', 'robotCode.rapid.gotoLabel', 'robotCode.rapid.showCallGraph', 'robotCode.abb.unusedRoutines', 'robotCode.abb.xrefReport', 'robotCode.abb.compareBackups', 'robotCode.rapid.setIndentation', 'robotCode.abb.addController', 'robotCode.abb.editController', 'robotCode.abb.connect', 'robotCode.abb.refresh', 'robotCode.abb.disconnect', 'robotCode.abb.removeController', 'robotCode.abb.forgetIdentity', 'robotCode.abb.findVirtualControllers', 'robotCode.abb.lookupEvent', 'robotCode.abb.convertTarget', 'robotCode.abb.backup', 'robotCode.abb.openPage', 'robotCode.abb.showEventLog', 'robotCode.abb.showSignals', 'robotCode.abb.setSpeed', 'robotCode.abb.motorsOn', 'robotCode.abb.motorsOff', 'robotCode.abb.startRapid', 'robotCode.abb.stopRapid', 'robotCode.abb.resetProgramPointer', 'robotCode.abb.loadModule', 'robotCode.abb.unloadModule', 'robotCode.abb.setSignal', 'robotCode.abb.setRapidData', 'robotCode.abb.requestWriteAccess', 'robotCode.abb.releaseWriteAccess'] },
  {
    title: 'In RUKUS', hint: 'its clusters are the cells; what needs a connection held open lives there',
    commands: ['robotCode.rukus.openCluster', 'robotCode.rukus.syncClusters', 'robotCode.rukus.exportCell', 'robotCode.rukus.revealData', 'robotCode.rukus.open', 'robotCode.rukus.monitor', 'robotCode.rukus.alarms', 'robotCode.rukus.backup'],
  },
  { title: 'Help', hint: 'something wrong, or an idea? tell us; which features are on', commands: ['robotCode.reportIssue', 'robotCode.chooseFeatureProfile'] },
];

/** contributed, but not something a person runs by name: tree-row plumbing, test hooks, this picker itself */
export const NOT_LISTED = new Set(['robotCode.showFeatures', 'robotCode.views.revealInEditor', 'robotCode.rapid.open', 'robotCode.abb.openPointer', 'robotCode.abb.openModule', 'robotCode.live.openTaskLine', 'robotCode.live.getSection', 'robotCode.live._state', 'robotCode.tp._teachPlan', 'robotCode.sync.diffOpen', 'robotCode.containers.diffWithSnapshot']);

/** `ctrl+alt+shift+t` -> `Ctrl+Alt+Shift+T`, as the keyboard shortcuts editor writes it */
export function prettyKey(key: string): string {
  return key.split(' ').map(chord => chord.split('+').map(k => (k.length === 1 ? k.toUpperCase() : k[0].toUpperCase() + k.slice(1))).join('+')).join(' ');
}
