// Making videos: one job for the whole library, working down a queue, so only one voice records at
// a time and a course is never locked by hours of it. A video is made from a page and kept beside
// it in its own files, so the page can change meanwhile: the video is then marked out of date.
import { existsSync, renameSync, rmSync } from 'node:fs';
import { readCourse, readPage, recordUsage } from './library.mjs';
import { estimate, isOldPage, videoStamp } from './video-check.mjs';
import { writeScript } from './video-script.mjs';
import { voiceStatus } from './voice.mjs';
import { readJson, withLock, writeJson } from './store.mjs';

export const readQueue = lib => readJson(lib.paths.videoQueue) || [];

const inQueue = (queue, courseId, n) => queue.some(item => item.courseId === courseId && item.n === n);

/** Adds pages. `first` puts them next in line; a page already waiting moves rather than repeats. */
export function queueVideos(lib, courseId, pages, { first = false } = {}) {
  return withLock(lib.root, () => {
    const others = readQueue(lib).filter(item => !(item.courseId === courseId && pages.includes(item.n)));
    const added = pages.map(n => ({ courseId, n }));
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

/** What a page's video is doing: 'none', 'old', 'queued', 'making', 'ready' or 'stale'. */
export function videoInfo(lib, courseId, page, { queue = readQueue(lib), job = null } = {}) {
  const meta = readJson(metaFile(lib, courseId, page.n));
  const current = Boolean(meta) && meta.stamp === videoStamp(page);
  const making = job?.state === 'running' && job.current?.courseId === courseId && job.current?.n === page.n;
  let state = 'none';
  if (making) state = 'making';
  else if (inQueue(queue, courseId, page.n)) state = 'queued';
  else if (current) state = 'ready';
  else if (meta) state = 'stale';
  else if (isOldPage(page)) state = 'old';
  return { state, minutes: meta?.minutes ?? null, message: making ? job.message : null, estimate: estimate(String(page.markdown || '').split(/\s+/).length), voice: voiceStatus() };
}

/** The pages of a course a press of Make videos would make, and what they would cost. */
export function courseVideos(lib, course, { job = null } = {}) {
  const queue = readQueue(lib);
  const pages = course.pages.map(entry => readPage(lib, course.id, entry.n)).filter(Boolean);
  const info = pages.map(page => ({ page, ...videoInfo(lib, course.id, page, { queue, job }) }));
  const wanted = info.filter(item => item.state === 'none' || item.state === 'stale');
  const sum = key => wanted.reduce((total, item) => total + item.estimate[key], 0);
  return {
    voice: voiceStatus(),
    total: pages.length,
    ready: info.filter(item => item.state === 'ready').length,
    waiting: info.filter(item => item.state === 'queued' || item.state === 'making').length,
    old: info.filter(item => item.state === 'old').length,
    wanted: wanted.map(item => item.page.n),
    estimate: { minutes: Math.round(sum('minutes')), recordingMinutes: Math.round(sum('recordingMinutes')), mb: Math.round(sum('mb')) },
  };
}

/** The next page worth making. Anything no longer wanted (page gone, video current) leaves the queue. */
function nextWanted(lib) {
  for (const { courseId, n } of readQueue(lib)) {
    const course = readCourse(lib, courseId);
    const page = course && readPage(lib, courseId, n);
    const made = page && readJson(metaFile(lib, courseId, n));
    if (page && made?.stamp !== videoStamp(page)) return { course, page };
    leaveQueue(lib, courseId, n);
  }
  return null;
}

/** Moves a finished recording into place: the meta file last, as it says the rest are whole. */
function keep(lib, courseId, n, stamp, taken) {
  const base = lib.paths.videoBase(courseId, n);
  const made = readJson(`${base}.new.json`);
  renameSync(`${base}.new.mp3`, `${base}.mp3`);
  renameSync(`${base}.new.json`, `${base}.json`);
  writeJson(`${base}.meta.json`, { stamp, minutes: Math.round(made.audio.mainEnd / 6) / 10, questions: made.quiz.length, rebuilt: made.stats?.rebuilt || [], sections: made.sections.length, stats: made.stats, recordingSeconds: taken, at: new Date().toISOString() });
}

function dropNew(lib, courseId, n) {
  const base = lib.paths.videoBase(courseId, n);
  for (const name of [`${base}.new.json`, `${base}.new.mp3`, `${base}.new.mp3.tmp`, `${base}.new.json.tmp`]) rmSync(name, { force: true });
}

/** Works down the queue until it's empty; returns how many videos it made. */
export async function makeVideos({ lib, io, save, isStopping }) {
  const ask = async (prompt, schema) => {
    const call = () => io.askStructured({ prompt, schema, tools: [], model: lib.settings.models.build, cwd: lib.root, onRateLimit: recordUsage });
    try {
      return await call();
    } catch (error) {
      if (isStopping()) throw error;
      return call(); // one more go before the job stops
    }
  };
  let made = 0;
  for (let next = nextWanted(lib); next; next = nextWanted(lib)) {
    if (isStopping()) throw new Error('stopped');
    const { course, page } = next;
    const position = course.pages.findIndex(entry => entry.n === page.n) + 1;
    const say = text => save({ message: `${course.title}, page ${position}: ${text}` });
    const base = lib.paths.videoBase(course.id, page.n);
    const stamp = videoStamp(page);
    save({ current: { courseId: course.id, n: page.n }, done: made, total: made + readQueue(lib).length, message: `${course.title}, page ${position}` });
    // Saved before recording, so a stop never repeats Claude's work.
    let script = readJson(`${base}.script.json`);
    if (script?.stamp !== stamp) {
      script = await writeScript({ page, ask, onStep: say });
      script.stamp = stamp;
      writeJson(`${base}.script.json`, script);
    }
    const started = Date.now();
    say('recording');
    try {
      await io.record({
        scriptFile: `${base}.script.json`,
        out: `${base}.new`,
        onProgress: (said, of) => say(`recording, ${Math.min(99, Math.round((said / Math.max(of, 1)) * 100))}%`),
      });
    } catch (error) {
      dropNew(lib, course.id, page.n);
      if (readCourse(lib, course.id)) throw error; // otherwise the course went while this ran
    }
    // The page may have changed or gone meanwhile. That's not worth another hour's recording: the
    // older video stays, marked out of date, and nothing is made until it's asked for.
    const now = readPage(lib, course.id, page.n);
    if (now && videoStamp(now) === stamp && existsSync(`${base}.new.json`)) {
      keep(lib, course.id, page.n, stamp, Math.round((Date.now() - started) / 1000));
      made++;
    } else {
      dropNew(lib, course.id, page.n);
    }
    rmSync(`${base}.script.json`, { force: true });
    leaveQueue(lib, course.id, page.n);
  }
  return made;
}
