// Settings: the library folder, the models, the Advisor's work folders, text size, usage, yt-dlp.
import { S, act, action, chip, formatDate, h, nav, toast } from './core.js';

const MODEL_CHOICES = [['sonnet', 'Sonnet'], ['opus', 'Opus'], ['haiku', 'Haiku']];

let ui = null;

/** `onLibraryChanged`: another library, so nothing cached belongs to it. */
export function buildSettingsView(host, { onLibraryChanged }) {
  const stack = h('div.settings-view');
  host.append(stack);
  ui = { stack, onLibraryChanged };
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
    h('div.folders', null, (settings.workFolders || []).map(folder => h('div.folder', null, h('span.mono', null, folder),
      action('remove', () => save({ workFolders: settings.workFolders.filter(other => other !== folder) }), 'faint')))),
    h('div.add-row', null, folderBox, h('button.button', { type: 'button', onclick: addFolder }, 'Add')));

  out.push(title('Text size', 'The page, its title and the chats. Also Ctrl+= and Ctrl+-.'),
    h('div.size-row', null,
      chip('A−', false, () => { nav.setTextScale(S.textScale - 0.1); showSettings(); }),
      h('span.size', null, `${Math.round(S.textScale * 100)}%`),
      chip('A+', false, () => { nav.setTextScale(S.textScale + 0.1); showSettings(); })));

  const usage = S.status?.usage;
  const percent = value => `${Math.round(Number(value) * 100)}%`;
  const usageText = usage && usage.fiveHour !== null && usage.fiveHour !== undefined
    ? `Last reading: ${percent(usage.fiveHour)} of the 5-hour limit${usage.sevenDay !== null && usage.sevenDay !== undefined ? `, ${percent(usage.sevenDay)} of the weekly limit` : ''} (${formatDate(usage.at)}).`
    : 'No reading yet: it shows after the first build or chat.';
  out.push(title('Your Claude usage', 'Builds and chats run on your own Claude subscription, through your logged-in Claude Code. They count toward the same limits as your work.'), h('p', null, usageText));

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

  ui.stack.replaceChildren(...out);
}
