// The video player: the audio is the clock, and every picture, word and question follows it.
// A video is a playlist of clips, one per section: each stops at its end, and the next starts when
// you say so. Opened as /learn/video/?course=<id>&page=<n>. An answer goes through check.answer, as on the
// page, so it counts towards Review. The audio can't send a header, so it's fetched and played from
// a Blob. Keeping the event stream open stops the server idling out during a long video.
import { onEvents, rpc, token } from '../../shared/api.js';
import { buildCameras, buildStates, sceneAt as sceneIndex } from './model.mjs';
import { applyState, initStage, stepObjects } from './stage.js';

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
};
const icon = name => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;

const query = new URLSearchParams(location.search);
const courseId = query.get('course');
const pageN = Number(query.get('page'));

/** Stops here with a plain sentence where the video would be. */
function giveUp(text) {
  $('frame').hidden = true;
  $('note').hidden = false;
  $('note').textContent = text;
  throw new Error(text);
}

async function load() {
  if (!courseId || !Number.isInteger(pageN)) giveUp('This link names no video.');
  onEvents(() => {});
  try {
    const video = await rpc('video.get', { courseId, n: pageN });
    const response = await fetch(`/api/video-audio?course=${encodeURIComponent(courseId)}&page=${pageN}`, { headers: { 'X-Learn-Token': token } });
    if (!response.ok) throw new Error('its sound is missing');
    return { video, blob: new Blob([await response.arrayBuffer()], { type: 'audio/mpeg' }) };
  } catch (error) {
    return giveUp(`This video can't play: ${error.message}`);
  }
}

const { video: V, blob } = await load();
const { scenes, assets, quiz, sections, audio: track } = V;
const quizById = new Map(quiz.map(q => [q.id, q]));
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
  // A question flagged as wrong since the video was made is passed over.
  scene.skip = Boolean(scene.check) && !quizById.has(scene.check);
}
const sceneAt = t => sceneIndex(scenes, t);

let shownScene = -1, shownCue = -1;
let cam = { x: 560, y: 298, zoom: 1 }, camFrom = cam, camTo = cam, camT0 = 0;

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
  $('section').textContent = `${clipAt(scene.start) + 1} of ${clips.length} · ${scene.section}`;
  $('title').textContent = scene.title;
  head.classList.remove('swap'); void head.offsetWidth; head.classList.add('swap');
  showWrongTurn(Boolean(scene.trap));
  showQuiz(scene);
}
function showClip(k) {
  shownClip = k;
  $('nowChapter').textContent = `${k + 1}/${clips.length} · ${clips[k].name}`;
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
function clipsInBox(id) {
  return clips.filter(c => { const box = planClip(c.name)?.box; return box === id || plan.boxes.find(b => b.id === box)?.parent === id; });
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
    cell.classList.toggle('done', mine.length > 0 && mine.every(c => c.done || c.skipped));
    cell.classList.toggle('skipped', mine.length > 0 && mine.every(c => c.skipped));
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
  if (![...state.values()].some(o => o.mask !== undefined && revealed.has(maskKey(s, o.id)))) return state;
  return new Map([...state].map(([id, o]) => [id, o.mask !== undefined && revealed.has(maskKey(s, id)) ? { ...o, mask: undefined } : o]));
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
const sound = new Audio(URL.createObjectURL(blob));
sound.preload = 'auto';
sound.preservesPitch = true;
let playing = false, rate = 1, dragging = false, mode = 'main', pinned = 0, extra = null, sleepTimer = 0, againClip = -1;
const answers = new Map(); // question id: the option picked, or null for "Not sure"
const picked = new Map(); // a guess picked, waiting on how sure you were
const sure = new Map();
const clockNow = () => ((mode === 'main' || mode === 'opener') && !dragging ? sound.currentTime : pinned);

function setPlaying(on, quiet = false) {
  playing = on;
  $('play').innerHTML = icon(on ? 'pause' : 'play');
  if (on) { $('cover').hidden = true; if (mode !== 'held') sound.play().catch(() => setPlaying(false)); } else sound.pause();
  if (!quiet) flash(on);
  if (on && mode === 'main' && shownClip >= 0 && clockNow() - clips[shownClip].from < 0.6) showHandoff(shownClip);
  wake();
}
function seek(t, keepPlaying = true) {
  if (openerScene) { openerScene = null; showWrongTurn(false); }
  if (activeMask) hideMask();
  mode = 'main';
  pinned = clamp(t, 0, total - 0.05);
  sound.currentTime = pinned;
  syncTo(pinned, true);
  showFrame(pinned);
  if (playing && keepPlaying) sound.play().catch(() => {});
}
/** Jumps within the clip playing now: a clip's edges are where it stops, not places to slip past. */
function seekInClip(t) { const c = clips[shownClip]; seek(clamp(t, c.from, c.to - 0.1)); }
/** Goes to a clip you picked, and plays it. */
function jump(t) { $('cover').hidden = true; seek(t); if (!playing) setPlaying(true, true); }
function watch(t) {
  if (mode === 'extra' && sound.currentTime >= extra.end - 0.03) { sound.pause(); mode = 'held'; }
  if (mode === 'opener' && !dragging && sound.currentTime >= openerScene.end - 0.03) { endOpener(); return; }
  if (!playing || mode !== 'main' || dragging) return;
  const scene = scenes[shownScene];
  if (scene.skip) { if (endsClip(scene)) endClip(clipAt(scene.start)); else sound.currentTime = scene.end + 0.02; return; }
  if (scene.check && t >= scene.end - 0.05 && !answers.has(scene.check)) { sound.pause(); mode = 'held'; pinned = scene.end - 0.06; return; }
  const mask = (scene.masks || []).find(item => item.until !== undefined && !maskPicks.has(maskKey(shownScene, item.id)) && t >= item.until - 0.05);
  if (mask) { sound.pause(); mode = 'held'; pinned = mask.until - 0.06; showMask(mask); return; }
  if (t >= clips[clipAt(t)].to - 0.05) endClip(clipAt(t));
}
/** A clip's end: it stops, waiting on the next clip's first picture until you say go. */
function endClip(k) {
  clips[k].done = true;
  clips[k].skipped = false;
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
}
function finish() {
  setPlaying(false, true);
  const right = [...answers.entries()].filter(([id, k]) => quizById.get(id).options[k]?.right).length;
  answers.clear();
  picked.clear();
  sure.clear();
  maskPicks.clear();
  revealed.clear();
  clips.forEach(c => { c.done = false; c.skipped = false; });
  seek(0, false);
  $('coverTitle').textContent = 'That is everything on this page.';
  $('coverMeta').textContent = `${right} of ${quiz.length} questions right`;
  $('coverPlay').title = 'Watch again';
  $('coverAgain').hidden = true;
  $('cover').hidden = false;
}

// --- Questions -------------------------------------------------------------------------
function showQuiz(scene) {
  const box = $('quiz');
  box.hidden = !scene.check || scene.skip;
  if (box.hidden) return;
  const q = quizById.get(scene.check);
  box.replaceChildren();
  box.append(div('quiz-tag', q.guess ? 'Guess first' : q.group ? 'Putting it together' : 'Quick check'), div('quiz-q', q.q));
  const order = q.order || (q.order = q.options.map((_, k) => k).sort(() => Math.random() - 0.5));
  const answered = answers.get(q.id);
  const done = answers.has(q.id);
  const waiting = picked.get(q.id);
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
    const { node, text } = button('option', String(place + 1), option.text, done || waiting !== undefined ? null : () => (q.guess ? pick(k) : answer(k)));
    if (waiting === k) node.classList.add('picked');
    if (!done) return;
    if (option.right) node.classList.add('right');
    if (k === answered && !option.right) node.classList.add('wrong');
    if (option.right || k === answered) { const why = document.createElement('span'); why.className = 'why'; why.textContent = option.why; text.append(why); }
  });
  // Not sure is an answer too: the clip plays from its start, nothing played out.
  if (q.guess && !done && waiting === undefined) button('option unsure', 'N', 'Not sure', notSure);
  const foot = div('quiz-foot');
  const primary = (label, onClick) => { const go = document.createElement('button'); go.className = 'primary'; go.textContent = label; go.id = 'continue'; go.addEventListener('click', onClick); foot.append(go); };
  const quiet = (label, onClick) => { const node = document.createElement('button'); node.className = 'quiet'; node.textContent = label; node.addEventListener('click', onClick); foot.append(node); };
  if (waiting !== undefined) {
    foot.append(div('quiz-ask', 'How sure were you?'));
    quiet('1 · I knew it', () => settle(true));
    quiet('2 · I guessed', () => settle(false));
  } else if (!done) quiet('Skip', leaveQuestion);
  else if (answered === null) primary('Continue', leaveQuestion);
  else {
    const right = q.options[answered].right;
    // Right, and you knew it: the clip is offered to skip. It stays in the list, one click back.
    if (q.guess && right && sure.get(q.id)) { primary('Skip this clip', skipClip); quiet('Watch it anyway', leaveQuestion); }
    else primary('Continue', leaveQuestion);
    foot.append(div(`quiz-result ${right ? 'good' : 'bad'}`, right ? 'Right' : 'Not quite'));
  }
  box.append(foot);
}
/** A guess: the pick first, then how sure you were, and only then whether it was right. */
function pick(k) {
  const q = quizById.get(scenes[shownScene].check);
  if (!q || answers.has(q.id)) return;
  picked.set(q.id, k);
  showQuiz(scenes[shownScene]);
}
function settle(knew) {
  const q = quizById.get(scenes[shownScene].check);
  if (!q || !picked.has(q.id)) return;
  sure.set(q.id, knew);
  const k = picked.get(q.id);
  picked.delete(q.id);
  answer(k);
}
function notSure() {
  const q = quizById.get(scenes[shownScene].check);
  if (!q || answers.has(q.id)) return;
  answers.set(q.id, null);
  leaveQuestion();
}
function skipClip() {
  const k = clipAt(scenes[shownScene].start);
  clips[k].skipped = true;
  mode = 'main';
  if (k >= clips.length - 1) { showRail(); return finish(); }
  jump(clips[k + 1].from);
}
function answer(k) {
  const scene = scenes[shownScene];
  const q = quizById.get(scene.check);
  if (!q || answers.has(q.id)) return;
  answers.set(q.id, k);
  // Counted as on the page. A question gone since the video was made just isn't recorded; a
  // clip's own guess is the video's alone and never goes to Review.
  if (!q.videoOnly) rpc('check.answer', { courseId, n: pageN, id: q.id, choice: k }).catch(() => {});
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
  const kc = ease(clamp((now - camT0) / 1000, 0, 1));
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
    if (!scene.check || scene.skip || scene.start < c.from || scene.start >= c.to) return;
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
  document.querySelectorAll('.chapter').forEach(node => {
    const k = Number(node.dataset.clip);
    node.classList.toggle('now', k === shownClip);
    node.classList.toggle('done', clips[k].done);
    node.classList.toggle('skipped', Boolean(clips[k].skipped));
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
function toggleCaptions(save = true) { showCaptions = !showCaptions; $('cc').classList.toggle('off', !showCaptions); $('captions').classList.toggle('off', !showCaptions); if (save) savePrefs(); }

// Speed and subtitles carry over to every video. Kept by the server, since the port, and so the
// browser's storage, changes with each start; the server keeps the page's own prefs beside these.
async function loadPrefs() {
  try {
    const response = await fetch('/api/prefs', { headers: { 'X-Learn-Token': token } });
    const saved = response.ok ? await response.json() : null;
    if (typeof saved?.videoRate === 'number') setRate(saved.videoRate, false);
    if (saved?.videoCaptions === false && showCaptions) toggleCaptions(false);
  } catch {}
}
function savePrefs() {
  fetch('/api/prefs', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Learn-Token': token }, body: JSON.stringify({ videoRate: rate, videoCaptions: showCaptions }), keepalive: true }).catch(() => {});
}
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
$('coverMeta').textContent = `${clips.length} clips, ${Math.round(total / 60)} minutes, ${quiz.length} questions`;
$('coverPlay').innerHTML = icon('play');
$('coverPlay').addEventListener('click', () => setPlaying(true));
$('coverAgain').addEventListener('click', () => { if (againClip >= 0) jump(clips[againClip].from); });
$('play').innerHTML = icon('play');
$('back').innerHTML = icon('back');
$('forward').innerHTML = icon('forward');
$('captions').innerHTML = icon('cc');
$('chaptersButton').innerHTML = icon('list');
$('full').innerHTML = icon('full');
showSound();
$('play').addEventListener('click', () => setPlaying(!playing));
$('back').addEventListener('click', () => seekInClip(clockNow() - 10));
$('forward').addEventListener('click', () => seekInClip(clockNow() + 10));
$('mute').addEventListener('click', toggleSound);
$('volume').addEventListener('input', event => setVolume(Number(event.target.value)));
$('captions').addEventListener('click', toggleCaptions);
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
frame.addEventListener('pointermove', wake);
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
  const asking = scene.check && !answers.has(scene.check);
  wake();
  if (key === ' ' || key === 'k') { event.preventDefault(); if (document.activeElement) document.activeElement.blur(); if (scene.check && answers.has(scene.check) && mode !== 'main') leaveQuestion(); else setPlaying(!playing); }
  else if (key === 'arrowleft') seekInClip(clockNow() - 5);
  else if (key === 'arrowright') seekInClip(clockNow() + 5);
  else if (key === 'j') seekInClip(clockNow() - 10);
  else if (key === 'l') seekInClip(clockNow() + 10);
  else if (key === 'arrowup') { event.preventDefault(); setVolume(sound.volume + 0.1); }
  else if (key === 'arrowdown') { event.preventDefault(); setVolume(sound.volume - 0.1); }
  else if (key === 'm') toggleSound();
  else if (key === 'c') toggleCaptions();
  else if (key === 'f') toggleFull();
  else if (key === 'g') toggleDrawer();
  else if (key === '>' ) nudgeRate(1);
  else if (key === '<') nudgeRate(-1);
  else if (key === ']') { if (shownClip < clips.length - 1) jump(clips[shownClip + 1].from); }
  else if (key === '[') { const c = clips[shownClip]; jump(clockNow() - c.from > 3 || !shownClip ? c.from : clips[shownClip - 1].from); }
  else if (key === 'enter' && !$('cover').hidden) setPlaying(true);
  else if (key === 'enter') document.getElementById('continue')?.click();
  else if (activeMask && !maskPicks.has(maskKey(activeMask.scene, activeMask.mask.id)) && /^[1-3]$/.test(key)) pickMask(Number(key) - 1);
  else if (asking && picked.has(scene.check) && (key === '1' || key === '2')) settle(key === '1');
  else if (asking && !picked.has(scene.check) && key === 'n' && quizById.get(scene.check)?.guess) notSure();
  else if (asking && !picked.has(scene.check) && /^[1-5]$/.test(key)) { const q = quizById.get(scene.check); const k = q.order?.[Number(key) - 1]; if (k !== undefined) (q.guess ? pick(k) : answer(k)); }
});

new ResizeObserver(fit).observe(frame);
fit();
wireScrub();
buildClips();
syncTo(0, true);
loadPrefs();
loop();

// For stills of a moment: tools/shoot.mjs --eval "player.hold(120)".
// player.endClip(k) shows the card at the end of clip k.
window.player = { hold: t => { $('cover').hidden = true; dragging = true; pinned = t; syncTo(t, true); showFrame(t); }, endClip, scenes, clips, sound, plan, openers: openersOf,
  // player.mask(): the masked line's pick, at the moment it holds (after player.hold), for stills.
  mask: () => { const scene = scenes[shownScene]; if (scene.masks?.[0]) showMask(scene.masks[0]); },
  // player.opener(qid, k, t): a moment of an opener, for stills.
  opener: (id, k, t) => { const scene = openersOf[id][k]; $('cover').hidden = true; dragging = true; openerScene = scene; openerCue = -1; mode = 'opener'; $('quiz').hidden = true; showWrongTurn(true); pinned = scene.start + t; syncOpener(scene.start + t, true); showFrame(scene.start + t); } };
