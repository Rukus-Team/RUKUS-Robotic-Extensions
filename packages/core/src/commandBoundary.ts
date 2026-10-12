/**
 * The one way a module registers its commands, so every command has the same error boundary:
 * a handler that throws gets its stack logged to the extension's output channel and a short
 * error message with a "Show Logs" button, instead of VS Code's generic "command resulted in an
 * error" with nothing in our log.
 */
import * as vscode from 'vscode';
import { commandFailure } from './errors';

/** What the boundary needs from the output channel: somewhere to write, and a way to show it. */
export interface CommandLog { appendLine(line: string): void; show(preserveFocus?: boolean): void }

/**
 * Register `id` for the life of the extension. The handler's arguments come from VS Code
 * untyped (a tree node, a URI, whatever a `command:` link or another extension passes): the
 * handler declares what it expects and must check it, as before. Its return value is passed
 * through, so `executeCommand` callers still get it.
 *
 * A failure is logged and shown, and then swallowed - except under the extension's own test
 * runner, where it is rethrown so the integration tests still see a command that failed.
 */
export function registerCommand<Args extends unknown[]>(ctx: vscode.ExtensionContext, log: CommandLog, id: string, handler: (...args: Args) => unknown): void {
  const rethrow = ctx.extensionMode === vscode.ExtensionMode.Test;
  ctx.subscriptions.push(vscode.commands.registerCommand(id, async (...args: unknown[]) => {
    // the cast is the boundary itself: VS Code does not type command arguments
    try { return await handler(...(args as Args)); }
    catch (e) {
      const failure = commandFailure(id, e);
      log.appendLine(`[${new Date().toLocaleTimeString()}] ${failure.log}`);
      if (rethrow) throw e;
      // not awaited: the message must not hold up the command that failed
      void vscode.window.showErrorMessage(failure.message, 'Show Logs').then(pick => { if (pick) log.show(true); });
      return undefined;
    }
  }));
}

/** {@link registerCommand} bound to one module's context and log: `const reg = commandRegistrar(ctx, s.output)`. */
export function commandRegistrar(ctx: vscode.ExtensionContext, log: CommandLog) {
  return <Args extends unknown[]>(id: string, handler: (...args: Args) => unknown): void => registerCommand(ctx, log, id, handler);
}
