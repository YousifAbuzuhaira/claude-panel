// The typing page: words, caret, result screen and theme picker, in Monkeytype's image.
import { loadSave, writeSave, withToken } from '../../shared/api.js';
import { rngFor, seedFromUrl } from '../rng.js';
import {
  DEFAULT_THEME, SERIKA_DARK, THEME_KEYS, TypeTest, WORD_COUNT,
  filterThemes, graphScale, isBest, parseThemes, readSave, saveOf, themeTitle,
} from './logic.js';

const $ = id => document.getElementById(id);
const wordsEl = $('words');
const caret = $('caret');
const params = new URLSearchParams(location.search);
const demoView = params.get('view'); // typing | result | themes, for snapshots
const rng = rngFor(seedFromUrl());

document.querySelector('a.back').href = withToken('../');

let themes = [{ name: DEFAULT_THEME, colors: [...SERIKA_DARK] }];
let themeName = DEFAULT_THEME;
let best = 0;
let test = null;
let wordEls = [];
let secondTimer = 0;
let idleTimer = 0;
let ready = false;

function save() {
  if (demoView || !ready) return;
  writeSave('typetest', saveOf(best, themeName));
}

// --- Themes --------------------------------------------------------------------------

function setColors(name) {
  const theme = themes.find(t => t.name === name);
  if (!theme) return;
  THEME_KEYS.forEach((key, k) => document.documentElement.style.setProperty(`--${key}`, theme.colors[k]));
}

function setTheme(name) {
  themeName = name;
  setColors(name);
  $('themeName').textContent = themeTitle(name);
}

// --- The words and the caret ------------------------------------------------------------

function buildWords() {
  wordsEl.textContent = '';
  wordEls = test.targets.map(() => {
    const el = document.createElement('div');
    el.className = 'word';
    wordsEl.append(el);
    return el;
  });
  wordEls.forEach((_, i) => drawWord(i));
}

/** One word, from what was typed into it: grey to type, light right, red wrong, dark red past its end. */
function drawWord(i) {
  const el = wordEls[i];
  const target = test.targets[i];
  const typed = test.typed[i];
  el.textContent = '';
  for (let j = 0; j < Math.max(target.length, typed.length); j++) {
    const letter = document.createElement('span');
    if (j >= target.length) {
      letter.textContent = typed[j];
      letter.className = 'extra';
    } else {
      letter.textContent = target[j];
      if (j < typed.length) letter.className = typed[j] === target[j] ? 'right' : 'wrong';
    }
    el.append(letter);
  }
  el.classList.toggle('left-wrong', test.isLeftWrong(i));
}

/** The caret sits before the next letter to type, or after the word's last. */
function moveCaret(jump = false) {
  if (test.isFinished || test.current >= wordEls.length) return;
  const letters = wordEls[test.current].children;
  if (letters.length === 0) return;
  const at = test.typed[test.current].length;
  const host = $('wordsHost').getBoundingClientRect();
  const box = (at < letters.length ? letters[at] : letters[letters.length - 1]).getBoundingClientRect();
  const x = (at < letters.length ? box.left : box.right) - host.left - 1;
  const y = box.top - host.top + (box.height - caret.offsetHeight) / 2;
  // Monkeytype's smooth caret: it glides to the next letter.
  caret.classList.toggle('glide', !jump);
  caret.style.left = `${x}px`;
  caret.style.top = `${y}px`;
}

/** The caret blinks while nothing is typed, and holds still while typing. */
function typed() {
  caret.classList.remove('blink');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { if (!test.isFinished) caret.classList.add('blink'); }, 1000);
}

function drawProgress() {
  const progress = $('progress');
  progress.textContent = `${test.current}/${WORD_COUNT}`;
  progress.style.visibility = test.isStarted && !test.isFinished ? 'visible' : 'hidden';
}

function newTest() {
  clearInterval(secondTimer);
  clearTimeout(idleTimer);
  test = new TypeTest({ rng });
  buildWords();
  $('result').hidden = true;
  $('typing').hidden = false;
  caret.hidden = false;
  caret.classList.add('blink');
  drawProgress();
  moveCaret(true);
}

function afterInput(before) {
  if (!before && test.isStarted) secondTimer = setInterval(() => test.addSample(1), 1000);
  if (test.isFinished) return finish();
  // The word before may have changed too (moved off it, or back into it).
  for (let i = Math.max(0, test.current - 1); i <= Math.min(wordEls.length - 1, test.current + 1); i++) drawWord(i);
  typed();
  moveCaret();
  drawProgress();
}

function addLetter(ch) {
  const wasStarted = test.isStarted;
  if (test.addLetter(ch)) afterInput(wasStarted);
}

function removeLetter(word) {
  if (test.removeLetter(word)) afterInput(true);
}

function finish() {
  clearInterval(secondTimer);
  clearTimeout(idleTimer);
  const result = test.result;
  result.isBest = isBest(result, best);
  if (result.isBest) {
    best = result.wpm;
    save();
  }
  showResult(result);
}

// --- The result screen -------------------------------------------------------------------

const fixed = (v, digits = 2) => v.toFixed(digits);

function showResult(result) {
  $('wpm').textContent = Math.round(result.wpm);
  $('wpm').title = `${fixed(result.wpm)} wpm`;
  $('acc').textContent = `${Math.round(result.acc)}%`;
  $('acc').title = `${fixed(result.acc)}% (${result.goodKeys} correct / ${result.badKeys} incorrect)`;
  $('raw').textContent = Math.round(result.raw);
  $('raw').title = fixed(result.raw);
  $('chars').textContent = result.chars.join('/');
  $('consistency').textContent = `${Math.round(result.consistency)}%`;
  $('consistency').title = `${fixed(result.consistency)}%`;
  $('time').textContent = `${Math.round(result.seconds)}s`;
  $('time').title = `${fixed(result.seconds)}s`;
  $('crown').hidden = !result.isBest;
  drawGraph(result.samples);
  caret.hidden = true;
  $('progress').style.visibility = 'hidden';
  $('typing').hidden = true;
  $('result').hidden = false;
}

const SVG = 'http://www.w3.org/2000/svg';
const GRAPH_W = 440;
const GRAPH_H = 170;

function svg(name, attrs, text) {
  const el = document.createElementNS(SVG, name);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  if (text !== undefined) el.textContent = text;
  return el;
}

/** Monkeytype's graph: wpm in the main colour, raw in sub, errors as crosses, one point a second. */
function drawGraph(samples) {
  const graph = $('graph');
  graph.textContent = '';
  const n = samples.length;
  if (n === 0) return;
  const { top, step } = graphScale(samples);
  const maxErrors = Math.max(1, ...samples.map(s => s.errors));
  const left = 26;
  const width = GRAPH_W - left;
  const yOf = v => GRAPH_H - (v / top) * GRAPH_H;
  for (let v = 0; v <= top; v += step) {
    const y = yOf(v);
    graph.append(svg('line', { x1: left, x2: GRAPH_W, y1: y, y2: y, stroke: 'var(--subAlt)', 'stroke-width': 1 }));
    graph.append(svg('text', { x: 0, y: y + 3.5 }, v));
  }
  const xOf = k => (n > 1 ? left + (width * k) / (n - 1) : left + width / 2);
  const wpmPoints = [];
  const rawPoints = [];
  samples.forEach((s, k) => {
    const x = xOf(k);
    wpmPoints.push(`${x},${yOf(s.wpm)}`);
    rawPoints.push(`${x},${yOf(s.raw)}`);
    graph.append(svg('text', { x, y: GRAPH_H + 14, 'text-anchor': 'middle' }, k + 1));
    if (s.errors > 0) {
      const ey = GRAPH_H - (s.errors / maxErrors) * GRAPH_H * 0.9;
      graph.append(svg('path', { d: `M${x - 4},${ey - 4}L${x + 4},${ey + 4}M${x - 4},${ey + 4}L${x + 4},${ey - 4}`, stroke: 'var(--error)', 'stroke-width': 2 }));
    }
  });
  const line = (points, color, w) => svg('polyline', { points: points.join(' '), fill: 'none', stroke: color, 'stroke-width': w, 'stroke-linejoin': 'round' });
  graph.append(line(rawPoints, 'var(--sub)', 2));
  graph.append(line(wpmPoints, 'var(--main)', 2.5));
  for (const p of wpmPoints) {
    const [x, y] = p.split(',');
    graph.append(svg('circle', { cx: x, cy: y, r: 2.5, fill: 'var(--main)' }));
  }
}

// --- The theme picker: a search box, a live preview, Esc reverts --------------------------

let picking = false;
let themeBefore = themeName;
let swatches = []; // { name, el }
let shown = [];
let pickIndex = -1;

function buildSwatches() {
  if (swatches.length) return;
  const host = $('swatches');
  swatches = themes.map(theme => {
    const el = document.createElement('div');
    el.className = 'swatch';
    el.style.background = theme.colors[0];
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = themeTitle(theme.name);
    title.style.color = theme.colors[1];
    el.append(title);
    for (const index of [5, 3]) {
      const dot = document.createElement('i');
      dot.style.background = theme.colors[index];
      el.append(dot);
    }
    const entry = { name: theme.name, el };
    el.addEventListener('mouseenter', () => selectSwatch(shown.indexOf(entry), false));
    el.addEventListener('click', () => closePicker(true));
    host.append(el);
    return entry;
  });
  const nothing = document.createElement('div');
  nothing.className = 'nothing';
  nothing.id = 'nothing';
  nothing.textContent = 'no themes match';
  nothing.hidden = true;
  host.append(nothing);
}

/** Moves the choice to the index-th shown swatch and previews its theme. */
function selectSwatch(index, scroll = true) {
  if (shown.length === 0 || index < 0) return;
  index = Math.min(shown.length - 1, index);
  if (pickIndex >= 0 && pickIndex < shown.length) shown[pickIndex].el.classList.remove('on');
  pickIndex = index;
  const chosen = shown[index];
  chosen.el.classList.add('on');
  if (scroll) chosen.el.scrollIntoView({ block: 'nearest' });
  setColors(chosen.name);
}

/** Typing in the search box keeps the themes whose name has it. */
function updateFilter() {
  const kept = new Set(filterThemes(themes, $('search').value).map(t => t.name));
  shown = [];
  for (const entry of swatches) {
    entry.el.hidden = !kept.has(entry.name);
    entry.el.classList.remove('on');
    if (kept.has(entry.name)) shown.push(entry);
  }
  $('nothing').hidden = shown.length > 0;
  pickIndex = -1;
  if (shown.length > 0) selectSwatch(0);
  else setColors(themeBefore);
}

function openPicker(query = '') {
  if (picking) return;
  buildSwatches();
  picking = true;
  themeBefore = themeName;
  $('picker').hidden = false;
  $('typing').hidden = true;
  $('result').hidden = true;
  const search = $('search');
  search.value = query;
  updateFilter();
  const current = shown.findIndex(entry => entry.name === themeName);
  selectSwatch(current >= 0 ? current : 0);
  search.focus();
}

/** Keep the chosen theme (Enter, a click) or go back to the one before (Esc). */
function closePicker(keep) {
  if (!picking) return;
  if (keep && pickIndex >= 0 && pickIndex < shown.length) {
    setTheme(shown[pickIndex].name);
    save();
  } else {
    setTheme(themeBefore);
  }
  picking = false;
  $('picker').hidden = true;
  $('search').blur();
  if (test.isFinished) {
    $('result').hidden = false;
  } else {
    $('typing').hidden = false;
    moveCaret(true);
  }
}

/** Arrows walk the swatch grid: a row is as many swatches as fit across. */
function movePick(columns, rows) {
  if (shown.length === 0) return;
  const firstTop = shown[0].el.offsetTop;
  let perRow = shown.findIndex(entry => entry.el.offsetTop !== firstTop);
  if (perRow <= 0) perRow = shown.length;
  selectSwatch(Math.max(0, Math.min(shown.length - 1, pickIndex + columns + rows * perRow)));
}

$('search').addEventListener('input', () => { if (picking) updateFilter(); });
$('themeButton').addEventListener('mousedown', event => event.preventDefault());
$('themeButton').addEventListener('click', () => (picking ? closePicker(false) : openPicker()));

// --- Keys ------------------------------------------------------------------------------

const PICK_KEYS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

document.addEventListener('keydown', event => {
  if (!ready) return;
  if (picking) {
    if (event.key === 'Escape') closePicker(false);
    else if (event.key === 'Enter') closePicker(true);
    else if (PICK_KEYS[event.key]) movePick(...PICK_KEYS[event.key]);
    else if (event.key !== 'Tab') return; // letters go to the search box
    event.preventDefault();
    return;
  }
  if (event.key === 'Escape') { event.preventDefault(); openPicker(); return; }
  if (event.key === 'Tab') { event.preventDefault(); newTest(); return; }
  if (event.key === 'Backspace') {
    event.preventDefault();
    // Ctrl+Backspace clears the word (and Option or Cmd+Backspace, as a Mac does).
    removeLetter(event.ctrlKey || event.altKey || event.metaKey);
    return;
  }
  if (event.ctrlKey || event.metaKey || event.isComposing) return;
  if (event.key.length === 1) {
    event.preventDefault();
    addLetter(event.key);
  }
});

// Out of focus, the words blur and say how to come back, as Monkeytype's do.
const host = document.querySelector('main');
addEventListener('blur', () => { if (!test.isFinished && !demoView) { host.classList.add('unfocused'); $('veil').hidden = false; } });
addEventListener('focus', () => {
  host.classList.remove('unfocused');
  $('veil').hidden = true;
  if (!test.isFinished && !picking) moveCaret(true);
});
$('veil').addEventListener('click', () => window.focus());
addEventListener('resize', () => moveCaret(true));

// --- Snapshots (?view=typing|result|themes&theme=name) ---------------------------------------

function showDemo() {
  const name = params.get('theme');
  if (name && themes.some(t => t.name === name)) setTheme(name);
  if (demoView === 'themes') return openPicker(name ? themeTitle(name).split(' ')[0] : '');
  test = new TypeTest({ targets: ['the', 'world', 'house', 'between', 'point', 'early', 'program', 'hand', 'leave', 'system'] });
  test.typed = ['the', 'wrold', 'house', 'betw', '', '', '', '', '', ''];
  test.current = 3;
  test.isStarted = true;
  buildWords();
  drawProgress();
  caret.classList.remove('blink');
  moveCaret(true);
  if (demoView === 'result') {
    test.isFinished = true;
    const samples = [
      { wpm: 84, raw: 96, errors: 0 }, { wpm: 98, raw: 108, errors: 1 }, { wpm: 104, raw: 112, errors: 0 },
      { wpm: 101, raw: 96, errors: 2 }, { wpm: 107, raw: 120, errors: 0 }, { wpm: 109, raw: 114, errors: 0 },
    ];
    showResult({ wpm: 109.4, raw: 113.6, acc: 96.2, goodKeys: 51, badKeys: 2, chars: [56, 1, 0, 0], consistency: 81.3, seconds: 5.87, samples, isBest: true });
  }
}

async function start() {
  newTest();
  const [text, saved] = await Promise.all([
    fetch('/data/TypeThemes.txt').then(r => (r.ok ? r.text() : '')).catch(() => ''),
    demoView ? null : loadSave('typetest'),
  ]);
  themes = parseThemes(text);
  const prefs = readSave(saved, themes.map(t => t.name));
  best = prefs.pb;
  setTheme(prefs.theme);
  ready = true;
  if (demoView) showDemo();
  else moveCaret(true);
}

start();
