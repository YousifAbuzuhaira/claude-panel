// The player's data in an explainer exported as one file (learn/export.mjs puts this in place of
// data.js, same exports): everything is in the page and nothing is sent anywhere. It plays from a
// double-clicked file and inside the wiki's sandboxed frame, where storage throws and a reload
// gets nothing new, so another clip plays in this same page (`go`) and what you do is kept in
// memory first, in localStorage only where that works. On the wiki each clip is a page of its own:
// another clip is read from its page, through the reading the wiki gives a page's script.
const DATA = JSON.parse(document.getElementById('explainer-data').textContent);
const ready = DATA.info.clips.filter(clip => document.getElementById(`clip-${clip.n}`)).map(clip => clip.n);
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

// A clip's script and sound as text: from this page, or (kept once read) from its own page on the
// wiki. Only that clip of this same explainer is taken: something else may be at its path by now.
const tagIn = (html, id) => new RegExp(`<script type="[a-z/]+" id="${id}">([^<]*)<\\/script>`).exec(html)?.[1] ?? null;
const read = new Map();
async function readAway(n, path) {
  if (!globalThis.keopsWiki?.readDoc) throw new Error('not on the wiki');
  const { content } = await globalThis.keopsWiki.readDoc({ workspace: DATA.info.workspace, path });
  const [info, clip, sound] = ['explainer-data', `clip-${n}`, `sound-${n}`].map(id => tagIn(String(content), id));
  if (!clip || !sound || JSON.parse(info).info.id !== DATA.info.id) throw new Error('not there');
  return { clip, sound };
}
async function part(n, name) {
  const node = document.getElementById(`${name}-${n}`);
  if (node) return node.textContent;
  const path = DATA.info.clips[n - 1]?.path;
  if (!path) throw new Error(name === 'clip' ? 'that clip is not in this file' : 'its sound is missing');
  if (!read.has(n)) read.set(n, readAway(n, path));
  try {
    return (await read.get(n))[name];
  } catch {
    read.delete(n); // asked again, it is read again
    throw new Error(`Open ${path.split('/').at(-1).replace(/\.html$/, '')} in the folder ${path.split('/').at(-2)} instead`);
  }
}

export const explainInfo = async () => DATA.info;
export const explainAt = async () => ({});
export async function explainVideo(id, n) {
  const script = JSON.parse(await part(n, 'clip'));
  // The clip after it, read while this one plays, so it follows on with no wait.
  const next = DATA.info.clips.find(item => item.n > n && item.path && item.state === 'ready');
  if (next) part(next.n, 'clip').catch(() => {});
  return script;
}
export async function explainSound(id, n) {
  const text = atob((await part(n, 'sound')).trim());
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

let wanted = 0;
/** Another clip, in this same page. One that can't be read leaves the clip playing as it is, and says why. */
export async function go(id, n) {
  wanted = n;
  await part(n, 'sound');
  if (wanted !== n) return; // another was asked for while this one was read
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
