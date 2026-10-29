// The colour scheme, see-through and releases for the web pages, from web/server.mjs.
// Pages load /shared/theme.js (a classic script) before their modules; this module uses it.
//
//   import { watchAppearance } from '../shared/look.js'
//   watchAppearance('learn')        // applies now, then follows changes made in any window
import { token } from './api.js';

const T = () => globalThis.ClaudeTheme;
const POLL_MS = 2000;

/** Native app windows (macOS) add class "native" to <html>; only they can be see-through. */
export const isNative = () => document.documentElement.classList.contains('native');

/**
 * The saved appearance, every field checked (today's look where missing); null when the server
 * could not be asked, so a page keeps what it shows rather than falling back to Ember.
 */
export async function loadAppearance() {
  try {
    const response = await fetch('/api/appearance', { headers: { 'X-Learn-Token': token } });
    if (!response.ok) return null;
    return T().parseAppearance(await response.text());
  } catch {
    return null;
  }
}

/** Saves the appearance for every window (throws if the server refuses); others follow within seconds. */
export async function saveAppearance(appearance) {
  const value = T().parseAppearance(appearance);
  const response = await fetch('/api/appearance', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Learn-Token': token },
    body: JSON.stringify({ v: 1, ...value }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  lastText = JSON.stringify(value);
  return value;
}

/** The presets that ship with the plugin: [{name, label, bg, accent, text}]. */
export async function loadPresets() {
  try {
    const response = await fetch('/data/Presets.json');
    return T().parsePresets(response.ok ? await response.text() : null);
  } catch {
    return T().parsePresets(null);
  }
}

/** {version, releases: [{version, date, by, notes}]} from releases.json and plugin.json. */
export async function loadReleases() {
  try {
    const response = await fetch('/api/releases', { headers: { 'X-Learn-Token': token } });
    return response.ok ? await response.json() : { version: null, releases: [] };
  } catch {
    return { version: null, releases: [] };
  }
}

let lastText = '';

/**
 * Applies the appearance for this page's group ('learn' or 'games') now, then checks for a
 * change every two seconds. In a plain browser the background stays solid whatever the
 * opacity says. onChange(appearance, palette) runs after each change. Returns a stop function.
 */
export function watchAppearance(group, onChange) {
  let stopped = false;
  const apply = async () => {
    const appearance = await loadAppearance();
    if (!appearance) return;
    const text = JSON.stringify(appearance);
    if (text === lastText || stopped) return;
    lastText = text;
    const shown = isNative() ? appearance : { ...appearance, opacity: { ...appearance.opacity, [group]: 1 } };
    const palette = T().applyAppearance(shown, group);
    if (onChange) onChange(appearance, palette);
  };
  apply();
  const timer = setInterval(apply, POLL_MS);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

/** Shows an appearance on this page at once (while a control is being dragged), unsaved. */
export function previewAppearance(appearance, group) {
  const shown = isNative() ? appearance : { ...appearance, opacity: { ...appearance.opacity, [group]: 1 } };
  return T().applyAppearance(shown, group);
}
