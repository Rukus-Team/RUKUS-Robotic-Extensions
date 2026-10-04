/**
 * The small pure pieces behind the Tier 1 sync work: the git-status parse for
 * `containers.gitAware`, and the per-file robot-compare map the status bar reads. No VS Code.
 */
import { parseGitPorcelain } from '@core/gitAware';
import { noteRobotCompare, robotCompareOf, clearRobotCompare } from '@core/robotCompare';
import { syncRelation, syncColorToken, snapshotRefFor, snapshotStatus, snapshotStatusText, MODIFIED_COLOR, DIVERGED_COLOR } from '@core/containerCompare';
import { normalizeTpForCompare, normalizedTextHash, lineDiffCount, snapshotNamesUnder, snapshotFetchedWithin } from '@core/robotContainers';
import { withSyncLock, pullAfterPushDecision } from '@core/syncLock';
import { httpGet } from '@core/live/http';
import type { ProgramInfo } from '@core/workspaceIndex';
import type { Services } from '@core/services';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

export async function run(check: (cond: unknown, msg: string) => void): Promise<void> {
  // ---- gitAware: porcelain parsing ----
  check(parseGitPorcelain('').dirty === false, 'gitAware: empty porcelain means clean');
  check(parseGitPorcelain('\n  \n').dirty === false, 'gitAware: whitespace-only porcelain means clean');
  const modified = parseGitPorcelain(' M C:/work/PROG.LS\n?? other.txt\n');
  check(modified.dirty === true && modified.status === ' M', `gitAware: a modified file is dirty (${JSON.stringify(modified)})`);
  check(parseGitPorcelain('?? C:/work/NEW.LS').status === '??', 'gitAware: an untracked file reports ??');

  // ---- robotCompare: keyed by the working file, case-insensitively ----
  clearRobotCompare();
  check(robotCompareOf('C:/work/PROG.LS') === undefined, 'robotCompare: nothing recorded is undefined');
  noteRobotCompare('C:/work/PROG.LS', { differs: true, changed: 3 });
  const hit = robotCompareOf('c:/work/prog.ls');
  check(!!hit && hit.differs && hit.changed === 3, `robotCompare: read back case-insensitively (${JSON.stringify(hit)})`);
  check(typeof hit?.at === 'number', 'robotCompare: the compare is stamped with a time');
  // keying by the robot root instead of the file was the bug: a different file must not see it
  check(robotCompareOf('C:/work/OTHER.LS') === undefined, 'robotCompare: a different file has no compare (keyed by file, not robot root)');
  noteRobotCompare('C:/work/OTHER.LS', { differs: false });
  check(robotCompareOf('C:/work/OTHER.LS')?.differs === false, 'robotCompare: identical compare is recorded as not differing');
  clearRobotCompare('C:/work/PROG.LS');
  check(robotCompareOf('C:/work/PROG.LS') === undefined && !!robotCompareOf('C:/work/OTHER.LS'), 'robotCompare: clearing one file leaves the others');
  clearRobotCompare();
  check(robotCompareOf('C:/work/OTHER.LS') === undefined, 'robotCompare: clearing with no argument drops everything');

  // ---- the git-shaped sync relation, shared by the status bar and the tree rows ----
  check(syncRelation({ state: 'same' }, undefined).symbol === '✓', 'syncRelation: W=S without a compare is ✓');
  check(syncRelation({ state: 'modified', lines: 2 }, undefined).symbol === '↑2', 'syncRelation: local changes show ↑n');
  check(syncRelation({ state: 'modified', lines: 2 }, { at: 1, differs: false }).symbol === '↑2', 'syncRelation: local changes, robot matches');
  check(syncRelation({ state: 'same' }, { at: 1, differs: true, changed: 3 }).symbol === '↓3', 'syncRelation: robot changed shows ↓n');
  check(syncRelation({ state: 'modified', lines: 2 }, { at: 1, differs: true, changed: 3 }).symbol === '↕', 'syncRelation: both changed is ↕');
  check(syncRelation({ state: 'missing' }, undefined).symbol === '?', 'syncRelation: no snapshot copy is ?');
  check(syncRelation({ state: 'same' }, { at: 1, differs: true, changed: 3 }).modified === false, 'syncRelation: robot-only change is not a local modification (no amber)');
  check(syncRelation({ state: 'modified', lines: 2 }, undefined).modified === true, 'syncRelation: a local diff is the amber case');

  // ---- the sync marker's colour: ✓/? plain, ↑/↓ amber, ↕ red ----
  check(syncColorToken(syncRelation({ state: 'same' }, undefined)) === undefined, 'syncColorToken: ✓ is uncoloured');
  check(syncColorToken(syncRelation({ state: 'missing' }, undefined)) === undefined, 'syncColorToken: ? is uncoloured');
  check(syncColorToken(syncRelation({ state: 'modified', lines: 2 }, undefined)) === MODIFIED_COLOR, 'syncColorToken: ↑ local is amber');
  check(syncColorToken(syncRelation({ state: 'same' }, { at: 1, differs: true, changed: 3 })) === MODIFIED_COLOR, 'syncColorToken: ↓ robot is amber');
  check(syncColorToken(syncRelation({ state: 'modified', lines: 2 }, { at: 1, differs: true, changed: 3 })) === DIVERGED_COLOR, 'syncColorToken: ↕ diverged is red');

  // ---- snapshot reference selection: a compiled binary must not shadow the source ----
  const prog = (over: Partial<ProgramInfo>): ProgramInfo => ({
    name: 'P', uri: {} as ProgramInfo['uri'], group: 'g', lineCount: 0, labels: 0, positions: 0,
    calls: [], macros: [], inlineComments: new Map(), dataAccess: new Map(),
    rawTokens: 0, mtime: 0, kind: 'tp', brand: 'fanuc', ...over,
  });
  const binRef = prog({ reference: true, kind: 'binary', textHash: undefined });
  const srcRef = prog({ reference: true, kind: 'tp', textHash: 'bbb' });
  const info = prog({ kind: 'tp', textHash: 'aaa' });
  check(snapshotRefFor([binRef, srcRef], info) === srcRef, 'snapshotRefFor: a compiled binary does not shadow the source');
  check(snapshotRefFor([srcRef, binRef], info) === srcRef, 'snapshotRefFor: order does not matter');
  const pcRef = prog({ reference: true, kind: 'binary', textHash: undefined });
  const klRef = prog({ reference: true, kind: 'karel', textHash: 'kkk' });
  check(snapshotRefFor([pcRef, klRef], prog({ kind: 'karel', textHash: 'aaa' })) === klRef, 'snapshotRefFor: a KAREL source beats its .pc');
  check(snapshotRefFor([pcRef], prog({ kind: 'karel', textHash: 'aaa' })) === undefined, 'snapshotRefFor: only a binary reference -> undefined, so the caller reads the source from disk');
  check(snapshotRefFor([klRef], info) === klRef, 'snapshotRefFor: a non-binary reference of another kind is used over a binary');
  const stub = (programs: ProgramInfo[]): Services => ({
    containers: {
      markerOf: () => ({ root: 'C:/r', name: 'R', snapshotFile: '', snapshotDir: 'C:/r/.robocode-robot/snapshot' }),
      snapshotInfo: () => ({ date: '2026-01-01T00:00:00Z' }),
    },
    index: { all: () => programs },
  } as unknown as Services);
  const st = snapshotStatus(stub([binRef, srcRef]), info);
  check(st?.state === 'modified', `snapshotStatus: an edit is modified even with a binary snapshot beside the source (${JSON.stringify(st)})`);
  check(snapshotStatus(stub([binRef, srcRef]), prog({ textHash: 'bbb' }))?.state === 'same', 'snapshotStatus: equal hashes are same');
  const compiledInfo: ProgramInfo = { ...prog({ kind: 'binary', textHash: undefined }), uri: { fsPath: 'C:/w/NAME.TP' } as ProgramInfo['uri'] };
  check(snapshotStatus(stub([]), compiledInfo)?.state === 'compiled', 'snapshotStatus: a compiled working copy is compiled (compare on demand), not same/modified');
  check(snapshotStatusText({ state: 'compiled' }) === 'compiled only', 'snapshotStatusText: compiled only');
  check(syncRelation({ state: 'compiled' }, undefined).symbol === '?', 'syncRelation: a compiled copy is ? (no text compare)');
  // a source working copy whose snapshot holds only a compiled copy is 'compiled', not '='
  const tmpSnap = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-cmp-'));
  try {
    fs.writeFileSync(path.join(tmpSnap, 'ONLYCOMP.TP'), Buffer.from([0xfe, 0xef, 0x00, 0x01]));
    const onlyStub = (programs: ProgramInfo[]): Services => ({
      containers: {
        markerOf: () => ({ root: 'C:/r', name: 'R', snapshotFile: '', snapshotDir: tmpSnap }),
        snapshotInfo: () => ({ date: '2026-01-01T00:00:00Z' }),
      },
      index: { all: () => programs },
    } as unknown as Services);
    const srcInfo: ProgramInfo = { ...prog({ kind: 'tp', textHash: 'aaa', name: 'ONLYCOMP' }), uri: { fsPath: 'C:/w/ONLYCOMP.LS' } as ProgramInfo['uri'] };
    check(snapshotStatus(onlyStub([]), srcInfo)?.state === 'compiled', 'snapshotStatus: source working, compiled-only snapshot -> compiled');
  } finally { try { fs.rmSync(tmpSnap, { recursive: true, force: true }); } catch { /* best effort */ } }

  // ---- an empty scaffold line ("   :  ;") is a real line, not filtered by normalization ----
  const head = '/PROG  TEST\n/ATTR\nLINE_COUNT\t= 2;\n/MN\n   1:  R[1]=1 ;\n   2:  R[2]=2 ;\n';
  const base = head + '/POS\n/END\n';
  const withScaffold = head + '   :  ;\n/POS\n/END\n';
  const nb = normalizeTpForCompare(base);
  const ns = normalizeTpForCompare(withScaffold);
  check(nb !== ns && normalizedTextHash(base, 'tp') !== normalizedTextHash(withScaffold, 'tp'),
    'empty scaffold line: "   :  ;" changes the normalized text (not filtered)');
  const d = lineDiffCount(nb, ns);
  check(d.changed + d.added + d.deleted === 1, `empty scaffold line: counted as one added line (${JSON.stringify(d)})`);
  check(normalizeTpForCompare(head + '   3:  ;\n/POS\n/END\n') === ns, 'empty scaffold line: "   :  ;" and a numbered blank normalize the same');

  // ---- the per-key sync lock: same key serialises, different keys do not block each other ----
  {
    const order: string[] = [];
    const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
    const a = withSyncLock('A', async () => { order.push('a1'); await delay(20); order.push('a2'); return 'a'; });
    const b = withSyncLock('A', async () => { order.push('b1'); await delay(1); order.push('b2'); return 'b'; });
    const c = withSyncLock('B', async () => { order.push('c1'); return 'c'; });
    const results = await Promise.all([a, b, c]);
    check(results.join('') === 'abc', 'the lock returns each operation\'s result');
    check(order.indexOf('b1') > order.indexOf('a2') && order.indexOf('b2') > order.indexOf('a2'),
      `the second op on a key waits for the first: ${order.join(',')}`);
    check(order.indexOf('c1') < order.indexOf('a2'), `a different key does not wait: ${order.join(',')}`);
    // a rejected op must not wedge the queue
    const failed = withSyncLock('F', async () => { throw new Error('boom'); });
    const after = withSyncLock('F', async () => 'ok');
    await failed.catch(() => undefined);
    check(await after === 'ok', 'a rejected operation does not wedge the key');
  }

  // ---- folder fetch scoping: only the names under the chosen snapshot directory ----
  const folderEntries = [
    { rel: 'PROGA.LS' },
    { rel: 'Data/numreg.va' },
    { rel: 'Data/posreg.va' },
    { rel: 'Data/Sub/sysvars.va' },
    { rel: 'Programs/other.TP' },
  ];
  check(JSON.stringify(snapshotNamesUnder(folderEntries, 'Data')) === JSON.stringify(['NUMREG.VA', 'POSREG.VA', 'SYSVARS.VA']), `snapshotNamesUnder: "Data" gets its files (recursive) and nothing else (${JSON.stringify(snapshotNamesUnder(folderEntries, 'Data'))})`);
  check(JSON.stringify(snapshotNamesUnder(folderEntries, 'DATA/')) === JSON.stringify(['NUMREG.VA', 'POSREG.VA', 'SYSVARS.VA']), 'snapshotNamesUnder: a trailing slash and case are ignored');
  check(snapshotNamesUnder(folderEntries, 'Data/Sub').join() === 'SYSVARS.VA', 'snapshotNamesUnder: a nested prefix narrows to that subtree, upper-cased');
  check(snapshotNamesUnder(folderEntries, 'Nope').length === 0, 'snapshotNamesUnder: a prefix that matches nothing is empty');
  check(snapshotNamesUnder(folderEntries, '').length === 5, 'snapshotNamesUnder: an empty prefix is the whole snapshot');
  // "Data" must not match a sibling that merely starts with the same word
  check(!snapshotNamesUnder([{ rel: 'Database/x.va' }], 'Data').length, 'snapshotNamesUnder: "Data" does not match "Database"');

  // ---- fetch-on-open buffer: a snapshot fetched in the last 5 minutes mutes the prompt ----
  const NOW = Date.parse('2026-09-30T12:00:00Z');
  const minsAgo = (m: number) => new Date(NOW - m * 60000).toISOString();
  const BUF = 5 * 60000;
  check(snapshotFetchedWithin(minsAgo(0), BUF, NOW), 'snapshotFetchedWithin: just fetched is fresh');
  check(snapshotFetchedWithin(minsAgo(4), BUF, NOW), 'snapshotFetchedWithin: 4 minutes ago is still fresh');
  check(!snapshotFetchedWithin(minsAgo(6), BUF, NOW), 'snapshotFetchedWithin: 6 minutes ago is stale, so prompt');
  check(!snapshotFetchedWithin(undefined, BUF, NOW), 'snapshotFetchedWithin: no timestamp is not fresh');
  check(!snapshotFetchedWithin('not-a-date', BUF, NOW), 'snapshotFetchedWithin: a bad timestamp is not fresh');
  check(snapshotFetchedWithin(minsAgo(-10), BUF, NOW), 'snapshotFetchedWithin: a future timestamp (clock skew) counts as fresh');

  // ---- pull-after-push: only an explicit push pulls, and the policy decides on a difference ----
  check(pullAfterPushDecision(true, 'always', true) === 'overwrite', "pullAfterPush: 'always' overwrites when identical");
  check(pullAfterPushDecision(true, 'always', false) === 'overwrite', "pullAfterPush: 'always' overwrites even when the controller changed it");
  check(pullAfterPushDecision(true, 'when-identical', true) === 'overwrite', "pullAfterPush: 'when-identical' overwrites when identical");
  check(pullAfterPushDecision(true, 'when-identical', false) === 'keep', "pullAfterPush: 'when-identical' keeps the local copy on a difference");
  check(pullAfterPushDecision(true, 'never', true) === 'off', "pullAfterPush: 'never' leaves the working copy alone");
  check(pullAfterPushDecision(false, 'always', true) === 'off', 'pullAfterPush: a live-edit save never pulls, whatever the policy');
  check(pullAfterPushDecision(false, 'when-identical', false) === 'off', 'pullAfterPush: a live-edit save never pulls (when-identical)');

  // ---- httpGet: a server that accepts TCP but never answers must fail in bounded time ----
  // This is the wedged-controller-web-server shape: the TCP handshake completes (so a port check
  // says "open") but no HTTP byte ever arrives. The absolute timeout is what turns it into a
  // bounded, catchable failure instead of a hang that leaves a connection stuck on "connecting".
  {
    const server = net.createServer(() => { /* accept the socket, never reply */ });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;
    const t0 = Date.now();
    let err: string | undefined;
    try { await httpGet({ host: '127.0.0.1', port, timeoutMs: 300 }, '/'); }
    catch (e: unknown) { err = e instanceof Error ? e.message : String(e); }
    const dt = Date.now() - t0;
    server.close();
    check(/timeout/i.test(err ?? ''), `httpGet: an unanswering server times out (${err ?? 'no error'})`);
    check(dt < 3000, `httpGet: it fails promptly, not on the OS connect timeout (${dt} ms)`);

    // an AbortSignal closes our side promptly, rather than waiting out the timeout
    const server2 = net.createServer(() => { /* accept, never reply */ });
    await new Promise<void>(resolve => server2.listen(0, '127.0.0.1', resolve));
    const port2 = (server2.address() as net.AddressInfo).port;
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    const t1 = Date.now();
    let err2: string | undefined;
    try { await httpGet({ host: '127.0.0.1', port: port2, timeoutMs: 5000 }, '/', ac.signal); }
    catch (e: unknown) { err2 = e instanceof Error ? e.message : String(e); }
    const dt2 = Date.now() - t1;
    server2.close();
    check(/abort/i.test(err2 ?? ''), `httpGet: an aborted request rejects as aborted (${err2 ?? 'no error'})`);
    check(dt2 < 1000, `httpGet: aborting is prompt, not the 5 s timeout (${dt2} ms)`);
  }
}
