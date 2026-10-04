/**
 * FANUC KAREL (.kl) parser — declarations, routines, block structure and
 * identifier references. Pure TypeScript. KAREL is case-insensitive; all symbol
 * lookups here are done on upper-cased names.
 */
import { KAREL_EV_FILES } from './evNames';

export interface KSpan { line: number; col: number; len: number }

export type KSymbolKind = 'program' | 'routine' | 'variable' | 'constant' | 'type' | 'parameter' | 'field' | 'structure';

export interface KSymbol {
  name: string;
  upper: string;
  kind: KSymbolKind;
  type?: string;
  /** declaring routine (undefined = program scope) */
  scope?: string;
  span: KSpan;
  line: number;
  /** for routines */
  params?: KParam[];
  returnType?: string;
  /** external routine or variable (ROUTINE x FROM prog, x FROM prog : type) */
  from?: string;
  /** first line of body / last line for folding */
  endLine?: number;
  /** for constants */
  value?: string;
  /** for structures */
  fields?: KSymbol[];
  /** the raw declaration text used in hovers */
  detail: string;
  /** comment lines immediately above the declaration */
  doc?: string;
}

export interface KParam { name: string; type: string; byName?: boolean }

export interface KBlock { kind: string; open: KSpan; close?: KSpan; name?: string }

export interface KDiagnostic { message: string; span: KSpan; severity: 'error' | 'warning' | 'info' | 'hint'; code: string }

export interface KIdentifierRef { upper: string; span: KSpan; line: number }

export interface KDirective { name: string; args: string; line: number; span: KSpan }

export interface KProgram {
  name?: string;
  nameSpan?: KSpan;
  directives: KDirective[];
  includes: string[];
  symbols: KSymbol[];
  routines: KSymbol[];
  blocks: KBlock[];
  diagnostics: KDiagnostic[];
  /** every identifier occurrence outside comments/strings, for references and unused detection */
  refs: KIdentifierRef[];
  /** line index of BEGIN of the main program */
  mainBegin?: number;
  mainEnd?: number;
  lines: string[];
  /** a compiled .pc under a .kl name: nothing in it was parsed */
  compiled?: boolean;
}

const KEYWORDS = new Set(['ABORT', 'ABOUT', 'AFTER', 'ALONG', 'ALSO', 'AND', 'ARRAY', 'AT', 'ATTACH', 'AWAY', 'AXIS', 'BEFORE', 'BEGIN', 'BOOLEAN', 'BY', 'BYNAME', 'BYTE', 'CAM_SETUP', 'CANCEL', 'CASE', 'CLOSE', 'CMOS', 'CONDITION', 'CONFIG', 'CONNECT', 'CONST', 'CONTINUE', 'COORDINATED', 'CR', 'DELAY', 'DISABLE', 'DISCONNECT', 'DIV', 'DO', 'DOWNTO', 'DRAM', 'ELSE', 'ENABLE', 'END', 'ENDCONDITION', 'ENDFOR', 'ENDIF', 'ENDMOVE', 'ENDSELECT', 'ENDSTRUCTURE', 'ENDUSING', 'ENDWHILE', 'ERROR', 'EVAL', 'EVENT', 'FILE', 'FOR', 'FROM', 'GO', 'GOTO', 'GROUP', 'GROUP_ASSOC', 'HAND', 'HOLD', 'IF', 'IN', 'INDEPENDENT', 'INTEGER', 'JOINTPOS', 'JOINTPOS1', 'JOINTPOS2', 'JOINTPOS3', 'JOINTPOS4', 'JOINTPOS5', 'JOINTPOS6', 'JOINTPOS7', 'JOINTPOS8', 'JOINTPOS9', 'MOD', 'MODEL', 'MOVE', 'NEAR', 'NOABORT', 'NODEDATA', 'NOMESSAGE', 'NOPAUSE', 'NOT', 'NOWAIT', 'OF', 'OPEN', 'OR', 'PATH', 'PATHHEADER', 'PAUSE', 'POSITION', 'POWERUP', 'PROGRAM', 'PULSE', 'PURGE', 'READ', 'REAL', 'RELATIVE', 'RELAX', 'RELEASE', 'REPEAT', 'RESTORE', 'RESUME', 'RETURN', 'ROUTINE', 'SELECT', 'SEMAPHORE', 'SHORT', 'SIGNAL', 'STOP', 'STRING', 'STRUCTURE', 'THEN', 'TIME', 'TIMER', 'TO', 'TPENABLE', 'TYPE', 'UNHOLD', 'UNINIT', 'UNPAUSE', 'UNTIL', 'USING', 'VAR', 'VECTOR', 'VIA', 'VIS_PROCESS', 'WAIT', 'WHEN', 'WHILE', 'WITH', 'WRITE', 'XYZWPR', 'XYZWPREXT', 'TRUE', 'FALSE', 'ON', 'OFF', 'MAXINT', 'MININT', 'TPDISPLAY', 'TPERROR', 'TPPROMPT', 'TPFUNC', 'TPSTATUS', 'CRTPROMPT', 'CRTERROR', 'CRTFUNC', 'CRTSTATUS', 'INPUT', 'OUTPUT', 'VISION', 'DIN', 'DOUT', 'GIN', 'GOUT', 'AIN', 'AOUT', 'RDI', 'RDO', 'OPIN', 'OPOUT', 'TPIN', 'TPOUT', 'WDI', 'WDO', 'UIN', 'UOUT', 'FLG', 'MRK', 'LDI', 'LDO', 'COMMAND', 'ENDPROGRAM', 'INTEGER', 'NODE', 'ENDNODE', 'RSWORLD', 'AESWORLD']);
export const KAREL_KEYWORDS = KEYWORDS;

const BLOCK_OPEN: Record<string, string> = { IF: 'ENDIF', FOR: 'ENDFOR', WHILE: 'ENDWHILE', REPEAT: 'UNTIL', SELECT: 'ENDSELECT', CONDITION: 'ENDCONDITION', STRUCTURE: 'ENDSTRUCTURE', USING: 'ENDUSING' };
const BLOCK_CLOSE = new Set(Object.values(BLOCK_OPEN));
const RE_WORD = /[A-Za-z_][A-Za-z0-9_]*/g;

export function stripCommentAndStrings(line: string): string {
  // replace string contents with spaces (keep length), cut at comment start
  let out = '';
  let inStr = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inStr) { out += c === "'" ? "'" : ' '; if (c === "'") inStr = false; continue; }
    if (c === "'") { inStr = true; out += c; continue; }
    if (c === '-' && line[i + 1] === '-') { out += ' '.repeat(line.length - i); break; }
    out += c;
  }
  return out;
}

/**
 * A compiled KAREL program (.pc) saved under a .kl name - the corpus has them. Read as
 * text, its bytes look like a page of unclosed blocks. KAREL source never holds a NUL or
 * the replacement character a decoder leaves for invalid bytes; a .pc has both up front.
 */
export function looksCompiled(text: string): boolean {
  const head = text.slice(0, 512);
  return head.includes('\0') || (head.match(/�/g)?.length ?? 0) > 4;
}

export function parseKarel(text: string): KProgram {
  const lines = text.split(/\r?\n/);
  const prog: KProgram = { directives: [], includes: [], symbols: [], routines: [], blocks: [], diagnostics: [], refs: [], lines };
  if (looksCompiled(text)) {
    prog.compiled = true;
    prog.diagnostics.push({ message: 'This looks like a compiled KAREL program (.pc) saved with a .kl name, not KAREL source. It is not checked.', span: { line: 0, col: 0, len: 1 }, severity: 'info', code: 'karel.compiledFile' });
    return prog;
  }
  const clean = lines.map(stripCommentAndStrings);

  let section: 'none' | 'var' | 'const' | 'type' = 'none';
  let currentRoutine: KSymbol | undefined;
  let routineHasBody = false;
  const blockStack: Array<{ kind: string; span: KSpan; expect: string; name?: string }> = [];
  let currentStruct: KSymbol | undefined;
  /** names of a declaration whose type is still on a later line */
  const pendingNames: Array<{ line: string; raw: string; lineNo: number }> = [];
  let pendingDoc: string[] = [];
  let inMainBody = false;
  /** an %INCLUDE at declaration level: ktrans pastes it in place, so the section it ENDS in
   *  (often VAR or CONST) carries on in this file without a keyword of its own */
  let afterInclude = false;

  const pushSym = (s: KSymbol) => { prog.symbols.push(s); };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = clean[i];
    const trimmed = line.trim();

    // doc comments
    const cm = /^\s*--\s?(.*)$/.exec(raw);
    if (cm && trimmed === '') { pendingDoc.push(cm[1]); continue; }
    if (trimmed === '') { pendingDoc = []; continue; }
    const takeDoc = () => { const d = pendingDoc.length ? pendingDoc.join('\n') : undefined; pendingDoc = []; return d; };

    // directives
    const dm = /^\s*%([A-Z0-9_]+)\b\s*(.*)$/i.exec(line);
    if (dm) {
      const name = dm[1].toUpperCase();
      prog.directives.push({ name, args: dm[2].trim(), line: i, span: { line: i, col: raw.indexOf('%'), len: dm[1].length + 1 } });
      if (name === 'INCLUDE') { prog.includes.push(dm[2].trim().split(/\s+/)[0]); if (!blockStack.length && !currentRoutine && !currentStruct) { afterInclude = true; section = 'none'; } }
      pendingDoc = [];
      continue;
    }

    // PROGRAM
    const pm = /^\s*PROGRAM\s+([A-Za-z_][A-Za-z0-9_]*)/i.exec(line);
    if (pm) {
      prog.name = pm[1];
      prog.nameSpan = { line: i, col: raw.toUpperCase().indexOf(pm[1].toUpperCase()), len: pm[1].length };
      pushSym({ name: pm[1], upper: pm[1].toUpperCase(), kind: 'program', span: prog.nameSpan, line: i, detail: raw.trim(), doc: takeDoc() });
      continue;
    }

    // ROUTINE
    const rm = /^\s*ROUTINE\s+([A-Za-z_][A-Za-z0-9_]*)\s*(\(([^)]*)\))?\s*(:\s*([A-Za-z_][A-Za-z0-9_]*))?\s*(FROM\s+([A-Za-z_][A-Za-z0-9_]*))?/i.exec(line);
    if (rm) {
      const nameCol = raw.toUpperCase().indexOf(rm[1].toUpperCase(), raw.toUpperCase().indexOf('ROUTINE') + 7);
      const span = { line: i, col: nameCol, len: rm[1].length };
      const params = parseParams(rm[3] ?? '');
      const sym: KSymbol = { name: rm[1], upper: rm[1].toUpperCase(), kind: 'routine', span, line: i, params, returnType: rm[5], from: rm[7], detail: raw.trim().replace(/\s+/g, ' '), doc: takeDoc() };
      // Multi-line parameter lists: keep appending lines until ")" found
      if (rm[2] === undefined && /\(/.test(line) && !/\)/.test(line)) {
        let j = i; let acc = line;
        while (j + 1 < lines.length && !/\)/.test(acc)) { j++; acc += ' ' + clean[j]; }
        const inner = /\(([^)]*)\)/.exec(acc);
        if (inner) sym.params = parseParams(inner[1]);
        const rt = /\)\s*:\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(acc); if (rt) sym.returnType = rt[1];
        const fr = /\bFROM\s+([A-Za-z_][A-Za-z0-9_]*)/i.exec(acc); if (fr) sym.from = fr[1];
        sym.detail = lines.slice(i, j + 1).map(s => s.trim()).join(' ').replace(/\s+/g, ' ');
        i = j;
      }
      pushSym(sym);
      prog.routines.push(sym);
      for (const p of sym.params ?? []) {
        pushSym({ name: p.name, upper: p.name.toUpperCase(), kind: 'parameter', type: p.type, scope: sym.upper, span: { line: i, col: 0, len: 0 }, line: i, detail: `${p.name} : ${p.type}` });
      }
      if (!sym.from) { currentRoutine = sym; routineHasBody = false; section = 'none'; }
      else { currentRoutine = undefined; }
      continue;
    }

    // Sections
    // A section keyword can carry its first declaration on the same line ("VAR q:XYZWPR"),
    // in which case the line opens the section AND declares something. Falling straight
    // through to `continue` used to lose that declaration entirely, so the variable was
    // invisible to hover, rename and the undeclared check.
    const sm = /^\s*(VAR|CONST|TYPE)\b(.*)$/i.exec(line);
    if (sm) {
      section = sm[1].toUpperCase() === 'VAR' ? 'var' : sm[1].toUpperCase() === 'CONST' ? 'const' : 'type';
      pendingDoc = [];
      if (sm[2].trim() === '') continue;      // plain section header, declarations follow
      // otherwise fall through and let this line be parsed as a declaration as well
    }

    if (/^\s*BEGIN\b/i.test(line)) {
      section = 'none';
      if (currentRoutine) { routineHasBody = true; blockStack.push({ kind: 'ROUTINE', span: { line: i, col: raw.indexOf('BEGIN'), len: 5 }, expect: 'END', name: currentRoutine.upper }); }
      else { inMainBody = true; prog.mainBegin = i; blockStack.push({ kind: 'PROGRAM', span: { line: i, col: raw.indexOf('BEGIN'), len: 5 }, expect: 'END', name: prog.name?.toUpperCase() }); }
      continue;
    }

    // END <name>
    const em = /^\s*END\b\s*([A-Za-z_][A-Za-z0-9_]*)?/i.exec(line);
    if (em) {
      const top = blockStack.pop();
      const span = { line: i, col: raw.toUpperCase().indexOf('END'), len: 3 };
      if (!top || top.expect !== 'END') {
        prog.diagnostics.push({ message: top ? `Expected ${top.expect} to close ${top.kind} opened on line ${top.span.line + 1}` : 'END without matching BEGIN', span, severity: 'error', code: 'karel.unbalanced' });
        if (top) blockStack.push(top);
      } else {
        if (em[1] && top.name && em[1].toUpperCase() !== top.name) {
          prog.diagnostics.push({ message: `END ${em[1]} does not match ${top.kind === 'PROGRAM' ? 'PROGRAM' : 'ROUTINE'} ${top.name}`, span: { line: i, col: raw.toUpperCase().indexOf(em[1].toUpperCase()), len: em[1].length }, severity: 'error', code: 'karel.endName' });
        }
        prog.blocks.push({ kind: top.kind, open: top.span, close: span, name: top.name });
        if (top.kind === 'ROUTINE' && currentRoutine) { currentRoutine.endLine = i; currentRoutine = undefined; routineHasBody = false; }
        if (top.kind === 'PROGRAM') { prog.mainEnd = i; inMainBody = false; }
      }
      collectRefs(prog, line, i);
      continue;
    }

    // A declaration straight after an include that left its section open: the shape of the
    // line says which section it is in (`n : T` VAR, `t = STRUCTURE` TYPE, `n = v` CONST).
    if (section === 'none' && afterInclude && !blockStack.length && !currentRoutine) {
      if (/^\s*[A-Za-z_][A-Za-z0-9_]*\s*(FROM\s+[A-Za-z_][A-Za-z0-9_]*\s*)?=\s*STRUCTURE\b/i.test(line)) section = 'type';
      else if (/^\s*[A-Za-z_][A-Za-z0-9_\s,]*?(\s(IN|FROM)\s[^:]*)?:/i.test(line)) section = 'var';
      else if (/^\s*[A-Za-z_][A-Za-z0-9_]*\s*=/.test(line)) section = 'const';
    }

    // Declarations. `TYPE t FROM p = STRUCTURE` and `CONST n = 1` can open their section on the
    // same line; the keyword is blanked (columns kept) so the name is read, not the keyword.
    const decl = line.replace(/^(\s*)(TYPE|CONST)\b/i, (_m, sp: string, kw: string) => sp + ' '.repeat(kw.length));
    if (section === 'type') {
      // `name [FROM prog] = STRUCTURE`: a type can be shared with another program like a variable
      const sm = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:FROM\s+([A-Za-z_][A-Za-z0-9_]*)\s*)?=\s*STRUCTURE\b/i.exec(decl);
      if (sm) {
        const span = { line: i, col: raw.indexOf(sm[1]), len: sm[1].length };
        currentStruct = { name: sm[1], upper: sm[1].toUpperCase(), kind: 'structure', from: sm[2], span, line: i, fields: [], detail: sm[2] ? `${sm[1]} FROM ${sm[2]} = STRUCTURE` : `${sm[1]} = STRUCTURE`, doc: takeDoc() };
        pushSym(currentStruct);
        blockStack.push({ kind: 'STRUCTURE', span, expect: 'ENDSTRUCTURE', name: currentStruct.upper });
        continue;
      }
      if (/^\s*ENDSTRUCTURE\b/i.test(line)) {
        const top = currentStruct ? blockStack.pop() : undefined;
        if (top && currentStruct) { currentStruct.endLine = i; prog.blocks.push({ kind: 'STRUCTURE', open: top.span, close: { line: i, col: raw.indexOf('ENDSTRUCTURE'), len: 12 }, name: currentStruct.upper }); }
        currentStruct = undefined;
        continue;
      }
      if (currentStruct) {
        for (const d of parseVarDecl(line, raw, i)) {
          d.kind = 'field'; d.scope = currentStruct.upper;
          currentStruct.fields!.push(d); pushSym(d);
        }
        continue;
      }
      const tm = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:FROM\s+([A-Za-z_][A-Za-z0-9_]*)\s*)?=\s*(.+?)\s*$/i.exec(decl);
      if (tm) {
        const span = { line: i, col: raw.indexOf(tm[1]), len: tm[1].length };
        pushSym({ name: tm[1], upper: tm[1].toUpperCase(), kind: 'type', type: tm[3].trim(), from: tm[2], span, line: i, detail: raw.trim(), doc: takeDoc() });
        collectRefs(prog, line.slice(line.indexOf('=') + 1), i, line.indexOf('=') + 1);
      }
      continue;
    }
    if (section === 'const') {
      const cm2 = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+?)\s*$/.exec(decl);
      if (cm2) {
        const span = { line: i, col: raw.indexOf(cm2[1]), len: cm2[1].length };
        pushSym({ name: cm2[1], upper: cm2[1].toUpperCase(), kind: 'constant', value: stringValueAt(raw, cm2[2]), scope: currentRoutine?.upper, span, line: i, detail: raw.trim(), doc: takeDoc() });
        collectRefs(prog, line.slice(line.indexOf('=') + 1), i, line.indexOf('=') + 1);
      }
      continue;
    }
    if (section === 'var') {
      // A name list can run over several lines before the type arrives:
      //     VAR
      //       task_status,
      //       retries      : INTEGER
      // Each name still has to be declared at its own line and column, so the continued
      // lines are remembered and replayed once the type is known rather than being
      // rewritten into one synthetic line.
      if (/^\s*[A-Za-z_][A-Za-z0-9_\s,]*,\s*$/.test(line)) { pendingNames.push({ line, raw, lineNo: i }); continue; }

      const decls = pendingNames.length
        ? [...pendingNames.flatMap(p => parseVarDecl(p.line.replace(/,\s*$/, `: ${typeOf(line)}`), p.raw, p.lineNo)), ...parseVarDecl(line, raw, i)]
        : parseVarDecl(line, raw, i);
      pendingNames.length = 0;
      const doc = takeDoc();
      for (const d of decls) { d.scope = currentRoutine?.upper; d.doc = doc; pushSym(d); }
      // type references inside the declaration
      const colon = line.indexOf(':');
      if (colon >= 0) collectRefs(prog, line.slice(colon + 1), i, colon + 1);
      continue;
    }

    // Body statements: block tracking. KAREL statements are not line-based
    // ("IF x THEN y = 1; ENDIF" is legal), so every keyword token on the line is examined in order.
    RE_WORD.lastIndex = 0;
    let prevWord = '';
    let w: RegExpExecArray | null;
    while ((w = RE_WORD.exec(line))) {
      const word = w[0].toUpperCase();
      const span = { line: i, col: w.index, len: word.length };
      const top = blockStack[blockStack.length - 1];
      if (word in BLOCK_OPEN) {
        // "WAIT FOR cond" and "PULSE DOUT[n] FOR ms" are not loops
        const isLoopFor = word !== 'FOR' || (prevWord !== 'WAIT' && !/\bPULSE\b/i.test(line.slice(0, w.index)));
        const isCondBlock = word !== 'CONDITION' || !/^(ENABLE|DISABLE|PURGE)$/.test(prevWord); // ENABLE CONDITION[n] is a statement
        if (isLoopFor && isCondBlock && word !== 'STRUCTURE') blockStack.push({ kind: word, span, expect: BLOCK_OPEN[word] });
      } else if (word === 'MOVE') {
        // "MOVE TO p, WHEN|UNTIL ... ENDMOVE" — a local condition handler; only when the statement continues after a comma.
        if (/,\s*$/.test(line) || /\b(WHEN|UNTIL)\b/i.test(line.slice(w.index)) && !/\bENDMOVE\b/i.test(line)) {
          blockStack.push({ kind: 'MOVE', span, expect: 'ENDMOVE' });
        }
      } else if (word === 'ENDMOVE') {
        if (top?.kind === 'MOVE') { blockStack.pop(); prog.blocks.push({ kind: 'MOVE', open: top.span, close: span }); }
      } else if (BLOCK_CLOSE.has(word)) {
        if (word === 'UNTIL' && top?.kind === 'MOVE') { /* UNTIL clause of a MOVE handler */ }
        else if (top && top.expect === word) {
          blockStack.pop();
          prog.blocks.push({ kind: top.kind, open: top.span, close: span });
        } else {
          prog.diagnostics.push({ message: top ? `${word} does not close ${top.kind} (line ${top.span.line + 1}); expected ${top.expect}` : `${word} without a matching block opener`, span, severity: 'error', code: 'karel.unbalanced' });
        }
      }
      prevWord = word;
    }
    collectRefs(prog, line, i);
    void inMainBody; void routineHasBody;
  }

  for (const open of blockStack) {
    prog.diagnostics.push({ message: `${open.kind} opened here is never closed (expected ${open.expect})`, span: open.span, severity: 'error', code: 'karel.unbalanced' });
  }

  return prog;
}

function parseParams(text: string): KParam[] {
  const out: KParam[] = [];
  for (const group of text.split(';')) {
    const m = /^\s*([^:]+?)\s*:\s*(.+?)\s*$/.exec(group);
    if (!m) continue;
    const type = m[2].trim();
    for (const n of m[1].split(',')) {
      const name = n.trim();
      if (!name) continue;
      out.push({ name, type });
    }
  }
  return out;
}

/** the declared type from a line like "  retries      : INTEGER" */
function typeOf(line: string): string {
  const c = line.indexOf(':');
  return c >= 0 ? line.slice(c + 1).trim() : 'ANY';
}

function parseVarDecl(line: string, raw: string, lineNo: number): KSymbol[] {
  // name {, name} [IN CMOS|DRAM|SHADOW] [FROM prog] : type. A FROM variable lives in another
  // program; without its own group the clause was read as part of the NAME ("errors FROM
  // lib_install"), which then failed the identifier-length check and was never declared.
  const m = /^\s*([A-Za-z_][A-Za-z0-9_\s,]*?)\s*(IN\s+(CMOS|DRAM|SHADOW)\s*)?(FROM\s+([A-Za-z_][A-Za-z0-9_]*)\s*)?(IN\s+(CMOS|DRAM|SHADOW)\s*)?:\s*(.+?)\s*$/i.exec(line);
  if (!m) return [];
  const type = m[8].trim();
  const from = m[5];
  const out: KSymbol[] = [];
  // `VAR x : INTEGER` all on one line is legal and does happen. The section keyword is
  // part of the name capture, so strip it — otherwise the declaration registers a symbol
  // literally called "VAR x", the real name is never declared, and everything downstream
  // (hover, rename, the undeclared check) is wrong about it.
  const kw = /^\s*(VAR|CONST|TYPE)\s+/i.exec(m[1]);
  const nameList = kw ? m[1].slice(kw[0].length) : m[1];
  let searchFrom = kw ? raw.toUpperCase().indexOf(kw[1].toUpperCase()) + kw[1].length : 0;
  for (const n of nameList.split(',')) {
    const name = n.trim();
    if (!name || /^(VAR|CONST|TYPE)$/i.test(name)) continue;
    const col = raw.indexOf(name, searchFrom);
    searchFrom = col + name.length;
    out.push({ name, upper: name.toUpperCase(), kind: 'variable', type, from, span: { line: lineNo, col: Math.max(col, 0), len: name.length }, line: lineNo, detail: from ? `${name} FROM ${from} : ${type}` : `${name} : ${type}` });
  }
  return out;
}

function stringValueAt(raw: string, cleanValue: string): string {
  // if the value was a string literal, recover it from raw
  const eq = raw.indexOf('=');
  return eq >= 0 ? raw.slice(eq + 1).trim() : cleanValue;
}

const RE_IDENT = /[A-Za-z_][A-Za-z0-9_]*/g;
function collectRefs(prog: KProgram, cleanLine: string, lineNo: number, colOffset = 0) {
  RE_IDENT.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RE_IDENT.exec(cleanLine))) {
    // skip $sysvars and structure member access after "."
    const before = cleanLine[m.index - 1];
    if (before === '$' || before === '.') continue;
    const upper = m[0].toUpperCase();
    if (KEYWORDS.has(upper)) continue;
    prog.refs.push({ upper, span: { line: lineNo, col: colOffset + m.index, len: m[0].length }, line: lineNo });
  }
}

/** Find the symbol a reference at (line,col) resolves to; routine scope first, then program scope. */
export function resolveSymbol(prog: KProgram, upper: string, line: number): KSymbol | undefined {
  const routine = prog.routines.find(r => !r.from && r.line <= line && (r.endLine ?? Number.MAX_SAFE_INTEGER) >= line);
  if (routine) {
    const local = prog.symbols.find(s => s.upper === upper && s.scope === routine.upper);
    if (local) return local;
  }
  return prog.symbols.find(s => s.upper === upper && s.scope === undefined && s.kind !== 'field')
    ?? prog.symbols.find(s => s.upper === upper);
}

export function routineSignature(r: KSymbol): string {
  const params = (r.params ?? []).map(p => `${p.name} : ${p.type}`).join('; ');
  return `ROUTINE ${r.name}${params ? `(${params})` : ''}${r.returnType ? ` : ${r.returnType}` : ''}${r.from ? ` FROM ${r.from}` : ''}`;
}

/**
 * Identifiers used but never declared — the check `ktrans` does not do.
 *
 * Verified against KTRANS V9.40-1: it reports syntax and type errors but says nothing
 * about an undeclared variable, so a typo in a name compiles clean and fails at runtime.
 * That makes this one of the few places the editor can beat the official compiler, which
 * is also why it has to be quiet: a check that cries wolf gets switched off within a day.
 *
 * It therefore declines to answer rather than guess. A program with `%INCLUDE` may take
 * declarations from a file we have not read, so nothing is reported for it at all, and
 * anything reachable through a directive, a GOTO label or a builtin is left alone.
 */
export function findUndeclared(prog: KProgram, isBuiltin: (upper: string) => boolean, included?: { names: ReadonlySet<string>; complete: boolean }): KIdentifierRef[] {
  // Only a real program can be judged: a .kl holding an include fragment has its
  // declarations elsewhere, and the corpus also contains binary .pc files saved under a
  // .kl name, whose garbage bytes otherwise read as a page of undeclared identifiers.
  if (!prog.name) return [];

  // Declarations could be coming from an include we cannot see. No answer beats a wrong one:
  // only when the caller read every include (includes.ts) is the program judged.
  const hasIncludes = prog.includes.length > 0 || prog.directives.some(d => /^INCLUDE$/i.test(d.name));
  if (hasIncludes && !included?.complete) return [];
  // Likewise an environment file (.ev) the extension has no table for, e.g. an option's own
  // `%ENVIRONMENT tpfdef`: its types and constants are invisible here.
  if (prog.directives.some(d => d.name === 'ENVIRONMENT' && !KAREL_EV_FILES.has(d.args.split(/\s+/)[0].toUpperCase()))) return [];

  const declared = new Set<string>(hasIncludes ? included!.names : []);
  for (const s of prog.symbols) {
    declared.add(s.upper);
    for (const f of s.fields ?? []) declared.add(f.upper);
    for (const p of s.params ?? []) declared.add(p.name.toUpperCase());
  }
  for (const r of prog.routines) {
    declared.add(r.upper);
    for (const p of r.params ?? []) declared.add(p.name.toUpperCase());
  }
  if (prog.name) declared.add(prog.name.toUpperCase());

  // GOTO targets and their `label::` declarations are not symbols, so both ends of a jump
  // would look undeclared. Collect them from the source rather than inventing a symbol kind.
  const labels = new Set<string>();
  for (let i = 0; i < prog.lines.length; i++) {
    const clean = stripCommentAndStrings(prog.lines[i]);
    for (const m of clean.matchAll(/\b(?:GOTO|GO\s+TO)\s+([A-Za-z_][A-Za-z0-9_]*)/gi)) labels.add(m[1].toUpperCase());
    for (const m of clean.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*::/gm)) labels.add(m[1].toUpperCase());
  }

  const out: KIdentifierRef[] = [];
  const seen = new Set<string>();
  for (const ref of prog.refs) {
    if (seen.has(ref.upper)) continue;                    // one report per name, at its first use
    if (declared.has(ref.upper) || labels.has(ref.upper)) continue;
    if (isBuiltin(ref.upper)) continue;
    // Directive lines carry file and program names, not variables.
    if (/^\s*%/.test(prog.lines[ref.line] ?? '')) continue;
    seen.add(ref.upper);
    out.push(ref);
  }
  return out;
}

/** Unused declarations (variables, constants, routines) — a reference is any identifier occurrence other than the declaration itself. */
export function findUnused(prog: KProgram): KSymbol[] {
  const counts = new Map<string, number>();
  for (const r of prog.refs) counts.set(r.upper, (counts.get(r.upper) ?? 0) + 1);
  const out: KSymbol[] = [];
  for (const s of prog.symbols) {
    if (s.kind === 'program' || s.kind === 'field' || s.kind === 'parameter') continue;
    if (s.kind === 'routine' && s.from) continue;
    const n = counts.get(s.upper) ?? 0;
    // declarations themselves are not in refs (VAR/CONST/TYPE names are not collected), so any ref means it is used
    if (n === 0) out.push(s);
  }
  return out;
}
