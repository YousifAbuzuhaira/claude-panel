// Where the player's data comes from: here, Learn's local server. An explainer exported as one
// file (learn/export.mjs) swaps in data-file.js, which has the same exports and reads the page
// itself. The player and explain.js talk to nothing else.
import { onEvents, rpc, token } from '../../shared/api.js';

/** What this page plays: a course page's video (?course=&page=) or an explainer's clip (?explain=&clip=). */
export function where() {
  const query = new URLSearchParams(location.search);
  return { courseId: query.get('course'), pageN: Number(query.get('page')), explainId: query.get('explain'), clipN: Number(query.get('clip') || 1) };
}

/** Keeps the event stream open, so the server doesn't idle out during a long video. */
export const keepAlive = () => { onEvents(() => {}); };

async function sound(path) {
  // An audio element can't send the token, so the sound is fetched and played from a Blob.
  const response = await fetch(path, { headers: { 'X-Learn-Token': token } });
  if (!response.ok) throw new Error('its sound is missing');
  return new Blob([await response.arrayBuffer()], { type: 'audio/mpeg' });
}

export async function courseVideo(courseId, n) {
  const video = await rpc('video.get', { courseId, n });
  return { video, blob: await sound(`/api/video-audio?course=${encodeURIComponent(courseId)}&page=${n}`) };
}

export const explainInfo = id => rpc('explain.get', { id });
/** Where you are (`{ n }`) or the depth picked (`{ depth }`): the job makes that clip first. */
export const explainAt = (id, change) => rpc('explain.at', { id, ...change });
export const explainVideo = (id, n) => rpc('explain.video', { id, n });
export const explainSound = (id, n) => sound(`/api/video-audio?explain=${encodeURIComponent(id)}&clip=${n}`);

/** Learn's Questions setting: what new videos are made with, and what the player shows. */
export const getQuestions = async () => (await rpc('settings.get').catch(() => null))?.videoQuestions === true;
export const saveQuestions = on => rpc('settings.set', { change: { videoQuestions: on } }).catch(() => {});

// Speed and subtitles carry over to every video. Kept by the server, since the port, and so the
// browser's storage, changes with each start; the server keeps the page's own prefs beside these.
export async function loadPrefs() {
  try {
    const response = await fetch('/api/prefs', { headers: { 'X-Learn-Token': token } });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}
export function savePrefs(prefs) {
  fetch('/api/prefs', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Learn-Token': token }, body: JSON.stringify(prefs), keepalive: true }).catch(() => {});
}

/** An answer to a page's question, counted as on the page, so it goes towards Review. */
export const countAnswer = answer => { rpc('check.answer', answer).catch(() => {}); };

const STORE = id => `claude-learn-explain:${id}`;
/** What you did in an explainer, kept for the tab's life: guesses made while waiting, clips watched or skipped. */
export function recall(id) {
  try {
    return JSON.parse(sessionStorage.getItem(STORE(id)) || '{}') || {};
  } catch {
    return {};
  }
}
export function remember(id, change) {
  const next = { ...recall(id), ...change(recall(id)) };
  try { sessionStorage.setItem(STORE(id), JSON.stringify(next)); } catch {}
  return next;
}

/** Another clip of the explainer: here a page of its own. */
export const go = (id, n) => { location.href = `${location.pathname}?explain=${encodeURIComponent(id)}&clip=${n}`; };
/** A page that can look again for clips made since it opened: here, never needed (it waits for them). */
export const refresh = null;

// One player per page here, so its life never ends before the page's. In a file, `go` plays
// another clip in the same page, and `life().signal` tells the last one's listeners to go.
const forever = new AbortController();
export const life = () => forever;
