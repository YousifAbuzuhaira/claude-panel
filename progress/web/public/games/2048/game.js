// The 2048 page: draws the board, takes keys and swipes, keeps the save.
import { loadSave, writeSave, withToken } from '../../shared/api.js';
import { rngFor, seedFromUrl } from '../rng.js';
import { CELLS, SIDE, newGame, play, readSave, saveOf, isStopped } from './logic.js';

const SLIDE_MS = 100;

// Each value its own colour, as the WPF window has them: warm neutrals, oranges
// into red, golds up to 2048, then cool colours past it.
const TILE_LOOKS = {
  2: ['#4B4840', '#EDE6DA'], 4: ['#5E5644', '#F2E8D5'], 8: ['#C2703F', '#FBF3EA'],
  16: ['#D9783C', '#FBF3EA'], 32: ['#E5643A', '#FBF3EA'], 64: ['#E8472F', '#FBF3EA'],
  128: ['#E3C15A', '#26231C'], 256: ['#E6BE47', '#26231C'], 512: ['#EABA33', '#26231C'],
  1024: ['#EEB521', '#26231C'], 2048: ['#F5C400', '#26231C'], 4096: ['#8E5BD6', '#F4F0FB'],
  8192: ['#6F55D9', '#F4F0FB'], 16384: ['#4F63D6', '#F0F3FC'], 32768: ['#3687D1', '#EFF6FC'],
  65536: ['#2AA3A8', '#EEFAFA'], 131072: ['#3FAF7A', '#EEFAF3'],
};
// Font size by digit count, on the original's 76 px tile.
const FONT_PX = { 1: 32, 2: 30, 3: 25, 4: 20, 5: 16 };

const $ = id => document.getElementById(id);
const boardEl = $('board');
const tilesEl = $('tiles');
const params = new URLSearchParams(location.search);
const isDemo = params.has('demo');
const rng = rngFor(seedFromUrl());

document.querySelector('a.back').href = withToken('../');

let game = newGame(rng);
let best = 0;
let tiles = new Map(); // cell -> tile element
let slide = null; // { timer, merged, spawned } while tiles slide
let ready = false; // no moves until the save has been read

const metrics = () => {
  const style = getComputedStyle(document.documentElement);
  return { tile: parseFloat(style.getPropertyValue('--tile')), gap: parseFloat(style.getPropertyValue('--gap')) };
};
const place = (cell, { tile, gap }) => {
  const x = gap + (cell % SIDE) * (tile + gap);
  const y = gap + Math.floor(cell / SIDE) * (tile + gap);
  return `translate(${x}px, ${y}px)`;
};

function drawSlots() {
  const m = metrics();
  const slots = $('slots');
  slots.textContent = '';
  for (let i = 0; i < CELLS; i++) {
    const slot = document.createElement('div');
    slot.className = 'slot';
    slot.style.transform = place(i, m);
    slots.append(slot);
  }
}

function newTile(value, cell, m, effect) {
  const look = TILE_LOOKS[value] || TILE_LOOKS[131072];
  const tile = document.createElement('div');
  tile.className = 'tile';
  tile.style.transform = place(cell, m);
  const face = document.createElement('div');
  face.className = effect ? `face ${effect}` : 'face';
  face.style.background = look[0];
  face.style.color = look[1];
  const digits = String(value).length;
  face.style.fontSize = `${((FONT_PX[digits] || 13) * m.tile) / 76}px`;
  // 2048 and past it glow.
  if (value >= 2048) face.style.boxShadow = `0 0 18px ${look[0]}b3`;
  face.textContent = value;
  tile.append(face);
  tilesEl.append(tile);
  return tile;
}

/** Draws the board as it is: merged tiles pop, the new tile grows in. */
function drawBoard(merged = [], spawned = -1) {
  const m = metrics();
  tilesEl.textContent = '';
  tiles = new Map();
  game.board.forEach((value, cell) => {
    if (value === 0) return;
    const effect = merged.includes(cell) ? 'pop' : cell === spawned ? 'grow' : '';
    tiles.set(cell, newTile(value, cell, m, effect));
  });
  drawScores();
  drawOverlay();
}

function drawScores() {
  $('score').textContent = game.score;
  $('best').textContent = best;
}

function drawOverlay() {
  const overlay = $('overlay');
  const message = $('message');
  if (game.over) {
    message.textContent = 'Game over!';
    message.style.color = 'var(--ink)';
    $('keep').hidden = true;
    overlay.classList.add('show');
  } else if (game.won && !game.keepPlaying) {
    message.textContent = 'You win!';
    message.style.color = '#F5C400';
    $('keep').hidden = false;
    overlay.classList.add('show');
  } else {
    overlay.classList.remove('show');
  }
}

/** "+N" rises out of the score and fades. */
function showGain(gain) {
  const rise = $('rise');
  rise.textContent = `+${gain}`;
  rise.classList.remove('go');
  void rise.offsetWidth;
  rise.classList.add('go');
}

function save() {
  if (isDemo) return;
  writeSave('2048', saveOf(best, game));
}

function finishSlide() {
  if (!slide) return;
  clearTimeout(slide.timer);
  const { merged, spawned } = slide;
  slide = null;
  drawBoard(merged, spawned);
}

function startSlide(result) {
  const m = metrics();
  for (let k = 0; k < result.from.length; k++) {
    const tile = tiles.get(result.from[k]);
    if (!tile) continue;
    tile.classList.add('sliding');
    tile.style.transform = place(result.to[k], m);
  }
  slide = { merged: result.merged, spawned: result.spawned, timer: setTimeout(finishSlide, SLIDE_MS) };
}

function restart() {
  if (!ready) return;
  if (slide) { clearTimeout(slide.timer); slide = null; }
  game = newGame(rng);
  drawBoard();
  save();
}

function doMove(dir) {
  if (!ready || isStopped(game)) return;
  // A key during a slide finishes it at once, so quick play never waits.
  finishSlide();
  const result = play(game, dir, rng);
  if (!result) return;
  if (game.score > best) best = game.score;
  save();
  if (result.gained > 0) showGain(result.gained);
  drawScores();
  startSlide(result);
}

const MOVE_KEYS = {
  ArrowUp: 0, w: 0, k: 0,
  ArrowRight: 1, d: 1, l: 1,
  ArrowDown: 2, s: 2, j: 2,
  ArrowLeft: 3, a: 3, h: 3,
};

document.addEventListener('keydown', event => {
  // As in the original, keys with Ctrl, Alt or Cmd held are not moves.
  if (event.ctrlKey || event.altKey || event.metaKey) return;
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  if (key in MOVE_KEYS) {
    event.preventDefault();
    doMove(MOVE_KEYS[key]);
  } else if (key === 'r') {
    event.preventDefault();
    restart();
  }
});

// Swipes, for a touch screen or a trackpad drag.
let swipe = null;
boardEl.addEventListener('pointerdown', event => { swipe = { x: event.clientX, y: event.clientY }; });
boardEl.addEventListener('pointerup', event => {
  if (!swipe) return;
  const dx = event.clientX - swipe.x;
  const dy = event.clientY - swipe.y;
  swipe = null;
  if (Math.max(Math.abs(dx), Math.abs(dy)) < 30) return;
  if (Math.abs(dx) > Math.abs(dy)) doMove(dx > 0 ? 1 : 3);
  else doMove(dy > 0 ? 2 : 0);
});

$('keep').addEventListener('click', () => {
  game.keepPlaying = true;
  drawOverlay();
  save();
});
$('again').addEventListener('click', restart);
$('new').addEventListener('click', event => { event.currentTarget.blur(); restart(); });
addEventListener('resize', () => { drawSlots(); finishSlide(); drawBoard(); });

// Every tile colour on one board, for a snapshot (?demo).
function showDemo() {
  game = { board: [2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536], score: 31412, won: true, keepPlaying: true, over: false };
  best = 52768;
  drawBoard();
}

async function start() {
  drawSlots();
  if (isDemo) return showDemo();
  const saved = readSave(await loadSave('2048'));
  best = Math.max(best, saved.best);
  // The kept game comes back as it was; anything else starts fresh.
  if (saved.game) game = saved.game;
  if (game.score > best) best = game.score;
  ready = true;
  drawBoard();
  save();
}

start();
