// Learn's settings: where the library lives, which model builds and which one chats,
// and the work folders the Advisor may read. Kept in a fixed place, since the library
// path is itself a setting.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { writeJson } from './store.mjs';

// LEARN_CONFIG_DIR and LEARN_LIBRARY point a snapshot or a test at a library of its own.
export const CONFIG_DIR = process.env.LEARN_CONFIG_DIR || join(homedir(), '.config/claude-learn');
export const CACHE_DIR = join(homedir(), '.cache/claude-learn');
export const SETTINGS_FILE = join(CONFIG_DIR, 'settings.json');
export const STATUS_FILE = join(CONFIG_DIR, 'status.json');

// What `claude --model` takes; a full model id works too.
export const MODELS = ['sonnet', 'opus', 'haiku'];

export const defaults = () => ({
  v: 1,
  library: join(homedir(), '.claude/learn'),
  models: { build: 'sonnet', chat: 'sonnet' },
  workFolders: [],
  claudePath: null,
});

/** `C:\Users\me\OneDrive\Learn` becomes `/mnt/c/Users/me/OneDrive/Learn`; WSL paths stay. */
export function toWslPath(path) {
  const text = String(path || '').trim();
  const drive = /^([A-Za-z]):[\\/](.*)$/.exec(text);
  if (drive) return `/mnt/${drive[1].toLowerCase()}/${drive[2].replace(/\\/g, '/')}`.replace(/\/+$/, '');
  const unc = /^\\\\wsl(?:\.localhost|\$)\\[^\\]+(\\.*)$/i.exec(text);
  if (unc) return unc[1].replace(/\\/g, '/');
  if (text.startsWith('~/')) return join(homedir(), text.slice(2));
  return text.replace(/\/+$/, '');
}

const isModel = value => typeof value === 'string' && (MODELS.includes(value) || /^claude-[a-z0-9.-]+$/.test(value));

/** Anything read from disk or sent by the window, made safe to use. */
export function normalizeSettings(raw) {
  const base = defaults();
  const value = raw && typeof raw === 'object' ? raw : {};
  const library = typeof value.library === 'string' && value.library.trim() ? toWslPath(value.library) : base.library;
  const models = value.models && typeof value.models === 'object' ? value.models : {};
  const folders = Array.isArray(value.workFolders) ? value.workFolders : [];
  return {
    v: 1,
    library: library.startsWith('/') ? library : base.library,
    models: {
      build: isModel(models.build) ? models.build : base.models.build,
      chat: isModel(models.chat) ? models.chat : base.models.chat,
    },
    workFolders: [...new Set(folders.filter(folder => typeof folder === 'string' && folder.trim()).map(toWslPath))].filter(folder => folder.startsWith('/')),
    claudePath: typeof value.claudePath === 'string' && value.claudePath.startsWith('/') ? value.claudePath : null,
  };
}

export function readSettings() {
  let settings;
  try {
    settings = normalizeSettings(JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')));
  } catch {
    settings = defaults();
  }
  if (process.env.LEARN_LIBRARY) settings.library = toWslPath(process.env.LEARN_LIBRARY);
  return settings;
}

/** Merges a change in; `null` for a key puts its default back. */
export function writeSettings(change) {
  const current = readSettings();
  const next = normalizeSettings({
    ...current,
    ...change,
    models: { ...current.models, ...(change.models || {}) },
  });
  writeJson(SETTINGS_FILE, next);
  return next;
}

/** The claude binary: the setting, then PATH, then where the installer puts it. */
export function claudeBinary(settings = readSettings()) {
  if (settings.claudePath && existsSync(settings.claudePath)) return settings.claudePath;
  for (const dir of (process.env.PATH || '').split(':')) {
    if (dir && existsSync(join(dir, 'claude'))) return join(dir, 'claude');
  }
  const local = join(homedir(), '.local/bin/claude');
  return existsSync(local) ? local : 'claude';
}
