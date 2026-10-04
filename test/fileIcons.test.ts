/**
 * File icons: one per FANUC file type, through `contributes.languages[].icon` - the extension
 * in big coloured letters, nothing else, an underline for a compiled or binary type. Checks
 * the table (scripts/make-file-icons.mjs), the files on disk and the manifest agree: an icon
 * path that points at nothing fails silently in VS Code, the file just gets the theme's blank
 * page. Wired in by test/run.ts: `run(check)`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { FILE_ICONS, ICON_THEME_ID, ICON_THEME_FILE, renderAll, renderTheme, manifestBlocks } from '../scripts/make-file-icons.mjs';

export function run(check: (cond: unknown, msg: string) => void): void {
  const repo = path.resolve(__dirname, '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
  const seti = JSON.parse(fs.readFileSync(path.join(repo, 'media', 'seti', 'vs-seti-icon-theme.json'), 'utf8'));
  type Lang = { id: string; extensions?: string[]; filenames?: string[]; filenamePatterns?: string[]; icon?: { light: string; dark: string }; configuration?: string };
  const langs: Lang[] = pkg.contributes.languages;

  // ---- the manifest is what the table says, exactly ----
  const want = manifestBlocks();
  check(JSON.stringify(langs) === JSON.stringify(want.languages), `file icons: contributes.languages is what scripts/make-file-icons.mjs implies - run node scripts/sync-file-icon-manifest.mjs (${langs.length} in package.json, ${want.languages.length} in the table)`);
  check(JSON.stringify(pkg.contributes.grammars) === JSON.stringify(want.grammars), 'file icons: contributes.grammars is what the table implies');
  const act: string[] = pkg.activationEvents;
  check(JSON.stringify(act.filter(a => a.startsWith('onLanguage:'))) === JSON.stringify(want.activation), 'file icons: the onLanguage activation events are what the table implies');
  check(act.some(a => a.startsWith('workspaceContains:')), 'file icons: syncing the manifest kept the activation events that are not about a language');

  // ---- every language has its two files, and they are really there ----
  const missing = langs.filter(l => !l.icon || !fs.existsSync(path.join(repo, l.icon.light)) || !fs.existsSync(path.join(repo, l.icon.dark))).map(l => l.id);
  check(missing.length === 0, `file icons: every contributed language has a light and a dark icon on disk (${missing.join(', ') || 'all ' + langs.length})`);

  // ---- the table itself ----
  const ids = FILE_ICONS.map(t => t.id).filter(Boolean), exts = FILE_ICONS.map(t => t.ext);
  check(new Set(ids).size === ids.length && new Set(exts).size === exts.length, 'file icons: no language id and no extension appears twice');
  // every FANUC file type in Sam's real backup store (counted 2026-09-19), and the KAREL dictionary sources
  const expected = ['ls', 'tp', 'kl', 'pc', 'cm', 'cf', 'va', 'dt', 'vr', 'sv', 'df', 'dg', 'io', 'vd', 'vda', 'cam', 'pmc', 'stm', 'utx', 'ftx'];
  const absent = expected.filter(e => !exts.includes(e));
  check(absent.length === 0, `file icons: every FANUC file type seen in a real backup has an icon (missing: ${absent.join(', ') || 'none'})`);
  // generic types are never claimed as a LANGUAGE - that would make every .txt on the PC a FANUC file
  const claimedExts = langs.flatMap(l => (l.extensions ?? []).map(e => e.replace(/^\./, '').toLowerCase()));
  const grabbed = ['xml', 'txt', 'zip', 'gif', 'json', 'dat', 'log', 'csv'].filter(e => claimedExts.includes(e));
  check(grabbed.length === 0, `file icons: no generic file type is claimed as a language (claimed: ${grabbed.join(', ') || 'none'})`);
  const themeOnly = FILE_ICONS.filter(t => t.themeOnly);
  check(themeOnly.length === 1 && themeOnly[0].ext === 'txt' && themeOnly[0].id === null && !langs.some(l => l.id === null), 'file icons: .txt gets its icon from the theme only - no language, no manifest entry');
  const sv = langs.find(l => l.id === 'fanuc-sv');
  check(sv && !sv.extensions && (sv.filenamePatterns ?? []).includes('sys*.sv') && (sv.filenames ?? []).includes('cellio.sv'), 'file icons: .sv is claimed by file NAME, never by extension - SystemVerilog keeps its files');

  // ---- the committed files are what the generator makes ----
  const rendered = renderAll(seti);
  const dir = path.join(repo, 'media', 'file-icons');
  const stale = [...rendered].filter(([name, body]) => !fs.existsSync(path.join(dir, name)) || fs.readFileSync(path.join(dir, name), 'utf8').replace(/\r\n/g, '\n') !== body).map(([n]) => n);
  check(stale.length === 0, `file icons: media/file-icons matches the generator (${stale.join(', ') || rendered.size + ' files'})`);
  const strays = fs.readdirSync(dir).filter(n => !rendered.has(n));
  check(strays.length === 0, `file icons: no leftover files from an earlier design (${strays.join(', ') || 'none'})`);
  check(rendered.size === FILE_ICONS.length * 2 + 1, `file icons: a dark and a light drawing of every type, plus the theme (${rendered.size} for ${FILE_ICONS.length})`);

  // ---- the Robot Code icon theme: Seti underneath, every FANUC type on top ----
  const themes: Array<{ id: string; path: string; label: string }> = pkg.contributes.iconThemes ?? [];
  const themeEntry = themes.find(t => t.id === ICON_THEME_ID);
  check(!!themeEntry && themeEntry.path === `./media/file-icons/${ICON_THEME_FILE}` && fs.existsSync(path.join(repo, themeEntry.path)), `file icons: package.json contributes the "${ICON_THEME_ID}" icon theme and its file exists`);
  const theme = JSON.parse(renderTheme(seti));
  check(Object.keys(seti.fileExtensions).every(k => k in theme.fileExtensions) && Object.keys(seti.iconDefinitions).every(k => k in theme.iconDefinitions) && Object.keys(seti.fileNames).every(k => k in theme.fileNames), 'file icons: the theme keeps every Seti mapping - no other file loses its icon');
  check(theme.fonts?.[0]?.src?.[0]?.path === '../seti/seti.woff' && fs.existsSync(path.join(repo, 'media', 'seti', 'seti.woff')) && fs.existsSync(path.join(repo, 'media', 'seti', 'ThirdPartyNotices.txt')), 'file icons: the theme points at the vendored Seti font, and its licence notice ships with it');
  const notOnTop = FILE_ICONS.filter(t => theme.fileExtensions[t.ext] !== `fanuc-${t.ext}-dark` || theme.light.fileExtensions[t.ext] !== `fanuc-${t.ext}-light`).map(t => t.ext);
  check(notOnTop.length === 0, `file icons: every FANUC type overrides the theme by extension, dark and light (${notOnTop.join(', ') || 'all'})`);
  check(seti.fileExtensions.ls === '_livescript' && theme.fileExtensions.ls === 'fanuc-ls-dark' && theme.fileExtensions.txt === 'fanuc-txt-dark', 'file icons: .ls is taken back from LiveScript and .txt is lettered - the two a language icon could not reach');
  const themeIconMissing = Object.values<{ iconPath?: string }>(theme.iconDefinitions).filter(d => d.iconPath && !fs.existsSync(path.join(dir, d.iconPath))).map(d => d.iconPath);
  check(themeIconMissing.length === 0, `file icons: every iconPath in the theme is a file beside it (${themeIconMissing.join(', ') || 'ok'})`);
  const langMissing = FILE_ICONS.filter(t => t.id && (theme.languageIds[t.id] !== `fanuc-${t.ext}-dark` || theme.light.languageIds[t.id] !== `fanuc-${t.ext}-light`)).map(t => t.id);
  check(langMissing.length === 0 && theme.fileNames['cellio.sv'] === 'fanuc-sv-dark', `file icons: the theme also maps by language id and by the .sv controller file names (${langMissing.join(', ') || 'ok'})`);
  const prop = pkg.contributes.configuration.properties['robotCode.fileIcons.enabled'];
  check(prop?.type === 'boolean' && prop.default === true, 'file icons: robotCode.fileIcons.enabled exists and defaults to ON - installing the extension means wanting the icons');
  const src = fs.readFileSync(path.join(repo, 'packages', 'core', 'src', 'fileIcons.ts'), 'utf8');
  check(src.includes(`'${ICON_THEME_ID}'`) && src.includes('fileIcons.enabled') && src.includes("'iconTheme'"), 'file icons: packages/core/src/fileIcons.ts switches workbench.iconTheme to the same theme id under that setting');

  // ---- the design: the extension in letters, and nothing else ----
  let bad = 0, boxed = 0, sameBoth = 0, lineWrong = 0;
  for (const t of FILE_ICONS) {
    const dark = rendered.get(`${t.ext}-dark.svg`)!, light = rendered.get(`${t.ext}-light.svg`)!;
    for (const body of [dark, light]) {
      if (!/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 32 32">/.test(body) || !body.trim().endsWith('</svg>') || !body.includes(`>${t.ext.toUpperCase()}</text>`) || (body.match(/</g) ?? []).length !== (body.match(/>/g) ?? []).length) bad++;
      // Sam: "not a box or anything, just a big VA" - no tile behind the letters, no outline round them
      const rects = body.match(/<rect [^>]*>/g) ?? [];
      if (rects.some(r => parseFloat(/height="([\d.]+)"/.exec(r)?.[1] ?? '0') > 4) || /stroke=/.test(body) || /<path/.test(body)) boxed++;
      // the underline, and only the underline, tells a binary from a readable file
      if (rects.length !== (t.binary ? 1 : 0)) lineWrong++;
    }
    if (dark === light) sameBoth++;
  }
  check(bad === 0, `file icons: every icon is a well-formed 32x32 SVG lettered with its own extension (${bad} were not)`);
  check(boxed === 0, `file icons: letters only - no tile, no outline, no folded corner (${boxed} had one)`);
  check(lineWrong === 0, `file icons: a compiled or binary type is underlined and a readable type is not (${lineWrong} wrong)`);
  check(sameBoth === 0, `file icons: the light-theme drawing is a darker shade, not a copy of the dark one (${sameBoth} identical)`);
  // .va is the one Sam named: purple
  const va = rendered.get('va-dark.svg')!;
  const rgb = /fill="#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})"/i.exec(va)!.slice(1).map(h => parseInt(h, 16));
  check(rgb[0] > rgb[1] + 40 && rgb[2] > rgb[1] + 40, `file icons: VA is purple - red and blue well above green (${rgb.join(',')})`);

  // ---- splitting fanuc-va / fanuc-cm cost no file type its grammar or its editor behaviour ----
  const grammars: Array<{ language: string; path: string }> = pkg.contributes.grammars;
  const highlighted = FILE_ICONS.filter(t => t.grammar);
  const noGrammar = highlighted.filter(t => !grammars.some(g => g.language === t.id && fs.existsSync(path.join(repo, g.path)))).map(t => t.id);
  check(noGrammar.length === 0 && ['ls', 'kl', 'va', 'dt', 'dg', 'io', 'cm', 'cf'].every(e => highlighted.some(t => t.ext === e)), `file icons: every file type that was highlighted before still is (${noGrammar.join(', ') || 'ok'})`);
  const noConfig = highlighted.filter(t => { const l = langs.find(x => x.id === t.id); return !l?.configuration || !fs.existsSync(path.join(repo, l.configuration)); }).map(t => t.id);
  check(noConfig.length === 0, `file icons: ... and keeps its language configuration (${noConfig.join(', ') || 'ok'})`);
  const binAct = FILE_ICONS.filter(t => t.binary && act.includes('onLanguage:' + t.id)).map(t => t.id);
  check(binAct.length === 0, `file icons: a binary type never activates the extension - there is nothing to do with one (${binAct.join(', ') || 'ok'})`);
}
