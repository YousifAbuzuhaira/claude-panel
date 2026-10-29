// Chess puzzles in the browser: the window of widget/ChessPuzzles.ps1, drawn with plain
// HTML/SVG. The rules, the narrator, the ratings, the store and the saves are the pure
// modules beside this one; this file is the flow and the screen.
//
// Testing aid (no saves are written): ?demo=board|hint|wrong|review|picker|played|pieces
// &puzzle=<id> plays the real handlers instantly, as the WPF -SnapshotView does; add
// &engine=1 to let a 'wrong'/'played' demo wait for Stockfish.
import { loadSave, token, writeSave } from '../../shared/api.js';
import { Board, isCapture, isCastle, isEnPassant, uci } from './board.js';
import { describe, ideaHint, lineSan, pieceOn, replyNote, summary } from './narrator.js';
import { update as glickoUpdate } from './glicko.js';
import { PuzzleStore, parseGlossary, parsePieces, randomRng, seededRng } from './store.js';
import {
  BOARD_LOOKS, CLIMB_MAX, CLIMB_MIN, CLIMB_START, DIFFICULTIES, HISTORY_MAX,
  buildSave, newPuzzleState, readProgress, restorePuzzle,
} from './save.js';
import { UciEngine, formatScore } from './engine.js';

const SLIDE_MS = 170, SETUP_MS = 450, REPLY_MS = 400, REFUTE_MS = 1900, FALLBACK_MS = 1400;
const FEED_MAX = 60, RETRY_GAP = 20, LIST_THRESHOLD = 60, PROVISIONAL_RD = 110;
// Glicko-2 starts unsure (deviation 500), so one early result could move the rating by
// hundreds; no single puzzle moves it more than this.
const MAX_RATING_STEP = 200;
// Climb: its own level, a fixed step up for a clean solve and a bigger one down for a miss.
const CLIMB_UP = 50, CLIMB_DOWN = 100;
const SKIP_CONFIRM_MS = 3000;
const THEME_GROUPS = { tactics: 'Tactics', mates: 'Mates', phases: 'Phases and endgames', length: 'Length', special: 'Game source' };
const DOT = '·';

// Lichess's own highlight colours (the WPF #AARRGGBB values).
const FILL = {
  last: 'rgba(155,199,0,0.41)', selected: 'rgba(20,85,30,0.5)', dest: 'rgba(20,85,30,0.5)', hint: 'rgba(230,190,71,0.63)',
  wrong: 'rgba(224,105,107,0.56)', hover: 'rgba(103,163,224,0.44)', arrow: 'rgba(21,120,27,0.8)',
};

const params = new URLSearchParams(location.search);
const DEMO = params.get('demo') || '';
const instant = !!DEMO;
const useEngine = !DEMO || params.get('engine') === '1';

const $ = id => document.getElementById(id);
const el = {
  board: $('board'), under: $('under'), over: $('over'), pieces: $('pieces'), promo: $('promo'), promoShade: $('promoShade'),
  veil: $('veil'), veilText: $('veilText'), loading: $('loading'),
  info: $('infoLine'), sideDot: $('sideDot'), status: $('statusText'), feed: $('feed'), moveStrip: $('moveStrip'),
  hint: $('hintButton'), next: $('nextButton'), modeRow: $('modeRow'), difficultyRow: $('difficultyRow'), climbNote: $('climbNote'),
  themeChip: $('themeChip'), themeLabel: $('themeLabel'), swatch: $('boardSwatch'), puzzleLink: $('puzzleLink'), gameLink: $('gameLink'),
  side: $('side'), picker: $('picker'), search: $('searchBox'), pickerList: $('pickerList'),
  ratingLabel: $('ratingLabel'), ratingNumber: $('ratingNumber'), ratingBox: $('ratingBox'), ratingFlash: $('ratingFlash'), sparkLine: $('sparkLine'),
  pieceDefs: $('pieceDefs'),
};

// --- State ------------------------------------------------------------------------------
let store = null, glossary = new Map();
let progress = readProgress(null).progress;
let p = null;                 // the puzzle being played (see save.js newPuzzleState)
let board = null;             // the position the puzzle is at
let viewBoard = null;         // the position drawn
let flipped = false;
const marks = { lastMove: null, selected: -1, targets: [], hintSquare: -1, arrow: null, wrongSquares: [], hoverSquares: [] };
let pieceViews = new Array(64).fill(null);
let anim = null;              // {end, then, timer}
let analysis = null;
let analysisDone = null;      // a promise the demo can wait on
let wrong = { before: null, move: null, reply: null };
let promotion = null;
let press = null, dragging = false;
let skipAskedAt = 0;
let timers = { setup: 0, reply: 0, refute: 0 };
let engine = null, engineRestarts = 0;
const rng = params.get('seed') ? seededRng(Number(params.get('seed'))) : randomRng;

// --- Saving -----------------------------------------------------------------------------
let saveBusy = false, saveAgain = false;
async function savePrefs() {
  // Demo runs leave the person's game alone.
  if (DEMO || !token || !store) return;
  if (saveBusy) { saveAgain = true; return; }
  saveBusy = true;
  try {
    do {
      saveAgain = false;
      await writeSave('chess', buildSave(progress, p));
    } while (saveAgain);
  } finally { saveBusy = false; }
}

// --- The board --------------------------------------------------------------------------
const SVG = 'http://www.w3.org/2000/svg';
const svgEl = (name, attrs) => {
  const node = document.createElementNS(SVG, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
};
const colOf = sq => flipped ? 7 - (sq % 8) : sq % 8;
const rowOf = sq => flipped ? Math.floor(sq / 8) : 7 - Math.floor(sq / 8);
const isDark = sq => (Math.floor(sq / 8) + (sq % 8)) % 2 === 0;

function squareAt(clientX, clientY) {
  const rect = el.board.getBoundingClientRect();
  const x = (clientX - rect.left) / rect.width * 8, y = (clientY - rect.top) / rect.height * 8;
  if (x < 0 || y < 0 || x >= 8 || y >= 8) return -1;
  const column = Math.floor(x), row = Math.floor(y);
  return flipped ? row * 8 + (7 - column) : (7 - row) * 8 + column;
}

function setBoardColour(name) {
  if (!Object.hasOwn(BOARD_LOOKS, name)) name = 'brown';
  progress.settings.board = name;
  document.documentElement.style.setProperty('--light', BOARD_LOOKS[name][0]);
  document.documentElement.style.setProperty('--dark', BOARD_LOOKS[name][1]);
  drawMarks();
}

function setOrientation(isFlipped) {
  flipped = isFlipped;
  if (viewBoard) showPosition(viewBoard); else drawMarks();
}

function pieceSvg(piece) {
  return `<svg viewBox="0 0 45 45"><use href="#piece${piece < 0 ? 'b' : 'w'}${Math.abs(piece)}"/></svg>`;
}
const placeAt = (node, sq) => { node.style.transform = `translate(${colOf(sq) * 100}%, ${rowOf(sq) * 100}%)`; };

/** Draws a position whole: the only full redraw of the pieces. */
function showPosition(position) {
  viewBoard = position;
  el.pieces.replaceChildren();
  pieceViews = new Array(64).fill(null);
  for (let sq = 0; sq < 64; sq++) {
    const piece = position.squares[sq];
    if (piece === 0) continue;
    const node = document.createElement('div');
    node.className = 'piece';
    node.innerHTML = pieceSvg(piece);
    placeAt(node, sq);
    el.pieces.append(node);
    pieceViews[sq] = node;
  }
  drawMarks();
}

/** Squares, marks and move dots under the pieces; coordinates and the arrow over them. */
function drawMarks() {
  const light = getComputedStyle(document.documentElement).getPropertyValue('--light').trim() || BOARD_LOOKS.brown[0];
  const dark = getComputedStyle(document.documentElement).getPropertyValue('--dark').trim() || BOARD_LOOKS.brown[1];
  const under = [];
  const rect = (sq, fill) => under.push(svgEl('rect', { x: colOf(sq), y: rowOf(sq), width: 1, height: 1, fill }));
  for (let sq = 0; sq < 64; sq++) rect(sq, isDark(sq) ? dark : light);
  if (marks.lastMove) { rect(marks.lastMove.from, FILL.last); rect(marks.lastMove.to, FILL.last); }
  for (const sq of marks.wrongSquares) rect(sq, FILL.wrong);
  if (marks.hintSquare >= 0) rect(marks.hintSquare, FILL.hint);
  if (marks.selected >= 0) rect(marks.selected, FILL.selected);
  for (const sq of marks.hoverSquares) rect(sq, FILL.hover);
  const view = viewBoard;
  if (view && view.inCheck()) {
    const king = view.kingSquare(view.whiteToMove);
    if (king >= 0) rect(king, 'url(#checkGlow)');
  }
  for (const sq of marks.targets) {
    const cx = colOf(sq) + 0.5, cy = rowOf(sq) + 0.5;
    // A capture: a ring round the square, as Lichess draws it.
    if (view && view.squares[sq] !== 0) under.push(svgEl('circle', { cx, cy, r: 0.44, fill: 'none', stroke: FILL.dest, 'stroke-width': 0.096 }));
    else under.push(svgEl('circle', { cx, cy, r: 0.15, fill: FILL.dest }));
  }
  const defs = svgEl('defs', {});
  const glow = svgEl('radialGradient', { id: 'checkGlow' });
  for (const [offset, colour, opacity] of [[0, '#FF0000', 1], [0.25, '#E70000', 1], [0.89, '#A90000', 0], [1, '#9E0000', 0]]) {
    glow.append(svgEl('stop', { offset, 'stop-color': colour, 'stop-opacity': opacity }));
  }
  defs.append(glow);
  el.under.replaceChildren(defs, ...under);

  const over = [];
  for (let k = 0; k < 8; k++) {
    // Files along the bottom edge, ranks down the left edge, in the other square's colour.
    const fileSquare = flipped ? 56 + (7 - k) : k;
    const rankSquare = flipped ? k * 8 + 7 : (7 - k) * 8;
    const fileText = svgEl('text', { x: k + 0.97, y: 7.96, 'text-anchor': 'end', class: 'coord', fill: isDark(fileSquare) ? light : dark });
    fileText.textContent = String.fromCharCode(97 + (fileSquare % 8));
    const rankText = svgEl('text', { x: 0.05, y: k + 0.2, class: 'coord', fill: isDark(rankSquare) ? light : dark });
    rankText.textContent = String(1 + Math.floor(rankSquare / 8));
    over.push(fileText, rankText);
  }
  if (marks.arrow) over.push(...arrowShapes(marks.arrow.from, marks.arrow.to));
  el.over.replaceChildren(...over);
}

/** A Lichess-style green arrow from one square's centre to another's (in square units). */
function arrowShapes(from, to) {
  const x1 = colOf(from) + 0.5, y1 = rowOf(from) + 0.5, x2 = colOf(to) + 0.5, y2 = rowOf(to) + 0.5;
  const length = Math.hypot(x2 - x1, y2 - y1);
  if (length < 0.02) return [];
  const ux = (x2 - x1) / length, uy = (y2 - y1) / length;
  const head = 0.42, width = 0.16;
  const tipX = x2 - ux * 0.12, tipY = y2 - uy * 0.12;
  const baseX = tipX - ux * head, baseY = tipY - uy * head;
  const shaft = svgEl('line', {
    x1: x1 + ux * 0.2, y1: y1 + uy * 0.2, x2: baseX, y2: baseY, stroke: FILL.arrow, 'stroke-width': width, 'stroke-linecap': 'round',
  });
  const points = [[tipX, tipY], [baseX - uy * head * 0.55, baseY + ux * head * 0.55], [baseX + uy * head * 0.55, baseY - ux * head * 0.55]];
  const tip = svgEl('polygon', { points: points.map(pt => pt.join(',')).join(' '), fill: FILL.arrow });
  return [shaft, tip];
}

// --- Moving pieces on screen ------------------------------------------------------------
function slide(node, sq) {
  if (!node) return;
  node.classList.add('slide');
  placeAt(node, sq);
}

/** Slides a move (or takes it back with reverse), then draws the result whole and runs then. */
function animate(before, move, then, reverse = false) {
  completeAnimation();
  const after = before.play(move);
  const end = reverse ? before : after;
  if (instant || document.hidden) {
    showPosition(end);
    if (then) then();
    return;
  }
  let rookFrom = -1, rookTo = -1;
  if (isCastle(move)) {
    if (move.to > move.from) { rookFrom = move.from + 3; rookTo = move.from + 1; } else { rookFrom = move.from - 4; rookTo = move.from - 1; }
  }
  if (!reverse) {
    if (viewBoard !== before) showPosition(before);
    let taken = move.to;
    if (isEnPassant(move)) taken = before.whiteToMove ? move.to - 8 : move.to + 8;
    const moving = pieceViews[move.from], rook = rookFrom >= 0 ? pieceViews[rookFrom] : null, victim = isCapture(move) ? pieceViews[taken] : null;
    void el.pieces.offsetWidth;
    if (victim) { victim.classList.add('slide'); victim.classList.add('fade'); }
    slide(moving, move.to);
    if (rook) slide(rook, rookTo);
  } else {
    showPosition(after);
    const moving = pieceViews[move.to], rook = rookTo >= 0 ? pieceViews[rookTo] : null;
    void el.pieces.offsetWidth;
    slide(moving, move.from);
    if (rook) slide(rook, rookFrom);
  }
  anim = { end, then, timer: setTimeout(completeAnimation, SLIDE_MS + 15) };
}

function completeAnimation() {
  if (!anim) return;
  const { end, then, timer } = anim;
  anim = null;
  clearTimeout(timer);
  showPosition(end);
  if (then) then();
}

// --- Theme titles -------------------------------------------------------------------------
function themeTitle(key) {
  if (!key || key === 'mix') return 'Mix';
  return glossary.has(key) ? glossary.get(key).title : key;
}
function themeListed(key) {
  if (key === 'mix') return true;
  if (!glossary.has(key)) return false;
  return glossary.get(key).group !== 'meta' && store.themeCount(key) >= LIST_THRESHOLD;
}

// --- Rating -------------------------------------------------------------------------------
const shownMode = () => (p ? p.mode : progress.settings.mode);

function updateRating() {
  let points;
  if (shownMode() === 'climb') {
    el.ratingLabel.textContent = 'LEVEL';
    el.ratingNumber.textContent = String(progress.climb.level);
    el.ratingBox.title = `Climb level (best ${progress.climb.best}): +${CLIMB_UP} for a clean solve, -${CLIMB_DOWN} for a miss.`;
    points = progress.climb.history;
  } else {
    el.ratingLabel.textContent = 'RATING';
    el.ratingNumber.textContent = String(Math.round(progress.rating.r)) + (progress.rating.rd > PROVISIONAL_RD ? '?' : '');
    el.ratingBox.title = 'Your puzzle rating (Glicko-2, as on Lichess). A ? means it is still settling.';
    points = progress.rating.history;
  }
  updateMode();
  if (points.length < 2) { el.sparkLine.setAttribute('points', ''); return; }
  const low = Math.min(...points), high = Math.max(...points);
  const span = Math.max(20, high - low);
  el.sparkLine.setAttribute('points', points.map((value, k) => {
    const x = k * 94 / (points.length - 1) + 1;
    const y = 23 - (value - low) / span * 20;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' '));
}

function ratingFlash(delta) {
  const f = el.ratingFlash;
  f.textContent = delta >= 0 ? `+${delta}` : String(delta);
  f.className = 'rating-flash ' + (delta >= 0 ? 'up' : 'down');
  // A demo shows the change beside the number instead of rising out of it.
  if (instant) { f.classList.add('still'); return; }
  void f.offsetWidth;
  f.classList.add('go');
}

/** The result is applied once per puzzle, the moment it is decided; retries don't count. */
function setResult(score) {
  if (!p || !p.rated) return;
  if (p.result && p.result.applied) return;
  if (p.mode === 'climb') {
    const step = score >= 1 ? CLIMB_UP : score > 0 ? Math.trunc(CLIMB_UP / 2) : -CLIMB_DOWN;
    const old = progress.climb.level;
    if (progress.climb.history.length === 0) progress.climb.history.push(old);
    progress.climb.level = Math.max(CLIMB_MIN, Math.min(CLIMB_MAX, old + step));
    const isBest = progress.climb.level > progress.climb.best;
    if (isBest) progress.climb.best = progress.climb.level;
    progress.climb.games++;
    progress.climb.history.push(progress.climb.level);
    progress.climb.history = progress.climb.history.slice(-HISTORY_MAX);
    p.result = { score, delta: progress.climb.level - old, applied: true, best: isBest };
    updateRating();
    ratingFlash(progress.climb.level - old);
    return;
  }
  const r = progress.rating;
  const next = glickoUpdate({ rating: r.r, deviation: r.rd, volatility: r.vol }, p.puzzle.rating, p.puzzle.deviation, score);
  next.rating = Math.max(r.r - MAX_RATING_STEP, Math.min(r.r + MAX_RATING_STEP, next.rating));
  const delta = Math.round(next.rating - r.r);
  if (r.history.length === 0) r.history.push(Math.round(r.r * 10) / 10);
  r.r = next.rating;
  r.rd = next.deviation;
  r.vol = next.volatility;
  r.games++;
  r.history.push(Math.round(next.rating * 10) / 10);
  r.history = r.history.slice(-HISTORY_MAX);
  p.result = { score, delta, applied: true };
  updateRating();
  ratingFlash(delta);
}

// --- The explanation feed -------------------------------------------------------------------
function addFeedView(entry) {
  const box = document.createElement('div');
  box.className = 'entry ' + entry.kind;
  if (entry.san) {
    const lead = document.createElement('b');
    lead.textContent = entry.san;
    box.append(lead);
  }
  const rest = document.createElement('span');
  rest.textContent = entry.text;
  box.append(rest);
  if (entry.squares && entry.squares.length) {
    box.dataset.squares = entry.squares.join(' ');
    box.addEventListener('mouseenter', () => { marks.hoverSquares = [...entry.squares]; drawMarks(); });
    box.addEventListener('mouseleave', () => { marks.hoverSquares = []; drawMarks(); });
  }
  el.feed.append(box);
  while (el.feed.children.length > FEED_MAX) el.feed.firstChild.remove();
  el.feed.scrollTop = el.feed.scrollHeight;
  return rest;
}

function addFeed(kind, san, text, squares = []) {
  const entry = { kind, san, text, squares: squares.filter(s => s != null) };
  if (kind !== 'progress') {
    p.feed.push(entry);
    if (p.feed.length > FEED_MAX) p.feed.splice(0, p.feed.length - FEED_MAX);
  }
  return addFeedView(entry);
}

// --- Status and info --------------------------------------------------------------------------
function setStatus(text, colour) {
  el.status.textContent = text;
  el.status.className = 'status ' + colour;
}

function updateInfo() {
  el.themeLabel.textContent = `Theme: ${themeTitle(progress.settings.theme)} ▾`;
  if (!p) { el.info.textContent = ''; return; }
  el.sideDot.classList.toggle('black', !p.solverWhite);
  let label = `#${p.puzzle.id} ${DOT} ${p.puzzle.rating} ${DOT} you play ${p.solverWhite ? 'White' : 'Black'}`;
  if (!p.rated) label += ` ${DOT} unrated retry`; else if (p.mode === 'climb') label += ` ${DOT} climb`;
  el.info.textContent = label;
  el.puzzleLink.href = `https://lichess.org/training/${p.puzzle.id}`;
  el.gameLink.href = `https://lichess.org/${p.puzzle.game}`;
}

function updateHintButton() {
  const b = el.hint;
  if (!p || p.phase !== 'play') { b.classList.add('off'); b.textContent = 'Hint'; return; }
  b.classList.remove('off');
  switch (p.hintNow) {
    case 0: b.textContent = 'Hint'; break;
    case 1: b.textContent = 'Hint: piece'; break;
    case 2: b.textContent = 'Hint: move'; break;
    default: b.textContent = 'No more hints'; b.classList.add('off');
  }
}

let modeViews = [], difficultyViews = [];
function buildSettings() {
  for (const choice of [
    { key: 'normal', label: 'Normal', tip: 'Puzzles near your rating; the rating moves with each result.' },
    { key: 'climb', label: 'Climb', tip: `Start at ${CLIMB_START} and work up: +${CLIMB_UP} for a clean solve, -${CLIMB_DOWN} for a miss.` },
  ]) {
    const b = pressable(choice.label, choice.tip);
    b.dataset.key = choice.key;
    b.addEventListener('click', () => chooseMode(choice.key));
    el.modeRow.append(b);
    modeViews.push(b);
  }
  for (const level of DIFFICULTIES) {
    const b = pressable(level.label);
    b.dataset.key = level.key;
    b.addEventListener('click', () => chooseDifficulty(level));
    el.difficultyRow.append(b);
    difficultyViews.push(b);
  }
}

function pressable(text, title = '') {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'pressable';
  b.textContent = text;
  if (title) b.title = title;
  b.tabIndex = -1;
  return b;
}

function updateMode() {
  for (const view of modeViews) view.classList.toggle('on', view.dataset.key === progress.settings.mode);
  const climb = progress.settings.mode === 'climb';
  el.difficultyRow.hidden = climb;
  el.climbNote.hidden = !climb;
  if (climb) el.climbNote.textContent = `Best ${progress.climb.best} ${DOT} +${CLIMB_UP} a solve ${DOT} -${CLIMB_DOWN} a miss`;
}

function updateDifficulty() {
  for (const view of difficultyViews) view.classList.toggle('on', view.dataset.key === progress.settings.difficulty);
}

// --- A puzzle from start to end ---------------------------------------------------------------
// p.step = how many of its moves are on the board (0 = not even the opponent's first
// move); p.line = the moves actually played, which can end in a different mate.

function lineBoard(count) {
  let position = Board.fromFen(p.puzzle.fen);
  for (let k = 0; k < count; k++) {
    const move = position.parseUci(p.line[k]);
    if (!move) return null;
    position = position.play(move);
  }
  return position;
}

function stopTimers() {
  for (const key of Object.keys(timers)) { clearTimeout(timers[key]); timers[key] = 0; }
}
function later(key, ms, fn) {
  clearTimeout(timers[key]);
  timers[key] = setTimeout(() => { timers[key] = 0; fn(); }, ms);
}

function setPuzzleView() {
  setOrientation(!p.solverWhite);
  updateInfo();
  updateRating();
  el.moveStrip.hidden = true;
  el.moveStrip.replaceChildren();
  el.next.textContent = 'Next puzzle';
  updateHintButton();
}

function clearMarks() {
  marks.selected = -1;
  marks.targets = [];
  marks.hintSquare = -1;
  marks.arrow = null;
  marks.wrongSquares = [];
  marks.hoverSquares = [];
}

function startPuzzle(puzzle, rated, note, mode = progress.settings.mode) {
  completeAnimation();
  stopTimers();
  analysis = null;
  el.veil.hidden = true;
  closePromotion();
  p = newPuzzleState(puzzle, rated, mode);
  clearMarks();
  marks.lastMove = null;
  el.feed.replaceChildren();
  board = Board.fromFen(puzzle.fen);
  viewBoard = board;
  setPuzzleView();
  if (note) addFeed('info', '', note);
  showPosition(board);
  setStatus('Watch their move', 'dim');
  savePrefs();
  if (instant) invokeSetup(); else later('setup', SETUP_MS, invokeSetup);
}

/** The opponent's move that sets the puzzle. */
function invokeSetup() {
  if (p.step !== 0) return;
  const before = board;
  const move = before.parseUci(p.puzzle.moves[0]);
  const note = describe(before, move, null);
  addFeed('reply', before.san(move), note.text || 'Their move.', note.squares);
  board = before.play(move);
  p.line.push(uci(move));
  p.step = 1;
  marks.lastMove = move;
  savePrefs();
  animate(before, move, setYourMove);
}

function setYourMove() {
  setStatus('Your move', 'ink');
  if (el.feed.children.length <= 2 && p.step === 1) addFeed('info', '', `Find the best move for ${p.solverWhite ? 'White' : 'Black'}.`);
  updateHintButton();
  savePrefs();
}

/** A move made on the board by the solver. */
function submitUserMove(move) {
  if (!p || p.phase !== 'play' || p.step % 2 !== 1 || analysis) return;
  clearSelection();
  const expected = board.parseUci(p.puzzle.moves[p.step]);
  const after = board.play(move);
  // As on Lichess: the puzzle's move, or any move that mates.
  const isRight = (expected && uci(expected) === uci(move)) || (after.inCheck() && after.legalMoves().length === 0);
  if (isRight) approveMove(move); else denyMove(move);
}

function followUpAfter(before, solution) {
  if (p.step + 2 >= p.puzzle.moves.length) return null;
  const after = before.play(solution);
  const reply = after.parseUci(p.puzzle.moves[p.step + 1]);
  return reply ? after.play(reply).parseUci(p.puzzle.moves[p.step + 2]) : null;
}

function approveMove(move) {
  const before = board;
  const after = before.play(move);
  // The same side's next move, two plies on, so the note can say what this one sets up.
  const note = describe(before, move, followUpAfter(before, move));
  addFeed('move', before.san(move), note.text || 'The right move.', note.squares);
  board = after;
  p.line.push(uci(move));
  p.step++;
  p.hintNow = 0;
  marks.hintSquare = -1;
  marks.arrow = null;
  marks.wrongSquares = [];
  marks.lastMove = move;
  const isDone = p.step >= p.puzzle.moves.length || (after.inCheck() && after.legalMoves().length === 0);
  if (isDone) {
    completePuzzle();
    animate(before, move, showReview);
    return;
  }
  setStatus('Good move', 'green');
  updateHintButton();
  savePrefs();
  animate(before, move, () => { if (instant) invokeReply(); else later('reply', REPLY_MS, invokeReply); });
}

/** The opponent's answer from the puzzle's line. */
function invokeReply() {
  if (!p || p.phase !== 'play' || p.step % 2 !== 0 || p.step >= p.puzzle.moves.length) return;
  const before = board;
  const reply = before.parseUci(p.puzzle.moves[p.step]);
  let previous = null;
  if (p.line.length >= 1) {
    const back = lineBoard(p.line.length - 1);
    if (back) previous = back.parseUci(p.line[p.line.length - 1]);
  }
  const after = before.play(reply);
  const next = p.step + 1 < p.puzzle.moves.length ? after.parseUci(p.puzzle.moves[p.step + 1]) : null;
  const note = replyNote(before, reply, previous, next);
  addFeed('reply', before.san(reply), note.text, note.squares);
  board = after;
  p.line.push(uci(reply));
  p.step++;
  marks.lastMove = reply;
  savePrefs();
  animate(before, reply, setYourMove);
}

// --- A wrong move: Stockfish's answer, or the facts of the move --------------------------------
function denyMove(move) {
  const before = board;
  p.mistakes++;
  p.pendingWrong = uci(move);
  wrong = { before, move, reply: null };
  marks.wrongSquares = [move.from, move.to];
  p.phase = 'wrong';
  addFeed('wrong', before.san(move), 'Not the move.', [move.from, move.to]);
  setStatus('Not the move', 'red');
  updateHintButton();
  savePrefs();
  animate(before, move, () => {
    if (startAnalysis()) return;
    showOwnMoveFacts();
  });
}

/** Without the engine: what the move itself does, then try again. */
function showOwnMoveFacts() {
  setResult(0);
  p.pendingWrong = null;
  const note = describe(wrong.before, wrong.move, null);
  const san = wrong.before.san(wrong.move);
  let text = note.text ? `Your ${san}: ${note.text}` : `Your ${san} doesn't capture, check, or attack anything of value.`;
  if (useEngine && (!engine || engine.status === 'dead')) text += " (Stockfish couldn't start here, so these are the move's own facts.)";
  addFeed('info', '', text, note.squares);
  p.phase = 'refuting';
  setStatus('Not the move', 'red');
  savePrefs();
  if (!instant) later('refute', FALLBACK_MS, restoreAfterWrong);
}

function confirmEngine() {
  if (!useEngine) return false;
  if (engine && engine.status !== 'dead') return true;
  if (engine) {
    if (engineRestarts >= 1) return false;
    engineRestarts++;
    engine = null;
  }
  try { engine = new UciEngine(); } catch { engine = null; return false; }
  return engine.status !== 'dead';
}

/** Asks Stockfish about the wrong move: its value, and the puzzle move's value. */
function startAnalysis() {
  if (!confirmEngine()) return false;
  const moves = p.line.slice(0, p.step);
  const mateTag = p.puzzle.themes.some(t => t.startsWith('mateIn'));
  const left = Math.floor((p.puzzle.moves.length - p.step + 1) / 2);
  const a = { moves, user: null, puzzle: null, pv: [], expected: p.puzzle.moves[p.step], knownPuzzle: mateTag ? 100000 - left : null };
  analysis = a;
  el.veilText.textContent = 'Stockfish is looking...';
  el.veil.hidden = false;
  p.phase = 'analysing';
  const fen = p.puzzle.fen;
  analysisDone = (async () => {
    const first = await engine.analyse(fen, moves, 700, [uci(wrong.move)]);
    if (analysis !== a) return;
    if (first.error || !first.hasScore) { console.warn('stockfish:', first.error, engine.drainLog().join(' | ')); stopAnalysis(); return; }
    a.user = first.value;
    a.pv = first.pv;
    if (a.knownPuzzle !== null) { a.puzzle = a.knownPuzzle; completeAnalysis(); return; }
    const second = await engine.analyse(fen, moves, 350, [a.expected]);
    if (analysis !== a) return;
    if (second.error || !second.hasScore) { stopAnalysis(); return; }
    a.puzzle = second.value;
    completeAnalysis();
  })().catch(error => { console.warn(error); if (analysis === a) stopAnalysis(); });
  return true;
}

function stopAnalysis() {
  el.veil.hidden = true;
  if (analysis) {
    analysis = null;
    showOwnMoveFacts();
  }
}

function completeAnalysis() {
  el.veil.hidden = true;
  const a = analysis;
  analysis = null;
  const before = wrong.before;
  const userSan = before.san(wrong.move);
  const verdict = `Your ${userSan} scores ${formatScore(a.user)}; the puzzle's move scores ${formatScore(a.puzzle)}.`;
  const bothMate = a.user >= 99000 && a.puzzle >= 99000;
  if (bothMate || (a.user >= a.puzzle - 30 && a.user >= 150)) {
    // Just as good: no penalty, but the puzzle wants its own line.
    p.mistakes--;
    p.pendingWrong = null;
    addFeed('engine', '', `That also wins. ${verdict} Find the puzzle's line.`);
    p.phase = 'refuting';
    setStatus('Also good', 'gold');
    savePrefs();
    if (!instant) later('refute', FALLBACK_MS, restoreAfterWrong);
    return;
  }
  setResult(0);
  p.pendingWrong = null;
  const after = before.play(wrong.move);
  const reply = a.pv.length >= 2 ? after.parseUci(a.pv[1]) : null;
  p.phase = 'refuting';
  setStatus('Not the move', 'red');
  if (!reply) {
    addFeed('engine', '', verdict);
    savePrefs();
    if (!instant) later('refute', FALLBACK_MS, restoreAfterWrong);
    return;
  }
  const note = describe(after, reply, null);
  let text = note.text ? `${note.text} ${verdict}` : verdict;
  // The engine's own continuation, so a quiet answer still shows where it leads.
  const line = lineSan(after, a.pv.slice(1), 6);
  if (line) text += ` Stockfish's line: ${line}.`;
  addFeed('engine', after.san(reply), text, note.squares);
  wrong.reply = reply;
  marks.lastMove = reply;
  savePrefs();
  animate(after, reply, () => { if (!instant) later('refute', REFUTE_MS, restoreAfterWrong); });
}

/** Takes back the wrong move (and Stockfish's answer) so the solver can try again. */
function restoreAfterWrong() {
  if (!p || p.phase !== 'refuting') return;
  clearTimeout(timers.refute);
  completeAnimation();
  p.phase = 'play';
  marks.wrongSquares = [];
  marks.lastMove = null;
  if (p.line.length >= 1) {
    const back = lineBoard(p.line.length - 1);
    if (back) marks.lastMove = back.parseUci(p.line[p.line.length - 1]);
  }
  const { before, move, reply } = wrong;
  const afterWrong = before.play(move);
  wrong.reply = null;
  setStatus('Try again', 'ink');
  updateHintButton();
  savePrefs();
  if (reply) animate(afterWrong, reply, () => animate(before, move, () => showPosition(board), true), true);
  else animate(before, move, () => showPosition(board), true);
}

// --- Hints: the idea, the piece, the move -------------------------------------------------------
function showHint() {
  if (!p || p.phase !== 'play' || p.step % 2 !== 1) return;
  const before = board;
  const solution = before.parseUci(p.puzzle.moves[p.step]);
  if (!solution) return;
  if (p.hintNow === 0) {
    const left = Math.floor((p.puzzle.moves.length - p.step + 1) / 2);
    const idea = ideaHint(before, solution, followUpAfter(before, solution), p.puzzle.themes, left);
    if (idea) {
      p.hintNow = 1;
      p.hint = Math.max(p.hint, 1);
      addFeed('hint', 'Hint:', idea);
      updateHintButton();
      savePrefs();
      return;
    }
  }
  if (p.hintNow <= 1) {
    p.hintNow = 2;
    p.hint = Math.max(p.hint, 2);
    marks.hintSquare = solution.from;
    setResult(0);
    addFeed('hint', 'Hint:', `Move ${pieceOn(before, solution.from)}.`, [solution.from]);
  } else if (p.hintNow === 2) {
    p.hintNow = 3;
    p.hint = 3;
    marks.arrow = { from: solution.from, to: solution.to };
    addFeed('hint', 'Hint:', `Play ${before.san(solution)}.`, [solution.from, solution.to]);
  } else return;
  drawMarks();
  updateHintButton();
  savePrefs();
}

// --- The end: result, summary, review ----------------------------------------------------------
function dropRetry(id) { progress.retry = progress.retry.filter(e => e.id !== id); }

function completePuzzle() {
  p.phase = 'review';
  let score = 1;
  if (p.mistakes > 0 || p.hint >= 2) score = 0; else if (p.hint === 1) score = 0.5;
  setResult(score);
  progress.counter++;
  progress.solved.add(p.puzzle.id);
  dropRetry(p.puzzle.id);
  if (score < 1 && p.rated && (p.mistakes > 0 || p.hint >= 2)) progress.retry.push({ id: p.puzzle.id, due: progress.counter + RETRY_GAP, mode: p.mode });

  const faced = lineBoard(1);
  const solverMoves = Math.floor(p.line.length / 2);
  const text = summary(faced, board, p.solverWhite, p.puzzle.themes, solverMoves);
  let heading = score >= 1 ? 'Solved.' : score > 0 ? 'Solved with the idea hint.' : p.mistakes > 0 ? 'Solved after a miss.' : 'Solved with hints.';
  if (!p.rated) heading = 'Retry done (unrated).';
  else if (p.mode === 'climb' && p.result) {
    const change = p.result.delta;
    heading += ` Level ${change >= 0 ? '+' : ''}${change} to ${progress.climb.level}.`;
    if (p.result.best) heading += ' New best!';
  }
  addFeed('summary', heading, text);
  const hasMateIn = p.puzzle.themes.some(t => t.startsWith('mateIn'));
  for (const theme of p.puzzle.themes) {
    if (!glossary.has(theme) || (theme === 'mate' && hasMateIn)) continue;
    const entry = glossary.get(theme);
    if (entry.group !== 'tactics' && entry.group !== 'mates') continue;
    addFeed('theme', entry.title, entry.line);
  }
  p.reviewPly = p.line.length;
  savePrefs();
}

function showReview() {
  const result = p.result;
  if (!p.rated) setStatus('Retry done', 'ink');
  else if (result && result.score >= 1) setStatus('Solved!', 'green');
  else if (result && result.score > 0) setStatus('Solved, half credit', 'gold');
  else setStatus('Solved, no credit', 'dim');
  el.next.textContent = 'Next puzzle';
  updateHintButton();
  buildMoveStrip();
  el.moveStrip.hidden = false;
  el.feed.scrollTop = el.feed.scrollHeight;
  clearMarks();
  drawMarks();
}

/** The line as clickable moves; the chosen one is lit. */
function buildMoveStrip() {
  const chips = [];
  let position = Board.fromFen(p.puzzle.fen);
  for (let k = 0; k < p.line.length; k++) {
    const move = position.parseUci(p.line[k]);
    if (!move) break;
    let label = position.san(move);
    if (position.whiteToMove) label = `${position.fullMove}. ${label}`;
    else if (k === 0) label = `${position.fullMove}... ${label}`;
    const chip = pressable(label);
    if (k + 1 === p.reviewPly) chip.classList.add('on');
    chip.addEventListener('click', () => setReviewPly(k + 1));
    chips.push(chip);
    position = position.play(move);
  }
  el.moveStrip.replaceChildren(...chips);
}

function setReviewPly(ply) {
  if (!p || p.phase !== 'review') return;
  ply = Math.max(1, Math.min(p.line.length, ply));
  const was = p.reviewPly;
  p.reviewPly = ply;
  const before = lineBoard(ply - 1);
  const move = before.parseUci(p.line[ply - 1]);
  marks.lastMove = move;
  buildMoveStrip();
  savePrefs();
  if (ply === was + 1) animate(before, move, null);
  else if (ply === was - 1) {
    const shownBefore = lineBoard(ply);
    const undo = shownBefore.parseUci(p.line[ply]);
    if (undo) animate(shownBefore, undo, null, true); else showPosition(shownBefore);
  } else showPosition(before.play(move));
}

// --- The next puzzle -------------------------------------------------------------------------------
/** Nothing played yet beyond the opponent's first move: leaving it costs nothing. */
const untouched = () => p && p.phase === 'play' && p.step <= 1 && p.hint === 0 && p.mistakes === 0 && !p.result;

function selectNextPuzzle(fresh = false) {
  if (p && p.phase !== 'review' && !fresh) {
    // Leaving a puzzle unsolved counts as a miss, so ask once before doing it.
    if (!instant && Date.now() - skipAskedAt > SKIP_CONFIRM_MS) {
      skipAskedAt = Date.now();
      setStatus('Skip? Press N again', 'gold');
      addFeed('info', '', 'Skipping counts as a miss. Press N (or Next) again to skip.');
      return;
    }
    setResult(0);
    progress.counter++;
    progress.solved.add(p.puzzle.id);
    if (p.rated) progress.retry.push({ id: p.puzzle.id, due: progress.counter + RETRY_GAP, mode: p.mode });
    else dropRetry(p.puzzle.id);
  }
  skipAskedAt = 0;
  // A missed puzzle comes back once, unrated.
  const due = progress.retry.find(e => e.due <= progress.counter && e.mode === progress.settings.mode);
  if (due) {
    progress.retry.splice(progress.retry.indexOf(due), 1);
    const again = store.get(due.id);
    if (again) { startPuzzle(again, false, 'A second try at a puzzle you missed earlier (unrated).'); return; }
  }
  let target;
  if (progress.settings.mode === 'climb') target = progress.climb.level;
  else {
    const shift = (DIFFICULTIES.find(d => d.key === progress.settings.difficulty) || DIFFICULTIES[2]).offset;
    target = Math.round(progress.rating.r) + shift;
  }
  const exclude = new Set(progress.solved);
  for (const entry of progress.retry) exclude.add(entry.id);
  if (p) exclude.add(p.puzzle.id);
  const pick = store.pick(progress.settings.theme, target, exclude, rng);
  const title = themeTitle(progress.settings.theme);
  let note = `Theme: ${title} ${DOT} aiming for ${target}`;
  if (progress.settings.mode === 'climb') note = `Climb ${DOT} level ${target} ${DOT} theme: ${title}`;
  if (pick.fellBackToMix) note = `No unplayed ${title} puzzles left, so a mixed one ${DOT} aiming for ${target}`;
  else if (pick.nearest) note += ` ${DOT} nearest available: ${pick.puzzle.rating}`;
  startPuzzle(pick.puzzle, true, note);
}

function chooseMode(chosen) {
  if (chosen === progress.settings.mode) return;
  progress.settings.mode = chosen;
  updateMode();
  savePrefs();
  if (!p || p.phase === 'review') selectNextPuzzle();
  else if (untouched()) selectNextPuzzle(true);
  else addFeed('info', '', `The next puzzle will be in ${chosen === 'climb' ? 'Climb' : 'Normal'} mode; this one finishes as it started.`);
}

function chooseDifficulty(level) {
  progress.settings.difficulty = level.key;
  updateDifficulty();
  savePrefs();
  if (p && p.phase !== 'review') addFeed('info', '', `The next puzzle will be ${level.label.toLowerCase()}.`);
}

// --- Coming back: the saved puzzle ------------------------------------------------------------------
function resumePuzzle(saved) {
  const back = restorePuzzle(saved, store);
  if (!back) return false;
  const { state, position, last } = back;
  p = state;
  clearMarks();
  el.feed.replaceChildren();
  for (const entry of state.feed) addFeedView(entry);
  board = position;
  viewBoard = position;
  setPuzzleView();
  marks.lastMove = last;
  // A page closed in the middle of a wrong move: the miss still counts.
  if (back.pendingWrong) { setResult(0); updateRating(); }
  state.pendingWrong = null;
  if (state.phase === 'review') {
    const shown = lineBoard(state.reviewPly);
    if (state.reviewPly >= 1) marks.lastMove = lineBoard(state.reviewPly - 1).parseUci(state.line[state.reviewPly - 1]);
    showPosition(shown);
    showReview();
  } else {
    showPosition(position);
    if (state.step === 0) { setStatus('Watch their move', 'dim'); later('setup', SETUP_MS, invokeSetup); }
    else if (state.step % 2 === 0) { setStatus('Their move', 'dim'); later('reply', REPLY_MS, invokeReply); }
    else {
      setStatus('Your move', 'ink');
      const solution = position.parseUci(state.puzzle.moves[state.step]);
      if (solution && state.hintNow >= 2) marks.hintSquare = solution.from;
      if (solution && state.hintNow >= 3) marks.arrow = { from: solution.from, to: solution.to };
      drawMarks();
    }
    updateHintButton();
  }
  return true;
}

// --- The theme picker --------------------------------------------------------------------------------
let isPicking = false, chips = [], shownChips = [], pickIndex = -1;
const groupViews = new Map();

function buildChips() {
  if (chips.length > 0) return;
  const entries = [{ key: 'mix', group: 'mix', title: 'Mix', line: 'Puzzles of every kind.' }];
  for (const [key, g] of glossary) if (themeListed(key)) entries.push({ key, group: g.group, title: g.title, line: g.line });
  const groupNames = { mix: 'All', ...THEME_GROUPS };
  for (const [groupKey, name] of Object.entries(groupNames)) {
    const members = entries.filter(e => e.group === groupKey);
    if (members.length === 0) continue;
    const heading = document.createElement('div');
    heading.className = 'group-heading';
    heading.textContent = name.toUpperCase();
    const wrap = document.createElement('div');
    wrap.className = 'chips';
    el.pickerList.append(heading, wrap);
    groupViews.set(groupKey, heading);
    for (const entry of members) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip';
      chip.title = entry.line;
      chip.tabIndex = -1;
      const title = document.createElement('span');
      title.className = 'title';
      title.textContent = entry.title;
      const count = document.createElement('span');
      count.className = 'count';
      count.textContent = String(entry.key === 'mix' ? store.count : store.themeCount(entry.key));
      chip.append(title, count);
      const item = { ...entry, group: groupKey, chip };
      chip.addEventListener('mouseenter', () => selectChip(shownChips.indexOf(item)));
      chip.addEventListener('click', () => { selectChip(shownChips.indexOf(item)); closePicker(true); });
      wrap.append(chip);
      chips.push(item);
    }
  }
}

function selectChip(index) {
  if (shownChips.length === 0 || index < 0) return;
  index = Math.min(shownChips.length - 1, index);
  if (pickIndex >= 0 && pickIndex < shownChips.length) shownChips[pickIndex].chip.classList.remove('on');
  pickIndex = index;
  shownChips[index].chip.classList.add('on');
  shownChips[index].chip.scrollIntoView({ block: 'nearest' });
}

function filterChips() {
  const query = el.search.value.trim().toLowerCase();
  const kept = [];
  for (const entry of chips) {
    const keep = !query || entry.title.toLowerCase().includes(query) || entry.key.toLowerCase().includes(query);
    entry.chip.hidden = !keep;
    entry.chip.classList.remove('on');
    if (keep) kept.push(entry);
  }
  for (const [groupKey, heading] of groupViews) heading.hidden = !kept.some(e => e.group === groupKey);
  shownChips = kept;
  pickIndex = -1;
  if (kept.length > 0) selectChip(0);
}

function openPicker() {
  if (isPicking || !store) return;
  buildChips();
  isPicking = true;
  el.search.value = '';
  el.picker.hidden = false;
  filterChips();
  const current = shownChips.findIndex(e => e.key === progress.settings.theme);
  if (current >= 0) selectChip(current);
  el.search.focus();
}

function closePicker(keep) {
  if (!isPicking) return;
  isPicking = false;
  el.picker.hidden = true;
  if (keep && pickIndex >= 0 && pickIndex < shownChips.length) {
    const chosen = shownChips[pickIndex].key;
    if (chosen !== progress.settings.theme) {
      progress.settings.theme = chosen;
      updateInfo();
      savePrefs();
      if (p && p.phase === 'review') selectNextPuzzle();
      else if (p) addFeed('info', '', `The next puzzle will be: ${themeTitle(chosen)}.`);
    }
  }
  el.search.blur();
}

const movePick = step => selectChip(Math.max(0, Math.min(shownChips.length - 1, pickIndex + step)));

// --- The promotion picker ---------------------------------------------------------------------------
function showPromotion(from, to) {
  promotion = { from, to };
  const white = board.whiteToMove;
  const towardCentre = rowOf(to) === 0 ? 1 : -1;
  const buttons = [5, 2, 4, 3].map((type, k) => {
    const choice = document.createElement('button');
    choice.type = 'button';
    choice.style.left = `${colOf(to) * 12.5}%`;
    choice.style.top = `${(rowOf(to) + towardCentre * k) * 12.5}%`;
    choice.innerHTML = pieceSvg(white ? type : -type);
    choice.addEventListener('pointerdown', event => event.stopPropagation());
    choice.addEventListener('click', event => {
      event.stopPropagation();
      const chosen = promotion;
      closePromotion();
      const move = board.findMove(chosen.from, chosen.to, type);
      if (move) submitUserMove(move);
    });
    return choice;
  });
  el.promo.replaceChildren(...buttons);
  el.promoShade.hidden = false;
}

function closePromotion() {
  el.promo.replaceChildren();
  el.promoShade.hidden = true;
  promotion = null;
}

// --- Selecting and moving pieces ------------------------------------------------------------------
function clearSelection() {
  marks.selected = -1;
  marks.targets = [];
  drawMarks();
}

function selectSquare(sq) {
  marks.selected = sq;
  marks.targets = [...new Set(board.legalMovesFrom(sq).map(m => m.to))];
  drawMarks();
}

const canMove = () => p && p.phase === 'play' && p.step % 2 === 1 && !analysis && !anim && !promotion;

function submitSquares(from, to) {
  if (board.needsPromotion(from, to)) { clearSelection(); showPromotion(from, to); return; }
  const move = board.findMove(from, to, 0);
  if (move) submitUserMove(move);
}

/** Pointer down on a square: move there, pick a piece up, or let go of the selection. */
function pushSquare(sq, x, y) {
  if (promotion) { closePromotion(); return; }
  if (p && p.phase === 'refuting') { restoreAfterWrong(); return; }
  if (p && p.phase === 'review') return;
  if (anim && p && p.phase === 'play') completeAnimation();
  if (!canMove() || sq < 0) return;
  if (marks.selected >= 0 && marks.targets.includes(sq)) { submitSquares(marks.selected, sq); return; }
  const piece = board.squares[sq];
  if (piece !== 0 && (piece > 0) === board.whiteToMove) {
    const wasSelected = marks.selected === sq;
    selectSquare(sq);
    press = { square: sq, x, y, wasSelected };
    dragging = false;
  } else clearSelection();
}

function movePointer(x, y) {
  if (!press) return;
  if (!dragging) {
    if (Math.abs(x - press.x) + Math.abs(y - press.y) < 5) return;
    dragging = true;
  }
  const node = pieceViews[press.square];
  if (!node) return;
  const rect = el.board.getBoundingClientRect();
  const size = rect.width / 8;
  node.classList.add('drag');
  node.style.transform = `translate(${x - rect.left - size / 2}px, ${y - rect.top - size / 2}px)`;
}

function popPointer(x, y) {
  const held = press;
  press = null;
  if (!held) return;
  if (dragging) {
    dragging = false;
    const target = squareAt(x, y);
    if (target >= 0 && marks.targets.includes(target)) { submitSquares(held.square, target); return; }
    // Dropped off a legal square: the piece goes home, still selected.
    showPosition(board);
    return;
  }
  if (held.wasSelected) clearSelection();
}

el.board.addEventListener('pointerdown', event => {
  if (event.button !== 0) return;
  event.preventDefault();
  try { el.board.setPointerCapture(event.pointerId); } catch {}
  pushSquare(squareAt(event.clientX, event.clientY), event.clientX, event.clientY);
});
el.board.addEventListener('pointermove', event => { if (press) movePointer(event.clientX, event.clientY); });
el.board.addEventListener('pointerup', event => popPointer(event.clientX, event.clientY));
el.board.addEventListener('pointercancel', () => { press = null; dragging = false; if (board) showPosition(board); });

// --- Keys and clicks --------------------------------------------------------------------------------
document.addEventListener('keydown', event => {
  if (!store) return;
  const name = event.key;
  if (isPicking) {
    const moves = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -2, ArrowDown: 2 };
    if (name === 'Escape') closePicker(false);
    else if (name === 'Enter') closePicker(true);
    else if (name in moves) movePick(moves[name]);
    else return;
    event.preventDefault();
    return;
  }
  if (event.ctrlKey || event.altKey || event.metaKey) return;
  if (p && p.phase === 'refuting' && name !== 'Escape' && !['Shift', 'Tab'].includes(name)) { restoreAfterWrong(); event.preventDefault(); return; }
  const review = p && p.phase === 'review';
  switch (name.length === 1 ? name.toLowerCase() : name) {
    case 'h': showHint(); break;
    case 'n': selectNextPuzzle(); break;
    case 'Enter': if (review) selectNextPuzzle(); break;
    case 't': openPicker(); break;
    case 'ArrowLeft': if (review) setReviewPly(p.reviewPly - 1); break;
    case 'ArrowRight': if (review) setReviewPly(p.reviewPly + 1); break;
    case 'Home': if (review) setReviewPly(1); break;
    case 'End': if (review) setReviewPly(p.line.length); break;
    case 'Escape': if (promotion) closePromotion(); else if (p && p.phase === 'refuting') restoreAfterWrong(); else clearSelection(); break;
    default: return;
  }
  event.preventDefault();
});

el.hint.addEventListener('click', () => { el.hint.blur(); showHint(); });
el.next.addEventListener('click', () => { el.next.blur(); selectNextPuzzle(); });
el.themeChip.addEventListener('click', () => { el.themeChip.blur(); if (isPicking) closePicker(false); else openPicker(); });
el.swatch.addEventListener('click', () => {
  el.swatch.blur();
  const names = Object.keys(BOARD_LOOKS);
  setBoardColour(names[(names.indexOf(progress.settings.board) + 1) % names.length]);
  savePrefs();
});
el.search.addEventListener('input', () => { if (isPicking) filterChips(); });
// A click outside the picker closes it without choosing.
document.addEventListener('pointerdown', event => { if (isPicking && !el.picker.contains(event.target) && !el.themeChip.contains(event.target)) closePicker(false); });
window.addEventListener('pagehide', () => { completeAnimation(); savePrefs(); if (engine) engine.quit(); });

// --- Demos: the real handlers, played instantly, for screenshots -------------------------------------
function clickSquare(sq) { pushSquare(sq, 0, 0); dragging = false; popPointer(0, 0); }
function solutionClick() {
  const move = board.parseUci(p.puzzle.moves[p.step]);
  clickSquare(move.from);
  if (board.needsPromotion(move.from, move.to)) { const m = board.findMove(move.from, move.to, move.promo); if (m) submitUserMove(m); return; }
  clickSquare(move.to);
}
function wrongClick() {
  const expected = p.puzzle.moves[p.step];
  for (const move of board.legalMoves()) {
    if (uci(move) === expected || move.promo !== 0 || board.play(move).isCheckmate()) continue;
    clickSquare(move.from);
    clickSquare(move.to);
    return;
  }
}
async function waitAnalysis() { while (analysis && analysisDone) await analysisDone; }
function untilDone(step) { for (let guard = 0; guard < 30 && p.phase === 'play'; guard++) step(); }

async function runDemo() {
  const chosen = store.get(params.get('puzzle')) || store.pick('fork', 1400, new Set(), seededRng(7)).puzzle;
  if (params.get('mode') === 'climb') { progress.settings.mode = 'climb'; updateMode(); }
  startPuzzle(chosen, true, 'Theme: Fork (demo)');
  switch (DEMO) {
    case 'hint': showHint(); showHint(); showHint(); break;
    case 'wrong': wrongClick(); await waitAnalysis(); break;
    case 'review': untilDone(solutionClick); break;
    case 'picker': openPicker(); el.search.value = 'mate'; filterChips(); break;
    case 'played':
      wrongClick();
      await waitAnalysis();
      if (p.phase === 'refuting') restoreAfterWrong();
      untilDone(solutionClick);
      break;
    case 'pieces':
      board = Board.fromFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
      setOrientation(false);
      marks.lastMove = null;
      showPosition(board);
      selectSquare(6);
      break;
  }
  document.body.dataset.demo = 'done';
}

// --- Life ------------------------------------------------------------------------------------------
async function fetchText(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.text();
}

async function main() {
  buildSettings();
  setBoardColour(progress.settings.board);
  drawMarks();
  let texts, saved;
  try {
    [texts, saved] = await Promise.all([
      Promise.all(['/data/ChessPuzzles.txt', '/data/ChessThemes.txt', '/data/ChessPieces.txt'].map(fetchText)),
      DEMO ? Promise.resolve(null) : loadSave('chess'),
    ]);
  } catch (error) {
    el.loading.textContent = `Could not load the puzzles: ${error.message}`;
    return;
  }
  store = PuzzleStore.fromText(texts[0]);
  glossary = parseGlossary(texts[1]);
  const art = parsePieces(texts[2]);
  el.pieceDefs.innerHTML = [...art].map(([code, paths]) => `<symbol id="piece${code < 0 ? 'b' : 'w'}${Math.abs(code)}" viewBox="0 0 45 45">${paths}</symbol>`).join('');
  const read = readProgress(saved, themeListed);
  progress = read.progress;
  setBoardColour(progress.settings.board);
  updateDifficulty();
  updateMode();
  updateRating();
  updateInfo();
  el.loading.hidden = true;
  // Stockfish starts in the background, so the first miss can use it.
  if (useEngine) confirmEngine();
  if (DEMO) { await runDemo(); return; }
  if (!(read.puzzle && resumePuzzle(read.puzzle))) selectNextPuzzle();
}

main().catch(error => { console.error(error); el.loading.hidden = false; el.loading.textContent = `Something broke: ${error.message}`; });
