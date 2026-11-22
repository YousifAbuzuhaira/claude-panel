// The window's one way into the library: JSON lines on stdin, answers and events on
// stdout. A request is `{ rid, cmd, ...args }`; the answer `{ rid, ok, result | error }`.
// Events (`{ event, ... }`) carry chat text as it streams and the status as it changes.
// Output is ASCII (everything else \u-escaped), so nothing is lost crossing to Windows.
import { existsSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import {
  addConcept, compactCatalogue, conceptById, ensureCategory, findConcept, markSeen, mergeConcepts, moveConcept,
  removeCategory, removeConcept, renameCategory, renameConcept, setDefinition, setLearned, setParent, stateOf,
} from './catalogue.mjs';
import {
  DAILY_CAP, answerInReview, answerOnPage, dropCourse, dueToday, emptyReview, flagItem, isFlagged, itemKey, nextDue, parseKey, recallDays, swapConcept,
} from './review.mjs';
import { markTerms, pageGlossary } from './terms.mjs';
import { shuffled } from './teach.mjs';
import { askStructured, describeTool } from './claude.mjs';
import { chatKey, clearChat, listAdvisorChats, readChat, removeAdvisorChat, sendChat } from './chat.mjs';
import { cancelJob, createJob, createPageJob, createRefreshJob, dropJobFiles, explainJob, listJobs, pickSources, readJob, resumeJob, resumeStale, saveJob, startDaemon, startVideos, videoJob } from './build.mjs';
import { videoStamp } from './video-check.mjs';
import { clearQueue, courseVideos, queueVideos, swapVideo, videoInfo } from './video.mjs';
import { explainInfo, explainPaths, inDepth, listExplainers, readExplainer, updateExplainer } from './explain.mjs';
import { exportExplainer } from './export.mjs';
import { voiceStatus } from './voice.mjs';
import { ensureYtDlp, installedYtDlp } from './deps.mjs';
import {
  courseSummary, listCourses, movePage, openLibrary, pruneConcepts, readCatalogue, readCourse, readPage, readStatus, recordUsage,
  removeCourse, removePage, renamePage, rewriteConceptIds, updateCatalogue, updateCourse, writeStatus,
} from './library.mjs';
import { markdownToBlocks } from './markdown.mjs';
import { overlapReport } from './overlap.mjs';
import { MATCH_SCHEMA, TIDY_SCHEMA, matchPrompt, tidyPrompt } from './prompts.mjs';
import { STATUS_FILE, readSettings, writeSettings } from './settings.mjs';
import { readJson, safeId, withLock, writeJson } from './store.mjs';
import { listClaudeChats } from './chats.mjs';

export const encodeLine = value => JSON.stringify(value).replace(/[\u007f-￿]/g, ch => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`) + '\n';

const conceptView = (catalogue, concept, recall = {}) => ({
  id: concept.id,
  name: concept.name,
  definition: concept.definition,
  parent: concept.parent,
  category: concept.category,
  alsoUsedIn: concept.alsoUsedIn || [],
  aliases: concept.aliases || [],
  state: stateOf(concept),
  learned: concept.learned,
  passed: Boolean(concept.passed),
  recall: recall[concept.id] || 0,
  seen: concept.seen || [],
});

/** Claude's replies are Markdown: the window draws them as blocks, like a page. */
const withBlocks = message => (message.role === 'assistant' ? { ...message, blocks: markdownToBlocks(message.text) } : message);
const chatView = chat => ({ ...chat, messages: chat.messages.map(withBlocks) });

function nextUnread(course, after) {
  const skipped = new Set(course.skipped || []);
  const read = new Set(course.read || []);
  return course.pages.find(page => page.n > after && !skipped.has(page.n) && !read.has(page.n)) || course.pages.find(page => page.n > after) || null;
}

export function createServer({ write = text => process.stdout.write(text) } = {}) {
  const send = value => write(encodeLine(value));
  const chats = new Map();
  let lib = openLibrary();

  const readReview = () => readJson(lib.paths.review) || emptyReview();
  /** `fn` changes the review state in place; what it returns is passed back. */
  const updateReview = fn => withLock(lib.root, () => {
    const state = readReview();
    const result = fn(state);
    writeJson(lib.paths.review, state);
    return result;
  });
  const pageCheck = (courseId, n, id) => (readPage(lib, courseId, n)?.blocks || []).find(block => block.t === 'check' && block.id === id) || null;

  const target = request => (request.advisor ? { advisor: true, chatId: safeId(request.chatId) } : { courseId: String(request.courseId), n: Number(request.n) });

  const handlers = {
    // A snapshot's copy of a library (LEARN_LIBRARY) never restarts its builds.
    hello: () => ({ settings: lib.settings, status: readStatus(), ytDlp: installedYtDlp(), resumed: process.env.LEARN_LIBRARY ? [] : resumeStale(lib), reviewDue: dueToday(readReview()).due.length }),

    'settings.get': () => readSettings(),
    'settings.set': ({ change }) => {
      const settings = writeSettings(change || {});
      lib = openLibrary(settings);
      return settings;
    },

    'library.get': () => {
      const catalogue = readCatalogue(lib);
      const courses = listCourses(lib).map(course => courseSummary(course, catalogue))
        .sort((a, b) => String(b.lastOpened || b.createdAt).localeCompare(String(a.lastOpened || a.createdAt)));
      const day = Date.now() - 86_400_000;
      const all = listJobs(lib);
      const jobs = all.filter(job => !job.dismissed && (job.state !== 'done' || Date.parse(job.updatedAt) > day)).slice(0, 10);
      return { categories: catalogue.categories, courses, jobs, explainers: listExplainers(lib, all), status: readStatus(), reviewDue: dueToday(readReview()).due.length };
    },

    'category.add': ({ name }) => updateCatalogue(lib, catalogue => ensureCategory(catalogue, name)),
    'category.rename': ({ id, name }) => updateCatalogue(lib, catalogue => renameCategory(catalogue, id, name)),
    'category.remove': ({ id, moveTo }) => {
      for (const course of listCourses(lib).filter(item => item.category === id)) updateCourse(lib, course.id, saved => { saved.category = moveTo; });
      return updateCatalogue(lib, catalogue => removeCategory(catalogue, id, moveTo));
    },

    'course.get': ({ id }) => {
      const course = readCourse(lib, id);
      if (!course) throw new Error('no such course');
      const catalogue = readCatalogue(lib);
      const recall = recallDays(readReview());
      const concepts = {};
      for (const page of course.pages) for (const conceptId of page.concepts || []) {
        const concept = conceptById(catalogue, conceptId);
        if (concept) concepts[conceptId] = conceptView(catalogue, concept, recall);
      }
      return { course, concepts, categories: catalogue.categories };
    },
    'course.setCategory': ({ id, category }) => updateCourse(lib, id, course => { course.category = category; }),
    'course.update': ({ id, title, summary }) => updateCourse(lib, id, course => {
      if (typeof title === 'string' && title.trim()) course.title = title.trim().slice(0, 120);
      if (typeof summary === 'string') course.summary = summary.trim().slice(0, 600);
      return courseSummary(course, readCatalogue(lib));
    }),
    'course.remove': ({ id }) => {
      const removedConcepts = removeCourse(lib, id);
      updateReview(state => dropCourse(state, id));
      if (readStatus().course?.id === id) writeStatus({ course: null });
      return { removedConcepts };
    },
    // Concepts left behind by courses removed before removing took them along.
    'concept.prune': () => ({ removedConcepts: pruneConcepts(lib) }),

    'page.get': ({ courseId, n }) => {
      const course = readCourse(lib, courseId);
      const page = readPage(lib, courseId, n);
      if (!course) throw new Error('no such course');
      if (!page) return { course: { id: course.id, title: course.title }, page: null, written: false };
      const where = { course: courseId, page: Number(n), at: new Date().toISOString() };
      updateCatalogue(lib, catalogue => markSeen(catalogue, page.concepts, where));
      const saved = updateCourse(lib, courseId, item => {
        item.read = [...new Set([...(item.read || []), Number(n)])];
        const scroll = item.progress && item.progress.page === Number(n) ? item.progress.scroll : 0;
        item.progress = { page: Number(n), scroll, at: where.at };
        return item;
      });
      const next = nextUnread(saved, Number(n));
      const position = saved.pages.findIndex(item => item.n === Number(n)) + 1;
      writeStatus({ course: { id: course.id, title: course.title, page: position, total: course.pages.length, next: next ? next.title : '' } });
      const catalogue = readCatalogue(lib);
      const review = readReview();
      const recall = recallDays(review);
      const concepts = page.concepts.map(id => conceptById(catalogue, id)).filter(Boolean).map(concept => conceptView(catalogue, concept, recall));
      // Words are marked as the page is read, so they follow what you have learned since.
      const shown = page.blocks.filter(block => block.t !== 'check' || !isFlagged(review, itemKey(courseId, Number(n), block.id)));
      const { blocks, used } = markTerms(shown, pageGlossary(page, saved.terms, catalogue.concepts));
      const answers = {};
      for (const block of shown) {
        const item = block.t === 'check' ? review.items[itemKey(courseId, Number(n), block.id)] : null;
        if (item && item.choice !== null) answers[block.id] = item.choice;
      }
      return { page: { ...page, blocks }, video: videoInfo(lib, courseId, page, { job: videoJob(lib) }), glossary: used, answers, concepts, chat: chatView(readChat(lib, { courseId, n: Number(n) })), progress: saved.progress, total: course.pages.length, skipped: saved.skipped || [] };
    },

    // Videos. `n` given: that page goes next; left out: every page that needs one, in order.
    'video.page': ({ courseId, n }) => {
      const page = readPage(lib, courseId, Number(n));
      return page ? videoInfo(lib, courseId, page, { job: videoJob(lib) }) : null;
    },
    'video.course': ({ courseId }) => {
      const course = readCourse(lib, courseId);
      if (!course) throw new Error('no such course');
      return courseVideos(lib, course, { job: videoJob(lib) });
    },
    'video.queue': ({ courseId, n, again }) => {
      const course = readCourse(lib, courseId);
      if (!course) throw new Error('no such course');
      const voice = voiceStatus();
      const wanted = n === undefined ? courseVideos(lib, course).wanted : [Number(n)];
      if (voice.reason) throw new Error(voice.reason);
      if (!wanted.length) throw new Error('every page that can have a video has one');
      queueVideos(lib, courseId, wanted, { first: n !== undefined, again: Boolean(again) });
      startVideos(lib);
      return courseVideos(lib, course, { job: videoJob(lib) });
    },
    'video.swap': ({ courseId, n }) => {
      const page = readPage(lib, courseId, Number(n));
      if (!page) throw new Error('no such page');
      if (videoInfo(lib, courseId, page, { job: videoJob(lib) }).state === 'making') throw new Error('this video is being made: wait for that to finish');
      swapVideo(lib, courseId, Number(n));
      return videoInfo(lib, courseId, page, { job: videoJob(lib) });
    },
    'video.get': ({ courseId, n }) => {
      const course = readCourse(lib, courseId);
      const number = Number(n);
      const video = readJson(`${lib.paths.videoBase(courseId, number)}.json`);
      if (!course || !video) throw new Error('it has not been made');
      const page = readPage(lib, courseId, number);
      const review = readReview();
      return { ...video, stats: undefined, courseTitle: course.title, stale: !page || video.stamp !== videoStamp(page), quiz: video.quiz.filter(q => !isFlagged(review, itemKey(courseId, number, q.id))) };
    },
    // An explainer's clips (/explain): the playlist with each clip's state, a clip's script and
    // sound, and where you are in it, which says how far ahead clips are made.
    'explain.get': ({ id }) => {
      const explainer = readExplainer(lib, safeId(id));
      if (!explainer) throw new Error('no such explainer');
      const job = listJobs(lib).find(item => item.kind === 'explain' && item.explain === explainer.id && item.state === 'running');
      return { ...explainInfo(lib, explainer, job?.making ?? null), message: job?.message || null };
    },
    // Every explainer, newest first, as the Library lists them.
    'explain.list': () => listExplainers(lib, listJobs(lib)),
    // An explainer as one file you can pass on (~/explainers), written now with every clip made.
    'explain.export': ({ id }) => {
      const done = exportExplainer(lib, safeId(id));
      if (!done) throw new Error('no clip of it is made yet');
      return done;
    },
    'explain.video': ({ id, n }) => {
      const explainer = readExplainer(lib, safeId(id));
      const clip = Number(n);
      const video = explainer && Number.isInteger(clip) ? readJson(`${explainPaths(lib, explainer.id).clip(clip)}.json`) : null;
      if (!video) throw new Error('this clip has not been made yet');
      return { ...video, stats: undefined, courseTitle: explainer.title, stale: false };
    },
    'explain.audio': ({ id, n }) => {
      const explainer = readExplainer(lib, safeId(id));
      const path = explainer && Number.isInteger(Number(n)) ? `${explainPaths(lib, explainer.id).clip(Number(n))}.mp3` : null;
      if (!path || !existsSync(path)) throw new Error('this clip has not been made yet');
      return { path };
    },
    'explain.at': ({ id, n, depth }) => {
      const explainer = updateExplainer(lib, safeId(id), now => ({
        at: Number.isInteger(Number(n)) && Number(n) >= 1 && Number(n) <= now.clips.length ? Number(n) : now.at,
        depth: [1, 2, 3].includes(Number(depth)) ? Number(depth) : now.depth,
        seenAt: new Date().toISOString(),
      }));
      // A clip asked for that isn't made, with nothing making it (a job whose process died, or one
      // with no depth that stopped waiting for a pick): it starts again. The player also says it's
      // here every minute it's open.
      const clip = explainer.clips[explainer.at - 1];
      const wanted = explainer.at === 1 || (explainer.depth && clip && inDepth(clip, explainer.depth));
      if (wanted && !existsSync(`${explainPaths(lib, explainer.id).clip(explainer.at)}.json`)) explainJob(lib, explainer);
      return explainInfo(lib, explainer);
    },
    'video.audio': ({ courseId, n }) => {
      const path = `${lib.paths.videoBase(courseId, Number(n))}.mp3`;
      if (!existsSync(path)) throw new Error('it has not been made');
      return { path };
    },

    'check.answer': ({ courseId, n, id, choice }) => {
      const block = pageCheck(courseId, Number(n), id);
      if (!block) throw new Error('that question is gone');
      const right = block.options[Number(choice)]?.right === 1;
      updateReview(state => answerOnPage(state, itemKey(courseId, Number(n), id), { right, choice: Number(choice), concepts: block.concepts, guess: Boolean(block.guess) }));
      return { right };
    },
    'check.flag': ({ key }) => {
      const { courseId, n, id } = parseKey(key);
      const block = pageCheck(courseId, n, id);
      return updateReview(state => Boolean(flagItem(state, key, { concepts: block?.concepts, guess: Boolean(block?.guess) })));
    },

    'review.list': () => {
      const state = readReview();
      const { due, done } = dueToday(state, Date.now(), Infinity);
      const room = Math.max(0, DAILY_CAP - done);
      const items = [];
      const gone = [];
      for (const key of due) {
        if (items.length === room) break;
        const { courseId, n, id } = parseKey(key);
        const block = pageCheck(courseId, n, id);
        if (!block) {
          // Its page was rewritten or removed.
          gone.push(key);
          continue;
        }
        items.push({ key, courseId, n, courseTitle: readCourse(lib, courseId)?.title || '', pageTitle: readPage(lib, courseId, n)?.title || '', check: { ...block, options: shuffled(block.options.map((option, i) => ({ ...option, i }))) } });
      }
      if (gone.length) updateReview(latest => { for (const key of gone) delete latest.items[key]; });
      return { items, waiting: Math.max(0, due.length - gone.length - items.length), done, cap: DAILY_CAP, next: nextDue(state) };
    },
    'review.answer': ({ key, choice }) => {
      const { courseId, n, id } = parseKey(key);
      const block = pageCheck(courseId, n, id);
      if (!block) throw new Error('that question is gone');
      const right = block.options[Number(choice)]?.right === 1;
      updateReview(state => answerInReview(state, key, right));
      return { right };
    },
    'progress.set': ({ courseId, n, scroll }) => updateCourse(lib, courseId, course => {
      course.progress = { page: Number(n), scroll: Math.max(0, Math.min(1, Number(scroll) || 0)), at: new Date().toISOString() };
      return true;
    }),
    'page.rename': ({ courseId, n, title }) => renamePage(lib, courseId, Number(n), title).pages,
    'page.move': ({ courseId, n, delta }) => movePage(lib, courseId, Number(n), Number(delta)).pages,
    'page.remove': ({ courseId, n }) => {
      const course = removePage(lib, courseId, Number(n));
      if (readStatus().course?.id === courseId) writeStatus({ course: { ...readStatus().course, total: course.pages.length } });
      return course;
    },
    'course.refresh': ({ id }) => {
      const job = createRefreshJob(lib, id);
      startDaemon(lib, job.id);
      return job;
    },
    'page.rewrite': ({ courseId, n, note }) => {
      const job = createPageJob(lib, { courseId, kind: 'page-rewrite', n, note });
      startDaemon(lib, job.id);
      return job;
    },
    'page.add': ({ courseId, topic, after }) => {
      const job = createPageJob(lib, { courseId, kind: 'page-add', topic, after: after ?? null });
      startDaemon(lib, job.id);
      return job;
    },
    'page.skip': ({ courseId, n, skip }) => updateCourse(lib, courseId, course => {
      const set = new Set(course.skipped || []);
      if (skip) set.add(Number(n)); else set.delete(Number(n));
      course.skipped = [...set].sort((a, b) => a - b);
      return course.skipped;
    }),

    'concept.list': () => {
      const catalogue = readCatalogue(lib);
      const titles = Object.fromEntries(listCourses(lib).map(course => [course.id, course.title]));
      const recall = recallDays(readReview());
      return { categories: catalogue.categories, concepts: catalogue.concepts.map(concept => conceptView(catalogue, concept, recall)), courseTitles: titles };
    },
    'concept.learn': ({ id, learned, courseId, n }) => updateCatalogue(lib, catalogue => {
      // The lock: only passing a closing question opens it. Unmarking is always allowed.
      const concept = conceptById(catalogue, id);
      if (learned && concept && !concept.learned && !concept.passed) throw new Error(`Answer the closing question for ${concept.name} first. If you already know it, add it in the Learned tab.`);
      return conceptView(catalogue, setLearned(catalogue, id, Boolean(learned), courseId ? { course: courseId, page: Number(n) || null } : null));
    }),
    'concept.add': async ({ text, category }) => {
      const name = String(text || '').trim();
      if (!name) throw new Error('type a concept');
      let catalogue = readCatalogue(lib);
      let found = findConcept(catalogue, name);
      let proposal = null;
      if (!found) {
        proposal = await askStructured({ prompt: matchPrompt(name, compactCatalogue(catalogue)), schema: MATCH_SCHEMA, model: lib.settings.models.chat, cwd: lib.root, onRateLimit: recordUsage });
      }
      return updateCatalogue(lib, latest => {
        let concept = found ? conceptById(latest, found.id) : proposal?.id ? conceptById(latest, proposal.id) : null;
        if (!concept) {
          const home = category ? latest.categories.find(item => item.id === category) || ensureCategory(latest, category) : ensureCategory(latest, 'General');
          concept = addConcept(latest, { name: proposal?.name || name, definition: proposal?.definition || '', parent: proposal?.parent || null, aliases: proposal && proposal.name !== name ? [name] : [], category: home.id, by: 'user' });
        }
        setLearned(latest, concept.id, true, null);
        return conceptView(latest, concept);
      });
    },
    'concept.remove': ({ id }) => updateCatalogue(lib, catalogue => removeConcept(catalogue, id)),
    'concept.rename': ({ id, name }) => updateCatalogue(lib, catalogue => conceptView(catalogue, renameConcept(catalogue, id, name))),
    'concept.move': ({ id, category }) => updateCatalogue(lib, catalogue => conceptView(catalogue, moveConcept(catalogue, id, category))),
    'concept.update': request => updateCatalogue(lib, catalogue => {
      let concept = conceptById(catalogue, request.id);
      if (!concept) throw new Error('no such concept');
      if (typeof request.name === 'string' && request.name.trim() && request.name.trim() !== concept.name) concept = renameConcept(catalogue, request.id, request.name);
      if (typeof request.definition === 'string') concept = setDefinition(catalogue, request.id, request.definition);
      if ('parent' in request) concept = setParent(catalogue, request.id, request.parent || null);
      return conceptView(catalogue, concept);
    }),
    'concept.merge': ({ keep, drop }) => {
      const kept = updateCatalogue(lib, catalogue => conceptView(catalogue, mergeConcepts(catalogue, keep, drop)));
      rewriteConceptIds(lib, drop, keep);
      updateReview(state => swapConcept(state, drop, keep));
      return kept;
    },
    'concept.tidy': async () => {
      const catalogue = readCatalogue(lib);
      if (catalogue.concepts.length < 2) return [];
      const answer = await askStructured({ prompt: tidyPrompt(compactCatalogue(catalogue)), schema: TIDY_SCHEMA, model: lib.settings.models.build, cwd: lib.root, onRateLimit: recordUsage });
      return (answer.merges || [])
        .filter(merge => merge.keep !== merge.drop && conceptById(catalogue, merge.keep) && conceptById(catalogue, merge.drop))
        .map(merge => ({ ...merge, keepName: conceptById(catalogue, merge.keep).name, dropName: conceptById(catalogue, merge.drop).name }));
    },

    'chat.get': request => chatView(readChat(lib, target(request))),
    'chat.clear': request => {
      clearChat(lib, target(request));
      return true;
    },
    'chat.send': request => {
      const where = target(request);
      const key = chatKey(where);
      if (chats.has(key)) throw new Error('still answering the last message');
      const handle = sendChat(lib, where, request.text, {
        onDelta: text => send({ event: 'chat.delta', key, text }),
        onTool: tool => send({ event: 'chat.tool', key, text: describeTool(tool) }),
        onRateLimit: recordUsage,
      });
      chats.set(key, handle);
      handle.done
        .then(message => send({ event: 'chat.done', key, message: withBlocks(message) }))
        .catch(error => send({ event: 'chat.error', key, error: error.stopped ? 'Stopped' : String(error.message || error) }))
        .finally(() => chats.delete(key));
      return { key };
    },
    'chat.stop': ({ key }) => {
      chats.get(key)?.stop();
      return true;
    },
    'advisor.list': () => listAdvisorChats(lib),
    'advisor.remove': ({ chatId }) => {
      chats.get(chatKey({ advisor: true, chatId }))?.stop();
      return removeAdvisorChat(lib, chatId);
    },

    'build.start': ({ topic, category, mode, link, file, name, chat, focus, audience }) => {
      const job = createJob(lib, { topic, category, mode, link, file, name, chat, focus, audience });
      startDaemon(lib, job.id);
      return job;
    },
    'build.pick': ({ jobId, picks }) => pickSources(lib, jobId, picks || []),
    'build.resume': ({ jobId }) => resumeJob(lib, jobId),
    'build.cancel': ({ jobId }) => cancelJob(lib, jobId),
    'build.dismiss': ({ jobId }) => {
      const job = readJob(lib, jobId);
      if (job) {
        saveJob(lib, { ...job, dismissed: true });
        if (job.state !== 'running') dropJobFiles(lib, job);
        if (job.kind === 'video') clearQueue(lib);
      }
      if (readStatus().build?.id === jobId) writeStatus({ build: null });
      return true;
    },
    'jobs.list': () => listJobs(lib).slice(0, 20),
    // The learner's Claude Code chats, to build a course from one (Learn's own runs left out).
    'claudeChats.list': () => listClaudeChats({ exclude: [lib.root] }),

    'deps.check': () => installedYtDlp(),
    'deps.install': async () => {
      await ensureYtDlp({ force: true });
      return installedYtDlp();
    },

    'overlap.get': ({ courseId }) => {
      const course = readCourse(lib, courseId);
      if (!course) throw new Error('no such course');
      const catalogue = readCatalogue(lib);
      const titles = Object.fromEntries(listCourses(lib).map(item => [item.id, item.title]));
      return { ...overlapReport(catalogue, course.pages, courseId), seen: Boolean(course.overlap?.seen), skipped: course.skipped || [], courseTitles: titles };
    },
    'overlap.apply': ({ courseId, skip }) => updateCourse(lib, courseId, course => {
      course.skipped = [...new Set([...(course.skipped || []), ...(skip || []).map(Number)])].sort((a, b) => a - b);
      course.overlap = { ...(course.overlap || {}), seen: true };
      return course.skipped;
    }),
  };

  async function handle(line) {
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      send({ event: 'error', error: 'a request that was not JSON' });
      return;
    }
    const handler = handlers[request.cmd];
    if (!handler) {
      send({ rid: request.rid, ok: false, error: `unknown command ${request.cmd}` });
      return;
    }
    try {
      const result = await handler(request);
      send({ rid: request.rid, ok: true, result: result ?? null });
    } catch (error) {
      send({ rid: request.rid, ok: false, error: String(error.message || error) });
    }
  }

  return { handle, send, handlers, stopChats: () => { for (const chat of chats.values()) chat.stop(); } };
}

/** Runs until stdin closes (the window went). Status changes go out as events. */
export function serve() {
  const server = createServer();
  let stamp = '';
  const watch = setInterval(() => {
    try {
      const info = statSync(STATUS_FILE);
      const next = `${info.mtimeMs}/${info.size}`;
      if (next !== stamp) {
        stamp = next;
        server.send({ event: 'status', status: readStatus() });
      }
    } catch {
      // no status yet
    }
  }, 1000);
  const input = createInterface({ input: process.stdin });
  input.on('line', line => { if (line.trim()) void server.handle(line); });
  input.on('close', () => {
    clearInterval(watch);
    server.stopChats();
    setTimeout(() => process.exit(0), 200);
  });
  server.send({ event: 'ready' });
}
