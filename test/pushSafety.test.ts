/**
 * A refused program upload (VS Code button test 2026-11-07, items 12, 14, 15; ROBOGUIDE V9.40).
 *  - 14: a refused .LS took the old program off the robot and left -TMPASC-.LS/.TP. The robot's
 *    copy is kept before the send and put back (TP first, then LS) when the program is gone;
 *    leftovers this send created are deleted. A fake FANUC MD: device below behaves like the
 *    controller did (RUKUS Studio TransferPutBackTests, PR #285).
 *  - 15: the reason is the controller's own (ERRALL.LS: "ASBN-092 Undefined instruction - line 23,
 *    column 28"), not a guess; the words say whether the old program went back.
 *  - 12: "R[1:Edit test]=    ;" (no value) is an error in the TP checker (ASBN-092).
 * Synthetic: no backup or controller needed. Set TP_CORPUS (folders, ";"-separated) to also run
 * the missing-operand check over real programs (none may be flagged). Wired in by test/run.ts.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseAlarms } from '@core/live/parsers';
import { FtpClient } from '@core/live/ftp';
import { parseTp } from '@fanuc/tp/parser';
import { tpChecks, missingOperand } from '@fanuc/tp/checks';
import {
  compiledForm, onRobot, leftovers, toDelete, putBackOrder, putBackAfterRefusal, refusalFromAlarms, parseRefusal, refusalSummary, refusedWords,
  type KeptCopy, type PutBackIo,
} from '@fanuc/live/putBack';
import { startMockRobot } from './mockRobot.mjs';

type Check = (cond: unknown, msg: string) => void;

// ROBOGUIDE R-30iB Plus V9.40, 2026-11-07, newest first: the loader's alarms after RKEDIT.LS with
// "R[1:Edit test]=" on line 23; an older unrelated alarm and a RESET below them
const ERRALL_REFUSED =
  'ERRALL.LS      Robot Name ROBOT 07-NOV-26 14:02:15  \n\n' +
  '   12" 07-NOV-26 14:02:11 " ASBN-009 on line 23, column 28                " ASBN-092 Undefined instruction            " WARN                          00000000"    "\n' +
  '   11" 07-NOV-26 14:02:11 " ASBN-008 file \'RKEDIT\'                        "                                             " WARN                          00000000"    "\n' +
  '   10" 07-NOV-26 14:02:11 " ASBN-002 Error occurred during load           "                                             " WARN                          00000000"    "\n' +
  '    9" 07-NOV-26 13:40:00 " SRVO-001 Operator panel E-stop                "                                             " SERVO                         00000000"    "\n' +
  '    8" 07-NOV-26 13:30:00 " R E S E T                                     "                                             "                               00000000"    "\n';
// nothing about the send: the newest alarm is an e-stop
const ERRALL_UNRELATED =
  'ERRALL.LS      Robot Name ROBOT 07-NOV-26 14:02:15  \n\n' +
  '    9" 07-NOV-26 13:40:00 " SRVO-001 Operator panel E-stop                "                                             " SERVO                         00000000"    "\n';
// the program open on the pendant: the controller keeps it
const ERRALL_IN_USE =
  'ERRALL.LS      Robot Name ROBOT 07-NOV-26 14:05:00  \n\n' +
  '   13" 07-NOV-26 14:05:00 " MEMO-068 Specified program is in use          "                                             " WARN                          00000000"    "\n';

const OLD_LS = '/PROG  RKEDIT\n/ATTR\n/MN\n   1:  R[1:Edit test]=1    ;\n/POS\n/END\n';
const BAD_LS = '/PROG  RKEDIT\n/ATTR\n/MN\n   1:  R[1:Edit test]=    ;\n/POS\n/END\n';
const OLD_TP = Buffer.from([0x54, 0x50, 0x01, 0x02]);   // a compiled program: bytes, not text

/**
 * A fake FANUC MD: device. A .LS whose text the loader cannot read (an assignment with no value)
 * is refused the way ROBOGUIDE did: the old program is gone, -TMPASC-.LS/.TP are left, ERRALL.LS
 * gets the loader's alarms, the reply is a 550. A program "in use" is refused and kept (MEMO-068).
 */
class FakeFanuc implements PutBackIo {
  files = new Map<string, Uint8Array>();
  writes: string[] = [];
  deletes: string[] = [];
  inUse = '';
  refuseTp = false;
  refuseAll = false;
  listFails = false;
  canDelete = true;
  remove?: (file: string) => Promise<void>;

  constructor() {
    this.remove = async (file: string) => {
      if (!this.canDelete) throw new Error('FTP DELE failed: 550 not allowed');
      this.deletes.push(file);
      const prog = file.replace(/\.[^.]*$/, '').toUpperCase();
      // a program goes by its .TP, and its .LS listing goes with it
      if (!this.files.delete(file.toUpperCase())) throw new Error('FTP DELE failed: 550 File not found');
      if (/\.TP$/i.test(file)) this.files.delete(`${prog}.LS`);
    };
  }

  put(prog: string, ls: string, tp: Uint8Array = OLD_TP): void {
    this.files.set(`${prog}.LS`, Buffer.from(ls, 'latin1'));
    this.files.set(`${prog}.TP`, tp);
  }

  async list(): Promise<string[]> {
    if (this.listFails) throw new Error('FTP LIST failed: 425');
    return [...this.files.keys()];
  }

  async write(file: string, data: Uint8Array): Promise<void> {
    this.writes.push(file);
    const name = file.toUpperCase();
    const prog = name.replace(/\.[^.]*$/, '');
    if (this.refuseAll) throw new Error('FTP STOR failed: 550 refused');
    if (prog === this.inUse) { this.files.set('ERRALL.LS', Buffer.from(ERRALL_IN_USE, 'latin1')); throw new Error('FTP STOR failed: 550 Program is in use'); }
    if (name.endsWith('.TP')) {
      if (this.refuseTp) throw new Error('FTP STOR failed: 553 binary not accepted');
      this.files.set(name, data);
      this.files.set(`${prog}.LS`, Buffer.from(`/PROG  ${prog}\n`, 'latin1'));
      return;
    }
    if (name.endsWith('.LS')) {
      // the loader takes the old program away as it starts
      this.files.delete(`${prog}.TP`); this.files.delete(`${prog}.LS`);
      this.files.set('-TMPASC-.LS', Buffer.from('x')); this.files.set('-TMPASC-.TP', Buffer.from('x'));
      if (missingOperandIn(Buffer.from(data).toString('latin1'))) {
        this.files.set('ERRALL.LS', Buffer.from(ERRALL_REFUSED, 'latin1'));
        throw new Error('FTP STOR failed: 550 Error occurred during load');
      }
      this.files.delete('-TMPASC-.LS'); this.files.delete('-TMPASC-.TP');
      this.files.set(name, data); this.files.set(`${prog}.TP`, Buffer.from('compiled'));
      return;
    }
    this.files.set(name, data);
  }

  text(file: string): string | undefined { const d = this.files.get(file.toUpperCase()); return d ? Buffer.from(d).toString('latin1') : undefined; }
}

const missingOperandIn = (ls: string) => ls.split(/\r?\n/).some(l => { const m = /^\s*\d+:\s*(.*?)\s*;\s*$/.exec(l); return !!m && !!missingOperand(m[1]); });

const keptOf = (dev: FakeFanuc, prog: string): KeptCopy[] => [
  { file: `${prog}.TP`, data: dev.files.get(`${prog}.TP`)!, path: `C:\\kept\\${prog}.TP` },
  { file: `${prog}.LS`, data: dev.files.get(`${prog}.LS`)!, path: `C:\\kept\\${prog}.LS` },
];

function listTpFiles(root: string, out: string[] = [], depth = 0): string[] {
  if (depth > 8) return out;
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(root, e.name);
    if (e.isDirectory()) listTpFiles(p, out, depth + 1);
    else if (/\.ls$/i.test(e.name)) out.push(p);
  }
  return out;
}

export async function runAsync(check: Check): Promise<void> {
  // ---------- 12: an operator with nothing after it ----------
  const flagged = [
    'R[1:Edit test]=', 'R[1]= ', 'PR[1,2]=PR[1,2]+', 'R[1]=R[2]*', 'R[3]=(R[1]-)', 'IF R[1]= ,JMP LBL[1]', 'IF R[1]>,JMP LBL[1]',
    'IF (R[1]<>),JMP LBL[2]', 'R[R[4]]=', 'SR[1:name]=', 'DO[1]=', 'R[1]=5/', '$WAITTMOUT=',
  ];
  for (const b of flagged) check(missingOperand(b) !== undefined, `missing operand flagged: "${b}"`);
  const fine = [
    'R[1:Edit test]=1', 'R[1]=R[2]+R[3]', 'R[1]=-1', 'R[1]=R[2]*(-1)', 'IF R[1]=1,JMP LBL[1]', 'IF R[1]<>R[2],JMP LBL[1]', 'WAIT DI[1]=ON',
    'WAIT DI[1]=ON TIMEOUT,LBL[1]', 'CALL -BCKEDT-', 'CALL A(1,2)', 'R[1:a=b]=1', "SR[1]='x='", "SR[1]=''", 'MESSAGE[R=]', 'JMP LBL[1:a-]',
    'DO[1]=PULSE,1.0sec', 'SELECT R[1]=1,JMP LBL[1]', 'ELSE,JMP LBL[2]', 'UFRAME_NUM=1', 'TIMER[1]=START', 'PR[1]=LPOS', 'R[1]=R[2] MOD 3',
    'IF (R[1]>=2 AND R[2]<=3),JMP LBL[5]', 'OVERRIDE=50%', 'SKIP CONDITION DI[1]=ON', 'R[1]=R[R[2]]', '$SPEED=1000', 'PAYLOAD[1]', 'END',
    'PR[1,1]=PR[1,1]+10.5', 'AR[1]', 'SPOT[SD=1,P=1,S=1,ED=1]', 'R[1]=DI[1]', 'IF R[1]<1,JMP LBL[1]', 'LBL[1:=]',
  ];
  for (const b of fine) check(missingOperand(b) === undefined, `no missing operand in valid "${b}" (${JSON.stringify(missingOperand(b))})`);
  const at = missingOperand('R[1:Edit test]=    ');
  check(at?.col === 14 && at.op === '=', `the "=" is where the finding starts (${JSON.stringify(at)})`);

  const prog = '/PROG  RKEDIT\n/ATTR\n/MN\n   1:  R[1:Edit test]=    ;\n   2:  R[2]=R[1]+1 ;\n   3:  IF R[1]> ,JMP LBL[1] ;\n   4:  LBL[1] ;\n/POS\n/END\n';
  const findings = tpChecks(prog, parseTp(prog)).filter(f => f.code === 'tp.missingOperand');
  check(findings.length === 2 && findings.every(f => f.severity === 'error'), `TP checker: two missing operands, errors (${findings.map(f => `${f.span.line}:${f.span.col}`)})`);
  check(findings[0]?.span.line === 3 && findings[0].span.col === 21 && /ASBN-092/.test(findings[0].message), `TP checker: line 4, from the "=" (${JSON.stringify(findings[0]?.span)} ${findings[0]?.message})`);
  const okProg = '/PROG  RKEDIT\n/ATTR\n/MN\n   1:  R[1:Edit test]=1    ;\n   2:  !R[1]= in a comment ;\n   3:  // R[2]= remark ;\n/POS\n/END\n';
  check(!tpChecks(okProg, parseTp(okProg)).some(f => f.code === 'tp.missingOperand'), 'TP checker: a valid line, a comment and a remark are not flagged');

  // the corpus: programs that load on real controllers are never flagged
  const roots = (process.env.TP_CORPUS ?? '').split(';').map(s => s.trim()).filter(Boolean);
  roots.push(path.resolve(__dirname, '..', 'test'));
  let files = 0, lines = 0;
  const hits: string[] = [];
  for (const root of roots) {
    for (const f of listTpFiles(root)) {
      const text = fs.readFileSync(f, 'latin1');
      if (!/^\/PROG\b/m.test(text)) continue;
      files++;
      for (const x of tpChecks(text, parseTp(text))) if (x.code === 'tp.missingOperand') hits.push(`${f}:${x.span.line + 1} ${text.split(/\r?\n/)[x.span.line].trim()}`);
      lines += text.split(/\n/).length;
    }
  }
  check(hits.length === 0, `missing operand: no finding in ${files} real programs (${lines} lines):\n    ${hits.slice(0, 8).join('\n    ')}`);
  console.log(process.env.TP_CORPUS ? `  missing operand corpus: ${files} programs, ${lines} lines, ${hits.length} flagged` : `  (missing operand corpus: ${files} test programs only - set TP_CORPUS to run it over real backups)`);

  // ---------- 15: the controller's own reason ----------
  const rows = parseAlarms(ERRALL_REFUSED);
  check(rows.length === 5 && rows[0].message === 'ASBN-009 on line 23, column 28' && rows[0].cause === 'ASBN-092 Undefined instruction' && rows[0].severity === 'WARN',
    `ERRALL.LS: the second column is the cause (${JSON.stringify(rows[0])})`);
  check(rows[1].message === "ASBN-008 file 'RKEDIT'" && rows[1].cause === undefined && rows[4].isReset, 'ERRALL.LS: an empty second column is no cause; the RESET row still parses');
  const r = refusalFromAlarms(ERRALL_REFUSED);
  check(r?.reason === 'ASBN-092 Undefined instruction' && r.line === 23 && r.column === 28 && r.program === 'RKEDIT',
    `refusal: reason, line, column, program (${JSON.stringify(r)})`);
  check(r !== undefined && refusalSummary(r) === 'ASBN-092 Undefined instruction - line 23, column 28', `refusal summary: ${r && refusalSummary(r)}`);
  check(!!r && !/SRVO-001/.test(r.alarms), 'refusal: an older unrelated alarm is not part of it');
  check(refusalFromAlarms(ERRALL_UNRELATED) === undefined, 'refusal: an e-stop on top is not taken for the reason');
  check(refusalFromAlarms(ERRALL_IN_USE)?.reason === 'MEMO-068 Specified program is in use', `refusal: MEMO-068 in use (${refusalFromAlarms(ERRALL_IN_USE)?.reason})`);
  const studio = parseRefusal("ASBN-009 on line 26, column 34 (ASBN-098 Invalid encoding of line); ASBN-008 file 'RKSD53T'; ASBN-002 Error occurred during load");
  check(studio.program === 'RKSD53T' && studio.line === 26 && studio.column === 34 && studio.reason === 'ASBN-098 Invalid encoding of line', `refusal parse (Studio's case): ${JSON.stringify(studio)}`);
  check(parseRefusal('MEMO-068 Specified program is in use').line === undefined, 'refusal parse: no line when the controller names none');

  // ---------- 14: the names ----------
  check(compiledForm('rkedit.ls') === 'RKEDIT.TP' && compiledForm('A.KL') === undefined, 'compiled form of a .LS is its .TP');
  check(onRobot('RKEDIT.LS', ['RKEDIT.TP']) === 'RKEDIT.TP' && onRobot('RKEDIT.LS', ['MAIN.TP']) === undefined, 'a .LS is on the robot when its .TP is');
  check(leftovers('RKEDIT.LS', ['MAIN.TP'], ['MAIN.TP', '-TMPASC-.LS', '-TMPASC-.TP']).join() === '-TMPASC-.TP,-TMPASC-.LS', 'leftovers: the -TMPASC- files that appeared');
  check(leftovers('RKEDIT.LS', ['-TMPASC-.TP', '-TMPASC-.LS'], ['-TMPASC-.LS', '-TMPASC-.TP']).length === 0, 'leftovers: a -TMPASC- the robot already had is not ours');
  check(leftovers('A.PC', [], ['-TMPASC-.TP']).length === 0, 'leftovers: only after a .LS');
  check(toDelete(['-TMPASC-.TP', '-TMPASC-.LS']).join() === '-TMPASC-.TP', 'a program is deleted by its .TP');
  check(putBackOrder('RKEDIT.LS', [{ file: 'RKEDIT.LS', data: Buffer.from('') }, { file: 'RKEDIT.TP', data: Buffer.from('') }, { file: 'X.TP', data: Buffer.from('') }]).map(k => k.file).join() === 'RKEDIT.TP,RKEDIT.LS', 'put back: the .TP first, then the .LS; nothing else');

  // ---------- 14: the fake controller ----------
  const send = async (dev: FakeFanuc, kept: KeptCopy[], data = BAD_LS) => {
    const before = await dev.list();
    let error = '';
    try { await dev.write('RKEDIT.LS', Buffer.from(data, 'latin1')); } catch (e: any) { error = e.message; }
    const refusal = dev.files.has('ERRALL.LS') ? refusalFromAlarms(dev.text('ERRALL.LS')!) : undefined;
    const putBack = error ? await putBackAfterRefusal(dev, 'RKEDIT.LS', kept, before) : undefined;
    return { error, refusal, putBack };
  };

  // the case seen on ROBOGUIDE: refused, old program gone, leftovers -> TP back, leftovers removed
  {
    const dev = new FakeFanuc(); dev.put('RKEDIT', OLD_LS); dev.put('MAIN', '/PROG  MAIN\n');
    const kept = keptOf(dev, 'RKEDIT');
    const { error, refusal, putBack } = await send(dev, kept);
    check(/550/.test(error) && !!putBack, 'fake: the bad .LS is refused');
    check(putBack!.needed && putBack!.restored && putBack!.from?.file === 'RKEDIT.TP' && Buffer.from(dev.files.get('RKEDIT.TP')!).equals(OLD_TP), `fake: the previous RKEDIT.TP went back as it was (${JSON.stringify({ ...putBack, from: putBack?.from?.file })})`);
    check(dev.writes.join() === 'RKEDIT.LS,RKEDIT.TP', `fake: one put-back write, the .TP (${dev.writes.join()})`);
    check(putBack!.removed.join() === '-TMPASC-.TP,-TMPASC-.LS' && !dev.files.has('-TMPASC-.TP') && !dev.files.has('-TMPASC-.LS') && dev.deletes.join() === '-TMPASC-.TP', `fake: the leftovers went, by the .TP (${dev.deletes.join()})`);
    check(dev.files.has('MAIN.TP'), 'fake: nothing else on the robot is touched');
    const w = refusedWords('ROBOT', 'RKEDIT.LS', { error, refusal, putBack: putBack! }, 'GENERIC HINT');
    check(!w.lost && w.text === "ROBOT refused RKEDIT.LS: ASBN-092 Undefined instruction - line 23, column 28. Its previous RKEDIT was put back. The controller's leftovers -TMPASC-.TP, -TMPASC-.LS were removed.",
      `words: the reason, the line, put back, leftovers (${w.text})`);
    check(!/GENERIC HINT|R507|write-protected/.test(w.text), 'words: no guessing when the controller said why');
  }
  // the .TP is not taken back: the .LS goes
  {
    const dev = new FakeFanuc(); dev.put('RKEDIT', OLD_LS); dev.refuseTp = true;
    const { putBack } = await send(dev, keptOf(dev, 'RKEDIT'));
    check(putBack!.restored && putBack!.from?.file === 'RKEDIT.LS' && dev.text('RKEDIT.LS') === OLD_LS, `fake: the .TP refused, the old .LS went back (${dev.writes.join()})`);
  }
  // nothing goes back: the loud warning, with where the copy is
  {
    const dev = new FakeFanuc(); dev.put('RKEDIT', OLD_LS);
    const kept = keptOf(dev, 'RKEDIT');
    const before = await dev.list();
    try { await dev.write('RKEDIT.LS', Buffer.from(BAD_LS, 'latin1')); } catch { /* refused */ }
    dev.refuseAll = true;
    const putBack = await putBackAfterRefusal(dev, 'RKEDIT.LS', kept, before);
    check(putBack.needed && !putBack.restored && !!putBack.error && putBack.from?.file === 'RKEDIT.LS', `fake: put-back failed, the .LS is the copy to send again (${JSON.stringify({ ...putBack, from: putBack.from?.file })})`);
    const w = refusedWords('ROBOT', 'RKEDIT.LS', { error: 'FTP STOR failed: 550', refusal: refusalFromAlarms(ERRALL_REFUSED), putBack });
    check(w.lost && /NO LONGER HAS RKEDIT/.test(w.text) && w.text.includes('C:\\kept\\RKEDIT.LS') && /ASBN-092/.test(w.text), `words: the loud warning (${w.text})`);
  }
  // in use: the controller kept the program -> nothing is sent back
  {
    const dev = new FakeFanuc(); dev.put('RKEDIT', OLD_LS); dev.inUse = 'RKEDIT';
    const { error, refusal, putBack } = await send(dev, keptOf(dev, 'RKEDIT'), OLD_LS);
    check(!putBack!.needed && putBack!.stillThere === true && dev.writes.join() === 'RKEDIT.LS', `fake: a program the robot kept is not written again (${dev.writes.join()})`);
    const w = refusedWords('ROBOT', 'RKEDIT.LS', { error, refusal, putBack: putBack! });
    check(w.text === 'ROBOT refused RKEDIT.LS: MEMO-068 Specified program is in use. RKEDIT on ROBOT is unchanged.', `words: in use, unchanged (${w.text})`);
  }
  // a new program: nothing to put back, the leftovers still go
  {
    const dev = new FakeFanuc(); dev.put('MAIN', '/PROG  MAIN\n');
    const { putBack } = await send(dev, []);
    check(!putBack!.needed && putBack!.stillThere === false && putBack!.removed.length === 2 && !dev.files.has('RKEDIT.TP'), 'fake: a new program refused - nothing put back, leftovers removed');
  }
  // the leftovers cannot be deleted: said, not hidden
  {
    const dev = new FakeFanuc(); dev.put('RKEDIT', OLD_LS); dev.canDelete = false;
    const { error, refusal, putBack } = await send(dev, keptOf(dev, 'RKEDIT'));
    check(putBack!.restored && putBack!.left.length === 2 && putBack!.removed.length === 0, 'fake: leftovers that will not go are reported as left');
    check(/are still on ROBOT/.test(refusedWords('ROBOT', 'RKEDIT.LS', { error, refusal, putBack: putBack! }).text), 'words: the leftovers still on the robot');
  }
  // the listing fails after the refusal: the copy goes back anyway (the same program over itself)
  {
    const dev = new FakeFanuc(); dev.put('RKEDIT', OLD_LS);
    const kept = keptOf(dev, 'RKEDIT');
    const before = await dev.list();
    try { await dev.write('RKEDIT.LS', Buffer.from(BAD_LS, 'latin1')); } catch { /* refused */ }
    dev.listFails = true;
    const putBack = await putBackAfterRefusal(dev, 'RKEDIT.LS', kept, before);
    check(putBack.needed && !putBack.restored && putBack.unconfirmed && dev.writes.join() === 'RKEDIT.LS,RKEDIT.TP' && putBack.left.length === 0 && putBack.removed.length === 0,
      `fake: no listing - the .TP is still sent once, and unconfirmed is not called restored (${JSON.stringify({ ...putBack, from: putBack.from?.file })})`);
    const w = refusedWords('ROBOT', 'RKEDIT.LS', { error: 'x', refusal: refusalFromAlarms(ERRALL_REFUSED), putBack });
    check(w.lost && /could not be listed to confirm/.test(w.text) && /check RKEDIT on the pendant/.test(w.text) && !/NO LONGER HAS/.test(w.text), `words: sent back but unconfirmed (${w.text})`);
  }
  // no reason from the controller: the reply and the generic hint
  {
    const w = refusedWords('ROBOT', 'RKEDIT.LS', { error: 'FTP STOR failed: 550 refused', putBack: { needed: false, restored: false, stillThere: true, removed: [], left: [] } }, 'The controller refused the file: usually ...');
    check(w.text === 'ROBOT refused RKEDIT.LS: FTP STOR failed: 550 refused. RKEDIT on ROBOT is unchanged. The controller refused the file: usually ...', `words: no reason - the reply and the hint (${w.text})`);
  }

  // ---------- FTP DELE (the leftovers' delete) against the mock controller ----------
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-dele-'));
  const mock = startMockRobot(dir, 18190, 18191);
  try {
    const ftp = new FtpClient({ host: '127.0.0.1', port: 18191, user: 'anonymous', password: '', timeoutMs: 2000 });
    await ftp.connect(); await ftp.cwd('MD:');
    await ftp.store('-TMPASC-.TP', Buffer.from('x'));
    await ftp.delete('-TMPASC-.TP');
    let missing = '';
    try { await ftp.delete('-TMPASC-.TP'); } catch (e: any) { missing = e.message; }
    await ftp.noop();
    await ftp.quit();
    check(!mock.uploads.has('-TMPASC-.TP') && /DELE failed: 550/.test(missing), `FTP DELE removes a file; a second one says 550 and the session stays in step (${missing})`);
  } catch (e: any) { check(false, `FTP DELE round trip failed: ${e?.stack ?? e}`); }
  finally { await mock.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}
