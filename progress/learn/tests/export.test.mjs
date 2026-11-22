// An explainer as one file (learn/export.mjs): the bundle, what goes in the page, what never does.
// node --test learn/tests/
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import vm from 'node:vm';

const root = mkdtempSync(join(tmpdir(), 'learn-export-'));
process.env.LEARN_LIBRARY = join(root, 'library');
process.env.LEARN_CONFIG_DIR = join(root, 'config');
process.env.LEARN_EXPORT_DIR = join(root, 'out');
after(() => rmSync(root, { recursive: true, force: true }));

const { clipForFile, exportExplainer, exportName, playerBundle, unmodule } = await import('../export.mjs');
const { explainPaths, readExplainer, saveExplainer } = await import('../explain.mjs');
const { openLibrary } = await import('../library.mjs');

const SESSION = '0b6c8f8e-1f6e-4b0e-9a55-3c1d2e4f5a6b';
const CWD = join(root, 'project');
const clip = (title, level) => ({ title, level, facts: [{ text: `${title} works like this.`, basis: 'session', quote: 'the words I typed in the chat' }], anchors: [], guess: { q: 'Which?', options: [{ text: 'a', why: 'w', right: true }], quote: 'the words I typed in the chat' }, failure: [] });
const video = n => ({
  title: `Clip ${n}`, sections: [`Clip ${n}`], scenes: [{ section: `Clip ${n}`, title: 't', start: 0, end: 2, cues: [], beats: [], objects: [], quote: 'the words I typed in the chat' }],
  assets: { code: {}, table: {}, diagram: {} }, quiz: [{ id: 'g', q: 'Which?', options: [], videoOnly: true, guess: true, quote: 'the words I typed in the chat' }],
  plan: { clips: [{ handoffQuote: 'the words I typed in the chat' }] }, openers: {}, pronounce: [], stats: { cwd: CWD }, model: 'opus', effort: 'low', explainer: 'x', clip: n,
  words: [{ w: 'Hi', s: 0, e: 0.3 }], audio: { mainEnd: 2, extras: {}, voice: 'af_heart', seconds: 2 },
});
function made(lib, explainer, n) {
  const base = explainPaths(lib, explainer.id).clip(n);
  mkdirSync(join(explainPaths(lib, explainer.id).dir, 'clips'), { recursive: true });
  writeFileSync(`${base}.json`, JSON.stringify(video(n)));
  writeFileSync(`${base}.mp3`, Buffer.from([0xff, 0xfb, n, 0x00]));
}
const dataOf = page => JSON.parse(/<script type="application\/json" id="explainer-data">(.*?)<\/script>/s.exec(page)[1]);

describe('the bundle', () => {
  test('a module: named imports become destructures of the modules before it, and its exports are named', () => {
    const { body, names } = unmodule("import { buildStates, sceneAt as sceneIndex } from './model.mjs';\nexport function a() {}\nexport async function b() {}\nexport const c = 1;\nconst d = 2;", 'x.js');
    assert.match(body, /^const \{ buildStates, sceneAt: sceneIndex \} = __model;$/m);
    assert.doesNotMatch(body, /\bexport\b/);
    assert.deepEqual(names, ['a', 'b', 'c']);
  });

  test("forms it can't bundle are refused by name, not left to break the file", () => {
    assert.throws(() => unmodule("import x from './model.mjs';", 'x.js'), /import that can't be bundled/);
    assert.throws(() => unmodule("import {\n  a,\n} from './model.mjs';", 'x.js'), /import that can't be bundled/);
    assert.throws(() => unmodule("import { a } from '../../shared/api.js';", 'x.js'), /import that can't be bundled/);
    assert.throws(() => unmodule('export default 1;', 'x.js'), /export that can't be bundled/);
    assert.throws(() => unmodule('export { a };', 'x.js'), /export that can't be bundled/);
    assert.throws(() => unmodule("const m = await import('./x.js');", 'x.js'), /dynamic import/);
  });

  test('the player bundles: every module in a form it takes, one script that compiles and never ends its tag early', () => {
    const script = playerBundle();
    assert.doesNotThrow(() => new vm.Script(`(async () => {\n${script}\n})`));
    assert.doesNotMatch(script, /<\/script|<!--/i);
    assert.match(script, /const __data = \(\(\) => \{/);
    assert.match(script, /__data\.boot\(__player\);\s*$/);
    assert.doesNotMatch(script, /shared\/api\.js|\/api\/rpc/, 'nothing in it talks to a server');
  });
});

describe('the file', () => {
  const lib = () => openLibrary();
  const make = (title = 'How </script> tokens <b>move</b>') => saveExplainer(lib(), {
    title, session: SESSION, cwd: CWD, depth: 2, at: 1, createdAt: new Date().toISOString(),
    map: { shape: 'none', boxes: [], clips: [] }, clips: [clip('One', 1), clip('Two', 2), clip('Three', 2), clip('Four', 3)],
  });

  test('nothing is written before a clip is ready', () => {
    const explainer = make('Empty');
    assert.equal(exportExplainer(lib(), explainer.id), null);
  });

  test('every clip made so far: the rest of the depth named as later, past it left out, and the depth always set', () => {
    const explainer = make();
    made(lib(), explainer, 1);
    made(lib(), explainer, 2);
    const done = exportExplainer(lib(), explainer.id);
    assert.equal(done.clips, 2);
    assert.ok(done.file.startsWith(process.env.LEARN_EXPORT_DIR));
    const page = readFileSync(done.file, 'utf8');
    const { info, questions } = dataOf(page);
    assert.equal(info.depth, 2);
    assert.deepEqual(info.clips.map(c => c.state), ['ready', 'ready', 'later', 'left out']);
    assert.equal(questions, false, 'the Questions setting as it was');
    assert.ok(page.includes('id="clip-1"') && page.includes('id="sound-2"') && !page.includes('id="clip-3"'));
    assert.match(page, new RegExp(`id="sound-1">${Buffer.from([0xff, 0xfb, 1, 0x00]).toString('base64')}<`));
    assert.match(page, /<script type="module">/);
    assert.doesNotMatch(page, /<link rel="stylesheet"|<script [^>]*src=/, 'nothing loaded from outside the page');
  });

  test('nothing of the chat goes in: no session id, folder, facts or quotes, and no plan or stats', () => {
    const explainer = make('Private');
    made(lib(), explainer, 1);
    const page = readFileSync(exportExplainer(lib(), explainer.id).file, 'utf8');
    for (const secret of [SESSION, CWD, root, 'the words I typed in the chat', 'works like this']) assert.ok(!page.includes(secret), secret);
    const kept = clipForFile(video(1), 'Private');
    assert.deepEqual(Object.keys(kept).sort(), ['assets', 'audio', 'courseTitle', 'openers', 'quiz', 'scenes', 'sections', 'stale', 'title', 'words']);
    assert.equal(kept.scenes[0].quote, undefined);
    assert.equal(kept.quiz[0].quote, undefined);
  });

  test('a title is text in the page: no tag of its own ends a script or starts markup', () => {
    const explainer = make();
    made(lib(), explainer, 1);
    const page = readFileSync(exportExplainer(lib(), explainer.id).file, 'utf8');
    assert.match(page, /<title>How &lt;\/script&gt; tokens &lt;b&gt;move&lt;\/b&gt;<\/title>/);
    assert.equal(dataOf(page).info.title, 'How </script> tokens <b>move</b>');
  });

  test("one name per explainer, kept: written again over itself, never over another's of the same title", () => {
    const one = make('Same title');
    const two = make('Same title');
    made(lib(), one, 1);
    made(lib(), two, 1);
    const first = exportExplainer(lib(), one.id).file;
    made(lib(), one, 2);
    assert.equal(exportExplainer(lib(), one.id).file, first);
    assert.equal(readExplainer(lib(), one.id).file, first);
    assert.notEqual(exportExplainer(lib(), two.id).file, first);
    assert.equal(exportName({ id: 'x2026112200001a2b', title: 'Why /explain used to stall!' }), 'why-explain-used-to-stall-1a2b.html');
    assert.equal(exportName({ id: 'x2026112200001a2b', title: '   ' }), 'explainer-1a2b.html');
  });

  test('with no depth saved, the depth is the deepest level made, so the file never asks', () => {
    const explainer = saveExplainer(lib(), { title: 'Old', depth: null, at: 1, createdAt: new Date().toISOString(), map: { shape: 'none', boxes: [], clips: [] }, clips: [clip('One', 1), clip('Two', 2)] });
    made(lib(), explainer, 1);
    const { info } = dataOf(readFileSync(exportExplainer(lib(), explainer.id).file, 'utf8'));
    assert.equal(info.depth, 1);
    assert.deepEqual(info.clips.map(c => c.state), ['ready', 'left out']);
  });

  test('LEARN_EXPORT_DIR is where files go; nothing lands in the real ~/explainers', () => {
    assert.ok(existsSync(process.env.LEARN_EXPORT_DIR));
  });
});
