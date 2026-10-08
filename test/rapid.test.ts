/**
 * ABB RAPID: parser, diagnostics, docs and grammar. Wired in by test/run.ts: `run(check)`,
 * and `runGrammar(check, root)` once the oniguruma WASM is loaded.
 *
 * Two halves. Synthetic fixtures written here pin down each construct and each diagnostic.
 * The corpus half reads the IRC5 backups in abb-reference (never copied into this repo) and
 * skips with a note when they are not on this machine: every file must parse, every name
 * span must hold the name, and the whole corpus - programs that run on real controllers -
 * must produce no error-severity diagnostic.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as oniguruma from 'vscode-oniguruma';
import * as vsctm from 'vscode-textmate';
import {
  parseRapid, parseAggregate, parseRobTarget, parseJointTarget, robTargetsOf, isUnusedAxis, routineAt, moduleSymbols,
  type RapidModule, type Span,
} from '@abb/rapid/parser';
import { lexRapid, looksEncrypted } from '@abb/rapid/lexer';
import { diagnoseModule, diagnoseTask, type RapidIssue } from '@abb/rapid/diagnostics';
import { lookupRapidDoc, rapidDocMarkdown, rapidDocNames } from '@abb/rapid/docs';

type Check = (cond: unknown, msg: string) => void;

const textAt = (m: RapidModule, s: Span) => (m.lines[s.line] ?? '').substr(s.col, s.len);
const codes = (xs: RapidIssue[]) => xs.map(x => `${x.severity}:${x.code}`).sort().join(' ');

/** A module that uses every construct the parser claims to handle. */
const FIXTURE = [
  'MODULE Fixture(SYSMODULE, NOSTEPIN)',                                            // 0
  '  ! module comment',                                                              // 1
  '  RECORD partdata',                                                               // 2
  '    num id;',                                                                     // 3
  '    string name;',                                                                // 4
  '  ENDRECORD',                                                                     // 5
  '  ALIAS num counter;',                                                            // 6
  '  CONST robtarget pHome:=[[1000,0,1500],[0,0,1,0],[0,0,0,0],[9E+09,9E+09,9E+09,9E+09,9E+09,9E+09]];', // 7
  '  PERS jointtarget jHome:=[[0,0,0,0,30,0],[9E+9,9E+09,9E+09,9E+09,9E+09,9E+09]];', // 8
  '  LOCAL VAR num nCount{2,3};',                                                    // 9
  '  TASK PERS tooldata tGun:=[TRUE,[[0,0,200],[1,0,0,0]],',                         // 10
  '    [5,[0,0,100],[1,0,0,0],0,0,0]];',                                             // 11
  '  VAR intnum iStop;',                                                             // 12
  '  ! Moves to the part',                                                           // 13
  '  PROC Main()',                                                                   // 14
  '    VAR num i:=0;',                                                               // 15
  '    MoveJ pHome, v1000, z50, tGun\\WObj:=wobj0;',                                 // 16
  '    MoveL Offs(pHome,0,0,100), v200, fine, tGun;',                                // 17
  '    MoveC p1, p2, v100, z10, tool0;',                                             // 18
  '    MoveAbsJ jHome\\NoEOffs, v500, fine, tool0;',                                 // 19
  '    SpotL wp1, v500, Gun1\\GunD:=gd1, sd_1, GunTCP\\WObj:=w1\\TLoad:=lo1;',       // 20
  '    IF i > 0 THEN',                                                               // 21
  '      Helper 1, \\Fast;',                                                         // 22
  '    ELSEIF i = 0 THEN',                                                           // 23
  '      i := Square(2);',                                                           // 24
  '    ELSE',                                                                        // 25
  '      %"Help" + "er"% 2;',                                                        // 26
  '    ENDIF',                                                                       // 27
  '    IF NOT i = 0 WaitTime 0.5;',                                                  // 28
  '    FOR k FROM 1 TO 3 DO',                                                        // 29
  '      nCount{1,k} := k;',                                                         // 30
  '    ENDFOR',                                                                      // 31
  '    WHILE i < 3 DO',                                                              // 32
  '      Incr i;',                                                                   // 33
  '    ENDWHILE',                                                                    // 34
  '    TEST i',                                                                      // 35
  '    CASE 1, 2:',                                                                  // 36
  '      GOTO lblEnd;',                                                              // 37
  '    DEFAULT:',                                                                    // 38
  '      CONNECT iStop WITH StopTrap;',                                              // 39
  '    ENDTEST',                                                                     // 40
  '    lblEnd:',                                                                     // 41
  '    SetDO doOut, 1; ! trailing comment',                                          // 42
  '  ERROR',                                                                         // 43
  '    RETRY;',                                                                      // 44
  '  ENDPROC',                                                                       // 45
  '  LOCAL PROC Helper(num n, \\switch Fast, \\num a | \\num b, INOUT num c{*}, PERS robtarget pt)', // 46
  '    <SMT>',                                                                       // 47
  '  UNDO',                                                                          // 48
  '    Stop;',                                                                       // 49
  '  ENDPROC',                                                                       // 50
  '  FUNC num Square(',                                                              // 51
  '    num x)',                                                                      // 52
  '    RETURN x*x;',                                                                 // 53
  '  ENDFUNC',                                                                       // 54
  '  TRAP StopTrap',                                                                 // 55
  '    StopMove;',                                                                   // 56
  '  ENDTRAP',                                                                       // 57
  'ENDMODULE',                                                                       // 58
  '',
].join('\r\n');

export function run(check: Check): void {
  // ---------------- lexer ----------------
  {
    const lx = lexRapid('x := "a!b""c"; ! note\r\nMoveL p, v, z, t\\WObj:=w;');
    check(lx.tokens.map(t => t.text).join(' ') === 'x := "a!b""c" ; MoveL p , v , z , t \\ WObj := w ;', `lexer tokens: ${lx.tokens.map(t => t.text).join(' ')}`);
    check(lx.comments.length === 1 && lx.comments[0].text === ' note' && lx.comments[0].span.col === 15 && !lx.comments[0].fullLine, 'a ! inside a string is not a comment; the trailing one is');
    check(lexRapid('<SMT>').tokens[0]?.kind === 'placeholder' && lexRapid('a<B>c').tokens.every(t => t.kind !== 'placeholder'), '<SMT> is a placeholder, a<B>c is a comparison');
    check(lexRapid('9E+09 1.5 .5 0xFF').tokens.map(t => t.kind).join() === 'num,num,num,num', 'numbers: 9E+09 1.5 .5 0xFF');
    check(looksEncrypted('\xfc\x10QH\x08\x01\x80') && !looksEncrypted('MODULE X\r\nENDMODULE\r\n') && !looksEncrypted('! caf\xe9\r\nMODULE X'), 'encrypted modules are told apart from Latin-1 text');
  }

  // ---------------- parser: every construct ----------------
  const m = parseRapid(FIXTURE);
  check(m.name === 'Fixture' && textAt(m, m.nameSpan!) === 'Fixture', `module name: ${m.name}`);
  check(m.attributes.join(',') === 'SYSMODULE,NOSTEPIN', `module attributes: ${m.attributes}`);
  check(m.problems.length === 0, `fixture parses clean: ${JSON.stringify(m.problems)}`);
  check(m.routines.map(r => `${r.kind} ${r.name}`).join(', ') === 'PROC Main, PROC Helper, FUNC Square, TRAP StopTrap', `routines: ${m.routines.map(r => r.name)}`);
  const main = m.routines[0], helper = m.routines[1], square = m.routines[2];
  check(main.startLine === 14 && main.endLine === 45 && main.doc === 'Moves to the part', `Main spans 14-45 with its doc: ${main.startLine}-${main.endLine} ${JSON.stringify(main.doc)}`);
  check(helper.local && !main.local, 'LOCAL PROC is local');
  check(square.returnType === 'num' && square.params.length === 1 && square.params[0].name === 'x' && square.signature === 'FUNC num Square( num x)', `FUNC over two lines: ${square.signature}`);
  const hp = helper.params;
  check(hp.map(p => p.name).join() === 'n,Fast,a,b,c,pt', `Helper params: ${hp.map(p => p.name)}`);
  check(hp[1].switch && hp[1].optional && hp[2].optional && hp[2].altGroup !== undefined && hp[2].altGroup === hp[3].altGroup && hp[0].altGroup === undefined, 'switch and | alternatives');
  check(hp[4].mode === 'INOUT' && hp[4].dims === 1 && hp[5].mode === 'PERS' && hp[5].type === 'robtarget' && hp[0].mode === 'IN', 'INOUT num c{*}, PERS robtarget pt');
  check(main.handlers.map(h => h.kind).join() === 'ERROR' && helper.handlers.map(h => h.kind).join() === 'UNDO', 'ERROR and UNDO handlers');
  check(main.labels.map(l => l.name).join() === 'lblEnd' && m.gotos.length === 1 && m.gotos[0].routine === 'Main', 'label and GOTO');
  check(m.placeholders.length === 1 && m.placeholders[0].text === '<SMT>' && m.placeholders[0].routine === 'Helper', '<SMT> placeholder');
  check(m.records.length === 1 && m.records[0].fields.map(f => `${f.type} ${f.name}`).join() === 'num id,string name', 'RECORD fields');
  check(m.aliases.length === 1 && m.aliases[0].name === 'counter' && m.aliases[0].type === 'num', 'ALIAS');

  const byName = new Map(m.data.map(d => [d.name, d]));
  check(m.data.map(d => d.name).join() === 'pHome,jHome,nCount,tGun,iStop', `module data: ${m.data.map(d => d.name)}`);
  check(byName.get('pHome')?.storage === 'CONST' && byName.get('jHome')?.storage === 'PERS' && byName.get('iStop')?.storage === 'VAR', 'storage classes');
  check(byName.get('nCount')?.scope === 'LOCAL' && byName.get('nCount')?.dims?.join() === '2,3' && byName.get('tGun')?.scope === 'TASK', 'LOCAL / TASK and array dims');
  const tg = byName.get('tGun')!;
  check(tg.init?.span.line === 10 && tg.init.end.line === 11 && /\[5,\[0,0,100\]/.test(tg.init.text), 'a declaration wrapping over two lines keeps its whole initializer');
  check(main.data.length === 1 && main.data[0].name === 'i' && main.data[0].routine === 'Main' && main.data[0].init?.text === '0', 'routine-level VAR');

  // moves
  check(m.moves.map(x => x.instruction).join() === 'MoveJ,MoveL,MoveC,MoveAbsJ,SpotL', `moves: ${m.moves.map(x => x.instruction)}`);
  const [mj, ml, mc, mabs, spot] = m.moves;
  check(mj.target?.text === 'pHome' && mj.speed?.text === 'v1000' && mj.zone?.text === 'z50' && mj.tool?.text === 'tGun' && mj.wobj?.text === 'wobj0' && mj.kind === 'joint', 'MoveJ roles');
  check(ml.target?.text === 'Offs(pHome,0,0,100)' && ml.zone?.text === 'fine', 'MoveL target is the whole Offs(...) expression');
  check(mc.circPoint?.text === 'p1' && mc.target?.text === 'p2' && mc.tool?.text === 'tool0', 'MoveC circle point and target');
  check(mabs.target?.text === 'jHome' && mabs.optArgs.some(o => o.name === 'NoEOffs' && !o.value) && mabs.kind === 'absj', 'MoveAbsJ with a \\switch after the target');
  check(spot.kind === 'spot' && spot.target?.text === 'wp1' && spot.gun?.text === 'Gun1' && spot.spot?.text === 'sd_1' && spot.tool?.text === 'GunTCP' && spot.wobj?.text === 'w1' && spot.tload?.text === 'lo1' && !spot.zone, 'SpotL roles (no zone)');
  for (const mv of m.moves) for (const a of [mv.target, mv.speed, mv.tool]) if (a) check(textAt(m, a.span) === a.text, `argument span holds its text: ${a.text}`);

  // calls
  const calls = m.calls.map(c => `${c.kind}:${c.name ?? c.expr}`);
  check(calls.includes('proc:Helper') && calls.includes('func:Square') && calls.includes('func:Offs') && calls.includes('proc:WaitTime') && calls.includes('proc:SetDO') && calls.includes('proc:Incr'), `calls: ${calls.join(' ')}`);
  const late = m.calls.find(c => c.kind === 'late')!;
  check(late && late.name === undefined && late.expr === '"Help" + "er"' && late.args[0]?.text === '2', `late binding with an expression: ${JSON.stringify(late)}`);
  const lit = parseRapid('MODULE L\r\nPROC P()\r\n  %"Helper"%;\r\n  %"Other"% 1, 2;\r\nENDPROC\r\nENDMODULE').calls.filter(c => c.kind === 'late');
  check(lit.map(c => c.name).join() === 'Helper,Other' && lit[1].args.length === 2 && lit[0].span.col === 4 && lit[0].span.len === 6, 'late binding with a literal name: span is the name inside the quotes');
  const hc = m.calls.find(c => c.name === 'Helper')!;
  check(hc.args.map(a => a.text).join() === '1' && hc.optArgs.map(o => o.name).join() === 'Fast', 'Helper 1, \\Fast: one positional, one switch');
  check(m.connects.length === 1 && m.connects[0].interrupt === 'iStop' && m.connects[0].trap === 'StopTrap', 'CONNECT ... WITH');
  check(m.refs.some(r => r.name === 'i' && r.write && r.span.line === 24) && m.refs.some(r => r.name === 'nCount' && r.write), 'assignment targets are written refs');
  check(!m.refs.some(r => r.name === 'WObj' || r.name === 'NoEOffs'), 'optional-argument names are not data refs');
  check(!m.calls.some(c => c.name === 'i') && m.calls.some(c => c.name === 'WaitTime' && c.args[0]?.text === '0.5'), 'compact IF: the condition ends where WaitTime begins');
  check(m.blocks.filter(b => b.kind === 'IF').length === 1 && m.blocks.every(b => b.close), 'every block closed; the compact IF opens none');
  check(m.comments.some(c => c.text === ' trailing comment' && !c.fullLine), 'trailing comment');
  check(routineAt(m, 30)?.name === 'Main' && routineAt(m, 56)?.name === 'StopTrap' && routineAt(m, 12) === undefined, 'routineAt');
  check(moduleSymbols(m).every(s => textAt(m, s.span) === s.name), 'moduleSymbols spans hold their names');

  // %%% header, BOM, lower-case keywords, encrypted
  const hdr = parseRapid('%%%\r\n  VERSION:1\r\n  LANGUAGE:ENGLISH\r\n%%%\r\n\r\nmodule Old\r\n  proc main()\r\n    movej p, v, z, t;\r\n  endproc\r\nendmodule\r\n');
  check(hdr.header?.version === '1' && hdr.header.language === 'ENGLISH' && hdr.name === 'Old' && hdr.routines[0]?.name === 'main' && hdr.moves[0]?.instruction === 'movej', '%%% header, keywords in any case');
  check(parseRapid('﻿MODULE B\r\nENDMODULE').nameSpan?.col === 7, 'a BOM does not shift columns');
  const enc = parseRapid('\xfc\x10QH\x08\x01\x80\x01garbage;');
  check(enc.encrypted && !enc.name && enc.routines.length === 0, 'encrypted module: empty, flagged');

  // ---------------- robtarget / jointtarget ----------------
  const rt = parseRobTarget('[[1000,0,1500],[0,0,1,0],[0,0,0,0],[9E+09,9E+09,9E+09,9E+09,9E+09,9E+09]]');
  check(rt && rt.trans.join() === '1000,0,1500' && rt.rot.join() === '0,0,1,0' && rt.robconf.join() === '0,0,0,0' && rt.extax.every(isUnusedAxis), 'robtarget literal');
  check(!parseRobTarget('[[1,2],[1,0,0,0],[0,0,0,0],[9E9,9E9,9E9,9E9,9E9,9E9]]') && !parseRobTarget('p10') && !parseRobTarget('[[1,2,3],[1,0,0,0]'), 'malformed robtargets are refused');
  const jt = parseJointTarget(byName.get('jHome')!.init!.text);
  check(jt && jt.robax.join() === '0,0,0,0,30,0' && isUnusedAxis(jt.extax[0]) && jt.extax[0] === 9e9, 'jointtarget literal, 9E+9 spelling');
  check(robTargetsOf(byName.get('pHome')!)?.length === 1, 'robTargetsOf a single robtarget');
  const arr = parseRapid('MODULE A\r\nCONST robtarget path{2}:=[[[1,2,3],[1,0,0,0],[0,0,0,0],[9E9,9E9,9E9,9E9,9E9,9E9]],[[4,5,6],[1,0,0,0],[0,0,0,0],[9E9,9E9,9E9,9E9,9E9,9E9]]];\r\nENDMODULE');
  check(robTargetsOf(arr.data[0])?.map(t => t.trans[0]).join() === '1,4', 'robTargetsOf an array');
  const agg = parseAggregate('[TRUE,"a""b",[1,-2.5E-3],wobj0]');
  check(JSON.stringify(agg) === JSON.stringify([true, 'a"b', [1, -0.0025], { expr: 'wobj0' }]), `parseAggregate: ${JSON.stringify(agg)}`);

  // ---------------- diagnostics ----------------
  check(diagnoseModule(m).length === 0, `fixture has no diagnostics: ${codes(diagnoseModule(m))}`);
  const d = (src: string) => diagnoseModule(parseRapid(`MODULE D\r\n${src}\r\nENDMODULE`));
  check(codes(d('PROC A()\r\n  IF x THEN\r\n    Stop;\r\nENDPROC')) === 'error:rapid.unclosedBlock', 'IF without ENDIF');
  check(codes(d('PROC A()\r\n  Stop;\r\n  ENDIF\r\nENDPROC')) === 'error:rapid.unmatchedEnd', 'ENDIF without IF');
  check(codes(d('PROC A()\r\n  FOR i FROM 1 TO 2 DO\r\n  ENDWHILE\r\n  ENDFOR\r\nENDPROC')) === 'error:rapid.unmatchedEnd', 'ENDWHILE inside a FOR');
  check(codes(d('PROC A()\r\n  WHILE TRUE DO\r\n    Stop;\r\nENDPROC')) === 'error:rapid.unclosedBlock', 'ENDPROC closes over an open WHILE');
  check(codes(d('PROC A()\r\n  Stop;\r\nPROC B()\r\nENDPROC')) === 'error:rapid.unclosedBlock', 'a PROC never ended');
  check(codes(d('PROC A()\r\n  ELSE\r\n  CASE 1:\r\nENDPROC')) === 'error:rapid.misplaced error:rapid.misplaced', 'ELSE outside IF, CASE outside TEST');
  check(codes(d('PROC A()\r\n  IF x THEN\r\n  ERROR\r\n  ENDIF\r\nENDPROC')) === 'error:rapid.misplaced', 'ERROR handler inside an IF');
  check(codes(d('VAR num x;\r\nPERS num X:=1;\r\nPROC x()\r\nENDPROC')) === 'error:rapid.duplicateName error:rapid.duplicateName', 'duplicate names are case-insensitive, data and routines share them');
  check(codes(d('PROC A(num n)\r\n  VAR num n;\r\nENDPROC')) === 'error:rapid.duplicateName', 'a local repeating a parameter');
  check(codes(d('PROC A()\r\n  VAR num n;\r\nENDPROC\r\nPROC B()\r\n  VAR num n;\r\nENDPROC')) === '', 'the same local name in two routines is fine');
  check(codes(d('PROC A()\r\n  GOTO nowhere;\r\n  here:\r\nENDPROC')) === 'error:rapid.undefinedLabel', 'GOTO to a missing label');
  check(codes(d('PROC A()\r\n  GOTO here;\r\n  here:\r\nENDPROC')) === '', 'GOTO to a label');
  check(codes(d('LOCAL PROC Unused()\r\nENDPROC')) === 'hint:rapid.unusedLocalRoutine', 'unused LOCAL routine is a hint');
  check(codes(d('LOCAL PROC ByName()\r\nENDPROC\r\nPROC A()\r\n  %"ByName"%;\r\nENDPROC')) === '', 'a LOCAL routine called by late binding is used');
  check(codes(d('LOCAL PROC Path_1()\r\nENDPROC\r\nPROC A()\r\n  CallByVar "Path_", 1;\r\nENDPROC')) === '', 'a LOCAL routine reached through CallByVar\'s prefix is used');
  check(codes(d('LOCAL TRAP T1\r\nENDTRAP\r\nPROC A()\r\n  CONNECT i WITH T1;\r\nENDPROC')) === '', 'a LOCAL TRAP named in CONNECT is used');
  check(codes(d('PROC A()\r\n  x := 1\r\nENDPROC')) === 'warning:rapid.missingSemicolon', 'missing ; before ENDPROC is a warning');

  const t1 = parseRapid('MODULE T1\r\nPROC main()\r\n  Shared1;\r\n  Other;\r\n  Nowhere;\r\n  Local2;\r\n  MoveL p, v, z, t;\r\nENDPROC\r\nENDMODULE');
  const t2 = parseRapid('MODULE T2\r\nPROC Other()\r\nENDPROC\r\nLOCAL PROC Local2()\r\n  Other;\r\nENDPROC\r\nENDMODULE');
  const sh = parseRapid('MODULE S(SYSMODULE)\r\nPROC Shared1()\r\nENDPROC\r\nENDMODULE');
  const [i1, i2] = diagnoseTask([t1, t2], { shared: [sh] });
  check(i1.filter(x => x.code === 'rapid.unknownRoutine').map(x => `${x.severity}:${textAt(t1, x.span)}`).join() === 'warning:Nowhere,warning:Local2', `task resolution: ${codes(i1)} ${i1.map(x => textAt(t1, x.span))}`);
  check(codes(i2) === 'hint:rapid.unusedLocalRoutine', `Local2 is LOCAL to T2 and T2 never calls it: ${codes(i2)}`);
  const [e1] = diagnoseTask([t1, parseRapid('\xfc\x10QH\x08\x01\x80')], { shared: [sh] });
  check(e1.filter(x => x.code === 'rapid.unknownRoutine').every(x => x.severity === 'hint'), 'with an encrypted module in the task an unknown call is only a hint');
  check(diagnoseTask([t1], { shared: [sh], known: ['Nowhere', 'Local2', 'Other'] })[0].length === 0, 'known names silence the check');

  // ---------------- docs ----------------
  for (const w of ['MoveL', 'movej', 'MOVEABSJ', 'SpotL', 'robtarget', 'Offs', 'SetDO', 'WaitDI', 'CONNECT', 'PERS', 'tooldata', 'zonedata'])
    check(!!lookupRapidDoc(w), `hover doc for ${w}`);
  check(!lookupRapidDoc('NotAThing'), 'no doc for an unknown word');
  check(rapidDocNames().length >= 80, `docs cover ${rapidDocNames().length} names`);
  check(/```rapid\nMoveL /.test(rapidDocMarkdown(lookupRapidDoc('MoveL')!)), 'doc markdown has a rapid code block');

  runCorpus(check);
}

// ---------------------------------------------------------------------------------------
// The IRC5 corpus
// ---------------------------------------------------------------------------------------

/** abb-reference/backups/Backup_09_16_2023_Before next to the repo (or next to any parent, for worktrees), or $RAPID_CORPUS. */
export function findCorpus(): string | undefined {
  if (process.env.RAPID_CORPUS && fs.existsSync(process.env.RAPID_CORPUS)) return process.env.RAPID_CORPUS;
  let dir = path.resolve(__dirname, '..');
  for (let i = 0; i < 6; i++) {
    const c = path.join(path.dirname(dir), 'abb-reference', 'backups', 'Backup_09_16_2023_Before');
    if (fs.existsSync(c)) return c;
    dir = path.dirname(dir);
  }
  return undefined;
}

function runCorpus(check: Check): void {
  const root = findCorpus();
  if (!root) { console.log('  (abb-reference corpus not found; RAPID corpus checks skipped - set RAPID_CORPUS to run them)'); return; }
  const files: string[] = [];
  const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(mod|modx|sys)$/i.test(e.name)) files.push(p); } };
  walk(root);
  // the 24 backups repeat most modules; parse each distinct text once
  const cache = new Map<string, RapidModule>();
  const parsed = new Map<string, RapidModule>();
  let threw = 0, bom = 0;
  for (const f of files) {
    const buf = fs.readFileSync(f);
    if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) bom++;
    // the controller writes Latin-1 (no corpus file is valid UTF-8 where it is not ASCII)
    const text = buf[0] === 0xef && buf[1] === 0xbb ? buf.toString('utf8') : buf.toString('latin1');
    let m = cache.get(text);
    if (!m) {
      try { m = parseRapid(text); } catch (e: any) { threw++; check(false, `parseRapid threw on ${f}: ${e?.message ?? e}`); continue; }
      cache.set(text, m);
    }
    parsed.set(f, m);
  }
  check(threw === 0, `every corpus file parses without throwing (${files.length} files)`);

  const plain = [...parsed].filter(([, m]) => !m.encrypted);
  const distinct = [...cache.values()].filter(m => !m.encrypted);
  check(plain.every(([, m]) => !!m.name), 'every plain module has a MODULE name');
  // the parser's name is the one on the MODULE line, found here independently of the parser
  const headerName = (m: RapidModule) => { for (const l of m.lines) { const x = /^\s*MODULE\s+([A-Za-z]\w*)/i.exec(l); if (x) return x[1]; if (l.trim() && !/^\s*(!|%%%|VERSION|LANGUAGE)/i.test(l)) return undefined; } return undefined; };
  const wrongName = plain.filter(([, m]) => m.name !== headerName(m));
  check(wrongName.length === 0, `module name matches the MODULE line: ${wrongName.slice(0, 3).map(([f, m]) => `${m.name} in ${path.basename(f)}`).join(', ')}`);
  // file and module names usually agree, but not always (TxtAnswerKeyGenSpot.sys holds MODULE AnswerKey)
  const otherName = plain.filter(([f, m]) => m.name?.toUpperCase() !== path.basename(f).replace(/\.\w+$/, '').toUpperCase());

  // spans hold the names they claim
  let spans = 0, bad = 0;
  const hold = (m: RapidModule, s: Span, name: string) => { spans++; if (textAt(m, s) !== name) { bad++; if (bad <= 5) check(false, `span ${s.line + 1}:${s.col} holds "${textAt(m, s)}", want "${name}"`); } };
  for (const m of distinct) {
    hold(m, m.nameSpan!, m.name!);
    for (const r of m.routines) {
      hold(m, r.nameSpan, r.name);
      for (const p of r.params) hold(m, p.nameSpan, p.name);
      for (const x of r.data) { hold(m, x.nameSpan, x.name); hold(m, x.typeSpan, x.type); }
      for (const l of r.labels) hold(m, l.span, l.name);
    }
    for (const x of m.data) { hold(m, x.nameSpan, x.name); hold(m, x.typeSpan, x.type); }
    for (const r of m.records) { hold(m, r.nameSpan, r.name); for (const fl of r.fields) hold(m, fl.nameSpan, fl.name); }
    for (const c of m.calls) if (c.kind !== 'late' && c.name) hold(m, c.span, c.name);
    for (const mv of m.moves) { hold(m, mv.span, mv.instruction); if (mv.target && mv.target.span.line === mv.target.end.line) hold(m, mv.target.span, mv.target.text); }
    for (const r of m.refs) hold(m, r.span, r.name);
  }
  check(bad === 0, `round-trip spans: ${bad} of ${spans} do not hold their name`);

  // robtarget / jointtarget literals all decode
  let rts = 0, rtBad = 0, jts = 0, jtBad = 0, unusedAx = 0;
  for (const m of distinct) for (const x of [...m.data, ...m.routines.flatMap(r => r.data)]) {
    if (!x.init?.text.trimStart().startsWith('[')) continue;
    if (/^robtarget$/i.test(x.type)) { const v = robTargetsOf(x); if (v) { rts += v.length; unusedAx += v.reduce((s, t) => s + t.extax.filter(isUnusedAxis).length, 0); } else rtBad++; }
    if (/^jointtarget$/i.test(x.type) && !x.dims) { if (parseJointTarget(x.init.text)) jts++; else jtBad++; }
  }
  check(rtBad === 0 && rts > 1000, `robtarget literals decode: ${rts} ok, ${rtBad} not`);
  check(jtBad === 0 && jts > 10, `jointtarget literals decode: ${jts} ok, ${jtBad} not`);

  // diagnostics: per task folder (with the shared TASK0 modules), and every other plain module alone
  const sev: Record<string, number> = {};
  const errors: string[] = [];
  const tally = (f: string, m: RapidModule, xs: RapidIssue[]) => {
    for (const x of xs) {
      sev[x.severity] = (sev[x.severity] ?? 0) + 1;
      if (x.severity === 'error') errors.push(`${path.relative(root, f)}:${x.span.line + 1} ${x.code} ${x.message} :: ${m.lines[x.span.line]?.trim()}`);
    }
  };
  const inTask = new Set<string>();
  let tasks = 0;
  for (const b of fs.readdirSync(root)) {
    const rapid = path.join(root, b, 'RAPID');
    if (!fs.existsSync(rapid)) continue;
    const names = fs.readdirSync(rapid).filter(t => /^TASK\d+$/i.test(t));
    const filesOf = (t: string) => ['SYSMOD', 'PROGMOD'].flatMap(s => { const dd = path.join(rapid, t, s); return fs.existsSync(dd) ? fs.readdirSync(dd).filter(x => /\.(mod|modx|sys)$/i.test(x)).map(x => path.join(dd, x)) : []; });
    const shared = names.includes('TASK0') ? filesOf('TASK0').map(f => parsed.get(f)!).filter(Boolean) : [];
    for (const t of names) {
      const fl = filesOf(t).filter(f => parsed.has(f));
      tasks++;
      const res = diagnoseTask(fl.map(f => parsed.get(f)!), { shared: t === 'TASK0' ? [] : shared });
      res.forEach((xs, i) => { inTask.add(fl[i]); tally(fl[i], parsed.get(fl[i])!, xs); });
    }
  }
  for (const [f, m] of plain) if (!inTask.has(f)) tally(f, m, diagnoseModule(m));
  check(errors.length === 0, `the corpus produces no error diagnostics (${errors.length}):\n      ${errors.slice(0, 10).join('\n      ')}`);

  const sum = (f: (m: RapidModule) => number) => distinct.reduce((s, m) => s + f(m), 0);
  console.log(`  RAPID corpus: ${files.length} files (${otherName.length} named unlike their module; ${cache.size} distinct, ${cache.size - distinct.length} encrypted, ${bom} with a BOM), ${tasks} task folders; ` +
    `distinct plain modules: ${distinct.length}, routines ${sum(m => m.routines.length)}, data ${sum(m => m.data.length + m.routines.reduce((s, r) => s + r.data.length, 0))}, ` +
    `moves ${sum(m => m.moves.length)}, calls ${sum(m => m.calls.length)}, late-bound ${sum(m => m.calls.filter(c => c.kind === 'late').length)}; ` +
    `robtargets ${rts} (${unusedAx} unused ext axes), jointtargets ${jts}; diagnostics ${JSON.stringify(sev)}`);
}

// ---------------------------------------------------------------------------------------
// The grammar (needs the oniguruma WASM loaded by run.ts)
// ---------------------------------------------------------------------------------------

export async function runGrammar(check: Check, root: string): Promise<void> {
  const file = path.join(root, 'syntaxes', 'rapid.tmLanguage.json');
  const registry = new vsctm.Registry({
    onigLib: Promise.resolve({ createOnigScanner: (s: string[]) => new oniguruma.OnigScanner(s), createOnigString: (s: string) => new oniguruma.OnigString(s) }),
    loadGrammar: async (scope: string) => scope === 'source.rapid' ? vsctm.parseRawGrammar(fs.readFileSync(file, 'utf8'), file) : null,
  });
  const g = await registry.loadGrammar('source.rapid');
  check(!!g, 'RAPID grammar loads');
  if (!g) return;
  let stack = vsctm.INITIAL;
  const lines = FIXTURE.split(/\r?\n/).map(line => {
    const r = g.tokenizeLine(line, stack); stack = r.ruleStack;
    return r.tokens.map(t => ({ text: line.slice(t.startIndex, t.endIndex), scopes: t.scopes }));
  });
  const has = (ln: number, text: string, scope: string) => lines[ln].some(t => t.text.trim() === text && t.scopes.includes(scope));
  const show = (ln: number) => JSON.stringify(lines[ln].map(t => [t.text, t.scopes[t.scopes.length - 1]]));
  check(has(0, 'Fixture', 'entity.name.type.module.rapid') && has(0, 'NOSTEPIN', 'storage.modifier.module-attribute.rapid'), `MODULE line: ${show(0)}`);
  check(lines[1].some(t => t.scopes.includes('comment.line.exclamation.rapid')), 'comment');
  check(has(7, 'CONST', 'storage.type.rapid') && has(7, 'robtarget', 'support.type.rapid') && has(7, 'pHome', 'variable.other.declaration.rapid') && has(7, '9E+09', 'constant.numeric.rapid'), `declaration: ${show(7)}`);
  check(has(14, 'Main', 'entity.name.function.rapid') && has(51, 'Square', 'entity.name.function.rapid') && has(51, 'num', 'support.type.rapid'), 'PROC and FUNC names');
  check(has(16, 'MoveJ', 'support.function.instruction.rapid') && has(16, 'WObj', 'variable.parameter.optional.rapid') && has(16, 'z50', 'constant.language.predefined.rapid'), `MoveJ line: ${show(16)}`);
  check(has(17, 'Offs', 'support.function.builtin.rapid') && has(17, 'fine', 'constant.language.predefined.rapid'), `Offs(...): ${show(17)}`);
  check(has(21, 'IF', 'keyword.control.rapid') && has(21, 'THEN', 'keyword.control.rapid'), 'IF ... THEN');
  check(has(46, 'switch', 'variable.parameter.optional.rapid') && has(46, 'INOUT', 'storage.type.rapid'), `\\switch and INOUT: ${show(46)}`);
  check(has(47, '<SMT>', 'invalid.placeholder.rapid') && has(41, 'lblEnd', 'entity.name.label.rapid'), 'placeholder and label');
  check(lines[26].some(t => t.scopes.includes('string.quoted.double.rapid')) && has(26, '%', 'keyword.operator.late-binding.rapid'), 'late binding and strings');
  check(has(43, 'ERROR', 'keyword.control.handler.rapid'), 'ERROR handler');
}
