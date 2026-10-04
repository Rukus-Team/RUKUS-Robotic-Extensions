/**
 * `robotCode.containers.gitAware` - note uncommitted changes in the user's own git repository
 * before a push. Pure parsing plus one git call, so it is testable without VS Code.
 *
 * Git is asked about the ONE file being pushed (`git status --porcelain -- <file>`), never the
 * whole tree: the point is "this program is not committed", not a repository summary. Any
 * failure - git missing, not a repository, a timeout - reads as "not dirty", so the check can
 * never block a push on its own.
 */
import { execFile } from 'node:child_process';

export interface GitPorcelain {
  /** there is at least one uncommitted change to the file */
  dirty: boolean;
  /** the two-character porcelain status code, when there is one (e.g. ` M`, `??`, `A `) */
  status?: string;
}

/** Parse `git status --porcelain` output for a single path. */
export function parseGitPorcelain(out: string): GitPorcelain {
  const lines = out.split(/\r?\n/).map(l => l.trimEnd()).filter(l => l.length > 0);
  if (!lines.length) return { dirty: false };
  return { dirty: true, status: lines[0].slice(0, 2) };
}

/** True when `file` has uncommitted changes in the git repository at `cwd`. Never throws. */
export function isFileDirty(cwd: string, file: string, timeoutMs = 4000): Promise<boolean> {
  return new Promise<boolean>(resolve => {
    try {
      execFile(
        'git',
        ['status', '--porcelain', '--', file],
        { cwd, windowsHide: true, timeout: timeoutMs },
        (err, stdout) => resolve(!err && parseGitPorcelain(stdout).dirty)
      );
    } catch {
      resolve(false);
    }
  });
}
