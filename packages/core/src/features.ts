/**
 * Features as On / Off / Auto, and profiles that set them all at once (All, FANUC only, ABB only,
 * Auto) - or Custom, each feature as the user sets it.
 *
 * A feature is one of the settings the extension already reads (and the manifest's `when` clauses
 * test): On writes it true, Off false, Auto removes it so its own default or detection decides
 * (FANUC / ABB: what the workspace holds; the others: their default). So a profile changes
 * nothing that is not also visible, and changeable, one setting at a time; `robotCode.featureProfile`
 * only says which preset the user picked. Pure: the VS Code side is src/featureProfile.ts.
 */

export type FeatureMode = 'on' | 'off' | 'auto';
export type ProfileId = 'auto' | 'all' | 'fanucOnly' | 'abbOnly' | 'custom';

export interface Feature {
  id: string;
  label: string;
  /** the setting under robotCode. it is */
  setting: string;
  /** what Auto means for it, in words */
  auto: string;
  /** needs a window reload to take effect */
  reload: boolean;
}

export const FEATURES: readonly Feature[] = [
  { id: 'fanuc', label: 'FANUC (TP, KAREL, controller data)', setting: 'fanuc.enabled', auto: 'on unless the workspace holds only ABB files', reload: true },
  { id: 'abb', label: 'ABB (RAPID, controllers)', setting: 'abb.enabled', auto: 'on when the workspace holds ABB files', reload: true },
  { id: 'robotConnections', label: 'Robot connections (experimental)', setting: 'experimental.robotConnections', auto: 'off', reload: false },
  { id: 'rukus', label: 'RUKUS hand-off buttons', setting: 'rukus.enabled', auto: 'on', reload: false },
  { id: 'fileIcons', label: 'Robot Code file icons', setting: 'fileIcons.enabled', auto: 'on', reload: false },
];

export const PROFILES: readonly { id: ProfileId; label: string; detail: string; modes?: Record<string, FeatureMode>; brands?: string }[] = [
  { id: 'auto', label: 'Auto', detail: 'Every feature decides for itself: the brands the workspace holds load', modes: { fanuc: 'auto', abb: 'auto' }, brands: 'auto' },
  { id: 'all', label: 'All', detail: 'FANUC and ABB both on, in every workspace', modes: { fanuc: 'on', abb: 'on' }, brands: 'both' },
  { id: 'fanucOnly', label: 'FANUC only', detail: 'FANUC on, ABB off', modes: { fanuc: 'on', abb: 'off' }, brands: 'fanuc' },
  { id: 'abbOnly', label: 'ABB only', detail: 'ABB on, FANUC off', modes: { fanuc: 'off', abb: 'on' }, brands: 'abb' },
  { id: 'custom', label: 'Custom', detail: 'Each feature On, Off or Auto, as you set it' },
];

/** A setting's value -> the feature's mode (unset is Auto). */
export const modeOf = (value: boolean | undefined): FeatureMode => (value === undefined ? 'auto' : value ? 'on' : 'off');
/** A mode -> what to write (undefined removes the setting). */
export const valueOf = (mode: FeatureMode): boolean | undefined => (mode === 'auto' ? undefined : mode === 'on');

/**
 * The writes a profile makes: each feature it names, and the side bar's brand choice
 * (robotCode.views.brands) to match. Custom names nothing: the features stay as they are.
 */
export function profileWrites(id: ProfileId): { setting: string; value: unknown }[] {
  const p = PROFILES.find(x => x.id === id);
  if (!p?.modes) return [];
  const out: { setting: string; value: unknown }[] = Object.entries(p.modes).map(([f, m]) => ({ setting: FEATURES.find(x => x.id === f)!.setting, value: valueOf(m) }));
  if (p.brands) out.push({ setting: 'views.brands', value: p.brands === 'auto' ? undefined : p.brands });
  return out;
}

/** Which profile the current settings amount to (by the brand features), else Custom. */
export function profileOf(values: Record<string, boolean | undefined>): ProfileId {
  for (const p of PROFILES) {
    if (!p.modes) continue;
    if (Object.entries(p.modes).every(([f, m]) => modeOf(values[FEATURES.find(x => x.id === f)!.setting]) === m)) return p.id;
  }
  return 'custom';
}
