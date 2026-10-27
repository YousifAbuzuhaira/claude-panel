// The library on disk: the catalogue, courses and their pages, and the small status file
// the panel's Learn tab reads. Every change goes through withLock.
import { readdirSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';
import { emptyCatalogue, removeConcept, stateOf } from './catalogue.mjs';
import { CONFIG_DIR, STATUS_FILE, readSettings } from './settings.mjs';
import { libraryPaths, readJson, withLock, writeJson } from './store.mjs';

export function openLibrary(settings = readSettings()) {
  return { root: settings.library, paths: libraryPaths(settings.library), settings };
}

export const readCatalogue = lib => readJson(lib.paths.catalogue) || emptyCatalogue();

/** `fn` changes the catalogue in place; what it returns is passed back. */
export function updateCatalogue(lib, fn) {
  return withLock(lib.root, () => {
    const catalogue = readCatalogue(lib);
    const result = fn(catalogue);
    writeJson(lib.paths.catalogue, catalogue);
    return result;
  });
}

export const readCourse = (lib, id) => readJson(lib.paths.course(id));

export function updateCourse(lib, id, fn) {
  return withLock(lib.root, () => {
    const course = readCourse(lib, id);
    if (!course) throw new Error('no such course');
    const result = fn(course);
    writeJson(lib.paths.course(id), course);
    return result;
  });
}

export const readPage = (lib, id, n) => readJson(lib.paths.page(id, n));

export function newCourseId(title) {
  const slug = String(title || 'course').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'course';
  return `${slug}-${randomBytes(2).toString('hex')}`;
}

export function listCourses(lib) {
  let names = [];
  try {
    names = readdirSync(lib.paths.courses);
  } catch {
    return [];
  }
  return names.map(name => {
    try {
      return readCourse(lib, name);
    } catch {
      return null;
    }
  }).filter(Boolean);
}

/** What the Library shows for one course. */
export function courseSummary(course, catalogue) {
  const ids = [...new Set(course.pages.flatMap(page => page.concepts || []))];
  const concepts = ids.map(id => catalogue.concepts.find(concept => concept.id === id)).filter(Boolean);
  return {
    id: course.id,
    title: course.title,
    topic: course.topic,
    category: course.category,
    status: course.status,
    summary: course.summary || '',
    pages: course.pages.length,
    written: course.pages.filter(page => page.status === 'written').length,
    read: (course.read || []).length,
    skipped: (course.skipped || []).length,
    concepts: concepts.length,
    learned: concepts.filter(concept => stateOf(concept) === 'learned').length,
    sources: course.sources.filter(source => source.usable !== false).length,
    lastOpened: course.progress?.at || null,
    createdAt: course.createdAt,
  };
}

/**
 * Removes a course and the concepts only it taught. A concept another course still
 * teaches stays, and so does one the person added by hand. Returns how many went.
 */
export function removeCourse(lib, id) {
  return withLock(lib.root, () => {
    const course = readCourse(lib, id);
    const taught = new Set((course?.pages || []).flatMap(page => page.concepts || []));
    rmSync(dirname(lib.paths.course(id)), { recursive: true, force: true });
    return pruneConcepts(lib, taught);
  });
}

/** Concepts no course teaches any more (of `among`, when given), except ones added by hand. */
export function pruneConcepts(lib, among = null) {
  return withLock(lib.root, () => {
    const used = new Set(listCourses(lib).flatMap(course => course.pages.flatMap(page => page.concepts || [])));
    return updateCatalogue(lib, catalogue => {
      const gone = catalogue.concepts.filter(concept => !used.has(concept.id) && concept.by !== 'user' && (!among || among.has(concept.id)));
      for (const concept of gone) removeConcept(catalogue, concept.id);
      return gone.length;
    });
  });
}

// --- Pages ------------------------------------------------------------------------------
// A page's `n` is its id for good (its files are pages/NN.json and chats/NN.json); its
// place in `course.pages` is its order.

/** A build or page job still working on this course, if any. */
export function activeJobFor(lib, courseId) {
  let names = [];
  try {
    names = readdirSync(lib.paths.jobs).filter(name => name.endsWith('.json'));
  } catch {
    return null;
  }
  for (const name of names) {
    const job = readJson(`${lib.paths.jobs}/${name}`);
    if (job && job.courseId === courseId && (job.state === 'running' || job.state === 'waiting-picks')) return job;
  }
  return null;
}

function refuseWhileBuilding(lib, courseId) {
  if (activeJobFor(lib, courseId)) throw new Error('this course is being written: wait for that to finish');
}

export function renamePage(lib, courseId, n, title) {
  const clean = String(title || '').trim().slice(0, 120);
  if (!clean) throw new Error('a page needs a title');
  return withLock(lib.root, () => {
    const course = readCourse(lib, courseId);
    const entry = course?.pages.find(page => page.n === n);
    if (!entry) throw new Error('no such page');
    entry.title = clean;
    writeJson(lib.paths.course(courseId), course);
    const file = lib.paths.page(courseId, n);
    const page = readJson(file);
    if (page) writeJson(file, { ...page, title: clean });
    return course;
  });
}

export function movePage(lib, courseId, n, delta) {
  return withLock(lib.root, () => {
    refuseWhileBuilding(lib, courseId);
    const course = readCourse(lib, courseId);
    const index = course ? course.pages.findIndex(page => page.n === n) : -1;
    if (index < 0) throw new Error('no such page');
    const to = Math.max(0, Math.min(course.pages.length - 1, index + Math.sign(delta)));
    if (to !== index) {
      const [page] = course.pages.splice(index, 1);
      course.pages.splice(to, 0, page);
      writeJson(lib.paths.course(courseId), course);
    }
    return course;
  });
}

/** Gone for good, with its chat. Its concepts stay in the catalogue. */
export function removePage(lib, courseId, n) {
  return withLock(lib.root, () => {
    refuseWhileBuilding(lib, courseId);
    const course = readCourse(lib, courseId);
    const index = course ? course.pages.findIndex(page => page.n === n) : -1;
    if (index < 0) throw new Error('no such page');
    if (course.pages.length === 1) throw new Error('this is the only page: remove the course instead');
    course.pages.splice(index, 1);
    course.read = (course.read || []).filter(other => other !== n);
    course.skipped = (course.skipped || []).filter(other => other !== n);
    if (course.overlap?.skippablePages) course.overlap.skippablePages = course.overlap.skippablePages.filter(other => other !== n);
    if (course.progress?.page === n) course.progress = null;
    writeJson(lib.paths.course(courseId), course);
    for (const file of [lib.paths.page(courseId, n), lib.paths.chat(courseId, n), lib.paths.chatSystem(courseId, n)]) rmSync(file, { force: true });
    return course;
  });
}

/** After a merge, every page that named `fromId` names `toId`. */
export function rewriteConceptIds(lib, fromId, toId) {
  const swap = ids => [...new Set((ids || []).map(id => (id === fromId ? toId : id)))];
  withLock(lib.root, () => {
    for (const course of listCourses(lib)) {
      let changed = false;
      for (const page of course.pages) {
        if ((page.concepts || []).includes(fromId)) {
          page.concepts = swap(page.concepts);
          changed = true;
          const file = lib.paths.page(course.id, page.n);
          const full = readJson(file);
          if (full) {
            full.concepts = swap(full.concepts);
            for (const check of full.checks || []) check.concepts = swap(check.concepts);
            writeJson(file, full);
          }
        }
      }
      if (changed) writeJson(lib.paths.course(course.id), course);
    }
  });
}

// --- The status the panel reads ---------------------------------------------------------

export const readStatus = () => readJson(STATUS_FILE) || { v: 1, build: null, course: null, usage: null };

/** Merges `patch` into status.json (the build, the course in front, the latest usage). */
export function writeStatus(patch) {
  return withLock(CONFIG_DIR, () => {
    const next = { ...readStatus(), ...patch, v: 1, at: new Date().toISOString() };
    writeJson(STATUS_FILE, next);
    return next;
  });
}

let usageWrittenAt = 0;

/** Keeps the latest usage-limit reading Claude reported (at most every 20 s). */
export function recordUsage(info) {
  if (!info || Date.now() - usageWrittenAt < 20_000) return;
  usageWrittenAt = Date.now();
  const windows = info.unifiedWindows || {};
  try {
    writeStatus({
      usage: {
        status: info.status || null,
        fiveHour: windows.five_hour?.utilization ?? null,
        fiveHourResetsAt: windows.five_hour?.resetsAt ?? info.resetsAt ?? null,
        sevenDay: windows.seven_day?.utilization ?? null,
        at: new Date().toISOString(),
      },
    });
  } catch {
    // only a reading
  }
}

/** A job as the panel's one build line. */
export const buildStatus = job => job && {
  id: job.id,
  topic: job.topic,
  step: job.step,
  state: job.state,
  message: job.message || '',
  done: job.done || 0,
  total: job.total || 0,
  courseId: job.courseId || null,
};
