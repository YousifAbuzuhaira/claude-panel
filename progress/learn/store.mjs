// The one place that writes the library: atomic JSON files under a lock, so the window's
// helper and a build running in the background never overwrite each other.
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';

const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** Temp file, then rename. A synced folder (OneDrive) can hold a file a moment: retry. */
export function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}`;
  writeFileSync(temp, JSON.stringify(value, null, 1) + '\n');
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(temp, file);
      return;
    } catch (error) {
      if (attempt >= 20 || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) {
        try { unlinkSync(temp); } catch {}
        throw error;
      }
      pause(100);
    }
  }
}

export function writeText(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}`;
  writeFileSync(temp, text);
  renameSync(temp, file);
}

const isAlive = pid => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
};

function isStale(lock) {
  try {
    const pid = Number(readFileSync(lock, 'utf8'));
    if (!pid || !isAlive(pid)) return true;
    return Date.now() - statSync(lock).mtimeMs > 30_000;
  } catch {
    return true;
  }
}

const held = new Map();

/** Runs `fn` holding `<library>/.lock`. Nested calls in one process share the hold. */
export function withLock(library, fn) {
  const lock = join(library, '.lock');
  if (held.get(lock) > 0) {
    held.set(lock, held.get(lock) + 1);
    try { return fn(); } finally { held.set(lock, held.get(lock) - 1); }
  }
  mkdirSync(library, { recursive: true });
  for (let attempt = 0; ; attempt++) {
    try {
      const fd = openSync(lock, 'wx');
      writeSync(fd, String(process.pid));
      closeSync(fd);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (isStale(lock)) {
        try { unlinkSync(lock); } catch {}
        continue;
      }
      if (attempt > 200) throw new Error('the library stayed locked for 10 s');
      pause(50);
    }
  }
  held.set(lock, 1);
  try {
    return fn();
  } finally {
    held.delete(lock);
    try { unlinkSync(lock); } catch {}
  }
}

/** Where everything in a library lives. */
export function libraryPaths(root) {
  const course = id => join(root, 'courses', safeId(id));
  const pageFile = n => `${String(n).padStart(2, '0')}.json`;
  return {
    root,
    catalogue: join(root, 'catalogue.json'),
    courses: join(root, 'courses'),
    course: id => join(course(id), 'course.json'),
    source: (id, sourceId) => join(course(id), 'sources', `${safeId(sourceId)}.json`),
    captions: id => join(course(id), 'sources', 'captions'),
    page: (id, n) => join(course(id), 'pages', pageFile(n)),
    chat: (id, n) => join(course(id), 'chats', pageFile(n)),
    chatSystem: (id, n) => join(course(id), 'chats', pageFile(n).replace('.json', '.system.md')),
    advisorChat: join(root, 'advisor', 'chat.json'),
    advisorSystem: join(root, 'advisor', 'system.md'),
    jobs: join(root, 'jobs'),
    job: id => join(root, 'jobs', `${safeId(id)}.json`),
    jobLog: id => join(root, 'jobs', `${safeId(id)}.log`),
  };
}

/** Ids name folders and files: keep them to a safe alphabet. */
export function safeId(id) {
  const text = String(id || '');
  if (!/^[a-z0-9][a-z0-9_-]{0,80}$/i.test(text)) throw new Error(`bad id: ${text}`);
  return text;
}

export const exists = existsSync;
