/**
 * Turning a caught value into log text. Pure (no vscode) so the command boundary, the poll
 * loops and the activation hook all log a failure the same way, and tests can run it in Node.
 */

/** The one-line message of anything thrown: an Error's message, else its string form. */
export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message || e.name;
  if (typeof e === 'string') return e;
  if (e && typeof e === 'object' && 'message' in e && typeof e.message === 'string') return e.message;
  return String(e);
}

/** What goes in the log: the stack when there is one (it starts with the message), else the message. */
export function errorDetail(e: unknown): string {
  if (e instanceof Error && e.stack) return e.stack;
  return errorMessage(e);
}

/**
 * A command that threw, as the user sees it (short, one line, prefixed like the rest of that
 * command's messages) and as the log keeps it (the command id and the stack).
 */
export function commandFailure(commandId: string, e: unknown): { message: string; log: string } {
  const prefix = commandId.startsWith('robotCode.abb.') ? 'ABB' : 'RUKUS';
  return { message: `${prefix}: ${errorMessage(e)}`, log: `[command] ${commandId} failed: ${errorDetail(e)}` };
}

/**
 * Did this failure come from code under `extensionPath`? The extension host is shared, so a
 * process-wide rejection hook sees every extension's failures; only ours belong in our log.
 * Decided by the stack, compared without regard to slash direction or case (Windows paths).
 */
export function isOwnFailure(e: unknown, extensionPath: string): boolean {
  if (!(e instanceof Error) || !e.stack || !extensionPath) return false;
  const norm = (s: string) => s.replace(/\\/g, '/').toLowerCase();
  return norm(e.stack).includes(norm(extensionPath));
}
