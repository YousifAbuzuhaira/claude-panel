// The appearance editor's arithmetic (Settings > Appearance), free of the page so node tests
// can import it. An appearance is { preset, colors: {bg, accent, text}, opacity: {panel, learn,
// games} }, as shared/theme.js parses it; every function here returns a new one.

/** The three window groups that each have their own see-through, in the order shown. */
export const GROUPS = [['panel', 'Panel'], ['learn', 'Learn'], ['games', 'Games']];

/** The three colours a scheme is made from, in the order shown. */
export const COLOR_KEYS = [['bg', 'Background'], ['accent', 'Accent'], ['text', 'Text']];

/**
 * '#e08a5f' or 'E08A5F' to '#E08A5F'; null for anything else. Six digits only: a box shows
 * its colour as it's typed, and '#E08' on the way to '#E08A5F' must not flash as '#EE0088'.
 */
export function normalizeHex(text) {
  const raw = String(text ?? '').trim().replace(/^#/, '');
  return /^[0-9a-f]{6}$/i.test(raw) ? `#${raw.toUpperCase()}` : null;
}

const copyOpacity = appearance => ({ ...(appearance?.opacity || {}) });

/** A preset picked: its three colours, the see-through as it was. */
export function withPreset(appearance, preset) {
  return {
    preset: preset.name,
    colors: { bg: preset.bg.toUpperCase(), accent: preset.accent.toUpperCase(), text: preset.text.toUpperCase() },
    opacity: copyOpacity(appearance),
  };
}

/**
 * Colours typed or picked (each already normalized). They count as a preset when they are
 * exactly one, so its swatch stays marked; anything else is 'custom'.
 */
export function withColors(appearance, colors, presets = []) {
  const same = presets.find(p => COLOR_KEYS.every(([key]) => String(p[key]).toUpperCase() === colors[key]));
  return { preset: same ? same.name : 'custom', colors: { ...colors }, opacity: copyOpacity(appearance) };
}

/** One group's see-through, `value` from 0 to 1. */
export function withOpacity(appearance, group, value) {
  return { preset: appearance.preset, colors: { ...appearance.colors }, opacity: { ...copyOpacity(appearance), [group]: value } };
}

/** The name of the swatch to mark: the preset, or 'custom' when the colours are no preset's. */
export function shownScheme(appearance, presets) {
  const named = presets.find(p => p.name === appearance.preset);
  if (named) return named.name;
  return withColors(appearance, appearance.colors, presets).preset;
}

/**
 * The colours the Custom swatch shows: the current ones when they are your own, else the last
 * of your own that were used (`remembered`), so picking a preset never loses them. Null: none yet.
 */
export function customColours(appearance, presets, remembered) {
  if (shownScheme(appearance, presets) === 'custom') return { ...appearance.colors };
  return remembered ? { bg: remembered.bg, accent: remembered.accent, text: remembered.text } : null;
}

export const sameColours = (a, b) => Boolean(a && b) && COLOR_KEYS.every(([key]) => String(a[key]).toUpperCase() === String(b[key]).toUpperCase());

/** Below this a light scheme loses its text against a dark terminal showing through. */
export const LIGHT_SEE_THROUGH_MIN = 0.6;

/** The see-through note for a light scheme that is clearer than reads well, else ''. */
export function seeThroughWarning(appearance, isDark) {
  if (isDark) return '';
  const low = GROUPS.some(([group]) => Number(appearance?.opacity?.[group]) < LIGHT_SEE_THROUGH_MIN);
  return low ? `A light scheme over a dark terminal reads best above ${percent(LIGHT_SEE_THROUGH_MIN)}.` : '';
}

/** 0.96 to '96%'. */
export const percent = value => `${Math.round(Number(value) * 100)}%`;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** '2026-10-29' to '29 Oct', as the panel's Releases tab shows it; '' when it isn't a date. */
export function shortDate(iso) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  if (!match || Number(match[2]) < 1 || Number(match[2]) > 12) return '';
  return `${Number(match[3])} ${MONTHS[Number(match[2]) - 1]}`;
}

/** A release's first line: '0.2.0 · 29 Oct · Mahmood'. */
export function releaseLine(release) {
  return [release.version, releaseMeta(release)].filter(Boolean).join(' · ');
}

/** When and who: '29 Oct · Mahmood'. */
export function releaseMeta(release) {
  return [shortDate(release.date), String(release.by || '').trim()].filter(Boolean).join(' · ');
}
