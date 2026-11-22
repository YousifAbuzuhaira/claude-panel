// Learn's settings: where the library lives, which model builds and which one chats,
// and the work folders the Advisor may read. Kept in a fixed place, since the library
// path is itself a setting.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, win32 } from 'node:path';
import { writeJson } from './store.mjs';

// LEARN_CONFIG_DIR and LEARN_LIBRARY point a snapshot or a test at a library of its own.
export const CONFIG_DIR = process.env.LEARN_CONFIG_DIR || join(homedir(), '.config/claude-learn');
// LEARN_CACHE_DIR: a scratch run's own downloads (yt-dlp, pypdf, the voice), never the real cache.
export const CACHE_DIR = process.env.LEARN_CACHE_DIR || join(homedir(), '.cache/claude-learn');
export const SETTINGS_FILE = join(CONFIG_DIR, 'settings.json');
export const STATUS_FILE = join(CONFIG_DIR, 'status.json');

// What `claude --model` takes; a full model id works too.
export const MODELS = ['sonnet', 'opus', 'haiku'];

export const defaults = () => ({
  v: 1,
  library: join(homedir(), '.claude/learn'),
  models: { build: 'sonnet', chat: 'sonnet', video: 'opus' },
  workFolders: [],
  claudePath: null,
  // Questions in videos: guesses, quick checks and masked lines that stop a video. Off, videos
  // play straight through and are made without them (cheaper and quicker).
  videoQuestions: false,
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

/**
 * A path as this machine's Node opens it. Inside WSL (and on macOS and Linux) that is
 * toWslPath's; on Windows itself a Windows path stays one (`C:\...`, `\\server\share`),
 * and only `~` is expanded, since `/mnt/c/...` means nothing there.
 */
export function toLocalPath(path, platform = process.platform) {
  if (platform !== 'win32') return toWslPath(path);
  const text = String(path || '').trim();
  if (text === '~' || text.startsWith('~/') || text.startsWith('~\\')) return win32.join(homedir(), text.slice(2));
  return text.replace(/(?<=[^:\\/])[\\/]+$/, '');
}

/** Whether a setting's path is whole: starts at / here, at a drive or a share on Windows. */
export const isAbsoluteLocal = (path, platform = process.platform) =>
  platform === 'win32' ? /^([A-Za-z]:[\\/]|\\\\[^\\]+\\)/.test(String(path)) : String(path).startsWith('/');

const isModel = value => typeof value === 'string' && (MODELS.includes(value) || /^claude-[a-z0-9.-]+$/.test(value));

/** Anything read from disk or sent by the window, made safe to use. */
export function normalizeSettings(raw, platform = process.platform) {
  const base = defaults();
  const value = raw && typeof raw === 'object' ? raw : {};
  const library = typeof value.library === 'string' && value.library.trim() ? toLocalPath(value.library, platform) : base.library;
  const models = value.models && typeof value.models === 'object' ? value.models : {};
  const folders = Array.isArray(value.workFolders) ? value.workFolders : [];
  return {
    v: 1,
    library: isAbsoluteLocal(library, platform) ? library : base.library,
    models: {
      build: isModel(models.build) ? models.build : base.models.build,
      chat: isModel(models.chat) ? models.chat : base.models.chat,
      video: isModel(models.video) ? models.video : base.models.video,
    },
    workFolders: [...new Set(folders.filter(folder => typeof folder === 'string' && folder.trim()).map(folder => toLocalPath(folder, platform)))].filter(folder => isAbsoluteLocal(folder, platform)),
    claudePath: typeof value.claudePath === 'string' && isAbsoluteLocal(value.claudePath, platform) ? value.claudePath : null,
    videoQuestions: value.videoQuestions === true,
  };
}

export function readSettings() {
  let settings;
  try {
    settings = normalizeSettings(JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')));
  } catch {
    settings = defaults();
  }
  if (process.env.LEARN_LIBRARY) settings.library = toLocalPath(process.env.LEARN_LIBRARY);
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

/**
 * The claude binary: the setting, then PATH, then where the installers put it. On Windows
 * claude.exe (the native installer's, or npm's behind claude.cmd); on a Mac also Homebrew's
 * and the old local install.
 */
export function claudeBinary(settings = readSettings(), { platform = process.platform, path = process.env.PATH || '', exists = existsSync, home = homedir() } = {}) {
  if (settings.claudePath && exists(settings.claudePath)) return settings.claudePath;
  const dirs = path.split(platform === 'win32' ? ';' : ':').filter(Boolean);
  if (platform === 'win32') {
    // npm's claude.cmd only starts its package's bin\claude.exe: that exe, spawned straight
    // (Node won't run a .cmd without a shell, and stopping a shell would leave claude running).
    for (const dir of dirs) {
      if (exists(win32.join(dir, 'claude.exe'))) return win32.join(dir, 'claude.exe');
      const shim = win32.join(dir, 'claude.cmd');
      if (exists(shim)) {
        const exe = win32.join(win32.dirname(shim), 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
        if (exists(exe)) return exe;
      }
    }
    const local = win32.join(home, '.local', 'bin', 'claude.exe');
    return exists(local) ? local : 'claude.exe';
  }
  for (const dir of dirs) {
    if (exists(join(dir, 'claude'))) return join(dir, 'claude');
  }
  const fallbacks = [join(home, '.local/bin/claude'), ...(platform === 'darwin' ? ['/opt/homebrew/bin/claude', '/usr/local/bin/claude', join(home, '.claude/local/claude')] : [])];
  return fallbacks.find(candidate => exists(candidate)) || 'claude';
}
