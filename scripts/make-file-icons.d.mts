export const FILE_ICONS: Array<{ ext: string; id: string | null; family: string; binary: boolean; grammar?: string; themeOnly?: boolean; alias: string; what: string; match?: { filenames: string[]; patterns: string[] } }>;
export const ICON_THEME_ID: string;
export const ICON_THEME_FILE: string;
/** the SVGs; with the parsed Seti theme (media/seti/vs-seti-icon-theme.json) the Robot Code theme file as well */
export function renderAll(seti?: unknown): Map<string, string>;
export function renderTheme(seti: unknown): string;
export function manifestBlocks(): { languages: unknown[]; grammars: unknown[]; activation: string[] };
