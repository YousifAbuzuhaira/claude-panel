// Learn's helper against a library of its own in a temp folder: a build walked through
// with stand-ins for yt-dlp, the web and Claude; resuming; the serve protocol; the lock.
// node --test learn/tests/
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'learn-test-'));
process.env.LEARN_LIBRARY = join(root, 'library');
process.env.LEARN_CONFIG_DIR = join(root, 'config');
after(() => rmSync(root, { recursive: true, force: true }));

const { createJob, createPageJob, readJob, runJob, tidyCandidates, cleanOutline } = await import('../build.mjs');
const { movePage, openLibrary, readCatalogue, readCourse, readPage, readStatus, removePage, renamePage } = await import('../library.mjs');
const { createServer } = await import('../serve.mjs');
const { withLock, writeJson, readJson } = await import('../store.mjs');

const CHUNKS = Array.from({ length: 60 }, (_, i) => ({ t: i * 30, text: `part ${i} about volumes` }));

/** Stand-ins for everything a build reaches out to. `answers` maps a schema to Claude's answer. */
function fakeIo({ pageFails = 0 } = {}) {
  const calls = { pages: 0, prompts: [] };
  let failuresLeft = pageFails;
  return {
    calls,
    io: {
      ytSearch: async query => [{ kind: 'youtube', url: 'https://www.youtube.com/watch?v=AAAAAAAAAAA', title: `About ${query}`, channel: 'Chan', lengthMin: 30, views: 10 }],
      ytInfo: async () => ({ id: 'AAAAAAAAAAA', title: 'Volumes video', channel: 'Chan', durationSec: 1800, chapters: [{ title: 'Intro', start: 0, end: 60 }], description: '' }),
      ytCaptions: async () => ({ chunks: CHUNKS }),
      ytPlaylist: async () => ({ title: 'List', videos: [] }),
      fetchPage: async () => ({ title: 'Volumes docs', sections: [{ heading: 'Volumes', anchor: 'volumes', level: 1, text: 'x'.repeat(800) }, { heading: 'Syntax', anchor: 'syntax', level: 2, text: 'docker run -v' }] }),
      ensureYtDlp: async () => '/bin/true',
      askStructured: async ({ prompt, schema }) => {
        calls.prompts.push(prompt);
        if (schema.properties.candidates) {
          return {
            courseTitle: 'Volumes in practice',
            summary: 'S',
            candidates: [
              { kind: 'youtube', url: 'https://youtu.be/AAAAAAAAAAA', title: 'Volumes video', channel: 'Chan', lengthMin: 30, level: 'beginner', why: 'w', recommended: true },
              { kind: 'web', url: 'https://docs.example/volumes', title: 'Docs', channel: 'docs', lengthMin: 10, level: 'beginner', why: 'w', recommended: true },
              { kind: 'web', url: 'https://docs.example/volumes', title: 'Duplicate', channel: 'docs', lengthMin: 10, level: 'beginner', why: 'w', recommended: false },
            ],
          };
        }
        if (schema.properties.concepts && schema.properties.sourceId) {
          return { title: 'Profiles', subtopics: ['optional services'], sourceId: 's2', fromSec: null, toSec: null, sections: ['Syntax'], support: [], concepts: [{ id: null, name: 'Compose profiles', definition: 'd', parent: 'Docker volumes', aliases: [], match: 'new', reason: 'r' }] };
        }
        if (schema.properties.pages) {
          return {
            title: 'Volumes in practice',
            summary: 'S',
            pages: [
              { title: 'Why data vanishes', subtopics: ['layer'], sourceId: 's1', fromSec: 0, toSec: 600, sections: [], support: [{ sourceId: 's2', sections: ['Syntax'] }], concepts: [{ id: null, name: 'Writable layer', definition: 'd', parent: null, aliases: [], match: 'new', reason: 'r' }] },
              { title: 'Volumes', subtopics: [], sourceId: 's2', fromSec: null, toSec: null, sections: ['Volumes', 'No such heading'], support: [], concepts: [{ id: null, name: 'Docker volumes', definition: 'd', parent: null, aliases: [], match: 'new', reason: 'r' }, { id: null, name: 'Volume drivers', definition: 'd', parent: 'Docker volumes', aliases: [], match: 'new', reason: 'r' }] },
              { title: 'Ghost', subtopics: [], sourceId: 's9', fromSec: 99999, toSec: null, sections: [], support: [], concepts: [{ id: null, name: 'writable layers', definition: 'd', parent: null, aliases: [], match: 'new', reason: 'r' }] },
            ],
          };
        }
        if (failuresLeft > 0) {
          failuresLeft--;
          throw new Error('Claude is busy');
        }
        calls.pages++;
        return { markdown: '## Part\nSaid at [1:05] (added). See [sec: Syntax].', checks: [{ q: 'Why?', answer: 'Because.', concepts: ['c_unknown'] }, { q: 'How?', answer: 'So.', concepts: [] }] };
      },
    },
  };
}

describe('a build, start to finish', () => {
  test('auto mode: research, fetch, outline, pages, with ids, links and checks in place', async () => {
    const lib = openLibrary();
    const job = createJob(lib, { topic: 'Docker volumes', category: 'DevOps', mode: 'auto' });
    const { io, calls } = fakeIo();
    await runJob(lib, job.id, io);
    const done = readJob(lib, job.id);
    assert.equal(done.state, 'done');
    assert.equal(done.total, 3);
    const course = readCourse(lib, done.courseId);
    assert.equal(course.status, 'ready');
    assert.equal(course.sources.length, 2, 'the duplicate url was dropped');
    assert.equal(course.pages[2].sourceId, 's1', 'an unknown source falls back to the first');
    assert.deepEqual(course.pages[1].sections, ['Volumes'], 'only headings that exist');
    assert.equal(course.pages[2].concepts[0], course.pages[0].concepts[0], '"writable layers" is the same concept');
    const catalogue = readCatalogue(lib);
    const drivers = catalogue.concepts.find(concept => concept.name === 'Volume drivers');
    assert.equal(drivers.parent, course.pages[1].concepts[0]);
    const page = readPage(lib, course.id, 1);
    const inlines = page.blocks[1].inlines;
    assert.ok(inlines.some(item => item.link === 'https://www.youtube.com/watch?v=AAAAAAAAAAA&t=65s'));
    assert.ok(inlines.some(item => item.link === 'https://docs.example/volumes#syntax'));
    assert.deepEqual(page.checks[0].concepts, course.pages[0].concepts, 'an unknown concept id falls back to the page');
    assert.equal(calls.pages, 3);
    assert.ok(calls.prompts.at(-1).includes('### Video s1'));
    assert.equal(readStatus().build.state, 'done');
  });

  test('pick mode stops for picks; a page that fails twice fails the build; resume writes only what is left', async () => {
    const lib = openLibrary();
    const job = createJob(lib, { topic: 'More volumes', category: 'DevOps', mode: 'pick' });
    await runJob(lib, job.id, fakeIo().io);
    assert.equal(readJob(lib, job.id).state, 'waiting-picks');
    writeJson(lib.paths.job(job.id), { ...readJob(lib, job.id), picks: ['s1', 's2'], step: 'fetch', state: 'running' });
    const failing = fakeIo({ pageFails: 2 });
    await runJob(lib, job.id, failing.io);
    const failed = readJob(lib, job.id);
    assert.equal(failed.state, 'failed');
    assert.equal(failed.step, 'pages');
    const before = readCourse(lib, failed.courseId).pages.filter(page => page.status === 'written');
    const stamps = before.map(page => statSync(lib.paths.page(failed.courseId, page.n)).mtimeMs);
    const again = fakeIo();
    await runJob(lib, job.id, again.io);
    assert.equal(readJob(lib, job.id).state, 'done');
    assert.equal(again.calls.pages, 3 - before.length, 'only the unwritten pages');
    before.forEach((page, i) => assert.equal(statSync(lib.paths.page(failed.courseId, page.n)).mtimeMs, stamps[i]));
  });
});

describe('editing a course', () => {
  const latestCourse = lib => {
    const job = createJob(lib, { topic: 'Edit me', category: 'DevOps', mode: 'auto' });
    return job;
  };

  test('pages are renamed, moved and removed by id; numbers are ids, places are order', async () => {
    const lib = openLibrary();
    const job = latestCourse(lib);
    await runJob(lib, job.id, fakeIo().io);
    const id = readJob(lib, job.id).courseId;
    renamePage(lib, id, 2, 'Volumes, renamed');
    assert.equal(readCourse(lib, id).pages[1].title, 'Volumes, renamed');
    assert.equal(readPage(lib, id, 2).title, 'Volumes, renamed');
    movePage(lib, id, 3, -1);
    assert.deepEqual(readCourse(lib, id).pages.map(page => page.n), [1, 3, 2]);
    writeJson(lib.paths.chat(id, 3), { v: 1, sessionId: 's', messages: [{ role: 'user', text: 'hi' }] });
    removePage(lib, id, 3);
    const after = readCourse(lib, id);
    assert.deepEqual(after.pages.map(page => page.n), [1, 2]);
    assert.equal(existsSync(lib.paths.page(id, 3)), false);
    assert.equal(existsSync(lib.paths.chat(id, 3)), false);
    removePage(lib, id, 2);
    assert.throws(() => removePage(lib, id, 1), /only page/);
  });

  test('a rewrite writes only that page, with the note, and clears its chat', async () => {
    const lib = openLibrary();
    const job = latestCourse(lib);
    await runJob(lib, job.id, fakeIo().io);
    const id = readJob(lib, job.id).courseId;
    const untouched = statSync(lib.paths.page(id, 1)).mtimeMs;
    writeJson(lib.paths.chat(id, 2), { v: 1, sessionId: 's', messages: [{ role: 'user', text: 'old' }] });
    const rewrite = createPageJob(lib, { courseId: id, kind: 'page-rewrite', n: 2, note: 'more hands-on' });
    assert.deepEqual(readJson(lib.paths.chat(id, 2)).messages, []);
    assert.throws(() => createPageJob(lib, { courseId: id, kind: 'page-rewrite', n: 1 }), /being written/);
    assert.throws(() => removePage(lib, id, 1), /being written/);
    const io = fakeIo();
    await runJob(lib, rewrite.id, io.io);
    assert.equal(io.calls.pages, 1);
    assert.ok(io.calls.prompts.at(-1).includes('more hands-on'));
    assert.equal(readJob(lib, rewrite.id).state, 'done');
    assert.equal(readCourse(lib, id).status, 'ready');
    assert.equal(statSync(lib.paths.page(id, 1)).mtimeMs, untouched);
  });

  test('an added page is planned from the sources, gets a new id, and lands after the chosen page', async () => {
    const lib = openLibrary();
    const job = latestCourse(lib);
    await runJob(lib, job.id, fakeIo().io);
    const id = readJob(lib, job.id).courseId;
    const add = createPageJob(lib, { courseId: id, kind: 'page-add', topic: 'Compose profiles', after: 1 });
    const io = fakeIo();
    await runJob(lib, add.id, io.io);
    const course = readCourse(lib, id);
    assert.deepEqual(course.pages.map(page => page.n), [1, 4, 2, 3]);
    assert.equal(course.pages[1].title, 'Profiles');
    assert.equal(course.pages[1].added, true);
    assert.ok(readPage(lib, id, 4));
    assert.equal(io.calls.pages, 1);
    assert.ok(io.calls.prompts.at(-1).includes('Write page 2 of 4'));
    assert.ok(readCatalogue(lib).concepts.some(concept => concept.name === 'Compose profiles'));
    assert.match(readJob(lib, add.id).message, /^Added: Profiles/);
  });
});

describe('helpers', () => {
  test('candidates: watch urls, no duplicates, ids in order', () => {
    const tidy = tidyCandidates([{ url: 'https://youtu.be/AAAAAAAAAAA?t=4', title: 'a' }, { url: 'https://www.youtube.com/watch?v=AAAAAAAAAAA' }, { url: 'ftp://x' }, { url: 'https://d/x', title: 'b' }]);
    assert.deepEqual(tidy.map(item => [item.id, item.kind, item.url]), [['s1', 'youtube', 'https://www.youtube.com/watch?v=AAAAAAAAAAA'], ['s2', 'web', 'https://d/x']]);
  });

  test('an outline is kept inside its video', () => {
    const [page] = cleanOutline([{ title: 'T', sourceId: 's1', fromSec: -5, toSec: 99999, concepts: [{ name: 'x' }] }], [{ id: 's1', kind: 'youtube', durationSec: 600 }]);
    assert.deepEqual([page.fromSec, page.toSec], [0, 600]);
  });

  test('the lock nests within one process and is gone afterwards', () => {
    const lib = openLibrary();
    const value = withLock(lib.root, () => withLock(lib.root, () => 7));
    assert.equal(value, 7);
    assert.equal(existsSync(join(lib.root, '.lock')), false);
    writeJson(join(root, 'x.json'), { a: 1 });
    assert.deepEqual(readJson(join(root, 'x.json')), { a: 1 });
  });
});

describe('serve', () => {
  const ask = async (server, lines, request) => {
    const before = lines.length;
    await server.handle(JSON.stringify(request));
    return JSON.parse(lines.slice(before).find(line => JSON.parse(line).rid === request.rid));
  };

  test('answers carry the rid even when the request has an id of its own; errors are answers too', async () => {
    const lines = [];
    const server = createServer({ write: text => lines.push(text.trim()) });
    const library = await ask(server, lines, { rid: 1, cmd: 'library.get' });
    assert.equal(library.ok, true);
    const courseId = library.result.courses[0].id;
    const course = await ask(server, lines, { rid: 2, cmd: 'course.get', id: courseId });
    assert.equal(course.rid, 2);
    assert.equal(course.result.course.id, courseId);
    const missing = await ask(server, lines, { rid: 3, cmd: 'course.get', id: 'nope' });
    assert.deepEqual([missing.ok, missing.error], [false, 'no such course']);
    const unknown = await ask(server, lines, { rid: 4, cmd: 'explode' });
    assert.match(unknown.error, /unknown command/);
  });

  test('opening a page makes its concepts Seen, never Learned; a tick makes one Learned', async () => {
    const lines = [];
    const server = createServer({ write: text => lines.push(text.trim()) });
    const library = await ask(server, lines, { rid: 1, cmd: 'library.get' });
    const courseId = library.result.courses[0].id;
    const page = await ask(server, lines, { rid: 2, cmd: 'page.get', courseId, n: 1 });
    assert.ok(page.result.concepts.every(concept => concept.state === 'seen'));
    const id = page.result.concepts[0].id;
    const learned = await ask(server, lines, { rid: 3, cmd: 'concept.learn', id, learned: true, courseId, n: 1 });
    assert.equal(learned.result.state, 'learned');
    const status = JSON.parse(readFileSync(join(process.env.LEARN_CONFIG_DIR, 'status.json'), 'utf8'));
    assert.equal(status.course.id, courseId);
  });

  test('output is ASCII, so nothing is lost on the way to Windows', async () => {
    const lines = [];
    const server = createServer({ write: text => lines.push(text) });
    await server.handle(JSON.stringify({ rid: 1, cmd: 'category.add', name: 'Café → ops' }));
    assert.ok(/^[\x00-\x7f]*$/.test(lines.join('')));
    assert.equal(JSON.parse(lines[0]).result.name, 'Café → ops');
  });
});
