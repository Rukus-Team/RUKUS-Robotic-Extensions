/**
 * Control-flow graph of one KAREL routine (or the main body), in the TP flowchart's shape
 * (tp/flow.ts) so the same view draws it and the same Mermaid export copies it. Pure TypeScript.
 *
 * KAREL is structured, so the graph follows the blocks rather than labels:
 *   IF c THEN / ELSE / ENDIF              a branch, true / false edges labelled with c
 *   SELECT e OF / CASE(v): / ELSE: / ENDSELECT   a branch, one `case` edge per CASE
 *   FOR .. DO / ENDFOR, WHILE c DO / ENDWHILE    a loop header, the body, a back edge
 *   REPEAT / UNTIL c                      a loop header, the body, UNTIL as a branch back
 *   label:: and GO TO label (GOTO)        a label block and a jump edge
 *   RETURN, ABORT                         straight to END
 * Everything else is a line in a block; calls of the program's own routines are marked as calls.
 */
import type { FlowGraph, FlowNode, FlowEdge, FlowEdgeKind, FlowLine } from '../tp/flow';
import { stripCommentAndStrings, type KProgram } from './parser';

/** The scopes a flowchart can be drawn for: the main body and each routine with a body here. */
/** `start`: the ROUTINE (or PROGRAM) line; `begin`: its BEGIN; `end`: its END */
export interface KarelFlowScope { name: string; start: number; begin: number; end: number; routine: boolean }

export function karelFlowScopes(prog: KProgram): KarelFlowScope[] {
  const lines = prog.lines;
  const out: KarelFlowScope[] = [];
  for (const r of prog.routines) {
    if (r.from || r.endLine === undefined) continue;
    let b = r.line + 1;
    while (b < r.endLine && !/^\s*BEGIN\b/i.test(stripCommentAndStrings(lines[b] ?? ''))) b++;
    if (b < r.endLine) out.push({ name: r.name, start: r.line, begin: b, end: r.endLine, routine: true });
  }
  if (prog.mainBegin !== undefined && prog.mainEnd !== undefined) out.push({ name: prog.name ?? 'main', start: prog.mainBegin, begin: prog.mainBegin, end: prog.mainEnd, routine: false });
  return out;
}

/** The scope a document line is in (the innermost: a routine before main). */
export function scopeAt(scopes: readonly KarelFlowScope[], line: number): KarelFlowScope | undefined {
  return scopes.find(s => s.routine && line >= s.start && line <= s.end) ?? scopes.find(s => !s.routine && line >= s.begin && line <= s.end);
}

type Pending = { from: number; kind: FlowEdgeKind; label?: string };
type Frame =
  | { t: 'if'; b: number; cond: string; ends: Pending[]; hasElse: boolean }
  | { t: 'select'; b: number; ends: Pending[]; started: boolean; hasElse: boolean }
  | { t: 'loop'; l: number; kind: 'for' | 'while' }
  | { t: 'repeat'; l: number };

/** a block opener and the word that ends its head; a head without it runs on to the next line */
const OPENERS: Array<[RegExp, RegExp]> = [[/^IF\b/i, /\bTHEN\b/i], [/^(WHILE|FOR)\b/i, /\bDO\b/i], [/^SELECT\b/i, /\bOF\b/i]];
/** a line that stops mid-expression goes on on the next */
const RUNS_ON = /(\b(AND|OR|NOT|DIV|MOD)|[-+*/<>=(,&])\s*$/i;
const MOTION =/^(MOVE|CANCEL|STOP|RESUME|HOLD|UNHOLD)\b/i;
/** a head and a statement after it on the same line: split there (IF a THEN b = 1 ; ENDIF) */
const HEADS = [/^(IF\b.+?\bTHEN)\s+(\S.*)$/i, /^((?:FOR|WHILE)\b.+?\bDO)\s+(\S.*)$/i, /^(SELECT\b.+?\bOF)\s+(\S.*)$/i, /^(ELSE)\s+(?!:)(\S.*)$/i, /^(REPEAT)\s+(\S.*)$/i, /^([A-Za-z_]\w*\s*::)\s*(\S.*)$/];

export interface KStatement { line: number; code: string; shown: string }

/**
 * The statements of a scope, one per entry: lines split at `;` and after a block head that has
 * more on its line, and a head that runs over several lines (IF a AND\n b THEN) joined. `code`
 * has strings blanked (stripCommentAndStrings) for matching; `shown` is the text as written.
 */
export function statements(lines: readonly string[], scope: Pick<KarelFlowScope, 'begin' | 'end'>): KStatement[] {
  const pieces: KStatement[] = [];
  for (let i = scope.begin + 1; i < scope.end; i++) {
    const raw = lines[i] ?? '';
    const code = stripCommentAndStrings(raw);
    let from = 0;
    const cut = (to: number) => {
      const c = code.slice(from, to).trim();
      if (c) pieces.push({ line: i, code: c, shown: raw.slice(from, to).trim() });
      from = to + 1;
    };
    for (let k = 0; k < code.length; k++) if (code[k] === ';') cut(k);
    cut(code.trimEnd().length);
  }
  // join a head whose THEN / DO / OF is on a later line (a few lines at most)
  const joined: KStatement[] = [];
  for (let k = 0; k < pieces.length; k++) {
    const p = { ...pieces[k] };
    const open = OPENERS.find(([o]) => o.test(p.code));
    // ... and any statement whose line stops mid-expression: UNTIL (a) OR\n (b)
    for (let n = 0; ((open && !open[1].test(p.code)) || RUNS_ON.test(p.code)) && n < 6 && k + 1 < pieces.length; n++) {
      k++;
      p.code += ' ' + pieces[k].code;
      p.shown += ' ' + pieces[k].shown;
    }
    joined.push(p);
  }
  // split "head rest" until none is left (the rest may itself be a head)
  const out: KStatement[] = [];
  const push = (p: KStatement) => {
    for (const re of HEADS) {
      const m = re.exec(p.code);
      if (!m) continue;
      const at = m[1].length;
      const restAt = p.code.indexOf(m[2], at);
      out.push({ line: p.line, code: m[1].trim().replace(/\s+/g, ' '), shown: p.shown.slice(0, at).trim().replace(/\s+/g, ' ') });
      push({ line: p.line, code: p.code.slice(restAt).trim(), shown: p.shown.slice(restAt).trim() });
      return;
    }
    out.push({ line: p.line, code: p.code.replace(/\s+/g, ' '), shown: p.shown.replace(/\s+/g, ' ') });
  };
  for (const p of joined) push(p);
  return out;
}

export function buildKarelFlow(prog: KProgram, scope: KarelFlowScope): FlowGraph {
  const nodes: FlowNode[] = [];
  const edges: FlowEdge[] = [];
  const unresolved: FlowGraph['unresolved'] = [];
  const routines = new Set(prog.routines.map(r => r.upper));
  const labels = new Map<string, number>();
  const gotos: Array<{ from: number; label: string }> = [];
  const toEnd: Pending[] = [];
  const stack: Frame[] = [];
  let pend: Pending[] = [];
  let cur: FlowNode | undefined;

  const node = (kind: FlowNode['kind'], title: string, docLine: number): FlowNode => {
    const n: FlowNode = { id: nodes.length, kind, title, lines: [], docLine };
    nodes.push(n);
    for (const p of pend) edges.push({ from: p.from, to: n.id, kind: p.kind, label: p.label, back: n.id <= p.from });
    pend = [];
    return n;
  };
  const close = () => { if (cur) { pend.push({ from: cur.id, kind: 'next' }); cur = undefined; } };
  const add = (docLine: number, text: string, kind: FlowLine['kind']) => {
    if (!cur) cur = node('block', '', docLine);
    const num = docLine + 1;
    cur.lines.push({ num, docLine, text, kind });
    cur.firstNum ??= num; cur.lastNum = num;
    if (!cur.title) cur.title = `line ${num}`;
  };
  const kindOf = (code: string): FlowLine['kind'] => {
    const head = /^([A-Za-z_]\w*)\s*(\(|$)/.exec(code)?.[1]?.toUpperCase();
    return head && routines.has(head) ? 'call' : MOTION.test(code) ? 'motion' : 'logic';
  };
  const top = <T extends Frame['t']>(t: T) => { const f = stack[stack.length - 1]; return f?.t === t ? (f as Extract<Frame, { t: T }>) : undefined; };

  node('entry', scope.routine ? `ROUTINE ${scope.name}` : `PROGRAM ${scope.name}`, scope.begin);
  pend = [{ from: 0, kind: 'next' }];

  for (const st of statements(prog.lines, scope)) {
    const { line: first, code, shown } = st;
    let m: RegExpExecArray | null;
    if ((m = /^IF\s+(.+?)\s+THEN$/i.exec(code))) {
      close();
      const cond = /^IF\s+(.+?)\s+THEN$/i.exec(shown)?.[1] ?? m[1];
      const b = node('branch', `IF ${cond}`, first);
      stack.push({ t: 'if', b: b.id, cond, ends: [], hasElse: false });
      pend = [{ from: b.id, kind: 'true', label: cond }];
    } else if (/^ELSE\s*:?$/i.test(code) && (top('if') || top('select'))) {
      close();
      const f = stack[stack.length - 1] as Extract<Frame, { t: 'if' | 'select' }>;
      if (f.t === 'if') { f.ends.push(...pend); pend = [{ from: f.b, kind: 'false', label: f.cond }]; }
      else { if (f.started) f.ends.push(...pend); pend = [{ from: f.b, kind: 'case', label: 'ELSE' }]; f.started = true; }
      f.hasElse = true;
    } else if (/^ENDIF\b/i.test(code) && top('if')) {
      close();
      const f = stack.pop() as Extract<Frame, { t: 'if' }>;
      pend = [...f.ends, ...pend, ...(f.hasElse ? [] : [{ from: f.b, kind: 'false' as const, label: f.cond }])];
    } else if ((m = /^SELECT\s+(.+?)\s+OF$/i.exec(code))) {
      close();
      const b = node('branch', `SELECT ${m[1]}`, first);
      stack.push({ t: 'select', b: b.id, ends: [], started: false, hasElse: false });
    } else if ((m = /^CASE\s*\((.*)\)\s*:\s*(.*)$/i.exec(code)) && top('select')) {
      close();
      const f = top('select')!;
      if (f.started) f.ends.push(...pend);
      pend = [{ from: f.b, kind: 'case', label: m[1].trim() }];
      f.started = true;
      if (m[2].trim()) add(first, shown.replace(/^CASE\s*\(.*?\)\s*:\s*/i, ''), kindOf(m[2].trim()));
    } else if (/^ENDSELECT\b/i.test(code) && top('select')) {
      close();
      const f = stack.pop() as Extract<Frame, { t: 'select' }>;
      pend = [...f.ends, ...(f.started ? pend : []), ...(f.hasElse ? [] : [{ from: f.b, kind: 'case' as const, label: 'no match' }])];
    } else if ((m = /^(FOR|WHILE)\s+(.+?)\s+DO$/i.exec(code))) {
      close();
      const text = /^(?:FOR|WHILE)\s+(.+?)\s+DO$/i.exec(shown)?.[1] ?? m[2];
      const l = node('loop', `${m[1].toUpperCase()} ${text}`, first);
      stack.push({ t: 'loop', l: l.id, kind: m[1].toUpperCase() === 'FOR' ? 'for' : 'while' });
      pend = [{ from: l.id, kind: m[1].toUpperCase() === 'FOR' ? 'loop' : 'true', label: m[1].toUpperCase() === 'WHILE' ? text : undefined }];
    } else if (/^(ENDFOR|ENDWHILE)\b/i.test(code) && top('loop')) {
      close();
      const f = stack.pop() as Extract<Frame, { t: 'loop' }>;
      for (const p of pend) edges.push({ from: p.from, to: f.l, kind: 'loop', label: p.label, back: true });
      pend = [{ from: f.l, kind: 'exit', label: f.kind === 'while' ? 'done' : undefined }];
    } else if (/^REPEAT\b/i.test(code)) {
      close();
      const l = node('loop', 'REPEAT', first);
      stack.push({ t: 'repeat', l: l.id });
      pend = [{ from: l.id, kind: 'next' }];
    } else if ((m = /^UNTIL\s+(.+)$/i.exec(code)) && top('repeat')) {
      close();
      const f = stack.pop() as Extract<Frame, { t: 'repeat' }>;
      const cond = /^UNTIL\s+(.+)$/i.exec(shown)?.[1] ?? m[1];
      const u = node('branch', `UNTIL ${cond}`, first);
      edges.push({ from: u.id, to: f.l, kind: 'false', label: cond, back: true });
      pend = [{ from: u.id, kind: 'true', label: cond }];
    } else if ((m = /^([A-Za-z_]\w*)\s*::/.exec(code))) {
      close();
      const n = node('label', `${m[1]}::`, first);
      labels.set(m[1].toUpperCase(), n.id);
      cur = n;
      const rest = shown.replace(/^[A-Za-z_]\w*\s*::\s*/, '');
      if (rest) add(first, rest, 'logic');
    } else if ((m = /^GO\s*TO\s+([A-Za-z_]\w*)/i.exec(code))) {
      add(first, shown, 'logic');
      gotos.push({ from: cur!.id, label: m[1] });
      cur = undefined;
    } else if (/^(RETURN|ABORT)\b/i.test(code)) {
      add(first, shown, 'logic');
      toEnd.push({ from: cur!.id, kind: 'jump' });
      cur = undefined;
    } else {
      add(first, shown, kindOf(code));
    }
  }
  close();
  // an unclosed block (a typo while editing) still ends somewhere
  while (stack.length) {
    const f = stack.pop()!;
    if (f.t === 'if' || f.t === 'select') pend.push(...f.ends);
  }
  pend.push(...toEnd);
  node('end', 'END', scope.end);
  for (const g of gotos) {
    const to = labels.get(g.label.toUpperCase());
    if (to === undefined) { unresolved.push({ label: 0, from: g.from }); continue; }
    edges.push({ from: g.from, to, kind: 'jump', label: `GO TO ${g.label}`, back: to <= g.from });
  }
  return { nodes, edges, unresolved };
}
