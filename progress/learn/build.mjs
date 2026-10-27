// Building a course, as steps saved in jobs/<id>.json: research, picks, fetch, outline,
// pages, done. A page job (rewrite one page, or add one) is the same machine with fewer
// steps: plan-page (for an added page), then pages. Each step is safe to run again, so a build stopped by a closed window, a
// sleep or a reboot carries on from where it got to. Builds run as their own detached
// process (`learn.mjs build run <id>`), so closing the window doesn't stop them.
import { spawn } from 'node:child_process';
import { mkdirSync, openSync, readdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { applyProposals, compactCatalogue, ensureCategory, findCategory, stateOf } from './catalogue.mjs';
import { askStructured, describeTool, stopAll } from './claude.mjs';
import { activeJobFor, buildStatus, newCourseId, readCatalogue, readCourse, readStatus, recordUsage, updateCatalogue, updateCourse, writeStatus } from './library.mjs';
import { markdownToBlocks } from './markdown.mjs';
import { overlapReport } from './overlap.mjs';
import { OUTLINE_SCHEMA, PAGE_PLAN_SCHEMA, PAGE_SCHEMA, RESEARCH_SCHEMA, outlinePrompt, pagePlanPrompt, pagePrompt, researchPrompt } from './prompts.mjs';
import {
  condenseTranscript, fetchPage, formatTime, isExtractorError, isPlaylist, isYouTube, sectionsOutline, sectionsText,
  transcriptText, watchUrl, youTubeId, ytCaptions, ytInfo, ytPlaylist, ytSearch,
} from './sources.mjs';
import { ensureYtDlp } from './deps.mjs';
import { readJson, withLock, writeJson } from './store.mjs';

const LEARN_MJS = fileURLToPath(new URL('./learn.mjs', import.meta.url));
const PAGES_AT_ONCE = 3;
const OUTLINE_BUDGET = 240_000; // characters of source material for the outline
const PAGE_BUDGET = 150_000; // characters of the main source for one page
const SUPPORT_BUDGET = 50_000;

const now = () => new Date().toISOString();

// --- Jobs ------------------------------------------------------------------------------

export const readJob = (lib, id) => readJson(lib.paths.job(id));

export function saveJob(lib, job) {
  const next = { ...job, updatedAt: now() };
  withLock(lib.root, () => writeJson(lib.paths.job(job.id), next));
  writeStatus({ build: buildStatus(next) });
  return next;
}

export function listJobs(lib) {
  let names = [];
  try {
    names = readdirSync(lib.paths.jobs).filter(name => name.endsWith('.json'));
  } catch {
    return [];
  }
  return names.map(name => readJson(`${lib.paths.jobs}/${name}`)).filter(Boolean).sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
}

/** Rewrite one page (`n`, with an optional note), or add one on `topic` after page `after`. */
export function createPageJob(lib, { courseId, kind, n = null, note = null, topic = null, after = null }) {
  const course = readCourse(lib, courseId);
  if (!course) throw new Error('no such course');
  if (activeJobFor(lib, courseId)) throw new Error('this course is being written: wait for that to finish');
  const stamp = now().replace(/[-:T]/g, '').slice(0, 12);
  const base = { v: 1, id: `j${stamp}${randomBytes(2).toString('hex')}`, kind, link: null, category: course.category, mode: 'page', courseId, courseTitle: course.title, summary: null, state: 'running', done: 0, total: course.pages.length, candidates: null, picks: null, pid: null, error: null, startedAt: now() };
  if (kind === 'page-rewrite') {
    const target = course.pages.find(page => page.n === Number(n));
    if (!target) throw new Error('no such page');
    updateCourse(lib, courseId, saved => {
      const entry = saved.pages.find(page => page.n === Number(n));
      entry.status = 'todo';
      entry.note = String(note || '').trim().slice(0, 500) || null;
      saved.status = 'building';
    });
    // The chat knew the old text.
    withLock(lib.root, () => writeJson(lib.paths.chat(courseId, Number(n)), { v: 1, sessionId: null, messages: [] }));
    return saveJob(lib, { ...base, topic: `Rewriting: ${target.title}`, step: 'pages', message: `Rewriting ${target.title}`, done: course.pages.filter(page => page.status === 'written').length - 1 });
  }
  if (kind === 'page-add') {
    const clean = String(topic || '').trim().slice(0, 200);
    if (!clean) throw new Error('say what the new page should be about');
    return saveJob(lib, { ...base, topic: `New page: ${clean}`, pageTopic: clean, after: after === null ? null : Number(after), step: 'plan-page', message: `Planning a page on ${clean}` });
  }
  throw new Error(`unknown page job ${kind}`);
}

export function createJob(lib, { topic, category, mode = 'pick', link = null }) {
  const cleanTopic = String(topic || '').trim().slice(0, 200);
  const cleanLink = link ? String(link).trim() : null;
  if (!cleanTopic && !cleanLink) throw new Error('type a topic or paste a link');
  if (cleanLink && !/^https?:\/\//.test(cleanLink)) throw new Error('the link must start with http:// or https://');
  const stamp = now().replace(/[-:T]/g, '').slice(0, 12);
  const job = {
    v: 1,
    id: `j${stamp}${randomBytes(2).toString('hex')}`,
    topic: cleanTopic || cleanLink,
    link: cleanLink,
    category: String(category || '').trim().slice(0, 60) || 'General',
    mode: cleanLink ? 'link' : mode === 'auto' ? 'auto' : 'pick',
    courseId: null,
    courseTitle: null,
    summary: null,
    step: 'research',
    state: 'running',
    message: cleanLink ? 'Reading the link' : `Researching ${cleanTopic}`,
    done: 0,
    total: 0,
    candidates: null,
    picks: null,
    pid: null,
    error: null,
    startedAt: now(),
  };
  return saveJob(lib, job);
}

const isAlive = pid => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
};

/** Starts `learn.mjs build run <id>` on its own, outliving whoever started it. */
export function startDaemon(lib, id) {
  mkdirSync(lib.paths.jobs, { recursive: true });
  const log = openSync(lib.paths.jobLog(id), 'a');
  const child = spawn(process.execPath, [LEARN_MJS, 'build', 'run', id], {
    detached: true,
    stdio: ['ignore', log, log],
    cwd: lib.root,
    env: { ...process.env, CLAUDE_PROGRESS_OFF: '1' },
  });
  child.unref();
  return child.pid;
}

/** Jobs that were running when their process died (reboot, WSL shut down): start them again. */
export function resumeStale(lib) {
  const resumed = [];
  for (const job of listJobs(lib)) {
    if (job.state === 'running' && (!job.pid || !isAlive(job.pid))) {
      saveJob(lib, { ...job, message: `Carrying on: ${job.message || job.step}` });
      startDaemon(lib, job.id);
      resumed.push(job.id);
    }
  }
  return resumed;
}

export function pickSources(lib, id, picks) {
  const job = readJob(lib, id);
  if (!job) throw new Error('no such build');
  const known = new Set((job.candidates || []).map(candidate => candidate.id));
  const chosen = [...new Set(picks)].filter(pick => known.has(pick));
  if (!chosen.length) throw new Error('pick at least one source');
  saveJob(lib, { ...job, picks: chosen, step: 'fetch', state: 'running', message: 'Reading the sources' });
  startDaemon(lib, id);
}

export function resumeJob(lib, id) {
  const job = readJob(lib, id);
  if (!job) throw new Error('no such build');
  if (job.state === 'running' && job.pid && isAlive(job.pid)) return;
  if (job.state === 'done') return;
  saveJob(lib, { ...job, state: 'running', error: null, message: `Carrying on: ${job.step}` });
  startDaemon(lib, id);
}

export function cancelJob(lib, id) {
  const job = readJob(lib, id);
  if (!job) throw new Error('no such build');
  if (job.state === 'done' || job.state === 'failed') return;
  if (job.pid && isAlive(job.pid)) {
    try { process.kill(job.pid, 'SIGTERM'); } catch {}
  }
  saveJob(lib, { ...readJob(lib, id), state: 'paused', message: 'Paused' });
}

// --- Running a job ------------------------------------------------------------------------

/** `io` is what the steps reach out to; the tests swap it. */
export const defaultIo = { askStructured, ytSearch, ytInfo, ytCaptions, ytPlaylist, fetchPage, ensureYtDlp };

export async function runJob(lib, id, io = defaultIo) {
  let job = readJob(lib, id);
  if (!job) throw new Error(`no build ${id}`);
  const save = patch => {
    job = saveJob(lib, { ...job, ...patch });
    return job;
  };
  let stopping = false;
  const onStop = () => {
    stopping = true;
    stopAll();
  };
  process.once('SIGTERM', onStop);
  save({ pid: process.pid, state: 'running', error: null });
  try {
    if (job.step === 'research') await research(lib, job, save, io);
    if (job.step === 'picks') {
      if (!job.picks || !job.picks.length) {
        save({ state: 'waiting-picks', message: 'Pick the sources to build from' });
        return job;
      }
      save({ step: 'fetch' });
    }
    if (job.step === 'fetch') await fetchSources(lib, job, save, io);
    if (job.step === 'outline') await outline(lib, job, save, io);
    if (job.step === 'plan-page') await planPage(lib, job, save, io);
    if (job.step === 'pages') await writePages(lib, job, save, io, () => stopping);
    if (job.step === 'done' || job.step === 'pages') {
      const course = readCourse(lib, job.courseId);
      const message = job.kind === 'page-rewrite' ? `Rewritten: ${job.topic.replace(/^Rewriting: /, '')}` : job.kind === 'page-add' ? `Added: ${job.addedTitle || job.pageTopic}` : `Ready: ${course.title}`;
      save({ step: 'done', state: 'done', message, done: course.pages.length, total: course.pages.length });
      if (!readStatus().course) writeStatus({ course: { id: course.id, title: course.title, page: 1, total: course.pages.length, next: course.pages[0]?.title || '' } });
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

function knownConcepts(lib, categoryName) {
  const catalogue = readCatalogue(lib);
  const category = findCategory(catalogue, categoryName);
  const inCategory = catalogue.concepts.filter(concept => !category || concept.category === category.id || (concept.alsoUsedIn || []).includes(category.id));
  return {
    learned: inCategory.filter(concept => stateOf(concept) === 'learned').map(concept => concept.name).slice(0, 200),
    seen: inCategory.filter(concept => stateOf(concept) === 'seen').map(concept => concept.name).slice(0, 200),
  };
}

/** Candidate urls tidied: YouTube links as plain watch urls, no duplicates, ids s1, s2... */
export function tidyCandidates(candidates) {
  const seen = new Set();
  const out = [];
  for (const candidate of candidates) {
    let url = String(candidate.url || '').trim();
    if (!/^https?:\/\//.test(url)) continue;
    const video = youTubeId(url);
    const kind = video ? 'youtube' : 'web';
    if (video) url = watchUrl(video);
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({
      id: `s${out.length + 1}`,
      kind,
      url,
      title: String(candidate.title || url).slice(0, 200),
      channel: String(candidate.channel || '').slice(0, 100),
      lengthMin: Number.isFinite(candidate.lengthMin) ? Math.round(candidate.lengthMin) : null,
      level: candidate.level || null,
      why: String(candidate.why || '').slice(0, 400),
      recommended: Boolean(candidate.recommended),
    });
  }
  return out;
}

async function research(lib, job, save, io) {
  if (job.link) {
    let candidates;
    let title;
    if (isYouTube(job.link) && isPlaylist(job.link)) {
      save({ message: 'Reading the playlist' });
      const playlist = await io.ytPlaylist(job.link);
      title = playlist.title;
      candidates = playlist.videos.slice(0, 40).map(video => ({ ...video, why: 'From the playlist you gave', recommended: true }));
    } else if (isYouTube(job.link)) {
      const info = await io.ytInfo(job.link);
      title = info.title;
      candidates = [{ kind: 'youtube', url: job.link, title: info.title, channel: info.channel, lengthMin: Math.round(info.durationSec / 60), why: 'The video you gave', recommended: true }];
    } else {
      const page = await io.fetchPage(job.link);
      title = page.title || job.link;
      candidates = [{ kind: 'web', url: job.link, title, channel: new URL(job.link).hostname, lengthMin: null, why: 'The page you gave', recommended: true }];
    }
    const tidy = tidyCandidates(candidates);
    save({ candidates: tidy, picks: tidy.map(candidate => candidate.id), courseTitle: title, topic: job.topic === job.link ? title : job.topic, step: 'fetch' });
    return;
  }
  save({ message: `Searching YouTube for ${job.topic}` });
  const videos = [];
  for (const query of [`${job.topic} course`, `${job.topic} tutorial`]) {
    try {
      videos.push(...(await io.ytSearch(query, 8)));
    } catch {
      // Claude can still search on its own.
    }
  }
  const unique = [...new Map(videos.map(video => [video.url, video])).values()];
  save({ message: `Finding the best sources for ${job.topic}` });
  const answer = await io.askStructured({
    prompt: researchPrompt({ topic: job.topic, category: job.category, known: knownConcepts(lib, job.category), videos: unique }),
    schema: RESEARCH_SCHEMA,
    tools: ['WebSearch', 'WebFetch'],
    model: lib.settings.models.build,
    cwd: lib.root,
    onRateLimit: recordUsage,
    onTool: tool => save({ message: describeTool(tool) }),
  });
  const candidates = tidyCandidates(answer.candidates || []);
  if (!candidates.length) throw new Error('research found no usable sources');
  let picks = candidates.filter(candidate => candidate.recommended).map(candidate => candidate.id);
  if (!picks.length) picks = candidates.slice(0, 3).map(candidate => candidate.id);
  if (job.mode === 'pick') {
    save({ candidates, courseTitle: answer.courseTitle, summary: answer.summary, step: 'picks', state: 'waiting-picks', message: `Pick the sources for ${job.topic}` });
  } else {
    save({ candidates, courseTitle: answer.courseTitle, summary: answer.summary, picks, step: 'fetch' });
  }
}

async function fetchSources(lib, job, save, io) {
  let courseId = job.courseId;
  if (!courseId) {
    courseId = newCourseId(job.courseTitle || job.topic);
    const category = updateCatalogue(lib, catalogue => ensureCategory(catalogue, job.category));
    const picked = job.candidates.filter(candidate => job.picks.includes(candidate.id));
    withLock(lib.root, () => writeJson(lib.paths.course(courseId), {
      v: 1,
      id: courseId,
      title: job.courseTitle || job.topic,
      topic: job.topic,
      summary: job.summary || '',
      category: category.id,
      status: 'building',
      createdAt: now(),
      jobId: job.id,
      sources: picked.map(candidate => ({ ...candidate, fetched: false, usable: null, reason: null })),
      pages: [],
      read: [],
      skipped: [],
      progress: null,
      overlap: null,
    }));
    save({ courseId });
  }
  const course = readCourse(lib, courseId);
  const total = course.sources.length;
  let index = 0;
  for (const source of course.sources) {
    index++;
    if (source.fetched) continue;
    save({ message: `Reading ${source.kind === 'youtube' ? 'video' : 'page'} ${index}/${total}: ${source.title}` });
    let record;
    try {
      record = source.kind === 'youtube' ? await fetchVideo(lib, courseId, source, io) : await fetchWeb(source, io);
    } catch (error) {
      record = { usable: false, reason: String(error.message || error).slice(0, 200) };
    }
    if (record.data) withLock(lib.root, () => writeJson(lib.paths.source(courseId, source.id), record.data));
    updateCourse(lib, courseId, saved => {
      const entry = saved.sources.find(item => item.id === source.id);
      Object.assign(entry, { fetched: true, usable: record.usable, reason: record.reason || null }, record.meta || {});
    });
  }
  const after = readCourse(lib, courseId);
  if (!after.sources.some(source => source.usable)) {
    throw new Error(`none of the sources could be read (${after.sources.map(source => source.reason).filter(Boolean).join('; ')})`);
  }
  save({ step: 'outline' });
}

async function fetchVideo(lib, courseId, source, io) {
  const info = await io.ytInfo(source.url);
  let captions = await io.ytCaptions(info.id, lib.paths.captions(courseId));
  if (!captions.chunks && isExtractorError(captions.reason || '')) {
    await io.ensureYtDlp({ force: true });
    captions = await io.ytCaptions(info.id, lib.paths.captions(courseId));
  }
  const meta = { title: info.title, channel: info.channel, lengthMin: Math.round(info.durationSec / 60), videoId: info.id };
  if (!captions.chunks) return { usable: false, reason: `no transcript: ${captions.reason}`, meta };
  return {
    usable: true,
    meta,
    data: { v: 1, id: source.id, kind: 'youtube', url: source.url, videoId: info.id, title: info.title, channel: info.channel, durationSec: info.durationSec, chapters: info.chapters, chunks: captions.chunks },
  };
}

async function fetchWeb(source, io) {
  const page = await io.fetchPage(source.url);
  const size = page.sections.reduce((total, section) => total + section.text.length, 0);
  const meta = { title: page.title || source.title };
  if (size < 500) return { usable: false, reason: 'the page has almost no text (it may need a browser)', meta };
  return { usable: true, meta, data: { v: 1, id: source.id, kind: 'web', url: source.url, title: page.title || source.title, sections: page.sections } };
}

const readSource = (lib, courseId, id) => readJson(lib.paths.source(courseId, id));

async function outline(lib, job, save, io) {
  const course = readCourse(lib, job.courseId);
  const sources = sourceExcerpts(lib, course);
  const catalogue = readCatalogue(lib);
  save({ message: `Planning ${course.title}` });
  const plan = await io.askStructured({
    prompt: outlinePrompt({ topic: job.topic, title: course.title, category: job.category, sources, catalogue: compactCatalogue(catalogue) }),
    schema: OUTLINE_SCHEMA,
    tools: [],
    model: lib.settings.models.build,
    cwd: lib.root,
    onRateLimit: recordUsage,
  });
  const pages = cleanOutline(plan.pages || [], sources);
  if (!pages.length) throw new Error('the plan had no pages');
  // All proposals at once, so a parent can name a concept another page introduces.
  const proposals = pages.flatMap(page => page.proposals);
  const { ids, report } = updateCatalogue(lib, catalogue => applyProposals(catalogue, proposals, course.category));
  let at = 0;
  const finished = pages.map((page, i) => {
    const concepts = [...new Set(ids.slice(at, at + page.proposals.length))];
    at += page.proposals.length;
    const { proposals: _unused, ...rest } = page;
    return { ...rest, n: i + 1, concepts, status: 'todo' };
  });
  const after = readCatalogue(lib);
  const overlap = overlapReport(after, finished, course.id);
  updateCourse(lib, course.id, saved => {
    saved.title = String(plan.title || saved.title).slice(0, 120);
    saved.summary = String(plan.summary || saved.summary || '').slice(0, 600);
    saved.pages = finished;
    saved.matches = report;
    saved.overlap = { ...overlap, seen: false, at: now() };
  });
  save({ step: 'pages', total: finished.length, done: 0, message: `Writing ${finished.length} pages` });
}

/** The excerpts a planner reads: a spread of each transcript, or each page's headings. */
function sourceExcerpts(lib, course) {
  const usable = course.sources.filter(source => source.usable);
  const budget = Math.max(20_000, Math.floor(OUTLINE_BUDGET / Math.max(1, usable.length)));
  return usable.map(source => {
    const data = readSource(lib, course.id, source.id);
    return data.kind === 'youtube'
      ? { ...data, excerpt: condenseTranscript(data.chunks, budget) }
      : { ...data, excerpt: sectionsOutline(data.sections, 400).slice(0, budget) };
  });
}

/** One page the learner asked for: planned from the course's sources, put after `job.after`. */
async function planPage(lib, job, save, io) {
  const course = readCourse(lib, job.courseId);
  const sources = sourceExcerpts(lib, course);
  if (!sources.length) throw new Error('this course has no readable sources to plan from');
  const plan = await io.askStructured({
    prompt: pagePlanPrompt({ course, topic: job.pageTopic, titles: course.pages.map(page => page.title), sources, catalogue: compactCatalogue(readCatalogue(lib)) }),
    schema: PAGE_PLAN_SCHEMA,
    tools: [],
    model: lib.settings.models.build,
    cwd: lib.root,
    onRateLimit: recordUsage,
  });
  const [page] = cleanOutline([plan], sources);
  if (!page) throw new Error('the plan had no page');
  const { ids } = updateCatalogue(lib, catalogue => applyProposals(catalogue, page.proposals, course.category));
  const { proposals: _unused, ...rest } = page;
  const saved = updateCourse(lib, course.id, item => {
    const n = Math.max(0, ...item.pages.map(other => other.n)) + 1;
    const at = job.after === null ? item.pages.length : item.pages.findIndex(other => other.n === job.after) + 1;
    item.pages.splice(at > 0 ? at : item.pages.length, 0, { ...rest, n, concepts: [...new Set(ids)], status: 'todo', added: true });
    item.status = 'building';
    return item;
  });
  save({ step: 'pages', addedTitle: page.title, total: saved.pages.length, done: saved.pages.filter(other => other.status === 'written').length, message: `Writing ${page.title}` });
}

/** The plan's pages made safe: real sources, times inside the video, headings that exist. */
export function cleanOutline(pages, sources) {
  const byId = new Map(sources.map(source => [source.id, source]));
  const first = sources[0];
  const headings = source => new Map((source.sections || []).map(section => [section.heading.toLowerCase().trim(), section.heading]));
  const window = (source, from, to) => {
    if (source.kind !== 'youtube') return { fromSec: null, toSec: null };
    const end = source.durationSec || 0;
    const start = Math.max(0, Math.min(end, Number.isFinite(from) ? from : 0));
    const stop = Math.max(start + 30, Math.min(end || Infinity, Number.isFinite(to) ? to : end));
    return { fromSec: Math.floor(start), toSec: Math.floor(stop) };
  };
  const pickSections = (source, names) => {
    if (source.kind !== 'web') return [];
    const known = headings(source);
    return (names || []).map(name => known.get(String(name).toLowerCase().trim())).filter(Boolean);
  };
  return pages.filter(page => page && page.title).slice(0, 20).map(page => {
    const source = byId.get(page.sourceId) || first;
    const support = (page.support || [])
      .map(item => ({ item, source: byId.get(item.sourceId) }))
      .filter(({ source: other }) => other && other.id !== source.id)
      .map(({ item, source: other }) => ({ sourceId: other.id, ...window(other, item.fromSec, item.toSec), sections: pickSections(other, item.sections) }));
    return {
      title: String(page.title).slice(0, 120),
      subtopics: (page.subtopics || []).map(String).slice(0, 8),
      sourceId: source.id,
      ...window(source, page.fromSec, page.toSec),
      sections: pickSections(source, page.sections),
      support,
      proposals: (page.concepts || []).filter(concept => concept && concept.name).slice(0, 6),
    };
  });
}

function material(source, from, to, sections, budget) {
  if (source.kind === 'youtube') {
    return `### Video ${source.id}: "${source.title}" by ${source.channel} (${source.url}), ${formatTime(from || 0)} to ${formatTime(to || source.durationSec)}\n${transcriptText(source.chunks, from || 0, to || Infinity).slice(0, budget)}`;
  }
  return `### Web page ${source.id}: "${source.title}" (${source.url})\n${sectionsText(source.sections, sections && sections.length ? sections : null, budget)}`;
}

async function writePages(lib, job, save, io, isStopping) {
  const course = readCourse(lib, job.courseId);
  const catalogue = readCatalogue(lib);
  const sources = new Map(course.sources.filter(source => source.usable).map(source => [source.id, readSource(lib, course.id, source.id)]));
  const learned = catalogue.concepts.filter(concept => stateOf(concept) === 'learned').map(concept => concept.name).slice(0, 200);
  const todo = course.pages.filter(page => page.status !== 'written');
  let done = course.pages.length - todo.length;
  save({ done, total: course.pages.length });
  const queue = [...todo];
  const worker = async () => {
    while (queue.length && !isStopping()) {
      const page = queue.shift();
      const main = sources.get(page.sourceId);
      const parts = [material(main, page.fromSec, page.toSec, page.sections, PAGE_BUDGET)];
      for (const item of page.support || []) {
        const other = sources.get(item.sourceId);
        if (other) parts.push(material(other, item.fromSec, item.toSec, item.sections, SUPPORT_BUDGET));
      }
      const concepts = page.concepts.map(id => catalogue.concepts.find(concept => concept.id === id)).filter(Boolean);
      // Order is the place in the list; `n` is only the page's id.
      const position = course.pages.findIndex(other => other.n === page.n);
      const ask = () => io.askStructured({
        prompt: pagePrompt({
          course,
          page,
          position: position + 1,
          total: course.pages.length,
          prevTitles: course.pages.slice(0, position).map(other => other.title),
          nextTitle: course.pages[position + 1]?.title || null,
          concepts,
          material: parts.join('\n\n'),
          learned,
        }),
        schema: PAGE_SCHEMA,
        tools: [],
        model: lib.settings.models.build,
        cwd: lib.root,
        onRateLimit: recordUsage,
      });
      let answer;
      try {
        answer = await ask();
      } catch (error) {
        if (isStopping()) throw error;
        answer = await ask(); // one more go before the build stops
      }
      const pageIds = new Set(page.concepts);
      const checks = (answer.checks || []).slice(0, 3).map(check => {
        const tests = (check.concepts || []).filter(id => pageIds.has(id));
        return { q: String(check.q), answer: String(check.answer), concepts: tests.length ? tests : page.concepts };
      });
      const videoSource = main.kind === 'youtube' ? main : (page.support || []).map(item => sources.get(item.sourceId)).find(other => other && other.kind === 'youtube');
      const videos = {};
      for (const other of [main, ...(page.support || []).map(item => sources.get(item.sourceId))]) if (other && other.kind === 'youtube') videos[other.id] = other.videoId;
      const sectionLinks = {};
      for (const web of [main, ...(page.support || []).map(item => sources.get(item.sourceId))].filter(other => other && other.kind === 'web')) {
        for (const section of web.sections) if (!sectionLinks[section.heading]) sectionLinks[section.heading] = section.anchor ? `${web.url.replace(/#.*$/, '')}#${section.anchor}` : web.url;
      }
      const markdown = String(answer.markdown || '');
      withLock(lib.root, () => writeJson(lib.paths.page(course.id, page.n), {
        v: 1,
        n: page.n,
        title: page.title,
        concepts: page.concepts,
        source: { id: main.id, kind: main.kind, url: main.url, title: main.title, videoId: videoSource?.videoId || null, fromSec: page.fromSec, toSec: page.toSec },
        support: (page.support || []).map(item => ({ ...item, url: sources.get(item.sourceId)?.url, title: sources.get(item.sourceId)?.title })),
        markdown,
        blocks: markdownToBlocks(markdown, { videoId: videoSource?.videoId || null, videos, sectionLinks }),
        checks,
        writtenAt: now(),
      }));
      updateCourse(lib, course.id, saved => {
        const entry = saved.pages.find(item => item.n === page.n);
        entry.status = 'written';
        entry.writtenAt = now();
        if (saved.pages.every(item => item.status === 'written')) saved.status = 'ready';
      });
      done++;
      save({ done, message: `Wrote page ${position + 1}/${course.pages.length}: ${page.title}` });
    }
  };
  await Promise.all(Array.from({ length: Math.min(PAGES_AT_ONCE, todo.length) }, worker));
  if (isStopping()) throw new Error('stopped');
}
