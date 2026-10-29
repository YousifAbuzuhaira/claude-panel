// The Sudoku page: draws the board, takes keys and clicks, keeps the save.
import { loadSave, writeSave, withToken } from '../../shared/api.js';
import { rngFor, seedFromUrl } from '../rng.js';
import { MAX_LIVES, Sudoku, readSave, saveOf } from './logic.js';

// Cell px, value and note font px, by board size.
const LOOKS = {
  4: { cell: 76, value: 31, note: 15 },
  6: { cell: 62, value: 27, note: 13 },
  9: { cell: 50, value: 24, note: 12 },
};

const $ = id => document.getElementById(id);
const boardEl = $('board');
const padEl = $('pad');
const params = new URLSearchParams(location.search);
const isDemo = params.has('demo');
const game = new Sudoku({ rng: rngFor(seedFromUrl()) });

document.querySelector('a.back').href = withToken('../');

let cells = []; // per cell: { el, value, notes, noteSpans }
let padButtons = [];
let flipHeld = false; // Shift or Ctrl held: a digit goes the other way
let dragSelecting = false;
let ready = false;

function save() {
  if (isDemo || !ready) return;
  writeSave('sudoku', saveOf(game));
}

function buildBoard() {
  const n = game.n;
  const look = LOOKS[n];
  boardEl.style.setProperty('--cell', `${look.cell}px`);
  boardEl.style.setProperty('--value', `${look.value}px`);
  boardEl.style.setProperty('--note', `${look.note}px`);
  boardEl.style.gridTemplateColumns = `repeat(${n}, var(--cell))`;
  boardEl.textContent = '';
  cells = [];
  for (let i = 0; i < n * n; i++) {
    const r = Math.floor(i / n);
    const c = i % n;
    const el = document.createElement('div');
    el.className = 'cell';
    if (c === 0) el.classList.add('col0');
    else if (c % game.boxCols === 0) el.classList.add('boxl');
    if (r === 0) el.classList.add('row0');
    else if (r % game.boxRows === 0) el.classList.add('boxt');
    el.dataset.index = i;
    const notes = document.createElement('div');
    notes.className = 'notes';
    notes.style.gridTemplateColumns = `repeat(${game.boxCols}, 1fr)`;
    notes.style.gridTemplateRows = `repeat(${game.boxRows}, 1fr)`;
    const noteSpans = [];
    for (let d = 1; d <= n; d++) {
      const span = document.createElement('span');
      notes.append(span);
      noteSpans.push(span);
    }
    const value = document.createElement('span');
    value.className = 'value';
    el.append(notes, value);
    boardEl.append(el);
    cells.push({ el, value, notes, noteSpans });
  }

  padEl.textContent = '';
  padButtons = [];
  for (let d = 1; d <= n; d++) {
    const button = document.createElement('button');
    button.className = 'press';
    button.textContent = d;
    button.addEventListener('click', event => act(() => game.enterDigit(d, event.shiftKey || event.ctrlKey)));
    padEl.append(button);
    padButtons.push(button);
  }
  const erase = document.createElement('button');
  erase.className = 'press';
  erase.textContent = '⌫';
  erase.title = 'Erase (Backspace); Ctrl+Z undoes';
  erase.addEventListener('click', () => act(() => game.clearCell()));
  padEl.append(erase);
}

function draw() {
  if (cells.length !== game.n * game.n) buildBoard();
  const n = game.n;
  const sel = game.selected;
  let peers = null;
  let selValue = 0;
  if (game.picked.length === 1) {
    peers = game.peers(sel);
    if (!game.wrong[sel]) selValue = game.values[sel];
  }
  // The selection's colour says where a plain digit goes now: orange answers,
  // blue notes. Holding Shift or Ctrl flips it at once.
  const asNote = game.notesNow(flipHeld);
  const picked = new Set(game.picked);
  for (let i = 0; i < n * n; i++) {
    const cell = cells[i];
    const v = game.values[i];
    const isPicked = picked.has(i);
    cell.el.classList.toggle('pick', isPicked);
    cell.el.classList.toggle('as-note', isPicked && asNote);
    const isSame = !isPicked && selValue !== 0 && v === selValue && !game.wrong[i];
    cell.el.classList.toggle('same', isSame);
    cell.el.classList.toggle('peer', !isPicked && !isSame && peers !== null && peers.has(i));
    if (v !== 0) {
      cell.value.textContent = v;
      cell.value.className = `value ${game.given[i] ? 'given' : game.wrong[i] ? 'wrong' : 'right'}`;
      cell.notes.style.visibility = 'hidden';
    } else {
      cell.value.textContent = '';
      cell.notes.style.visibility = 'visible';
      const mask = game.notes[i];
      for (let d = 1; d <= n; d++) {
        const span = cell.noteSpans[d - 1];
        const has = (mask & (1 << d)) !== 0;
        span.textContent = has ? d : '';
        // Notes of the selected square's number stand out with its squares.
        span.classList.toggle('lit', has && d === selValue);
      }
    }
  }
  drawChrome();
}

function drawChrome() {
  const n = game.n;
  $('title').textContent = `Sudoku ${n}x${n}`;
  const hearts = $('hearts');
  hearts.textContent = '';
  for (let k = 0; k < MAX_LIVES; k++) {
    const heart = document.createElement('span');
    heart.textContent = '♥';
    if (k >= game.lives) heart.className = 'lost';
    hearts.append(heart);
  }
  for (const button of document.querySelectorAll('[data-mode]')) button.classList.toggle('on', button.dataset.mode === game.mode);
  for (const button of document.querySelectorAll('[data-size]')) button.classList.toggle('on', Number(button.dataset.size) === n);
  // A digit already placed everywhere it goes is dimmed on the pad.
  const counts = game.placedCounts();
  padButtons.forEach((button, k) => button.classList.toggle('done', counts[k + 1] >= n));

  const status = $('status');
  let text = game.status;
  let tone = game.statusTone;
  if (!text) {
    tone = 'dim';
    text = game.mode === 'notes' ? 'Notes · Shift+digit answers · Space switches' : 'Answer · Shift+digit notes · Space switches';
  }
  status.textContent = text;
  status.className = tone;
}

/** Runs a change, saves it when it says it changed something, and redraws. */
function act(change) {
  if (!ready) return;
  if (change()) save();
  draw();
}

function newGame(side) {
  act(() => game.newGame(side));
}

// --- Keys --------------------------------------------------------------------------
// Digits answer, Shift or Ctrl + digit notes (or the other way in Notes mode).
// Space or N switches the mode, Ctrl+Z undoes, arrows move and with Shift or Ctrl
// grow the selection.

function digitOf(code) {
  const match = /^(?:Digit|Numpad)([0-9])$/.exec(code);
  return match ? Number(match[1]) : -1;
}

const ARROWS = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };

document.addEventListener('keydown', event => {
  if (event.key === 'Shift' || event.key === 'Control') {
    if (!flipHeld) { flipHeld = true; draw(); }
    return;
  }
  const flip = event.shiftKey || event.ctrlKey;
  const digit = digitOf(event.code);
  if (digit >= 1 && !event.metaKey && !event.altKey) {
    event.preventDefault();
    act(() => game.enterDigit(digit, flip));
    return;
  }
  if ((event.ctrlKey || event.metaKey) && event.code === 'KeyZ') {
    event.preventDefault();
    act(() => game.undo());
    return;
  }
  if (event.metaKey || event.altKey) return;
  if (ARROWS[event.key]) {
    event.preventDefault();
    const [rows, cols] = ARROWS[event.key];
    act(() => { game.moveSelection(rows, cols, flip); return false; });
    return;
  }
  if (event.ctrlKey) return;
  if (event.key === ' ' || event.code === 'KeyN') {
    event.preventDefault();
    act(() => game.switchMode());
  } else if (event.key === 'Backspace' || event.key === 'Delete' || digit === 0) {
    event.preventDefault();
    act(() => game.clearCell());
  } else if (event.key === 'Escape') {
    act(() => { game.selectOnly(-1); return false; });
  }
});

document.addEventListener('keyup', event => {
  if ((event.key === 'Shift' || event.key === 'Control') && flipHeld !== (event.shiftKey || event.ctrlKey)) {
    flipHeld = event.shiftKey || event.ctrlKey;
    draw();
  }
});
addEventListener('blur', () => { if (flipHeld) { flipHeld = false; draw(); } });

// --- Mouse: click, Ctrl-click (or Cmd-click) toggles, Shift-click adds, drag adds ----

const cellIndex = target => {
  const el = target instanceof Element ? target.closest('.cell') : null;
  return el ? Number(el.dataset.index) : -1;
};

boardEl.addEventListener('mousedown', event => {
  if (event.button !== 0) return;
  const index = cellIndex(event.target);
  if (index < 0) return;
  event.preventDefault();
  if (event.ctrlKey || event.metaKey) game.selectToggle(index);
  else if (event.shiftKey) game.selectAdd(index);
  else game.selectOnly(index);
  dragSelecting = true;
  draw();
});
boardEl.addEventListener('mouseover', event => {
  if (!dragSelecting) return;
  if ((event.buttons & 1) === 0) { dragSelecting = false; return; }
  const index = cellIndex(event.target);
  if (index < 0 || game.picked.includes(index)) return;
  game.selectAdd(index);
  draw();
});
addEventListener('mouseup', () => { dragSelecting = false; });
// Ctrl-click on a Mac opens the context menu; on the board it selects instead.
boardEl.addEventListener('contextmenu', event => event.preventDefault());

for (const button of document.querySelectorAll('[data-mode]')) {
  button.addEventListener('click', () => act(() => (game.mode !== button.dataset.mode ? game.switchMode() : false)));
}
for (const button of document.querySelectorAll('[data-size]')) button.addEventListener('click', () => newGame(Number(button.dataset.size)));
$('new').addEventListener('click', () => newGame(game.n));
// Buttons never keep the focus, so Space always switches the mode.
for (const button of document.querySelectorAll('button')) button.addEventListener('mousedown', event => event.preventDefault());
padEl.addEventListener('mousedown', event => event.preventDefault());

// --- A snapshot: one right answer, one wrong, notes, a selection (?demo) -------------

function showDemo() {
  const n = game.n;
  const empty = [];
  for (let i = 0; i < n * n; i++) if (!game.given[i]) empty.push(i);
  game.selectOnly(empty[0]);
  game.enterDigit(game.solution[empty[0]]);
  game.selectOnly(empty[1]);
  game.enterDigit((game.solution[empty[1]] % n) + 1);
  game.mode = 'notes';
  for (let k = 2; k < Math.min(6, empty.length); k++) {
    game.selectOnly(empty[k]);
    game.enterDigit(game.solution[empty[k]]);
    game.enterDigit((game.solution[empty[k]] % n) + 1);
  }
  game.selectOnly(empty[2]);
  const noted = game.solution[empty[2]];
  for (let i = 0; i < n * n; i++) if (game.given[i] && game.values[i] === noted) { game.selectOnly(i); break; }
}

async function start() {
  const saved = readSave(isDemo ? null : await loadSave('sudoku'));
  const size = Number(params.get('size')) || saved.size;
  // The game left open comes back as it was; anything else starts a new puzzle.
  const restored = !params.get('size') && saved.game && game.restore(saved.game);
  if (!restored) game.newGame([4, 6, 9].includes(size) ? size : 9);
  if (isDemo) showDemo();
  ready = true;
  save();
  draw();
}

start();
