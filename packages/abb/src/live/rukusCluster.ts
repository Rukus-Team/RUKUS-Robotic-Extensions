/**
 * The open RUKUS cluster's ABB robots in the ABB Controllers view.
 *
 * RUKUS clusters are mixed (RUKUS #28): each robot says its brand ("Make"). Core turns the
 * FANUC ones into the cell's controllers; this puts the ABB ones in front of AbbControllers
 * whenever the cluster changes - opened, synced, or edited in RUKUS (core watches the file).
 * Nothing is written to settings: the list is RUKUS's, so it goes when the cluster closes.
 *
 * A robot's RWS password is copied into secret storage the first time only, as core does for
 * FANUC FTP passwords. One RUKUS encrypted ("Encrypt robot passwords" on the cluster) is
 * decrypted for this Windows account; one it cannot read is left for the user to enter.
 */
import * as vscode from 'vscode';
import type { RukusClusters } from '@core/rukus/clusters';
import { clusterAbbRobots, type RukusRobot } from '@core/rukus/store';
import { unprotectAll, resolvePassword } from '@core/rukus/dpapi';
import type { AbbControllers, AbbProfile } from './controllers';

/** A RUKUS ABB robot as an ABB Controllers profile; defaults left out, as the settings keep them. */
export function profileFromRukus(r: RukusRobot): AbbProfile {
  const a = r.abb!;
  return {
    name: r.name,
    ...(a.family === 'omnicore' ? { family: 'omnicore' as const } : {}),
    host: r.host,
    ...(a.port ? { port: a.port } : {}),
    ...(a.https ? { https: true } : {}),
    ...(a.user && a.user !== 'Default User' ? { user: a.user } : {}),
    ...(a.mechUnit && a.mechUnit.toUpperCase() !== 'ROB_1' ? { mechUnit: a.mechUnit } : {}),
  };
}

export function followRukusCluster(ctrls: AbbControllers, rukus: RukusClusters, output: vscode.OutputChannel): vscode.Disposable {
  let run = 0;
  const apply = async () => {
    const mine = ++run;
    const current = rukus.current();
    const robots = current ? clusterAbbRobots(current.cluster) : [];
    const decrypted = await unprotectAll(robots.map(r => r.abb?.password ?? ''));
    if (mine !== run) return;   // a newer change arrived while PowerShell was working

    let stored = 0; const unreadable: string[] = [];
    for (const r of robots) {
      if (!r.abb?.password || await ctrls.hasPassword(r.name)) continue;
      const password = resolvePassword(r.abb.password, decrypted);
      if (password === undefined) { unreadable.push(r.name); continue; }
      await ctrls.setPassword(r.name, password);
      stored++;
    }
    ctrls.setClusterProfiles(current?.cluster.name, robots.map(profileFromRukus));
    if (current && robots.length) {
      output.appendLine(`[RUKUS] cluster ${current.cluster.name}: ${robots.length} ABB robot(s) in ABB Controllers`
        + (stored ? `; ${stored} RWS password(s) stored` : '')
        + (unreadable.length ? `; ${unreadable.join(', ')}: password encrypted by another Windows account - enter it on Connect` : ''));
    }
  };
  void apply();
  return rukus.onDidChange(() => void apply());
}
