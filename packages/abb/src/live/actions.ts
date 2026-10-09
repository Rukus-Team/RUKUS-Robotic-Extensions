/**
 * The ABB controller's Actions: the commands that CHANGE a controller - speed override, motors,
 * RAPID start / stop / PP to Main, load and unload a module, set an output, write a RAPID value,
 * and request / release write access. Each one asks first (a modal that says what will change),
 * except Stop. They run through AbbControllers.control, which logs the write, reads the state
 * again after it, and explains an OmniCore that refuses for want of write access.
 *
 * Every command takes (controller name or tree node, opts?). `opts` is for tests and scripts: given,
 * nothing is asked - not even the confirmation - as with Back Up and Download. A command returns
 * true when the controller took the write, false when it refused (the error is shown).
 */
import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { controlStationName, type AbbControllers, type AbbConnection } from './controllers';
import type { RwsSignal } from '../rws/client';
import { ctrlStateLabel, opModeLabel, execStateLabel, runModeLabel, taskTypeLabel } from './names';

type NameOf = (node?: any, only?: (c: AbbConnection) => boolean) => Promise<string | undefined>;

/** The commands, in the order the page and the context menu show them. */
export const ABB_ACTIONS = [
  'robotCode.abb.setSpeed', 'robotCode.abb.motorsOn', 'robotCode.abb.motorsOff',
  'robotCode.abb.startRapid', 'robotCode.abb.stopRapid', 'robotCode.abb.resetProgramPointer',
  'robotCode.abb.loadModule', 'robotCode.abb.unloadModule', 'robotCode.abb.setSignal', 'robotCode.abb.setRapidData',
  'robotCode.abb.requestWriteAccess', 'robotCode.abb.releaseWriteAccess',
] as const;

export const SPEEDS = [100, 75, 50, 25, 10, 5];

/** `MODULE Foo(SYSMODULE)` -> Foo */
export function moduleNameIn(text: string): string | undefined { return /^\s*MODULE\s+(\w+)/im.exec(text)?.[1]; }

/** The file name a module is uploaded as: the local file's, or `<MODULE name>.mod` for an untitled editor. */
export function uploadName(localPath: string | undefined, text: string): string | undefined {
  const base = localPath ? path.basename(localPath) : undefined;
  if (base && /\.(mod|modx|sys|sysx)$/i.test(base)) return base;
  const mod = moduleNameIn(text);
  return mod ? `${mod}.mod` : base;
}


export function registerAbbActions(ctx: vscode.ExtensionContext, ctrls: AbbControllers, nameOf: NameOf): void {
  const reg = (id: string, fn: (...a: any[]) => any) => ctx.subscriptions.push(vscode.commands.registerCommand(id, fn));
  const show = (e: unknown) => void vscode.window.showErrorMessage(`ABB: ${(e as any)?.message ?? e}`);
  const connected = (node?: any) => nameOf(node, c => c.state === 'connected');
  const confirm = async (message: string, detail: string, button: string) => (await vscode.window.showWarningMessage(message, { modal: true, detail }, button)) === button;
  const done = (msg: string) => vscode.window.setStatusBarMessage(`$(check) ${msg}`, 4000);
  const panelText = (c: AbbConnection) => {
    const p = c.snapshot.panel;
    return p ? `Now: ${ctrlStateLabel(p.ctrlState) ?? '?'}, ${opModeLabel(p.opMode) ?? '?'}, speed ${p.speedRatio}%, RAPID ${execStateLabel(c.snapshot.execution?.state) ?? '?'}, run mode ${runModeLabel(c.snapshot.execution?.cycle) ?? '?'}.` : '';
  };
  /** a task of the controller: the only one, or the user's pick (motion tasks first) */
  const pickTask = async (c: AbbConnection, title: string): Promise<string | undefined> => {
    const tasks = [...(c.snapshot.tasks ?? [])].sort((a, b) => +b.motion - +a.motion || a.name.localeCompare(b.name));
    if (!tasks.length) { vscode.window.showInformationMessage(`${c.profile.name}: read the tasks first (Get).`); return undefined; }
    if (tasks.length === 1) return tasks[0].name;
    return (await vscode.window.showQuickPick(tasks.map(t => ({ label: t.name, description: [t.motion ? 'motion task' : taskTypeLabel(t.type), execStateLabel(t.execState)].filter(Boolean).join(' · ') })), { title }))?.label;
  };

  reg('robotCode.abb.setSpeed', async (node?: any, percent?: number) => {
    const name = await connected(node); if (!name) return;
    const c = ctrls.get(name)!;
    const now = c.snapshot.panel?.speedRatio;
    let v = percent;
    if (v === undefined) {
      const pick = await vscode.window.showQuickPick([...SPEEDS.map(s => ({ label: `${s}%`, value: s, description: s === now ? 'now' : undefined })), { label: 'Other…', value: -1, description: '0-100' }],
        { title: `Speed override on ${name}${now !== undefined ? ` (now ${now}%)` : ''}` });
      if (!pick) return;
      v = pick.value;
      if (v < 0) {
        const typed = await vscode.window.showInputBox({ title: `Speed override on ${name}`, prompt: 'Percent, 0-100', value: String(now ?? 100), validateInput: t => (/^\d{1,3}$/.test(t.trim()) && +t <= 100 ? undefined : 'A whole number from 0 to 100') });
        if (typed === undefined) return;
        v = +typed.trim();
      }
      if (!(await confirm(`Set the speed override of ${name} to ${v}%?`, `${now !== undefined ? `It is ${now}% now. ` : ''}Every move RAPID makes runs at this share of its programmed speed.`, `Set ${v}%`))) return;
    }
    try { await ctrls.control(name, `speed override ${v}%`, cl => cl.setSpeedRatio(v!)); done(`${name}: speed ${v}%`); return true; } catch (e) { show(e); return false; }
  });

  const motors = (on: boolean) => async (node?: any, yes?: boolean) => {
    const name = await connected(node); if (!name) return;
    const c = ctrls.get(name)!;
    if (!yes && !(await confirm(`Turn the motors ${on ? 'on' : 'off'} on ${name}?`,
      `${panelText(c)} ${on ? 'Motors on needs AUTO mode (in manual the enabling device decides). With motors on the robot can move as soon as RAPID runs.' : 'Motors off stops any motion and RAPID with it.'}`, on ? 'Motors On' : 'Motors Off'))) return;
    try { await ctrls.control(name, `motors ${on ? 'on' : 'off'}`, cl => cl.setMotors(on)); done(`${name}: motors ${on ? 'on' : 'off'}`); return true; } catch (e) { show(e); return false; }
  };
  reg('robotCode.abb.motorsOn', motors(true));
  reg('robotCode.abb.motorsOff', motors(false));

  reg('robotCode.abb.startRapid', async (node?: any, cycle?: 'once' | 'forever') => {
    const name = await connected(node); if (!name) return;
    const c = ctrls.get(name)!;
    let mode = cycle;
    if (!mode) {
      const pp = c.snapshot.tasks?.filter(t => t.motion).map(t => { const p = c.snapshot.pointers?.get(t.name)?.program; return p ? `${t.name} at ${p.module} › ${p.routine}${p.begin ? ` line ${p.begin.line}` : ''}` : undefined; }).filter(Boolean).join('; ');
      const pick = await vscode.window.showQuickPick([
        { label: runModeLabel('once')!, description: 'run main once, then stop', value: 'once' as const },
        { label: runModeLabel('forever')!, description: 'run main over and over until stopped', value: 'forever' as const },
      ], { title: `Start RAPID on ${name}` });
      if (!pick) return;
      mode = pick.value;
      if (!(await confirm(`Start RAPID on ${name} in ${pick.label}? THE ROBOT WILL MOVE.`,
        `${panelText(c)}${pp ? ` Program pointer (last read): ${pp}.` : ''} RAPID starts from the program pointer, at the speed override. Make sure nobody is in the cell.`, `Start (${pick.label})`))) return;
    }
    try { await ctrls.control(name, `RAPID start (${runModeLabel(mode)})`, cl => cl.startRapid(mode), ['state', 'tasks']); done(`${name}: RAPID started`); return true; } catch (e) { show(e); return false; }
  });

  // Stop asks nothing: stopping is always allowed to be quick
  reg('robotCode.abb.stopRapid', async (node?: any) => {
    const name = await connected(node); if (!name) return;
    try { await ctrls.control(name, 'RAPID stop', cl => cl.stopRapid(), ['state', 'tasks']); done(`${name}: RAPID stopped`); return true; } catch (e) { show(e); return false; }
  });

  reg('robotCode.abb.resetProgramPointer', async (node?: any, yes?: boolean) => {
    const name = await connected(node); if (!name) return;
    if (!yes && !(await confirm(`Move the program pointer to Main on ${name}?`, 'Every normal task\'s program pointer goes to the start of its main routine; RAPID must be stopped. The next start runs from there.', 'PP to Main'))) return;
    try { await ctrls.control(name, 'program pointer to Main', cl => cl.resetProgramPointer(), ['state', 'tasks']); done(`${name}: PP to Main`); return true; } catch (e) { show(e); return false; }
  });

  /** opts: { file: a local path; task } - the file is uploaded under its own name */
  reg('robotCode.abb.loadModule', async (node?: any, opts?: { file: string; task: string }) => {
    const name = await connected(node); if (!name) return;
    const c = ctrls.get(name)!;
    let text: string, local: string | undefined, from: string;
    if (opts) { text = await fs.readFile(opts.file, 'utf8'); local = opts.file; from = opts.file; }
    else {
      const ed = vscode.window.activeTextEditor;
      const items: (vscode.QuickPickItem & { id: 'editor' | 'file' })[] = [];
      if (ed?.document.languageId === 'abb-rapid') items.push({ label: `$(edit) ${path.basename(ed.document.uri.path)}`, description: `the open editor${ed.document.isDirty ? ' (with its unsaved changes)' : ''}`, id: 'editor' });
      items.push({ label: '$(folder-opened) Choose a file…', description: '.mod / .modx / .sys / .sysx', id: 'file' });
      const src = items.length === 1 ? items[0] : await vscode.window.showQuickPick(items, { title: `Load a module into ${name}` });
      if (!src) return;
      if (src.id === 'editor') { text = ed!.document.getText(); local = ed!.document.isUntitled ? undefined : ed!.document.uri.fsPath; from = ed!.document.isUntitled ? 'the open editor' : local!; }
      else {
        const f = await vscode.window.showOpenDialog({ title: `Load a module into ${name}`, canSelectMany: false, filters: { 'RAPID modules': ['mod', 'modx', 'sys', 'sysx'], 'All files': ['*'] }, defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri });
        if (!f?.[0]) return;
        local = f[0].fsPath; from = local; text = Buffer.from(await vscode.workspace.fs.readFile(f[0])).toString('utf8');
      }
    }
    const file = uploadName(local, text);
    const mod = moduleNameIn(text);
    if (!file || !mod) { vscode.window.showErrorMessage(`ABB: ${from} has no MODULE line - not a RAPID module.`); return; }
    const task = opts?.task ?? await pickTask(c, `Load ${mod} into which task of ${name}?`); if (!task) return;
    const loaded = c.snapshot.modules?.get(task)?.some(m => m.name.toUpperCase() === mod.toUpperCase());
    if (!opts && !(await confirm(`Load ${mod} into ${task} on ${name}?`,
      `Uploads ${from} to $HOME/${file} on the controller (replacing a file of that name), then loads it into ${task}.${loaded ? ` ${mod} is loaded already: it is replaced (RAPID must be stopped).` : ''}`, loaded ? `Replace ${mod}` : 'Load'))) return;
    try {
      await ctrls.control(name, `load ${mod} into ${task} from $HOME/${file}`, async cl => { await cl.uploadFile(`$HOME/${file}`, Buffer.from(text, 'utf8')); await cl.loadModule(task, `$HOME/${file}`, true); }, ['state', 'tasks']);
      done(`${name}: ${mod} loaded into ${task}`);
      return true;
    } catch (e) { show(e); return false; }
  });

  /** opts: { task, module }; a module node of the ABB Controllers view gives both */
  reg('robotCode.abb.unloadModule', async (node?: any, opts?: { task: string; module: string }) => {
    const name = await connected(node); if (!name) return;
    const c = ctrls.get(name)!;
    let task = opts?.task ?? (node?.type === 'module' ? node.task : undefined);
    let mod: string | undefined = opts?.module ?? (node?.type === 'module' ? node.m.name : undefined);
    const ask = !opts;
    if (!task) task = await pickTask(c, `Unload a module from which task of ${name}?`);
    if (!task) return;
    if (!mod) {
      const list = [...(c.snapshot.modules?.get(task) ?? [])].sort((a, b) => +(a.type === 'SysMod') - +(b.type === 'SysMod') || a.name.localeCompare(b.name));
      if (!list.length) { vscode.window.showInformationMessage(`${name}: no modules read for ${task} (Get the tasks first).`); return; }
      mod = (await vscode.window.showQuickPick(list.map(m => ({ label: m.name, description: m.type === 'SysMod' ? 'system module' : 'program module' })), { title: `Unload which module from ${task}?` }))?.label;
      if (!mod) return;
    }
    const sys = c.snapshot.modules?.get(task)?.find(m => m.name === mod)?.type === 'SysMod';
    if (ask && !(await confirm(`Unload ${mod} from ${task} on ${name}?`,
      `${mod} leaves the task's memory (its file on the controller stays). RAPID must be stopped.${sys ? ' It is a SYSTEM module: routines and data other modules use may go with it.' : ''} Take a backup first if it holds changes made on the pendant.`, 'Unload'))) return;
    try { await ctrls.control(name, `unload ${mod} from ${task}`, cl => cl.unloadModule(task!, mod!), ['state', 'tasks']); done(`${name}: ${mod} unloaded`); return true; } catch (e) { show(e); return false; }
  });

  /** opts: { path (as the signal list gives it), value } */
  reg('robotCode.abb.setSignal', async (node?: any, opts?: { path: string; value: string }) => {
    const name = await connected(node); if (!name) return;
    const c = ctrls.get(name)!;
    let sig: Pick<RwsSignal, 'path' | 'name' | 'type' | 'value'> | undefined, value = opts?.value;
    if (opts) sig = c.snapshot.signals?.find(s => s.path === opts.path) ?? { path: opts.path, name: opts.path.split('/').pop()!, type: 'DO', value: '?' };
    else {
      let list: RwsSignal[];
      try { list = await ctrls.calc(name, 'signals', cl => cl.signals()); } catch (e) { show(e); return; }
      const outs = list.filter(s => ['DO', 'GO', 'AO'].includes(s.type)).sort((a, b) => ['DO', 'GO', 'AO'].indexOf(a.type) - ['DO', 'GO', 'AO'].indexOf(b.type) || a.name.localeCompare(b.name));
      if (!outs.length) { vscode.window.showInformationMessage(`${name} has no output signals.`); return; }
      const pick = await vscode.window.showQuickPick(outs.map(s => ({ label: s.name, description: `${s.type} = ${s.value}${s.state && s.state !== 'not simulated' ? ` (${s.state})` : ''}${s.category ? ` · ${s.category}` : ''}`, detail: s.path, s })), { title: `Set an output on ${name}`, matchOnDetail: true });
      if (!pick) return;
      sig = pick.s;
      if (sig.type === 'DO') value = (await vscode.window.showQuickPick([{ label: '1', description: 'on' }, { label: '0', description: 'off' }].map(i => ({ ...i, description: `${i.description}${i.label === sig!.value ? ' · now' : ''}` })), { title: `${sig.name} (now ${sig.value})` }))?.label;
      else value = await vscode.window.showInputBox({ title: `${sig.name} (${sig.type}, now ${sig.value})`, value: sig.value, prompt: sig.type === 'AO' ? 'A number in the signal\'s range' : 'A whole number the group\'s bits can hold' });
      if (value === undefined) return;
      value = value.trim();
      if (!(await confirm(`Set ${sig.name} to ${value} on ${name}?`, `${sig.type} ${sig.path}, now ${sig.value}. Whatever is wired to it, or a RAPID program reading it, reacts at once.`, `Set ${value}`))) return;
    }
    try {
      await ctrls.control(name, `set ${sig!.path} = ${value}`, cl => cl.setSignal(sig!.path, value!), []);
      if (c.snapshot.at.get('signals')) await ctrls.readExtra(name, 'signals').catch(() => undefined);
      done(`${name}: ${sig!.name} = ${value}`);
      return true;
    } catch (e) { show(e); return false; }
  });

  /** opts: { task, module?, name, value } - value as RAPID writes it */
  reg('robotCode.abb.setRapidData', async (node?: any, opts?: { task: string; module?: string; name: string; value: string }) => {
    const name = await connected(node); if (!name) return;
    const c = ctrls.get(name)!;
    let target = opts;
    if (!target) {
      const task = await pickTask(c, `Write a RAPID value in which task of ${name}?`); if (!task) return;
      const sym = await vscode.window.showInputBox({ title: `Write a RAPID value in ${task}`, prompt: 'The data\'s name, or Module/name for data local to a module', placeHolder: 'nCount or MainModule/nCount', validateInput: v => (/^\s*(\w+\/)?\w+\s*$/.test(v) ? undefined : 'A RAPID name, optionally Module/name') });
      if (!sym) return;
      const [a, b] = sym.trim().split('/');
      const module = b ? a : undefined, data = b ?? a;
      let now: string | undefined;
      try { now = await ctrls.calc(name, `read ${task}/${sym.trim()}`, cl => cl.symbol(task, data, module)); } catch (e) { show(e); return; }
      if (now === undefined) { vscode.window.showErrorMessage(`ABB: ${name} has no data ${sym.trim()} in ${task}.`); return; }
      const value = await vscode.window.showInputBox({ title: `${task}/${sym.trim()} (now ${now})`, value: now, prompt: 'The new value, as RAPID writes it: 5, TRUE, "text", [1,2,3]' });
      if (value === undefined || value.trim() === now) return;
      target = { task, module, name: data, value: value.trim() };
      if (!(await confirm(`Write ${data} on ${name}?`, `${task}/${sym.trim()}: ${now}  →  ${target.value}\nA running program uses the new value from its next read. Only VAR and PERS data can be written; a PERS value is also what a backup saves.`, 'Write'))) return;
    }
    const t = target;
    try { await ctrls.control(name, `write ${t.task}/${t.module ? `${t.module}/` : ''}${t.name} = ${t.value}`, cl => cl.setRapidData(t.task, t.name, t.value, t.module), []); done(`${name}: ${t.name} written`); return true; } catch (e) { show(e); return false; }
  });

  /**
   * Request write access. IRC5 (RW 6) and RobotWare 7: mastership of every domain, held until
   * released. RobotWare 8: this PC as a remote control station - registered in each session (it
   * does not outlive one) under a GUID made once per controller and a numeric PIN (asked once, kept
   * in secret storage, asked again when the controller turns it down) - then write access, then the
   * status read back to see that this PC's id holds it. `pin` is for tests and scripts.
   */
  reg('robotCode.abb.requestWriteAccess', async (node?: any, yes?: boolean, pin?: string) => {
    const name = await connected(node); if (!name) return;
    const c = ctrls.get(name)!;
    const station = c.client?.usesControlStation === true;
    const blocked = ctrls.writeBlocked(name);
    if (blocked) { show(blocked); return false; }
    if (!yes && !(await confirm(`Request write access to ${name}?`, station
      ? `This PC asks to be the control station that may change ${name} (as "${controlStationName()}"); the FlexPendant may have to grant it. While it holds write access the pendant cannot make changes until it is released.`
      : `This session takes mastership of RAPID, configuration and motion and keeps it until Release; meanwhile the FlexPendant cannot edit RAPID or the configuration.`, 'Request'))) return;
    const askPin = () => vscode.window.showInputBox({
      title: `${name}: control station PIN`, prompt: 'A number (digits only). Kept in VS Code\'s secret storage.', password: true, ignoreFocusOut: true,
      validateInput: v => (/^\s*\d+\s*$/.test(v) ? undefined : 'Digits only, no prefix'),
    }).then(v => v?.trim());
    try {
      if (!station) { await ctrls.control(name, 'request mastership (RAPID, configuration, motion)', cl => cl.requestWriteAccess()); done(`${name}: mastership held`); return true; }
      const id = await ctrls.stationId(name);
      const kept = pin ?? await ctrls.getStationPin(name);
      let p = kept ?? await askPin();
      if (!p) return false;
      const request = (pinNow: string) => ctrls.control(name, `register as control station ${id} and request write access`, cl => cl.requestWriteAccess({ name: controlStationName(), id, pin: pinNow }));
      try { await request(p); }
      catch (e) {
        if (!kept || pin) throw e;
        // the kept PIN no longer works: ask once more
        await ctrls.forgetStationPin(name);
        p = await askPin();
        if (!p) return false;
        await request(p);
      }
      await ctrls.setStationPin(name, p);
      const holder = ctrls.get(name)?.snapshot.access?.holder;
      if (ctrls.holdsAccess(name)) done(`${name}: write access held`);
      else vscode.window.showInformationMessage(`${name}: write access requested${holder ? ` - it is held by ${holder}` : ''}. If the FlexPendant asks, grant it there, then press Get on the State card.`);
      return true;
    } catch (e) { show(e); return false; }
  });

  /** RW 8: a write may already have ended write access - then there is nothing to release, and that is no error. */
  reg('robotCode.abb.releaseWriteAccess', async (node?: any, yes?: boolean) => {
    const name = await connected(node); if (!name) return;
    if (!yes && !(await confirm(`Release write access to ${name}?`, 'The FlexPendant (or another control station) can take it again; this PC cannot change the controller until it requests it again.', 'Release'))) return;
    const c = ctrls.get(name)!;
    try {
      const released = await ctrls.control(name, 'release write access', cl => cl.releaseWriteAccess(cl.usesControlStation ? c.stationId : undefined));
      done(released ? `${name}: write access released` : `${name}: write access was no longer held`);
      return true;
    } catch (e) { show(e); return false; }
  });
}
