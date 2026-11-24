// An explainer on the wiki (learn/wiki.mjs): where it goes, how one too big is split, what is sent,
// and that nothing is sent that wasn't asked for. The wiki itself is played by the test.
// node --test learn/tests/
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'learn-wiki-'));
process.env.LEARN_LIBRARY = join(root, 'library');
process.env.LEARN_CONFIG_DIR = join(root, 'config');
process.env.LEARN_EXPORT_DIR = join(root, 'out');
// A key of yours never reaches this: nothing here may be sent anywhere.
for (const name of ['WIKI_API_KEY', 'WIKI_API_URL', 'WIKI_WEB_URL']) delete process.env[name];
globalThis.fetch = async () => assert.fail('a real request');
after(() => rmSync(root, { recursive: true, force: true }));

const { explainPaths, readExplainer, saveExplainer, updateExplainer } = await import('../explain.mjs');
const { runExplainJob, startExplainer } = await import('../explain-job.mjs');
const { explainerHtml } = await import('../export.mjs');
const { readJob, saveJob } = await import('../jobs.mjs');
const { normalizeSettings, readSettings, SETTINGS_FILE } = await import('../settings.mjs');
const { buildStatus, openLibrary } = await import('../status.mjs');
const { isOnWiki, MAX_PAGE, packParts, sendToWiki, wikiCommand, wikiPages, wikiPath } = await import('../wiki.mjs');

const lib = openLibrary();
const KEY = 'kwk_not-a-real-key';
const env = { WIKI_API_KEY: KEY };
const clip = (title, level = 1) => ({ title, level, facts: [], anchors: [], guess: { q: '', options: [], quote: '' }, failure: [] });
const video = n => ({ title: `Clip ${n}`, sections: [], scenes: [], assets: {}, quiz: [], words: [], audio: { mainEnd: 1 } });
const explainerOf = (title, clips, patch = {}) => saveExplainer(lib, { title, session: 'secret-session', cwd: root, depth: 2, at: 1, createdAt: new Date().toISOString(), map: { shape: 'none', boxes: [], clips: [] }, clips, ...patch });
function made(explainer, n, bytes = 300) {
  const base = explainPaths(lib, explainer.id).clip(n);
  mkdirSync(join(explainPaths(lib, explainer.id).dir, 'clips'), { recursive: true });
  writeFileSync(`${base}.json`, JSON.stringify(video(n)));
  writeFileSync(`${base}.mp3`, Buffer.alloc(bytes, n));
}
/** A limit that takes `count` clips of 90,000 bytes of sound (120,000 as text) to a page. */
const room = (explainer, count) => Buffer.byteLength(explainerHtml({ explainer, clips: [] })) + 2000 + count * 125_000;
/** A wiki that answers with `answers` in turn (the last one again), and keeps what it was sent. */
function wiki(...answers) {
  const sent = [];
  const fetch = async (url, init) => {
    const fields = Object.fromEntries([...init.body.entries()].filter(([, value]) => typeof value === 'string'));
    sent.push({ url, auth: init.headers.authorization, fields, name: init.body.get('file').name, page: await init.body.get('file').text() });
    const answer = answers[Math.min(sent.length, answers.length) - 1] ?? { node: { id: 'n1', slug: 'tokens', shortId: `s${sent.length}` } };
    if (answer instanceof Error) throw answer;
    const { status = 200, ...body } = answer;
    return new Response(JSON.stringify(body), { status });
  };
  return { sent, fetch };
}
const infoOf = page => JSON.parse(/<script type="application\/json" id="explainer-data">(.*?)<\/script>/s.exec(page)[1]).info;

describe('where it goes, and in how many pages', () => {
  test('its path is the same each time: the title, then the id’s last 4, in one folder', () => {
    const explainer = { id: 'x202611240900abcd', title: 'How tokens/keys move…' };
    assert.equal(wikiPath(explainer), 'Explainers/how-tokens-keys-move-abcd.html');
    assert.equal(wikiPath(explainer, 2), 'Explainers/how-tokens-keys-move-abcd-part-2.html');
  });

  test('clips are packed in order, as many to a part as fit; one too big for any has its own', () => {
    const sizes = (...bytes) => bytes.map((size, k) => ({ n: k + 1, bytes: size }));
    assert.deepEqual(packParts(sizes(4, 4, 4, 4, 4), 10), [[1, 2], [3, 4], [5]]);
    assert.deepEqual(packParts(sizes(10, 10), 10), [[1], [2]]);
    assert.deepEqual(packParts(sizes(3, 50, 3, 3), 10), [[1], [2], [3, 4]]);
    assert.deepEqual(packParts([], 10), []);
  });

  test('one page when it fits, the same one the file is', () => {
    const explainer = explainerOf('Small', [clip('One'), clip('Two', 2)]);
    const clips = [1, 2].map(n => ({ n, video: video(n), sound: Buffer.alloc(300, n) }));
    const pages = wikiPages({ explainer, clips });
    assert.equal(pages.length, 1);
    assert.equal(pages[0].path, wikiPath(explainer));
    assert.equal(pages[0].page, explainerHtml({ explainer, clips }));
    assert.deepEqual(infoOf(pages[0].page).clips.map(c => [c.state, c.part]), [['ready', undefined], ['ready', undefined]]);
    assert.ok(MAX_PAGE < 5_000_000, 'under what the wiki takes');
  });

  test('over the limit it goes in parts: each within it, each clip in one, and the others named by their part', () => {
    const explainer = explainerOf('Big', [clip('One'), clip('Two', 2), clip('Three', 2), clip('Past the depth', 3)]);
    const clips = [1, 2, 3].map(n => ({ n, video: video(n), sound: Buffer.alloc(90_000, n) }));
    const max = room(explainer, 2);
    const pages = wikiPages({ explainer, clips, max });
    assert.equal(pages.length, 2);
    for (const { page } of pages) assert.ok(Buffer.byteLength(page) <= max, `${Buffer.byteLength(page)} of ${max} bytes`);
    assert.deepEqual(pages.map(page => page.path), [wikiPath(explainer, 1), wikiPath(explainer, 2)]);
    const infos = pages.map(page => infoOf(page.page));
    assert.deepEqual(infos[0].clips.map(c => [c.state, c.part]), [['ready', undefined], ['ready', undefined], ['later', 2], ['left out', undefined]]);
    assert.deepEqual(infos[1].clips.map(c => [c.state, c.part]), [['later', 1], ['later', 1], ['ready', undefined], ['left out', undefined]]);
    assert.deepEqual(infos.map(info => info.depth), [2, 2]);
    assert.match(pages[1].page, /<title>Big \(part 2 of 2\)<\/title>/);
    assert.doesNotMatch(pages.map(page => page.page).join(''), /secret-session/);
  });

  test('a part whose own clips are all of the first level is still as deep as the whole', () => {
    const explainer = explainerOf('Levels', [clip('One'), clip('Two', 3)], { depth: null });
    const clips = [1, 2].map(n => ({ n, video: video(n), sound: Buffer.alloc(90_000, n) }));
    const pages = wikiPages({ explainer, clips, max: room(explainer, 1) });
    assert.deepEqual(pages.map(page => infoOf(page.page).depth), [3, 3]);
  });
});

describe('sending it', () => {
  test('one upload, as the wiki wants it: the workspace, the path, its own mode, the file, the key', async () => {
    const explainer = explainerOf('Sent', [clip('One')], { wiki: { to: 'personal' } });
    made(explainer, 1);
    const { sent, fetch } = wiki({ node: { id: 'n1', slug: 'sent', shortId: 'Ab3' } });
    const done = await sendToWiki(lib, explainer.id, { env, fetch });
    assert.deepEqual(done, { to: 'personal', urls: ['https://wiki.keops.ai/d/sent-Ab3'], error: null });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].url, 'https://wiki-api.keops.ai/api/docs/push');
    assert.equal(sent[0].auth, `Bearer ${KEY}`);
    assert.deepEqual(sent[0].fields, { workspace: 'personal', path: wikiPath(explainer), renderMode: 'standalone', message: 'Clips made by /explain' });
    assert.equal(sent[0].name, wikiPath(explainer).split('/').at(-1));
    assert.doesNotMatch(sent[0].page, /secret-session|kwk_/, 'neither the chat nor the key is in the page');
    assert.equal(isOnWiki(readExplainer(lib, explainer.id)), true);
    assert.doesNotMatch(readFileSync(explainPaths(lib, explainer.id).file, 'utf8'), /kwk_/, 'nor is the key kept');
  });

  test('never one that was not asked for, nor one whose clips are not all made', async () => {
    const { sent, fetch } = wiki();
    const plain = explainerOf('Not asked', [clip('One')]);
    made(plain, 1);
    assert.equal(await sendToWiki(lib, plain.id, { env, fetch }), null);
    const odd = explainerOf('Odd place', [clip('One')], { wiki: { to: 'everyone' } });
    made(odd, 1);
    assert.equal(await sendToWiki(lib, odd.id, { env, fetch }), null);
    const part = explainerOf('Half made', [clip('One'), clip('Two', 2)], { wiki: { to: 'shared' } });
    made(part, 1);
    assert.match((await sendToWiki(lib, part.id, { env, fetch })).error, /not all made/);
    assert.equal(sent.length, 0);
  });

  test('what goes wrong is kept in plain words, never thrown, and never names the key', async () => {
    const explainer = explainerOf('Refused', [clip('One')], { wiki: { to: 'shared' } });
    made(explainer, 1);
    const send = async (answers, options = {}) => (await sendToWiki(lib, explainer.id, { env, retryMs: 0, fetch: wiki(...answers).fetch, ...options })).error;
    assert.match(await send([], { env: {} }), /WIKI_API_KEY isn't set/);
    assert.match(await send([{ status: 401 }]), /refused WIKI_API_KEY/);
    assert.match(await send([{ status: 400, message: 'File exceeds 5MB limit' }]), /400: File exceeds 5MB limit/);
    assert.match(await send([Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } })]), /couldn't reach the wiki \(ENOTFOUND\)/);
    assert.match(await send([{ node: { id: '../evil path' } }]), /didn't say where/);
    const kept = readExplainer(lib, explainer.id);
    assert.equal(kept.wiki.to, 'shared');
    assert.equal(isOnWiki(kept), false);
    assert.doesNotMatch(JSON.stringify(kept.wiki), /kwk_/);
  });

  test('a network slip, or the wiki’s own trouble, is tried once more; a refusal is not', async () => {
    const explainer = explainerOf('Retried', [clip('One')], { wiki: { to: 'personal' } });
    made(explainer, 1);
    const ok = { node: { id: 'n1', slug: null, shortId: null } };
    const slip = wiki(new TypeError('fetch failed'), ok);
    assert.deepEqual((await sendToWiki(lib, explainer.id, { env, fetch: slip.fetch, retryMs: 0 })).urls, ['https://wiki.keops.ai/d/n1']);
    assert.equal(slip.sent.length, 2);
    const trouble = wiki({ status: 503 }, ok);
    assert.equal((await sendToWiki(lib, explainer.id, { env, fetch: trouble.fetch, retryMs: 0 })).error, null);
    const refused = wiki({ status: 403, message: 'no' }, ok);
    assert.match((await sendToWiki(lib, explainer.id, { env, fetch: refused.fetch, retryMs: 0 })).error, /403/);
    assert.equal(refused.sent.length, 1);
  });

  test('in parts, each is sent; one that fails is said, and the ones before it are kept', async () => {
    const explainer = explainerOf('Parts', [clip('One'), clip('Two', 2)], { wiki: { to: 'shared' } });
    made(explainer, 1, 90_000);
    made(explainer, 2, 90_000);
    const { sent, fetch } = wiki({ node: { id: 'p1' } }, { status: 400, message: 'no' });
    const done = await sendToWiki(lib, explainer.id, { env, fetch, max: room(explainer, 1), retryMs: 0 });
    assert.deepEqual(sent.map(one => one.fields.path), [wikiPath(explainer, 1), wikiPath(explainer, 2)]);
    assert.deepEqual(done.urls, ['https://wiki.keops.ai/d/p1']);
    assert.match(done.error, /400/);
    assert.equal(isOnWiki(readExplainer(lib, explainer.id)), false);
  });

  test('stopped half way, it ends there and says so', async () => {
    const explainer = explainerOf('Stopped', [clip('One')], { wiki: { to: 'personal' } });
    made(explainer, 1);
    const stop = new AbortController();
    const fetch = (_, init) => new Promise((_done, fail) => init.signal.addEventListener('abort', () => fail(init.signal.reason)));
    const sending = sendToWiki(lib, explainer.id, { env, fetch, signal: stop.signal });
    setTimeout(() => stop.abort(), 20);
    assert.equal((await sending).error, 'stopped');
  });

  test('another wiki, as wiki-push has it: WIKI_API_URL and WIKI_WEB_URL', async () => {
    const explainer = explainerOf('Elsewhere', [clip('One')], { wiki: { to: 'personal' } });
    made(explainer, 1);
    const { sent, fetch } = wiki({ node: { id: 'n9' } });
    const done = await sendToWiki(lib, explainer.id, { env: { ...env, WIKI_API_URL: 'http://localhost:4014/', WIKI_WEB_URL: 'http://localhost:3014/' }, fetch });
    assert.equal(sent[0].url, 'http://localhost:4014/api/docs/push');
    assert.deepEqual(done.urls, ['http://localhost:3014/d/n9']);
  });
});

describe('/clips wiki', () => {
  test('one that failed is sent again over your last version; one already there only says where', async () => {
    const explainer = explainerOf('Again', [clip('One')], { wiki: { to: 'personal', urls: [], error: "couldn't reach the wiki" } });
    made(explainer, 1);
    const { sent, fetch } = wiki({ node: { id: 'n1' } });
    const first = await wikiCommand(lib, explainer.id, { env, fetch });
    assert.deepEqual([first.found, first.to, first.urls, first.error], [true, 'personal', ['https://wiki.keops.ai/d/n1'], null]);
    assert.equal(sent[0].fields.amend, 'true');
    const second = await wikiCommand(lib, explainer.id, { env, fetch });
    assert.deepEqual(second.urls, ['https://wiki.keops.ai/d/n1']);
    assert.equal(sent.length, 1, 'nothing sent twice');
  });

  test('one that was not asked onto the wiki is never sent by it; one still being made waits', async () => {
    const { sent, fetch } = wiki();
    const plain = explainerOf('Plain', [clip('One')]);
    made(plain, 1);
    const answer = await wikiCommand(lib, plain.id, { env, fetch });
    assert.deepEqual([answer.found, answer.to, answer.urls], [true, null, []]);
    const half = explainerOf('Half', [clip('One'), clip('Two', 2)], { wiki: { to: 'shared' } });
    made(half, 1);
    const waits = await wikiCommand(lib, half.id, { env, fetch });
    assert.deepEqual([waits.waiting, waits.ready, waits.clips], [true, 1, 2]);
    assert.deepEqual(await wikiCommand(lib, 'x000000000000', { env, fetch }), { found: false });
    assert.equal(sent.length, 0);
  });

  test('off and on are the question’s setting; anything else on disk reads as asking', async () => {
    assert.deepEqual(await wikiCommand(lib, 'off'), { asking: false });
    assert.equal(readSettings().wiki, 'off');
    assert.equal(JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')).wiki, 'off', 'where the hook reads it');
    assert.deepEqual(await wikiCommand(lib, 'on'), { asking: true });
    assert.equal(normalizeSettings({ wiki: 'nope' }).wiki, 'ask');
    assert.equal(normalizeSettings({}).wiki, 'ask');
  });
});

describe("an explainer's job and the wiki", () => {
  const job = (id, explainer) => saveJob(lib, { v: 1, id, kind: 'explain', explain: explainer.id, state: 'running', step: 'clips', done: 0, total: 2, pid: null, startedAt: new Date().toISOString() });

  test('once, when every clip is made, and told with the last: until then the job is not all done', async () => {
    const explainer = explainerOf('Job', [clip('One'), clip('Two', 2)], { wiki: { to: 'personal' } });
    made(explainer, 1);
    made(explainer, 2);
    job('j202611240000aa01', explainer);
    const calls = [];
    const send = async (_, id) => {
      const now = readJob(lib, 'j202611240000aa01');
      calls.push([id, now.state, now.message, now.done]);
      return { to: 'personal', urls: ['https://wiki.keops.ai/d/n1'], error: null };
    };
    const done = await runExplainJob(lib, 'j202611240000aa01', { sendToWiki: send });
    assert.deepEqual(calls, [[explainer.id, 'running', 'Putting it on the wiki', 0]]);
    assert.deepEqual([done.state, done.done, done.total, done.message], ['done', 2, 2, '2 clips ready, and on the wiki']);
    assert.deepEqual(buildStatus(done).wiki, { to: 'personal', urls: ['https://wiki.keops.ai/d/n1'], error: null });
    assert.equal(buildStatus({ ...done, kind: 'video' }).wiki, null);
  });

  test('a failed upload ends nothing: the clips are ready, and it says why', async () => {
    const explainer = explainerOf('Job failed', [clip('One')], { depth: 1, wiki: { to: 'shared' } });
    made(explainer, 1);
    job('j202611240000aa02', explainer);
    const done = await runExplainJob(lib, 'j202611240000aa02', { sendToWiki: async () => ({ to: 'shared', urls: [], error: 'no' }) });
    assert.deepEqual([done.state, done.message, done.error, done.wiki.error], ['done', 'Your clip is ready; not on the wiki', null, 'no']);
  });

  test('not asked for, or there already: nothing is sent', async () => {
    const send = async () => assert.fail('sent');
    const plain = explainerOf('Job plain', [clip('One')], { depth: 1 });
    made(plain, 1);
    job('j202611240000aa03', plain);
    assert.equal((await runExplainJob(lib, 'j202611240000aa03', { sendToWiki: send })).wiki, null);
    const there = explainerOf('Job there', [clip('One')], { depth: 1, wiki: { to: 'personal', urls: ['https://wiki.keops.ai/d/n1'], error: null } });
    made(there, 1);
    job('j202611240000aa04', there);
    assert.deepEqual((await runExplainJob(lib, 'j202611240000aa04', { sendToWiki: send })).wiki.urls, ['https://wiki.keops.ai/d/n1']);
  });

  test('the workspace is kept on the explainer it was picked for, and only a workspace is', async () => {
    const plan = {
      title: 'Kept', shape: 'none', boxes: [], depth: 1,
      clips: [{ title: 'One', box: null, level: 1, facts: [{ text: 'The gateway mints the token.', basis: 'code' }], anchors: [{ file: 'a.js', from: 1, to: 1, expect: 'mint' }], guess: { q: 'Which?', options: [{ text: 'a', why: 'w', right: true }, { text: 'b', why: 'w', right: false }, { text: 'c', why: 'w', right: false }], quote: 'gateway mints the token' } }],
    };
    const cwd = join(root, 'project');
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(cwd, 'a.js'), 'mint(user)\n');
    const start = wikiTo => startExplainer(lib, { plan, sessionId: '0b6c8f8e-1f6e-4b0e-9a55-3c1d2e4f5a6b', cwd, wiki: wikiTo, io: { askStructured: async () => ({ wrong: [] }) }, job: () => ({ id: 'j1' }) });
    const picked = await start('shared');
    assert.equal(picked.wiki, 'shared');
    assert.deepEqual(readExplainer(lib, picked.id).wiki, { to: 'shared' });
    for (const other of [undefined, null, 'public', true]) {
      const plain = await start(other);
      assert.equal(plain.wiki, null);
      assert.equal(readExplainer(lib, plain.id).wiki, null);
    }
    updateExplainer(lib, picked.id, () => ({ at: 1 }));
    assert.deepEqual(readExplainer(lib, picked.id).wiki, { to: 'shared' }, 'kept through other changes');
  });
});
