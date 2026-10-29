// Settings: the colour scheme and see-through every window shares, then the library folder,
// the models, the Advisor's work folders, text size, usage, yt-dlp, and what's new.
import { isNative, loadAppearance, loadPresets, loadReleases, previewAppearance, saveAppearance } from '../shared/look.js';
import { COLOR_KEYS, GROUPS, normalizeHex, percent, releaseMeta, shownScheme, withColors, withOpacity, withPreset } from './appearance.js';
import { S, act, action, chip, formatDate, h, nav, toast } from './core.js';

const MODEL_CHOICES = [['sonnet', 'Sonnet'], ['opus', 'Opus'], ['haiku', 'Haiku']];
const theme = () => globalThis.ClaudeTheme;

let ui = null;

/** `onLibraryChanged`: another library, so nothing cached belongs to it. */
export function buildSettingsView(host, { onLibraryChanged }) {
  // Appearance and About are built once and kept, so a status event never resets a colour
  // being typed or a slider being dragged; the rest is redrawn from the settings.
  const look = h('section.setting');
  const rest = h('div.setting');
  const about = h('section.setting');
  host.append(h('div.settings-view', null, look, rest, about));
  ui = { look, rest, about, usage: null, onLibraryChanged };
  buildAppearance();
  buildAbout();
}

export async function refreshSettings() {
  const settings = await act('settings.get');
  if (!settings) return;
  S.settings = settings;
  showSettings();
}

async function save(change) {
  const before = S.settings?.library;
  const settings = await act('settings.set', { change });
  if (!settings) return;
  if (settings.library !== before) ui.onLibraryChanged();
  S.settings = settings;
  showSettings();
  toast('Saved');
}

const title = (text, note) => h('div.setting-title', null, h('h3', null, text), note ? h('p.dim', null, note) : null);

function usageText() {
  const usage = S.status?.usage;
  if (!usage || usage.fiveHour === null || usage.fiveHour === undefined) return 'No reading yet: it shows after the first build or chat.';
  const week = usage.sevenDay !== null && usage.sevenDay !== undefined ? `, ${percent(usage.sevenDay)} of the weekly limit` : '';
  return `Last reading: ${percent(usage.fiveHour)} of the 5-hour limit${week} (${formatDate(usage.at)}).`;
}

/** A status event while Settings is open: only the usage line changes. */
export function settingsStatus() {
  if (ui?.usage) ui.usage.textContent = usageText();
}

export function showSettings() {
  if (!ui || !S.settings) return;
  const settings = S.settings;
  const out = [];

  const libraryBox = h('input.input.grow.mono', { type: 'text', 'aria-label': 'Library folder' });
  libraryBox.value = settings.library || '';
  out.push(title('Library folder', 'Where your courses, concepts and chats are kept (~/... or a full path). Changing it starts using that folder; nothing is moved.'),
    h('div.add-row', null, libraryBox, h('button.button', { type: 'button', onclick: () => save({ library: libraryBox.value.trim() }) }, 'Use this folder')));

  for (const [key, label, note] of [['build', 'Model that builds courses', 'Research, planning and writing the pages.'], ['chat', 'Model for chat', 'The page chats, the Advisor, and filing concepts you add.']]) {
    const current = settings.models?.[key];
    out.push(title(label, note), h('div.chips', null, MODEL_CHOICES.map(([model, name]) => chip(name, current === model, () => save({ models: { [key]: model } })))));
  }

  const folderBox = h('input.input.grow.mono', { type: 'text', placeholder: 'A folder, e.g. ~/code/my-app', 'aria-label': 'Work folder' });
  const addFolder = () => {
    const path = folderBox.value.trim();
    if (path) save({ workFolders: [...(settings.workFolders || []), path] });
  };
  folderBox.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); addFolder(); } });
  out.push(title('Work folders the Advisor may read', 'It reads them (never writes) to see the stack you really use: package.json, Dockerfiles, CI config, source.'),
    h('div.folders', null, (settings.workFolders || []).map(folder => h('div.folder', null, h('span.mono', { title: folder }, folder),
      action('remove', () => save({ workFolders: settings.workFolders.filter(other => other !== folder) }), 'faint')))),
    h('div.add-row', null, folderBox, h('button.button', { type: 'button', onclick: addFolder }, 'Add')));

  const size = h('span.size', null, `${Math.round(S.textScale * 100)}%`);
  const step = delta => () => {
    nav.setTextScale(S.textScale + delta);
    size.textContent = `${Math.round(S.textScale * 100)}%`;
  };
  out.push(title('Text size', 'The page, its title and the chats. Also Ctrl+= and Ctrl+-.'),
    h('div.size-row', null,
      h('button.button', { type: 'button', title: 'Smaller (Ctrl+-)', 'aria-label': 'Smaller text', onclick: step(-0.1) }, 'A−'),
      size,
      h('button.button', { type: 'button', title: 'Larger (Ctrl+=)', 'aria-label': 'Larger text', onclick: step(0.1) }, 'A+')));

  ui.usage = h('p', null, usageText());
  out.push(title('Your Claude usage', 'Builds and chats run on your own Claude subscription, through your logged-in Claude Code. They count toward the same limits as your work.'), ui.usage);

  const ytText = h('span.dim', null, 'yt-dlp: checking...');
  const update = action('update now', async () => {
    update.textContent = 'updating...';
    const result = await act('deps.install');
    update.textContent = result ? `updated: ${result.version}` : 'update failed';
  }, 'blue');
  out.push(title('Transcripts', 'Video captions come through yt-dlp, which Learn downloads and keeps up to date itself.'), h('div.yt-row', null, ytText, update));
  act('deps.check').then(result => {
    ytText.textContent = result ? `yt-dlp ${result.version}` : 'yt-dlp: not downloaded yet (it comes with the first build)';
  });

  ui.rest.replaceChildren(...out);
}

// --- Appearance ---------------------------------------------------------------------------------
// A pick saves at once and every window follows; typed colours show here first and are saved
// with *Use these*; a slider shows while dragged and saves when let go.

const A = {
  saved: null, // the appearance on file
  presets: [],
  typing: false, // colours typed and shown here, not yet saved
  sliding: null, // the group whose slider is held
  parts: null,
};

function buildAppearance() {
  const schemes = h('div.schemes', { role: 'radiogroup', 'aria-label': 'Colour scheme' });
  const boxes = {};
  const wells = {};
  const colours = COLOR_KEYS.map(([key, label]) => {
    const box = h('input.input', { type: 'text', maxlength: '7', spellcheck: 'false', autocomplete: 'off', 'aria-label': `${label} colour, as #RRGGBB` });
    const well = h('input.well', { type: 'color', title: `Pick the ${label.toLowerCase()} colour`, 'aria-label': `Pick the ${label.toLowerCase()} colour` });
    box.addEventListener('input', typedColours);
    box.addEventListener('keydown', event => {
      if (event.key === 'Enter') { event.preventDefault(); useColours(); }
      if (event.key === 'Escape') { event.preventDefault(); leaveSettings(); }
    });
    well.addEventListener('input', () => {
      box.value = well.value.toUpperCase();
      typedColours();
    });
    boxes[key] = box;
    wells[key] = well;
    return h('div.colour', null, h('span.caption', null, label), h('span.colour-boxes', null, box, well));
  });
  const use = h('button.button', { type: 'button', disabled: true, title: 'Give these colours to every window', onclick: useColours }, 'Use these');
  const note = h('p.look-note');

  const native = isNative();
  const min = Math.round(theme().MIN_OPACITY * 100);
  const sliders = GROUPS.map(([group, label]) => {
    const id = `see-through-${group}`;
    const range = h('input', { type: 'range', id, min: String(min), max: '100', step: '1', disabled: !native });
    const out = h('output', { for: id });
    range.addEventListener('input', () => slide(group, range, out, false));
    range.addEventListener('change', () => slide(group, range, out, true));
    return { group, range, out, row: h('div.ui-opacity', null, h('label', { for: id }, label), range, out) };
  });
  const reset = h('button.button', { type: 'button', onclick: resetLook }, 'Reset to Ember');
  reset.title = 'Ember colours and the usual see-through, in every window';

  ui.look.append(
    title('Appearance', 'The colours and see-through of every window: Learn, the panel and the games.'),
    h('div.look-part', null, h('span.caption', null, 'Colour scheme'), schemes),
    h('div.look-part', null, h('span.caption', null, 'Custom colours'), h('div.colours', null, colours, use), note),
    h('div.look-part', null, h('span.caption', null, 'See-through'),
      h(`div.opacities${native ? '' : '.off'}`, null, sliders.map(slider => slider.row)),
      h('p.look-note', null, native ? 'The background only: text stays sharp.' : 'See-through needs the app window.')),
    h('div.look-reset', null, reset));
  A.parts = { schemes, boxes, wells, use, note, sliders };

  Promise.all([loadPresets(), loadAppearance()]).then(([presets, appearance]) => {
    A.presets = presets;
    if (!A.saved) A.saved = appearance || globalThis.ClaudeTheme.parseAppearance(null);
    syncAppearance();
  });
}

function schemeButton(label, colors, on, onClick, tip) {
  const swatch = h(`span.ui-swatch${on ? '.on' : ''}`, { style: { background: colors.bg } },
    h('i', { style: { background: colors.accent } }), h('i', { style: { background: colors.text } }));
  return h(`button.scheme${on ? '.on' : ''}`, { type: 'button', role: 'radio', 'aria-checked': String(on), title: tip, onclick: onClick }, swatch, h('span', null, label));
}

/** Draws the editor from the saved appearance (what's typed or held stays as it is). */
function syncAppearance() {
  if (!A.parts || !A.saved || !A.presets.length) return;
  const on = shownScheme(A.saved, A.presets);
  const items = A.presets.map(preset => schemeButton(preset.label || preset.name, preset, on === preset.name, () => commit(withPreset(A.saved, preset)), `${preset.label || preset.name}: every window`));
  if (on === 'custom') items.push(schemeButton('Custom', A.saved.colors, true, () => A.parts.boxes.bg.focus(), 'Your own colours, below'));
  A.parts.schemes.replaceChildren(...items);
  if (!A.typing) {
    for (const [key] of COLOR_KEYS) {
      const hex = A.saved.colors[key];
      A.parts.boxes[key].value = hex;
      A.parts.boxes[key].classList.remove('bad');
      A.parts.wells[key].value = hex.toLowerCase();
    }
    canUse(false);
    A.parts.note.textContent = '';
  }
  for (const slider of A.parts.sliders) {
    if (A.sliding === slider.group) continue;
    const value = A.saved.opacity[slider.group];
    slider.range.value = String(Math.round(value * 100));
    slider.out.value = percent(value);
  }
}

/** *Use these* is the accent button only while there's something to use. */
function canUse(on) {
  A.parts.use.disabled = !on;
  A.parts.use.classList.toggle('primary', on);
}

/** The three boxes as typed: shown here once all three are colours. */
function typedColours() {
  const colors = {};
  let complete = true;
  for (const [key] of COLOR_KEYS) {
    const box = A.parts.boxes[key];
    const hex = normalizeHex(box.value);
    // Red only once there's a whole value to judge, not while it's being typed.
    box.classList.toggle('bad', !hex && box.value.replace('#', '').length >= 6);
    if (hex) {
      colors[key] = hex;
      A.parts.wells[key].value = hex.toLowerCase();
    } else complete = false;
  }
  A.typing = true;
  canUse(complete);
  A.parts.note.textContent = complete ? 'Shown here; Use these gives them to every window.' : '';
  if (complete && A.saved) previewAppearance(withColors(A.saved, colors, A.presets), 'learn');
}

function useColours() {
  const colors = {};
  for (const [key, label] of COLOR_KEYS) {
    const hex = normalizeHex(A.parts.boxes[key].value);
    if (!hex) {
      A.parts.boxes[key].classList.add('bad');
      A.parts.note.textContent = `${label}: a colour is #RRGGBB, like #E08A5F.`;
      return;
    }
    colors[key] = hex;
  }
  if (A.saved) commit(withColors(A.saved, colors, A.presets));
}

function slide(group, range, out, done) {
  if (!A.saved) return;
  const value = Number(range.value) / 100;
  out.value = percent(value);
  const next = withOpacity(A.saved, group, value);
  if (done) {
    A.sliding = null;
    commit(next);
  } else {
    A.sliding = group;
    if (group === 'learn') previewAppearance(next, 'learn');
  }
}

function resetLook() {
  const ember = A.presets.find(preset => preset.name === 'ember') || { name: 'ember', ...theme().DEFAULT_COLORS };
  commit({ ...withPreset(A.saved, ember), opacity: { ...theme().DEFAULT_OPACITY } });
}

/** Shows `next` here at once and saves it for every window. */
async function commit(next) {
  A.typing = false;
  A.saved = next;
  previewAppearance(next, 'learn');
  syncAppearance();
  try {
    A.saved = await saveAppearance(next);
  } catch {
    toast("Couldn't save the colour scheme", 'error');
  }
}

/** Another window changed the appearance (shared/look.js saw the file change). */
export function appearanceChanged(appearance) {
  A.saved = appearance;
  syncAppearance();
}

/** Leaving Settings (or Esc in a colour box): colours typed but not used go back. */
export function leaveSettings() {
  if (!A.typing || !A.saved) return;
  A.typing = false;
  previewAppearance(A.saved, 'learn');
  syncAppearance();
}

// --- About ----------------------------------------------------------------------------------------

function buildAbout() {
  const body = h('div.about');
  ui.about.append(title('About'), body);
  loadReleases().then(({ version, releases }) => {
    const newest = (releases || [])[0];
    body.replaceChildren(
      h('div.about-version', null, `claude-panel ${version || ''}`.trim()),
      newest ? h('div.release', null,
        h('div.release-head', null, h('b', null, newest.version), releaseMeta(newest) ? ` · ${releaseMeta(newest)}` : ''),
        h('ul.release-notes', null, (newest.notes || []).map(note => h('li', null, note)))) : null);
  });
}
