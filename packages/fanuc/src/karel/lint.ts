/**
 * KAREL lint: what ktrans will refuse, and what it lets through that then goes wrong on
 * the robot (beta list 2, item 10). Pure - no vscode - so it runs over the whole corpus in
 * the unit tests, where the rule is "no finding on a program a real controller ran".
 *
 * The rules follow the KAREL Reference Manual and ONE Robotics' "FANUC KAREL Programming:
 * An Introduction": PROGRAM first and END with the same name (the parser reports those),
 * declarations before BEGIN, directives before declarations, name lengths by core version
 * (identifierLengthIssues), and the %NOLOCKGROUP / motion rule - a program that moves the robot
 * needs its motion group, a program that does not should say %NOLOCKGROUP so it runs
 * without locking one (and from a browser, a condition handler or alongside TP).
 *
 * Each finding carries a code (`karel.lint.<rule>`) so one rule can be switched off.
 */
import { stripCommentAndStrings, type KProgram, type KDiagnostic } from './parser';

export const LINT_CODES = {
  cStyle: 'karel.lint.cStyle',
  declAfterBegin: 'karel.lint.declAfterBegin',
  directivePlacement: 'karel.lint.directivePlacement',
  commentLength: 'karel.lint.commentLength',
  stringLength: 'karel.lint.stringLength',
  integerRange: 'karel.lint.integerRange',
  reservedName: 'karel.lint.reservedName',
  duplicate: 'karel.lint.duplicate',
  assignConst: 'karel.lint.assignConst',
  argCount: 'karel.lint.argCount',
  returnValue: 'karel.lint.returnValue',
  lockGroup: 'karel.lint.lockGroup',
  noBegin: 'karel.lint.noBegin',
  elseif: 'karel.lint.elseif',
} as const;

/** the largest STRING a KAREL variable holds, and the largest INTEGER */
export const KAREL_STRING_MAX = 254;
export const KAREL_COMMENT_MAX = 16;
export const KAREL_INT_MAX = 2147483647;

const MOTION = /\b(MOVE\s+(TO|NEAR|ALONG|AWAY|ABOUT|AXIS|RELATIVE)|MOVE\b)/i;

/**
 * KAREL's reserved words proper (KAREL Reference Manual, appendix "Reserved words") -
 * the parser's keyword set is wider on purpose (port names, TPDISPLAY, ON/OFF/TRUE/FALSE,
 * MAXINT) because it colours and completes them, but those are PREDEFINED IDENTIFIERS a
 * program may redefine: a corpus program that a controller ran declares `DIN = 1`,
 * `ON = 1` and `OFF = 0` as constants. Only a word in this set is refused as a name.
 */
const RESERVED = new Set(['ABORT', 'ABOUT', 'AFTER', 'ALONG', 'ALSO', 'AND', 'ARRAY', 'AT', 'ATTACH', 'AWAY', 'AXIS', 'BEFORE', 'BEGIN', 'BOOLEAN', 'BY', 'BYNAME', 'BYTE', 'CAM_SETUP', 'CANCEL', 'CASE', 'CLOSE', 'CMOS', 'COMMAND', 'CONDITION', 'CONFIG', 'CONNECT', 'CONST', 'CONTINUE', 'COORDINATED', 'CR', 'DELAY', 'DISABLE', 'DISCONNECT', 'DIV', 'DO', 'DOWNTO', 'DRAM', 'ELSE', 'ENABLE', 'END', 'ENDCONDITION', 'ENDFOR', 'ENDIF', 'ENDMOVE', 'ENDSELECT', 'ENDSTRUCTURE', 'ENDUSING', 'ENDWHILE', 'ERROR', 'EVAL', 'EVENT', 'FILE', 'FOR', 'FROM', 'GO', 'GOTO', 'GROUP', 'GROUP_ASSOC', 'HAND', 'HOLD', 'IF', 'IN', 'INDEPENDENT', 'INTEGER', 'JOINTPOS', 'JOINTPOS1', 'JOINTPOS2', 'JOINTPOS3', 'JOINTPOS4', 'JOINTPOS5', 'JOINTPOS6', 'JOINTPOS7', 'JOINTPOS8', 'JOINTPOS9', 'MOD', 'MODEL', 'MOVE', 'NEAR', 'NOABORT', 'NODEDATA', 'NOMESSAGE', 'NOPAUSE', 'NOT', 'NOWAIT', 'OF', 'OPEN', 'OR', 'PATH', 'PATHHEADER', 'PAUSE', 'POSITION', 'POWERUP', 'PROGRAM', 'PULSE', 'PURGE', 'READ', 'REAL', 'RELATIVE', 'RELAX', 'RELEASE', 'REPEAT', 'RESTORE', 'RESUME', 'RETURN', 'ROUTINE', 'SELECT', 'SEMAPHORE', 'SHORT', 'SIGNAL', 'STOP', 'STRING', 'STRUCTURE', 'THEN', 'TIME', 'TIMER', 'TO', 'TPENABLE', 'TYPE', 'UNHOLD', 'UNINIT', 'UNPAUSE', 'UNTIL', 'USING', 'VAR', 'VECTOR', 'VIA', 'VIS_PROCESS', 'WAIT', 'WHEN', 'WHILE', 'WITH', 'WRITE', 'XYZWPR', 'XYZWPREXT']);

export function lintKarel(prog: KProgram): KDiagnostic[] {
  const out: KDiagnostic[] = [];
  if (!prog.name) return out;   // an include fragment or a binary under a .kl name: not a program to judge
  const lines = prog.lines;
  const clean = lines.map(stripCommentAndStrings);
  const push = (code: string, severity: KDiagnostic['severity'], line: number, col: number, len: number, message: string) => out.push({ code, severity, span: { line, col: Math.max(0, col), len: Math.max(1, len) }, message });

  // ---- where things are: declarations, routine bodies, the main body ----
  const routineLines = new Set<number>();
  for (const r of prog.routines) if (r.endLine !== undefined) for (let i = r.line; i <= r.endLine; i++) routineLines.add(i);
  const mainBegin = prog.mainBegin;
  const inMain = (i: number) => mainBegin !== undefined && i > mainBegin && (prog.mainEnd === undefined || i < prog.mainEnd);
  const inAnyBody = (i: number) => inMain(i) || [...prog.routines].some(r => r.endLine !== undefined && i > r.line && i <= r.endLine && clean.slice(r.line, i).some(l => /^\s*BEGIN\b/i.test(l)));

  // ---- 1. C-isms: what someone coming from C or ST writes, that ktrans refuses ----
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    if (/^\s*%/.test(c)) continue;
    for (const m of c.matchAll(/==|!=|&&|\|\||:=|\+\+|--\s*$|\/\/|\bELSE\s*IF\b|\bELSEIF\b|\bELIF\b/gi)) {
      const t = m[0].trim();
      if (t === '--') continue;   // a comment marker survives stripping only as the cut point; never here
      const fix = t === '==' ? '=' : t === '!=' ? '<>' : t === '&&' ? 'AND' : t === '||' ? 'OR' : t === ':=' ? '=' : t === '++' ? 'x = x + 1' : t === '//' ? '-- for a comment' : 'ELSE ... IF ... ENDIF ENDIF (KAREL has no ELSEIF)';
      if (/^ELSE\s*IF$/i.test(t)) push(LINT_CODES.elseif, 'error', i, m.index!, m[0].length, `KAREL has no ELSE IF: nest it - ELSE, then IF ... ENDIF, then the outer ENDIF.`);
      else if (/^(ELSEIF|ELIF)$/i.test(t)) push(LINT_CODES.elseif, 'error', i, m.index!, m[0].length, `KAREL has no ${t.toUpperCase()}: nest it - ELSE, then IF ... ENDIF, then the outer ENDIF.`);
      else push(LINT_CODES.cStyle, 'error', i, m.index!, m[0].length, `"${t}" is not KAREL; write ${fix}.`);
    }
  }

  // ---- 2. declarations after BEGIN, directives after declarations ----
  let firstDecl: number | undefined;
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    if (/^\s*(CONST|TYPE|VAR)\b/i.test(c) && firstDecl === undefined && !routineLines.has(i)) firstDecl = i;
    if (/^\s*(CONST|TYPE|VAR)\b/i.test(c) && inMain(i)) push(LINT_CODES.declAfterBegin, 'error', i, ...pos(c, /(CONST|TYPE|VAR)/i), `${/(CONST|TYPE|VAR)/i.exec(c)![1].toUpperCase()} after BEGIN: declarations go between PROGRAM and BEGIN (or before a routine's BEGIN).`);
    if (/^\s*ROUTINE\b/i.test(c) && inMain(i)) push(LINT_CODES.declAfterBegin, 'error', i, ...pos(c, /ROUTINE/i), 'A ROUTINE cannot be declared inside the program body; put it before BEGIN or after END.');
  }
  for (const d of prog.directives) {
    const name = d.name.toUpperCase();
    if (name === 'INCLUDE') continue;   // %INCLUDE may sit among declarations
    if (inAnyBody(d.line)) push(LINT_CODES.directivePlacement, 'error', d.line, d.span.col, d.span.len, `%${d.name} inside a body: translator directives go right after the PROGRAM line, before any declaration.`);
    else if (firstDecl !== undefined && d.line > firstDecl) push(LINT_CODES.directivePlacement, 'warning', d.line, d.span.col, d.span.len, `%${d.name} after the first declaration: ktrans wants directives right after PROGRAM, before CONST/TYPE/VAR.`);
    if (name === 'COMMENT') {
      const v = /=\s*'([^']*)'/.exec(d.args)?.[1];
      // ktrans takes a longer one (the corpus has 19); the pendant shows the first 16
      if (v !== undefined && v.length > KAREL_COMMENT_MAX) push(LINT_CODES.commentLength, 'warning', d.line, d.span.col, d.span.len + d.args.length + 1, `%COMMENT is ${v.length} characters; the pendant shows the first ${KAREL_COMMENT_MAX}.`);
    }
  }

  // ---- 3. literals: strings past 254, integers past 32 bits, STRING[n] past 254 ----
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (/^\s*--/.test(raw)) continue;
    for (const m of raw.matchAll(/'((?:[^']|'')*)'/g)) {
      if (m[1].length > KAREL_STRING_MAX) push(LINT_CODES.stringLength, 'error', i, m.index!, m[0].length, `String literal is ${m[1].length} characters; a KAREL STRING holds at most ${KAREL_STRING_MAX}.`);
    }
    const c = clean[i];
    for (const m of c.matchAll(/\bSTRING\s*\[\s*(\d+)\s*\]/gi)) {
      const n = parseInt(m[1], 10);
      if (n > KAREL_STRING_MAX || n < 1) push(LINT_CODES.stringLength, 'error', i, m.index!, m[0].length, `STRING[${n}]: the length must be 1 to ${KAREL_STRING_MAX}.`);
    }
    for (const m of c.matchAll(/(?<![\w.])(\d{10,})(?![\w.])/g)) {
      if (Number(m[1]) > KAREL_INT_MAX) push(LINT_CODES.integerRange, 'error', i, m.index!, m[0].length, `${m[1]} does not fit a KAREL INTEGER (largest is ${KAREL_INT_MAX}).`);
    }
  }

  // ---- 4. names: reserved words as identifiers, duplicates in one scope ----
  const seen = new Map<string, number>();
  for (const s of prog.symbols) {
    if (s.kind === 'routine' || s.kind === 'program') continue;   // routines are judged from prog.routines below
    if (RESERVED.has(s.upper) && s.kind !== 'field') push(LINT_CODES.reservedName, 'error', s.span.line, s.span.col, s.span.len, `"${s.name}" is a KAREL reserved word and cannot be a ${s.kind} name.`);
    if (s.kind === 'field') continue;
    const key = `${s.scope ?? ''}|${s.upper}`;
    const prev = seen.get(key);
    if (prev !== undefined) push(LINT_CODES.duplicate, 'error', s.span.line, s.span.col, s.span.len, `"${s.name}" is declared twice in the same scope (first on line ${prev + 1}).`);
    else seen.set(key, s.line);
  }
  for (const r of prog.routines) {
    if (r.from) continue;
    if (RESERVED.has(r.upper)) push(LINT_CODES.reservedName, 'error', r.span.line, r.span.col, r.span.len, `"${r.name}" is a KAREL reserved word and cannot be a routine name.`);
    const key = `|${r.upper}`;
    const prev = seen.get(key);
    if (prev !== undefined) push(LINT_CODES.duplicate, 'error', r.span.line, r.span.col, r.span.len, `"${r.name}" is declared twice (first on line ${prev + 1}).`);
    else seen.set(key, r.line);
  }

  // ---- 5. assignment to a constant ----
  const consts = new Map(prog.symbols.filter(s => s.kind === 'constant').map(s => [s.upper, s]));
  if (consts.size) {
    for (let i = 0; i < clean.length; i++) {
      if (!inAnyBody(i)) continue;
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(?!=)/.exec(clean[i]);
      if (m && consts.has(m[1].toUpperCase()) && !/^\s*(IF|WHILE|UNTIL|WHEN|ELSE|FOR)\b/i.test(clean[i])) push(LINT_CODES.assignConst, 'error', i, m.index + clean[i].indexOf(m[1]), m[1].length, `"${m[1]}" is a constant; it cannot be assigned.`);
    }
  }

  // ---- 6. calls to routines declared here, with the wrong number of arguments ----
  // Only a declaration that is complete on its own line is trusted: `ROUTINE x(a : INTEGER)`.
  // A bare `ROUTINE x` may carry its parameters in a way the parser did not see (the corpus
  // has `ROUTINE x --(a; b : INTEGER)` and lists split over lines), and an external
  // `FROM prog` declaration is only a copy of the truth - the providing program has it.
  const complete = (r: typeof prog.routines[number]) => !r.from && /\(/.test(clean[r.line] ?? '') && /\)/.test(clean[r.line] ?? '');
  const routines = new Map(prog.routines.filter(r => r.params !== undefined && complete(r)).map(r => [r.upper, r]));
  if (routines.size) {
    for (let i = 0; i < clean.length; i++) {
      if (!inAnyBody(i)) continue;
      const c = clean[i];
      for (const m of c.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
        const r = routines.get(m[1].toUpperCase());
        if (!r || r.line === i) continue;
        const args = countArgs(c, m.index! + m[0].length);
        if (args === undefined) continue;   // runs past the line: not judged
        const want = r.params!.length;
        if (args !== want) push(LINT_CODES.argCount, 'error', i, m.index!, m[1].length, `${r.name} takes ${want} argument${want === 1 ? '' : 's'} (line ${r.line + 1}); ${args} given.`);
      }
      // a call with no parentheses to a routine that takes parameters
      const bare = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(c);
      if (bare) { const r = routines.get(bare[1].toUpperCase()); if (r && r.params!.length && r.line !== i) push(LINT_CODES.argCount, 'error', i, c.indexOf(bare[1]), bare[1].length, `${r.name} takes ${r.params!.length} argument${r.params!.length === 1 ? '' : 's'} (line ${r.line + 1}); none given.`); }
    }
  }

  // ---- 7. functions return a value, procedures do not ----
  // The "procedure returns a value" half needs the declaration to be complete on its line
  // (see above); a function's return type is read wherever the declaration says it.
  for (const r of prog.routines) {
    if (r.from || r.endLine === undefined) continue;
    const body = clean.slice(r.line + 1, r.endLine);
    const returns = body.map((l, k) => ({ l, k })).filter(x => /^\s*RETURN\b/i.test(x.l));
    if (r.returnType) {
      if (!returns.some(x => /^\s*RETURN\s*\(/i.test(x.l))) push(LINT_CODES.returnValue, 'warning', r.span.line, r.span.col, r.span.len, `${r.name} returns ${r.returnType} but has no RETURN(value); the caller gets an uninitialized value.`);
      for (const x of returns) if (!/^\s*RETURN\s*\(/i.test(x.l)) push(LINT_CODES.returnValue, 'error', r.line + 1 + x.k, ...pos(x.l, /RETURN/i), `${r.name} returns ${r.returnType}: RETURN needs a value here, RETURN(...).`);
    } else if (complete(r)) {
      for (const x of returns) if (/^\s*RETURN\s*\(/i.test(x.l)) push(LINT_CODES.returnValue, 'error', r.line + 1 + x.k, ...pos(x.l, /RETURN/i), `${r.name} is a procedure (no return type): RETURN takes no value.`);
    }
  }

  // ---- 8. motion and the group lock ----
  const noLock = prog.directives.some(d => /^NOLOCKGROUP$/i.test(d.name));
  const lockGroup = prog.directives.some(d => /^LOCKGROUP$/i.test(d.name));
  const motionLine = clean.findIndex((c, i) => inAnyBody(i) && MOTION.test(c) && !/^\s*(ENDMOVE|--)/i.test(c));
  if (noLock && motionLine >= 0) push(LINT_CODES.lockGroup, 'error', motionLine, ...pos(clean[motionLine], /MOVE/i), 'MOVE with %NOLOCKGROUP: a program that moves the robot must own its motion group. Remove %NOLOCKGROUP (or use %LOCKGROUP = 1).');
  if (!noLock && !lockGroup && motionLine < 0 && prog.nameSpan) push(LINT_CODES.lockGroup, 'hint', prog.nameSpan.line, prog.nameSpan.col, prog.nameSpan.len, 'No motion here: add %NOLOCKGROUP so the program runs without taking the motion group (needed to run from a browser, a condition handler, or beside a TP program).');

  // ---- 9. a program with declarations and no body ----
  if (prog.mainBegin === undefined && prog.nameSpan && !prog.includes.length && !clean.some(l => /^\s*BEGIN\b/i.test(l))) push(LINT_CODES.noBegin, 'error', prog.nameSpan.line, prog.nameSpan.col, prog.nameSpan.len, `${prog.name} has no BEGIN ... END body.`);

  return out.sort((a, b) => a.span.line - b.span.line || a.span.col - b.span.col);
}

function pos(line: string, re: RegExp): [number, number] {
  const m = re.exec(line);
  return m ? [m.index, m[0].length] : [0, Math.max(1, line.trim().length)];
}

/**
 * Arguments between the `(` at `from` and its `)`, counted at the top level - an argument
 * that is itself a call, an index or a string with commas counts once. `undefined` when
 * the `)` is not on this line (a call written over several lines is not judged).
 */
export function countArgs(clean: string, from: number): number | undefined {
  let depth = 0, args = 0, any = false;
  for (let i = from; i < clean.length; i++) {
    const ch = clean[i];
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ']') depth--;
    else if (ch === ')') { if (depth === 0) return any ? args + 1 : 0; depth--; }
    else if (ch === ',' && depth === 0) { args++; any = true; }
    else if (!/\s/.test(ch)) any = true;
  }
  return undefined;
}

/**
 * How long a name ktrans accepts, by controller core version - measured on the WinOLPC
 * ktrans of each version (2026-10-03), not taken from the manual:
 *   V6.40          every identifier 12
 *   V7.70 / V8.30  variables and routines 36, but the PROGRAM name still 12
 *   V9.x           everything 36
 * One fixed limit of 12 flagged 133 names in a delivered Ford project that compiles clean
 * on V9.40, which is the kind of noise that gets a check switched off.
 */
export type KarelCoreVersion = 'V6' | 'V7-V8' | 'V9';
export interface KarelNameLimits { identifier: number; program: number; version: string }

export function karelNameLimits(version: KarelCoreVersion): KarelNameLimits {
  if (version === 'V6') return { identifier: 12, program: 12, version: 'V6.40 and older' };
  if (version === 'V7-V8') return { identifier: 36, program: 12, version: 'V7.x / V8.x' };
  return { identifier: 36, program: 36, version: 'V9.x' };
}

/** `Version=V8.30-1` (robot.ini) or a bare "V8.30" -> the version family; undefined when unreadable */
export function karelCoreVersionOf(text: string): KarelCoreVersion | undefined {
  const m = /V?(\d)\.?(\d\d)/i.exec(/^\s*Version\s*=\s*(.+)$/im.exec(text)?.[1] ?? text);
  if (!m) return undefined;
  const major = Number(m[1]);
  return major <= 6 ? 'V6' : major <= 8 ? 'V7-V8' : 'V9';
}

export function identifierLengthIssues(prog: KProgram, limits: KarelNameLimits): KDiagnostic[] {
  const out: KDiagnostic[] = [];
  for (const s of prog.symbols) {
    if (!s.span.len || s.kind === 'parameter') continue;
    const max = s.kind === 'program' ? limits.program : limits.identifier;
    if (s.name.length <= max) continue;
    const what = s.kind === 'program' ? 'a PROGRAM name' : 'a name';
    out.push({ code: 'karel.identLength', severity: 'warning', span: s.span,
      message: `"${s.name}" is ${s.name.length} characters; ktrans ${limits.version} allows ${max} for ${what} (robotCode.karel.coreVersion).` });
  }
  return out;
}
