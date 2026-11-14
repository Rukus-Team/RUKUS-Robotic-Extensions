/**
 * A program's name is said twice: by its file (`PICK.ls`, `pick.kl`) and inside it (`/PROG  PICK`,
 * `PROGRAM pick` ... `END pick`). The two have to match, so a change to one is carried to the
 * other. Pure text work - programRename.ts does the editor side.
 */

/** `C:/x/Pick_Part.ls` -> `Pick_Part` */
export function fileBaseName(path: string): string {
  return (path.split(/[\\/]/).pop() ?? '').replace(/\.[^.]+$/, '');
}

/** A name the controller takes for a program: a letter, then letters, digits and `_`, 36 at most */
export function programNameProblem(name: string): string | undefined {
  if (!name) return 'A program name cannot be empty.';
  if (name.length > 36) return `A program name holds 36 characters; this is ${name.length}.`;
  if (!/^[A-Za-z]/.test(name)) return 'A program name starts with a letter.';
  if (!/^[A-Za-z0-9_]+$/.test(name)) return 'A program name is letters, digits and _ only.';
  return undefined;
}

export interface NameEdit { line: number; col: number; len: number; newText: string }
export interface HeaderName { name: string; edits(newName: string): NameEdit[] }

/** The name in a TP program's `/PROG` line (the controller writes it in capitals) */
export function tpHeaderName(text: string): HeaderName | undefined {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\/PROG\s+)([A-Za-z0-9_\-]+)/.exec(lines[i]);
    if (m) return { name: m[2], edits: n => [{ line: i, col: m[1].length, len: m[2].length, newText: n.toUpperCase() }] };
    if (/^\/(MN|ATTR)\b/.test(lines[i])) break;
  }
  return undefined;
}

/** The name in a KAREL program's `PROGRAM` line, and the `END <name>` that closes it */
export function karelHeaderName(text: string): HeaderName | undefined {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*PROGRAM\s+)([A-Za-z_][A-Za-z0-9_]*)/i.exec(lines[i]);
    if (!m) continue;
    const name = m[2];
    return {
      name,
      edits: n => {
        const out: NameEdit[] = [{ line: i, col: m[1].length, len: name.length, newText: n }];
        for (let j = lines.length - 1; j > i; j--) {
          const e = /^(\s*END\s+)([A-Za-z_][A-Za-z0-9_]*)\s*(--.*)?$/i.exec(lines[j]);
          if (e && e[2].toUpperCase() === name.toUpperCase()) { out.push({ line: j, col: e[1].length, len: e[2].length, newText: n }); break; }
        }
        return out;
      },
    };
  }
  return undefined;
}

export function headerNameOf(fileName: string, text: string): HeaderName | undefined {
  return /\.ls$/i.test(fileName) ? tpHeaderName(text) : /\.kl$/i.test(fileName) ? karelHeaderName(text) : undefined;
}

/**
 * A file is renamed: what its header becomes. Only a file whose header matched its old name is
 * followed - a copy kept as `PICK_old.ls` with `/PROG PICK` inside says something else on purpose
 * (or by mistake, which the name check reports), and renaming it is not a reason to rewrite it.
 * Nothing when the name does not change (a move to another folder, `pick.ls` -> `PICK.ls` for TP)
 * or the new one is not a program name.
 */
export function headerEditsForFileRename(oldPath: string, newPath: string, text: string): NameEdit[] {
  if (oldPath.replace(/^.*\./, '').toLowerCase() !== newPath.replace(/^.*\./, '').toLowerCase()) return [];
  const header = headerNameOf(newPath, text);
  const oldBase = fileBaseName(oldPath), newBase = fileBaseName(newPath);
  if (!header || header.name.toUpperCase() !== oldBase.toUpperCase()) return [];
  if (programNameProblem(newBase)) return [];
  return header.edits(newBase).filter(e => e.newText !== header.name);
}
