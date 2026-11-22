// Learn on every setup (on Windows in an Edge app window, from widget/Learn.ps1), and the games
// in the browser: a small local server that bridges HTTP + Server-Sent Events to Learn's helper
// (`learn.sh serve`, contract 2 in CLAUDE.md) and serves the pages in ./public. Node's own
// modules only.
//
//   node server.mjs open [learn [--view <v>] [--course <id>] | games | games/<name>]
//                                                 find or start the server, open the page
//   node server.mjs serve                         run it in the foreground (what `open` starts)
//
// Security: it can start `claude -p` runs on the person's subscription and delete their
// courses, and any page they have open can reach 127.0.0.1. So it listens on 127.0.0.1
// only, wants a per-launch token on every API request (X-Learn-Token, or ?token= for the
// event stream, which can't set headers), and refuses any foreign Host or Origin, which
// also stops DNS rebinding. The token travels only in the URL's #hash. One thing needs no
// token: /look.css, the colour scheme for a page's first paint (colours are not secret).
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, extname, join, normalize, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
// The pages' own colour arithmetic (a classic script that sets globalThis.ClaudeTheme), so the
// first paint and every page agree to the byte.
import './public/shared/theme.js';

const THEME = globalThis.ClaudeTheme;
const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(HERE, 'public');
const WIDGET = join(HERE, '..', 'widget');
const LEARN_SH = join(HERE, '..', 'learn', 'learn.sh');
const LEARN_MJS = join(HERE, '..', 'learn', 'learn.mjs');
const CONFIG_DIR = process.env.LEARN_CONFIG_DIR || join(homedir(), '.config', 'claude-learn');
const WEB_FILE = join(CONFIG_DIR, 'web.json');
// Learn's page prefs (view, course, text size, contents, custom colours). Kept here rather than
// in the browser, whose storage is per origin: the port, and so the origin, changes each start.
const PREFS_FILE = join(CONFIG_DIR, 'web-prefs.json');
const SAVES_DIR = process.env.CLAUDE_PANEL_SAVES || join(homedir(), '.config', 'claude-panel', 'games');
// The colour scheme and see-through every window shares (the shape is in shared/theme.js).
// Inside WSL, and on Windows itself, it is the Windows windows' own file
// (%LOCALAPPDATA%\ClaudePhases), so the browser pages and the PowerShell windows wear one scheme.
const APPEARANCE_FILE = process.env.CLAUDE_PANEL_APPEARANCE
  || (process.platform === 'win32' && process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'ClaudePhases', 'appearance.json') : null)
  || windowsAppearanceFile()
  || join(homedir(), '.config', 'claude-panel', 'appearance.json');

/** On WSL, %LOCALAPPDATA%\ClaudePhases\appearance.json as a WSL path; null anywhere else. */
function windowsAppearanceFile() {
  if (!process.env.WSL_DISTRO_NAME) return null;
  try {
    const local = spawnSync('cmd.exe', ['/d', '/c', 'echo %LOCALAPPDATA%'], { cwd: '/mnt/c', encoding: 'utf8', timeout: 5000 }).stdout.trim();
    if (!/^[A-Za-z]:\\/.test(local)) return null;
    const path = spawnSync('wslpath', ['-u', local], { encoding: 'utf8', timeout: 5000 }).stdout.trim();
    return path && existsSync(path) ? join(path, 'ClaudePhases', 'appearance.json') : null;
  } catch {
    return null;
  }
}
const RELEASES_FILE = join(HERE, '..', 'releases.json');
const PLUGIN_FILE = join(HERE, '..', '.claude-plugin', 'plugin.json');
const STOCKFISH_DIR = join(homedir(), '.cache', 'claude-learn', 'stockfish');
const APP_SOURCE = join(HERE, '..', 'mac', 'ClaudePanel.swift');
const APP_CACHE = join(homedir(), '.cache', 'claude-panel', 'app');
// The window app keeps `<pid> <port>` here for each page it shows (pidFile in ClaudePanel.swift),
// and loads the path in `<id>.open` when one appears (a deep link for a window already open).
const WINDOWS_DIR = join(homedir(), '.cache', 'claude-panel', 'windows');
const IDLE_MS = 30 * 60_000;
// A new version takes over from this server on its port: how long the old one waits for it.
const HANDOVER_WAIT_MS = 5_000;
// Every chat's phases.json (register.tsx writes them), for Learn's chats line. On Windows itself
// the plugin writes them in the temp folder (stateRoot in hooks/widget.ts), which is tmpdir().
const GLANCE_ROOT = process.env.CLAUDE_PANEL_GLANCE_ROOT || (process.platform === 'win32' ? join(tmpdir(), 'claude-progress') : '/tmp/claude-progress');
const RPC_TIMEOUT_MS = 10 * 60_000;
const MAX_BODY = 4 * 1024 * 1024;
// The appearance and the prefs are a few hundred bytes; every window re-reads the appearance.
const MAX_SMALL_BODY = 4 * 1024;
// A document for a new course, sent by Learn's page: kept here until build.start moves it into
// the library (learn/build.mjs takes anything under this folder by moving, not copying).
const UPLOADS_DIR = join(CONFIG_DIR, 'uploads');
const MAX_UPLOAD = 64 * 1024 * 1024;
const UPLOAD_TYPES = new Set(['.pdf', '.docx', '.md', '.markdown', '.txt', '.text', '.html', '.htm']);
const UPLOAD_MAX_AGE_MS = 24 * 3600_000;

// The game data the WPF games read, served as is.
const DATA_FILES = new Set(['ChessPuzzles.txt', 'ChessThemes.txt', 'ChessPieces.txt', 'TypeThemes.txt', 'Presets.json']);
const GAMES = new Set(['2048', 'sudoku', 'typetest', 'chess']);
// npm stockfish@19.0.1, as https://unpkg.com/stockfish@19.0.1/?meta lists it. Never committed: GPL-3.0.
const STOCKFISH = {
  'stockfish-19-lite-single.js': { size: 28_230, sha256: 'zLEw1/8pQIUxxH2Fmkn5HVnU9ILQWlPrGjIxpPYkyRo=' },
  'stockfish-19-lite-single.wasm': { size: 1_845_971, sha256: '7k8RW9stMsrflsraEEoFtewlfXrW9XWCGQtJvHHwlt4=' },
};

// --- The pages that open on their own, and their window titles --------------------------------

export const WINDOW_TITLES = { learn: 'Learn', 'learn/video': 'Learn video', games: 'Games', 'games/sudoku': 'Sudoku', 'games/2048': '2048', 'games/typing': 'Typing', 'games/chess': 'Chess' };
// Learn's views a link can ask for (web/public/learn/app.js reads ?view= and ?course=).
const LEARN_VIEWS = new Set(['library', 'course', 'review', 'learned', 'ask', 'settings', 'overlap']);
const COURSE_ID = /^[\w.-]{1,160}$/;

/**
 * Where a page lives on this server: 'learn' with { view: 'settings' } is 'learn/?view=settings',
 * and a course alone opens that course. A view or course that isn't well formed is left out, so
 * the page opens where it would anyway. Null for a page that doesn't exist.
 */
export function pagePath(page, { view, course, n, explain, clip } = {}) {
  const key = String(page ?? '').replace(/^\/+|\/+$/g, '') || 'learn';
  if (!Object.hasOwn(WINDOW_TITLES, key)) return null;
  const query = new URLSearchParams();
  if (key === 'learn') {
    const hasCourse = typeof course === 'string' && COURSE_ID.test(course);
    if (typeof view === 'string' && LEARN_VIEWS.has(view)) query.set('view', view);
    else if (hasCourse) query.set('view', 'course');
    if (hasCourse) query.set('course', course);
  }
  // A page's video, or an explainer's clips (/explain): `explain` and, at a clip, `clip`.
  if (key === 'learn/video' && typeof explain === 'string' && EXPLAIN_ID.test(explain)) {
    query.set('explain', explain);
    if (/^\d{1,2}$/.test(String(clip ?? ''))) query.set('clip', String(clip));
  } else if (key === 'learn/video') {
    if (typeof course !== 'string' || !COURSE_ID.test(course) || !/^\d{1,4}$/.test(String(n))) return null;
    query.set('course', course);
    query.set('page', String(n));
  }
  const search = query.toString();
  return { key, path: `${key}/${search ? `?${search}` : ''}`, view: query.get('view'), course: query.get('course'), n: query.get('page'), explain: query.get('explain'), clip: query.get('clip') };
}

/**
 * A one-time launch address: the page's own folder with the nonce in the query. Edge keys an app
 * window's place on the address without its port or query, so `--app=` windows of one page
 * reopen where they were left (a nonce in the path made every launch a stranger).
 */
const EXPLAIN_ID = /^x[0-9a-f]{12,20}$/;

export const launchPath = (key, nonce) => `${key}/?launch=${nonce}`;

/**
 * Whether a server on `running` hands over to a new one: the plugin is on another version, no
 * helper request or chat reply is in flight (a new helper would drop it), and a hand-over to
 * this same version hasn't already failed.
 */
export function shouldHandOver({ running, plugin, busy, failedFor = null }) {
  return running !== plugin && !busy && failedFor !== plugin;
}

const CHAT_RECENT_MS = 15 * 60_000;
const shorten = (text, max) => (text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1)).trimEnd()}…`);
const PHASE_MARKS = { done: '✓', in_progress: '●' };

/**
 * Learn's chats line, from every chat's phases.json ({ state, mtimeMs }), newest first: each
 * chat at work with the phase it's on and its count, or its live test run when it has no plan.
 * A chat shows while its plan has phases left, a test runs, or it changed in the last 15
 * minutes. `tip` holds each chat's whole plan.
 */
export function phaseLine(chats, now = Date.now()) {
  const items = [];
  const tip = [];
  for (const { state, mtimeMs } of [...chats].sort((a, b) => b.mtimeMs - a.mtimeMs)) {
    if (!state || typeof state !== 'object') continue;
    const phases = Array.isArray(state.plan?.items) ? state.plan.items : [];
    const live = (Array.isArray(state.runs) ? state.runs : []).filter(run => run?.status === 'running').at(-1);
    const left = phases.filter(item => item?.status !== 'done').length;
    const isRecent = now - mtimeMs < CHAT_RECENT_MS;
    if (left === 0 && !live && !isRecent) continue;
    if (phases.length === 0 && !live) continue;
    const label = String(state.title || state.plan?.title || `chat ${String(state.sessionId || '').slice(0, 4)}`);
    const item = { label: shorten(label, 24) };
    if (phases.length) {
      const current = phases.find(phase => phase?.status === 'in_progress');
      if (current) Object.assign(item, { mark: 'now', text: shorten(String(current.name || ''), 34) });
      else if (left === 0) Object.assign(item, { mark: 'done', text: 'All done' });
      else Object.assign(item, { mark: 'next', text: shorten(String(state.plan.title || ''), 34) });
      item.count = `${Number(state.plan.done) || 0}/${Number(state.plan.total) || phases.length}`;
    } else {
      Object.assign(item, { mark: 'tests', text: 'Tests', count: String(live.count ?? '') });
    }
    items.push(item);
    if (tip.length) tip.push('');
    tip.push(label);
    if (phases.length) {
      tip.push(`  ${state.plan.title || ''}`);
      for (const phase of phases) tip.push(`    ${PHASE_MARKS[phase?.status] || '○'}  ${phase?.name || ''}`);
    }
    if (live) tip.push(`  Tests: ${live.label || ''} ${live.count ?? ''}`.trimEnd());
  }
  return { items, tip: tip.join('\n') };
}

/** Every chat's phases.json under `root`, with its time, for phaseLine; [] when there are none. */
function readChats(root) {
  const chats = [];
  let dirs = [];
  try {
    dirs = readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory());
  } catch {
    return chats;
  }
  for (const dir of dirs) {
    const file = join(root, dir.name, 'phases.json');
    try {
      const { mtimeMs } = statSync(file);
      chats.push({ state: JSON.parse(readFileSync(file, 'utf8')), mtimeMs });
    } catch {
      // No file yet, or one being rewritten: the next look gets it.
    }
  }
  return chats;
}

// --- The look, Learn's prefs, and the terminal a window follows (pure, for the tests) ---------

const declarations = (palette, roles) => roles.map(role => `${THEME.cssName(role)}:${THEME.cssColor(palette[role])}`).join(';');

/**
 * GET /look.css: the saved colour scheme (the appearance file's text, or null) as the CSS every
 * role takes, so a page's first paint is already in it. On :root at full opacity, as a plain
 * browser shows it; and for a native window (html.native, set before the page draws) the
 * group's see-through as well. shared/look.js takes over once the page runs.
 */
export function lookCss(saved, group) {
  const appearance = THEME.parseAppearance(saved);
  const solid = THEME.derivePalette(appearance.colors, 1);
  const clear = THEME.derivePalette(appearance.colors, appearance.opacity[group] ?? 1);
  const changed = THEME.ROLES.filter(role => clear[role] !== solid[role]);
  const root = `:root{${declarations(solid, THEME.ROLES)};color-scheme:${solid.isDark ? 'dark' : 'light'}}\n`;
  return changed.length ? `${root}html.native{${declarations(clear, changed)}}\n` : root;
}

const round2 = value => Math.round(value * 100) / 100;

/**
 * What POST /api/appearance writes: only the four fields every window reads, each checked, and
 * anything missing or malformed kept from the file as it was (as the Mac app's cleanAppearance
 * does). `saved` is the file's text, or null.
 */
export function cleanAppearance(value, saved = null) {
  const base = THEME.parseAppearance(saved);
  const given = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const colors = { ...base.colors };
  for (const key of ['bg', 'accent', 'text']) {
    const hex = given.colors?.[key];
    if (THEME.parseHex(hex)) colors[key] = hex.toUpperCase();
  }
  const opacity = {};
  for (const key of ['panel', 'learn', 'games']) {
    const number = given.opacity?.[key];
    const chosen = typeof number === 'number' && Number.isFinite(number) ? number : base.opacity[key];
    opacity[key] = round2(Math.min(1, Math.max(THEME.MIN_OPACITY, chosen)));
  }
  const preset = typeof given.preset === 'string' ? given.preset.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) : '';
  return { v: 1, preset: preset || base.preset, colors, opacity };
}

const PREF_VIEWS = new Set(['library', 'course', 'review', 'learned', 'ask', 'settings']);

/** What POST /api/prefs keeps: the fields web Learn remembers, each checked; the rest dropped. */
export function cleanPrefs(value) {
  const out = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  if (PREF_VIEWS.has(value.view)) out.view = value.view;
  if (typeof value.courseId === 'string' && COURSE_ID.test(value.courseId)) out.courseId = value.courseId;
  else if (value.courseId === null) out.courseId = null;
  if (typeof value.textScale === 'number' && Number.isFinite(value.textScale)) out.textScale = round2(Math.min(3, Math.max(0.5, value.textScale)));
  if (typeof value.showContents === 'boolean') out.showContents = value.showContents;
  const custom = value.customColors;
  if (custom && typeof custom === 'object' && ['bg', 'accent', 'text'].every(key => THEME.parseHex(custom[key]))) {
    out.customColors = { bg: custom.bg.toUpperCase(), accent: custom.accent.toUpperCase(), text: custom.text.toUpperCase() };
  }
  // The video player's: its speed and its subtitles, the same for every video.
  if (VIDEO_RATES.includes(value.videoRate)) out.videoRate = value.videoRate;
  if (typeof value.videoCaptions === 'boolean') out.videoCaptions = value.videoCaptions;
  return out;
}

const VIDEO_RATES = [0.75, 1, 1.25, 1.5, 1.75, 2];

/**
 * The prefs after a POST: each field the body names is replaced (or dropped, when its value isn't
 * kept), and the rest stay. Learn's pages and its video player each send only their own fields.
 */
export function mergePrefs(saved, given) {
  const out = cleanPrefs(saved);
  const clean = cleanPrefs(given);
  for (const key of Object.keys(given || {})) {
    if (key in clean) out[key] = clean[key];
    else delete out[key];
  }
  return out;
}

/**
 * A terminal a window follows ({ program: TERM_PROGRAM, itermSession: ITERM_SESSION_ID }), or {}
 * when it doesn't look like one. They go to the window app as arguments (never through a shell).
 */
export function cleanTerminal(value) {
  const program = typeof value?.program === 'string' && /^[\w.+ -]{1,64}$/.test(value.program) ? value.program : '';
  if (!program) return {};
  const session = typeof value.itermSession === 'string' && /^[\w.:-]{0,128}$/.test(value.itermSession) ? value.itermSession : '';
  return { program, itermSession: session };
}

// WebAssembly and a worker for Stockfish; YouTube frames for Learn's videos; inline styles only.
// Learn's own videos play from a Blob: an audio element can't send the token.
const CSP = [
  "default-src 'self'", "script-src 'self' 'wasm-unsafe-eval'", "worker-src 'self' blob:", "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:", 'media-src blob:', "connect-src 'self'", 'frame-src https://www.youtube.com https://www.youtube-nocookie.com',
  "object-src 'none'", "base-uri 'none'", "form-action 'self'",
].join('; ');

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.wasm': 'application/wasm', '.ico': 'image/x-icon',
};

// --- The helper -------------------------------------------------------------------------

/** One `learn.sh serve` child: requests go in by rid, events go out to every page. */
function startHelper(onEvent) {
  let child = null;
  let version = null;
  let rid = 0;
  let restarts = 0;
  let lastStderr = '';
  const pending = new Map();

  const launch = () => {
    version = pluginVersion();
    const argv = process.platform === 'win32' ? [process.execPath, [LEARN_MJS, 'serve']] : ['bash', [LEARN_SH, 'serve']];
    // windowsHide: on Windows a child of this console-less server would open a console of its own.
    child = spawn(argv[0], argv[1], { stdio: ['pipe', 'pipe', 'pipe'], env: process.env, windowsHide: true });
    createInterface({ input: child.stdout }).on('line', line => {
      let value;
      try {
        value = JSON.parse(line);
      } catch {
        return;
      }
      if (typeof value.rid === 'number' && pending.has(value.rid)) {
        const { resolve, timer } = pending.get(value.rid);
        clearTimeout(timer);
        pending.delete(value.rid);
        resolve(value);
      } else if (value.event) {
        onEvent(value);
      }
    });
    child.stderr.on('data', chunk => { lastStderr = (lastStderr + chunk).slice(-2000); });
    child.on('exit', () => {
      child = null;
      for (const [id, { resolve, timer }] of pending) {
        clearTimeout(timer);
        resolve({ rid: id, ok: false, error: 'Learn\'s helper stopped' });
      }
      pending.clear();
      // Restarted once, as the WPF window does; after that the page shows why.
      if (restarts < 1) {
        restarts++;
        launch();
      } else {
        onEvent({ event: 'fatal', error: lastStderr.trim() || 'Learn\'s helper stopped and could not be restarted' });
      }
    });
  };
  launch();

  return {
    async ask(request) {
      // Pages come from disk, so after an update they're new while a running helper is still old.
      // A new version starts a new helper before it's asked anything. Jobs run apart, so they go on.
      if (child && pluginVersion() !== version) {
        const stale = child;
        restarts = 0;
        await new Promise(resolve => {
          stale.once('exit', resolve);
          stale.kill();
        });
      }
      if (!child) return { ok: false, error: 'Learn\'s helper is not running' };
      const id = ++rid;
      return new Promise(resolve => {
        const timer = setTimeout(() => {
          pending.delete(id);
          resolve({ rid: id, ok: false, error: 'Learn\'s helper took too long to answer' });
        }, RPC_TIMEOUT_MS);
        pending.set(id, { resolve, timer });
        child.stdin.write(JSON.stringify({ ...request, rid: id }) + '\n');
      });
    },
    /** A request is waiting for its answer. */
    busy: () => pending.size > 0,
    stop() {
      restarts = Infinity;
      child?.stdin.end();
    },
  };
}

// --- Saves and Stockfish ------------------------------------------------------------------

function writeAtomic(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, text, { mode: 0o600 });
  // On Windows a reader that has the file open (a WPF window reading appearance.json) refuses
  // the rename for a moment: try again for up to two seconds, as learn/store.mjs does.
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(temp, path);
      return;
    } catch (error) {
      if (attempt >= 20 || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) {
        rmSync(temp, { force: true });
        throw error;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
}

const fetchings = new Map();

/** Fetches one Stockfish file once, checks its hash, and keeps it in ~/.cache. */
function stockfishFile(name) {
  const path = join(STOCKFISH_DIR, name);
  const want = STOCKFISH[name];
  const isGood = buffer => buffer.length === want.size && createHash('sha256').update(buffer).digest('base64') === want.sha256;
  if (existsSync(path)) {
    const buffer = readFileSync(path);
    if (isGood(buffer)) return Promise.resolve(buffer);
  }
  if (fetchings.has(name)) return fetchings.get(name);
  const fetching = fetch(`https://unpkg.com/stockfish@19.0.1/bin/${name}`)
    .then(async response => {
      if (!response.ok) throw new Error(`unpkg answered ${response.status}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      if (!isGood(buffer)) throw new Error(`${name} did not match its pinned hash`);
      mkdirSync(STOCKFISH_DIR, { recursive: true });
      writeFileSync(path, buffer);
      return buffer;
    })
    .finally(() => fetchings.delete(name));
  fetchings.set(name, fetching);
  return fetching;
}

// --- HTTP ---------------------------------------------------------------------------------

/** An upload's name made safe for a file name, keeping its extension. */
export function uploadName(raw) {
  let name = '';
  try { name = decodeURIComponent(String(raw || '')); } catch { name = String(raw || ''); }
  name = name.split(/[\\/]/).pop().replace(/[^\w.\- ]+/g, '_').replace(/^\.+/, '').trim().slice(0, 120);
  return name;
}

/** The body streamed to `file`, up to `limit` bytes; rejects (and removes the file) past it. */
function saveBody(req, file, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const out = createWriteStream(file, { mode: 0o600 });
    const fail = error => {
      out.destroy();
      rmSync(file, { force: true });
      reject(error);
    };
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) {
        req.destroy();
        fail(new Error('too large'));
      }
    });
    req.on('error', fail);
    out.on('error', fail);
    out.on('finish', () => resolve(size));
    req.pipe(out);
  });
}

function pruneUploads() {
  try {
    for (const name of readdirSync(UPLOADS_DIR)) {
      const file = join(UPLOADS_DIR, name);
      if (Date.now() - statSync(file).mtimeMs > UPLOAD_MAX_AGE_MS) rmSync(file, { force: true });
    }
  } catch {
    // No uploads yet.
  }
}

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('too large'));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** A small JSON object from the body (MAX_SMALL_BODY), or null for anything else. */
async function readJsonObject(req) {
  try {
    const value = JSON.parse(await readBody(req, MAX_SMALL_BODY));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

// Only 64 hex digits are ever compared: anything else (other bytes, another length) can't throw.
const sameToken = (given, token) => typeof given === 'string' && /^[0-9a-f]{64}$/.test(given) && timingSafeEqual(Buffer.from(given), Buffer.from(token));

// One-time addresses for the browser: the token never goes on a command line, where any user
// on the machine can read it. `open` asks for one, the browser opens <page>/?launch=<nonce> (or
// the older /launch/<nonce>), and the server answers once, within a minute, with a redirect to
// the page and its token in the #hash.
const LAUNCH_MS = 60_000;
const launches = new Map();

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** `check`'s first truthy answer, asked every 150 ms for up to `ms`; null after that. */
async function waitFor(check, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const value = await check();
    if (value) return value;
    await sleep(150);
  }
  return null;
}

function serve() {
  // A server started to take over from an older version (CLAUDE_PANEL_TAKEOVER=1) keeps its
  // port and token, so the pages it had open carry on with this one.
  const takeover = process.env.CLAUDE_PANEL_TAKEOVER === '1' ? readRecord() : null;
  const token = takeover?.token ?? randomBytes(32).toString('hex');
  const version = pluginVersion();
  let boundPort = 0;
  const clients = new Set();
  // The page each event stream belongs to ('learn' or 'other'): `open` reuses an open Learn.
  const pageOf = new Map();
  // Chat replies still coming (chat.send answered, no chat.done or chat.error yet).
  const busyChats = new Set();
  let lastActive = Date.now();
  // The terminal each native window follows, by page key, as `open` reported it (POST
  // /api/opened): with two Claude sessions in two terminal windows, a page opening another page
  // hands on its own terminal, not the one that first started this server.
  const terminals = new Map();
  let lastTerminal = cleanTerminal({ program: process.env.TERM_PROGRAM, itermSession: process.env.ITERM_SESSION_ID });
  const write = (targets, value) => {
    const text = `data: ${JSON.stringify(value)}\n\n`;
    for (const res of targets) res.write(text);
  };
  const broadcast = value => {
    if (value?.event === 'chat.done' || value?.event === 'chat.error') busyChats.delete(value.key);
    write(clients, value);
  };
  const learnPages = () => [...clients].filter(res => pageOf.get(res) === 'learn');
  const helper = startHelper(broadcast);

  const server = createServer((req, res) => {
    // One bad request answers 400 or 500; it never takes the server down.
    handle(req, res).catch(error => {
      const isBad = error instanceof URIError || error instanceof SyntaxError;
      if (!res.headersSent) res.writeHead(isBad ? 400 : 500, { 'Content-Type': 'text/plain' });
      res.end(isBad ? 'bad request' : 'server error');
    });
  });

  const handle = async (req, res) => {
    lastActive = Date.now();
    // Kept from listen(): during a hand-over the server has stopped listening, and has no address.
    const port = boundPort;
    const self = `127.0.0.1:${port}`;
    const send = (code, body, type = 'application/json; charset=utf-8', extra = {}) => {
      res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', ...extra });
      res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
    };

    // Only this server's own pages: no other Host (DNS rebinding), no other Origin, no preflights.
    if (req.headers.host !== self) return send(403, { error: 'wrong host' });
    if (req.headers.origin !== undefined && req.headers.origin !== `http://${self}`) return send(403, { error: 'wrong origin' });
    if (req.method === 'OPTIONS') return send(403, { error: 'no cross-origin requests' });

    const url = new URL(req.url, `http://${self}`);
    const path = url.pathname;

    if (path.startsWith('/api/')) {
      const given = path === '/api/events' ? url.searchParams.get('token') : req.headers['x-learn-token'];
      if (!sameToken(given, token)) return send(401, { error: 'missing or wrong token' });

      if (path === '/api/ping') return send(200, { ok: true, pid: process.pid, version });

      // `reuse` (the Windows launcher): with a Learn page open, that page goes to the place asked
      // for and the launcher brings its window forward, so there is one Learn window.
      if (path === '/api/launch' && req.method === 'POST') {
        const { page, view, course, n, explain, clip, reuse } = JSON.parse((await readBody(req)) || '{}') || {};
        const target = typeof page === 'string' && page ? pagePath(page, { view, course, n, explain, clip }) : null;
        if (!target) return send(400, { error: 'no such page' });
        const open = target.key === 'learn' && reuse === true ? learnPages() : [];
        if (open.length) {
          if (target.view || target.course) write(open, { event: 'navigate', view: target.view, course: target.course });
          return send(200, { existing: true });
        }
        const nonce = randomBytes(16).toString('hex');
        launches.set(nonce, { page: target.path, until: Date.now() + LAUNCH_MS });
        return send(200, { nonce, path: launchPath(target.key, nonce) });
      }

      // `open` found this server on an older version: hand over to a new one, unless busy. It
      // names its own server.mjs: an install from GitHub keeps each version in a folder of its
      // own, so this server's folder never sees the new version.
      if (path === '/api/handover' && req.method === 'POST') {
        const target = handoverTarget(JSON.parse((await readBody(req)) || '{}') || {});
        if (!canHandOver(target)) return send(200, { ok: false });
        send(200, { ok: true });
        handOver(target);
        return;
      }

      // Learn's chats line (phaseLine).
      if (path === '/api/phases' && req.method === 'GET') return send(200, phaseLine(readChats(GLANCE_ROOT)));

      // A page in a native window opening another page in its own window (Learn's games mark):
      // one window per page, as `open` gives. Only where the window app is already built.
      if (path === '/api/open' && req.method === 'POST') {
        const { page, view, course, n, explain, clip, from } = JSON.parse((await readBody(req, MAX_SMALL_BODY)) || '{}') || {};
        const target = typeof page === 'string' && page ? pagePath(page, { view, course, n, explain, clip }) : null;
        if (!target) return send(400, { error: 'no such page' });
        const app = nativeApp({ build: false });
        if (!app) return send(200, { ok: false, error: 'no window app here' });
        // The asking page's own terminal (`from` is its page, e.g. 'learn'), so both stick to one.
        const opener = typeof from === 'string' ? pagePath(from) : null;
        const terminal = (opener && terminals.get(opener.key)) || lastTerminal;
        terminals.set(target.key, terminal);
        startWindow(app, { port, token }, target, terminal);
        return send(200, { ok: true, shown: 'window' });
      }

      // `open` started a native window that follows this terminal (see open() below).
      if (path === '/api/opened' && req.method === 'POST') {
        const { page, program, itermSession } = JSON.parse((await readBody(req, MAX_SMALL_BODY)) || '{}') || {};
        const target = typeof page === 'string' && page ? pagePath(page) : null;
        if (!target) return send(400, { error: 'no such page' });
        const terminal = cleanTerminal({ program, itermSession });
        if (terminal.program) {
          terminals.set(target.key, terminal);
          lastTerminal = terminal;
        }
        return send(200, { ok: true });
      }

      if (path === '/api/events' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        // A dropped stream (a hand-over) comes back within a second, not the browser's default three.
        res.write('retry: 1000\n: hello\n\n');
        // The version first, so a page that reconnects after a hand-over knows Learn was updated.
        write([res], { event: 'server', version });
        clients.add(res);
        pageOf.set(res, url.searchParams.get('page') === 'learn' ? 'learn' : 'other');
        const beat = setInterval(() => res.write(': beat\n\n'), 25_000);
        req.on('close', () => {
          clearInterval(beat);
          clients.delete(res);
          pageOf.delete(res);
          lastActive = Date.now();
        });
        return;
      }

      // A document for a new course: raw bytes, its name in X-File-Name. Answers its path here,
      // for build.start { file, name }.
      if (path === '/api/upload' && req.method === 'POST') {
        const name = uploadName(req.headers['x-file-name']);
        if (!name || !UPLOAD_TYPES.has(extname(name).toLowerCase())) return send(400, { ok: false, error: 'Learn reads PDF, Word (.docx), Markdown, text and HTML files' });
        if (Number(req.headers['content-length']) > MAX_UPLOAD) return send(413, { ok: false, error: 'the file is over 64 MB' });
        mkdirSync(UPLOADS_DIR, { recursive: true, mode: 0o700 });
        pruneUploads();
        const file = join(UPLOADS_DIR, `${randomBytes(6).toString('hex')}-${name}`);
        try {
          const size = await saveBody(req, file, MAX_UPLOAD);
          if (!size) {
            rmSync(file, { force: true });
            return send(400, { ok: false, error: 'the file is empty' });
          }
          return send(200, { ok: true, path: file, name, size });
        } catch (error) {
          return send(error.message === 'too large' ? 413 : 400, { ok: false, error: error.message === 'too large' ? 'the file is over 64 MB' : 'the upload broke off' });
        }
      }

      // A video's sound, for the player to play from a Blob. The helper says where it is, so this
      // server learns nothing about how a library is laid out.
      if (path === '/api/video-audio' && req.method === 'GET') {
        const explain = url.searchParams.get('explain');
        const answer = explain
          ? await helper.ask({ cmd: 'explain.audio', id: explain, n: Number(url.searchParams.get('clip')) })
          : await helper.ask({ cmd: 'video.audio', courseId: url.searchParams.get('course'), n: Number(url.searchParams.get('page')) });
        if (!answer.ok) return send(404, { error: answer.error });
        return send(200, readFileSync(answer.result.path), 'audio/mpeg');
      }

      if (path === '/api/rpc' && req.method === 'POST') {
        let request;
        try {
          request = JSON.parse(await readBody(req));
        } catch {
          return send(400, { ok: false, error: 'the body is not JSON' });
        }
        if (!request || typeof request.cmd !== 'string') return send(400, { ok: false, error: 'no cmd' });
        delete request.rid;
        const answer = await helper.ask(request);
        if (request.cmd === 'chat.send' && answer.ok && answer.result?.key) busyChats.add(answer.result.key);
        return send(200, answer.ok ? { ok: true, result: answer.result } : { ok: false, error: answer.error });
      }

      const save = /^\/api\/save\/([\w-]+)$/.exec(path);
      if (save) {
        const game = save[1];
        if (!GAMES.has(game)) return send(404, { error: 'no such game' });
        const file = join(SAVES_DIR, `${game}.json`);
        if (req.method === 'GET') return send(200, existsSync(file) ? readFileSync(file, 'utf8') : 'null');
        if (req.method === 'POST') {
          let text;
          try {
            text = await readBody(req);
            JSON.parse(text);
          } catch {
            return send(400, { error: 'the body is not JSON' });
          }
          writeAtomic(file, text);
          return send(200, { ok: true });
        }
      }

      // The shared appearance file. Every window (PowerShell, Swift, these pages) re-reads it on
      // each change, so only its four checked fields are ever written, never the body as sent.
      if (path === '/api/appearance') {
        if (req.method === 'GET') return send(200, existsSync(APPEARANCE_FILE) ? readFileSync(APPEARANCE_FILE, 'utf8') : 'null');
        if (req.method === 'POST') {
          const value = await readJsonObject(req);
          if (!value) return send(400, { error: 'the body is not a small JSON object' });
          const saved = existsSync(APPEARANCE_FILE) ? readFileSync(APPEARANCE_FILE, 'utf8') : null;
          const clean = cleanAppearance(value, saved);
          writeAtomic(APPEARANCE_FILE, JSON.stringify(clean));
          return send(200, { ok: true, appearance: clean });
        }
      }

      // Learn's prefs, kept on this machine rather than per browser origin.
      if (path === '/api/prefs') {
        if (req.method === 'GET') return send(200, existsSync(PREFS_FILE) ? readFileSync(PREFS_FILE, 'utf8') : 'null');
        if (req.method === 'POST') {
          const value = await readJsonObject(req);
          if (!value) return send(400, { error: 'the body is not a small JSON object' });
          let saved = null;
          try { saved = existsSync(PREFS_FILE) ? JSON.parse(readFileSync(PREFS_FILE, 'utf8')) : null; } catch {}
          writeAtomic(PREFS_FILE, JSON.stringify(mergePrefs(saved, value)));
          return send(200, { ok: true });
        }
      }

      if (path === '/api/releases' && req.method === 'GET') {
        try {
          const { releases } = JSON.parse(readFileSync(RELEASES_FILE, 'utf8'));
          const { version } = JSON.parse(readFileSync(PLUGIN_FILE, 'utf8'));
          return send(200, { version, releases: Array.isArray(releases) ? releases : [] });
        } catch {
          return send(200, { version: null, releases: [] });
        }
      }

      return send(404, { error: 'no such API' });
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, { error: 'GET only' });

    // The colour scheme for a page's first paint, linked right after /shared/theme.css. No token
    // (a stylesheet can't send one, and colours aren't secret), but only for this server's own
    // pages: a browser that says where a request comes from must say it's from here.
    if (path === '/look.css') {
      const site = req.headers['sec-fetch-site'];
      if (site !== undefined && site !== 'same-origin' && site !== 'none') return send(403, '/* this server\'s own pages only */', TYPES['.css']);
      const group = url.searchParams.get('group') === 'games' ? 'games' : 'learn';
      let saved = null;
      try {
        saved = readFileSync(APPEARANCE_FILE, 'utf8');
      } catch {
        // Nothing saved yet: Ember.
      }
      return send(200, lookCss(saved, group), TYPES['.css']);
    }

    // <page>/?launch=<nonce>, or the older /launch/<nonce>.
    const nonce = url.searchParams.get('launch') ?? /^\/launch\/([0-9a-f]{32})$/.exec(path)?.[1] ?? null;
    if (nonce !== null) {
      const target = /^[0-9a-f]{32}$/.test(nonce) ? launches.get(nonce) : undefined;
      launches.delete(nonce);
      if (!target || Date.now() > target.until) return send(403, 'This link has expired: open Learn again from the panel, or run /learn.', 'text/plain');
      return send(302, '', 'text/plain', { Location: `/${target.page}#token=${token}` });
    }

    const engine = /^\/engine\/([\w.-]+)$/.exec(path);
    if (engine) {
      if (!STOCKFISH[engine[1]]) return send(404, 'not found', 'text/plain');
      try {
        return send(200, await stockfishFile(engine[1]), TYPES[extname(engine[1])], { 'Cache-Control': 'max-age=86400' });
      } catch (error) {
        return send(502, String(error.message || error), 'text/plain');
      }
    }

    const data = /^\/data\/([\w.-]+)$/.exec(path);
    if (data) {
      if (!DATA_FILES.has(data[1])) return send(404, 'not found', 'text/plain');
      return send(200, readFileSync(join(WIDGET, data[1])), TYPES[extname(data[1])] || TYPES['.txt'], { 'Cache-Control': 'max-age=3600' });
    }

    if (path === '/') return send(302, '', 'text/plain', { Location: '/learn/' });
    let file = normalize(join(PUBLIC, decodeURIComponent(path)));
    if (file !== PUBLIC && !file.startsWith(PUBLIC + sep)) return send(403, 'no', 'text/plain');
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
    if (!existsSync(file)) return send(404, 'not found', 'text/plain');
    // Pages run only their own scripts: a link or text from a course can never run code.
    const policy = extname(file) === '.html' ? { 'Content-Security-Policy': CSP } : {};
    return send(200, readFileSync(file), TYPES[extname(file)] || 'application/octet-stream', policy);
  };

  const listen = port => new Promise((resolve, reject) => {
    const fail = error => {
      server.off('listening', done);
      reject(error);
    };
    const done = () => {
      server.off('error', fail);
      boundPort = server.address().port;
      resolve();
    };
    server.once('error', fail);
    server.once('listening', done);
    server.listen(port, '127.0.0.1');
  });

  const writeRecord = () => {
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(WEB_FILE, JSON.stringify({ port: boundPort, token, pid: process.pid, version }), { mode: 0o600 });
    chmodSync(WEB_FILE, 0o600);
  };

  (async () => {
    // Taking over: the old server has just let the port go; a moment's retry covers the gap.
    for (let tries = 0; ; tries++) {
      try {
        await listen(takeover?.port ?? 0);
        break;
      } catch (error) {
        if (!takeover || error.code !== 'EADDRINUSE' || tries >= 20) {
          process.stderr.write(`claude-panel: couldn't listen: ${error.message || error}\n`);
          process.exit(1);
        }
        await sleep(150);
      }
    }
    writeRecord();
    process.stdout.write(JSON.stringify({ event: 'listening', port: boundPort }) + '\n');
  })();

  // After an update the pages and the helper are new, but this server's own code is old: it hands
  // over to a new server on the same port with the same token, so open pages reconnect by
  // themselves (and offer a reload). Never while a request or a chat reply is in flight; if the new
  // one isn't up within HANDOVER_WAIT_MS, this one listens again and leaves that version alone.
  let handingOver = false;
  let failedFor = null;
  // `target`: the version to hand over to and its server.mjs; none means this folder's own.
  const ownTarget = () => ({ version: pluginVersion(), script: fileURLToPath(import.meta.url) });
  const canHandOver = (target = ownTarget()) =>
    !handingOver && target.version !== '0.0.0' && shouldHandOver({ running: version, plugin: target.version, busy: helper.busy() || busyChats.size > 0, failedFor });
  const handOver = async (target = ownTarget()) => {
    handingOver = true;
    const next = target.version;
    const port = boundPort;
    server.close();
    server.closeIdleConnections?.();
    const child = spawn(process.execPath, [target.script, 'serve'], { detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, CLAUDE_PANEL_TAKEOVER: '1' } });
    child.on('error', () => {});
    child.unref();
    const ready = await waitFor(async () => {
      const record = readRecord();
      return record && record.pid === child.pid && record.port === port && (await ping(record));
    }, HANDOVER_WAIT_MS);
    if (ready) {
      // The pages' event streams reconnect, to the new server.
      for (const res of clients) res.end();
      shutdown();
      return;
    }
    try {
      process.kill(child.pid);
    } catch {
      // It never started.
    }
    failedFor = next;
    process.stderr.write(`claude-panel: version ${next} didn't take over in time; staying on ${version}\n`);
    try {
      await listen(port);
      writeRecord();
    } catch {
      shutdown();
    }
    handingOver = false;
  };

  // Gone after 30 minutes with no page connected and no request; handed over after an update.
  setInterval(() => {
    if (clients.size === 0 && Date.now() - lastActive > IDLE_MS) shutdown();
    else if (canHandOver()) handOver();
  }, 60_000).unref();

  const shutdown = () => {
    helper.stop();
    try {
      const recorded = JSON.parse(readFileSync(WEB_FILE, 'utf8'));
      if (recorded.pid === process.pid) writeFileSync(WEB_FILE, '{}', { mode: 0o600 });
    } catch {
      // nothing recorded
    }
    process.exit(0);
  };
  process.on('unhandledRejection', error => process.stderr.write(`claude-panel: ${error?.stack || error}\n`));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

/**
 * Where a hand-over request says to go: `{version, script}` when `script` is another copy's
 * server.mjs whose plugin.json says that version (so only a real install of the plugin is ever
 * started); else this folder's own. `read` is readFileSync, swapped by the tests.
 */
export function handoverTarget(body, { own = { version: pluginVersion(), script: fileURLToPath(import.meta.url) }, read = readFileSync } = {}) {
  const { version, script } = body && typeof body === 'object' ? body : {};
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version) || typeof script !== 'string' || basename(script) !== 'server.mjs') return own;
  try {
    const manifest = JSON.parse(read(join(dirname(script), '..', '.claude-plugin', 'plugin.json'), 'utf8'));
    return manifest.version === version ? { version, script } : own;
  } catch {
    return own;
  }
}

// --- Finding or starting it, and opening the page -----------------------------------------------

function readRecord() {
  try {
    const value = JSON.parse(readFileSync(WEB_FILE, 'utf8'));
    return typeof value.port === 'number' && typeof value.token === 'string' ? value : null;
  } catch {
    return null;
  }
}

/**
 * A one-time launch address for `target` (from pagePath), from the running server, or
 * { existing: true } when `reuse` and a Learn page is open (it was sent to the place asked for).
 * A server older than launchPath answers only a nonce: its /launch/<nonce> still works.
 */
async function launchLink(record, target, { reuse = false } = {}) {
  const answer = await postJson(record, '/api/launch', { page: target.key, view: target.view, course: target.course, n: target.n, explain: target.explain, clip: target.clip, reuse });
  if (answer.existing === true) return { existing: true };
  if (typeof answer.nonce !== 'string') throw new Error('the server gave no launch link');
  const path = typeof answer.path === 'string' ? answer.path : `launch/${answer.nonce}`;
  return { link: `http://127.0.0.1:${record.port}/${path}` };
}

function ping(record) {
  return new Promise(resolve => {
    const req = httpRequest(
      { host: '127.0.0.1', port: record.port, path: '/api/ping', headers: { 'X-Learn-Token': record.token, Host: `127.0.0.1:${record.port}` }, timeout: 1500 },
      res => {
        res.resume();
        resolve(res.statusCode === 200);
      },
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

async function findOrStart() {
  const record = readRecord();
  if (record && (await ping(record))) {
    if (record.version === pluginVersion()) return record;
    // An older server: ask it to hand over (it may be busy, or too old to know how), and use
    // whichever server answers on the port after that.
    const answer = await postJson(record, '/api/handover', { version: pluginVersion(), script: fileURLToPath(import.meta.url) }).catch(() => null);
    if (answer?.ok === true) {
      const fresh = await waitFor(async () => {
        const now = readRecord();
        return now && now.pid !== record.pid && (await ping(now)) ? now : null;
      }, HANDOVER_WAIT_MS + 3_000);
      // Time for open pages to reconnect, so an open Learn is found and reused, not doubled.
      if (fresh) {
        await sleep(1_500);
        return fresh;
      }
    }
    const still = await waitFor(async () => (await ping(record) ? record : null), 3_000);
    if (still) return still;
  }
  // Detached, so a closed Claude session doesn't take an open tab with it.
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'serve'], { detached: true, stdio: 'ignore', env: process.env, windowsHide: true });
  child.unref();
  const started = Date.now();
  while (Date.now() - started < 10_000) {
    await new Promise(resolve => setTimeout(resolve, 150));
    const fresh = readRecord();
    if (fresh && fresh.pid === child.pid && (await ping(fresh))) return fresh;
  }
  throw new Error('the Learn server did not start');
}

function browserArgv(url) {
  if (process.platform === 'darwin') return ['open', [url]];
  if (process.platform === 'win32') return ['cmd', ['/c', 'start', '', url]];
  if (process.env.WSL_DISTRO_NAME) return ['cmd.exe', ['/c', 'start', '', url]];
  return ['xdg-open', [url]];
}

// --- The native window on macOS -------------------------------------------------------------

/** The plugin's version from plugin.json, for the window app's About box. */
export function pluginVersion() {
  try {
    const { version } = JSON.parse(readFileSync(PLUGIN_FILE, 'utf8'));
    return typeof version === 'string' && /^\d+\.\d+\.\d+$/.test(version) ? version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const infoPlist = version => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>dev.claude-panel.window</string>
  <key>CFBundleName</key><string>Claude Panel</string>
  <key>CFBundleExecutable</key><string>ClaudePanel</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${version}</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSAppleEventsUsageDescription</key><string>The progress panel asks iTerm2 which window holds your Claude session, so it can sit on that window and follow it.</string>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>
`;

/**
 * The window app's binary (mac/ClaudePanel.swift), built with swiftc the first time and
 * cached by the source's hash, so an update rebuilds it. Null where it can't be built
 * (no Xcode or Command Line Tools): the browser stands in. `build: false` only finds one
 * already built (a request handler must never wait minutes for swiftc).
 *
 * The hash leaves the version out: a release that doesn't touch the Swift keeps its binary,
 * and only the Info.plist beside it is rewritten with the new version.
 */
function nativeApp({ build = true } = {}) {
  if (process.platform !== 'darwin' || process.env.CLAUDE_PANEL_BROWSER === '1' || !existsSync(APP_SOURCE)) return null;
  const hash = createHash('sha256').update(readFileSync(APP_SOURCE)).update(infoPlist('')).digest('hex').slice(0, 16);
  const bundle = join(APP_CACHE, hash, 'Claude Panel.app');
  const binary = join(bundle, 'Contents', 'MacOS', 'ClaudePanel');
  const plistFile = join(bundle, 'Contents', 'Info.plist');
  const plist = infoPlist(pluginVersion());
  if (existsSync(binary)) {
    try {
      if (readFileSync(plistFile, 'utf8') !== plist) writeFileSync(plistFile, plist);
    } catch {
      // A plist that can't be rewritten only shows an old version number.
    }
    return binary;
  }
  if (!build) return null;
  // A build of this source that failed once isn't tried again on every open (a new version's
  // Swift is a new folder, so it gets its own try).
  const failed = `${binary}.failed`;
  if (existsSync(failed)) return null;
  // Without Apple's developer tools /usr/bin/xcrun is a stub that opens their "install" dialog;
  // xcode-select -p never asks, so it says first whether swiftc can run at all.
  if (spawnSync('xcode-select', ['-p'], { stdio: 'ignore', timeout: 5000 }).status !== 0) return null;
  mkdirSync(dirname(binary), { recursive: true });
  writeFileSync(plistFile, plist);
  const built = spawnSync('xcrun', ['swiftc', '-O', APP_SOURCE, '-o', `${binary}.tmp`], { encoding: 'utf8', timeout: 180_000 });
  if (built.status !== 0) {
    const why = (built.stderr || built.error?.message || '').slice(0, 2000);
    try { writeFileSync(failed, why); } catch {}
    process.stderr.write(`claude-panel: couldn't build the window app, using the browser: ${why.slice(0, 500)}\n`);
    return null;
  }
  renameSync(`${binary}.tmp`, binary);
  return binary;
}

/** The window app's id for a page: 'games/chess' is 'games-chess'. */
export const windowId = key => key.replace('/', '-');

/**
 * True when the window app already shows this page for this server (its pid file,
 * ClaudePanel.swift): that pid is alive and is the window app, not another process that was
 * given the number after the window closed.
 */
function windowShowing(key, port) {
  try {
    const [pid, shownPort] = readFileSync(join(WINDOWS_DIR, `${windowId(key)}.pid`), 'utf8').trim().split(/\s+/).map(Number);
    if (!(pid > 0) || shownPort !== port) return false;
    process.kill(pid, 0);
    const ps = spawnSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8', timeout: 2000 });
    // Where ps can't be run, the live pid is trusted, as before.
    if (ps.error) return true;
    return ps.status === 0 && /ClaudePanel\s*$/.test(ps.stdout);
  } catch {
    return false;
  }
}

/**
 * One native window for `target` (from pagePath): no tabs or address bar. One per page; a
 * second start brings the first forward. Given the chat's terminal, it sticks to it as the
 * floating panel does.
 */
function startWindow(app, record, target, terminal = {}) {
  // A window that's already open and asked for a view (`open learn --view settings`) gets the
  // path in its mailbox and loads it (no token: the page keeps it for the session); the new
  // process below only brings that window forward. With no such window, a mailbox left behind
  // by one that's gone is removed, so it can't send the new window to an old link.
  const mailbox = join(WINDOWS_DIR, `${windowId(target.key)}.open`);
  try {
    if (!windowShowing(target.key, record.port)) rmSync(mailbox, { force: true });
    else if (target.path !== `${target.key}/`) writeAtomic(mailbox, `/${target.path}\n`);
  } catch {
    // No mailbox: the window still comes forward, on the page it shows.
  }
  const url = `http://127.0.0.1:${record.port}/${target.path}`;
  const follow = terminal.program ? ['--terminal', terminal.program, '--iterm-session', terminal.itermSession || ''] : [];
  // The token goes on stdin, never in argv: any user on the Mac can read a process's arguments.
  const window = spawn(app, ['--url', url, '--token-stdin', '--id', windowId(target.key), '--title', WINDOW_TITLES[target.key], ...follow], { detached: true, stdio: ['pipe', 'ignore', 'ignore'] });
  window.on('error', () => {});
  window.stdin.on('error', () => {});
  window.stdin.end(`${record.token}\n`);
  window.unref();
}

/** POSTs JSON to the running server; resolves the answer's JSON. */
function postJson(record, path, value) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(value);
    const req = httpRequest(
      { host: '127.0.0.1', port: record.port, path, method: 'POST', timeout: 3000,
        headers: { 'X-Learn-Token': record.token, Host: `127.0.0.1:${record.port}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      res => {
        let text = '';
        res.on('data', chunk => { text += chunk; });
        res.on('end', () => {
          try {
            resolve(JSON.parse(text));
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('the server did not answer')));
    req.end(body);
  });
}

async function open(page, terminal = {}, deep = {}) {
  const target = pagePath(page, deep);
  if (target === null) throw new Error(`no such page: ${page}`);
  const record = await findOrStart();
  const url = `http://127.0.0.1:${record.port}/${target.path}`;
  let shown = 'browser';
  // CLAUDE_PANEL_LAUNCH=1: open nothing, answer a one-time link instead (the Windows launcher
  // opens it itself, which works where starting a Windows program from WSL doesn't). With a
  // Learn page already open the answer is `existing`: that page has gone to the place asked for,
  // and the launcher brings its window forward.
  if (process.env.CLAUDE_PANEL_LAUNCH === '1') {
    // CLAUDE_PANEL_NEW=1: a link even so (the launcher found no window to bring forward).
    const answer = await launchLink(record, target, { reuse: process.env.CLAUDE_PANEL_NEW !== '1' });
    const shown = answer.existing ? { shown: 'existing' } : { shown: 'none', launch: answer.link };
    process.stdout.write(JSON.stringify({ ok: true, url, port: record.port, ...shown }) + '\n');
    return;
  }
  if (process.env.CLAUDE_PANEL_NO_BROWSER !== '1') {
    const app = nativeApp();
    // One Learn window: an open Learn page is sent to the place asked for (`navigate`), so it
    // neither reloads (losing what was typed) nor gets a twin in a new tab.
    const sent = target.key === 'learn' ? await launchLink(record, target, { reuse: true }).catch(() => null) : null;
    if (app) {
      const follow = cleanTerminal(terminal);
      // The open window has its page already: started bare it only comes forward, with no mailbox.
      const bare = sent?.existing === true && windowShowing(target.key, record.port);
      startWindow(app, record, bare ? pagePath(target.key) : target, follow);
      shown = 'window';
      // So a page in this window that opens another (Learn's games mark) hands on this terminal.
      if (follow.program) await postJson(record, '/api/opened', { page: target.key, ...follow }).catch(() => {});
    } else if (sent?.existing === true) {
      // A browser tab can't be brought forward from here; it has gone to the place asked for.
      shown = 'existing';
    } else {
      // A one-time link, so the token never sits on the browser's command line.
      const { link } = sent?.link ? sent : await launchLink(record, target);
      const [command, args] = browserArgv(link);
      const opener = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
      if (process.env.WSL_DISTRO_NAME) {
        // From WSL the opener is a Windows cmd.exe that `start`s the browser and returns. Wait for
        // it: started from a wsl.exe that ends with this process (the Windows panel's link), WSL
        // would stop the opener with it, before the browser ever started.
        await new Promise(resolve => {
          opener.on('exit', resolve);
          opener.on('error', resolve);
          setTimeout(resolve, 10_000).unref();
        });
      } else {
        opener.unref();
      }
    }
  }
  // The URL without its token: the token stays out of logs and transcripts.
  process.stdout.write(JSON.stringify({ ok: true, url, port: record.port, shown }) + '\n');
}

// Run as a command (web.sh, findOrStart's child), not when a test imports the helpers above.
const isMain = (() => {
  try {
    return realpathSync(process.argv[1] || '') === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return true;
  }
})();

if (isMain) {
  const args = process.argv.slice(2);
  const mode = args.shift() || 'open';
  // `open` with only flags (`open --view settings`) is Learn.
  const page = args.length && !args[0].startsWith('--') ? args.shift() : 'learn';
  // `open <page> --terminal <TERM_PROGRAM> --iterm-session <id>`: the terminal a window sticks to;
  // `open learn --view <library|course|learned|ask|settings> --course <id>`: where Learn opens.
  const flag = name => (args.indexOf(name) >= 0 ? args[args.indexOf(name) + 1] : undefined);
  const terminal = { program: flag('--terminal') || process.env.TERM_PROGRAM, itermSession: flag('--iterm-session') || process.env.ITERM_SESSION_ID };
  const deep = { view: flag('--view'), course: flag('--course'), n: flag('--page'), explain: flag('--explain'), clip: flag('--clip') };
  if (mode === 'serve') serve();
  else if (mode === 'app-path') {
    // The plugin's floating panel on macOS runs this binary (in panel mode); null: no Swift here.
    const binary = nativeApp();
    process.stdout.write(JSON.stringify(binary ? { ok: true, binary } : { ok: false, error: 'the window app could not be built here' }) + '\n');
  }
  else if (mode === 'open') {
    open(page, terminal, deep).catch(error => {
      process.stdout.write(JSON.stringify({ ok: false, error: String(error.message || error) }) + '\n');
      process.exit(1);
    });
  } else {
    process.stderr.write('usage: node server.mjs open [learn [--view <view>] [--course <id>] | games | games/<sudoku|2048|typing|chess>] | serve | app-path\n');
    process.exit(2);
  }
}
