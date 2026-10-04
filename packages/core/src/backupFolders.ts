/**
 * Backup-folder naming shared by every brand: which robot a folder belongs to and the date in
 * its name. RUKUS names backup folders the same way whatever the controller make, so this
 * lives in core. Pure, no vscode import, so the containers module and the tests can use it.
 */

/**
 * The robot a backup folder belongs to, from the folder's name. RUKUS names the folder from a
 * template, and ships two presets - both have to read:
 *   Sam's       {RobotName}_({BackupType})_{Date:yyMMdd}      "S002R01_(MD)_260912"        → "S002R01"
 *   Rodrigo's   {RobotName}_{BackupType}_{Date:yyyy-MM-dd}    "S002R01_MD_2026-09-12"      → "S002R01"
 * plus the older hand-made shapes: "S002R01_full_260823", "R1_backup", "R1_260912".
 * A name that is only a date - a RUKUS batch folder, "2026-08-29_09-15" - stays as it is.
 *
 * Rodrigo's shape was not recognised until 2026-09-19: the whole folder name came back as the
 * robot, so his datasets were labelled "S002R01_MD_2026-09-12" and nothing matched them to a
 * robot.json named S002R01. The backup TYPE is what makes it safe to cut there: RUKUS only
 * writes MD, IMG or Filtered, so "CELL_MD_2026-09-12" is a robot called CELL, while a robot
 * that really is called "LINE_2026" keeps its name.
 */
export function robotNameFromFolder(folder: string): string {
  const base = folder.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? folder;
  for (const re of ROBOT_FOLDER_PATTERNS) {
    const t = re.exec(base)?.groups?.robot?.trim();
    if (t) return t;
  }
  const m = /^(.+?)(?:_\(|_full|_backup|_bak|_\d{6}(?:_|$)|_(?:MD|IMG|Filtered)_\d{4}-\d{2}-\d{2}(?:_|$)|_(?:MD|IMG|Filtered)_\d{6,8}(?:_|$))/i.exec(base);
  return (m ? m[1] : base) || base;
}

/**
 * Robot-folder name patterns read first, ahead of the two presets above: the one RUKUS is
 * set to (its `BackupRobotFolderTemplate`, turned into a RegExp with a `robot` group by
 * rukus/store.ts) is put here when RUKUS's settings are read, so a folder named by
 * whatever template the user chose is read the same way RUKUS wrote it.
 */
export const ROBOT_FOLDER_PATTERNS: RegExp[] = [];

/**
 * "S002R01_full_260823" → "26-08-23", "S002R01_MD_2026-09-12" → "26-09-12"; undefined when the
 * name carries no date. Here rather than in views/typeStyle.ts (which re-exports it as
 * backupDate) so code that must not import vscode - the containers module, the tests - can
 * use the one implementation.
 */
export function folderDate(folder: string): string | undefined {
  const base = folder.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
  const m = /(?:^|[_\-.( ])(\d{2})(\d{2})(\d{2})(?:[_\-.) ]|$)/.exec(base) ?? /(\d{4})-(\d{2})-(\d{2})/.exec(base);
  if (!m) return undefined;
  return m[1].length === 4 ? `${m[1].slice(2)}-${m[2]}-${m[3]}` : `${m[1]}-${m[2]}-${m[3]}`;
}
