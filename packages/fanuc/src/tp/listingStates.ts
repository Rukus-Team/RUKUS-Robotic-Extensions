import { parseTp, type TpDataRef } from './parser';

export interface ListingStateStrip {
  text: string;
  removed: number;
}

export function stripListingStates(text: string): ListingStateStrip {
  const prog = parseTp(text);
  const byLine = new Map<number, TpDataRef[]>();
  for (const ref of prog.dataRefs) {
    if (!ref.state || !ref.stateSpan) continue;
    const list = byLine.get(ref.stateSpan.line);
    if (list) list.push(ref);
    else byLine.set(ref.stateSpan.line, [ref]);
  }
  if (!byLine.size) return { text, removed: 0 };

  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  let removed = 0;
  for (const [lineNo, refs] of byLine) {
    const raw = lines[lineNo];
    if (raw === undefined) continue;
    const ranges = refs
      .map(ref => {
        const span = ref.stateSpan!;
        let start = span.col - 1;
        while (start >= 0 && (raw[start] === ' ' || raw[start] === '\t')) start--;
        if (raw[start] !== ':') return undefined;
        let end = span.col + span.len;
        while (end < raw.length && (raw[end] === ' ' || raw[end] === '\t')) end++;
        if (raw[end] === ':') {
          const after = raw.slice(end + 1);
          if (/^\s*\]/.test(after)) end += 1 + (/^\s*/.exec(after)?.[0].length ?? 0);
        }
        return { start, end };
      })
      .filter((r): r is { start: number; end: number } => !!r)
      .sort((a, b) => b.start - a.start);
    if (!ranges.length) continue;
    let out = raw;
    for (const r of ranges) out = out.slice(0, r.start) + out.slice(r.end);
    lines[lineNo] = out;
    removed += ranges.length;
  }
  return { text: lines.join(eol), removed };
}
