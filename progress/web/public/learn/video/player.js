// The video player: the audio is the clock, and every picture, word and question follows it.
// Opened as /learn/video/?course=<id>&page=<n>. An answer goes through check.answer, as on the
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
  const s = sceneAt(t);
  const scene = scenes[s];
  let c = 0;
  while (c < (scene.cues || []).length && scene.cues[c].t <= t) c += 1;
  if (s === shownScene && c === shownCue) return;
  const newScene = s !== shownScene;
  shownScene = s; shownCue = c;
  applyState(scene.states[c], instant);
  camFrom = instant ? scene.cameras[c] : { ...cam };
  camTo = scene.cameras[c];
  camT0 = performance.now();
  if (instant) cam = camTo;
  if (newScene) showHead(scene);
}
function showHead(scene) {
  const head = $('head');
  $('section').textContent = scene.section;
  $('title').textContent = scene.title;
  $('nowChapter').textContent = scene.section;
  head.classList.remove('swap'); void head.offsetWidth; head.classList.add('swap');
  document.querySelectorAll('.chapter').forEach(node => node.classList.toggle('now', node.dataset.section === scene.section));
  showQuiz(scene);
}

// --- Sound and time --------------------------------------------------------------------
const sound = new Audio(URL.createObjectURL(blob));
sound.preload = 'auto';
sound.preservesPitch = true;
let playing = false, rate = 1, dragging = false, mode = 'main', pinned = 0, clip = null, sleepTimer = 0;
const answers = new Map();
const clockNow = () => (mode === 'main' && !dragging ? sound.currentTime : pinned);

function setPlaying(on) {
  playing = on;
  $('play').innerHTML = icon(on ? 'pause' : 'play');
  if (on) { $('cover').hidden = true; if (mode !== 'held') sound.play().catch(() => setPlaying(false)); } else sound.pause();
  flash(on);
  wake();
}
function seek(t, keepPlaying = true) {
  mode = 'main';
  pinned = clamp(t, 0, total - 0.05);
  sound.currentTime = pinned;
  syncTo(pinned, true);
  showFrame(pinned);
  if (playing && keepPlaying) sound.play().catch(() => {});
}
function watch(t) {
  if (mode === 'extra' && sound.currentTime >= clip.end - 0.03) { sound.pause(); mode = 'held'; }
  if (!playing || mode !== 'main' || dragging) return;
  const scene = scenes[shownScene];
  if (scene.skip) { sound.currentTime = scene.end + 0.02; return; }
  if (scene.check && t >= scene.end - 0.05 && !answers.has(scene.check)) { sound.pause(); mode = 'held'; pinned = scene.end - 0.06; }
  if (t >= total - 0.05) finish();
}
function finish() {
  setPlaying(false);
  const right = [...answers.entries()].filter(([id, k]) => quizById.get(id).options[k].right).length;
  $('coverTitle').textContent = 'That is everything on this page.';
  $('coverMeta').textContent = `${right} of ${quiz.length} questions right`;
  $('coverPlay').title = 'Watch again';
  $('cover').hidden = false;
  answers.clear();
  document.querySelectorAll('.tick').forEach(tick => tick.classList.remove('right', 'wrong'));
  seek(0, false);
}

// --- Questions -------------------------------------------------------------------------
function showQuiz(scene) {
  const box = $('quiz');
  box.hidden = !scene.check || scene.skip;
  if (box.hidden) return;
  const q = quizById.get(scene.check);
  box.replaceChildren();
  box.append(div('quiz-tag', q.guess ? 'Guess first' : 'Quick check'), div('quiz-q', q.q));
  const order = q.order || (q.order = q.options.map((_, k) => k).sort(() => Math.random() - 0.5));
  const answered = answers.get(q.id);
  order.forEach((k, place) => {
    const option = q.options[k];
    const button = document.createElement('button');
    button.className = 'option';
    const key = document.createElement('span'); key.className = 'key'; key.textContent = String(place + 1);
    const text = document.createElement('span'); text.textContent = option.text;
    button.append(key, text);
    if (answered !== undefined) {
      button.disabled = true;
      if (option.right) button.classList.add('right');
      if (k === answered && !option.right) button.classList.add('wrong');
      if (option.right || k === answered) { const why = document.createElement('span'); why.className = 'why'; why.textContent = option.why; text.append(why); }
    } else button.addEventListener('click', () => answer(k));
    box.append(button);
  });
  const foot = div('quiz-foot');
  if (answered === undefined) {
    const skip = document.createElement('button'); skip.className = 'quiet'; skip.textContent = 'Skip'; skip.addEventListener('click', leaveQuestion);
    foot.append(skip);
  } else {
    const go = document.createElement('button'); go.className = 'primary'; go.textContent = 'Continue'; go.id = 'continue'; go.addEventListener('click', leaveQuestion);
    const right = q.options[answered].right;
    foot.append(go, div(`quiz-result ${right ? 'good' : 'bad'}`, right ? 'Right' : 'Not quite'));
  }
  box.append(foot);
}
function answer(k) {
  const scene = scenes[shownScene];
  const q = quizById.get(scene.check);
  if (!q || answers.has(q.id)) return;
  answers.set(q.id, k);
  // Counted as on the page. A question gone since the video was made just isn't recorded.
  rpc('check.answer', { courseId, n: pageN, id: q.id, choice: k }).catch(() => {});
  showQuiz(scene);
  const right = q.options[k].right;
  const tick = document.querySelector(`.tick[data-scene="${shownScene}"]`);
  if (tick) tick.classList.add(right ? 'right' : 'wrong');
  clip = track.extras[q.id][right ? 'right' : 'wrong'];
  pinned = scene.end - 0.06;
  mode = 'extra';
  sound.currentTime = clip.start;
  if (playing) sound.play().catch(() => {});
}
function leaveQuestion() {
  const scene = scenes[shownScene];
  mode = 'main';
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
  if (scenes[shownScene]?.check || !$('cover').hidden) { if (shownPhrase !== -1) drawPhrase(-1); return; }
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
  const scene = scenes[shownScene];
  const kc = ease(clamp((now - camT0) / 1000, 0, 1));
  cam = { x: camFrom.x + (camTo.x - camFrom.x) * kc, y: camFrom.y + (camTo.y - camFrom.y) * kc, zoom: camFrom.zoom + (camTo.zoom - camFrom.zoom) * kc };
  // A slow push-in through every scene, so the picture is never quite still.
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const span = Math.max(1, scene.end - scene.start);
  const zoom = cam.zoom * (still ? 1 : 1 + 0.02 * clamp((t - scene.start) / span, 0, 1));
  $('camera').style.transform = `translate(${560 - cam.x * zoom}px, ${298 - cam.y * zoom}px) scale(${zoom})`;
  showCaption(t);
  showClock(t);
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
  $('clock').innerHTML = `${timeText(t)} <span>/ ${timeText(total)}</span>`;
  document.querySelectorAll('.seg').forEach(seg => { seg.firstElementChild.style.width = `${clamp((t - Number(seg.dataset.from)) / Number(seg.dataset.span), 0, 1) * 100}%`; });
  $('knob').style.left = `${(t / total) * 100}%`;
}
function buildScrub() {
  const box = $('scrub');
  sections.forEach(name => {
    const own = scenes.filter(scene => scene.section === name);
    if (!own.length) return;
    const from = own[0].start, to = own.at(-1).end, span = to - from;
    const seg = div('seg');
    seg.dataset.from = from; seg.dataset.span = span;
    seg.style.flex = `${span} 1 0`;
    seg.append(document.createElement('i'), document.createElement('u'));
    box.append(seg);
  });
  scenes.forEach((scene, k) => {
    if (!scene.check || scene.skip) return;
    const tick = div('tick');
    tick.dataset.scene = k;
    tick.style.left = `${(scene.start / total) * 100}%`;
    box.append(tick);
  });
  const timeOf = event => { const r = box.getBoundingClientRect(); return clamp((event.clientX - r.left) / r.width, 0, 1) * total; };
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
function buildChapters() {
  sections.forEach(name => {
    const first = scenes.find(scene => scene.section === name);
    if (!first) return;
    const button = document.createElement('button');
    button.className = 'chapter';
    button.dataset.section = name;
    const time = document.createElement('small'); time.textContent = timeText(first.start);
    const text = document.createElement('span'); text.textContent = name;
    button.append(time, text);
    button.addEventListener('click', () => { seek(first.start); toggleDrawer(false); });
    $('chapters').append(button);
  });
}
function toggleDrawer(open) { $('drawer').classList.toggle('open', open ?? !$('drawer').classList.contains('open')); wake(); }
function setRate(value) {
  rate = value;
  sound.playbackRate = rate;
  $('speed').textContent = `${rate}x`;
  $('speedMenu').hidden = true;
  [...$('speedMenu').children].forEach(button => button.classList.toggle('on', Number(button.dataset.rate) === rate));
}
function nudgeRate(step) { const all = [0.75, 1, 1.25, 1.5, 1.75, 2]; setRate(all[clamp(all.indexOf(rate) + step, 0, all.length - 1)]); }
function setVolume(value) { sound.volume = clamp(value, 0, 1); sound.muted = sound.volume === 0; $('volume').value = sound.volume; showSound(); }
function toggleSound() { sound.muted = !sound.muted; showSound(); }
function showSound() { $('mute').innerHTML = icon(sound.muted ? 'muted' : 'sound'); }
function toggleCaptions() { showCaptions = !showCaptions; $('cc').classList.toggle('off', !showCaptions); $('captions').classList.toggle('off', !showCaptions); }
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
$('coverMeta').textContent = `${Math.round(total / 60)} minutes, ${quiz.length} questions`;
$('coverPlay').innerHTML = icon('play');
$('coverPlay').addEventListener('click', () => setPlaying(true));
$('play').innerHTML = icon('play');
$('back').innerHTML = icon('back');
$('forward').innerHTML = icon('forward');
$('captions').innerHTML = icon('cc');
$('chaptersButton').innerHTML = icon('list');
$('full').innerHTML = icon('full');
showSound();
$('play').addEventListener('click', () => setPlaying(!playing));
$('back').addEventListener('click', () => seek(clockNow() - 10));
$('forward').addEventListener('click', () => seek(clockNow() + 10));
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
  else if (key === 'arrowleft') seek(clockNow() - 5);
  else if (key === 'arrowright') seek(clockNow() + 5);
  else if (key === 'j') seek(clockNow() - 10);
  else if (key === 'l') seek(clockNow() + 10);
  else if (key === 'arrowup') { event.preventDefault(); setVolume(sound.volume + 0.1); }
  else if (key === 'arrowdown') { event.preventDefault(); setVolume(sound.volume - 0.1); }
  else if (key === 'm') toggleSound();
  else if (key === 'c') toggleCaptions();
  else if (key === 'f') toggleFull();
  else if (key === 'g') toggleDrawer();
  else if (key === '>' ) nudgeRate(1);
  else if (key === '<') nudgeRate(-1);
  else if (key === ']') { const next = scenes.find(item => sections.indexOf(item.section) > sections.indexOf(scene.section)); if (next) seek(next.start); }
  else if (key === '[') { const own = scenes.find(item => item.section === scene.section); const earlier = clockNow() - own.start > 3 ? own : scenes.find(item => sections.indexOf(item.section) === sections.indexOf(scene.section) - 1); if (earlier) seek(earlier.start); }
  else if (key === 'enter' && scene.check && answers.has(scene.check)) leaveQuestion();
  else if (asking && /^[1-5]$/.test(key)) { const q = quizById.get(scene.check); const k = q.order?.[Number(key) - 1]; if (k !== undefined) answer(k); }
});

new ResizeObserver(fit).observe(frame);
fit();
buildScrub();
buildChapters();
syncTo(0, true);
loop();

// For stills of a moment: tools/shoot.mjs --eval "player.hold(120)".
window.player = { hold: t => { $('cover').hidden = true; dragging = true; pinned = t; syncTo(t, true); showFrame(t); }, scenes, sound };
