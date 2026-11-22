// An explainer's clips (/explain): each clip is its own short video, played as a page's video is,
// and the next opens when one ends. Before a clip is ready: pick how deep to go (once), then, with
// questions on, answer the clip's guess question while it's being made, so the wait isn't dead time.
// In an exported file every clip there is ready and the depth was picked: none of that shows.
import { explainAt, explainInfo, explainSound, explainVideo, getQuestions, recall, remember } from './data.js';

const make = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};
const sleep = ms => new Promise(done => setTimeout(done, ms));

/** How deep to go: the mental model, the mechanism with its code, or everything. Asked once. */
function askDepth(info, gate) {
  return new Promise(resolve => {
    gate.replaceChildren(make('div', 'gate-title', info.title), make('div', 'gate-ask', 'How deep should it go?'));
    const choices = [
      ['The idea', 'the mental model'],
      ['The mechanism', 'and the code that does it'],
      ['Everything', 'with failure modes and edges'],
    ];
    choices.forEach(([label, sub], k) => {
      const count = info.counts[k];
      if (k && count === info.counts[k - 1]) return; // a depth that adds no clip isn't a choice
      const button = make('button', 'gate-choice');
      button.append(make('span', 'key', String(k + 1)), make('b', '', label), make('span', 'gate-sub', `${sub} · ${count} clip${count === 1 ? '' : 's'}`));
      button.addEventListener('click', async () => resolve(await explainAt(info.id, { depth: k + 1 })));
      gate.append(button);
    });
    gate.hidden = false;
  });
}

/** While a clip is made: its title and how it's going, and with questions on its guess, answered now and played out when it's ready. */
function showWaiting(info, n, gate, id, questions) {
  const clip = info.clips[n - 1];
  const kept = recall(id).guesses?.[n];
  gate.replaceChildren(make('div', 'gate-meta', `Clip ${n} of ${info.clips.filter(item => item.level <= (info.depth || 1)).length}`), make('div', 'gate-title', clip.title));
  const status = make('div', 'gate-status', info.message || 'Being made: usually 2 to 4 minutes');
  status.id = 'gateStatus';
  gate.append(status);
  if (!questions) {
    // Nothing to answer: the clip plays when it's made.
  } else if (kept) {
    gate.append(make('div', 'gate-ask', kept.unsure ? 'It will start from the beginning.' : 'Your answer is kept: the clip starts from it.'));
  } else {
    const box = make('div', 'gate-quiz');
    box.append(make('div', 'quiz-tag', 'Guess first, while you wait'), make('div', 'gate-q', clip.guess.q));
    const keep = guess => { remember(id, now => ({ guesses: { ...(now.guesses || {}), [n]: guess } })); showWaiting(info, n, gate, id, questions); };
    clip.guess.options.forEach((option, k) => {
      const button = make('button', 'option');
      button.append(make('span', 'key', String(k + 1)), make('span', '', option.text));
      button.addEventListener('click', () => keep({ k }));
      box.append(button);
    });
    const unsure = make('button', 'option unsure');
    unsure.append(make('span', 'key', 'N'), make('span', '', 'Not sure'));
    unsure.addEventListener('click', () => keep({ unsure: true }));
    box.append(unsure);
    gate.append(box);
  }
  gate.hidden = false;
}

/**
 * The clip asked for, once it's made: `{ video, blob, outer }`, `outer` the explainer's playlist and
 * map. Picks the depth first when none is picked; while the clip is being made, shows its guess.
 */
export async function loadExplainer({ id, n, gate }) {
  let info = await explainInfo(id);
  if (!info.clips[n - 1]) throw new Error('it has no such clip');
  if (info.clips[n - 1].state === 'later') throw new Error('that clip is not in this file yet');
  if (!info.depth) info = { ...info, ...(await askDepth(info, gate)) };
  if (info.clips[n - 1].state !== 'ready') {
    await explainAt(id, { n });
    showWaiting(info, n, gate, id, await getQuestions());
    for (;;) {
      await sleep(3000);
      info = await explainInfo(id);
      const clip = info.clips[n - 1];
      if (clip.state === 'ready') break;
      const status = document.getElementById('gateStatus');
      if (status) status.textContent = clip.state === 'left out' ? 'This clip is past the depth you picked.' : info.message || 'Waiting its turn';
    }
  }
  const outer = { ...info, ...(await explainAt(id, { n })) };
  const video = await explainVideo(id, n);
  const blob = await explainSound(id, n);
  gate.hidden = true;
  return { video, blob, outer };
}
