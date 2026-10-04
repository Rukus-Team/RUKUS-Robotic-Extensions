/**
 * The snapshot sync primitives (issue #12): finding and writing snapshot files, the per-file
 * age map, the history reflog, the data/program predicates, and the verbatim push compare.
 * Pure + a temp folder; no VS Code. Wired in by test/run.ts: `await run(check)`.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  verbatimCompare, metadataOnlyDiff, eolNormalize,
  findSnapshotFile, readSnapshotFile, writeSnapshotFile, listSnapshotFiles,
  snapshotFileTimes, snapshotFileAge, snapshotRelKey,
  pushSnapshotFileToHistory, pruneSnapshotHistory, listSnapshotHistory,
  findSnapshotProgram, findSnapshotSource, readSnapshotProgram,
  isSourceProgram, isCompiledProgram, pairedProgramName,
  isSnapshotDataFile, isSnapshotProgramFile, SNAPSHOT_HISTORY_DIR, ROBOT_DIR,
  type SnapshotProvenance,
} from '@core/robotContainers';

export async function run(check: (cond: unknown, msg: string) => void): Promise<void> {
  // ---- verbatim compare ----
  const meta = 'PROGRAM TEST\nDATE = 24-SEP-26\nLINE_COUNT = 10\n  1: R[1]=1 ;\n';
  const metaChanged = 'PROGRAM TEST\nDATE = 25-SEP-26\nLINE_COUNT = 10\n  1: R[1]=1 ;\n';
  check(verbatimCompare('a\nb', 'a\nb').same, 'verbatimCompare: identical text is same');
  check(verbatimCompare('a\r\nb', 'a\nb').same, 'verbatimCompare: CRLF vs LF is the same (a transport artefact, not a change)');
  check(eolNormalize('a\r\nb\rc') === 'a\nb\nc', 'eolNormalize: folds CRLF and bare CR');
  const one = verbatimCompare('a\nb', 'a\nX');
  check(!one.same && one.changed === 1, `verbatimCompare: a changed line counts (${JSON.stringify(one)})`);
  // line numbers count verbatim (unlike the normalized working-vs-snapshot compare)
  const renumbered = verbatimCompare('  1: R[1]=1 ;', '  2: R[1]=1 ;');
  check(!renumbered.same, 'verbatimCompare: a renumber is a difference here, even though the tree marker ignores it');
  // metadata-only differences still block, but are labelled
  const md = verbatimCompare(meta, metaChanged);
  check(!md.same && md.metadataOnly === true, `verbatimCompare: only a DATE line changed -> still a conflict, labelled metadata-only (${JSON.stringify(md)})`);
  check(!metadataOnlyDiff('a\nb', 'a\nc'), 'metadataOnlyDiff: a real code change is not metadata');
  check(metadataOnlyDiff('DATE = 1', 'DATE = 2'), 'metadataOnlyDiff: a DATE change is metadata');

  // ---- classifications ----
  check(isSnapshotDataFile('NUMREG.VA') && isSnapshotDataFile('iostate.dg') && isSnapshotDataFile('cell.io') && isSnapshotDataFile('sysframe.va'), 'isSnapshotDataFile: registers, iostate, .io and frames are data');
  check(!isSnapshotDataFile('PROG.LS') && !isSnapshotDataFile('prog.kl'), 'isSnapshotDataFile: programs are not data');
  check(isSnapshotProgramFile('PROG.LS') && isSnapshotProgramFile('PROG.kl') && isSnapshotProgramFile('X.TP') && isSnapshotProgramFile('Y.PC'), 'isSnapshotProgramFile: .ls/.kl/.tp/.pc');
  check(snapshotRelKey('Sub\\Prog.LS') === 'sub/prog.ls', `snapshotRelKey: lower-cased, forward slashes (${snapshotRelKey('Sub\\Prog.LS')})`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'robocode-sync-'));
  try {
    const snap = path.join(tmp, ROBOT_DIR, 'snapshot');
    fs.mkdirSync(path.join(snap, 'PROGS'), { recursive: true });
    fs.writeFileSync(path.join(snap, 'PROG.LS'), 'HELLO');
    fs.writeFileSync(path.join(snap, 'NUMREG.VA'), '$NUMREG');
    fs.writeFileSync(path.join(snap, 'PROGS', 'OTHER.LS'), 'OTHER');

    // ---- finding and reading, case-insensitively and nested ----
    check(findSnapshotFile(snap, 'prog.ls') === path.join(snap, 'PROG.LS'), 'findSnapshotFile: matches the file name case-insensitively');
    check(findSnapshotFile(snap, 'OTHER.ls') === path.join(snap, 'PROGS', 'OTHER.LS'), 'findSnapshotFile: finds a nested file by name');
    check(findSnapshotFile(snap, 'nope.ls') === undefined, 'findSnapshotFile: missing is undefined');
    check(readSnapshotFile(snap, 'prog.ls') === 'HELLO', 'readSnapshotFile: reads the matching file');

    // ---- writing preserves the existing case ----
    writeSnapshotFile(snap, 'prog.ls', 'UPDATED');
    check(fs.existsSync(path.join(snap, 'PROG.LS')) && fs.readFileSync(path.join(snap, 'PROG.LS'), 'utf8') === 'UPDATED', 'writeSnapshotFile: overwrites the existing file, keeping its name');
    writeSnapshotFile(snap, 'NEW.LS', 'NEWFILE');
    check(fs.readFileSync(path.join(snap, 'NEW.LS'), 'utf8') === 'NEWFILE', 'writeSnapshotFile: creates a new file');

    // ---- the per-file age map, with an mtime fallback ----
    const at = '2026-09-24T10:00:00.000Z';
    const times = snapshotFileTimes(snap, at);
    check(Object.keys(times).length === 4 && times['prog.ls'] === at && times['progs/other.ls'] === at, `snapshotFileTimes: every file stamped (${Object.keys(times).join(', ')})`);
    const prov: SnapshotProvenance = { date: at, source: { kind: 'robot', name: 'R1', host: '1.2.3.4' }, fileCount: 4, updatedAt: at, files: times };
    check(snapshotFileAge(prov, 'PROG.LS', 0) === Date.parse(at), 'snapshotFileAge: uses the recorded time (case-insensitive key)');
    check(snapshotFileAge(undefined, 'PROG.LS', 12345) === 12345, 'snapshotFileAge: falls back to mtime when there is no map');
    check(snapshotFileAge(prov, 'unknown.ls', 999) === 999, 'snapshotFileAge: falls back for a file missing from the map');

    // ---- listSnapshotFiles ----
    const list = listSnapshotFiles(snap).map(e => e.rel).sort();
    check(list.length === 4 && list[0] === 'NEW.LS' && list.includes('PROGS/OTHER.LS'), `listSnapshotFiles: recursive with forward slashes (${list.join(', ')})`);

    // ---- the history reflog ----
    const hist = pushSnapshotFileToHistory(tmp, snap, 'PROG.LS', '20260924_100000');
    check(!!hist && fs.readFileSync(hist!, 'utf8') === 'UPDATED', 'pushSnapshotFileToHistory: keeps the current copy before a fetch replaces it');
    check(hist!.includes(SNAPSHOT_HISTORY_DIR), 'pushSnapshotFileToHistory: the copy lives under snapshot-history/');
    check(pushSnapshotFileToHistory(tmp, snap, 'missing.ls') === undefined, 'pushSnapshotFileToHistory: a file that is not there is a no-op');
    // a second stamp, then prune to the newest one
    pushSnapshotFileToHistory(tmp, snap, 'PROG.LS', '20260924_110000');
    pruneSnapshotHistory(tmp, 1);
    const stamps = fs.readdirSync(path.join(tmp, ROBOT_DIR, SNAPSHOT_HISTORY_DIR));
    check(stamps.length === 1 && stamps[0] === '20260924_110000', `pruneSnapshotHistory: keeps the newest N stamps (${stamps.join(', ')})`);
    pruneSnapshotHistory(tmp, 0);
    check(fs.readdirSync(path.join(tmp, ROBOT_DIR, SNAPSHOT_HISTORY_DIR)).length === 1, 'pruneSnapshotHistory: 0 keeps everything');

    // ---- the history browser's listing ----
    const kept = listSnapshotHistory(tmp, 'PROG.LS');
    check(kept.length === 1 && kept[0].stamp === '20260924_110000', `listSnapshotHistory: finds the kept version (${JSON.stringify(kept)})`);
    check(listSnapshotHistory(tmp, 'MISSING.LS').length === 0, 'listSnapshotHistory: a file with no history is an empty list');
    check(listSnapshotHistory(tmp, 'OTHER.LS', 'PROG.LS').length === 1, 'listSnapshotHistory: the fallback name matches a flat-named version');

    // ---- snapshot program lookup + read (the index-free compare fallback) ----
    check(findSnapshotProgram(snap, 'PROG') === path.join(snap, 'PROG.LS'), 'findSnapshotProgram: finds PROG.LS by program name');
    check(findSnapshotProgram(snap, 'other') === path.join(snap, 'PROGS', 'OTHER.LS'), 'findSnapshotProgram: finds a nested program by name');
    check(findSnapshotProgram(snap, 'NOPE') === undefined, 'findSnapshotProgram: a name with no copy is undefined');
    const read = readSnapshotProgram(snap, 'PROG', 'tp');
    check(!!read && read.path === path.join(snap, 'PROG.LS') && typeof read.textHash === 'string' && typeof read.normText === 'string', `readSnapshotProgram: reads and normalizes the copy (${JSON.stringify(read && { path: read.path, hash: read.textHash })})`);
    check(readSnapshotProgram(snap, 'NOPE', 'tp') === undefined, 'readSnapshotProgram: no copy is undefined');

    // ---- source vs compiled: a compiled copy is never read or compared as text ----
    check(isSourceProgram('X.LS') && isSourceProgram('x.kl') && !isSourceProgram('x.tp') && !isSourceProgram('numreg.va'), 'isSourceProgram: .ls/.kl only');
    check(isCompiledProgram('X.TP') && isCompiledProgram('x.pc') && !isCompiledProgram('x.ls'), 'isCompiledProgram: .tp/.pc only');
    check(pairedProgramName('NAME.LS') === 'NAME.TP' && pairedProgramName('name.tp') === 'name.LS', `pairedProgramName: LS<->TP either way (${pairedProgramName('name.tp')})`);
    check(pairedProgramName('NAME.KL') === 'NAME.PC' && pairedProgramName('NAME.PC') === 'NAME.KL', 'pairedProgramName: KL<->PC either way');
    check(pairedProgramName('NUMREG.VA') === undefined && pairedProgramName('notes.txt') === undefined, 'pairedProgramName: a non-program has no pair');
    fs.writeFileSync(path.join(snap, 'COMPILED.TP'), Buffer.from([0xfe, 0xef, 0x00, 0x01]));
    check(findSnapshotProgram(snap, 'COMPILED') === path.join(snap, 'COMPILED.TP'), 'findSnapshotProgram: finds a compiled-only program');
    check(findSnapshotSource(snap, 'COMPILED') === undefined, 'findSnapshotSource: a compiled-only program has no source');
    check(readSnapshotProgram(snap, 'COMPILED', 'tp') === undefined, 'readSnapshotProgram: never reads a compiled .tp as source');
    fs.writeFileSync(path.join(snap, 'BOTH.LS'), '/PROG B\n/MN\n/POS\n/END\n');
    fs.writeFileSync(path.join(snap, 'BOTH.TP'), Buffer.from([0x00, 0x01]));
    check(findSnapshotSource(snap, 'BOTH') === path.join(snap, 'BOTH.LS'), 'findSnapshotSource: the source wins over a compiled copy');
    check(readSnapshotProgram(snap, 'BOTH', 'tp')?.path === path.join(snap, 'BOTH.LS'), 'readSnapshotProgram: reads the source, not the compiled copy');
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}
