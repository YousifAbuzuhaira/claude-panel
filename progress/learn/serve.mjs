// The window's one way into the library: JSON lines on stdin, answers and events on
// stdout. A request is `{ rid, cmd, ...args }`; the answer `{ rid, ok, result | error }`.
// Events (`{ event, ... }`) carry chat text as it streams and the status as it changes.
// Output is ASCII (everything else \u-escaped), so nothing is lost crossing to Windows.
import { statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import {
  addConcept, compactCatalogue, conceptById, ensureCategory, findConcept, markSeen, mergeConcepts, moveConcept,
  removeCategory, removeConcept, renameCategory, renameConcept, setDefinition, setLearned, setParent, stateOf,
} from './catalogue.mjs';
import { askStructured, describeTool } from './claude.mjs';
import { chatKey, clearChat, readChat, sendChat } from './chat.mjs';
import { cancelJob, createJob, createPageJob, listJobs, pickSources, readJob, resumeJob, resumeStale, saveJob, startDaemon } from './build.mjs';
import { ensureYtDlp, installedYtDlp } from './deps.mjs';
import {
  courseSummary, listCourses, movePage, openLibrary, readCatalogue, readCourse, readPage, readStatus, recordUsage,
  removeCourse, removePage, renamePage, rewriteConceptIds, updateCatalogue, updateCourse, writeStatus,
} from './library.mjs';
import { markdownToBlocks } from './markdown.mjs';
import { overlapReport } from './overlap.mjs';
import { MATCH_SCHEMA, TIDY_SCHEMA, matchPrompt, tidyPrompt } from './prompts.mjs';
import { STATUS_FILE, readSettings, writeSettings } from './settings.mjs';

export const encodeLine = value => JSON.stringify(value).replace(/[\u007f-￿]/g, ch => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`) + '\n';

const conceptView = (catalogue, concept) => ({
  id: concept.id,
  name: concept.name,
  definition: concept.definition,
  parent: concept.parent,
  category: concept.category,
  alsoUsedIn: concept.alsoUsedIn || [],
  aliases: concept.aliases || [],
  state: stateOf(concept),
  learned: concept.learned,
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

  const target = request => (request.advisor ? { advisor: true } : { courseId: String(request.courseId), n: Number(request.n) });

  const handlers = {
    // A snapshot's copy of a library (LEARN_LIBRARY) never restarts its builds.
    hello: () => ({ settings: lib.settings, status: readStatus(), ytDlp: installedYtDlp(), resumed: process.env.LEARN_LIBRARY ? [] : resumeStale(lib) }),

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
      const jobs = listJobs(lib).filter(job => !job.dismissed && (job.state !== 'done' || Date.parse(job.updatedAt) > day)).slice(0, 10);
      return { categories: catalogue.categories, courses, jobs, status: readStatus() };
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
      const concepts = {};
      for (const page of course.pages) for (const conceptId of page.concepts || []) {
        const concept = conceptById(catalogue, conceptId);
        if (concept) concepts[conceptId] = conceptView(catalogue, concept);
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
      removeCourse(lib, id);
      if (readStatus().course?.id === id) writeStatus({ course: null });
      return true;
    },

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
      const concepts = page.concepts.map(id => conceptById(catalogue, id)).filter(Boolean).map(concept => conceptView(catalogue, concept));
      return { page, concepts, chat: chatView(readChat(lib, { courseId, n: Number(n) })), progress: saved.progress, total: course.pages.length, skipped: saved.skipped || [] };
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
      return { categories: catalogue.categories, concepts: catalogue.concepts.map(concept => conceptView(catalogue, concept)), courseTitles: titles };
    },
    'concept.learn': ({ id, learned, courseId, n }) => updateCatalogue(lib, catalogue => conceptView(catalogue, setLearned(catalogue, id, Boolean(learned), courseId ? { course: courseId, page: Number(n) || null } : null))),
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

    'build.start': ({ topic, category, mode, link }) => {
      const job = createJob(lib, { topic, category, mode, link });
      startDaemon(lib, job.id);
      return job;
    },
    'build.pick': ({ jobId, picks }) => pickSources(lib, jobId, picks || []),
    'build.resume': ({ jobId }) => resumeJob(lib, jobId),
    'build.cancel': ({ jobId }) => cancelJob(lib, jobId),
    'build.dismiss': ({ jobId }) => {
      const job = readJob(lib, jobId);
      if (job) saveJob(lib, { ...job, dismissed: true });
      if (readStatus().build?.id === jobId) writeStatus({ build: null });
      return true;
    },
    'jobs.list': () => listJobs(lib).slice(0, 20),

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
