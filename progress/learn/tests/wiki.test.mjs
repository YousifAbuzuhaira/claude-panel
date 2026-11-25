// An explainer on the wiki (learn/wiki.mjs): its folder and its docs, one a clip, what is sent, and
// that nothing is sent that wasn't asked for. The wiki itself is played by the test.
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
const { isOnWiki, sendToWiki, wikiCommand, wikiFolder, wikiPages, wikiPlace } = await import('../wiki.mjs');

const lib = openLibrary();
const KEY = 'kwk_not-a-real-key';
const env = { WIKI_API_KEY: KEY };
const clip = (title, level = 1) => ({ title, level, facts: [], anchors: [], guess: { q: '', options: [], quote: '' }, failure: [] });
const video = n => ({ title: `Clip ${n}`, sections: [], scenes: [], assets: {}, quiz: [], words: [], audio: { mainEnd: 1 } });
const explainerOf = (title, clips, patch = {}) => saveExplainer(lib, { title, session: 'secret-session', cwd: root, depth: 2, at: 1, createdAt: new Date().toISOString(), map: { shape: 'none', boxes: [], clips: [] }, clips, ...patch });
function made(explainer, n) {
  const base = explainPaths(lib, explainer.id).clip(n);
  mkdirSync(join(explainPaths(lib, explainer.id).dir, 'clips'), { recursive: true });
  writeFileSync(`${base}.json`, JSON.stringify(video(n)));
  writeFileSync(`${base}.mp3`, Buffer.alloc(300, n));
}
/**
 * A wiki that answers uploads with `answers` in turn (the last one again), and keeps what it was
 * sent. `looked` is each path it was asked about; it has the ones in `there`.
 */
function wiki(answers = [], there = []) {
  const sent = [];
  const looked = [];
  const fetch = async (url, init) => {
    assert.equal(init.headers.authorization, `Bearer ${KEY}`);
    if (init.method === 'GET') {
      const query = new URL(url).searchParams;
      looked.push(`${query.get('workspace')}:${query.get('path')}`);
      return new Response('{}', { status: there.includes(query.get('path')) ? 400 : 404 });
    }
    const fields = Object.fromEntries([...init.body.entries()].filter(([, value]) => typeof value === 'string'));
    sent.push({ url, fields, name: init.body.get('file').name, page: await init.body.get('file').text() });
    const answer = answers[Math.min(sent.length, answers.length) - 1] ?? { node: { id: 'n1', slug: 'doc', shortId: `s${sent.length}` } };
    if (answer instanceof Error) throw answer;
    const { status = 200, ...body } = answer;
    return new Response(JSON.stringify(body), { status });
  };
  return { sent, looked, fetch };
}
const infoOf = page => JSON.parse(/<script type="application\/json" id="explainer-data">(.*?)<\/script>/s.exec(page)[1]).info;
const holds = page => [...page.matchAll(/id="clip-(\d+)"/g)].map(match => Number(match[1]));

describe('its folder, and its docs', () => {
  test('a folder named after it in Explainers, or inside the folder you named; taken, its id tells it apart', () => {
    const explainer = { id: 'x202611240900abcd', title: 'How tokens/keys  move.' };
    assert.equal(wikiPlace(explainer), 'Explainers/How tokens keys move');
    assert.equal(wikiPlace({ ...explainer, wiki: { folder: 'Auth' } }), 'Explainers/Auth/How tokens keys move');
    assert.equal(wikiPlace(explainer, true), 'Explainers/How tokens keys move abcd');
    assert.equal(wikiPlace({ id: 'x1', title: '...' }), 'Explainers/Explainer');
  });

  test('the folder you named, tidied: no way out of Explainers, no slashes of its own, at most 3 deep', () => {
    assert.equal(wikiFolder(' Auth '), 'Auth');
    assert.equal(wikiFolder('Auth/Sessions'), 'Auth/Sessions');
    assert.equal(wikiFolder('Explainers/Auth'), 'Auth');
    assert.equal(wikiFolder('../../Finance'), 'Finance');
    assert.equal(wikiFolder('a/b\\c/d/e'), 'a/b/c');
    for (const none of [undefined, null, '', ' / ', '..', 5, true]) assert.equal(wikiFolder(none), null);
    assert.equal(wikiFolder('x'.repeat(300)).length, 80);
  });

  test('a page a clip, numbered as they play, each holding its own clip and the paths of the others', () => {
    const explainer = explainerOf('Tokens', [clip('The gateway'), clip('The refresh', 2), clip('Past the depth', 3)], { wiki: { to: 'shared' } });
    const clips = [1, 2].map(n => ({ n, video: video(n), sound: Buffer.alloc(300, n) }));
    const pages = wikiPages({ explainer, clips, place: 'Explainers/Tokens' });
    assert.deepEqual(pages.map(page => page.path), ['Explainers/Tokens/01-the-gateway.html', 'Explainers/Tokens/02-the-refresh.html']);
    assert.deepEqual(pages.map(page => holds(page.page)), [[1], [2]]);
    const infos = pages.map(page => infoOf(page.page));
    assert.deepEqual(infos[0].clips.map(c => [c.state, c.path]), [['ready', undefined], ['ready', 'Explainers/Tokens/02-the-refresh.html'], ['left out', undefined]]);
    assert.deepEqual(infos[1].clips.map(c => [c.state, c.path]), [['ready', 'Explainers/Tokens/01-the-gateway.html'], ['ready', undefined], ['left out', undefined]]);
    assert.deepEqual(infos.map(info => info.workspace), ['shared', 'shared']);
    assert.match(pages[1].page, /<title>The refresh · Tokens<\/title>/);
    assert.doesNotMatch(pages.map(page => page.page).join(''), /secret-session/);
  });

  test('a page is as deep as the whole, whatever its own clip; a title with no letters still has a name', () => {
    const explainer = explainerOf('Levels', [clip('One'), clip('…', 3)], { depth: null, wiki: { to: 'personal' } });
    const clips = [1, 2].map(n => ({ n, video: video(n), sound: Buffer.alloc(300, n) }));
    const pages = wikiPages({ explainer, clips, place: 'Explainers/Levels' });
    assert.deepEqual(pages.map(page => infoOf(page.page).depth), [3, 3]);
    assert.equal(pages[1].path, 'Explainers/Levels/02-clip.html');
  });

  test('the file you pass on is as it was: every clip in it, no workspace and no paths', () => {
    const explainer = explainerOf('File', [clip('One'), clip('Two', 2)], { wiki: { to: 'shared', place: 'Explainers/File' } });
    const page = explainerHtml({ explainer, clips: [1, 2].map(n => ({ n, video: video(n), sound: Buffer.alloc(300, n) })) });
    assert.deepEqual(holds(page), [1, 2]);
    assert.equal(infoOf(page).workspace, undefined);
    assert.doesNotMatch(page, /Explainers\/File/);
    assert.match(page, /<title>File<\/title>/);
  });
});

describe('sending it', () => {
  test('one upload a clip, as the wiki wants it, the last clip first; where they are is kept in order', async () => {
    const explainer = explainerOf('Sent', [clip('One'), clip('Two', 2)], { wiki: { to: 'personal', folder: 'Auth' } });
    made(explainer, 1);
    made(explainer, 2);
    const { sent, looked, fetch } = wiki([{ node: { id: 'n2', slug: '02-two', shortId: 'B' } }, { node: { id: 'n1', slug: '01-one', shortId: 'A' } }]);
    const done = await sendToWiki(lib, explainer.id, { env, fetch });
    assert.deepEqual(done, { to: 'personal', place: 'Explainers/Auth/Sent', urls: ['https://wiki.keops.ai/d/01-one-A', 'https://wiki.keops.ai/d/02-two-B'], error: null });
    assert.deepEqual(looked, ['personal:Explainers/Auth/Sent']);
    assert.deepEqual(sent.map(one => one.url), Array(2).fill('https://wiki-api.keops.ai/api/docs/push'));
    assert.deepEqual(sent.map(one => one.fields), ['02-two', '01-one'].map(name => ({ workspace: 'personal', path: `Explainers/Auth/Sent/${name}.html`, renderMode: 'standalone', message: 'Clips made by /explain' })));
    assert.deepEqual(sent.map(one => one.name), ['02-two.html', '01-one.html']);
    assert.doesNotMatch(sent.map(one => one.page).join(''), /secret-session|kwk_/, 'neither the chat nor the key is in a page');
    assert.equal(isOnWiki(readExplainer(lib, explainer.id)), true);
    assert.doesNotMatch(readFileSync(explainPaths(lib, explainer.id).file, 'utf8'), /kwk_/, 'nor is the key kept');
  });

  test("a folder of that name that's already there is never written into: its own is made beside it", async () => {
    const explainer = explainerOf('Taken', [clip('One')], { wiki: { to: 'shared' } });
    made(explainer, 1);
    const { sent, fetch } = wiki([], ['Explainers/Taken']);
    const done = await sendToWiki(lib, explainer.id, { env, fetch });
    assert.equal(done.place, `Explainers/Taken ${explainer.id.slice(-4)}`);
    assert.equal(sent[0].fields.path, `Explainers/Taken ${explainer.id.slice(-4)}/01-one.html`);
  });

  test('never one that was not asked for, nor one whose clips are not all made', async () => {
    const { sent, looked, fetch } = wiki();
    const plain = explainerOf('Not asked', [clip('One')]);
    made(plain, 1);
    assert.equal(await sendToWiki(lib, plain.id, { env, fetch }), null);
    const odd = explainerOf('Odd place', [clip('One')], { wiki: { to: 'everyone' } });
    made(odd, 1);
    assert.equal(await sendToWiki(lib, odd.id, { env, fetch }), null);
    const part = explainerOf('Half made', [clip('One'), clip('Two', 2)], { wiki: { to: 'shared' } });
    made(part, 1);
    assert.match((await sendToWiki(lib, part.id, { env, fetch })).error, /not all made/);
    assert.deepEqual([sent.length, looked.length], [0, 0]);
  });

  test('what goes wrong is kept in plain words, never thrown, and never names the key', async () => {
    const explainer = explainerOf('Refused', [clip('One')], { wiki: { to: 'shared' } });
    made(explainer, 1);
    const send = async (answers, options = {}) => (await sendToWiki(lib, explainer.id, { env, retryMs: 0, fetch: wiki(answers).fetch, ...options })).error;
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

  test("the wiki's answer about the folder is believed only when it's one: no folder is guessed at", async () => {
    const explainer = explainerOf('Unsure', [clip('One')], { wiki: { to: 'shared' } });
    made(explainer, 1);
    const answering = status => ({ env, retryMs: 0, fetch: async (_, init) => (init.method === 'GET' ? new Response('{}', { status }) : assert.fail('sent')) });
    assert.match((await sendToWiki(lib, explainer.id, answering(503))).error, /503/);
    assert.match((await sendToWiki(lib, explainer.id, answering(403))).error, /403/);
    assert.match((await sendToWiki(lib, explainer.id, answering(401))).error, /refused WIKI_API_KEY/);
    assert.equal(readExplainer(lib, explainer.id).wiki.place, undefined);
  });

  test('a network slip, or the wiki’s own trouble, is tried once more; a refusal is not', async () => {
    const explainer = explainerOf('Retried', [clip('One')], { wiki: { to: 'personal' } });
    made(explainer, 1);
    const ok = { node: { id: 'n1', slug: null, shortId: null } };
    const slip = wiki([new TypeError('fetch failed'), ok]);
    assert.deepEqual((await sendToWiki(lib, explainer.id, { env, fetch: slip.fetch, retryMs: 0 })).urls, ['https://wiki.keops.ai/d/n1']);
    assert.equal(slip.sent.length, 2);
    const trouble = wiki([{ status: 503 }, ok]);
    assert.equal((await sendToWiki(lib, explainer.id, { env, fetch: trouble.fetch, retryMs: 0 })).error, null);
    const refused = wiki([{ status: 403, message: 'no' }, ok]);
    assert.match((await sendToWiki(lib, explainer.id, { env, fetch: refused.fetch, retryMs: 0 })).error, /403/);
    assert.equal(refused.sent.length, 1);
  });

  test('one that fails half way is said, and sent again it goes to the same folder', async () => {
    const explainer = explainerOf('Half sent', [clip('One'), clip('Two', 2)], { wiki: { to: 'shared' } });
    made(explainer, 1);
    made(explainer, 2);
    const first = wiki([{ node: { id: 'p2' } }, { status: 400, message: 'no' }]);
    const done = await sendToWiki(lib, explainer.id, { env, fetch: first.fetch, retryMs: 0 });
    assert.deepEqual(first.sent.map(one => one.name), ['02-two.html', '01-one.html']);
    assert.match(done.error, /400/);
    assert.equal(isOnWiki(readExplainer(lib, explainer.id)), false);
    const again = wiki([], ['Explainers/Half sent']);
    const second = await sendToWiki(lib, explainer.id, { env, fetch: again.fetch, amend: true });
    assert.deepEqual([second.place, second.error, again.looked], ['Explainers/Half sent', null, []], 'its own folder, not asked about again');
    assert.deepEqual(again.sent.map(one => one.fields.amend), ['true', 'true']);
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
    const { sent, fetch } = wiki([{ node: { id: 'n9' } }]);
    const done = await sendToWiki(lib, explainer.id, { env: { ...env, WIKI_API_URL: 'http://localhost:4014/', WIKI_WEB_URL: 'http://localhost:3014/' }, fetch });
    assert.equal(sent[0].url, 'http://localhost:4014/api/docs/push');
    assert.deepEqual(done.urls, ['http://localhost:3014/d/n9']);
  });
});

describe('/clips wiki', () => {
  test('one that failed is sent again over your last version; one already there only says where', async () => {
    const explainer = explainerOf('Again', [clip('One')], { wiki: { to: 'personal', place: 'Explainers/Again', urls: [], error: "couldn't reach the wiki" } });
    made(explainer, 1);
    const { sent, fetch } = wiki([{ node: { id: 'n1' } }]);
    const first = await wikiCommand(lib, explainer.id, { env, fetch });
    assert.deepEqual([first.found, first.to, first.place, first.urls, first.error], [true, 'personal', 'Explainers/Again', ['https://wiki.keops.ai/d/n1'], null]);
    assert.equal(sent[0].fields.amend, 'true');
    const second = await wikiCommand(lib, explainer.id, { env, fetch });
    assert.deepEqual([second.place, second.urls], ['Explainers/Again', ['https://wiki.keops.ai/d/n1']]);
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
      return { to: 'personal', place: 'Explainers/Job', urls: ['https://wiki.keops.ai/d/n1'], error: null };
    };
    const done = await runExplainJob(lib, 'j202611240000aa01', { sendToWiki: send });
    assert.deepEqual(calls, [[explainer.id, 'running', 'Putting it on the wiki', 0]]);
    assert.deepEqual([done.state, done.done, done.total, done.message], ['done', 2, 2, '2 clips ready, and on the wiki']);
    assert.deepEqual(buildStatus(done).wiki, { to: 'personal', place: 'Explainers/Job', urls: ['https://wiki.keops.ai/d/n1'], error: null });
    assert.equal(buildStatus({ ...done, kind: 'video' }).wiki, null);
  });

  test('a failed upload ends nothing: the clips are ready, and it says why', async () => {
    const explainer = explainerOf('Job failed', [clip('One')], { depth: 1, wiki: { to: 'shared' } });
    made(explainer, 1);
    job('j202611240000aa02', explainer);
    const done = await runExplainJob(lib, 'j202611240000aa02', { sendToWiki: async () => ({ to: 'shared', place: null, urls: [], error: 'no' }) });
    assert.deepEqual([done.state, done.message, done.error, done.wiki.error], ['done', 'Your clip is ready; not on the wiki', null, 'no']);
  });

  test('not asked for, or there already: nothing is sent', async () => {
    const send = async () => assert.fail('sent');
    const plain = explainerOf('Job plain', [clip('One')], { depth: 1 });
    made(plain, 1);
    job('j202611240000aa03', plain);
    assert.equal((await runExplainJob(lib, 'j202611240000aa03', { sendToWiki: send })).wiki, null);
    const there = explainerOf('Job there', [clip('One')], { depth: 1, wiki: { to: 'personal', place: 'Explainers/Job there', urls: ['https://wiki.keops.ai/d/n1'], error: null } });
    made(there, 1);
    job('j202611240000aa04', there);
    assert.deepEqual((await runExplainJob(lib, 'j202611240000aa04', { sendToWiki: send })).wiki.urls, ['https://wiki.keops.ai/d/n1']);
  });

  test('the workspace and the folder are kept on the explainer they were picked for; a folder alone is nothing', async () => {
    const plan = {
      title: 'Kept', shape: 'none', boxes: [], depth: 1,
      clips: [{ title: 'One', box: null, level: 1, facts: [{ text: 'The gateway mints the token.', basis: 'code' }], anchors: [{ file: 'a.js', from: 1, to: 1, expect: 'mint' }], guess: { q: 'Which?', options: [{ text: 'a', why: 'w', right: true }, { text: 'b', why: 'w', right: false }, { text: 'c', why: 'w', right: false }], quote: 'gateway mints the token' } }],
    };
    const cwd = join(root, 'project');
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(cwd, 'a.js'), 'mint(user)\n');
    const start = (wikiTo, folder) => startExplainer(lib, { plan, sessionId: '0b6c8f8e-1f6e-4b0e-9a55-3c1d2e4f5a6b', cwd, wiki: wikiTo, folder, io: { askStructured: async () => ({ wrong: [] }) }, job: () => ({ id: 'j1' }) });
    const picked = await start('shared', 'Explainers/Auth');
    assert.deepEqual([picked.wiki, picked.folder], ['shared', 'Auth']);
    assert.deepEqual(readExplainer(lib, picked.id).wiki, { to: 'shared', folder: 'Auth' });
    assert.deepEqual(readExplainer(lib, (await start('personal')).id).wiki, { to: 'personal', folder: null });
    for (const other of [undefined, null, 'public', true]) {
      const plain = await start(other, 'Auth');
      assert.deepEqual([plain.wiki, plain.folder], [null, null]);
      assert.equal(readExplainer(lib, plain.id).wiki, null);
    }
    updateExplainer(lib, picked.id, () => ({ at: 1 }));
    assert.deepEqual(readExplainer(lib, picked.id).wiki, { to: 'shared', folder: 'Auth' }, 'kept through other changes');
  });
});
