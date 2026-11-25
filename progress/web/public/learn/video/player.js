// The video player: the audio is the clock, and every picture, word and question follows it.
// A video is a playlist of clips, one per section: each stops at its end, and the next starts when
// you say so. Opened as /learn/video/?course=<id>&page=<n>. An answer goes through check.answer, as on the
// page, so it counts towards Review. Everything it needs comes through data.js: Learn's server, or
// in an explainer exported as one file, the page itself (data-file.js), where this whole module
// runs again for each clip and `life().signal` ends the run before.
import { countAnswer, courseVideo, explainAt, getQuestions, go, keepAlive, life, loadPrefs as readPrefs, recall, refresh, remember, savePrefs as writePrefs, saveQuestions, where } from './data.js';
import { buildCameras, buildStates, sceneAt as sceneIndex } from './model.mjs';
import { applyState, initStage, stepObjects } from './stage.js';
import { loadExplainer } from './explain.js';

const $ = id => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const ease = k => 1 - Math.pow(1 - k, 3);
const div = (cls, text) => { const node = document.createElement('div'); node.className = cls; if (text !== undefined) node.textContent = text; return node; };
const timeText = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const ICONS = {
  play: '<path d="M7 4.5v15l12-7.5z" fill="currentColor"/>',
  pause: '<path d="M7 5h3.6v14H7zM13.4 5H17v14h-3.6z" fill="currentColor"/>',
  back: '<path d="M12 5a7 7 0 1 1-6.7 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M12 1.8 8.2 5 12 8.2z" fill="currentColor"/><text x="12.1" y="15.2" font-size="7.4" font-family="Segoe UI, sans-serif" font-weight="700" text-anchor="middle" fill="currentColor">10</text>',
  forward: '<path d="M12 5a7 7 0 1 0 6.7 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M12 1.8 15.8 5 12 8.2z" fill="currentColor"/><text x="11.9" y="15.2" font-size="7.4" font-family="Segoe UI, sans-serif" font-weight="700" text-anchor="middle" fill="currentColor">10</text>',
  sound: '<path d="M4 9.5v5h3.4l4.6 3.8V5.7L7.4 9.5z" fill="currentColor"/><path d="M15 8.6a4.6 4.6 0 0 1 0 6.8M17.5 6.2a8 8 0 0 1 0 11.6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
  muted: '<path d="M4 9.5v5h3.4l4.6 3.8V5.7L7.4 9.5z" fill="currentColor"/><path d="m15.5 9.5 5 5m0-5-5 5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
  cc: '<rect x="3" y="5.5" width="18" height="13" rx="2" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M10.6 10.3a2.2 2.2 0 1 0 0 3.4M17 10.3a2.2 2.2 0 1 0 0 3.4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
  list: '<path d="M4 6.5h2M4 12h2M4 17.5h2M9 6.5h11M9 12h11M9 17.5h11" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  full: '<path d="M4 9V4.5h4.5M15.5 4.5H20V9M20 15v4.5h-4.5M8.5 19.5H4V15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  questions: '<circle cx="12" cy="12" r="8.6" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M9.6 9.6a2.5 2.5 0 1 1 3.4 2.3c-.7.3-1 .8-1 1.5v.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><circle cx="12" cy="16.9" r="1.05" fill="currentColor"/>',
};
const icon = name => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;

// An explainer's clip (/explain): ?explain=<id>&clip=<n>. Each clip is its own video; the next opens when one ends.
const { courseId, pageN, explainId, clipN } = where();
const { signal } = life();

/** Stops here with a plain sentence where the video would be. */
function giveUp(text) {
  $('frame').hidden = true;
  $('note').hidden = false;
  $('note').textContent = text;
  throw new Error(text);
}

async function load() {
  if (explainId) {
    if (!/^x[0-9a-f]{12,20}$/.test(explainId) || !Number.isInteger(clipN) || clipN < 1) giveUp('This link names no explainer.');
    keepAlive();
    try {
      return await loadExplainer({ id: explainId, n: clipN, gate: $('gate') });
    } catch (error) {
      return giveUp(`This explainer can't play: ${error.message}`);
    }
  }
  if (!courseId || !Number.isInteger(pageN)) giveUp('This link names no video.');
  keepAlive();
  try {
    return await courseVideo(courseId, pageN);
  } catch (error) {
    return giveUp(`This video can't play: ${error.message}`);
  }
}

const { video: V, blob, outer = null } = await load();
// An explainer's playlist: its clips in the depth picked, the map they share, what you did in it.
const inDepth = outer ? outer.clips.filter(c => c.level <= (outer.depth || 1)) : [];
const nextOuter = outer ? inDepth.find(c => c.n > clipN) || null : null;
/** Another clip. One that can't be read (its page on the wiki moved) says so over this one, which plays on when asked. */
async function goToClip(n) {
  try {
    await go(explainId, n);
  } catch (error) {
    if (signal.aborted) return;
    setPlaying(false, true);
    toggleDrawer(false);
    $('coverTitle').textContent = `Couldn't load "${outer.clips[n - 1].title}" here`;
    $('coverMeta').textContent = error.message;
    coverAction = () => goToClip(n);
    $('coverPlay').title = 'Try again';
    againClip = 0;
    $('coverAgain').hidden = false;
    $('cover').hidden = false;
  }
}
if (outer) V.plan = outer.map;
const { scenes, assets, quiz, sections, audio: track } = V;
const quizById = new Map(quiz.map(q => [q.id, q]));
// Questions (Learn's setting, Q here): off, nothing stops the video. A video made without any
// has nothing to turn on; one made with them hides them while the setting is off.
let wantQuestions = await getQuestions();
const hasQuestions = scenes.some(scene => scene.check || scene.masks?.length);
const questionsOn = () => wantQuestions && hasQuestions;
// A question scene is passed over when questions are off, or when it's gone since the video was made.
const skipped = scene => Boolean(scene.check) && (!questionsOn() || !quizById.has(scene.check));
const total = track.mainEnd;

// --- Clips: the page's sections, each a span of the one track ------------------------------
const clips = sections.map(name => scenes.filter(scene => scene.section === name)).filter(own => own.length)
  .map((own, k) => ({ name: own[0].section, from: k ? own[0].start : 0, to: own.at(-1).end, done: false }));
const clipAt = t => { let found = 0; clips.forEach((c, k) => { if (c.from <= t + 0.001) found = k; }); return found; };
const endsClip = scene => scene.end >= clips[clipAt(scene.start)].to - 0.01;
let shownClip = -1;

// The map, drawn once for the whole video in the title band, and each clip's place on it. Openers:
// a wrong guess played out, past the main track, one per wrong option of a clip's guess.
const plan = V.plan && V.plan.shape !== 'none' && (V.plan.boxes || []).length ? V.plan : null;
const planClip = name => plan?.clips.find(entry => entry.clip === name);
const openersOf = V.openers || {};
for (const byOption of Object.values(openersOf)) for (const scene of Object.values(byOption)) {
  scene.states = buildStates(scene);
  scene.cameras = buildCameras(scene, scene.states, assets);
}
initStage({ objects: $('objects'), wires: $('wires'), assets });

// --- Every moment is worked out from the time alone, so any jump lands on the right picture ---
for (const scene of scenes) {
  scene.states = buildStates(scene);
  scene.cameras = buildCameras(scene, scene.states, assets);
}
const sceneAt = t => sceneIndex(scenes, t);

let shownScene = -1, shownCue = -1;
let cam = { x: 560, y: 298, zoom: 1 }, camFrom = cam, camTo = cam, camT0 = 0;
// Pulling back is quicker, so the camera has made room before something new has faded in (520 ms).
const camMs = () => (camTo.zoom < camFrom.zoom ? 600 : 1000);

function syncTo(t, instant) {
  if (mode === 'opener') return syncOpener(t, instant);
  const s = sceneAt(t);
  const scene = scenes[s];
  let c = 0;
  while (c < (scene.cues || []).length && scene.cues[c].t <= t) c += 1;
  if (clipAt(t) !== shownClip) showClip(clipAt(t));
  if (s === shownScene && c === shownCue) return;
  const newScene = s !== shownScene;
  shownScene = s; shownCue = c;
  applyState(unmasked(scene.states[c], s), instant);
  camFrom = instant ? scene.cameras[c] : { ...cam };
  camTo = scene.cameras[c];
  camT0 = performance.now();
  if (instant) cam = camTo;
  if (newScene) showHead(scene);
}
function showHead(scene) {
  const head = $('head');
  $('section').textContent = outer ? `${inDepth.findIndex(c => c.n === clipN) + 1} of ${inDepth.length} · ${scene.section}` : `${clipAt(scene.start) + 1} of ${clips.length} · ${scene.section}`;
  $('title').textContent = scene.title;
  head.classList.remove('swap'); void head.offsetWidth; head.classList.add('swap');
  showWrongTurn(Boolean(scene.trap));
  showQuiz(scene);
}
function showClip(k) {
  shownClip = k;
  $('nowChapter').textContent = outer ? `${inDepth.findIndex(c => c.n === clipN) + 1}/${inDepth.length} · ${clips[k].name}` : `${k + 1}/${clips.length} · ${clips[k].name}`;
  showClipBar(k);
  showRail();
  drawMap(k);
  if (playing) showHandoff(k);
}
/** A real failure, or a wrong guess played out: marked by the player, never left to a script. */
function showWrongTurn(on) {
  $('stage').classList.toggle('wrong', on);
  $('wrongTurn').hidden = !on;
}

// --- The map: where this clip sits in the whole ----------------------------------------------
/** The clips the map counts: this video's, or an explainer's whole playlist with what you did in it. */
function mapClips() {
  if (!outer) return clips;
  const kept = recall(explainId);
  return inDepth.map(c => ({ name: c.title, done: Boolean(kept.done?.[c.n]) || (c.n === clipN && Boolean(clips[0]?.done)) }));
}
function clipsInBox(id) {
  return mapClips().filter(c => { const box = planClip(c.name)?.box; return box === id || plan.boxes.find(b => b.id === box)?.parent === id; });
}
function drawMap(k) {
  const node = $('map');
  $('head').classList.toggle('with-map', Boolean(plan));
  node.hidden = !plan;
  if (!plan) return;
  const here = planClip(clips[k].name)?.box;
  const box = plan.boxes.find(b => b.id === here);
  const parent = box?.parent ? plan.boxes.find(b => b.id === box.parent) : null;
  // Two levels: inside a part, its own boxes stand in for the whole, so no more than 4 show at once.
  const row = parent ? plan.boxes.filter(b => b.parent === parent.id) : plan.boxes.filter(b => !b.parent);
  node.replaceChildren();
  if (parent) node.append(div('map-crumb', `${parent.label} ›`));
  row.forEach((b, i) => {
    if (i && plan.shape === 'flow') node.append(div('map-arrow', '→'));
    const mine = clipsInBox(b.id);
    const cell = div('map-box', b.label);
    cell.dataset.box = b.id;
    cell.classList.toggle('now', b.id === here || b.id === parent?.id);
    cell.classList.toggle('done', mine.length > 0 && mine.every(c => c.done));
    node.append(cell);
  });
}
/** Going into a clip of the next box, what passes between them slides along the map: shown, not said. */
function showHandoff(k) {
  const entry = planClip(clips[k]?.name);
  const before = k > 0 ? planClip(clips[k - 1].name) : null;
  if (!plan || plan.shape !== 'flow' || !entry?.handoff || !before || before.box === entry.box) return;
  const map = $('map');
  const to = map.querySelector(`[data-box="${CSS.escape(entry.box)}"]`);
  if (!to) return;
  const from = map.querySelector(`[data-box="${CSS.escape(before.box)}"]`);
  const centre = cell => cell.offsetLeft + cell.offsetWidth / 2;
  map.querySelectorAll('.map-chip').forEach(chip => chip.remove());
  const chip = div('map-chip', entry.handoff);
  chip.style.left = `${from ? centre(from) : 0}px`;
  map.append(chip);
  requestAnimationFrame(() => requestAnimationFrame(() => { chip.style.left = `${centre(to)}px`; chip.classList.add('go'); }));
  setTimeout(() => chip.remove(), 2600);
}

// --- A masked line: the learner picks the line that does what the clip just showed -----------
const revealed = new Set(); // `${scene}:${object}` of lines picked
const maskPicks = new Map();
let activeMask = null;
const maskKey = (s, id) => `${s}:${id}`;
function unmasked(state, s) {
  // Questions off: every masked line shows its real line, and nothing stops for it.
  const shows = id => !questionsOn() || revealed.has(maskKey(s, id));
  if (![...state.values()].some(o => o.mask !== undefined && shows(o.id))) return state;
  return new Map([...state].map(([id, o]) => [id, o.mask !== undefined && shows(id) ? { ...o, mask: undefined } : o]));
}
function showMask(mask) {
  activeMask = { mask, scene: shownScene };
  const all = mask.all || (mask.all = [mask.answer, ...mask.choices].map((text, k) => ({ text, right: !k })).sort(() => Math.random() - 0.5));
  const box = $('maskBox');
  box.replaceChildren(div('quiz-tag', 'Which line goes here?'));
  all.forEach((choice, k) => {
    const node = document.createElement('button');
    node.className = 'mask-choice';
    const key = document.createElement('span'); key.className = 'key'; key.textContent = String(k + 1);
    const text = document.createElement('code'); text.textContent = choice.text;
    node.append(key, text);
    node.addEventListener('click', () => pickMask(k));
    box.append(node);
  });
  box.hidden = false;
  drawPhrase(-1);
}
function pickMask(k) {
  if (!activeMask) return;
  const { mask, scene } = activeMask;
  const key = maskKey(scene, mask.id);
  if (maskPicks.has(key)) return;
  maskPicks.set(key, k);
  revealed.add(key);
  const box = $('maskBox');
  [...box.querySelectorAll('.mask-choice')].forEach((node, place) => {
    node.disabled = true;
    if (mask.all[place].right) node.classList.add('right');
    else if (place === k) node.classList.add('wrong');
  });
  box.append(div(`quiz-result ${mask.all[k].right ? 'good' : 'bad'}`, mask.all[k].right ? 'Right' : 'Not quite: the real line is now on screen'));
  applyState(unmasked(scenes[scene].states[shownCue], scene), false);
  mode = 'main';
  if (playing) sound.play().catch(() => {});
  setTimeout(() => { if (activeMask?.mask === mask) hideMask(); }, 2800);
}
function hideMask() { activeMask = null; $('maskBox').hidden = true; }

// --- Openers ------------------------------------------------------------------------------
let openerScene = null, openerCue = -1;
function syncOpener(t, instant) {
  let c = 0;
  while (c < (openerScene.cues || []).length && openerScene.cues[c].t <= t) c += 1;
  if (c === openerCue) return;
  openerCue = c;
  applyState(openerScene.states[c], instant);
  camFrom = instant ? openerScene.cameras[c] : { ...cam };
  camTo = openerScene.cameras[c];
  camT0 = performance.now();
  if (instant) cam = camTo;
}
function playOpener(scene) {
  openerScene = scene;
  openerCue = -1;
  mode = 'opener';
  $('quiz').hidden = true;
  $('title').textContent = scene.title;
  showWrongTurn(true);
  sound.currentTime = scene.start;
  syncOpener(scene.start, true);
  if (playing) sound.play().catch(() => {});
}
function endOpener() {
  openerScene = null;
  showWrongTurn(false);
  leaveQuestion();
}

// --- Sound and time --------------------------------------------------------------------
const soundUrl = URL.createObjectURL(blob);
const sound = new Audio(soundUrl);
sound.preload = 'auto';
signal.addEventListener('abort', () => { sound.pause(); URL.revokeObjectURL(soundUrl); });
sound.preservesPitch = true;
let playing = false, rate = 1, dragging = false, mode = 'main', pinned = 0, extra = null, sleepTimer = 0, againClip = -1, advanceTimer = 0;
const answers = new Map(); // question id: the option picked, or null for "Not sure"
signal.addEventListener('abort', () => { clearTimeout(advanceTimer); clearTimeout(sleepTimer); });
/** A clip's end card counting down to the next clip (questions off), stopped. */
function cancelAdvance() {
  if (!advanceTimer) return;
  clearTimeout(advanceTimer);
  advanceTimer = 0;
  $('coverMeta').textContent = $('coverMeta').textContent.replace(/ · starts in 2 s$/, '');
}
const clockNow = () => ((mode === 'main' || mode === 'opener') && !dragging ? sound.currentTime : pinned);

function setPlaying(on, quiet = false) {
  cancelAdvance();
  playing = on;
  $('play').innerHTML = icon(on ? 'pause' : 'play');
  if (on) { $('cover').hidden = true; if (mode !== 'held') sound.play().catch(() => setPlaying(false)); } else sound.pause();
  if (!quiet) flash(on);
  if (on && mode === 'main' && shownClip >= 0 && clockNow() - clips[shownClip].from < 0.6) showHandoff(shownClip);
  wake();
}
/** Where a jump lands: past a question that's hidden (to the next scene's start: scenes have gaps), unless it ends its clip. */
function landing(t) {
  for (let s = sceneAt(t); skipped(scenes[s]) && !endsClip(scenes[s]) && s + 1 < scenes.length; s += 1) t = scenes[s + 1].start;
  return t;
}
function seek(t, keepPlaying = true) {
  if (openerScene) { openerScene = null; showWrongTurn(false); }
  if (activeMask) hideMask();
  cancelAdvance();
  mode = 'main';
  pinned = landing(clamp(t, 0, total - 0.05));
  sound.currentTime = pinned;
  syncTo(pinned, true);
  showFrame(pinned);
  if (playing && keepPlaying) sound.play().catch(() => {});
}
/** Jumps within the clip playing now: a clip's edges are where it stops, not places to slip past. */
function seekInClip(t) { const c = clips[shownClip]; seek(clamp(t, c.from, c.to - 0.1)); }
/** Goes to a clip you picked, and plays it. */
function jump(t) { $('cover').hidden = true; coverAction = null; seek(t); if (!playing) setPlaying(true, true); }
function watch(t) {
  if (mode === 'extra' && sound.currentTime >= extra.end - 0.03) { sound.pause(); mode = 'held'; }
  if (mode === 'opener' && !dragging && sound.currentTime >= openerScene.end - 0.03) { endOpener(); return; }
  if (!playing || mode !== 'main' || dragging) return;
  const scene = scenes[shownScene];
  // Passed over to the next scene's start: just past this one's end is still this one, in the gap.
  if (skipped(scene)) { if (endsClip(scene)) endClip(clipAt(scene.start)); else sound.currentTime = scenes[shownScene + 1]?.start ?? scene.end; return; }
  if (scene.check && t >= scene.end - 0.05 && !answers.has(scene.check)) { sound.pause(); mode = 'held'; pinned = scene.end - 0.06; return; }
  const mask = questionsOn() && (scene.masks || []).find(item => item.until !== undefined && !maskPicks.has(maskKey(shownScene, item.id)) && t >= item.until - 0.05);
  if (mask) { sound.pause(); mode = 'held'; pinned = mask.until - 0.06; showMask(mask); return; }
  if (t >= clips[clipAt(t)].to - 0.05) endClip(clipAt(t));
}
/**
 * A clip's end: it stops on the next clip's first picture. With questions on it waits until you
 * say go; with them off the card shows for 2 s and the next clip plays.
 */
function endClip(k) {
  clips[k].done = true;
  if (outer && k >= clips.length - 1) return endExplainerClip();
  if (k >= clips.length - 1) { showRail(); return finish(); }
  setPlaying(false, true);
  const next = clips[k + 1];
  seek(next.from, false);
  showRail();
  againClip = k;
  $('coverTitle').textContent = `Next: ${next.name}`;
  $('coverMeta').textContent = `${k + 2} of ${clips.length} · ${timeText(next.to - next.from)}`;
  $('coverPlay').title = 'Play the next clip (Enter)';
  $('coverAgain').hidden = false;
  $('cover').hidden = false;
  if (!questionsOn()) countDown(() => setPlaying(true, true));
}
/** The next clip in 2 s, said on the card; Space, a jump or turning questions on stops it. */
function countDown(go) {
  $('coverMeta').textContent += ' · starts in 2 s';
  advanceTimer = setTimeout(() => { advanceTimer = 0; go(); }, 2000);
}
/** An explainer's clip done: the card names the next one, which opens on play (or by itself, in 2 s, with questions off). */
function endExplainerClip() {
  remember(explainId, now => ({ done: { ...(now.done || {}), [clipN]: true } }));
  setPlaying(false, true);
  showRail();
  if (!nextOuter) {
    $('coverTitle').textContent = 'That is the whole explainer.';
    $('coverMeta').textContent = `${inDepth.length} clip${inDepth.length === 1 ? '' : 's'}`;
    coverAction = () => goToClip(inDepth[0].n);
    $('coverPlay').title = 'From the first clip';
  } else if (nextOuter.state === 'later') {
    // An exported file made before the rest: a file on disk is written again as each clip is made.
    $('coverTitle').textContent = `Next: ${nextOuter.title}`;
    $('coverMeta').textContent = `${inDepth.findIndex(c => c.n === nextOuter.n) + 1} of ${inDepth.length} · not in this file yet`;
    coverAction = refresh;
    $('coverPlay').title = refresh ? 'Look again for it' : 'Not in this file yet';
  } else {
    $('coverTitle').textContent = `Next: ${nextOuter.title}`;
    $('coverMeta').textContent = `${inDepth.findIndex(c => c.n === nextOuter.n) + 1} of ${inDepth.length}${nextOuter.state === 'ready' ? '' : ' · still being made'}`;
    coverAction = () => goToClip(nextOuter.n);
    $('coverPlay').title = 'Play the next clip (Enter)';
  }
  againClip = 0;
  $('coverAgain').hidden = false;
  $('cover').hidden = false;
  if (nextOuter && nextOuter.state !== 'later' && !questionsOn()) countDown(() => goToClip(nextOuter.n));
}
let coverAction = null;
function finish() {
  setPlaying(false, true);
  const right = [...answers.entries()].filter(([id, k]) => quizById.get(id).options[k]?.right).length;
  const asked = questionsOn();
  answers.clear();
  maskPicks.clear();
  revealed.clear();
  clips.forEach(c => { c.done = false; });
  seek(0, false);
  $('coverTitle').textContent = 'That is everything on this page.';
  $('coverMeta').textContent = asked ? `${right} of ${quiz.length} questions right` : `${clips.length} clips`;
  $('coverPlay').title = 'Watch again';
  $('coverAgain').hidden = true;
  $('cover').hidden = false;
}

// --- Questions -------------------------------------------------------------------------
function showQuiz(scene) {
  const box = $('quiz');
  box.hidden = !scene.check || skipped(scene);
  if (box.hidden) return;
  const q = quizById.get(scene.check);
  box.replaceChildren();
  box.append(div('quiz-tag', q.guess ? 'Guess first' : q.group ? 'Putting it together' : 'Quick check'), div('quiz-q', q.q));
  const order = q.order || (q.order = q.options.map((_, k) => k).sort(() => Math.random() - 0.5));
  const answered = answers.get(q.id);
  const done = answers.has(q.id);
  const button = (cls, keyText, label, onClick) => {
    const node = document.createElement('button');
    node.className = cls;
    const key = document.createElement('span'); key.className = 'key'; key.textContent = keyText;
    const text = document.createElement('span'); text.textContent = label;
    node.append(key, text);
    if (onClick) node.addEventListener('click', onClick); else node.disabled = true;
    box.append(node);
    return { node, text };
  };
  order.forEach((k, place) => {
    const option = q.options[k];
    const { node, text } = button('option', String(place + 1), option.text, done ? null : () => answer(k));
    if (!done) return;
    if (option.right) node.classList.add('right');
    if (k === answered && !option.right) node.classList.add('wrong');
    if (option.right || k === answered) { const why = document.createElement('span'); why.className = 'why'; why.textContent = option.why; text.append(why); }
  });
  // Not sure is an answer too: the clip plays from its start, nothing played out.
  if (q.guess && !done) button('option unsure', 'N', 'Not sure', notSure);
  const foot = div('quiz-foot');
  const primary = (label, onClick) => { const go = document.createElement('button'); go.className = 'primary'; go.textContent = label; go.id = 'continue'; go.addEventListener('click', onClick); foot.append(go); };
  const quiet = (label, onClick) => { const node = document.createElement('button'); node.className = 'quiet'; node.textContent = label; node.addEventListener('click', onClick); foot.append(node); };
  if (!done) quiet('Skip', leaveQuestion);
  else if (answered === null) primary('Continue', leaveQuestion);
  else {
    const right = q.options[answered].right;
    primary('Continue', leaveQuestion);
    foot.append(div(`quiz-result ${right ? 'good' : 'bad'}`, right ? 'Right' : 'Not quite'));
  }
  box.append(foot);
}
function notSure() {
  const q = quizById.get(scenes[shownScene].check);
  if (!q || answers.has(q.id)) return;
  answers.set(q.id, null);
  leaveQuestion();
}
function answer(k) {
  const scene = scenes[shownScene];
  const q = quizById.get(scene.check);
  if (!q || answers.has(q.id)) return;
  answers.set(q.id, k);
  // Counted as on the page. A question gone since the video was made just isn't recorded; a
  // clip's own guess is the video's alone and never goes to Review.
  if (!q.videoOnly) countAnswer({ courseId, n: pageN, id: q.id, choice: k });
  showQuiz(scene);
  const right = q.options[k].right;
  const tick = document.querySelector(`.tick[data-scene="${shownScene}"]`);
  if (tick) tick.classList.add(right ? 'right' : 'wrong');
  pinned = scene.end - 0.06;
  // Wrong: your answer played out, when the clip has it.
  if (q.guess && !right && openersOf[q.id]?.[k]) return playOpener(openersOf[q.id][k]);
  extra = track.extras[q.id][right ? 'right' : 'wrong'];
  pinned = scene.end - 0.06;
  mode = 'extra';
  sound.currentTime = extra.start;
  if (playing) sound.play().catch(() => {});
}
function leaveQuestion() {
  const scene = scenes[shownScene];
  mode = 'main';
  if (endsClip(scene)) return endClip(clipAt(scene.start));
  sound.currentTime = scene.end + 0.02;
  if (playing) sound.play().catch(() => {});
}

// --- Subtitles: short phrases, timed from the voice's own sounds ---------------------------
function phrasesOf(words) {
  const out = [];
  let run = [];
  const close = () => { if (run.length) { out.push({ s: run[0].s, e: run.at(-1).e, words: run }); run = []; } };
  words.forEach((word, k) => {
    run.push(word);
    const chars = run.map(w => w.w).join(' ').length;
    const next = words[k + 1];
    if (/[.!?:;]$/.test(word.w) || (/,$/.test(word.w) && chars > 26) || chars > 58 || (next && next.s - word.e > 0.3)) close();
  });
  close();
  return out;
}
const phrases = phrasesOf(V.words);
let shownPhrase = -1, showCaptions = true;
function drawPhrase(index) {
  const cc = $('cc');
  shownPhrase = index;
  if (index < 0) { cc.replaceChildren(); return; }
  const p = document.createElement('p');
  phrases[index].words.forEach((word, k) => { if (k) p.append(' '); const i = document.createElement('i'); i.textContent = word.w; p.append(i); });
  cc.replaceChildren(p);
}
function showCaption(t) {
  const current = mode === 'opener' ? openerScene : scenes[shownScene];
  if (current?.check || activeMask || !$('cover').hidden) { if (shownPhrase !== -1) drawPhrase(-1); return; }
  let low = 0, high = phrases.length - 1, found = -1;
  while (low <= high) { const mid = (low + high) >> 1; if (phrases[mid].s - 0.06 <= t) { found = mid; low = mid + 1; } else high = mid - 1; }
  if (found >= 0 && t > phrases[found].e + 0.55) found = -1;
  if (found !== shownPhrase) drawPhrase(found);
  if (found < 0) return;
  const spans = $('cc').querySelectorAll('i');
  phrases[found].words.forEach((word, k) => {
    const span = spans[k];
    if (!span) return;
    const on = t >= word.s - 0.04 && t < word.e;
    span.classList.toggle('on', on);
    span.classList.toggle('said', t >= word.s - 0.04);
  });
}

// --- The frame loop --------------------------------------------------------------------
function showFrame(t) {
  const now = performance.now();
  stepObjects(now);
  const scene = mode === 'opener' ? openerScene : scenes[shownScene];
  const kc = ease(clamp((now - camT0) / camMs(), 0, 1));
  cam = { x: camFrom.x + (camTo.x - camFrom.x) * kc, y: camFrom.y + (camTo.y - camFrom.y) * kc, zoom: camFrom.zoom + (camTo.zoom - camFrom.zoom) * kc };
  // A slow push-in through every scene, so the picture is never quite still.
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const span = Math.max(1, scene.end - scene.start);
  const zoom = cam.zoom * (still ? 1 : 1 + 0.02 * clamp((t - scene.start) / span, 0, 1));
  $('camera').style.transform = `translate(${560 - cam.x * zoom}px, ${298 - cam.y * zoom}px) scale(${zoom})`;
  showCaption(t);
  showClock(mode === 'opener' ? pinned : t);
}
function loop() {
  if (signal.aborted) return;
  const t = clockNow();
  syncTo(t, false);
  watch(t);
  showFrame(t);
  requestAnimationFrame(loop);
}

// --- Controls --------------------------------------------------------------------------
const frame = $('frame');
function wake() {
  frame.classList.add('awake');
  frame.classList.remove('sleeping');
  clearTimeout(sleepTimer);
  if (playing) sleepTimer = setTimeout(() => {
    if (!dragging && !$('drawer').classList.contains('open') && $('speedMenu').hidden) { frame.classList.remove('awake'); frame.classList.add('sleeping'); }
  }, 2600);
}
function flash(on) {
  const node = $('flash');
  node.innerHTML = icon(on ? 'play' : 'pause');
  node.classList.remove('go'); void node.offsetWidth; node.classList.add('go');
}
function showClock(t) {
  const c = clips[Math.max(0, shownClip)];
  $('clock').innerHTML = `${timeText(Math.max(0, t - c.from))} <span>/ ${timeText(c.to - c.from)}</span>`;
  document.querySelectorAll('.seg').forEach(seg => { seg.firstElementChild.style.width = `${clamp((t - Number(seg.dataset.from)) / Number(seg.dataset.span), 0, 1) * 100}%`; });
  $('knob').style.left = `${clamp((t - c.from) / (c.to - c.from), 0, 1) * 100}%`;
}
/** The scrub bar is the clip playing now, its questions marked on it. */
function showClipBar(k) {
  const box = $('scrub');
  const c = clips[k];
  box.querySelectorAll('.seg, .tick').forEach(node => node.remove());
  const seg = div('seg');
  seg.dataset.from = c.from; seg.dataset.span = c.to - c.from;
  seg.style.flex = '1 1 0';
  seg.append(document.createElement('i'), document.createElement('u'));
  box.append(seg);
  scenes.forEach((scene, index) => {
    if (!scene.check || skipped(scene) || scene.start < c.from || scene.start >= c.to) return;
    const tick = div('tick');
    tick.dataset.scene = index;
    tick.style.left = `${((scene.start - c.from) / (c.to - c.from)) * 100}%`;
    const option = quizById.get(scene.check).options[answers.get(scene.check)];
    if (option) tick.classList.add(option.right ? 'right' : 'wrong');
    box.append(tick);
  });
}
function wireScrub() {
  const box = $('scrub');
  const timeOf = event => { const r = box.getBoundingClientRect(); const c = clips[shownClip]; return c.from + clamp((event.clientX - r.left) / r.width, 0, 1) * (c.to - c.from - 0.1); };
  const hover = event => {
    const t = timeOf(event), r = box.getBoundingClientRect();
    const scene = scenes[sceneAt(t)];
    const tip = $('tip');
    tip.innerHTML = '';
    const stamp = document.createElement('b'); stamp.textContent = timeText(t);
    tip.append(stamp, scene.check ? 'Quick check' : scene.title);
    tip.style.left = `${clamp(event.clientX - r.left, 90, r.width - 90)}px`;
    document.querySelectorAll('.seg').forEach(seg => { seg.children[1].style.width = `${clamp((t - Number(seg.dataset.from)) / Number(seg.dataset.span), 0, 1) * 100}%`; });
  };
  box.addEventListener('pointermove', event => { hover(event); if (dragging) { pinned = timeOf(event); syncTo(pinned, true); } });
  box.addEventListener('pointerleave', () => { document.querySelectorAll('.seg u').forEach(u => { u.style.width = 0; }); });
  box.addEventListener('pointerdown', event => {
    box.setPointerCapture(event.pointerId);
    dragging = true;
    box.classList.add('drag');
    sound.pause();
    pinned = timeOf(event);
    syncTo(pinned, true);
  });
  const release = () => { if (!dragging) return; dragging = false; box.classList.remove('drag'); seek(pinned); wake(); };
  box.addEventListener('pointerup', release);
  box.addEventListener('pointercancel', release);
}
/** The clips drawer: each clip with its length, the one playing, and those you've watched. */
function buildClips() {
  if (outer) {
    // An explainer's playlist: every clip in the depth picked, each opening its own video.
    const kept = recall(explainId);
    inDepth.forEach(c => {
      const button = document.createElement('button');
      button.className = 'chapter';
      button.classList.toggle('now', c.n === clipN);
      button.classList.toggle('done', Boolean(kept.done?.[c.n]));
      const state = document.createElement('small'); state.textContent = c.state === 'ready' ? String(c.n) : `${c.n} ·`;
      const text = document.createElement('span'); text.textContent = c.title + (c.state === 'ready' ? '' : ` (${{ making: 'being made', later: 'not in this file yet' }[c.state] || 'waiting'})`);
      button.append(state, text);
      button.disabled = c.state === 'later';
      button.addEventListener('click', () => goToClip(c.n));
      $('chapters').append(button);
    });
    return;
  }
  clips.forEach((c, k) => {
    const button = document.createElement('button');
    button.className = 'chapter';
    button.dataset.clip = k;
    const time = document.createElement('small'); time.textContent = timeText(c.to - c.from);
    const text = document.createElement('span'); text.textContent = c.name;
    button.append(time, text);
    button.addEventListener('click', () => { jump(c.from); toggleDrawer(false); });
    $('chapters').append(button);
  });
}
function showRail() {
  if (outer) { if (shownClip >= 0) drawMap(shownClip); return; }
  document.querySelectorAll('.chapter').forEach(node => {
    const k = Number(node.dataset.clip);
    node.classList.toggle('now', k === shownClip);
    node.classList.toggle('done', clips[k].done);
  });
  if (shownClip >= 0) drawMap(shownClip);
}
function toggleDrawer(open) { $('drawer').classList.toggle('open', open ?? !$('drawer').classList.contains('open')); wake(); }
function setRate(value, save = true) {
  rate = value;
  sound.playbackRate = rate;
  $('speed').textContent = `${rate}x`;
  $('speedMenu').hidden = true;
  [...$('speedMenu').children].forEach(button => button.classList.toggle('on', Number(button.dataset.rate) === rate));
  if (save) savePrefs();
}
function nudgeRate(step) { const all = [0.75, 1, 1.25, 1.5, 1.75, 2]; setRate(all[clamp(all.indexOf(rate) + step, 0, all.length - 1)]); }
function setVolume(value) { sound.volume = clamp(value, 0, 1); sound.muted = sound.volume === 0; $('volume').value = sound.volume; showSound(); }
function toggleSound() { sound.muted = !sound.muted; showSound(); }
function showSound() { $('mute').innerHTML = icon(sound.muted ? 'muted' : 'sound'); }
/**
 * Questions on or off, for this video and as Learn's setting (new videos are made by it). Turning
 * them off mid-question leaves that question, masked line or played-out answer and plays on.
 */
function setQuestions(on, save = true) {
  if (!hasQuestions) return;
  wantQuestions = on;
  $('questions').classList.toggle('off', !on);
  $('questions').title = on ? 'Questions are on (Q)' : 'Questions are off (Q)';
  if (on) cancelAdvance();
  else if (mode === 'opener') endOpener();
  else if (activeMask) { revealed.add(maskKey(activeMask.scene, activeMask.mask.id)); hideMask(); mode = 'main'; if (playing) sound.play().catch(() => {}); }
  else if (mode === 'held' || mode === 'extra') leaveQuestion();
  const scene = scenes[shownScene];
  if (scene) {
    showQuiz(scene);
    applyState(unmasked(scene.states[Math.max(0, shownCue)], shownScene), true);
  }
  if (shownClip >= 0) showClipBar(shownClip);
  if (save) saveQuestions(on);
  wake();
}
function toggleCaptions(save = true) { showCaptions = !showCaptions; $('cc').classList.toggle('off', !showCaptions); $('captions').classList.toggle('off', !showCaptions); if (save) savePrefs(); }

// Speed and subtitles carry over to every video (data.js keeps them).
async function loadPrefs() {
  const saved = await readPrefs();
  if (typeof saved?.videoRate === 'number') setRate(saved.videoRate, false);
  if (saved?.videoCaptions === false && showCaptions) toggleCaptions(false);
}
function savePrefs() { writePrefs({ videoRate: rate, videoCaptions: showCaptions }); }
function toggleFull() { if (!document.fullscreenEnabled) return; if (document.fullscreenElement) document.exitFullscreen(); else frame.requestFullscreen().catch(() => {}); }
function fit() {
  const w = frame.clientWidth, h = frame.clientHeight;
  const k = Math.min(w / 1120, h / 630);
  $('stage').style.transform = `translate(${(w - 1120 * k) / 2}px, ${(h - 630 * k) / 2}px) scale(${k})`;
  frame.style.setProperty('--k', k);
}

$('pageTitle').textContent = V.title;
$('courseTitle').textContent = V.courseTitle || 'Learn';
document.title = `${V.title}: video`;
if (V.stale) {
  $('note').hidden = false;
  $('note').textContent = 'This page changed since the video was made.';
}
$('full').hidden = !document.fullscreenEnabled;
$('coverTitle').textContent = V.title;
$('coverMeta').textContent = outer ? `Clip ${inDepth.findIndex(c => c.n === clipN) + 1} of ${inDepth.length} · ${timeText(total)}` : `${clips.length} clips, ${Math.round(total / 60)} minutes${questionsOn() ? `, ${quiz.length} questions` : ''}`;
$('coverPlay').innerHTML = icon('play');
$('coverPlay').addEventListener('click', () => (coverAction ? coverAction() : setPlaying(true)));
$('coverAgain').addEventListener('click', () => { if (againClip >= 0) jump(clips[againClip].from); });
$('play').innerHTML = icon('play');
$('back').innerHTML = icon('back');
$('forward').innerHTML = icon('forward');
$('captions').innerHTML = icon('cc');
$('questions').innerHTML = icon('questions');
$('questions').classList.toggle('off', !questionsOn());
$('questions').disabled = !hasQuestions;
$('questions').title = !hasQuestions ? 'This video was made without questions' : wantQuestions ? 'Questions are on (Q)' : 'Questions are off (Q)';
$('chaptersButton').innerHTML = icon('list');
$('full').innerHTML = icon('full');
showSound();
$('play').addEventListener('click', () => setPlaying(!playing));
$('back').addEventListener('click', () => seekInClip(clockNow() - 10));
$('forward').addEventListener('click', () => seekInClip(clockNow() + 10));
$('mute').addEventListener('click', toggleSound);
$('volume').addEventListener('input', event => setVolume(Number(event.target.value)));
$('captions').addEventListener('click', toggleCaptions);
$('questions').addEventListener('click', () => setQuestions(!wantQuestions));
$('chaptersButton').addEventListener('click', () => toggleDrawer());
$('full').addEventListener('click', toggleFull);
$('speed').addEventListener('click', () => { $('speedMenu').hidden = !$('speedMenu').hidden; wake(); });
[2, 1.75, 1.5, 1.25, 1, 0.75].forEach(value => {
  const button = document.createElement('button');
  button.textContent = `${value}x`;
  button.dataset.rate = value;
  button.classList.toggle('on', value === 1);
  button.addEventListener('click', () => setRate(value));
  $('speedMenu').append(button);
});
frame.addEventListener('pointermove', wake, { signal });
$('stage').addEventListener('click', event => {
  if (event.target.closest('.quiz') || $('drawer').classList.contains('open')) { toggleDrawer(false); return; }
  setPlaying(!playing);
  $('speedMenu').hidden = true;
});
$('stage').addEventListener('dblclick', toggleFull);

document.addEventListener('keydown', event => {
  if (event.target.tagName === 'INPUT' || event.ctrlKey || event.metaKey || event.altKey) return;
  const scene = scenes[shownScene];
  const key = event.key.toLowerCase();
  const asking = scene.check && !skipped(scene) && !answers.has(scene.check);
  wake();
  if ((key === ' ' || key === 'k') && advanceTimer) { event.preventDefault(); cancelAdvance(); }
  else if (key === ' ' || key === 'k') { event.preventDefault(); if (document.activeElement) document.activeElement.blur(); if (scene.check && answers.has(scene.check) && mode !== 'main') leaveQuestion(); else setPlaying(!playing); }
  else if (key === 'arrowleft') seekInClip(clockNow() - 5);
  else if (key === 'arrowright') seekInClip(clockNow() + 5);
  else if (key === 'j') seekInClip(clockNow() - 10);
  else if (key === 'l') seekInClip(clockNow() + 10);
  else if (key === 'arrowup') { event.preventDefault(); setVolume(sound.volume + 0.1); }
  else if (key === 'arrowdown') { event.preventDefault(); setVolume(sound.volume - 0.1); }
  else if (key === 'm') toggleSound();
  else if (key === 'c') toggleCaptions();
  else if (key === 'q') setQuestions(!wantQuestions);
  else if (key === 'f') toggleFull();
  else if (key === 'g') toggleDrawer();
  else if (key === '>' ) nudgeRate(1);
  else if (key === '<') nudgeRate(-1);
  else if (key === ']') { if (shownClip < clips.length - 1) jump(clips[shownClip + 1].from); }
  else if (key === '[') { const c = clips[shownClip]; jump(clockNow() - c.from > 3 || !shownClip ? c.from : clips[shownClip - 1].from); }
  else if (key === 'enter' && !$('cover').hidden) (coverAction ? coverAction() : setPlaying(true));
  else if (key === 'enter') document.getElementById('continue')?.click();
  else if (activeMask && !maskPicks.has(maskKey(activeMask.scene, activeMask.mask.id)) && /^[1-3]$/.test(key)) pickMask(Number(key) - 1);
  else if (asking && key === 'n' && quizById.get(scene.check)?.guess) { event.preventDefault(); notSure(); } // the wiki's own N opens its notepad
  else if (asking && /^[1-5]$/.test(key)) { const k = quizById.get(scene.check).order?.[Number(key) - 1]; if (k !== undefined) answer(k); }
}, { signal });

const resized = new ResizeObserver(fit);
resized.observe(frame);
signal.addEventListener('abort', () => resized.disconnect());
fit();
wireScrub();
buildClips();
seek(0, false); // past a hidden question the video opens on
loadPrefs();
// A guess answered while this clip was being made: played out now, from where it leads.
const keptGuess = outer ? recall(explainId).guesses?.[clipN] : null;
const firstGuess = quiz.find(q => q.guess);
// An explainer's clip starts by itself: after the guess kept while it was made, or straight away
// with questions off. The card hides only once the sound plays: a browser that won't play sound
// on a page nobody has clicked keeps the card and its play button.
const autoStart = () => sound.play().then(() => setPlaying(true, true), () => {});
if (questionsOn() && keptGuess && firstGuess && scenes[shownScene]?.check === firstGuess.id) {
  if (keptGuess.unsure) { answers.set(firstGuess.id, null); leaveQuestion(); }
  else answer(keptGuess.k);
  autoStart();
} else if (outer && !questionsOn()) autoStart();
// An open clip says where you are every minute: the job makes that clip first, and one whose
// process died (a reboot) carries on.
if (outer) {
  const here = setInterval(() => explainAt(explainId, { n: clipN }).catch(() => {}), 60_000);
  signal.addEventListener('abort', () => clearInterval(here));
}
loop();

// For stills of a moment: tools/shoot.mjs --eval "player.hold(120)".
// player.endClip(k) shows the card at the end of clip k.
window.player = { hold: t => { $('cover').hidden = true; dragging = true; pinned = t; syncTo(t, true); showFrame(t); }, endClip, scenes, clips, sound, plan, openers: openersOf,
  // player.questions(on): turns questions on or off without saving it, for stills.
  questions: on => setQuestions(on, false),
  // player.mask(): the masked line's pick, at the moment it holds (after player.hold), for stills.
  mask: () => { const scene = scenes[shownScene]; if (scene.masks?.[0]) showMask(scene.masks[0]); },
  // player.opener(qid, k, t): a moment of an opener, for stills.
  opener: (id, k, t) => { const scene = openersOf[id][k]; $('cover').hidden = true; dragging = true; openerScene = scene; openerCue = -1; mode = 'opener'; $('quiz').hidden = true; showWrongTurn(true); pinned = scene.start + t; syncOpener(scene.start + t, true); showFrame(scene.start + t); } };
