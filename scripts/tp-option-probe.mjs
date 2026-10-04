// Probe a real (or ROBOGUIDE) controller with every line in data/tp-syntax.json: each candidate
// line is pushed as its own one-line .LS, so the controller's compiler says yes or no to that
// line alone; an accepted line is read back to get the controller's own spelling, then deleted.
//
//   node scripts/tp-option-probe.mjs --dry [outDir]           write the programs, push nothing
//   node scripts/tp-option-probe.mjs <host> [--only J512,J670] [--family tracking] [--limit n]
//                                           [--from n] [--to n]     (1-based probe line numbers)
//
// Results go to probe-results/<host>.json and .md (accepted / rejected / changed spelling); a
// --from/--to run writes <host>.lines-<from>-<to>.*. Every line is also saved as it completes to
// <host>.partial.json, so a run that dies keeps what it had. A controller that stops answering
// (curl timeout) is "no-response", not a rejection; five in a row end the run - on 2026-10-03 both
// ROBOGUIDE controllers stopped taking programs after ~840 lines and every later line read as a
// syntax error.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = n => { const i = args.indexOf(n); return i < 0 ? undefined : args.splice(i, 2)[1]; };
const only = flag('--only')?.split(',').map(s => s.trim().toUpperCase());
const family = flag('--family');
const limit = Number(flag('--limit') ?? Infinity);
const from = Number(flag('--from') ?? 1);
const to = Number(flag('--to') ?? Infinity);
// --skip-seen a.json,b.json: do not send a line that an earlier run already answered (re-test
// only what a catalog or probe fix changed)
const seen = new Set((flag('--skip-seen') ?? '').split(',').filter(Boolean)
  .flatMap(f => JSON.parse(fs.readFileSync(f, 'utf8')).filter(r => r.verdict !== 'no-response' && r.verdict !== 'not-probed').map(r => r.line)));
const ranged = from > 1 || to < Infinity || seen.size > 0;
const dry = args[0] === '--dry';
const host = dry ? undefined : args[0];
if (!dry && !host) { console.error('usage: tp-option-probe.mjs <host> | --dry [outDir]'); process.exit(2); }

const catalog = JSON.parse(fs.readFileSync(path.join(root, 'data', 'tp-syntax.json'), 'utf8'));
const items = (Array.isArray(catalog) ? catalog : catalog.items)
  .filter(i => !only || (i.option?.code && only.some(c => i.option.code.toUpperCase().includes(c))))
  .filter(i => !family || i.family === family);

// ---- turn a catalog form/example into one concrete program line
const MOTION = /^(J|L|C|A|S)\s+P\[/;
function concrete(s) {
  return s.trim()
    .replace(/^\s*\d+\s*[:.]\s*/, '').replace(/^\d+\s+(?=[A-Za-z!])/, '').replace(/\s*;\s*$/, '')  // manual line numbers
    .replace(/<[^>]*>/g, '1')                      // <schedule> -> 1
    .replace(/\[\s*([a-z])\s*\]/g, '[1]')          // [n] -> [1]
    .replace(/\[([a-z]),([a-z])\]/g, '[1,1]')
    .replace(/\[([a-z]):([a-z])\]/g, '[1:1]')
    .replace(/\b([RP]R?|DI|DO|AR|VR|PL|LBL|RPM|SR)\[([a-z])\]/gi, '$1[1]')
    .replace(/\b([a-z])%/g, '50%')
    .replace(/\bP\[\s*\]/g, 'P[1]')                // "J P[] 100% FINE" in a manual table
    .replace(/^P\[/, 'L P[')                       // a motion line printed without its type
    .replace(/^1\s+(?=[A-Za-z!])/, '');            // a <line> placeholder in front
}
const usable = s => s && !/\.\.\.|…|\s\/\s|\(.*\bor\b.*\)/.test(s) && s.length < 200 && !/^\(/.test(s) && !/^:/.test(s)
  && !/(^|[^A-Za-z0-9_\]])1\[/.test(s)          // a <FUNC>/<name> placeholder that became "1[" - not a line
  && !/^\d/.test(s) && !/^(MOD|DIV)\b/i.test(s)  // "<lhs>=(<expr>)" -> "1=(1)"; "<v> MOD <v>" -> "MOD 1"
  && !/^C\s+P\[[^\]]*\][^:]*$/.test(s);          // a circular move needs its second point: on the next line
// Quoted-label arguments - CALL PKCSGETPOSCK("CStn ID"=R[110:Pk1x StnId],...) - are never sent.
// Loading that line on 2026-10-03 left the controller's loader broken and the NEXT load crashed
// tpmain (OS-144 System error C0000005, NTOS-020) on two V9.40 ROBOGUIDE controllers; each needed a
// restart. They are listed in the report as not probed instead.
const CRASHES_LOADER = s => /"[^"]*"\s*=/.test(s);
// Unquoted labelled arguments - CALL PKCSGETID('CONV1',CStn ID Reg=11) - did the same on the second
// run (line 918 -> 919). They keep their line numbers (so --from still lines up) but are not sent.
const LABELLED_ARGS = s => /\([^()]*\b[A-Za-z][A-Za-z0-9_#.]*(\s+[A-Za-z0-9_#.()\[\]-]+)+\s*=/.test(s) && /^CALL\b/i.test(s);
// ...and then plain CALL PKCSGETID(1,1) crashed a freshly restarted .3 by itself, as CALL
// PKCSGETPOSCK(1,1,1) had on the first run: the iRPickTool (PK*/PT*) program calls are the
// hazard, however the arguments are written. None of them is sent.
const IRPICK_CALL = s => /^CALL\s+P[KT][A-Z0-9_]*\b/i.test(s);
const NOT_SENT = s => LABELLED_ARGS(s) || IRPICK_CALL(s);

function linesFor(item) {
  const raw = [...(item.examples ?? []), ...(item.forms ?? [])].map(concrete).filter(usable);
  const out = [];
  for (let l of raw) {
    if (item.kind === 'motion-option' && !MOTION.test(l)) l = `L P[1] 100mm/sec FINE ${l}`;
    // a function is only legal inside a mixed-logic expression: R[1]=(ABS[R[1]]), not R[1]=ABS[R[1]].
    // An IF/WAIT form is already a statement.
    else if (item.kind === 'function' && !/=/.test(l) && !/^(IF|WAIT|SELECT)\b/i.test(l)) l = `R[1]=(${l})`;
    else if (item.kind === 'operand') continue;    // covered by the instructions that use them
    if (!out.includes(l)) out.push(l);
    if (out.length >= 3) break;
  }
  return out;
}

const pos = n => [`P[${n}]{`, '   GP1:', '\tUF : 0, UT : 1,\t\tCONFIG : \'N U T, 0, 0, 0\',',
  `\tX =   ${500 + 10 * n}.000  mm,\tY =     0.000  mm,\tZ =   500.000  mm,`,
  '\tW =   180.000 deg,\tP =     0.000 deg,\tR =     0.000 deg', '};'];
function program(name, line) {
  // a case may span several lines (--lines): each is numbered, a line starting with ':' continues the one before
  const body = line.split('\n');
  let num = 0;
  const mn = body.map(l => l.startsWith(':') ? `    :  ${l.slice(1).trim()} ;` : `${String(++num).padStart(4)}:  ${l} ;`);
  const ps =[...new Set([...line.matchAll(/\bP\[(\d+)/g)].map(m => Number(m[1])))].sort((a, b) => a - b);
  const POS = ps.flatMap(pos);
  const usesP = ps.length > 0;
  return ['/PROG  ' + name, '/ATTR', 'OWNER\t\t= MNEDITOR;', 'COMMENT\t\t= "option probe";', 'PROG_SIZE\t= 0;',
    'CREATE\t\t= DATE 26-10-02  TIME 12:00:00;', 'MODIFIED\t= DATE 26-10-02  TIME 12:00:00;', 'FILE_NAME\t= ;', 'VERSION\t\t= 0;',
    `LINE_COUNT\t= ${num};`, 'MEMORY_SIZE\t= 0;', 'PROTECT\t\t= READ_WRITE;',
    'TCD:  STACK_SIZE\t= 0,', '      TASK_PRIORITY\t= 50,', '      TIME_SLICE\t= 0,', '      BUSY_LAMP_OFF\t= 0,', '      ABORT_REQUEST\t= 0,', '      PAUSE_REQUEST\t= 0;',
    'DEFAULT_GROUP\t= 1,*,*,*,*;', 'CONTROL_CODE\t= 00000000 00000000;', '/MN', ...mn, '/POS', ...(usesP ? POS : []), '/END', ''].join('\r\n');
}

const cases = [];
const unsafe = [];
// --lines <file>: hand-written cases instead of the catalog - separated by '---' lines, '#' comments,
// a case can be several program lines (':' continues the line before); an optional first line
// "id: <catalog id>" ties the case to a catalog item for tp-probe-verdicts
const linesFile = flag('--lines');
if (linesFile) {
  for (const block of fs.readFileSync(linesFile, 'utf8').split(/^---\s*$/m)) {
    const ls = block.split(/\r?\n/).map(l => l.trimEnd()).filter(l => l.trim() && !/^\s*#/.test(l));
    if (!ls.length) continue;
    const id = /^id:\s*(.+)$/.exec(ls[0])?.[1];
    const line = (id ? ls.slice(1) : ls).join('\n');
    (CRASHES_LOADER(line) ? unsafe : cases).push({ id: id ?? 'adhoc', option: null, confidence: 'test', line });
  }
} else for (const item of items) for (const line of linesFor(item)) (CRASHES_LOADER(line) ? unsafe : cases).push({ id: item.id, option: item.option ?? null, confidence: item.confidence, line });
cases.forEach((c, i) => { c.n = i + 1; });          // probe line number, for --from/--to re-runs
const run = cases.slice(from - 1, Math.min(to, cases.length)).filter(c => !seen.has(c.line)).slice(0, limit);
console.log(`${items.length} catalog items -> ${cases.length} probe lines${run.length < cases.length ? ` (running ${run.length})` : ''}; ${unsafe.length} quoted-label lines not sent (they crash the loader)`);

if (dry) {
  const out = path.resolve(args[1] ?? path.join(root, 'probe-results', 'dry'));
  fs.mkdirSync(out, { recursive: true });
  run.forEach((c, i) => fs.writeFileSync(path.join(out, `RCOP${String(i).padStart(4, '0')}.LS`), program(`RCOP${String(i).padStart(4, '0')}`, c.line), 'latin1'));
  fs.writeFileSync(path.join(out, 'index.json'), JSON.stringify(run.map((c, i) => ({ file: `RCOP${String(i).padStart(4, '0')}.LS`, ...c })), null, 1));
  console.log(`wrote ${run.length} programs to ${out}`);
  process.exit(0);
}

// ---- push, read back, delete (curl, the same way the live smoke test does)
const ftp = `ftp://${host}/md:/`;
const curl = (a, input) => execFileSync('curl', ['-s', '-S', '-m', '30', ...a], { input, encoding: 'latin1', stdio: ['pipe', 'pipe', 'pipe'] });
const del = name => { for (const f of [`${name}.ls`, `${name}.tp`]) { try { curl([ftp, '-Q', `DELE ${f}`, '-o', process.platform === 'win32' ? 'NUL' : '/dev/null']); } catch { /* not there */ } } };
// the /MN body as sent: numbered lines without their numbers, continuation lines as ':...', joined by newlines
const bodyLine = text => {
  const ls = text.split(/\r?\n/), a = ls.findIndex(l => /^\/MN/.test(l)), b = ls.findIndex(l => /^\/POS/.test(l));
  return ls.slice(a + 1, b < 0 ? undefined : b).filter(l => l.trim())
    .map(l => /^\s*\d+:/.test(l) ? l.replace(/^\s*\d+:\s*/, '') : ':' + l.replace(/^\s*:\s*/, ''))
    .map(l => l.replace(/\s*;\s*$/, '')).join('\n');
};
const norm = s => s.replace(/\s+/g, ' ').replace(/\[(\d+):[^\]]*\]/g, '[$1]').trim().toUpperCase();

// A failed load leaves ASBN-002/008/009 at the top of ERRALL.LS (newest first); 009 carries the
// cause. SCIO-016 "un-installed option" means the compiler knew the word - only the option is missing.
function why() {
  try {
    const top = curl([`${ftp}errall.ls`]).split(/\r?\n/).filter(l => /^\s*\d+"/.test(l)).slice(0, 3);
    const at = top.find(l => /ASBN-009/.test(l)) ?? top[0] ?? '';
    const cols = at.split('"').map(s => s.trim());
    const cause = (cols.find(s => /^[A-Z]{3,4}-\d{3}/.test(s) && !/^ASBN-00[289]/.test(s)) ?? '').replace(/\s+/g, ' ');
    const where = (cols.find(s => /^ASBN-009/.test(s)) ?? '').replace(/^ASBN-009\s*/, '');
    return { cause, where };
  } catch { return { cause: '', where: '' }; }
}
const verdict = cause => /un-installed option/i.test(cause) ? 'option-missing' : 'syntax';

const NAME = 'RCOPROBE';
function probe(line) {
  try {
    curl(['-T', '-', `${ftp}${NAME}.LS`], Buffer.from(program(NAME, line), 'latin1'));
    const back = bodyLine(curl([`${ftp}${NAME}.LS`]));
    return { ok: true, controller: back, changed: norm(back) !== norm(line) };
  } catch (e) {
    const error = String(e.stderr || e.message).trim().split(/\r?\n/).pop();
    // curl exit 28 = timed out: the controller did not answer, which says nothing about the line
    if (e.status === 28) return { ok: false, verdict: 'no-response', cause: '', where: '', error };
    const { cause, where } = why();
    return { ok: false, verdict: verdict(cause), cause, where, error };
  } finally { del(NAME); }
}

// control: a line every controller takes, or nothing below means anything
const control = probe('R[1]=1');
if (!control.ok) { console.error(`control line R[1]=1 was rejected (${control.cause || control.error}); is ${host} reachable and in AUTO/T1 with no program selected?`); process.exit(1); }

const outDir = path.join(root, 'probe-results');
fs.mkdirSync(outDir, { recursive: true });
const tag = host.replace(/[^\w.-]/g, '_') + (linesFile ? '.' + path.basename(linesFile).replace(/\.[^.]*$/, '') : seen.size ? '.retest' : ranged ? `.lines-${from}-${Math.min(to, cases.length)}` : '');

const results = [];
let n = 0, silent = 0;
for (const c of run) {
  n++;
  const r = NOT_SENT(c.line) ? { ...c, ok: false, verdict: 'not-probed' } : { ...c, ...probe(c.line) };
  results.push(r);
  fs.writeFileSync(path.join(outDir, `${tag}.partial.json`), JSON.stringify(results, null, 1));
  const k = v => results.filter(v).length;
  process.stdout.write(`\r${n}/${run.length} (line ${c.n})  ok ${k(x => x.ok)}  option missing ${k(x => x.verdict === 'option-missing')}  syntax ${k(x => x.verdict === 'syntax')}  no response ${k(x => x.verdict === 'no-response')}   `);
  silent = r.verdict === 'no-response' ? silent + 1 : 0;
  if (silent >= 5) {
    console.error(`\n${host} stopped answering at probe line ${c.n - 4}; stopping. Fix the controller, then re-run with --from ${c.n - 4}.`);
    results.splice(results.length - silent, silent);     // the silent lines prove nothing either way
    break;
  }
}
console.log();
fs.writeFileSync(path.join(outDir, `${tag}.json`), JSON.stringify(results, null, 1));
const opt = r => r.option ? `${r.option.code ?? '-'} ${r.option.name}` : '(base)';
const count = v => results.filter(v).length;
const md = [`# TP option probe: ${host}`, '',
  `${results.length} lines${ranged ? ` (probe lines ${from}-${Math.min(to, cases.length)})` : ''}: ${count(r => r.ok)} accepted, ${count(r => r.verdict === 'option-missing')} recognised but option not installed, ${count(r => r.verdict === 'syntax')} rejected as written, ${count(r => r.verdict === 'no-response')} no response.`, '',
  '## Rejected as written (spelling or operands wrong, or not on this software)', '', '| Option | Conf. | Line | Where | Cause |', '|---|---|---|---|---|',
  ...results.filter(r => r.verdict === 'syntax').map(r => `| ${opt(r)} | ${r.confidence} | \`${r.line}\` | ${r.where} | ${r.cause || r.error} |`), '',
  '## Accepted, controller spells it differently', '', '| Option | Sent | Controller |', '|---|---|---|',
  ...results.filter(r => r.ok && r.changed).map(r => `| ${opt(r)} | \`${r.line}\` | \`${r.controller}\` |`), '',
  '## Recognised, option not installed here', '', ...results.filter(r => r.verdict === 'option-missing').map(r => `- ${opt(r)}: \`${r.line}\``), '',
  '## Accepted as written', '', ...results.filter(r => r.ok && !r.changed).map(r => `- ${opt(r)}: \`${r.line}\``), '',
  '## No response (the controller did not answer - re-run these lines)', '', ...results.filter(r => r.verdict === 'no-response').map(r => `- line ${r.n}: \`${r.line}\``), '',
  '## Not probed: labelled arguments and PK*/PT* program calls (they crashed the controller\'s loader on 2026-10-03)', '', ...[...unsafe, ...results.filter(r => r.verdict === 'not-probed')].map(r => `- ${opt(r)}: \`${r.line}\``), ''].join('\n');
fs.writeFileSync(path.join(outDir, `${tag}.md`), md);
console.log(`results: probe-results/${tag}.md`);
