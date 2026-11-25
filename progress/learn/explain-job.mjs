// An explainer's job (/explain): a plan checked, then the job making its clips, run on its own.
// Shared by the progress plugin (through build.mjs, which pauses a course's videos around it and
// starts the job as `learn.mjs build run`) and the explain plugin (through explain-cli.mjs, `run`),
// so it needs nothing of courses.
import { existsSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SESSION_ID } from './chats.mjs';
import { askStructured, stopAll } from './claude.mjs';
import { checkExplainer, clipCounts, makeExplainer, readExplainer, saveExplainer, wantedClips } from './explain.mjs';
import { exportExplainer } from './export.mjs';
import { isJobLive, listJobs, now, readJob, saveJob, spawnJob } from './jobs.mjs';
import { writeJson } from './store.mjs';
import { ensureVoice, record } from './voice.mjs';
import { WORKSPACES, isOnWiki, sendToWiki, wikiFolder } from './wiki.mjs';

const EXPLAIN_CLI = fileURLToPath(new URL('./explain-cli.mjs', import.meta.url));

/** What an explainer's job reaches out to; the tests swap it. */
export const explainIo = { askStructured, ensureVoice, record, exportExplainer, sendToWiki };

/** How an explainer's job runs on its own, unless its caller says otherwise: `explain-cli.mjs run <job>`. */
export const explainDaemon = id => [EXPLAIN_CLI, 'run', id];

/**
 * An explainer from your session's plan: checked first, all of it (`{ problems }` go back to the
 * session), then made by a job of its own (`job`, explainJob unless the caller wraps it). `wiki` is
 * the workspace the person picked for this one (personal or shared), or nothing, and `folder` the
 * folder they named there: kept on it alone.
 */
export async function startExplainer(lib, { plan, sessionId, cwd, wiki = null, folder = null, io = explainIo, job = explainJob }) {
  if (!SESSION_ID.test(String(sessionId || ''))) throw new Error('that is not a chat id');
  if (!cwd || !existsSync(cwd)) throw new Error("the session's folder is not on this computer");
  const checked = await checkExplainer({ plan, sessionId, cwd, io, model: lib.settings.models.video });
  if (checked.problems) return { problems: checked.problems };
  const explainer = saveExplainer(lib, { ...checked.explainer, wiki: WORKSPACES.includes(wiki) ? { to: wiki, folder: wikiFolder(folder) } : null });
  const started = job(lib, explainer);
  return { id: explainer.id, clips: explainer.clips.length, wanted: wantedClips(explainer), depth: explainer.depth, wiki: explainer.wiki?.to ?? null, folder: explainer.wiki?.folder ?? null, job: started.id };
}

/**
 * The job making an explainer's clips: the one running, or a new one. A job counts as running only
 * while its process lives, so one killed by a reboot or a WSL shutdown carries on when it's asked
 * for again (`explain.at`). `before` runs only when a job is (re)started; `daemon` is its command.
 */
export function explainJob(lib, explainer, { daemon = explainDaemon, before = () => {} } = {}) {
  const running = listJobs(lib).find(job => job.kind === 'explain' && job.explain === explainer.id && job.state === 'running');
  if (running && isJobLive(running)) return running;
  before();
  if (running) {
    saveJob(lib, { ...running, pid: null, state: 'running', error: null, message: `Carrying on: ${running.step}` });
    spawnJob(lib, running.id, daemon(running.id));
    return readJob(lib, running.id);
  }
  const stamp = now().replace(/[-:T]/g, '').slice(0, 12);
  const job = saveJob(lib, {
    v: 1, id: `j${stamp}${randomBytes(2).toString('hex')}`, kind: 'explain', explain: explainer.id, topic: explainer.title, courseTitle: 'Explainer', link: null, category: null, mode: 'page', courseId: null, summary: null,
    step: 'voice', state: 'running', message: 'Getting ready', done: 0, total: wantedClips(explainer), working: [], leftMinutes: null, candidates: null, picks: null, pid: null, error: null, startedAt: now(),
  });
  spawnJob(lib, job.id, daemon(job.id));
  return job;
}

/**
 * Runs an explainer's job in this process: the voice set up when it's the first time, then its
 * clips (makeExplainer), then the wiki when it was picked for it: once, with every clip made. SIGTERM
 * pauses it; a failure is saved on the job with the step it was at.
 */
export async function runExplainJob(lib, id, io = explainIo) {
  let job = readJob(lib, id);
  if (!job) throw new Error(`no job ${id}`);
  // Stopped before this process came up (whoever starts one saves it as running first).
  if (job.state === 'paused') return job;
  const save = patch => {
    job = saveJob(lib, { ...job, ...patch });
    return job;
  };
  let stopping = false;
  let giveUp;
  const stopped = new Promise((_, reject) => { giveUp = reject; });
  stopped.catch(() => {});
  const uploading = new AbortController();
  const onStop = () => {
    stopping = true;
    stopAll();
    uploading.abort();
    giveUp(new Error('stopped'));
  };
  process.once('SIGTERM', onStop);
  save({ pid: process.pid, state: 'running', error: null });
  try {
    writeJson(lib.paths.explaining, { pid: process.pid, id: job.explain });
    try {
      if (job.step === 'voice') {
        // A download can't be stopped part way: the job ends without it, and its process ends the download.
        await Promise.race([io.ensureVoice({ onProgress: message => stopping || save({ message }) }), stopped]);
        save({ step: 'clips' });
      }
      const made = await makeExplainer({ lib, io, id: job.explain, save, isStopping: () => stopping });
      // Every clip ready, not only this run's: a job carried on after a reboot made just the rest.
      const explainer = readExplainer(lib, job.explain);
      const { done, total } = explainer ? clipCounts(lib, explainer) : { done: made, total: made };
      // The last clip is told with the wiki's answer: `done` isn't saved as all of them before it.
      let wiki = explainer?.wiki?.to ? explainer.wiki : null;
      if (wiki && done >= total && !isOnWiki(explainer) && io.sendToWiki) {
        save({ message: 'Putting it on the wiki', making: null });
        wiki = await io.sendToWiki(lib, explainer.id, { signal: uploading.signal });
      }
      const onWiki = wiki?.urls?.length && !wiki.error ? ', and on the wiki' : wiki?.error ? '; not on the wiki' : '';
      const message = done < total ? `${done} of ${total} clips ready` : `${total === 1 ? 'Your clip is ready' : `${total} clips ready`}${onWiki}`;
      save({ step: 'done', state: 'done', making: null, message, done, total, wiki: wiki ? { to: wiki.to, place: wiki.place || null, urls: wiki.urls || [], error: wiki.error || null } : null });
    } finally {
      rmSync(lib.paths.explaining, { force: true });
    }
  } catch (error) {
    stopAll();
    if (stopping) save({ state: 'paused', message: 'Paused' });
    else save({ state: 'failed', error: String(error.message || error).slice(0, 500), message: `Stopped at ${job.step}: ${String(error.message || error).slice(0, 120)}` });
  } finally {
    process.removeListener('SIGTERM', onStop);
  }
  return job;
}
