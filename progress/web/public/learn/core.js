// What every Learn view shares: the app state, a tiny DOM builder, the toast, the banner,
// the helper call, two-click removes and inline edits. Pure DOM; no framework.
import { rpc } from '../shared/api.js';

export const VIEW_NAMES = ['library', 'course', 'learned', 'ask', 'settings'];
export const MIN_SCALE = 0.8;
export const MAX_SCALE = 1.6;

export const GLYPH = {
  check: '✓', half: '◐', empty: '○', full: '●', pending: '◌', skip: '⊘',
  play: '▶︎', link: '↗', dot: '·', up: '↑', down: '↓', left: '←', right: '→',
  close: '✕', box: '☐', ticked: '☑',
};

/** Everything on screen comes from here; nothing is kept on disk by the page. */
export const S = {
  view: 'library',
  helperReady: false,
  settings: null,
  status: null,
  library: null, // library.get
  concepts: null, // concept.list
  courseId: null,
  courseData: null, // course.get
  pageN: 0,
  pageData: null, // page.get
  textScale: 1,
  showContents: true,
};

// --- Remembered in the browser: the view, the open course, text size, the contents column.
const PREFS_KEY = 'claude-learn-prefs';

export function loadPrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
    if (VIEW_NAMES.includes(saved.view)) S.view = saved.view;
    if (typeof saved.courseId === 'string') S.courseId = saved.courseId;
    if (Number.isFinite(saved.textScale)) S.textScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, saved.textScale));
    if (typeof saved.showContents === 'boolean') S.showContents = saved.showContents;
  } catch {}
}

export function savePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ view: S.view, courseId: S.courseId, textScale: S.textScale, showContents: S.showContents }));
  } catch {}
}

// --- DOM ----------------------------------------------------------------------------------

/** `h('button.primary', { onclick }, 'Build')`. Props starting with `on` are listeners. */
export function h(spec, props = null, ...kids) {
  const [tag, ...classes] = spec.split('.');
  const el = document.createElement(tag || 'div');
  if (classes.length) el.className = classes.join(' ');
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue;
      if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
      else if (key === 'class') el.className = [el.className, value].filter(Boolean).join(' ');
      else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
      else if (key === 'dataset') Object.assign(el.dataset, value);
      else if (key in el && typeof value !== 'string') el[key] = value;
      else el.setAttribute(key, value === true ? '' : String(value));
    }
  }
  append(el, kids);
  return el;
}

function append(el, kids) {
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
}

/** A text link that acts: `link('rename', () => ...)`. Stops the click reaching the row. */
export function action(text, onClick, cls = '') {
  return h(`button.action${cls ? `.${cls}` : ''}`, {
    type: 'button',
    onclick: event => {
      event.stopPropagation();
      onClick(event);
    },
  }, text);
}

export function chip(text, on, onClick, extra = '') {
  return h(`button.chip${on ? '.on' : ''}${extra ? `.${extra}` : ''}`, {
    type: 'button',
    onclick: event => {
      event.stopPropagation();
      onClick(event);
    },
  }, text);
}

export const short = (text, max) => {
  const value = String(text || '');
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
};

export function formatDate(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const days = Math.floor((Date.now() - date.getTime()) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
}

export function formatClock(seconds) {
  if (seconds === null || seconds === undefined || !Number.isFinite(Number(seconds))) return '';
  const total = Math.floor(Number(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = String(total % 60).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${secs}` : `${minutes}:${secs}`;
}

export const isHttp = url => /^https?:\/\//i.test(String(url || ''));

/** Links open in a new tab, and only for http(s). */
export function openLink(url) {
  if (isHttp(url)) window.open(url, '_blank', 'noopener,noreferrer');
}

// --- Toast and banner ---------------------------------------------------------------------

let toastTimer = null;
export function toast(text, kind = 'info') {
  const el = document.getElementById('toast');
  el.textContent = text;
  el.className = `toast show ${kind === 'error' ? 'error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, 5000);
}

export function banner(text) {
  const el = document.getElementById('banner');
  el.textContent = text || '';
  el.hidden = !text;
}

// --- The helper ---------------------------------------------------------------------------

/** One helper command. Throws the helper's error. */
export const call = (cmd, args = {}) => rpc(cmd, args);

/** One helper command whose failure becomes a red toast; resolves undefined on failure. */
export async function act(cmd, args = {}) {
  try {
    return await rpc(cmd, args);
  } catch (error) {
    toast(String(error.message || error), 'error');
    return undefined;
  }
}

// --- A remove needs a second click within 4 s ----------------------------------------------

let armedKey = null;
let armedAt = 0;
/** True on the second click; the first turns `el` into a red "remove? click again". */
export function armed(key, el, prompt = 'remove? click again') {
  if (armedKey === key && Date.now() - armedAt < 4000) {
    armedKey = null;
    return true;
  }
  armedKey = key;
  armedAt = Date.now();
  if (el) {
    const before = el.textContent;
    el.textContent = prompt;
    el.classList.add('danger');
    setTimeout(() => {
      if (el.isConnected && el.textContent === prompt) {
        el.textContent = before;
        el.classList.remove('danger');
      }
    }, 4000);
  }
  if (!el) toast('Click again to remove');
  return false;
}

// --- Inline edits: Enter saves, Shift+Enter adds a line, Esc cancels -------------------------

export function inlineEdit({ value = '', placeholder = '', multiline = false, onSave, onCancel, cls = '' }) {
  const box = h(`textarea.inline-edit${cls ? `.${cls}` : ''}`, { placeholder, rows: multiline ? 3 : 1 });
  box.value = value;
  let done = false;
  const fit = () => {
    if (!multiline) return;
    box.style.height = 'auto';
    box.style.height = `${Math.min(240, box.scrollHeight + 2)}px`;
  };
  box.addEventListener('input', fit);
  box.addEventListener('click', event => event.stopPropagation());
  box.addEventListener('keydown', async event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      done = true;
      onCancel?.();
      return;
    }
    if (event.key === 'Enter') {
      if (event.shiftKey) {
        if (!multiline) event.preventDefault();
        return;
      }
      event.preventDefault();
      if (done) return;
      done = true;
      const ok = await onSave(box.value.trim());
      if (ok === false) done = false;
    }
  });
  requestAnimationFrame(() => {
    box.focus();
    box.setSelectionRange(box.value.length, box.value.length);
    if (!multiline) box.select();
    fit();
  });
  return box;
}

/** A text box with Enter wired (Shift+Enter for a new line in a multiline one). */
export function onEnter(box, fn) {
  box.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      fn();
    }
  });
}

// --- Cross-view hooks, filled in by app.js (keeps the modules free of import cycles) -------

export const nav = {
  showView: () => {},
  openCourse: () => {},
  refreshLibrary: () => {},
  refreshLearned: () => {},
  setTextScale: () => {},
};

export const categoryName = id => {
  const lists = [S.library?.categories, S.concepts?.categories, S.courseData?.categories];
  for (const list of lists) {
    const found = (list || []).find(category => category.id === id);
    if (found) return found.name;
  }
  return 'General';
};
