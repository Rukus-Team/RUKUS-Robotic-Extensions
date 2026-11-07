/**
 * "Send File to Robot": the open program, once, to a robot - the command a user looks for when
 * the program is a plain local file. It is Push (robotCode.sync.pushFile) under the name people
 * search for, offered on every TP editor and in the Explorer, not only inside a robot container:
 * the same robotCode.live.upload switch and its explanation, the same robot pick, confirmation,
 * gates and read-back (editorCommands.ts registers it and hands the file to Push). Pure.
 */

/** Why a file of this kind cannot be sent from the editor, or undefined when it can (a TP .ls). */
export function sendFileRefusal(fileName: string): string | undefined {
  const ext = /\.([^.\\/]+)$/.exec(fileName)?.[1]?.toLowerCase();
  if (ext === 'ls') return undefined;
  if (ext === 'tp') return `${fileName} is a compiled TP program; Send File to Robot sends the source (.ls) and the controller compiles it. Open the .ls of this program and send that.`;
  if (ext === 'kl') return `${fileName} is KAREL source; the controller runs the compiled .pc, which this extension does not send. Compile it with ktrans and load the .pc from the pendant or ROBOGUIDE.`;
  if (ext === 'pc') return `${fileName} is a compiled KAREL program; this extension sends TP programs (.ls) only. Load the .pc from the pendant or ROBOGUIDE.`;
  if (ext === 'mod' || ext === 'modx' || ext === 'sys' || ext === 'sysx' || ext === 'prg') return `${fileName} is an ABB RAPID module; sending modules to an ABB controller is not part of this extension yet. Load it with RobotStudio or the FlexPendant.`;
  return `Send File to Robot sends FANUC TP programs (.ls); ${fileName} is not one.`;
}

