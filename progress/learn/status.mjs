// The library's handle and the small status file the panel's Learn tab (and the explain plugin's
// notices) read: shared by course builds and explainers, so it needs nothing of courses.
import { CONFIG_DIR, STATUS_FILE, readSettings } from './settings.mjs';
import { libraryPaths, readJson, withLock, writeJson } from './store.mjs';

export function openLibrary(settings = readSettings()) {
  return { root: settings.library, paths: libraryPaths(settings.library), settings };
}

export const readStatus = () => readJson(STATUS_FILE) || { v: 1, build: null, course: null, usage: null };

/** Merges `patch` into status.json (the build, the course in front, the latest usage). */
export function writeStatus(patch) {
  return withLock(CONFIG_DIR, () => {
    const next = { ...readStatus(), ...patch, v: 1, at: new Date().toISOString() };
    writeJson(STATUS_FILE, next);
    return next;
  });
}

/** A job as the panel's one build line. */
export const buildStatus = job => job && {
  id: job.id,
  kind: job.kind || null,
  topic: job.topic,
  step: job.step,
  state: job.state,
  message: job.message || '',
  done: job.done || 0,
  total: job.total || 0,
  courseId: job.courseId || null,
  explain: job.kind === 'explain' ? job.explain || null : null,
  file: job.kind === 'explain' ? job.file || null : null,
  wiki: job.kind === 'explain' ? job.wiki || null : null,
  ...(job.kind === 'video' ? { working: job.working || [], leftMinutes: job.leftMinutes ?? null } : {}),
};
