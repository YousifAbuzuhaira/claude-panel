// The player's data in an exported explainer (data-file.js): it runs inside the wiki's sandboxed
// frame, where touching storage throws and the address can't change, so nothing there may break
// it. A stand-in page (the few elements it reads) and storage that throws stand in for that frame.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const info = { id: 'x2026112200001a2b', title: 'Tokens', depth: 2, clips: [{ n: 1, state: 'ready' }, { n: 2, state: 'later' }, { n: 3, state: 'ready' }] };
const elements = {
  'explainer-data': { textContent: JSON.stringify({ info, questions: true }) },
  'clip-3': { textContent: JSON.stringify({ title: 'Clip 3' }) },
  'sound-3': { textContent: Buffer.from([1, 2, 3, 250]).toString('base64') },
  frame: { innerHTML: '<div id="stage"></div>', hidden: false },
  note: { hidden: true, textContent: '' },
};
globalThis.document = { getElementById: id => elements[id] || null };
globalThis.location = { hash: '#clip=2', protocol: 'about:' };
globalThis.history = { replaceState() { throw new Error('SecurityError'); } };
Object.defineProperty(globalThis, 'localStorage', { get() { throw new Error('SecurityError: no storage in a sandbox'); }, configurable: true });
globalThis.atob = text => Buffer.from(text, 'base64').toString('latin1');

const data = await import('../public/learn/video/data-file.js');

test('it opens on a clip in the file: one asked for that is not there falls back to the first ready', () => {
  assert.deepEqual(data.where(), { courseId: null, pageN: NaN, explainId: info.id, clipN: 1 });
});

test('with storage that throws, what you do is kept for the page: guesses, done marks, questions, speed', async () => {
  assert.equal(await data.getQuestions(), true, 'the setting the file was made with');
  data.saveQuestions(false);
  assert.equal(await data.getQuestions(), false);
  assert.deepEqual(data.recall(info.id), {});
  data.remember(info.id, now => ({ done: { ...(now.done || {}), 1: true } }));
  assert.deepEqual(data.recall(info.id), { done: { 1: true } });
  data.savePrefs({ videoRate: 1.5, videoCaptions: false });
  assert.deepEqual(await data.loadPrefs(), { videoRate: 1.5, videoCaptions: false });
});

test("a clip's script and sound come from the page; one not in it says so", async () => {
  assert.deepEqual(await data.explainVideo(info.id, 3), { title: 'Clip 3' });
  const blob = await data.explainSound(info.id, 3);
  assert.equal(blob.type, 'audio/mpeg');
  assert.deepEqual([...new Uint8Array(await blob.arrayBuffer())], [1, 2, 3, 250]);
  await assert.rejects(data.explainVideo(info.id, 2), /not in this file/);
  await assert.rejects(data.courseVideo('c', 1), /explainer only/);
  assert.deepEqual(await data.explainAt(info.id, { n: 3 }), {}, 'nothing is sent anywhere');
});

test('another clip plays in the same page: the last run told to end, the frame put back, the player run again', async () => {
  let runs = 0;
  data.boot(async () => { runs += 1; });
  assert.equal(runs, 1);
  const first = data.life();
  elements.frame.innerHTML = '<div>drawn over</div>';
  elements.note.hidden = false;
  data.go(info.id, 3);
  assert.equal(first.signal.aborted, true);
  assert.equal(data.life().signal.aborted, false);
  assert.equal(data.where().clipN, 3);
  assert.equal(elements.frame.innerHTML, '<div id="stage"></div>');
  assert.equal(elements.note.hidden, true);
  assert.equal(runs, 2, 'the address could not change (it throws), and it played anyway');
});

test('inside a frame, nothing offers to look again for new clips: only a file on disk is written again', () => {
  assert.equal(data.refresh, null);
});
