/**
 * ABB's tab in core's Robot Connections form (core/live/connectionKinds.ts): the fields of an
 * ABB profile, and saving, testing and connecting them through AbbControllers.
 *
 * A new controller starts at 192.168.125.1 - the IRC5 / OmniCore service (programming) port,
 * which is the same address on every ABB controller - with Default User. Profiles go to the
 * `robotCode.abb.controllers` setting (the workspace's when a folder is open, so a cluster's
 * folder carries its ABB controllers), passwords to secret storage.
 */
import * as vscode from 'vscode';
import type { ConnectionKind, ConnectionTest } from '@core/live/connectionKinds';
import { RwsClient } from '../rws/client';
import { AbbControllers, type AbbProfile } from './controllers';

export const ABB_SERVICE_PORT_IP = '192.168.125.1';

/** the form's fields back into a profile; defaults are left out so settings stay short */
export function profileFromForm(p: Record<string, unknown>): AbbProfile {
  const str = (k: string) => (typeof p[k] === 'string' ? (p[k] as string).trim() : '');
  let host = str('host'), port = typeof p.port === 'number' && p.port > 0 ? Math.round(p.port) : undefined;
  // "127.0.0.1:57289" typed into the address, as the old prompt took it
  const hp = /^(.+):(\d{1,5})$/.exec(host);
  if (hp) { host = hp[1]; port ??= +hp[2]; }
  const family = str('family') === 'omnicore' ? 'omnicore' : undefined;
  const user = str('user'), mechUnit = str('mechUnit');
  return {
    name: str('name'), ...(family ? { family } : {}), host, ...(port ? { port } : {}),
    ...(p.https === true ? { https: true } : {}),
    ...(user && user !== 'Default User' ? { user } : {}),
    ...(mechUnit && mechUnit.toUpperCase() !== 'ROB_1' ? { mechUnit } : {}),
  };
}

function formFromProfile(p: AbbProfile): Record<string, unknown> {
  return { family: p.family ?? 'irc5', name: p.name, host: p.host, port: p.port ?? '', https: !!p.https, user: p.user ?? 'Default User', mechUnit: p.mechUnit ?? 'ROB_1' };
}

function hintFor(err: string, p: AbbProfile): string {
  if (/ECONNREFUSED/.test(err)) return p.host.startsWith('127.') ? 'Nothing listens there. A RobotStudio virtual controller picks a new port each time it starts - find it with Get-NetTCPConnection -OwningProcess (Get-Process RobVC).Id -State Listen.' : 'The controller refused the port. RWS answers on 80 (HTTP) on the service port; check the port and HTTPS settings.';
  if (/timeout|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH/i.test(err)) return p.host === ABB_SERVICE_PORT_IP ? 'No answer on the service port. Is the PC cabled to the controller\'s service port (X2 on IRC5, MGMT on OmniCore) with DHCP or a fixed 192.168.125.x address?' : 'No answer. Check the IP and that the PC is on the robot network.';
  if (/\b401\b/.test(err)) return 'Login refused. The factory login is Default User / robotics; a controller with UAS set up needs a user it grants Remote Login.';
  if (/\b503\b/.test(err)) return 'The controller has no free RWS session. Sessions expire after a few minutes of no use, or restart the controller\'s web services.';
  return 'See the Robot Code output channel for the full log.';
}

export function abbConnectionKind(ctrls: AbbControllers): ConnectionKind {
  const cfg = () => vscode.workspace.getConfiguration('robotCode');
  /**
   * The edited list into the workspace's settings when a folder is open (a cluster's folder then
   * carries its ABB controllers), else the user's. It starts from the list in effect, because a
   * workspace list replaces the user's list rather than adding to it.
   */
  const writeList = (edit: (list: AbbProfile[]) => AbbProfile[]) =>
    cfg().update('abb.controllers', edit([...cfg().get<AbbProfile[]>('abb.controllers', [])]), vscode.workspace.workspaceFolders ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global);
  return {
    id: 'abb',
    label: 'ABB',
    onDidChange: ctrls.onDidChange,
    note: `ABB controllers are read over Robot Web Services: IRC5 (RobotWare 6, RWS 1.0) and OmniCore (RobotWare 7/8, RWS 2.0, HTTPS). The service port is ${ABB_SERVICE_PORT_IP} on every controller. Only a Back Up you confirm writes to the controller.`,
    fields: () => [
      { key: 'family', label: 'Controller', type: 'select', options: [
        { value: 'irc5', label: 'IRC5 - RobotWare 6 (RWS 1.0)', sets: { https: false } },
        { value: 'omnicore', label: 'OmniCore - RobotWare 7/8 (RWS 2.0)', sets: { https: true } },
      ] },
      { key: 'name', label: 'Controller name', type: 'text', placeholder: 'IRC5-CELL2' },
      { key: 'host', label: 'IP address', type: 'text', placeholder: ABB_SERVICE_PORT_IP, help: `${ABB_SERVICE_PORT_IP} is the service (programming) port. RobotStudio virtual controller: 127.0.0.1 and its port below.` },
      { key: 'port', label: 'Port', type: 'number', placeholder: 'default (80, or 443 with HTTPS)', help: 'Blank for the default. A RobotStudio virtual controller listens on a port of its own that changes each time it starts.' },
      { key: 'https', label: 'HTTPS', type: 'checkbox', placeholder: 'use HTTPS (OmniCore; the controller\'s self-signed certificate is accepted)' },
      { key: 'user', label: 'RWS user', type: 'text', placeholder: 'Default User' },
      { key: 'password', label: 'Password', type: 'password', placeholder: 'robotics is the factory default' },
      { key: 'mechUnit', label: 'Mechanical unit', type: 'text', placeholder: 'ROB_1', help: 'Whose position Get reads.' },
    ],
    defaults: () => ({ family: 'irc5', name: '', host: ABB_SERVICE_PORT_IP, port: '', https: false, user: 'Default User', mechUnit: 'ROB_1' }),
    list: () => ctrls.list().map(c => ({
      name: c.profile.name,
      host: `${c.profile.host}${c.profile.port ? `:${c.profile.port}` : ''}`,
      state: c.state,
      detail: [(c.profile.family === 'omnicore' ? 'OmniCore' : 'IRC5') + (c.snapshot.system?.robotWareName ? ` · RW ${c.snapshot.system.robotWareName.split('.').slice(0, 2).join('.')}` : ''), c.rukusCluster ? `RUKUS ${c.rukusCluster}` : ''].filter(Boolean).join(' · '),
      profile: formFromProfile(c.profile),
    })),

    async save(form, password, originalName) {
      const p = profileFromForm(form);
      if (!p.name || !p.host) throw new Error('Name and IP address are required.');
      const fromRukus = originalName ? ctrls.clusterOf(originalName) : ctrls.clusterOf(p.name);
      if (fromRukus) throw new Error(`${originalName ?? p.name} comes from RUKUS cluster ${fromRukus} - change it in RUKUS (Edit Robot); it follows here on the next sync.`);
      if (p.name !== originalName && ctrls.get(p.name)) throw new Error(`There is already an ABB controller called ${p.name}.`);
      // a rename keeps the stored password unless a new one was typed
      const oldPassword = originalName && originalName !== p.name ? await ctrls.getPassword(originalName) : undefined;
      if (originalName && originalName !== p.name) await ctrls.disconnect(originalName);
      await writeList(list => {
        const was = originalName ?? p.name;
        return list.some(x => x.name === was) ? list.map(x => (x.name === was ? p : x)) : [...list, p];
      });
      if (password !== undefined) await ctrls.setPassword(p.name, password);
      else if (oldPassword !== undefined) await ctrls.setPassword(p.name, oldPassword);
      if (originalName && originalName !== p.name) await ctrls.forgetPassword(originalName);
      return p.name;
    },

    async remove(name) {
      const fromRukus = ctrls.clusterOf(name);
      if (fromRukus) throw new Error(`${name} comes from RUKUS cluster ${fromRukus} - remove it in RUKUS.`);
      await ctrls.disconnect(name); await ctrls.forgetPassword(name);
      const inspect = cfg().inspect<AbbProfile[]>('abb.controllers');
      for (const [target, value] of [[vscode.ConfigurationTarget.Workspace, inspect?.workspaceValue], [vscode.ConfigurationTarget.Global, inspect?.globalValue]] as const) {
        if (value?.some(p => p.name === name)) await cfg().update('abb.controllers', value.filter(p => p.name !== name), target);
      }
    },

    async test(form, password, originalName): Promise<ConnectionTest> {
      const p = profileFromForm(form);
      const started = Date.now();
      const ms = () => Date.now() - started;
      if (!p.host) return { ok: false, ms: 0, text: 'Enter the IP address first.' };
      const pw = password ?? (originalName ? await ctrls.getPassword(originalName) : undefined);
      if (pw === undefined) return { ok: false, ms: 0, text: 'Enter the password to test (robotics is the factory default).' };
      const client = new RwsClient({ host: p.host, port: p.port, family: p.family, https: p.https ?? p.family === 'omnicore', user: p.user ?? 'Default User', password: pw, timeoutMs: 8000 });
      try {
        const sys = await client.system();
        return { ok: true, ms: ms(), text: [sys.name, sys.robotWareName ? `RobotWare ${sys.robotWareName}` : undefined, sys.sysid ? `system ${sys.sysid}` : undefined].filter(Boolean).join(' · '), suggestedName: sys.name };
      } catch (e: any) {
        const msg = e?.message ?? String(e);
        return { ok: false, ms: ms(), text: msg, hint: hintFor(msg, p) };
      } finally { await client.logout(); }
    },

    async connect(name) {
      await vscode.commands.executeCommand('robotCode.abb.connect', name);
    },
    disconnect: name => ctrls.disconnect(name),
  };
}
