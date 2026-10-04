/**
 * The ask-and-insert side of program templates: pick one, fill its placeholders (the
 * program's own facts by itself, anything else asked once), and either hand the lines to
 * the New TP Program wizard or drop them at the cursor of an open program.
 */
import * as vscode from 'vscode';
import * as os from 'node:os';
import type { FanucServices } from '../services';
import { config } from '@core/util';
import { COMMENT_WIDTH, fanucDate, fanucTime } from './headers';
import { DEFAULT_PROGRAM_TEMPLATES, expandTemplate, templatePrompts, unnumberedBodyLines, type ProgramTemplate } from './programTemplates';

export function programTemplates(): ProgramTemplate[] {
  return config<ProgramTemplate[]>('tp.programTemplates', DEFAULT_PROGRAM_TEMPLATES).filter(t => t && typeof t.name === 'string' && Array.isArray(t.lines));
}

/** undefined = cancelled */
export async function pickProgramTemplate(placeHolder: string): Promise<ProgramTemplate | undefined> {
  const templates = programTemplates();
  if (!templates.length) { vscode.window.showInformationMessage('No program templates are configured (robotCode.tp.programTemplates).'); return undefined; }
  if (templates.length === 1) return templates[0];
  const pick = await vscode.window.showQuickPick(
    templates.map(t => ({ label: t.name, description: t.description ?? `${t.lines.length} lines`, detail: [t.header ? `header: ${t.header}` : '', templatePrompts(t).length ? `asks for ${templatePrompts(t).join(', ')}` : ''].filter(Boolean).join(' · ') || undefined, t })),
    { placeHolder, matchOnDetail: true });
  return pick?.t;
}

/** the template's lines with every placeholder filled - the known ones by itself, the rest asked once; undefined = cancelled */
export async function resolveTemplateLines(s: FanucServices, t: ProgramTemplate, program: string | undefined, comment: string | undefined, uri?: vscode.Uri): Promise<string[] | undefined> {
  const values: Record<string, string | undefined> = {
    PROGRAM: program, COMMENT: comment, DATE: fanucDate(), TIME: fanucTime(),
    USER: (() => { try { return os.userInfo().username; } catch { return undefined; } })(),
    ROBOT: uri ? s.data.dataset(uri)?.name : s.data.datasets.length === 1 ? s.data.datasets[0].name : undefined,
    RULE: '-'.repeat(COMMENT_WIDTH),
  };
  for (const field of templatePrompts(t)) {
    const v = await vscode.window.showInputBox({ title: `${t.name} template`, prompt: field.replace(/_/g, ' ').toLowerCase().replace(/^./, c => c.toUpperCase()), placeHolder: `leave empty to keep \${${field}}` });
    if (v === undefined) return undefined;
    values[field] = v.trim() || undefined;
  }
  const out = expandTemplate(t, values);
  if (out.tooLong.length) vscode.window.showWarningMessage(`${out.tooLong.length} comment line${out.tooLong.length === 1 ? '' : 's'} of the template run${out.tooLong.length === 1 ? 's' : ''} past the ${COMMENT_WIDTH} characters the pendant shows.`);
  return out.lines;
}

/**
 * `robotCode.tp.insertTemplate`: a template's body at the cursor (inside /MN, else at the
 * top of the body), unnumbered - the renumber that follows numbers it. Mirrors Insert
 * Program Header.
 */
export function registerInsertTemplate(
  reg: (id: string, fn: (...a: any[]) => any) => void,
  s: FanucServices,
  tpEditor: () => vscode.TextEditor | undefined,
  applyRenumber: (doc: vscode.TextDocument) => Promise<unknown>,
): void {
  reg('robotCode.tp.insertTemplate', async () => {
    const ed = tpEditor(); if (!ed) return;
    const prog = s.tp.get(ed.document);
    const t = await pickProgramTemplate('Which program template?');
    if (!t) return;
    if (!t.lines.length) { vscode.window.showInformationMessage(`"${t.name}" has no body lines to insert.`); return; }
    const lines = await resolveTemplateLines(s, t, prog.header.name, prog.header.attrs.get('COMMENT')?.value.replace(/^"|"$/g, ''), ed.document.uri);
    if (!lines) return;
    const cursor = ed.selection.active.line;
    const mn = prog.sections.mn;
    const end = prog.sections.pos ?? prog.sections.end ?? ed.document.lineCount;
    const at = mn !== undefined && cursor > mn && cursor < end ? cursor : mn !== undefined ? mn + 1 : cursor;
    await ed.edit(b => b.insert(new vscode.Position(at, 0), unnumberedBodyLines(lines, config<number>('tp.lineNumberWidth', 4)).join('\n') + '\n'));
    await applyRenumber(ed.document);
  });
}
