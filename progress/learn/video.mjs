// Making videos: one job for the whole library, working down a queue, so only one voice records at
// a time and a course is never locked by hours of it. A video is made from a page and kept beside
// it in its own files, so the page can change meanwhile: the video is then marked out of date.
import { existsSync, rmSync } from 'node:fs';
import { readCourse, readPage, recordUsage } from './library.mjs';
import { estimate, isOldPage, videoStamp } from './video-check.mjs';
import { videoEffort, writeScript } from './video-script.mjs';
import { voiceStatus } from './voice.mjs';
import { readSettings } from './settings.mjs';
import { readJson, renameRetry, withLock, writeJson } from './store.mjs';

export const readQueue = lib => readJson(lib.paths.videoQueue) || [];

// How hard the model thinks about a script: in video-script.mjs, which explainers use without this queue.
export { videoEffort };

const inQueue = (queue, courseId, n) => queue.some(item => item.courseId === courseId && item.n === n);

/**
 * Adds pages. `first` puts them next in line; a page already waiting moves rather than repeats.
 * `again` makes a page that already has a current video, from a fresh script.
 */
export function queueVideos(lib, courseId, pages, { first = false, again = false } = {}) {
  return withLock(lib.root, () => {
    const others = readQueue(lib).filter(item => !(item.courseId === courseId && pages.includes(item.n)));
    const added = pages.map(n => ({ courseId, n, ...(again ? { again } : {}) }));
    if (again) for (const n of pages) rmSync(`${lib.paths.videoBase(courseId, n)}.script.json`, { force: true });
    const queue = first ? [...added, ...others] : [...others, ...added];
    writeJson(lib.paths.videoQueue, queue);
    return queue;
  });
}

function leaveQueue(lib, courseId, n) {
  withLock(lib.root, () => writeJson(lib.paths.videoQueue, readQueue(lib).filter(item => !(item.courseId === courseId && item.n === n))));
}

export function clearQueue(lib) {
  withLock(lib.root, () => writeJson(lib.paths.videoQueue, []));
}

const metaFile = (lib, courseId, n) => `${lib.paths.videoBase(courseId, n)}.meta.json`;
const WHOLE = ['.mp3', '.json', '.meta.json'];
const AHEAD_PAGES = 2; // the page being recorded, and the one whose script is written meanwhile

/** How a video came to be, for the page to say. Older videos don't know. */
const madeWith = meta => (meta ? { model: meta.model || null, effort: meta.effort || null, takenMinutes: meta.takenMinutes ?? (meta.stats ? Math.round((meta.stats.minutes || 0) + (meta.recordingSeconds || 0) / 60) : null), minutes: meta.minutes ?? null } : null);

/** "12 min" or "7 hours". */
export const timeText = minutes => (minutes < 60 ? `${Math.max(1, Math.round(minutes))} min` : `${Math.round(minutes / 6) / 10} hours`);

const wordsOf = page => String(page.markdown || '').split(/\s+/).length;

/** What a page's video is doing: 'none', 'old', 'queued', 'making', 'ready' or 'stale'. */
export function videoInfo(lib, courseId, page, { queue = readQueue(lib), job = null } = {}) {
  const base = lib.paths.videoBase(courseId, page.n);
  const meta = readJson(`${base}.meta.json`);
  const current = Boolean(meta) && meta.stamp === videoStamp(page);
  const progress = job?.state === 'running' ? (job.working || []).find(item => item.courseId === courseId && item.n === page.n) || null : null;
  let state = 'none';
  if (progress) state = 'making';
  else if (inQueue(queue, courseId, page.n)) state = 'queued';
  else if (current) state = 'ready';
  else if (meta) state = 'stale';
  else if (isOldPage(page)) state = 'old';
  return {
    state,
    minutes: meta?.minutes ?? null,
    made: madeWith(meta),
    earlier: madeWith(readJson(`${base}.previous.meta.json`)),
    progress,
    message: progress ? `${progress.note}, about ${timeText(progress.leftMinutes)} left` : null,
    estimate: estimate(wordsOf(page)),
    voice: voiceStatus(),
  };
}

/** The pages of a course a press of Make videos would make, and what they would cost. */
export function courseVideos(lib, course, { job = null } = {}) {
  const queue = readQueue(lib);
  const pages = course.pages.map(entry => readPage(lib, course.id, entry.n)).filter(Boolean);
  const info = pages.map(page => ({ page, ...videoInfo(lib, course.id, page, { queue, job }) }));
  const wanted = info.filter(item => item.state === 'none' || item.state === 'stale');
  const sum = key => wanted.reduce((total, item) => total + item.estimate[key], 0);
  // Scripts run ahead of recording, so after the first one only recording adds time.
  const total = sum('recordingMinutes') + (wanted[0]?.estimate.scriptMinutes || 0);
  return {
    voice: voiceStatus(),
    total: pages.length,
    ready: info.filter(item => item.state === 'ready').length,
    waiting: info.filter(item => item.state === 'queued' || item.state === 'making').length,
    old: info.filter(item => item.state === 'old').length,
    wanted: wanted.map(item => item.page.n),
    leftMinutes: job?.state === 'running' ? job.leftMinutes ?? null : null,
    estimate: { minutes: Math.round(sum('minutes')), recordingMinutes: Math.round(sum('recordingMinutes')), totalMinutes: Math.round(total), mb: Math.round(sum('mb')) },
  };
}

/** The next pages worth making, up to `count`. Anything no longer wanted leaves the queue. */
function nextWanted(lib, count) {
  const wanted = [];
  for (const { courseId, n, again = false } of readQueue(lib)) {
    const course = readCourse(lib, courseId);
    const page = course && readPage(lib, courseId, n);
    const made = page && readJson(metaFile(lib, courseId, n));
    if (page && (again || made?.stamp !== videoStamp(page))) wanted.push({ course, page, again });
    else leaveQueue(lib, courseId, n);
    if (wanted.length === count) break;
  }
  return wanted;
}

/**
 * Moves a finished recording into place: the meta file last, as it says the rest are whole. A video
 * made again leaves the one it replaces beside it, since a new setting can make it worse.
 */
function keep(lib, courseId, n, stamp, seconds, again) {
  const base = lib.paths.videoBase(courseId, n);
  const made = readJson(`${base}.new.json`);
  rmSync(`${base}.previous.meta.json`, { force: true });
  for (const end of WHOLE.slice(0, 2)) rmSync(`${base}.previous${end}`, { force: true });
  if (again && existsSync(`${base}.meta.json`)) for (const end of WHOLE) renameRetry(`${base}${end}`, `${base}.previous${end}`);
  renameRetry(`${base}.new.mp3`, `${base}.mp3`);
  renameRetry(`${base}.new.json`, `${base}.json`);
  const scriptSeconds = (made.stats?.minutes || 0) * 60;
  writeJson(`${base}.meta.json`, { stamp, minutes: Math.round(made.audio.mainEnd / 6) / 10, questions: made.quiz.length, rebuilt: made.stats?.rebuilt || [], sections: made.sections.length, stats: made.stats, recordingSeconds: seconds, takenMinutes: Math.round((scriptSeconds + seconds) / 6) / 10, model: made.model || null, effort: made.effort || null, at: new Date().toISOString() });
}

/** Puts the earlier version of a video in front; the one in front becomes the earlier one. */
export function swapVideo(lib, courseId, n) {
  const base = lib.paths.videoBase(courseId, n);
  if (!existsSync(`${base}.previous.meta.json`)) throw new Error('this video has no earlier version');
  withLock(lib.root, () => {
    for (const end of WHOLE) {
      renameRetry(`${base}${end}`, `${base}.swap${end}`);
      renameRetry(`${base}.previous${end}`, `${base}${end}`);
      renameRetry(`${base}.swap${end}`, `${base}.previous${end}`);
    }
  });
}

function dropNew(lib, courseId, n) {
  const base = lib.paths.videoBase(courseId, n);
  for (const name of [`${base}.new.json`, `${base}.new.mp3`, `${base}.new.mp3.tmp`, `${base}.new.json.tmp`]) rmSync(name, { force: true });
}

/** An explainer's clips are being made (its job is alive): a course's video waits to record. */
function explaining(lib) {
  const now = readJson(lib.paths.explaining);
  if (!now?.pid) return false;
  try {
    process.kill(now.pid, 0);
    return true;
  } catch {
    return false;
  }
}
const sleep = ms => new Promise(done => setTimeout(done, ms));

/** A page's share of its making taken up by the script; recording is the rest. */
const scriptShare = ({ scriptMinutes, recordingMinutes }) => scriptMinutes / Math.max(scriptMinutes + recordingMinutes, 1);

/** Works down the queue until it's empty; returns how many videos it made. */
export async function makeVideos({ lib, io, save, isStopping }) {
  const model = lib.settings.models.video;
  const effort = videoEffort(model);
  const ask = async (prompt, schema) => {
    const call = () => io.askStructured({ prompt, schema, tools: [], model, effort, cwd: lib.root, onRateLimit: recordUsage });
    try {
      return await call();
    } catch (error) {
      if (isStopping()) throw error;
      return call(); // one more go before the job stops
    }
  };
  let made = 0;
  let pace = 1; // how this machine compares with the estimate, once recording shows it
  const working = new Map();

  // Recording sets the pace, so what's queued counts its recording time, at the pace seen so far.
  const refresh = () => {
    const entries = [...working.values()];
    const now = Date.now();
    for (const item of entries) {
      const { fractionDone, parts, began } = item.live;
      const minutes = (now - began) / 60_000;
      if (item.stage === 'script') {
        item.fraction = Math.max(fractionDone, Math.min(0.95, minutes / parts.scriptMinutes)) * scriptShare(parts);
        item.ownLeft = Math.max(1, parts.scriptMinutes - minutes) + parts.recordingMinutes * pace;
      } else if (item.stage === 'ready') {
        item.fraction = scriptShare(parts);
        item.ownLeft = parts.recordingMinutes * pace;
      } else {
        item.fraction = scriptShare(parts) + (1 - scriptShare(parts)) * fractionDone;
        item.ownLeft = Math.max(0.5, item.live.recordLeft ?? parts.recordingMinutes * pace);
      }
    }
    const first = entries[0];
    // A page behind the first waits for it, and its script overlaps that wait.
    const inLine = item => item.live.parts.recordingMinutes * pace;
    entries.forEach((item, index) => { item.leftMinutes = Math.round((index ? Math.max(item.ownLeft, first.ownLeft + inLine(item)) : item.ownLeft) * 10) / 10; });
    const queued = readQueue(lib).filter(item => !working.has(`${item.courseId}:${item.n}`)).map(item => readPage(lib, item.courseId, item.n)).filter(Boolean);
    const later = queued.reduce((total, page) => total + estimate(wordsOf(page)).recordingMinutes * pace, 0);
    const behind = entries.slice(1).reduce((total, item) => total + inLine(item), 0);
    const leftMinutes = entries.length ? Math.round((first.ownLeft + behind + later) * 10) / 10 : null;
    const message = first ? `${first.courseTitle}, page ${first.position}: ${first.note}, about ${timeText(first.leftMinutes)} left` : 'Getting ready';
    const shown = entries.map(({ live, ownLeft, courseTitle, ...item }) => item);
    save({ working: shown, leftMinutes, done: made, total: made + readQueue(lib).length, message });
  };
  const tick = setInterval(refresh, 15_000);

  const entryFor = ({ course, page }) => {
    const name = `${course.id}:${page.n}`;
    if (!working.has(name)) {
      working.set(name, {
        courseId: course.id, n: page.n, title: page.title, courseTitle: course.title,
        position: course.pages.findIndex(entry => entry.n === page.n) + 1,
        stage: 'script', note: 'writing the script', fraction: 0, leftMinutes: 0, startedAt: new Date().toISOString(),
        live: { fractionDone: 0, parts: estimate(wordsOf(page)), began: Date.now() },
      });
    }
    return working.get(name);
  };

  const writeFor = async next => {
    const { page } = next;
    const entry = entryFor(next);
    const base = lib.paths.videoBase(next.course.id, page.n);
    const stamp = videoStamp(page);
    // Saved before recording, so a stop never repeats Claude's work. Learn's Questions setting is
    // read for each page: a script waiting to record with the other setting is written again.
    const questions = readSettings().videoQuestions;
    let script = readJson(`${base}.script.json`);
    if (script?.stamp !== stamp || (script.withQuestions ?? true) !== questions) {
      refresh();
      script = await writeScript({
        page,
        ask,
        questions,
        onStep: (note, share) => {
          entry.note = note;
          entry.live.fractionDone = share;
          refresh();
        },
      });
      Object.assign(script, { stamp, model, effort });
      writeJson(`${base}.script.json`, script);
    }
    entry.stage = 'ready';
    entry.note = 'script ready, waiting to record';
    entry.live.fractionDone = 1;
    refresh();
    return script;
  };

  // One script at a time, per version of a page. A failure ahead waits for that page's turn, so
  // the recording going on when it happened still finishes.
  const scripts = new Map();
  const scriptFor = next => {
    const name = `${next.course.id}:${next.page.n}:${videoStamp(next.page)}`;
    if (!scripts.has(name)) {
      const writing = writeFor(next);
      writing.catch(() => {});
      scripts.set(name, writing);
    }
    return scripts.get(name);
  };

  try {
    save({ working: [], leftMinutes: null });
    for (let wanted = nextWanted(lib, AHEAD_PAGES); wanted.length; wanted = nextWanted(lib, AHEAD_PAGES)) {
      if (isStopping()) throw new Error('stopped');
      const [next, after] = wanted;
      const { course, page, again } = next;
      const base = lib.paths.videoBase(course.id, page.n);
      const stamp = videoStamp(page);
      await scriptFor(next);
      if (after) scriptFor(after);
      const entry = entryFor(next);
      // Only one voice at a time: an explainer you're waiting on records first.
      while (explaining(lib)) {
        if (isStopping()) throw new Error('stopped');
        entry.note = 'waiting while an explainer records';
        refresh();
        await sleep(5000);
      }
      const started = Date.now();
      entry.stage = 'recording';
      entry.note = 'recording';
      entry.live.fractionDone = 0;
      refresh();
      try {
        await io.record({
          scriptFile: `${base}.script.json`,
          out: `${base}.new`,
          onProgress: (said, of) => {
            const share = Math.min(0.99, said / Math.max(of, 1));
            const minutes = (Date.now() - started) / 60_000;
            const whole = minutes / Math.max(share, 0.01);
            entry.live.fractionDone = share;
            entry.live.recordLeft = whole - minutes + 0.3; // and the file to write
            if (share > 0.03) pace = whole / Math.max(entry.live.parts.recordingMinutes, 1);
            entry.note = `recording, ${Math.round(share * 100)}%`;
            refresh();
          },
        });
      } catch (error) {
        dropNew(lib, course.id, page.n);
        if (readCourse(lib, course.id)) throw error; // otherwise the course went while this ran
      }
      // The page may have changed or gone meanwhile. That's not worth another hour's recording: the
      // older video stays, marked out of date, and nothing is made until it's asked for.
      const now = readPage(lib, course.id, page.n);
      if (now && videoStamp(now) === stamp && existsSync(`${base}.new.json`)) {
        keep(lib, course.id, page.n, stamp, Math.round((Date.now() - started) / 1000), again);
        made++;
      } else {
        dropNew(lib, course.id, page.n);
      }
      rmSync(`${base}.script.json`, { force: true });
      leaveQueue(lib, course.id, page.n);
      working.delete(`${course.id}:${page.n}`);
      refresh();
    }
    // The queue was emptied with a script still being written: it's kept for when it's wanted.
    await Promise.allSettled(scripts.values());
  } finally {
    clearInterval(tick);
  }
  return made;
}
