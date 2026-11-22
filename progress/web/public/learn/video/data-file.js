// The player's data in an explainer exported as one file (learn/export.mjs puts this in place of
// data.js, same exports): everything is in the page and nothing is sent anywhere. It plays from a
// double-clicked file and inside the wiki's sandboxed frame, where storage throws and a reload
// gets nothing new, so another clip plays in this same page (`go`) and what you do is kept in
// memory first, in localStorage only where that works.
const DATA = JSON.parse(document.getElementById('explainer-data').textContent);
const ready = DATA.info.clips.filter(clip => clip.state === 'ready').map(clip => clip.n);
const fromHash = () => Number(/(?:^#|&)clip=(\d+)/.exec(location.hash)?.[1]);
let clip = ready.includes(fromHash()) ? fromHash() : ready[0] || 1;

const memory = new Map();
const store = {
  get(key) {
    if (memory.has(key)) return memory.get(key);
    try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; }
  },
  set(key, value) {
    memory.set(key, value);
    try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
  },
};

export const where = () => ({ courseId: null, pageN: NaN, explainId: DATA.info.id, clipN: clip });
export const keepAlive = () => {};
export const courseVideo = async () => { throw new Error('this file holds an explainer only'); };

export const explainInfo = async () => DATA.info;
export const explainAt = async () => ({});
export async function explainVideo(id, n) {
  const node = document.getElementById(`clip-${n}`);
  if (!node) throw new Error('that clip is not in this file');
  return JSON.parse(node.textContent);
}
export async function explainSound(id, n) {
  const node = document.getElementById(`sound-${n}`);
  if (!node) throw new Error('its sound is missing');
  const text = atob(node.textContent.trim());
  const bytes = new Uint8Array(text.length);
  for (let k = 0; k < text.length; k++) bytes[k] = text.charCodeAt(k);
  return new Blob([bytes], { type: 'audio/mpeg' });
}

// The Questions setting as it was when the file was made, then yours, for this file only.
const QUESTIONS = `claude-learn-questions:${DATA.info.id}`;
export const getQuestions = async () => store.get(QUESTIONS) ?? DATA.questions === true;
export const saveQuestions = on => store.set(QUESTIONS, on);
export const loadPrefs = async () => store.get('claude-learn-video-prefs');
export const savePrefs = prefs => store.set('claude-learn-video-prefs', prefs);
export const countAnswer = () => {};

const STORE = id => `claude-learn-explain:${id}`;
export const recall = id => store.get(STORE(id)) || {};
export function remember(id, change) {
  const next = { ...recall(id), ...change(recall(id)) };
  store.set(STORE(id), next);
  return next;
}

/** Looks again for clips made since the file opened: a file on disk is written again after each clip. */
export const refresh = location.protocol === 'file:' ? () => location.reload() : null;

// One run of the player per clip: `go` ends the last one (`life().signal` takes its listeners and
// its frame loop), puts the frame back as it was and plays the clip asked for.
let controller = new AbortController();
let run = null;
let blank = '';
export const life = () => controller;

function start() {
  const frame = document.getElementById('frame');
  frame.innerHTML = blank;
  frame.hidden = false;
  const note = document.getElementById('note');
  note.hidden = true;
  note.textContent = '';
  // A clip that can't play has said why where the video would be.
  run().catch(() => {});
}

export function go(id, n) {
  controller.abort();
  controller = new AbortController();
  clip = n;
  try { history.replaceState(null, '', `#clip=${n}`); } catch {}
  start();
}

/** The player's body, run for the first clip now and again for each clip after. */
export function boot(player) {
  run = player;
  blank = document.getElementById('frame').innerHTML;
  start();
}
