/**
 * Hover for user / tool frame references: `UFRAME_NUM=3`, `UTOOL_NUM=2`, `UFRAME[3]`,
 * `UTOOL[2]`, and the `UF : 3, UT : 2` header of a /POS block. Shows what that frame IS
 * on this controller - X Y Z W P R from sysframe.va - because the number alone says
 * nothing, and a point taught in the wrong frame is the classic silent mistake.
 */
import * as vscode from 'vscode';
import type { FanucServices } from '../services';
import type { Xyzwpr } from './frameMath';
import { isIdentityFrame } from '../data/sysFrameParser';
import { md } from '@core/util';

const RE_SET = /\b(UFRAME_NUM|UTOOL_NUM)\s*=\s*(\d+|R\[[^\]]*\]|AR\[\d+\])/g;
const RE_IDX = /\b(UFRAME|UTOOL)\[(\d+)\]/g;
const RE_POS = /\bUF\s*:\s*(\d+|F)\s*,\s*UT\s*:\s*(\d+|F)/g;

export function fmtFrame(f: Xyzwpr): string { return `X ${f.x.toFixed(3)} · Y ${f.y.toFixed(3)} · Z ${f.z.toFixed(3)} · W ${f.w.toFixed(3)} · P ${f.p.toFixed(3)} · R ${f.r.toFixed(3)}`; }

export function frameHover(s: FanucServices, doc: vscode.TextDocument, pos: vscode.Position): vscode.Hover | undefined {
  const text = doc.lineAt(pos.line).text;
  const hit = (re: RegExp) => { re.lastIndex = 0; let m: RegExpExecArray | null; while ((m = re.exec(text))) if (pos.character >= m.index && pos.character <= m.index + m[0].length) return m; return null; };
  const ds = s.data.dataset(doc.uri);
  const lines: string[] = [];
  let range: vscode.Range | undefined;

  const describe = (which: 'UF' | 'UT', n: number | 'F' | string) => {
    const table = which === 'UF' ? ds?.frames : ds?.tools;
    const name = which === 'UF' ? 'User frame' : 'Tool frame';
    if (n === 'F') return `**${name}: untaught** — the block was never taught (the controller writes \`F\`).`;
    if (typeof n === 'string' && !/^\d+$/.test(n)) return `**${name} from ${n}** — decided at run time.`;
    const i = typeof n === 'number' ? n : parseInt(n, 10);
    if (i === 0) return `**${name} 0** — ${which === 'UF' ? 'world' : 'the faceplate'}, the identity by definition.`;
    const f = table?.get(i);
    const active = which === 'UF' ? ds?.activeFrame : ds?.activeTool;
    const tag = active === i ? ' _(selected when the backup was taken)_' : '';
    if (!ds || !table?.size) return `**${name} ${i}**${tag}\n\n_No sysframe.va in this robot's backup, so the frame's values are not known here._`;
    if (!f || isIdentityFrame(f)) return `**${name} ${i}**${tag} — ⚠ all zeros on ${ds.label}: never set up (or set to the identity).`;
    return `**${name} ${i}**${tag} _(${ds.label})_\n\n| | |\n|---|---|\n| X · Y · Z | ${f.x.toFixed(3)} · ${f.y.toFixed(3)} · ${f.z.toFixed(3)} mm |\n| W · P · R | ${f.w.toFixed(3)} · ${f.p.toFixed(3)} · ${f.r.toFixed(3)} deg |`;
  };

  let m: RegExpExecArray | null;
  if ((m = hit(RE_SET))) { lines.push(describe(m[1] === 'UFRAME_NUM' ? 'UF' : 'UT', m[2])); range = new vscode.Range(pos.line, m.index, pos.line, m.index + m[0].length); }
  else if ((m = hit(RE_IDX))) { lines.push(describe(m[1] === 'UFRAME' ? 'UF' : 'UT', m[2])); range = new vscode.Range(pos.line, m.index, pos.line, m.index + m[0].length); }
  else if ((m = hit(RE_POS))) { lines.push(describe('UF', m[1]), '', describe('UT', m[2])); range = new vscode.Range(pos.line, m.index, pos.line, m.index + m[0].length); }
  if (!lines.length) return undefined;
  return new vscode.Hover(md(...lines), range);
}
