// An explainer on the Keops wiki, when the person picked a workspace as /explain asked (`wiki.to`,
// kept on that explainer alone: nothing goes out without it). It is the page ~/explainers has, sent
// once, when every clip of the depth is made, since each version there keeps a full copy; one page
// when the wiki takes it, else several. No share link is made: the workspace's own people open it.
// The key is WIKI_API_KEY (a personal kwk_ key), only ever sent to the wiki as its sign-in.
import { explainerHtml, exportName, pageDepth, clipTags, readyClips } from './export.mjs';
import { clipCounts, listExplainers, nextClip, readExplainer, updateExplainer } from './explain.mjs';
import { readSettings, writeSettings } from './settings.mjs';

export const WORKSPACES = ['personal', 'shared'];
export const MAX_PAGE = 4_900_000; // the wiki takes 5,000,000 bytes a doc
const FOLDER = 'Explainers';
const TIMEOUT_MS = 120_000;
const RETRY_MS = 2000;
// What a page's list of clips can grow by when it also says which part each one is in.
const PARTS_SLACK = 2000;

/** Where an explainer goes: the same each time, so sent again it's a new version of the same doc. */
export const wikiPath = (explainer, part = 0) => `${FOLDER}/${part ? exportName(explainer).replace(/\.html$/, `-part-${part}.html`) : exportName(explainer)}`;

/** Clips in order, as many to a part as fit in `room` bytes (one too big for any gets its own). */
export function packParts(sizes, room) {
  const parts = [];
  let used = 0;
  for (const { n, bytes } of sizes) {
    if (!parts.length || used + bytes > room) {
      parts.push([]);
      used = 0;
    }
    parts.at(-1).push(n);
    used += bytes;
  }
  return parts;
}

/** What goes up, `{ path, page }`: one page with every clip, or parts when it's over `max` bytes. */
export function wikiPages({ explainer, clips, questions = false, max = MAX_PAGE }) {
  const whole = explainerHtml({ explainer, clips, questions });
  if (Buffer.byteLength(whole) <= max) return [{ path: wikiPath(explainer), page: whole }];
  // Every part as deep as the whole: a part's own clips may all be of the first levels.
  const deep = { ...explainer, depth: pageDepth(explainer, clips) };
  const sizes = clips.map(clip => ({ n: clip.n, bytes: Buffer.byteLength(clipTags(clip, explainer.title)) + 1 }));
  const empty = Buffer.byteLength(explainerHtml({ explainer: deep, clips: [], questions }));
  const parts = packParts(sizes, max - empty - PARTS_SLACK);
  return parts.map((part, k) => ({
    path: wikiPath(explainer, k + 1),
    page: explainerHtml({ explainer: deep, clips: clips.filter(clip => part.includes(clip.n)), questions, parts }),
  }));
}

const sleep = (ms, signal) => new Promise((done, fail) => {
  const timer = setTimeout(done, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); fail(new Error('stopped')); }, { once: true });
});
const base = (url, fallback) => (url || fallback).replace(/\/+$/, '');

/** One page sent: its address on the wiki. Throws in words the person can act on. */
async function pushPage({ path, page, to, amend, env, fetch, signal, retryMs }) {
  const send = async () => {
    const form = new FormData();
    form.set('workspace', to);
    form.set('path', path);
    form.set('renderMode', 'standalone');
    form.set('message', 'Clips made by /explain');
    if (amend) form.set('amend', 'true');
    form.set('file', new Blob([page], { type: 'text/html' }), path.split('/').at(-1));
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    try {
      return await fetch(`${base(env.WIKI_API_URL, 'https://wiki-api.keops.ai')}/api/docs/push`, {
        method: 'POST',
        headers: { authorization: `Bearer ${env.WIKI_API_KEY}` },
        body: form,
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (error) {
      if (signal?.aborted) throw new Error('stopped');
      if (timeout.aborted) throw new Error("the wiki didn't answer in 2 minutes");
      return { failed: `couldn't reach the wiki (${error.cause?.code || error.message})` };
    }
  };
  let response = await send();
  // Once more after a network slip or the wiki's own trouble: the same page sent twice is one version.
  if (response.failed || response.status >= 500) {
    await sleep(retryMs, signal);
    response = await send();
  }
  if (response.failed) throw new Error(response.failed);
  if (response.status === 401) throw new Error("the wiki refused WIKI_API_KEY: it's wrong, or was revoked");
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`the wiki refused it (${response.status}${body?.message ? `: ${String(body.message).slice(0, 120)}` : ''})`);
  const { id, slug, shortId } = body?.node || {};
  const name = shortId ? (slug ? `${slug}-${shortId}` : shortId) : id;
  if (!/^[\w-]+$/.test(String(name || ''))) throw new Error("the wiki took it but didn't say where it is");
  return `${base(env.WIKI_WEB_URL, 'https://wiki.keops.ai')}/d/${name}`;
}

/** An explainer that's on the wiki, every part of it. */
export const isOnWiki = explainer => Boolean(explainer?.wiki?.urls?.length) && !explainer.wiki.error;

/**
 * Sends an explainer to the workspace picked for it, and keeps how it went on it: `{ to, urls,
 * error }`. A failure is kept, never thrown: the clips and their file are made whatever happens
 * here. `amend`: sent again, it replaces your own last version when that's under 10 minutes old.
 */
export async function sendToWiki(lib, id, { amend = false, signal = null, env = process.env, fetch = globalThis.fetch, max = MAX_PAGE, retryMs = RETRY_MS } = {}) {
  const explainer = readExplainer(lib, id);
  const to = explainer?.wiki?.to;
  if (!WORKSPACES.includes(to)) return null;
  const urls = [];
  let error = null;
  try {
    if (!nextClip(lib, explainer).done) throw new Error('its clips are not all made yet');
    if (!env.WIKI_API_KEY) throw new Error("WIKI_API_KEY isn't set where the clips were made");
    const clips = readyClips(lib, explainer);
    for (const { path, page } of wikiPages({ explainer, clips, questions: readSettings().videoQuestions === true, max })) {
      if (signal?.aborted) throw new Error('stopped');
      urls.push(await pushPage({ path, page, to, amend, env, fetch, signal, retryMs }));
    }
  } catch (problem) {
    error = String(problem.message || problem).slice(0, 200);
  }
  const wiki = { to, urls, error, at: new Date().toISOString() };
  updateExplainer(lib, id, () => ({ wiki }));
  return { to, urls, error };
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
  const answer = { found: true, id: explainer.id, title: explainer.title, to: explainer.wiki?.to || null, ready: done, clips: total, urls: [], error: null };
  if (!answer.to || !nextClip(lib, explainer).done) return { ...answer, waiting: Boolean(answer.to) };
  if (isOnWiki(explainer)) return { ...answer, urls: explainer.wiki.urls };
  return { ...answer, ...(await sendToWiki(lib, explainer.id, { amend: true, ...options })) };
}
