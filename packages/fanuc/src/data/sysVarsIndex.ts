/**
 * System-variable reference: what `$PLST_GRP1[2].$PAYLOAD` is, in words.
 *
 * The data is RUKUS's `SysVarsReference.json` - 53,000 paths with type, access and storage
 * from real controllers, a few thousand of them with a description. Pure: rows in, lookups
 * out, no file system and no VS Code, so it is testable and the loader can feed it from
 * whichever copy of the reference is nearest.
 */

export interface SysVarInfo {
  path: string;
  description?: string;
  dataType?: string;
  access?: string;
  storage?: string;
  /** 'manual' = from a FANUC manual; 'inferred' = guessed from the name, and said so wherever shown */
  source?: string;
}

/** the compact shape the bundled data file uses: [path, description, dataType, access, storage, source] */
export type SysVarRow = [string, string | null, string | null, string | null, string | null, (string | null)?];
/** one object of RUKUS's SysVarsReference.json as written (nulls where nothing is known) */
export interface RawSysVar { path: string; description?: string | null; dataType?: string | null; access?: string | null; storage?: string | null; source?: string | null }

export interface SysVarLookup {
  /** the entry for the name as asked (exact or with indices normalised), if any */
  info?: SysVarInfo;
  /** the reference path that answered - `$MNUFRAME[1,1]` for a question about `[1,5]` */
  matchedPath?: string;
  /** the nearest ancestor with a description, for context when the field has none */
  parent?: SysVarInfo;
}

const RE_TOKEN = /\$[A-Za-z_][A-Za-z0-9_]*(?:\[[0-9, ]*\])?(?:\.\$?[A-Za-z_][A-Za-z0-9_]*(?:\[[0-9, ]*\])?)*/g;

/**
 * `$mnuframe[1,5].$x` → `$MNUFRAME[1,1].$X`. The reference is written for element 1 of
 * every array, so every index becomes 1 and the field separator gets its `$` back.
 */
export function normalizeSysVar(name: string): string {
  return name.trim().toUpperCase()
    .replace(/\[([0-9, ]*)\]/g, (_, inner: string) => `[${inner.split(',').map(() => '1').join(',')}]`)
    .replace(/\.(?!\$)/g, '.$')
    .replace(/\.$/, '');
}

/** The `$…` token under `character` on a line, with its bounds, or undefined. */
export function sysVarTokenAt(line: string, character: number): { token: string; start: number; end: number } | undefined {
  RE_TOKEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RE_TOKEN.exec(line))) {
    if (character >= m.index && character <= m.index + m[0].length) return { token: m[0], start: m.index, end: m.index + m[0].length };
  }
  return undefined;
}

export class SysVarsIndex {
  private readonly byPath = new Map<string, SysVarInfo>();
  /** parent path → field name → entry, for completion after `$X[1].$` */
  private readonly children = new Map<string, Map<string, SysVarInfo>>();

  get size(): number { return this.byPath.size; }

  /** later rows win, so a fuller source loaded after the bundled subset overrides it */
  add(rows: Iterable<SysVarRow | RawSysVar>): void {
    for (const r of rows) {
      const info: SysVarInfo = Array.isArray(r)
        ? { path: r[0], description: r[1] ?? undefined, dataType: r[2] ?? undefined, access: r[3] ?? undefined, storage: r[4] ?? undefined, source: r[5] ?? undefined }
        : { path: r.path, description: r.description || undefined, dataType: r.dataType || undefined, access: r.access || undefined, storage: r.storage || undefined, source: r.source || undefined };
      const key = info.path.toUpperCase();
      const prev = this.byPath.get(key);
      // keep a description already known when the newer row has none, and a manual one over a guess
      if (prev?.description && (!info.description || (prev.source === 'manual' && info.source !== 'manual'))) { info.description = prev.description; info.source = prev.source; }
      this.byPath.set(key, info);
      const dot = key.lastIndexOf('.');
      if (dot > 0) {
        const parent = key.slice(0, dot);
        let m = this.children.get(parent);
        if (!m) { m = new Map(); this.children.set(parent, m); }
        m.set(key.slice(dot + 1), info);
      }
    }
  }

  lookup(name: string): SysVarLookup {
    const upper = name.trim().toUpperCase().replace(/\.$/, '');
    const norm = normalizeSysVar(name);
    const out: SysVarLookup = {};
    // The element-1 spelling first: a manual describes the variable, not each element of the
    // array, and the importers write their newest text onto that spelling. A row for
    // `$X[2].$F` that exists on its own is the controller capture's older wording.
    const hit = this.byPath.get(norm) ?? this.byPath.get(upper);
    if (hit) { out.info = hit; out.matchedPath = hit.path; }
    // nearest described ancestor
    let p = norm;
    for (;;) {
      const dot = p.lastIndexOf('.');
      if (dot < 0) break;
      p = p.slice(0, dot);
      const anc = this.byPath.get(p) ?? this.byPath.get(p.replace(/\[[^\]]*\]$/, ''));
      if (anc?.description && anc.source !== 'inferred') { out.parent = anc; break; }
    }
    if (!out.info) {
      // `$MNUFRAME[1,5]` asked about the array itself: fall back to the bare variable
      const bare = this.byPath.get(norm.replace(/\[[^\]]*\]$/, ''));
      if (bare && !norm.includes('.')) { out.info = bare; out.matchedPath = bare.path; }
    }
    return out;
  }

  /** every top-level variable, manual descriptions first, then inferred, then none */
  topLevel(): SysVarInfo[] {
    const out: SysVarInfo[] = [];
    for (const [k, v] of this.byPath) if (!k.includes('.')) out.push(v);
    const rank = (v: SysVarInfo) => (!v.description ? 2 : v.source === 'inferred' ? 1 : 0);
    return out.sort((a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path));
  }

  /** fields of `$X[1]` (or `$X`), for completion after the dot */
  fieldsOf(parent: string): SysVarInfo[] {
    const norm = normalizeSysVar(parent);
    const m = this.children.get(norm) ?? this.children.get(norm.replace(/\[[^\]]*\]$/, '')) ?? this.children.get(norm + '[1]');
    return m ? [...m.values()].sort((a, b) => a.path.localeCompare(b.path)) : [];
  }
}

/** Markdown lines for one variable - shared by the TP, KAREL and .va hovers. */
export function describeSysVar(token: string, r: SysVarLookup, extraDoc?: string): string[] {
  const lines: string[] = [`**${token}** — system variable`];
  const info = r.info;
  if (extraDoc) lines.push('', extraDoc);
  if (info?.description && info.description !== extraDoc) {
    // a guess is shown as a guess: the name expanded, not a manual's words
    lines.push('', info.source === 'inferred' ? `${info.description}\n\n_Inferred from the name; no description yet._` : info.description);
  }
  if (info) {
    const facts = [info.dataType ? `\`${info.dataType}\`` : '', info.access ? `access ${info.access}` : '', info.storage ? `storage ${info.storage}` : ''].filter(Boolean);
    if (facts.length) lines.push('', facts.join(' · '));
    if (r.matchedPath && r.matchedPath.toUpperCase() !== token.toUpperCase()) lines.push('', `_Reference entry: \`${r.matchedPath}\`_`);
  } else if (!extraDoc) {
    lines.push('', '_Not in the system variable reference._');
  }
  if (r.parent && r.parent.path.toUpperCase() !== (r.matchedPath ?? '').toUpperCase() && r.parent.description && r.parent.description !== info?.description && r.parent.source !== 'inferred') {
    lines.push('', `\`${r.parent.path}\` — ${r.parent.description}`);
  }
  return lines;
}
