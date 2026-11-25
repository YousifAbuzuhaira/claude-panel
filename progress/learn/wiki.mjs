// An explainer on the Keops wiki, when the person picked a workspace as /explain asked (`wiki.to`,
// kept on that explainer alone: nothing goes out without it). Each clip is a doc of its own, in a
// folder named after the explainer: Explainers/<title>/01-first-clip.html, or inside a folder the
// person named, Explainers/<theirs>/<title>/. They go up once, when every clip of the depth is made,
// since each version there keeps a full copy. A clip's page knows where the others are and reads
// them through the wiki when they're asked for (data-file.js), so they still play one after
// another. No share link is made: the workspace's own people open it. The key is WIKI_API_KEY (a
// personal kwk_ key), only ever sent to the wiki as its sign-in.
import { explainerHtml, readyClips, slugOf } from './export.mjs';
import { clipCounts, listExplainers, nextClip, readExplainer, updateExplainer } from './explain.mjs';
import { readSettings, writeSettings } from './settings.mjs';

export const WORKSPACES = ['personal', 'shared'];
const FOLDER = 'Explainers';
const TIMEOUT_MS = 120_000;
const RETRY_MS = 2000;

/** A folder's name as the wiki takes it: no slashes, nothing unseen, not too long. */
const nameOf = text => String(text ?? '').replace(/[\\/\p{Cc}]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 80).replace(/^[. ]+|[. ]+$/g, '');

/** The folder a person named (`Auth`, `Auth/Sessions`), tidied: at most 3 deep, inside Explainers; null for none. */
export function wikiFolder(named) {
  const parts = String(typeof named === 'string' ? named : '').split(/[\\/]/).map(nameOf).filter(Boolean);
  if (parts[0]?.toLowerCase() === FOLDER.toLowerCase()) parts.shift();
  return parts.slice(0, 3).join('/') || null;
}

/** Where an explainer's clips go: its title's folder, with the id's last 4 when that name is `taken`. */
export const wikiPlace = (explainer, taken = false) => [FOLDER, ...(explainer.wiki?.folder ? [explainer.wiki.folder] : []), `${nameOf(explainer.title) || 'Explainer'}${taken ? ` ${String(explainer.id).slice(-4)}` : ''}`].join('/');

/** What goes up, a page per clip: `{ n, path, page }`, numbered as they play. */
export function wikiPages({ explainer, clips, place, questions = false }) {
  const paths = new Map(clips.map((clip, k) => [clip.n, `${place}/${String(k + 1).padStart(2, '0')}-${slugOf(explainer.clips[clip.n - 1].title) || 'clip'}.html`]));
  const elsewhere = { workspace: explainer.wiki.to, paths };
  return clips.map(clip => ({ n: clip.n, path: paths.get(clip.n), page: explainerHtml({ explainer, clips: [clip], questions, elsewhere }) }));
}

const sleep = (ms, signal) => new Promise((done, fail) => {
  const timer = setTimeout(done, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); fail(new Error('stopped')); }, { once: true });
});
const base = (url, fallback) => (url || fallback).replace(/\/+$/, '');

/**
 * One call to the wiki, made once more after a network slip or the wiki's own trouble (the same page
 * sent twice is one version). Throws in words the person can act on; a refusal other than of the key
 * is the caller's to read.
 */
async function call(path, init, { env, fetch, signal, retryMs }) {
  const once = async () => {
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    try {
      return await fetch(`${base(env.WIKI_API_URL, 'https://wiki-api.keops.ai')}${path}`, {
        ...init(),
        headers: { authorization: `Bearer ${env.WIKI_API_KEY}` },
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (error) {
      if (signal?.aborted) throw new Error('stopped');
      if (timeout.aborted) throw new Error("the wiki didn't answer in 2 minutes");
      return { failed: `couldn't reach the wiki (${error.cause?.code || error.message})` };
    }
  };
  let response = await once();
  if (response.failed || response.status >= 500) {
    await sleep(retryMs, signal);
    response = await once();
  }
  if (response.failed) throw new Error(response.failed);
  if (response.status === 401) throw new Error("the wiki refused WIKI_API_KEY: it's wrong, or was revoked");
  return response;
}

const refused = async response => {
  const body = await response.json().catch(() => null);
  return new Error(`the wiki refused it (${response.status}${body?.message ? `: ${String(body.message).slice(0, 120)}` : ''})`);
};

/**
 * Whether something is at a path already (a folder answers 400: it's no doc). Another explainer of
 * the same title may be there, someone else's in the shared workspace: its clips must not be written over.
 */
async function isThere(to, path, io) {
  const response = await call(`/api/docs/resolve?workspace=${to}&path=${encodeURIComponent(path)}`, () => ({ method: 'GET' }), io);
  if (response.status === 404) return false;
  if (response.ok || response.status === 400) return true;
  throw await refused(response);
}

/** One clip's page sent: its address on the wiki. */
async function pushPage({ path, page }, to, amend, io) {
  const response = await call('/api/docs/push', () => {
    const body = new FormData();
    body.set('workspace', to);
    body.set('path', path);
    body.set('renderMode', 'standalone');
    body.set('message', 'Clips made by /explain');
    if (amend) body.set('amend', 'true');
    body.set('file', new Blob([page], { type: 'text/html' }), path.split('/').at(-1));
    return { method: 'POST', body };
  }, io);
  if (!response.ok) throw await refused(response);
  const { id, slug, shortId } = (await response.json().catch(() => null))?.node || {};
  const name = shortId ? (slug ? `${slug}-${shortId}` : shortId) : id;
  if (!/^[\w-]+$/.test(String(name || ''))) throw new Error("the wiki took it but didn't say where it is");
  return `${base(io.env.WIKI_WEB_URL, 'https://wiki.keops.ai')}/d/${name}`;
}

/** An explainer that's on the wiki, every clip of it. */
export const isOnWiki = explainer => Boolean(explainer?.wiki?.urls?.length) && !explainer.wiki.error;

/**
 * Sends an explainer to the workspace picked for it, and keeps how it went on it: `{ to, place, urls,
 * error }` (its folder, each clip's address in order, or what went wrong). A failure is kept, never
 * thrown: the clips and their file are made whatever happens here. The last clip goes first, so the
 * one people open first is there once the ones it leads to are. `amend`: sent again, a page replaces
 * your own last version when that's under 10 minutes old.
 */
export async function sendToWiki(lib, id, { amend = false, signal = null, env = process.env, fetch = globalThis.fetch, retryMs = RETRY_MS } = {}) {
  const explainer = readExplainer(lib, id);
  const to = explainer?.wiki?.to;
  if (!WORKSPACES.includes(to)) return null;
  const io = { env, fetch, signal, retryMs };
  const keep = change => updateExplainer(lib, id, now => ({ wiki: { ...now.wiki, ...change } })).wiki;
  let place = explainer.wiki.place || null;
  const urls = [];
  let error = null;
  try {
    if (!nextClip(lib, explainer).done) throw new Error('its clips are not all made yet');
    if (!env.WIKI_API_KEY) throw new Error("WIKI_API_KEY isn't set where the clips were made");
    if (!place) {
      place = wikiPlace(explainer, await isThere(to, wikiPlace(explainer), io));
      keep({ place }); // sent again, it goes to the same folder, which is there by then
    }
    const pages = wikiPages({ explainer, clips: readyClips(lib, explainer), place, questions: readSettings().videoQuestions === true });
    for (const page of pages.reverse()) {
      if (signal?.aborted) throw new Error('stopped');
      urls.unshift(await pushPage(page, to, amend, io));
    }
  } catch (problem) {
    error = String(problem.message || problem).slice(0, 200);
  }
  keep({ urls, error, at: new Date().toISOString() });
  return { to, place, urls, error };
}

/**
 * `explain wiki [id | on | off]`, for /clips wiki: an explainer that asked for the wiki and isn't
 * there, sent again (with no id the newest one); already there, where it is. `off` stops /explain
 * asking about the wiki, `on` has it ask again. The answer is one JSON object.
 */
export async function wikiCommand(lib, word, options = {}) {
  if (word === 'on' || word === 'off') return { asking: writeSettings({ wiki: word === 'on' ? 'ask' : 'off' }).wiki === 'ask' };
  const asked = listExplainers(lib).map(item => readExplainer(lib, item.id)).filter(explainer => explainer?.wiki?.to);
  const explainer = word ? readExplainer(lib, word) : asked.find(item => !isOnWiki(item)) || asked[0];
  if (!explainer) return { found: false };
  const { done, total } = clipCounts(lib, explainer);
  const answer = { found: true, id: explainer.id, title: explainer.title, to: explainer.wiki?.to || null, place: explainer.wiki?.place || null, ready: done, clips: total, urls: [], error: null };
  if (!answer.to || !nextClip(lib, explainer).done) return { ...answer, waiting: Boolean(answer.to) };
  if (isOnWiki(explainer)) return { ...answer, urls: explainer.wiki.urls };
  return { ...answer, ...(await sendToWiki(lib, explainer.id, { amend: true, ...options })) };
}
