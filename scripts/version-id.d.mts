export const TYPE_NAMES: Record<number, string>;
export const TYPE_WORDS: Record<string, number>;
export const RELEASE_TYPE: number;
export function makeId(issue: number, start: Date, type: number): string;
export function makeReleaseId(year: number, month: number, n: number): string;
export function typeFromBranch(branch: string | undefined): number | undefined;
export function typeFromWord(word: string | undefined): number | undefined;
export type DecodedId =
  | { ok: false; why: string }
  | { ok: true; form: 'work'; year: number; month: number; day: number; issue: number; type: number; typeName: string; started: string; text: string }
  | { ok: true; form: 'release'; year: number; month: number; release: number; type: number; typeName: string; text: string }
  | { ok: true; form: 'first'; year: number; month: number; day: number; issue: number; type?: number; typeName?: string; started: string; text: string };
export function decodeId(text: string): DecodedId;
export function compareIds(a: string, b: string): number;
export function highestId(list: string[]): string | undefined;
export function nextReleaseNumber(year: number, month: number, released: string[]): number;
export function restampDate(issue: number, top: string, today?: Date, type?: number): Date;
