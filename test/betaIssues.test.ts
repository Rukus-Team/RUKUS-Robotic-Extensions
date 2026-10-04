/**
 * Regressions from Sam's beta list of 2026-09-21. Synthetic on purpose, like issue5.test.ts:
 * none of it needs reference-backup, so none of it can be skipped silently.
 * Wired in by test/run.ts: `run(check)`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseTp } from '@fanuc/tp/parser';
import { usageFindings, buildXref, xrefFindings } from '@fanuc/tools/xref';
import { commentOverrun, COMMENT_WIDTH } from '@fanuc/tp/headers';
import { TP_INSTRUCTION_COMPLETIONS, TP_OPERAND_COMPLETIONS, operandContext } from '@fanuc/tp/docs';
import { buildProgramText, progLine, PROGRAM_SUB_TYPES } from '@fanuc/tp/programTemplates';
import { FEATURE_GROUPS, NOT_LISTED, prettyKey } from '@core/views/featureGroups';

const program = (body: string[]) => ['/PROG  T', '/ATTR', '/MN', ...body.map((l, i) => `${String(i + 1).padStart(4)}:${l} ;`), '/POS', '/END', ''].join('\n');

export function run(check: (cond: unknown, msg: string) => void): void {
  // ---- #6: a PR nobody assigns is a taught PR, not a finding ----
  {
    const access = new Map<string, 'w' | 'r'>([['PR:5', 'r'], ['R:10', 'r']]);
    const f = usageFindings([{ name: 'A', dataAccess: access }, { name: 'B', dataAccess: new Map() }]);
    check(!f.has('PR:5'), `a PR that is only read gets no "never written" note: ${JSON.stringify(f.get('PR:5'))}`);
    check(f.get('R:10')?.some(x => /never written/.test(x)), 'a numeric register that is only read still does');
    const entries = buildXref([{ name: 'A', prog: parseTp(program(['J PR[5] 100% FINE', '  R[1]=R[10]'])) }]);
    const found = xrefFindings(entries).map(x => `${x.entry.kind}:${x.entry.index}`);
    check(!found.includes('PR:5') && found.includes('R:10'), `the report agrees: ${found.join(' ')}`);
  }

  // ---- #4: a PR motion target is ONE data reference (it was hinted twice, `PR[5:home:home]`) ----
  {
    const prog = parseTp(program(['J PR[5] 100% FINE']));
    const target = prog.lines.find(l => l.motion)?.motion?.target;
    const refs = prog.dataRefs.filter(d => d.kind === 'PR' && d.index === 5);
    check(target?.kind === 'PR' && refs.length === 1 && refs[0].span.col === target.span.col,
      'the motion target PR[5] is also in dataRefs, at the same span - so exactly one provider loop may hint it');
    const providers = fs.readFileSync(path.join(__dirname, '..', 'packages', 'fanuc', 'src', 'tp', 'providers.ts'), 'utf8');
    check(!/registerInlayHintsProvider/.test(providers) && !/class TpInlayHints/.test(providers),
      'in-line hints are decorations, not inlay hints (so no theme can tint their background)');
    const deco = fs.readFileSync(path.join(__dirname, '..', 'packages', 'fanuc', 'src', 'tp', 'typeDecorations.ts'), 'utf8');
    check(/robotCode\.hintComment/.test(deco) && /isIndirectLabelIndex/.test(deco),
      'the comment decoration draws the register comment and skips indirect label registers');
  }

  // ---- #11: comment length ----
  {
    check(COMMENT_WIDTH === 32, 'a comment line holds 32');
    check(commentOverrun('!' + 'x'.repeat(32)) === undefined, '32 characters fit');
    const over = commentOverrun('!' + 'x'.repeat(40));
    check(over?.from === 33 && over.to === 41, `40 characters: the last 8 are marked: ${JSON.stringify(over)}`);
    check(commentOverrun('!' + 'x'.repeat(32) + ' ;') === undefined, 'the terminator is not counted');
    check(commentOverrun('--eg:' + 'x'.repeat(80)) === undefined, 'an extended comment has no such limit');
    check(commentOverrun('//' + 'x'.repeat(80)) === undefined, 'nor has a remark');
    check(commentOverrun('!' + 'x'.repeat(40), 0) === undefined, '0 switches it off');
  }

  // ---- #14: completions ----
  {
    const labels = TP_INSTRUCTION_COMPLETIONS.map(c => c.label);
    const pr = labels.filter(l => l.startsWith('PR['));
    check(pr[0] === 'PR[]' && TP_INSTRUCTION_COMPLETIONS.find(c => c.label === 'PR[]')!.insert === 'PR[${1}]',
      `typing PR offers the plain register first, not an element assignment: ${pr.join(' | ')}`);
    check(pr.indexOf('PR[,]=') === pr.length - 1, 'the element assignment is the last PR entry');
    check(labels.filter(l => l.startsWith('R['))[0] === 'R[]', 'same for R');
    check(new Set(labels).size === labels.length, 'no duplicate instruction labels');
    const bracketed = [...TP_INSTRUCTION_COMPLETIONS, ...TP_OPERAND_COMPLETIONS].filter(c => c.suggest);
    // ... or, for CALL / RUN, after the space where the program name goes (the list is the programs)
    check(bracketed.length > 0 && bracketed.every(c => /\[\$\{1\}\]$/.test(c.insert) || /^(CALL|RUN) $/.test(c.insert)), 'an entry that re-opens the list leaves the caret in an empty bracket at its end, or after CALL / RUN');
    check(TP_OPERAND_COMPLETIONS.some(c => c.insert === 'PR[${1}]') && TP_OPERAND_COMPLETIONS.some(c => c.insert === 'DI[${1}]'), 'operands cover the data kinds');

    const at = (s: string) => operandContext(s, s.length);
    check(at('   1:  R[1]=PR')?.word === 'PR', 'after = is an operand');
    check(at('   1:  IF DI')?.word === 'DI', 'after IF is an operand');
    check(at('   1:  WAIT (F')?.word === 'F', 'after ( is an operand');
    check(at('   1:L P[1] 100mm/sec CN')?.motion === true, 'the tail of a motion line knows it is one');
    check(at('   1:  R[1]=PR')?.motion === false, 'and an assignment is not');
    check(at('   1:  PR') === undefined, 'the start of the instruction belongs to the instruction list');
    check(at('   1:  !set the DO') === undefined, 'not in a comment');
    check(at('   1:  //  R[1]=PR') === undefined, 'not in a remark');
    check(at('   1:  R[1:gripper op') === undefined, 'not inside a bracket comment');
    check(at("   1:  MESSAGE['hello DO") === undefined && at("   1:  SR[1]='abc DO") === undefined, 'not in a string');
  }

  // ---- #5: program type and write protect ----
  {
    const spec = { name: 'open_grip', comment: 'open', group: '1,*,*,*,*', headerLines: [], bodyLines: [], date: '26-09-21', time: '10:00:00' };
    check(buildProgramText(spec).startsWith('/PROG  OPEN_GRIP\n'), 'an ordinary program has a bare /PROG line');
    check(progLine('open_grip', 'Macro') === '/PROG  OPEN_GRIP\t  Macro', 'a macro is written the way the controller writes it (tab, two spaces, Macro)');
    const macro = buildProgramText({ ...spec, subType: 'Macro', writeProtect: true });
    check(macro.startsWith('/PROG  OPEN_GRIP\t  Macro\n') && /^PROTECT\t\t= READ;$/m.test(macro), 'sub type and write protect reach the file');
    check(/^PROTECT\t\t= READ_WRITE;$/m.test(buildProgramText(spec)), 'write protect is off unless asked for');
    check(parseTp(macro).header.name === 'OPEN_GRIP', 'and the parser still reads the name off a /PROG line with a sub type');
    check(PROGRAM_SUB_TYPES.map(t => t.subType).join(',') === ',Macro,Cond', 'TP, Macro, Cond are offered');
  }

  // ---- #10: every contributed command has a place in the feature picker ----
  {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    const contributed: string[] = manifest.contributes.commands.map((c: { command: string }) => c.command);
    const listed = FEATURE_GROUPS.flatMap(g => g.commands);
    const lost = contributed.filter(c => !listed.includes(c) && !NOT_LISTED.has(c));
    check(lost.length === 0, `commands in package.json with no group in FEATURE_GROUPS (add them): ${lost.join(', ')}`);
    const ghosts = [...listed, ...NOT_LISTED].filter(c => !contributed.includes(c));
    check(ghosts.length === 0, `FEATURE_GROUPS names commands that are not contributed: ${ghosts.join(', ')}`);
    check(new Set(listed).size === listed.length, 'no command is listed twice');
    check(prettyKey('ctrl+alt+shift+t') === 'Ctrl+Alt+Shift+T' && prettyKey('ctrl+/') === 'Ctrl+/', 'keys read as the shortcuts editor writes them');

    // #7: a shortcut is for one thing
    const keys: Array<{ key: string; command: string; when?: string }> = manifest.contributes.keybindings;
    const clash = keys.filter((k, i) => keys.some((o, j) => j < i && o.key === k.key && (o.when ?? '') === (k.when ?? '')));
    check(clash.length === 0, `two commands on one key in the same context: ${clash.map(k => k.key).join(', ')}`);
    const byLang = (lang: string) => keys.filter(k => (k.when ?? '').includes(lang)).map(k => k.key);
    const tpKeys = byLang('fanuc-tp');
    check(new Set(tpKeys).size === tpKeys.length, `a TP editor key is bound once: ${tpKeys.filter((k, i) => tpKeys.indexOf(k) !== i).join(', ')}`);

    // #1: what edits the document is not offered in a document that cannot be edited
    const submenu: Array<{ command: string; when?: string }> = manifest.contributes.menus['robotCode.tp.submenu'];
    const readOk = ['robotCode.tp.showCallGraph', 'robotCode.tp.showFlow', 'robotCode.tp.comparePositions', 'robotCode.tp.stripPositions'];
    const open = submenu.filter(m => !m.when && !readOk.includes(m.command));
    check(open.length === 0, `TP menu entries shown in a read-only file: ${open.map(m => m.command).join(', ')}`);
    // #2: Download is reachable from the row, the tab, the editor and the Explorer.
    // The editor/Explorer entries now live one level down, under the shared "Robot Code" submenu.
    const reachesCommand = (menu: string, command: string): boolean => {
      const items: Array<{ command?: string; submenu?: string }> = manifest.contributes.menus[menu] ?? [];
      if (items.some(m => m.command === command)) return true;
      return items.some(m => m.submenu && (manifest.contributes.menus[m.submenu] ?? []).some((x: { command?: string }) => x.command === command));
    };
    for (const menu of ['view/item/context', 'editor/title', 'editor/title/context', 'editor/context', 'explorer/context']) {
      check(reachesCommand(menu, 'robotCode.live.downloadFile'), `Download is on ${menu}`);
    }
    // #12
    const view = manifest.contributes.views.robotCode.find((v: { id: string }) => v.id === 'robotCode.programs');
    check(view.name === 'Programs', `the section is called Programs: ${view.name}`);

    // ---- git-shaped sync buttons on the editor tab, one Compare command ----
    const tabEntries: Array<{ command: string; group?: string }> = manifest.contributes.menus['editor/title'];
    const tab = tabEntries.map(m => m.command);
    const syncTab = tab.filter(c => c.startsWith('robotCode.sync.'));
    check(JSON.stringify(syncTab) === JSON.stringify(['robotCode.sync.revertFile', 'robotCode.sync.fetchFile', 'robotCode.sync.pullFile', 'robotCode.sync.pushFile', 'robotCode.sync.compareFile', 'robotCode.sync.history']),
      `the tab's sync buttons, in order: ${syncTab.join(', ')}`);
    // every one of our tab items must sort before another extension's Git "Open Changes"
    // (navigation@2), so the git-diff button sits to the right of ours
    const order = (g?: string) => Number((g ?? '').split('@')[1] ?? '0');
    const late = tabEntries.filter(m => /navigation@/.test(m.group ?? '') && order(m.group) >= 2);
    check(late.length === 0, `tab items that sort after the Git button: ${late.map(m => `${m.command} (${m.group})`).join(', ')}`);
    check(!tab.includes('robotCode.containers.diffWithSnapshot') && !tab.includes('robotCode.sync.diffOpen'),
      'the merged diff commands are not separate tab buttons');
    const iconOf = (id: string) => manifest.contributes.commands.find((c: { command: string }) => c.command === id)?.icon;
    check(iconOf('robotCode.sync.fetchFile') === '$(repo-fetch)' && iconOf('robotCode.sync.pullFile') === '$(repo-pull)' && iconOf('robotCode.sync.pushFile') === '$(repo-push)',
      `fetch/pull/push use the git icons (${iconOf('robotCode.sync.fetchFile')} ${iconOf('robotCode.sync.pullFile')} ${iconOf('robotCode.sync.pushFile')})`);
    check(iconOf('robotCode.sync.compareFile') === '$(git-compare)' && iconOf('robotCode.sync.revertFile') === '$(discard)' && iconOf('robotCode.sync.history') === '$(history)',
      'compare/revert/history icons');
    const tabPush = manifest.contributes.menus['editor/title'].find((m: { command: string }) => m.command === 'robotCode.sync.pushFile');
    check(/robotCode\.syncPushable/.test(tabPush?.when ?? ''), `the tab Push button is state-aware: ${tabPush?.when}`);
    const subPush = manifest.contributes.menus['robotCode.sync.submenu'].find((m: { command: string }) => m.command === 'robotCode.sync.pushFile');
    check(!!subPush && !/robotCode\.syncPushable/.test(subPush.when ?? ''), 'the context-menu Push is always shown');
    for (const hidden of ['robotCode.sync.diffOpen', 'robotCode.containers.diffWithSnapshot']) {
      const e = manifest.contributes.menus.commandPalette.find((m: { command: string }) => m.command === hidden);
      check(e?.when === 'false', `${hidden} is hidden from the command palette`);
    }
    // the CodeLens was removed: the tab button is the one Compare affordance
    const codeLensSrc = path.join(__dirname, '..', 'packages', 'core', 'src', 'containerCodeLens.ts');
    check(!fs.existsSync(codeLensSrc), 'the snapshot CodeLens file is gone');
    check(!Object.prototype.hasOwnProperty.call(manifest.contributes.configuration.properties, 'robotCode.containers.snapshotCodeLens'),
      'the snapshotCodeLens setting is gone');
    check(manifest.contributes.menus['robotCode.sync.submenu'].some((m: { command: string }) => m.command === 'robotCode.sync.history'),
      'History is in the sync submenu (editor and Explorer right-click)');
    check(manifest.contributes.menus['view/item/context'].some((m: { command: string; when?: string }) => m.command === 'robotCode.sync.history' && /program/.test(m.when ?? '')),
      'History is on the program rows');
    // the language configuration takes ONE line comment token; an array is silently ignored
    const lang = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'language-configs', 'tp.language-configuration.json'), 'utf8'));
    check(typeof lang.comments.lineComment === 'string', 'lineComment is a string');
  }
}
