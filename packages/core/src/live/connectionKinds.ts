/**
 * Other brands' controllers in the Robot Connections form.
 *
 * The form is core's and was FANUC's alone; a brand whose controllers are kept somewhere else
 * (ABB: the `robotCode.abb.controllers` setting and its own AbbControllers) registers a kind
 * here, and the form shows a FANUC / <brand> selector, lists that brand's controllers beside
 * the FANUC ones and hands the brand its own fields. Core never learns what the fields mean:
 * a profile crosses as a plain object and the brand reads it back.
 */
import * as vscode from 'vscode';

export interface ConnectionRow {
  name: string;
  host: string;
  state: string;
  /** short text after the host in the list: 'IRC5', 'RobotWare 6.16' */
  detail?: string;
  /** the fields the form edits, as the brand wants them back */
  profile: Record<string, unknown>;
}

export interface ConnectionTest {
  ok: boolean;
  ms: number;
  /** one line: what answered ('IRC5_6_16 · RobotWare 6.16.3') or what went wrong */
  text: string;
  hint?: string;
  /** a name the controller calls itself, offered when the form's name is empty */
  suggestedName?: string;
}

/** one input on the form; `password` is never stored in the profile, it goes to `save`/`test` on its own */
export interface ConnectionField {
  key: string;
  label: string;
  type: 'text' | 'number' | 'password' | 'checkbox' | 'select';
  placeholder?: string;
  help?: string;
  /** for a select; choosing an option also sets the fields in `sets` (OmniCore -> HTTPS on) */
  options?: { value: string; label: string; sets?: Record<string, unknown> }[];
}

export interface ConnectionKind {
  /** the brand id: 'abb' */
  readonly id: string;
  /** 'ABB' */
  readonly label: string;
  readonly onDidChange: vscode.Event<unknown>;
  /** the form's inputs, in order; `name` and `host` are expected among them */
  fields(): ConnectionField[];
  /** a paragraph under the form: what the connection does and does not do */
  note?: string;
  list(): ConnectionRow[];
  /** the fields a new controller starts with */
  defaults(): Record<string, unknown>;
  /** returns the saved name; `originalName` is set when an existing one was edited (and maybe renamed) */
  save(profile: Record<string, unknown>, password: string | undefined, originalName: string | undefined): Promise<string>;
  /** already confirmed by the form */
  remove(name: string): Promise<void>;
  /** `originalName`: the saved controller being edited, whose stored password stands in for a blank one */
  test(profile: Record<string, unknown>, password: string | undefined, originalName: string | undefined): Promise<ConnectionTest>;
  connect(name: string): Promise<void>;
  disconnect(name: string): Promise<void>;
}

const kinds: ConnectionKind[] = [];
const changed = new vscode.EventEmitter<void>();
/** fires when a kind is registered (the form re-renders its selector) */
export const onDidChangeConnectionKinds = changed.event;

export function registerConnectionKind(kind: ConnectionKind): vscode.Disposable {
  const i = kinds.findIndex(k => k.id === kind.id);
  if (i >= 0) kinds[i] = kind; else kinds.push(kind);
  changed.fire();
  return new vscode.Disposable(() => { const j = kinds.indexOf(kind); if (j >= 0) { kinds.splice(j, 1); changed.fire(); } });
}

export function connectionKinds(): readonly ConnectionKind[] { return kinds; }
export function connectionKind(id: string): ConnectionKind | undefined { return kinds.find(k => k.id === id); }
