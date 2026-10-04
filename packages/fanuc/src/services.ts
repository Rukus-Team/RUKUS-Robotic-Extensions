/**
 * FANUC's services: core's shared services plus the FANUC data store (.va register dumps),
 * the TP and KAREL parse caches and the $-variable reference. Split out of core's
 * services.ts in monorepo phase 2; every FANUC module takes this type.
 */
import * as vscode from 'vscode';
import { Services } from '@core/services';
import { ParseCache } from '@core/util';
import { DataStore } from './data/dataStore';
import { parseTp, type TpProgram } from './tp/parser';
import { parseKarel, type KProgram } from './karel/parser';
import type { SysVarsReference } from './data/sysVarsReference';

export class FanucServices extends Services<DataStore> {
  readonly tp = new ParseCache<TpProgram>(parseTp);
  readonly karel = new ParseCache<KProgram>(parseKarel);
  /** `$` system variable reference (RUKUS data); set by the extension, which knows its own path */
  sysvars!: SysVarsReference;
  private readonly closeSub: vscode.Disposable;

  constructor() {
    super(new DataStore());
    // A reopened document starts again at version 1, possibly with different text (a file
    // re-read from a controller, a backup pulled over a closed file): never keep its parse.
    this.closeSub = vscode.workspace.onDidCloseTextDocument(d => { this.tp.drop(d.uri); this.karel.drop(d.uri); });
  }

  override dispose() {
    this.closeSub.dispose();
    this.sysvars?.dispose();
    super.dispose();
  }
}
