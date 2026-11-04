// Building a course, as steps saved in jobs/<id>.json: research, picks, fetch, outline,
// pages, done. A page job (rewrite one page, or add one) is the same machine with fewer
// steps: plan-page (for an added page), then pages. Each step is safe to run again, so a build stopped by a closed window, a
// sleep or a reboot carries on from where it got to. Builds run as their own detached
// process (`learn.mjs build run <id>`), so closing the window doesn't stop them.
import { spawn } from 'node:child_process';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { applyProposals, compactCatalogue, ensureCategory, findCategory, stateOf } from './catalogue.mjs';
import { askStructured, describeTool, stopAll } from './claude.mjs';
import { activeJobFor, buildStatus, newCourseId, readCatalogue, readCourse, readStatus, recordUsage, updateCatalogue, updateCourse, writeStatus } from './library.mjs';
import { inlineText, markdownToBlocks } from './markdown.mjs';
import { askNumbers, cleanAsks, picksCovering, uncovered } from './coverage.mjs';
import { overlapReport } from './overlap.mjs';
import {
  BRIEF_SCHEMA, OUTLINE_SCHEMA, PAGE_PLAN_SCHEMA, PAGE_SCHEMA, READER_SCHEMA, RESEARCH_SCHEMA, TEACH_SCHEMA,
  chatBriefPrompt, outlinePrompt, pagePlanPrompt, pagePrompt, readerPrompt, researchPrompt, teachPrompt,
} from './prompts.mjs';
import { MAX_QUICK, applyReader, checkBlock, closingFor, mergeAids, mergeTerms, placeChecks, tidyAids } from './teach.mjs';
import { SESSION_ID, readClaudeChat } from './chats.mjs';
import {
  condenseTranscript, fetchPage, formatTime, isExtractorError, isPlaylist, isYouTube, sectionsOutline, sectionsText,
  transcriptText, watchUrl, youTubeId, ytCaptions, ytInfo, ytPlaylist, ytSearch,
} from './sources.mjs';
import { ensureYtDlp } from './deps.mjs';
import { MAX_DOCUMENT_BYTES, documentType, readDocument, uniqueHeadings } from './documents.mjs';
import { CONFIG_DIR, toWslPath } from './settings.mjs';
import { readJson, withLock, writeJson } from './store.mjs';

const LEARN_MJS = fileURLToPath(new URL('./learn.mjs', import.meta.url));
const PAGES_AT_ONCE = 3;
const MAX_PAGES = 40;
const MAX_TOPIC = 3000; // room for Build all as one course: it joins several whole topics
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

/**
 * An older course made the new way: the same sources planned and written again, as a new course.
 * The old one stays until you remove it, so a build that stops half way costs you nothing.
 */
export function createRefreshJob(lib, courseId) {
  const course = readCourse(lib, courseId);
  if (!course) throw new Error('no such course');
  if (activeJobFor(lib, courseId)) throw new Error('this course is being written: wait for that to finish');
  const usable = course.sources.filter(source => source.usable);
  if (!usable.length) throw new Error('this course has no readable sources to plan from');
  const id = newCourseId(course.title);
  const stamp = now().replace(/[-:T]/g, '').slice(0, 12);
  const jobId = `j${stamp}${randomBytes(2).toString('hex')}`;
  const from = join(dirname(lib.paths.course(courseId)), 'sources');
  const to = join(dirname(lib.paths.course(id)), 'sources');
  cpSync(from, to, { recursive: true });
  // A document's stored copy moved with it.
  for (const source of usable) {
    const data = readJson(lib.paths.source(id, source.id));
    if (data?.file && data.file.startsWith(`${from}/`)) writeJson(lib.paths.source(id, source.id), { ...data, file: data.file.replace(from, to) });
  }
  const category = readCatalogue(lib).categories.find(item => item.id === course.category)?.name || 'General';
  withLock(lib.root, () => writeJson(lib.paths.course(id), {
    ...course, id, status: 'building', createdAt: now(), jobId, pages: [], read: [], skipped: [], progress: null, overlap: null, terms: [], notCovered: [], updatedFrom: courseId,
  }));
  return saveJob(lib, {
    v: 1, id: jobId, kind: 'course-refresh', topic: course.topic || course.title, link: null, category, mode: 'page', courseId: id, courseTitle: course.title, summary: null,
    asks: course.asks || [], step: 'outline', state: 'running', message: `Planning ${course.title} again`, done: 0, total: 0, candidates: null, picks: null, pid: null, error: null, startedAt: now(),
  });
}

/** A document given to a build: its path here (a Windows path is turned into WSL's), and its name. */
function checkDocument(file, name) {
  const path = resolve(toWslPath(String(file).trim()));
  const fileName = String(name || basename(path)).trim().slice(0, 200);
  if (!documentType(fileName)) throw new Error(`Learn reads PDF, Word (.docx), Markdown, text and HTML files, not ${extname(fileName) || 'this file'}`);
  let size;
  try {
    size = statSync(path).size;
  } catch {
    throw new Error(`can't open ${fileName}`);
  }
  if (!size) throw new Error(`${fileName} is empty`);
  if (size > MAX_DOCUMENT_BYTES) throw new Error(`${fileName} is ${Math.round(size / 1048576)} MB; Learn reads documents up to ${MAX_DOCUMENT_BYTES / 1048576} MB`);
  return { path, fileName };
}

export function createJob(lib, { topic, category, mode = 'auto', link = null, file = null, name = null, chat = null, focus = null }) {
  const cleanTopic = String(topic || '').trim().slice(0, MAX_TOPIC);
  const cleanLink = link ? String(link).trim() : null;
  const document = file ? checkDocument(file, name) : null;
  const chatId = chat ? String(chat).trim() : null;
  const cleanFocus = String(focus || topic || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  if (chatId && !SESSION_ID.test(chatId)) throw new Error('that is not a chat id');
  if (chatId && !cleanFocus) throw new Error('say what the course should cover');
  if (!cleanTopic && !cleanLink && !document && !chatId) throw new Error('type a topic or paste a link');
  if (cleanLink && !/^https?:\/\//.test(cleanLink)) throw new Error('the link must start with http:// or https://');
  const stamp = now().replace(/[-:T]/g, '').slice(0, 12);
  const job = {
    v: 1,
    id: `j${stamp}${randomBytes(2).toString('hex')}`,
    topic: chatId ? cleanFocus : cleanTopic || cleanLink || (document ? basename(document.fileName, extname(document.fileName)) : ''),
    link: cleanLink,
    file: null,
    fileName: document ? document.fileName : null,
    chat: chatId,
    focus: chatId ? cleanFocus : null,
    category: String(category || '').trim().slice(0, 60) || 'General',
    mode: chatId ? 'chat' : document ? 'document' : cleanLink ? 'link' : mode === 'pick' ? 'pick' : 'auto',
    courseId: null,
    courseTitle: null,
    summary: null,
    step: 'research',
    state: 'running',
    message: chatId ? 'Reading your chat' : document ? `Reading ${document.fileName}` : cleanLink ? 'Reading the link' : `Researching ${cleanTopic}`,
    done: 0,
    total: 0,
    candidates: null,
    picks: null,
    pid: null,
    error: null,
    startedAt: now(),
  };
  if (document) {
    // The build keeps its own copy, so the course still works when the original moves. An
    // upload from the web page (in our config folder) is moved rather than copied.
    const stored = lib.paths.jobDocument(job.id, extname(document.fileName));
    mkdirSync(lib.paths.jobs, { recursive: true });
    const upload = document.path.startsWith(`${resolve(CONFIG_DIR, 'uploads')}/`);
    if (upload) {
      try {
        renameSync(document.path, stored);
      } catch {
        copyFileSync(document.path, stored);
        rmSync(document.path, { force: true });
      }
    } else {
      copyFileSync(document.path, stored);
    }
    job.file = stored;
  }
  return saveJob(lib, job);
}

/** A job's leftovers once nothing needs them: its copy of a document, what was read from it. */
export function dropJobFiles(lib, job) {
  if (job.file && job.file.startsWith(`${lib.paths.jobs}/`)) rmSync(job.file, { force: true });
  if (job.id) {
    rmSync(lib.paths.jobSections(job.id), { force: true });
    rmSync(lib.paths.jobChat(job.id), { recursive: true, force: true });
  }
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
export const defaultIo = { askStructured, ytSearch, ytInfo, ytCaptions, ytPlaylist, fetchPage, ensureYtDlp, readDocument, readClaudeChat };

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
export function tidyCandidates(candidates, askCount = 0) {
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
      covers: askNumbers(candidate.covers, askCount),
      recommended: Boolean(candidate.recommended),
    });
  }
  return out;
}

/**
 * A course from one of the learner's chats: the chat shrunk to a text file (secrets masked),
 * then one Claude run with Read and Grep only (and the project, read only) writes a brief of
 * the part the course is about. The brief is the course's one source, like a document.
 */
async function researchChat(lib, job, save, io) {
  save({ message: 'Reading your chat' });
  const chat = await io.readClaudeChat(job.chat);
  if (!chat.turns) throw new Error('that chat has nothing said in it');
  const work = lib.paths.jobChat(job.id);
  mkdirSync(work, { recursive: true, mode: 0o700 });
  writeFileSync(`${work}/chat.txt`, chat.text, { mode: 0o600 });
  const categories = readCatalogue(lib).categories.map(category => category.name);
  save({ message: `Finding "${job.focus}" in ${chat.title}` });
  let brief;
  try {
    brief = await io.askStructured({
      prompt: chatBriefPrompt({ focus: job.focus, title: chat.title, project: chat.cwd ? basename(chat.cwd) : '', cwd: chat.cwd && existsSync(chat.cwd) ? chat.cwd : null, categories }),
      schema: BRIEF_SCHEMA,
      tools: ['Read', 'Grep', 'Glob'],
      addDirs: chat.cwd && existsSync(chat.cwd) ? [chat.cwd] : [],
      model: lib.settings.models.build,
      cwd: work,
      onRateLimit: recordUsage,
      onTool: tool => save({ message: describeTool(tool) }),
    });
  } finally {
    // The chat's text is only for that run.
    rmSync(work, { recursive: true, force: true });
  }
  const sections = uniqueHeadings((brief.sections || []).filter(section => section && section.heading && String(section.text || '').trim()).map(section => ({ heading: String(section.heading).slice(0, 140), level: 1, text: String(section.text).slice(0, 40_000) })));
  if (brief.found === false || sections.length < 2) throw new Error(`the chat has nothing about "${job.focus}"${brief.summary ? `: ${String(brief.summary).slice(0, 200)}` : ''}`);
  const title = String(brief.courseTitle || job.focus).slice(0, 200);
  withLock(lib.root, () => writeJson(lib.paths.jobSections(job.id), { type: 'chat', title, chatTitle: chat.title, project: chat.cwd ? basename(chat.cwd) : '', sections }));
  const candidate = { id: 's1', kind: 'chat', url: null, title, channel: chat.title, lengthMin: null, level: null, why: 'Your chat', recommended: true };
  const category = job.category === 'General' && brief.category ? String(brief.category).trim().slice(0, 60) || job.category : job.category;
  save({ candidates: [candidate], picks: ['s1'], courseTitle: title, summary: String(brief.summary || '').slice(0, 400), category, step: 'fetch' });
}

async function research(lib, job, save, io) {
  if (job.chat) {
    await researchChat(lib, job, save, io);
    return;
  }
  if (job.file) {
    // A document is its own one source: read it now, so the course starts with its real title.
    const read = await io.readDocument(job.file, {
      name: job.fileName,
      model: lib.settings.models.build,
      onProgress: message => save({ message }),
      onRateLimit: recordUsage,
    });
    withLock(lib.root, () => writeJson(lib.paths.jobSections(job.id), read));
    const detail = [read.type, read.pages ? `${read.pages} pages` : null, read.byClaude ? `${read.byClaude} read by Claude` : null].filter(Boolean).join(', ');
    const candidate = { id: 's1', kind: 'doc', url: null, title: read.title.slice(0, 200), channel: detail, lengthMin: null, level: null, why: 'The document you gave', recommended: true };
    const topic = job.topic && job.topic !== basename(job.fileName, extname(job.fileName)) ? job.topic : read.title;
    save({ candidates: [candidate], picks: ['s1'], courseTitle: read.title.slice(0, 200), topic: topic.slice(0, 200), step: 'fetch' });
    return;
  }
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
  const known = knownConcepts(lib, job.category);
  const search = (asks, missing) => io.askStructured({
    prompt: researchPrompt({ topic: job.topic, category: job.category, known, videos: unique, asks, missing }),
    schema: RESEARCH_SCHEMA,
    tools: ['WebSearch', 'WebFetch'],
    model: lib.settings.models.build,
    cwd: lib.root,
    onRateLimit: recordUsage,
    onTool: tool => save({ message: describeTool(tool) }),
  });
  const answer = await search([], []);
  const asks = cleanAsks(answer.asks);
  let candidates = tidyCandidates(answer.candidates || [], asks.length);
  // Something they named has no source: one more search, for that alone.
  const gaps = uncovered(asks, candidates);
  if (gaps.length) {
    save({ message: `Looking for more on ${gaps.join(', ')}` });
    const more = await search(asks, gaps);
    candidates = tidyCandidates([...candidates, ...(more.candidates || [])], asks.length);
  }
  if (!candidates.length) throw new Error('research found no usable sources');
  let picks = candidates.filter(candidate => candidate.recommended).map(candidate => candidate.id);
  if (!picks.length) picks = candidates.slice(0, 3).map(candidate => candidate.id);
  picks = picksCovering(candidates, asks, picks);
  const found = { asks, candidates, courseTitle: answer.courseTitle, summary: answer.summary };
  if (job.mode === 'pick') {
    // What Claude recommends starts ticked, with what covers every ask.
    save({ ...found, candidates: candidates.map(candidate => ({ ...candidate, recommended: picks.includes(candidate.id) })), step: 'picks', state: 'waiting-picks', message: `Pick the sources for ${job.topic}` });
  } else {
    save({ ...found, picks, step: 'fetch' });
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
      record = source.kind === 'youtube' ? await fetchVideo(lib, courseId, source, io)
        : source.kind === 'doc' ? await fetchDocument(lib, job, courseId, source, io)
          : source.kind === 'chat' ? fetchChatBrief(lib, job, source)
            : await fetchWeb(source, io);
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

/** The document the job read: moved into the course, with the sections read from it. */
async function fetchDocument(lib, job, courseId, source, io) {
  const read = readJson(lib.paths.jobSections(job.id)) || (await io.readDocument(job.file, { name: job.fileName, model: lib.settings.models.build, onRateLimit: recordUsage }));
  const kept = lib.paths.courseDocument(courseId, source.id, extname(job.fileName));
  mkdirSync(resolve(kept, '..'), { recursive: true });
  if (existsSync(job.file)) {
    try {
      renameSync(job.file, kept);
    } catch {
      copyFileSync(job.file, kept);
    }
  }
  dropJobFiles(lib, job);
  return {
    usable: true,
    meta: { title: read.title },
    data: { v: 1, id: source.id, kind: 'doc', url: null, title: read.title, docType: read.type, pages: read.pages || null, file: existsSync(kept) ? kept : null, fileName: job.fileName, sections: read.sections },
  };
}

/** The brief written from the chat, as the course's source. */
function fetchChatBrief(lib, job, source) {
  const brief = readJson(lib.paths.jobSections(job.id));
  if (!brief) throw new Error('the brief from the chat is missing: start the build again');
  dropJobFiles(lib, job);
  return {
    usable: true,
    meta: { title: brief.title },
    data: { v: 1, id: source.id, kind: 'chat', url: null, title: brief.title, chatId: job.chat, chatTitle: brief.chatTitle, project: brief.project, sections: brief.sections },
  };
}

const readSource = (lib, courseId, id) => readJson(lib.paths.source(courseId, id));

async function outline(lib, job, save, io) {
  const course = readCourse(lib, job.courseId);
  const sources = sourceExcerpts(lib, course);
  const catalogue = readCatalogue(lib);
  const asks = job.asks || [];
  save({ message: `Planning ${course.title}` });
  const askForPlan = missing => io.askStructured({
    prompt: outlinePrompt({ topic: job.topic, title: course.title, category: job.category, sources, catalogue: compactCatalogue(catalogue), asks, missing }),
    schema: OUTLINE_SCHEMA,
    tools: [],
    model: lib.settings.models.build,
    cwd: lib.root,
    onRateLimit: recordUsage,
  });
  let plan = await askForPlan([]);
  let pages = cleanOutline(plan.pages || [], sources, asks.length);
  if (!pages.length) throw new Error('the plan had no pages');
  // Something they named has no page: one more plan. What still has none shows on the course.
  let notCovered = uncovered(asks, pages);
  if (notCovered.length) {
    save({ message: `Planning pages for ${notCovered.join(', ')}` });
    const again = await askForPlan(notCovered);
    const morePages = cleanOutline(again.pages || [], sources, asks.length);
    const left = uncovered(asks, morePages);
    if (morePages.length && left.length < notCovered.length) {
      plan = again;
      pages = morePages;
      notCovered = left;
    }
  }
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
    saved.asks = asks;
    saved.notCovered = notCovered;
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
    // It joins the part of the page before it.
    const part = item.pages[(at > 0 ? at : item.pages.length) - 1]?.part || '';
    item.pages.splice(at > 0 ? at : item.pages.length, 0, { ...rest, part, n, concepts: [...new Set(ids)], status: 'todo', added: true });
    item.status = 'building';
    return item;
  });
  save({ step: 'pages', addedTitle: page.title, total: saved.pages.length, done: saved.pages.filter(other => other.status === 'written').length, message: `Writing ${page.title}` });
}

/** The plan's pages made safe: real sources, times inside the video, headings that exist. */
export function cleanOutline(pages, sources, askCount = 0) {
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
    if (source.kind === 'youtube') return [];
    const known = headings(source);
    return (names || []).map(name => known.get(String(name).toLowerCase().trim())).filter(Boolean);
  };
  return pages.filter(page => page && page.title).slice(0, MAX_PAGES).map(page => {
    const source = byId.get(page.sourceId) || first;
    const support = (page.support || [])
      .map(item => ({ item, source: byId.get(item.sourceId) }))
      .filter(({ source: other }) => other && other.id !== source.id)
      .map(({ item, source: other }) => ({ sourceId: other.id, ...window(other, item.fromSec, item.toSec), sections: pickSections(other, item.sections) }));
    return {
      title: String(page.title).slice(0, 120),
      part: String(page.part || '').trim().slice(0, 80),
      covers: askNumbers(page.covers, askCount),
      outcomes: (page.outcomes || []).map(item => String(item).trim().slice(0, 200)).filter(Boolean).slice(0, 3),
      subtopics: (page.subtopics || []).map(String).slice(0, 12),
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
  const name = source.kind === 'doc' ? `Document ${source.id}: "${source.title}" (${source.docType || 'document'})` : source.kind === 'chat' ? `Chat brief ${source.id}: "${source.title}"` : `Web page ${source.id}: "${source.title}" (${source.url})`;
  return `### ${name}\n${sectionsText(source.sections, sections && sections.length ? sections : null, budget)}`;
}

/**
 * One page: Claude writes it, then a second call reads the finished page and writes its terms
 * and questions, then a third sees only the page and answers them blind. What fails gets one
 * repair; what still fails is dropped. A concept left with no closing question gets a plain one.
 */
async function makePage({ lib, io, page, concepts, isStopping, onStep, writeRequest }) {
  const conceptIds = concepts.map(concept => concept.id);
  const ask = async (prompt, schema) => {
    const call = () => io.askStructured({ prompt, schema, tools: [], model: lib.settings.models.build, cwd: lib.root, onRateLimit: recordUsage });
    try {
      return await call();
    } catch (error) {
      if (isStopping()) throw error;
      return call(); // one more go before the build stops
    }
  };
  const teachAndRead = async (markdown, repair) => {
    onStep(repair ? `fixing what didn't pass in ${page.title}` : `writing the questions for ${page.title}`);
    const raw = await ask(teachPrompt({ page, concepts, markdown, repair }), TEACH_SCHEMA);
    const blocks = markdownToBlocks(markdown);
    const headings = blocks.filter(block => block.t === 'h').map(block => inlineText(block.inlines));
    const aids = tidyAids(raw, { markdown, conceptIds, headings });
    onStep(`testing the questions for ${page.title}`);
    const reading = await ask(readerPrompt({ page, markdown, terms: [...(repair?.terms || []), ...aids.terms], quick: aids.quick, closing: aids.closing }), READER_SCHEMA);
    return applyReader(aids, reading, conceptIds);
  };
  onStep(`writing ${page.title}`);
  let markdown = String((await ask(writeRequest([]), PAGE_SCHEMA)).markdown || '');
  let aids = await teachAndRead(markdown, null);
  const stats = { asked: aids.quick.length + aids.closing.length + aids.failed.length, failed: aids.failed.length, unknown: aids.unknown.length, missing: aids.missing.length, rewritten: false, repaired: false };
  if (aids.missing.length) {
    // The page left out something it had to cover: it's written again, and so is the rest.
    stats.rewritten = true;
    onStep(`adding what ${page.title} left out`);
    const rewrite = await ask(writeRequest(aids.missing), PAGE_SCHEMA);
    markdown = String(rewrite.markdown || markdown);
    aids = await teachAndRead(markdown, null);
  } else if (aids.failed.length || aids.unknown.length || aids.untested.length) {
    stats.repaired = true;
    aids = mergeAids(aids, await teachAndRead(markdown, aids));
  }
  const tested = new Set(aids.closing.flatMap(check => check.concepts));
  const closing = [...aids.closing, ...concepts.filter(concept => !tested.has(concept.id)).map(closingFor)];
  stats.quick = Math.min(aids.quick.length, MAX_QUICK);
  stats.closing = closing.length;
  stats.terms = aids.terms.length;
  stats.leftUnknown = aids.unknown;
  return { markdown, aids: { terms: aids.terms, quick: aids.quick.slice(0, MAX_QUICK), closing }, stats };
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
      const made = await makePage({
        lib,
        io,
        page,
        concepts,
        isStopping,
        onStep: text => save({ message: `Page ${position + 1}/${course.pages.length}: ${text}` }),
        writeRequest: missing => pagePrompt({
          course,
          page,
          position: position + 1,
          total: course.pages.length,
          prevTitles: course.pages.slice(0, position).map(other => other.title),
          nextTitle: course.pages[position + 1]?.title || null,
          concepts,
          material: parts.join('\n\n'),
          learned,
          missing,
        }),
      });
      const videoSource = main.kind === 'youtube' ? main : (page.support || []).map(item => sources.get(item.sourceId)).find(other => other && other.kind === 'youtube');
      const videos = {};
      for (const other of [main, ...(page.support || []).map(item => sources.get(item.sourceId))]) if (other && other.kind === 'youtube') videos[other.id] = other.videoId;
      const sectionLinks = {};
      for (const web of [main, ...(page.support || []).map(item => sources.get(item.sourceId))].filter(other => other && other.kind === 'web')) {
        for (const section of web.sections) if (!sectionLinks[section.heading]) sectionLinks[section.heading] = section.anchor ? `${web.url.replace(/#.*$/, '')}#${section.anchor}` : web.url;
      }
      const { markdown, aids, stats } = made;
      const ctx = { videoId: videoSource?.videoId || null, videos, sectionLinks };
      const blocks = placeChecks(markdownToBlocks(markdown, ctx), aids.quick.map(check => ({ block: checkBlock(check, ctx), section: check.section })));
      withLock(lib.root, () => writeJson(lib.paths.page(course.id, page.n), {
        v: 1,
        n: page.n,
        title: page.title,
        concepts: page.concepts,
        source: { id: main.id, kind: main.kind, url: main.url, title: main.title, videoId: videoSource?.videoId || null, fromSec: page.fromSec, toSec: page.toSec, ...(main.kind === 'doc' ? { file: main.file || null, fileName: main.fileName || null, docType: main.docType || null } : {}) },
        support: (page.support || []).map(item => ({ ...item, url: sources.get(item.sourceId)?.url, title: sources.get(item.sourceId)?.title })),
        markdown,
        blocks,
        outcomes: page.outcomes || [],
        terms: aids.terms,
        checks: aids.closing,
        stats,
        writtenAt: now(),
      }));
      updateCourse(lib, course.id, saved => {
        const entry = saved.pages.find(item => item.n === page.n);
        entry.status = 'written';
        entry.writtenAt = now();
        saved.terms = mergeTerms(saved.terms, aids.terms, page.n);
        if (saved.pages.every(item => item.status === 'written')) saved.status = 'ready';
      });
      done++;
      save({ done, message: `Wrote page ${position + 1}/${course.pages.length}: ${page.title}` });
    }
  };
  await Promise.all(Array.from({ length: Math.min(PAGES_AT_ONCE, todo.length) }, worker));
  if (isStopping()) throw new Error('stopped');
}
