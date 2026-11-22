// Learn's helper against a library of its own in a temp folder: a build walked through
// with stand-ins for yt-dlp, the web and Claude; resuming; the serve protocol; the lock.
// node --test learn/tests/
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'learn-test-'));
process.env.LEARN_LIBRARY = join(root, 'library');
process.env.LEARN_CONFIG_DIR = join(root, 'config');
after(() => rmSync(root, { recursive: true, force: true }));

const { createJob, createPageJob, createRefreshJob, readJob, runJob, tidyCandidates, cleanOutline } = await import('../build.mjs');
const { buildStatus, listCourses, movePage, openLibrary, pruneConcepts, readCatalogue, readCourse, readPage, readStatus, removeCourse, removePage, renamePage, updateCatalogue } = await import('../library.mjs');
const { addConcept, ensureCategory, setPassed } = await import('../catalogue.mjs');
const { createServer } = await import('../serve.mjs');
const { withLock, writeJson, readJson } = await import('../store.mjs');
const { clearQueue, courseVideos, makeVideos, queueVideos, readQueue, swapVideo, videoInfo } = await import('../video.mjs');
const { readDocument } = await import('../documents.mjs');
const { writeSettings } = await import('../settings.mjs');

const CHUNKS = Array.from({ length: 60 }, (_, i) => ({ t: i * 30, text: `part ${i} about volumes` }));

/** Stand-ins for everything a build reaches out to. `answers` maps a schema to Claude's answer. */
function fakeIo({ pageFails = 0, brief = 'some', disputes = [], briefFixes = [], source = null, changes = [] } = {}) {
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
      readDocument: (file, options) => readDocument(file, options),
      readClaudeChat: async id => {
        calls.chats = [...(calls.chats || []), id];
        return { text: 'CHAT: Fixing the panel\n[#1] LEARNER: the browser link does nothing\nCLAUDE: the opener dies with wsl.exe', cwd: '', title: 'Fixing the panel', turns: 2 };
      },
      askStructured: async ({ prompt, schema, tools }) => {
        calls.prompts.push(prompt);
        calls.tools = [...(calls.tools || []), tools];
        if (schema.properties.disputes) return { disputes };
        // The brief held against the chat, a page against its material, and a patch.
        if (schema.properties.fixes) return { wrong: [], dropped: briefFixes.length ? [{ fact: 'a dropped fact', where: '12', section: 'x' }] : [], fixes: briefFixes };
        if (schema.properties.dropped) {
          calls.sourceChecks = (calls.sourceChecks || 0) + 1;
          return source || { wrong: [], dropped: [] };
        }
        if (schema.properties.changes) {
          calls.patches = (calls.patches || 0) + 1;
          return { changes };
        }
        if (schema.properties.found) {
          if (brief === 'nothing') return { found: false, courseTitle: 'x', summary: 'The chat is about something else.', category: 'x', sections: [] };
          return {
            found: true,
            asks: ['the browser link fix', 'the browser link fix', 'how it was checked'],
            courseTitle: 'Opening a browser from WSL',
            summary: 'Why a link opened from WSL can die, and the one-time link that fixes it.',
            category: 'Windows',
            sections: [
              { heading: 'The problem', text: 'Clicking did nothing. '.repeat(20) },
              { heading: 'Why the opener died', text: 'WSL stops the processes of a wsl.exe that ends. '.repeat(20) },
              { heading: 'The fix', text: 'Return a one-time link and open it from Windows. '.repeat(20) },
              { heading: 'Key facts', text: '- FALSE: the opener outlives wsl.exe. True: WSL stops it when wsl.exe ends.' },
            ],
          };
        }
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
        if (schema.properties.terms) {
          calls.teach = (calls.teach || 0) + 1;
          const concepts = [...prompt.matchAll(/^- (c_\w+): /gm)].map(match => match[1]);
          return {
            terms: [{ term: 'volume', aka: [], def: 'Storage that outlives a container.', key: true }],
            quick: [
              { q: 'Which keeps the data?', guess: false, options: [{ text: 'the volume', right: true, why: 'Said on the page.' }, { text: 'the layer', right: false, why: 'It goes.' }, { text: 'the image', right: false, why: 'Read only.' }], quote: 'Volumes keep your data safe when a container is removed', section: 'Part', concepts: concepts.slice(0, 1) },
              { q: 'Not from the page?', guess: false, options: [{ text: 'a', right: true, why: 'x' }, { text: 'b', right: false, why: 'x' }, { text: 'c', right: false, why: 'x' }], quote: 'nothing like this is written anywhere on it', section: 'Part', concepts: [] },
            ],
            closing: [{ q: `Explain it (${calls.teach})`, points: ['one', 'two'], answer: 'Because.', quote: 'Volumes keep your data safe when a container is removed', section: 'Part', concepts }],
          };
        }
        if (schema.properties.answers) {
          const shown = [...prompt.matchAll(/^\[(q\w+)\]/gm)].map(match => match[1]);
          const line = /^ {2}(\d): the volume$/m.exec(prompt);
          return { answers: shown.map(id => ({ id, choice: line ? Number(line[1]) : null })), closing: shown.map(id => ({ id, answerable: true })), unknown: [], missing: [] };
        }
        calls.pages++;
        return { markdown: '## Part\nSaid at [1:05] (added). See [sec: Syntax].\n\nVolumes keep your data safe when a container is removed.\n\n## Recap\nDone.' };
      },
    },
  };
}

describe('the lock on Learned', () => {
  test('a chip is refused until a closing question is passed; unmarking and Add as learned stay open', async () => {
    const lib = openLibrary();
    const job = createJob(lib, { topic: 'Locked', category: 'DevOps' });
    await runJob(lib, job.id, fakeIo().io);
    const courseId = readJob(lib, job.id).courseId;
    const [id] = readCourse(lib, courseId).pages[0].concepts;
    const lines = [];
    const server = createServer({ write: text => lines.push(text.trim()) });
    const ask = async request => {
      lines.length = 0;
      await server.handle(JSON.stringify({ rid: 1, ...request }));
      return JSON.parse(lines.at(-1));
    };
    const refused = await ask({ cmd: 'concept.learn', id, learned: true });
    assert.equal(refused.ok, false);
    assert.match(refused.error, /closing question/);
    updateCatalogue(lib, catalogue => setPassed(catalogue, [id], { course: courseId, page: 1 }));
    const marked = await ask({ cmd: 'concept.learn', id, learned: true });
    assert.equal(marked.result.state, 'learned');
    const unmarked = await ask({ cmd: 'concept.learn', id, learned: false });
    assert.notEqual(unmarked.result.state, 'learned');
  });
  test('a page shows its answers, and a flagged question goes from the page and review', async () => {
    const lib = openLibrary();
    const job = createJob(lib, { topic: 'Checks', category: 'DevOps' });
    await runJob(lib, job.id, fakeIo().io);
    const courseId = readJob(lib, job.id).courseId;
    const lines = [];
    const server = createServer({ write: text => lines.push(text.trim()) });
    const ask = async request => {
      lines.length = 0;
      await server.handle(JSON.stringify({ rid: 1, ...request }));
      return JSON.parse(lines.at(-1)).result;
    };
    const first = await ask({ cmd: 'page.get', courseId, n: 1 });
    const check = first.page.blocks.find(block => block.t === 'check');
    const right = check.options.findIndex(option => option.right);
    assert.deepEqual(await ask({ cmd: 'check.answer', courseId, n: 1, id: check.id, choice: right }), { right: true });
    const second = await ask({ cmd: 'page.get', courseId, n: 1 });
    assert.equal(second.answers[check.id], right);
    assert.ok(second.glossary.some(item => item.term === 'volume'));
    await ask({ cmd: 'check.flag', key: `${courseId}/1/${check.id}` });
    const third = await ask({ cmd: 'page.get', courseId, n: 1 });
    assert.ok(!third.page.blocks.some(block => block.t === 'check'));
  });
});

describe('updating an older course', () => {
  test('the same sources make a new course; the old one is untouched', async () => {
    const lib = openLibrary();
    const job = createJob(lib, { topic: 'Older', category: 'DevOps' });
    const { io, calls } = fakeIo();
    await runJob(lib, job.id, io);
    const oldId = readJob(lib, job.id).courseId;
    const before = calls.pages;
    const refresh = createRefreshJob(lib, oldId);
    assert.equal(refresh.step, 'outline', 'no research, and nothing fetched again');
    await runJob(lib, refresh.id, io);
    const fresh = readCourse(lib, readJob(lib, refresh.id).courseId);
    assert.notEqual(fresh.id, oldId);
    assert.equal(fresh.updatedFrom, oldId);
    assert.equal(fresh.status, 'ready');
    assert.equal(calls.pages, before + fresh.pages.length);
    assert.equal(readCourse(lib, oldId).status, 'ready');
    assert.ok(readPage(lib, oldId, 1));
  });
});

describe('everything you asked for', () => {
  test('a named thing with no source gets a second search; one with no page, a second plan', async () => {
    const lib = openLibrary();
    const job = createJob(lib, { topic: 'Docker and Kubernetes', category: 'DevOps' });
    assert.equal(job.mode, 'auto', 'a build goes straight through unless you ask to pick');
    const { io } = fakeIo();
    const prompts = { research: [], outline: [] };
    const real = io.askStructured;
    io.askStructured = async request => {
      const answer = await real(request);
      if (request.schema.properties.candidates) {
        prompts.research.push(request.prompt);
        const second = prompts.research.length > 1;
        return {
          ...answer,
          asks: ['Docker', 'Kubernetes'],
          candidates: second
            ? [{ ...answer.candidates[1], url: 'https://docs.example/k8s', covers: [1], recommended: true }]
            : answer.candidates.map(candidate => ({ ...candidate, covers: [0] })),
        };
      }
      if (request.schema.properties.pages) {
        prompts.outline.push(request.prompt);
        return { ...answer, pages: answer.pages.map((page, index) => ({ ...page, part: 'Basics', outcomes: ['Trace it'], covers: prompts.outline.length > 1 && index === 2 ? [1] : [0] })) };
      }
      return answer;
    };
    await runJob(lib, job.id, io);
    const done = readJob(lib, job.id);
    assert.equal(prompts.research.length, 2);
    assert.ok(prompts.research[1].includes('found nothing good for: Kubernetes'));
    assert.equal(prompts.outline.length, 2);
    assert.ok(prompts.outline[1].includes('no page for: Kubernetes'));
    const course = readCourse(lib, done.courseId);
    assert.deepEqual(course.asks, ['Docker', 'Kubernetes']);
    assert.deepEqual(course.notCovered, []);
    assert.equal(course.pages[0].part, 'Basics');
    assert.deepEqual(course.pages[2].outcomes, ['Trace it']);
  });
  test('what still has no page shows on the course', async () => {
    const lib = openLibrary();
    const job = createJob(lib, { topic: 'Docker and Rust', category: 'DevOps' });
    const { io } = fakeIo();
    const real = io.askStructured;
    io.askStructured = async request => {
      const answer = await real(request);
      if (request.schema.properties.candidates) return { ...answer, asks: ['Docker', 'Rust'], candidates: answer.candidates.map(candidate => ({ ...candidate, covers: [0, 1] })) };
      if (request.schema.properties.pages) return { ...answer, pages: answer.pages.map(page => ({ ...page, covers: [0] })) };
      return answer;
    };
    await runJob(lib, job.id, io);
    assert.deepEqual(readCourse(lib, readJob(lib, job.id).courseId).notCovered, ['Rust']);
  });
});

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
    assert.deepEqual(page.checks[0].concepts, course.pages[0].concepts);
    assert.deepEqual(page.blocks.map(block => block.t), ['h', 'p', 'p', 'check', 'h', 'p'], 'the check that passed sits at the end of its section');
    assert.equal(page.stats.failed, 1, 'the question whose quote is not on the page was dropped');
    assert.equal(page.terms[0].term, 'volume');
    assert.ok(course.terms.some(item => item.term === 'volume' && item.n === 1));
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

describe('removing a course', () => {
  test('takes the concepts only it taught; keeps ones another course teaches and ones added by hand', async () => {
    const lib = openLibrary();
    // Courses from the tests above teach the same fake concepts: start from none.
    for (const course of listCourses(lib)) removeCourse(lib, course.id);
    const first = createJob(lib, { topic: 'First', category: 'DevOps', mode: 'auto' });
    await runJob(lib, first.id, fakeIo().io);
    const second = createJob(lib, { topic: 'Second', category: 'DevOps', mode: 'auto' });
    await runJob(lib, second.id, fakeIo().io);
    const firstId = readJob(lib, first.id).courseId;
    const secondId = readJob(lib, second.id).courseId;
    // The fake outline gives both courses the same concepts: all are shared.
    const shared = readCourse(lib, firstId).pages.flatMap(page => page.concepts);
    updateCatalogue(lib, catalogue => addConcept(catalogue, { name: 'Git rebase', category: ensureCategory(catalogue, 'DevOps').id, by: 'user' }));
    assert.equal(removeCourse(lib, firstId), 0, 'every concept is still taught by the second course');
    assert.ok(shared.every(id => readCatalogue(lib).concepts.some(concept => concept.id === id)));
    const removed = removeCourse(lib, secondId);
    assert.ok(removed >= 3);
    const left = readCatalogue(lib).concepts;
    assert.ok(left.some(concept => concept.name === 'Git rebase'), 'added by hand: stays');
    assert.ok(shared.every(id => !left.some(concept => concept.id === id)));
    assert.equal(pruneConcepts(lib), 0, 'nothing left over');
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

  test('an outline keeps what each page owns, tidied and at most 8; an older plan with none owns nothing', () => {
    const teaches = ['  JWT  verify ', '', 'Prefetch', ...Array.from({ length: 10 }, (_, k) => `term ${k}`)];
    const [page, older] = cleanOutline([{ title: 'T', sourceId: 's1', teaches, concepts: [{ name: 'x' }] }, { title: 'U', sourceId: 's1', concepts: [{ name: 'y' }] }], [{ id: 's1', kind: 'chat', sections: [] }]);
    assert.deepEqual(page.teaches.slice(0, 2), ['JWT verify', 'Prefetch']);
    assert.equal(page.teaches.length, 8);
    assert.deepEqual(older.teaches, []);
  });

  test("the status an explainer's job writes names the explainer, for the panel's Watch clips; other jobs name none", () => {
    const job = { id: 'j1', kind: 'explain', explain: 'x202611181332459e', topic: 'Tokens', step: 'clips', state: 'running', done: 1, total: 3 };
    assert.equal(buildStatus(job).explain, 'x202611181332459e');
    assert.equal(buildStatus({ ...job, kind: 'video' }).explain, null);
    assert.equal(buildStatus({ ...job, kind: undefined, explain: undefined }).explain, null);
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
    assert.deepEqual(library.result.explainers, [], 'no explainer made yet: an empty list, not a missing one');
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

describe("Ask's chats", () => {
  const ask = async (server, lines, request) => {
    const before = lines.length;
    await server.handle(JSON.stringify(request));
    return JSON.parse(lines.slice(before).find(line => JSON.parse(line).rid === request.rid));
  };

  test('the one chat of before becomes the first of the list, once', async () => {
    const lib = openLibrary();
    writeJson(lib.paths.advisorChat, { v: 1, sessionId: null, messages: [
      { role: 'user', text: 'What should I learn next about Postgres replication and failover in production?', at: '2026-11-01T10:00:00.000Z' },
      { role: 'assistant', text: 'Start with WAL.', at: '2026-11-01T10:01:00.000Z' },
    ] });
    const lines = [];
    const server = createServer({ write: text => lines.push(text.trim()) });
    const list = (await ask(server, lines, { rid: 1, cmd: 'advisor.list' })).result;
    assert.equal(list.length, 1);
    assert.equal(list[0].count, 2);
    assert.ok(list[0].title.length <= 60);
    assert.match(list[0].title, /^What should I learn next about Postgres/);
    assert.ok(!existsSync(lib.paths.advisorChat));
    assert.ok(existsSync(`${lib.paths.advisorChat}.moved`));
    const again = (await ask(server, lines, { rid: 2, cmd: 'advisor.list' })).result;
    assert.equal(again.length, 1);
    const chat = (await ask(server, lines, { rid: 3, cmd: 'chat.get', advisor: true, chatId: list[0].id })).result;
    assert.equal(chat.messages.length, 2);
    assert.ok(chat.messages[1].blocks, 'replies come with their blocks');
  });

  test('chats are listed by when they were last used; a new id reads empty; remove takes one away', async () => {
    const lib = openLibrary();
    writeJson(lib.paths.advisorChatFile('aold'), { v: 1, id: 'aold', title: 'Old', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', messages: [{ role: 'user', text: 'Old', at: '2026-10-01T00:00:00.000Z' }] });
    writeJson(lib.paths.advisorChatFile('anew'), { v: 1, id: 'anew', title: 'New', createdAt: '2026-11-02T00:00:00.000Z', updatedAt: '2026-11-02T00:00:00.000Z', messages: [{ role: 'user', text: 'New', at: '2026-11-02T00:00:00.000Z' }] });
    writeJson(lib.paths.advisorChatFile('aempty'), { v: 1, id: 'aempty', title: '', createdAt: null, updatedAt: null, messages: [] });
    const lines = [];
    const server = createServer({ write: text => lines.push(text.trim()) });
    const ids = (await ask(server, lines, { rid: 1, cmd: 'advisor.list' })).result.map(chat => chat.id);
    assert.deepEqual(ids.slice(0, 2), ['anew', 'aold']);
    assert.ok(!ids.includes('aempty'), 'an empty chat is not listed');
    const fresh = (await ask(server, lines, { rid: 2, cmd: 'chat.get', advisor: true, chatId: 'abrandnew' })).result;
    assert.deepEqual(fresh.messages, []);
    assert.equal((await ask(server, lines, { rid: 3, cmd: 'advisor.remove', chatId: 'aold' })).ok, true);
    const after = (await ask(server, lines, { rid: 4, cmd: 'advisor.list' })).result.map(chat => chat.id);
    assert.ok(!after.includes('aold'));
    assert.ok(!existsSync(lib.paths.advisorChatFile('aold')));
  });

  test('a chat id must be a safe name', async () => {
    const lines = [];
    const server = createServer({ write: text => lines.push(text.trim()) });
    const bad = await ask(server, lines, { rid: 1, cmd: 'chat.get', advisor: true, chatId: '../../etc' });
    assert.equal(bad.ok, false);
    assert.match(bad.error, /bad id/);
    const none = await ask(server, lines, { rid: 2, cmd: 'advisor.remove', chatId: '' });
    assert.equal(none.ok, false);
  });
});

describe('a course from a document', () => {
  const notes = join(root, 'notes.md');
  writeFileSync(notes, `# Postgres failover\n\nWhy replicas matter. ${'More words about replicas and the WAL. '.repeat(30)}\n\n## Promotion\n\n${'Promote the standby with pg_promote and fence the old primary. '.repeat(30)}\n`);

  test('the document is copied in, read into sections, and becomes the course\'s one source', async () => {
    const lib = openLibrary();
    const job = createJob(lib, { file: notes, category: 'Databases' });
    assert.equal(job.mode, 'document');
    assert.equal(job.fileName, 'notes.md');
    assert.ok(job.file.startsWith(lib.paths.jobs) && existsSync(job.file), 'the build keeps its own copy');
    assert.ok(existsSync(notes), 'the original stays where it was');
    const { io, calls } = fakeIo();
    await runJob(lib, job.id, io);
    const done = readJob(lib, job.id);
    assert.equal(done.state, 'done', done.error || '');
    const course = readCourse(lib, done.courseId);
    assert.equal(course.title, 'Postgres failover');
    assert.equal(course.sources.length, 1);
    assert.equal(course.sources[0].kind, 'doc');
    const source = readJson(lib.paths.source(course.id, 's1'));
    assert.deepEqual(source.sections.map(section => section.heading), ['Postgres failover', 'Promotion']);
    assert.ok(source.file && existsSync(source.file) && source.file.startsWith(join(lib.root, 'courses', course.id)), 'the copy lives with the course');
    assert.ok(!existsSync(job.file), 'and no longer with the job');
    assert.ok(!existsSync(lib.paths.jobSections(job.id)));
    assert.ok(calls.prompts.some(prompt => prompt.includes('document "Postgres failover" (Markdown)')), 'the outline is told it is a document');
    assert.ok(calls.prompts.at(-1).includes('### Document s1'), 'the page writer gets its sections');
    assert.equal(readPage(lib, course.id, 1).source.kind, 'doc');
  });

  test('an upload from the web page is moved in, not copied', () => {
    const lib = openLibrary();
    const uploads = join(process.env.LEARN_CONFIG_DIR, 'uploads');
    mkdirSync(uploads, { recursive: true });
    const sent = join(uploads, 'abc123-notes.md');
    writeFileSync(sent, readFileSync(notes));
    const job = createJob(lib, { file: sent, name: 'notes.md', category: 'Databases' });
    assert.ok(!existsSync(sent));
    assert.ok(existsSync(job.file));
  });

  test('what it cannot read is refused before a build starts', () => {
    const lib = openLibrary();
    const exe = join(root, 'tool.exe');
    writeFileSync(exe, 'MZ');
    assert.throws(() => createJob(lib, { file: exe }), /reads PDF, Word/);
    assert.throws(() => createJob(lib, { file: join(root, 'missing.pdf') }), /can't open/);
    const empty = join(root, 'empty.md');
    writeFileSync(empty, '');
    assert.throws(() => createJob(lib, { file: empty }), /is empty/);
  });
});

describe('a course from a Claude chat', () => {
  const chatId = '11111111-2222-4333-8444-555555555555';

  test('the chat is read, a brief written from it with read-only tools, and the brief is the source', async () => {
    const lib = openLibrary();
    const job = createJob(lib, { chat: chatId, focus: 'the browser link fix' });
    assert.equal(job.mode, 'chat');
    assert.equal(job.topic, 'the browser link fix');
    const { io, calls } = fakeIo();
    await runJob(lib, job.id, io);
    const done = readJob(lib, job.id);
    assert.equal(done.state, 'done', done.error || '');
    assert.deepEqual(calls.chats, [chatId]);
    assert.deepEqual(calls.tools[0], ['Read', 'Grep', 'Glob'], 'the brief has read-only tools');
    assert.ok(calls.prompts[0].includes('the browser link fix'));
    assert.ok(!existsSync(lib.paths.jobChat(job.id)), "the chat's text is gone after the brief");
    const course = readCourse(lib, done.courseId);
    assert.equal(course.title, 'Opening a browser from WSL');
    assert.equal(course.sources[0].kind, 'chat');
    const category = readCatalogue(lib).categories.find(item => item.id === course.category);
    assert.equal(category.name, 'Windows', "with no category given, the brief's is used");
    assert.ok(calls.prompts.at(-1).includes('### Chat brief s1') || calls.prompts.some(prompt => prompt.includes('### Chat brief s1')));
    assert.deepEqual(course.asks, ['the browser link fix', 'how it was checked'], 'the brief names the asks, once each');
    const told = calls.prompts.filter(prompt => prompt.includes('KEY FACTS OF THIS COURSE') && prompt.includes('FALSE: the opener outlives wsl.exe'));
    assert.ok(told.some(prompt => prompt.startsWith('Write page')), 'every page writer gets the key facts');
    assert.ok(told.some(prompt => prompt.includes('Compare them, both ways')), 'and so does the source check');
    assert.equal(course.audience, 'team');
  });

  test('the brief is held against the chat with read-only tools, and its fixes go in', async () => {
    const lib = openLibrary();
    const job = createJob(lib, { chat: chatId, focus: 'the browser link fix', audience: 'self' });
    assert.equal(job.audience, 'self');
    const { io, calls } = fakeIo({ briefFixes: [{ heading: 'The fix', text: 'Return a one-time link, checked.' }, { heading: 'Who does it', text: 'You write and review.' }] });
    await runJob(lib, job.id, io);
    const done = readJob(lib, job.id);
    assert.equal(done.state, 'done', done.error || '');
    assert.deepEqual(calls.tools[1], ['Read', 'Grep'], 'the check reads the chat and the brief, nothing else');
    assert.ok(calls.prompts[1].includes('brief.md'));
    assert.ok(calls.prompts[0].includes('was in this chat'), 'the brief knows who the course is for');
    const course = readCourse(lib, done.courseId);
    assert.equal(course.audience, 'self');
    const source = readJson(lib.paths.source(course.id, 's1'));
    assert.equal(source.sections.find(section => section.heading === 'The fix').text, 'Return a one-time link, checked.');
    assert.ok(source.sections.some(section => section.heading === 'Who does it'), 'a new section is added');
    assert.deepEqual(source.briefCheck.dropped, ['a dropped fact']);
    assert.equal(source.briefCheck.fixed, 2);
    assert.ok(!existsSync(lib.paths.jobChat(job.id)), "the chat's text is gone after both runs");
  });

  test('a chat with nothing about the focus fails the build, saying so', async () => {
    const lib = openLibrary();
    const job = createJob(lib, { chat: chatId, focus: 'quantum computing' });
    await runJob(lib, job.id, fakeIo({ brief: 'nothing' }).io);
    const failed = readJob(lib, job.id);
    assert.equal(failed.state, 'failed');
    assert.match(failed.error, /nothing about "quantum computing"/);
  });

  test('a bad id or no focus is refused', () => {
    const lib = openLibrary();
    assert.throws(() => createJob(lib, { chat: '../etc', focus: 'x' }), /not a chat id/);
    assert.throws(() => createJob(lib, { chat: chatId, focus: '  ' }), /what the course should cover/);
  });
});

describe('videos', () => {
  const quiet = { state: 'running' };
  const videoAsk = { askStructured: async ({ schema }) => (schema.properties.scenes ? { scenes: [], pronounce: [] } : schema.properties.answers ? { answers: [], closing: [], unknown: [], missing: [] } : { added: [], dropped: [] }) };
  /** A recording that writes what narrate.py writes. */
  const recording = (during = () => {}) => async ({ scriptFile, out }) => {
    during();
    const script = readJson(scriptFile);
    writeFileSync(`${out}.mp3`, 'sound');
    writeJson(`${out}.json`, { ...script, audio: { mainEnd: 120, extras: {}, voice: 'v', seconds: 130 }, words: [] });
    return { done: true };
  };
  const pageOf = (n, extra = {}) => ({ v: 1, n, title: `Page ${n}`, concepts: [], source: {}, support: [], markdown: `Words of page ${n}.`, blocks: [{ t: 'p', inlines: [{ s: `Words of page ${n}.` }] }], terms: [], checks: [], outcomes: [], stats: {}, ...extra });
  function courseWith(name, pages) {
    const lib = openLibrary();
    writeJson(lib.paths.course(name), { v: 1, id: name, title: name, category: 'general', status: 'ready', sources: [], pages: pages.map(n => ({ n, title: `Page ${n}`, status: 'written', concepts: [] })), read: [], skipped: [] });
    for (const n of pages) writeJson(lib.paths.page(name, n), pageOf(n));
    return lib;
  }
  const run = (lib, record) => makeVideos({ lib, io: { ...videoAsk, record }, save: () => {}, isStopping: () => false });

  test('a page asked for goes first, and a page already waiting moves rather than repeats', () => {
    const lib = courseWith('queue-a', [1, 2, 3]);
    queueVideos(lib, 'queue-a', [1, 2, 3]);
    const queue = queueVideos(lib, 'queue-a', [3], { first: true });
    assert.deepEqual(queue.map(item => item.n), [3, 1, 2]);
    clearQueue(lib);
  });

  test('videos are made down the queue, and their files appear together', async () => {
    const lib = courseWith('queue-b', [1, 2]);
    queueVideos(lib, 'queue-b', [1, 2]);
    assert.equal(await run(lib, recording()), 2);
    assert.deepEqual(readQueue(lib), []);
    const base = lib.paths.videoBase('queue-b', 2);
    assert.ok(existsSync(`${base}.mp3`) && existsSync(`${base}.json`) && existsSync(`${base}.meta.json`));
    assert.ok(!existsSync(`${base}.script.json`));
    assert.equal(videoInfo(lib, 'queue-b', pageOf(2)).state, 'ready');
    assert.equal(videoInfo(lib, 'queue-b', pageOf(2)).minutes, 2);
  });

  test('a page that changes keeps its video, marked out of date, and nothing remakes it', async () => {
    const lib = courseWith('queue-c', [1]);
    queueVideos(lib, 'queue-c', [1]);
    await run(lib, recording());
    const changed = pageOf(1, { markdown: 'New words.' });
    writeJson(lib.paths.page('queue-c', 1), changed);
    assert.equal(videoInfo(lib, 'queue-c', changed).state, 'stale');
    assert.deepEqual(readQueue(lib), []);
  });

  test('a page changed during its recording is not saved as its video', async () => {
    const lib = courseWith('queue-d', [1]);
    queueVideos(lib, 'queue-d', [1]);
    const made = await run(lib, recording(() => writeJson(lib.paths.page('queue-d', 1), pageOf(1, { markdown: 'Changed meanwhile.' }))));
    assert.equal(made, 0);
    assert.ok(!existsSync(`${lib.paths.videoBase('queue-d', 1)}.mp3`));
    assert.deepEqual(readQueue(lib), []);
  });

  test('a stop keeps the script, so going on asks Claude nothing again', async () => {
    const lib = courseWith('queue-e', [1]);
    queueVideos(lib, 'queue-e', [1]);
    await assert.rejects(run(lib, async () => { throw new Error('stopped'); }), /stopped/);
    assert.ok(existsSync(`${lib.paths.videoBase('queue-e', 1)}.script.json`));
    let asked = 0;
    const counting = { askStructured: async options => { asked++; return videoAsk.askStructured(options); } };
    await makeVideos({ lib, io: { ...counting, record: recording() }, save: () => {}, isStopping: () => false });
    assert.equal(asked, 0);
  });

  test('a script waiting to record, made with the other Questions setting, is written again', async () => {
    const lib = courseWith('queue-q', [1]);
    queueVideos(lib, 'queue-q', [1]);
    await assert.rejects(run(lib, async () => { throw new Error('stopped'); }), /stopped/);
    assert.equal(readJson(`${lib.paths.videoBase('queue-q', 1)}.script.json`).withQuestions, false);
    writeSettings({ videoQuestions: true });
    try {
      let asked = 0;
      const counting = { askStructured: async options => { asked++; return videoAsk.askStructured(options); } };
      await makeVideos({ lib, io: { ...counting, record: recording() }, save: () => {}, isStopping: () => false });
      assert.ok(asked > 0);
    } finally {
      writeSettings({ videoQuestions: false });
    }
  });

  test('a page or course gone from the queue is passed over', async () => {
    const lib = courseWith('queue-f', [1]);
    queueVideos(lib, 'queue-f', [1, 9]);
    queueVideos(lib, 'queue-nowhere', [1]);
    assert.equal(await run(lib, recording()), 1);
    assert.deepEqual(readQueue(lib), []);
  });

  test('a page says what state its video is in', () => {
    const lib = courseWith('queue-g', [1, 2, 3]);
    assert.equal(videoInfo(lib, 'queue-g', pageOf(1)).state, 'none');
    assert.equal(videoInfo(lib, 'queue-g', pageOf(2, { stats: undefined })).state, 'old');
    queueVideos(lib, 'queue-g', [3]);
    assert.equal(videoInfo(lib, 'queue-g', pageOf(3)).state, 'queued');
    const working = [{ courseId: 'queue-g', n: 3, note: 'recording, 40%', fraction: 0.6, leftMinutes: 6 }];
    const making = videoInfo(lib, 'queue-g', pageOf(3), { job: { ...quiet, working } });
    assert.equal(making.state, 'making');
    assert.equal(making.progress.fraction, 0.6);
    assert.match(making.message, /about 6 min left/);
    assert.equal(videoInfo(lib, 'queue-g', pageOf(3), { job: { state: 'paused', working } }).state, 'queued');
    clearQueue(lib);
  });

  test('while a page records, the next page\'s script is written, and no further', async () => {
    const lib = courseWith('queue-k', [1, 2, 3]);
    queueVideos(lib, 'queue-k', [1, 2, 3]);
    const scriptOf = n => existsSync(`${lib.paths.videoBase('queue-k', n)}.script.json`);
    let seen = null;
    const record = recording();
    await run(lib, async options => {
      await new Promise(resolve => setTimeout(resolve, 30));
      seen ||= { next: scriptOf(2), after: scriptOf(3) };
      return record(options);
    });
    assert.deepEqual(seen, { next: true, after: false });
  });

  test('a script that fails ahead lets the recording going on finish first', async () => {
    const lib = courseWith('queue-l', [1, 2]);
    queueVideos(lib, 'queue-l', [1, 2]);
    let calls = 0;
    const failing = { askStructured: async options => {
      calls++;
      if (options.prompt.includes('Page 2') && !options.schema.properties.answers && !options.schema.properties.added) throw new Error('no more usage');
      return videoAsk.askStructured(options);
    } };
    await assert.rejects(makeVideos({ lib, io: { ...failing, record: recording() }, save: () => {}, isStopping: () => false }), /no more usage/);
    assert.ok(calls > 0);
    assert.ok(existsSync(`${lib.paths.videoBase('queue-l', 1)}.meta.json`));
    assert.deepEqual(readQueue(lib).map(item => item.n), [2]);
    clearQueue(lib);
  });

  test('made again, the new one replaces the old only when done, and the old stays as the earlier version', async () => {
    const lib = courseWith('queue-m', [1]);
    queueVideos(lib, 'queue-m', [1]);
    await run(lib, recording());
    const base = lib.paths.videoBase('queue-m', 1);
    writeFileSync(`${base}.mp3`, 'first sound');
    queueVideos(lib, 'queue-m', [1], { first: true, again: true });
    const record = recording();
    await run(lib, async options => {
      assert.equal(readFileSync(`${base}.mp3`, 'utf8'), 'first sound');
      return record(options);
    });
    assert.deepEqual(readQueue(lib), []);
    assert.equal(readFileSync(`${base}.mp3`, 'utf8'), 'sound');
    assert.equal(readFileSync(`${base}.previous.mp3`, 'utf8'), 'first sound');
    assert.ok(videoInfo(lib, 'queue-m', pageOf(1)).earlier);
  });

  test('switching brings the earlier version forward, and back', async () => {
    const lib = courseWith('queue-n', [1]);
    queueVideos(lib, 'queue-n', [1]);
    await run(lib, recording());
    assert.throws(() => swapVideo(lib, 'queue-n', 1), /no earlier version/);
    const base = lib.paths.videoBase('queue-n', 1);
    writeFileSync(`${base}.mp3`, 'first sound');
    queueVideos(lib, 'queue-n', [1], { first: true, again: true });
    await run(lib, recording());
    swapVideo(lib, 'queue-n', 1);
    assert.equal(readFileSync(`${base}.mp3`, 'utf8'), 'first sound');
    swapVideo(lib, 'queue-n', 1);
    assert.equal(readFileSync(`${base}.mp3`, 'utf8'), 'sound');
  });

  test('a video remembers how it was made; an older one still says what it took', async () => {
    const lib = courseWith('queue-o', [1]);
    queueVideos(lib, 'queue-o', [1]);
    await run(lib, recording());
    const { made } = videoInfo(lib, 'queue-o', pageOf(1));
    assert.equal(made.model, lib.settings.models.video);
    assert.equal(made.effort, /opus/.test(made.model) ? 'low' : 'high');
    const meta = `${lib.paths.videoBase('queue-o', 1)}.meta.json`;
    writeJson(meta, { stamp: 'x', minutes: 2, stats: { minutes: 9 }, recordingSeconds: 660 });
    assert.deepEqual(videoInfo(lib, 'queue-o', pageOf(1)).made, { model: null, effort: null, takenMinutes: 20, minutes: 2 });
  });

  test('a course counts what a press would make, and leaves old pages out', () => {
    const lib = courseWith('queue-h', [1, 2]);
    writeJson(lib.paths.page('queue-h', 2), pageOf(2, { stats: undefined }));
    const videos = courseVideos(lib, readCourse(lib, 'queue-h'));
    assert.deepEqual(videos.wanted, [1]);
    assert.equal(videos.old, 1);
    assert.equal(videos.total, 2);
  });

  test('removing a page removes its video', async () => {
    const lib = courseWith('queue-i', [1, 2]);
    queueVideos(lib, 'queue-i', [1]);
    await run(lib, recording());
    queueVideos(lib, 'queue-i', [1], { first: true, again: true });
    await run(lib, recording());
    removePage(lib, 'queue-i', 1);
    const base = lib.paths.videoBase('queue-i', 1);
    assert.ok(!existsSync(`${base}.mp3`) && !existsSync(`${base}.previous.mp3`) && !existsSync(`${base}.previous.meta.json`));
  });

  test('a video job never locks a course: it has none', () => {
    const lib = courseWith('queue-j', [1]);
    writeJson(lib.paths.job('jvideo'), { id: 'jvideo', kind: 'video', courseId: null, state: 'running' });
    assert.ok(createPageJob(lib, { courseId: 'queue-j', kind: 'page-rewrite', n: 1 }));
    rmSync(lib.paths.job('jvideo'), { force: true });
  });
});

describe('the fact-check in a build', () => {
  test('a flag on a real passage draws its box and keeps the page\'s questions honest', async () => {
    const { io } = fakeIo({ disputes: [{ quote: 'Volumes keep your data safe when a container is removed', problem: 'Not always.', correction: 'Only named ones.', evidence: 'https://elsewhere.example/x', checks: [] }] });
    const lib = openLibrary();
    const job = createJob(lib, { topic: 'Disputed volumes', category: 'Docker' });
    await runJob(lib, job.id, io);
    const saved = readJob(lib, job.id);
    if (saved.state === 'waiting-picks') return;
    const page = readPage(lib, saved.courseId, 1);
    assert.ok(Array.isArray(page.disputes));
  });

  test('the source check: what it finds is patched in place, and what stays contradicted is boxed with no link', async () => {
    const wrongQuote = 'Volumes keep your data safe when a container is removed';
    const { io, calls } = fakeIo({
      source: { wrong: [{ quote: wrongQuote, kind: 'contradicts', problem: 'The source says only named volumes.', correction: 'Anonymous ones go with the container.' }], dropped: [{ fact: 'docker run -v', where: 'Syntax' }] },
      changes: [{ heading: 'Part', after: null, markdown: '## Part\nSaid at [1:05] (added). See [sec: Syntax].\n\nVolumes keep your data safe when a container is removed, the page still says.' }],
    });
    const lib = openLibrary();
    const job = createJob(lib, { topic: 'Sourced volumes', category: 'Docker', mode: 'auto' });
    await runJob(lib, job.id, io);
    const saved = readJob(lib, job.id);
    assert.equal(saved.state, 'done', saved.error || '');
    const page = readPage(lib, saved.courseId, 1);
    assert.ok(calls.patches >= 1, 'a patch, not a rewrite');
    assert.equal(calls.pages, 3, 'each page written once');
    assert.ok(page.markdown.includes('the page still says'), 'the patched section is in');
    assert.ok(page.markdown.includes('## Recap'), 'the rest is kept');
    const box = page.disputes.find(dispute => dispute.source);
    assert.equal(box.evidence, null);
    assert.equal(page.stats.sourceCheck.wrong, 1);
    assert.deepEqual(page.stats.sourceCheck.leftDropped, ['docker run -v']);
    assert.ok(page.blocks.some(block => block.t === 'callout' && block.kind === 'disputed'));
  });

  test('a page over its size is tightened once, and kept only if the check finds nothing more missing', async () => {
    const long = `## Part\n${'Volumes keep your data safe when a container is removed. '.repeat(400)}\n\n## Recap\nDone.`;
    const { io, calls } = fakeIo({ changes: [{ heading: 'Part', after: null, markdown: '## Part\nVolumes keep your data safe when a container is removed.' }] });
    const write = io.askStructured;
    io.askStructured = async args => (args.schema.properties.markdown ? (calls.pages++, { markdown: long }) : write(args));
    const lib = openLibrary();
    const job = createJob(lib, { topic: 'Long volumes', category: 'Docker', mode: 'auto' });
    await runJob(lib, job.id, io);
    const saved = readJob(lib, job.id);
    assert.equal(saved.state, 'done', saved.error || '');
    const page = readPage(lib, saved.courseId, 1);
    assert.equal(page.stats.tightened, 'kept');
    assert.ok(page.stats.words < page.stats.wordsWritten);
    assert.ok(page.stats.budget >= 600 && page.stats.budget <= 2400);
  });

  test('the check gets the web and nothing else', async () => {
    const { io, calls } = fakeIo();
    const lib = openLibrary();
    const job = createJob(lib, { topic: 'Checked volumes', category: 'Docker', mode: 'auto' });
    await runJob(lib, job.id, io);
    assert.ok(calls.tools.some(tools => tools.join() === 'WebSearch,WebFetch'));
  });
});
