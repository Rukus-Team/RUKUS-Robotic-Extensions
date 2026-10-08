/**
 * The machine-readable RAPID reference (packages/abb/src/rapid/reference.json), built from
 * ABB's 3HAC050917 manual by scripts/import-rapid-manual.mjs. `run(check)`.
 *
 * Read with fs rather than imported: the tsconfig has no resolveJsonModule. The file is found
 * by walking up from this file, so the check works from test/ and from a compiled dist/test/.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { RAPID_INSTRUCTIONS } from '@abb/rapid/builtins';

type Check = (cond: unknown, msg: string) => void;

interface RefArg { name: string; type?: string; optional?: boolean; switch?: boolean; alt?: number; desc?: string }
interface RefEntry {
  name: string; kind: 'instruction' | 'function' | 'type'; summary: string; syntax?: string;
  args?: RefArg[]; returns?: string; components?: { name: string; type: string; desc?: string }[]; option?: string;
}
interface Ref { source: string; generated: string; entries: RefEntry[] }

function loadRef(): Ref {
  const rel = path.join('packages', 'abb', 'src', 'rapid', 'reference.json');
  for (let dir = __dirname, i = 0; i < 6; i++, dir = path.dirname(dir)) {
    const file = path.join(dir, rel);
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')) as Ref;
  }
  throw new Error(`${rel} not found above ${__dirname}`);
}

/**
 * Names in RAPID_INSTRUCTIONS that are not in the manual: SpotWare / Servo Tool Control
 * and other option instructions documented in their own application manuals. Reported, not failed.
 */
export let rapidReferenceMisses: string[] = [];

export function run(check: Check): void {
  const ref = loadRef();
  const all = ref.entries;
  const byKind = (k: RefEntry['kind']) => all.filter(e => e.kind === k);
  const find = (name: string, kind?: RefEntry['kind']) => all.find(e => e.name.toLowerCase() === name.toLowerCase() && (!kind || e.kind === kind));

  check(/3HAC050917/.test(ref.source) && /^\d{4}-\d{2}-\d{2}$/.test(ref.generated), `reference: source and generated date (${ref.source}, ${ref.generated})`);
  check(byKind('instruction').length >= 350, `reference: >= 350 instructions (${byKind('instruction').length})`);
  check(byKind('function').length >= 150, `reference: >= 150 functions (${byKind('function').length})`);
  check(byKind('type').length >= 80, `reference: >= 80 data types (${byKind('type').length})`);
  const empty = all.filter(e => !e.summary || !e.summary.trim()).map(e => e.name);
  check(empty.length === 0, `reference: every entry has a summary (empty: ${empty.join(', ')})`);
  const sorted = all.map(e => e.name);
  check(sorted.every((n, i) => i === 0 || sorted[i - 1].localeCompare(n, 'en', { sensitivity: 'base' }) <= 0), 'reference: entries sorted by name');

  /** the required (non-optional) arguments, in order */
  const required = (e: RefEntry | undefined) => (e?.args ?? []).filter(a => !a.optional);
  const argOf = (e: RefEntry | undefined, n: string) => e?.args?.find(a => a.name === n);

  const moveL = find('MoveL', 'instruction');
  check(required(moveL).map(a => `${a.name}:${a.type}`).join(' ') === 'ToPoint:robtarget Speed:speeddata Zone:zonedata Tool:tooldata',
    `reference: MoveL required args ToPoint robtarget, Speed speeddata, Zone zonedata, Tool tooldata (${required(moveL).map(a => `${a.name}:${a.type}`).join(' ')})`);
  const wobj = argOf(moveL, 'WObj');
  check(wobj?.optional === true && wobj.type === 'wobjdata', 'reference: MoveL \\WObj is an optional wobjdata');
  const conc = argOf(moveL, 'Conc');
  check(conc?.optional === true && conc.switch === true, 'reference: MoveL \\Conc is an optional switch');
  const v = argOf(moveL, 'V'), t = argOf(moveL, 'T');
  check(v?.alt !== undefined && v.alt === t?.alt, 'reference: MoveL \\V | \\T share an alternative group');
  check(moveL?.syntax?.startsWith('MoveL [\\Conc] ToPoint'), `reference: MoveL syntax line (${moveL?.syntax})`);

  const firstRequired: [string, string, string][] = [
    ['MoveJ', 'ToPoint', 'robtarget'],
    ['MoveC', 'CirPoint', 'robtarget'],
    ['MoveAbsJ', 'ToJointPos', 'jointtarget'],
    ['TPWrite', 'String', 'string'],
    ['WaitTime', 'Time', 'num'],
    ['SetDO', 'Signal', 'signaldo'],
    ['WaitDI', 'Signal', 'signaldi'],
    ['Add', 'Name', 'num'],
    ['Incr', 'Name', 'num'],
  ];
  for (const [inst, arg, type] of firstRequired) {
    const e = find(inst, 'instruction');
    const a = required(e)[0];
    check(!!e, `reference: ${inst} present`);
    // TPWrite's first argument is `String` in the manual's text but `TPText` in some syntax blocks; the type is what matters there
    const nameOk = inst === 'TPWrite' ? true : a?.name === arg;
    check(nameOk && a?.type === type, `reference: ${inst} first required arg ${arg} ${type} (${a?.name}:${a?.type})`);
  }
  // MoveJ carries the same tail as MoveL
  check(required(find('MoveJ', 'instruction')).map(a => a.type).join(' ') === 'robtarget speeddata zonedata tooldata', 'reference: MoveJ required arg types');

  const fnReturns: [string, string][] = [['Offs', 'robtarget'], ['RelTool', 'robtarget'], ['CRobT', 'robtarget'], ['CJointT', 'jointtarget'], ['Abs', 'num'], ['NumToStr', 'string']];
  for (const [fn, ret] of fnReturns) {
    const e = find(fn, 'function');
    check(e?.returns === ret, `reference: function ${fn} returns ${ret} (${e?.returns})`);
  }
  check(required(find('Offs', 'function')).map(a => `${a.name}:${a.type}`).join(' ') === 'Point:robtarget XOffset:num YOffset:num ZOffset:num', 'reference: Offs (Point XOffset YOffset ZOffset)');
  check(argOf(find('CRobT', 'function'), 'Tool')?.optional === true, 'reference: CRobT \\Tool is optional');

  const robtarget = find('robtarget', 'type');
  check((robtarget?.components ?? []).map(c => `${c.name}:${c.type}`).join(' ') === 'trans:pos rot:orient robconf:confdata extax:extjoint',
    `reference: robtarget components trans rot robconf extax (${(robtarget?.components ?? []).map(c => c.name).join(' ')})`);
  for (const ty of ['tooldata', 'wobjdata', 'speeddata', 'zonedata']) check(!!find(ty, 'type'), `reference: data type ${ty} present`);
  check((find('tooldata', 'type')?.components ?? []).map(c => c.name).join(' ') === 'robhold tframe tload', 'reference: tooldata components robhold tframe tload');

  // Every base-RobotWare instruction the diagnostics know should be in the manual; the misses
  // (SpotWare, Servo Tool calibration helpers, other option instructions) are reported only.
  const have = new Set(byKind('instruction').map(e => e.name.toUpperCase()));
  rapidReferenceMisses = [...RAPID_INSTRUCTIONS].filter(n => !have.has(n)).sort();
  if (rapidReferenceMisses.length) console.log(`  note: RAPID_INSTRUCTIONS not in the 3HAC050917 reference (option/SpotWare instructions): ${rapidReferenceMisses.join(', ')}`);
  const baseMustHave = ['MOVEL', 'MOVEJ', 'MOVEC', 'MOVEABSJ', 'SEARCHL', 'TRIGGL', 'SETDO', 'WAITDI', 'WAITTIME', 'TPWRITE', 'ACCSET', 'CONFL', 'OPEN', 'CLOSE', 'SOCKETCREATE', 'ISIGNALDI', 'ITIMER'];
  const baseMissing = baseMustHave.filter(n => RAPID_INSTRUCTIONS.has(n) && !have.has(n));
  check(baseMissing.length === 0, `reference: core base-RobotWare instructions present (${baseMissing.join(', ')})`);
}
