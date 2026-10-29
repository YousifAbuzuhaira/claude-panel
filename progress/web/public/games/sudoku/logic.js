// Sudoku's generator and rules, ported from widget/Sudoku.ps1 (class SudokuGen and
// the game functions around it). No DOM.
// Grids are flat arrays of n*n, 0 for empty; boxes are boxRows x boxCols.
import { shuffle } from '../rng.js';

/** Box shape [rows, cols] and how many givens each size aims for. */
export const SHAPES = { 4: [2, 2], 6: [2, 3], 9: [3, 3] };
export const CLUES = { 4: 6, 6: 14, 9: 30 };
export const BUDGET_MS = 1500;
export const MAX_LIVES = 3;
export const UNDO_KEPT = 200;

const bits = mask => {
  let k = 0;
  while (mask !== 0) { mask &= mask - 1; k++; }
  return k;
};

// --- The generator (SudokuGen) -----------------------------------------------------

function boxOf(b, i) {
  const r = Math.floor(i / b.n);
  const c = i % b.n;
  return Math.floor(r / b.boxRows) * (b.n / b.boxCols) + Math.floor(c / b.boxCols);
}

function canPlace(b, i, d) {
  const bit = 1 << d;
  return ((b.rows[Math.floor(i / b.n)] | b.cols[i % b.n] | b.boxes[boxOf(b, i)]) & bit) === 0;
}

function put(b, i, d) {
  const bit = 1 << d;
  b.cells[i] = d;
  b.rows[Math.floor(i / b.n)] |= bit;
  b.cols[i % b.n] |= bit;
  b.boxes[boxOf(b, i)] |= bit;
}

function unput(b, i) {
  const bit = ~(1 << b.cells[i]);
  b.rows[Math.floor(i / b.n)] &= bit;
  b.cols[i % b.n] &= bit;
  b.boxes[boxOf(b, i)] &= bit;
  b.cells[i] = 0;
}

const free = (b, i) => b.full & ~(b.rows[Math.floor(i / b.n)] | b.cols[i % b.n] | b.boxes[boxOf(b, i)]);

function load(grid, n, boxRows, boxCols) {
  const b = {
    n, boxRows, boxCols,
    full: ((1 << (n + 1)) - 1) & ~1,
    cells: [...grid],
    rows: new Array(n).fill(0), cols: new Array(n).fill(0), boxes: new Array(n).fill(0),
    rng: null,
  };
  for (let i = 0; i < n * n; i++) {
    const d = b.cells[i];
    if (d === 0) continue;
    if (!Number.isInteger(d) || d < 1 || d > n || !canPlace(b, i, d)) return null;
    put(b, i, d);
  }
  return b;
}

// Backtracking on the most constrained cell. Counts solutions up to limit;
// with keepFirst the first solution is left in the board.
function search(b, limit, keepFirst) {
  const n = b.n;
  let best = -1;
  let bestFree = 0;
  let bestBits = n + 1;
  for (let i = 0; i < n * n; i++) {
    if (b.cells[i] !== 0) continue;
    const f = free(b, i);
    const k = bits(f);
    if (k === 0) return 0;
    if (k < bestBits) {
      best = i; bestFree = f; bestBits = k;
      if (k === 1) break;
    }
  }
  if (best < 0) return 1;

  const digits = [];
  for (let d = 1; d <= n; d++) if (bestFree & (1 << d)) digits.push(d);
  if (b.rng) shuffle(digits, b.rng);

  let total = 0;
  for (const d of digits) {
    put(b, best, d);
    total += search(b, limit - total, keepFirst);
    if (total >= limit && keepFirst) return total;
    unput(b, best);
    if (total >= limit) return total;
  }
  return total;
}

export function countSolutions(grid, n, boxRows, boxCols, limit) {
  const b = load(grid, n, boxRows, boxCols);
  return b === null ? 0 : search(b, limit, false);
}

/** Every row, column and box, as lists of cells. */
export function units(n, boxRows, boxCols) {
  const list = [];
  for (let u = 0; u < 3 * n; u++) list.push(new Array(n));
  for (let u = 0; u < n; u++) {
    const top = Math.floor(u / (n / boxCols)) * boxRows;
    const left = (u % (n / boxCols)) * boxCols;
    for (let k = 0; k < n; k++) {
      list[u][k] = u * n + k;
      list[n + u][k] = k * n + u;
      list[2 * n + u][k] = (top + Math.floor(k / boxCols)) * n + left + (k % boxCols);
    }
  }
  return list;
}

/**
 * True when naked and hidden singles alone fill the grid: every step is forced,
 * so the solution is unique and a person never has to guess.
 */
export function solvesBySingles(grid, n, boxRows, boxCols) {
  const b = load(grid, n, boxRows, boxCols);
  if (b === null) return false;
  const all = units(n, boxRows, boxCols);
  let moved = true;
  while (moved) {
    moved = false;
    for (let i = 0; i < n * n; i++) {
      if (b.cells[i] !== 0) continue;
      const f = free(b, i);
      if (f === 0) return false;
      if (bits(f) === 1) {
        let d = 1;
        while ((f & (1 << d)) === 0) d++;
        put(b, i, d);
        moved = true;
      }
    }
    for (const unit of all) {
      for (let d = 1; d <= n; d++) {
        let at = -1;
        let places = 0;
        let isPlaced = false;
        for (const i of unit) {
          if (b.cells[i] === d) { isPlaced = true; break; }
          if (b.cells[i] === 0 && (free(b, i) & (1 << d)) !== 0) { at = i; places++; }
        }
        if (isPlaced) continue;
        if (places === 0) return false;
        if (places === 1) { put(b, at, d); moved = true; }
      }
    }
  }
  return b.cells.every(d => d !== 0);
}

export function isValidSolution(grid, n, boxRows, boxCols) {
  if (!Array.isArray(grid) || grid.length !== n * n) return false;
  if (!grid.every(d => Number.isInteger(d) && d >= 1 && d <= n)) return false;
  return load(grid, n, boxRows, boxCols) !== null;
}

export const givensMatch = (givens, solution) => givens.every((g, i) => g === 0 || g === solution[i]);

/**
 * A full random grid, then givens taken away in random order while the puzzle
 * still solves by singles. Out of time only leaves more givens.
 */
export function generate(n, boxRows, boxCols, targetClues, rng = Math.random, budgetMs = BUDGET_MS, now = () => performance.now()) {
  const started = now();
  const b = load(new Array(n * n).fill(0), n, boxRows, boxCols);
  b.rng = rng;
  search(b, 1, true);

  const solution = [...b.cells];
  const givens = [...b.cells];
  const order = shuffle([...Array(n * n).keys()], rng);
  let clues = n * n;
  for (const i of order) {
    if (clues <= targetClues || now() - started > budgetMs) break;
    const kept = givens[i];
    givens[i] = 0;
    if (solvesBySingles(givens, n, boxRows, boxCols)) clues--;
    else givens[i] = kept;
  }
  return { givens, solution, clues, ms: now() - started };
}

export function newPuzzle(side, rng = Math.random, now) {
  const [boxRows, boxCols] = SHAPES[side];
  return generate(side, boxRows, boxCols, CLUES[side], rng, BUDGET_MS, now);
}

// --- The game ------------------------------------------------------------------------

export const STATUS = {
  solved: 'Solved! · New for another',
  outOfLives: 'Out of lives — new puzzle',
  oneAtATime: 'Answers go in one square at a time',
};

/**
 * One puzzle in play: the board, the selection, lives, mode, undo. Every method
 * changes it in place and returns whether anything changed that should be saved.
 */
export class Sudoku {
  constructor({ rng = Math.random, now } = {}) {
    this.rng = rng;
    this.now = now;
    this.mode = 'answer';
    this.n = 0;
  }

  /** A fresh puzzle of this size (the mode carries over). */
  newGame(side) {
    const puzzle = newPuzzle(side, this.rng, this.now);
    this.setSize(side);
    this.solution = puzzle.solution;
    this.values = [...puzzle.givens];
    this.given = this.values.map(v => v !== 0);
    this.wrong = new Array(side * side).fill(false);
    this.notes = new Array(side * side).fill(0);
    this.lives = MAX_LIVES;
    this.reset();
    return true;
  }

  setSize(side) {
    this.n = side;
    [this.boxRows, this.boxCols] = SHAPES[side];
  }

  reset() {
    this.picked = [];
    this.selected = -1;
    this.history = [];
    this.isSolved = false;
    this.status = '';
    this.statusTone = 'dim';
  }

  setStatus(text, tone = 'dim') {
    this.status = text;
    this.statusTone = tone;
  }

  /**
   * The kept game, checked before it is trusted: its solution must be a full
   * valid grid and its givens must agree with it. False (and nothing changed) when off.
   */
  restore(game) {
    if (!game || typeof game !== 'object') return false;
    const side = game.size;
    if (!SHAPES[side]) return false;
    const [boxRows, boxCols] = SHAPES[side];
    const total = side * side;
    const { solution, values, given, wrong, notes } = game;
    for (const list of [solution, values, given, wrong, notes]) if (!Array.isArray(list) || list.length !== total) return false;
    if (!isValidSolution(solution, side, boxRows, boxCols)) return false;
    if (!values.every(v => Number.isInteger(v) && v >= 0 && v <= side)) return false;
    if (!given.every(v => typeof v === 'boolean') || !wrong.every(v => typeof v === 'boolean')) return false;
    if (!notes.every(v => Number.isInteger(v) && v >= 0)) return false;
    for (let i = 0; i < total; i++) if (given[i] && values[i] !== solution[i]) return false;
    this.setSize(side);
    this.solution = [...solution];
    this.values = [...values];
    this.given = [...given];
    this.wrong = [...wrong];
    this.notes = [...notes];
    this.lives = Math.max(1, Math.min(MAX_LIVES, Number.isInteger(game.lives) ? game.lives : MAX_LIVES));
    this.mode = game.mode === 'notes' ? 'notes' : 'answer';
    this.reset();
    return true;
  }

  /** The game for the save, or null once solved (a solved game is not kept). */
  toSave() {
    if (this.isSolved || !this.solution) return null;
    return {
      size: this.n, solution: [...this.solution], values: [...this.values], given: [...this.given],
      wrong: [...this.wrong], notes: [...this.notes], lives: this.lives, mode: this.mode,
    };
  }

  row(i) { return Math.floor(i / this.n); }

  /** Every cell sharing a row, a column or a box with this one, itself included. */
  peers(index) {
    const n = this.n;
    const r = this.row(index);
    const c = index % n;
    const top = r - (r % this.boxRows);
    const left = c - (c % this.boxCols);
    const set = new Set();
    for (let k = 0; k < n; k++) { set.add(r * n + k); set.add(k * n + c); }
    for (let dr = 0; dr < this.boxRows; dr++) for (let dc = 0; dc < this.boxCols; dc++) set.add((top + dr) * n + left + dc);
    return set;
  }

  // The selected squares. `selected` is the one picked last: the arrows move
  // from it and an answer goes into it.
  selectOnly(index) {
    this.picked = index >= 0 ? [index] : [];
    this.selected = index;
  }

  selectAdd(index) {
    if (!this.picked.includes(index)) this.picked.push(index);
    this.selected = index;
  }

  selectToggle(index) {
    if (this.picked.includes(index) && this.picked.length > 1) {
      this.picked = this.picked.filter(i => i !== index);
      this.selected = this.picked[this.picked.length - 1];
    } else {
      this.selectAdd(index);
    }
  }

  /** The arrows move the selection; with Shift or Ctrl held they grow it. */
  moveSelection(rows, cols, extend) {
    if (this.isSolved) return;
    if (this.selected < 0) { this.selectOnly(0); return; }
    const n = this.n;
    const r = Math.max(0, Math.min(n - 1, this.row(this.selected) + rows));
    const c = Math.max(0, Math.min(n - 1, (this.selected % n) + cols));
    if (extend) this.selectAdd(r * n + c);
    else this.selectOnly(r * n + c);
  }

  switchMode() {
    this.mode = this.mode === 'answer' ? 'notes' : 'answer';
    this.setStatus('');
    return true;
  }

  /** Does a plain digit go in as a note now? `flip` is Shift or Ctrl held. */
  notesNow(flip) { return (this.mode === 'notes') !== Boolean(flip); }

  saveUndo() {
    this.history.push({ values: [...this.values], wrong: [...this.wrong], notes: [...this.notes] });
    if (this.history.length > UNDO_KEPT) this.history.shift();
  }

  /** Undo takes back squares and notes, never a lost life. */
  undo() {
    if (this.isSolved || this.history.length === 0) return false;
    const last = this.history.pop();
    this.values = last.values;
    this.wrong = last.wrong;
    this.notes = last.notes;
    this.setStatus('');
    return true;
  }

  /**
   * A correct answer settles its cell: its own notes go, and so does that digit
   * from the notes of every cell in its row, column and box.
   */
  removePeerNotes(index, digit) {
    const keep = ~(1 << digit);
    for (const peer of this.peers(index)) this.notes[peer] &= keep;
    this.notes[index] = 0;
  }

  /**
   * A digit goes in as a note or an answer: the mode decides, and `flip` (Shift
   * or Ctrl held) turns it the other way for this one digit.
   */
  enterDigit(digit, flip = false) {
    if (this.isSolved || this.picked.length === 0 || digit < 1 || digit > this.n) return false;
    if (this.notesNow(flip)) return this.writeNote(digit);
    if (this.picked.length > 1) {
      this.setStatus(STATUS.oneAtATime);
      return false;
    }
    const i = this.selected;
    if (this.given[i]) return false;
    // A right answer is final.
    if (this.values[i] !== 0 && !this.wrong[i]) return false;
    // The same wrong digit twice costs one life, not two.
    if (this.wrong[i] && this.values[i] === digit) return false;
    this.setStatus('');
    this.saveUndo();

    if (digit === this.solution[i]) {
      this.values[i] = digit;
      this.wrong[i] = false;
      this.removePeerNotes(i, digit);
      if (this.values.every((v, k) => v === this.solution[k])) {
        this.isSolved = true;
        this.selectOnly(-1);
        this.setStatus(STATUS.solved, 'green');
      }
    } else {
      // A wrong digit stays red, until erased or typed over.
      this.values[i] = digit;
      this.wrong[i] = true;
      this.lives--;
      if (this.lives <= 0) {
        this.newGame(this.n);
        this.setStatus(STATUS.outOfLives, 'red');
      }
    }
    return true;
  }

  /** The open selected squares: not given, and empty or red. */
  openPicked() {
    return this.picked.filter(i => !this.given[i] && (this.values[i] === 0 || this.wrong[i]));
  }

  /**
   * A pencil mark goes into every open selected square, or comes out of all of
   * them when they all have it. It replaces a red answer, as typing over it would.
   */
  writeNote(digit) {
    const open = this.openPicked();
    if (open.length === 0) return false;
    this.saveUndo();
    const bit = 1 << digit;
    const isEverywhere = open.every(i => !this.wrong[i] && (this.notes[i] & bit) !== 0);
    for (const i of open) {
      this.values[i] = 0;
      this.wrong[i] = false;
      if (isEverywhere) this.notes[i] &= ~bit;
      else this.notes[i] |= bit;
    }
    this.setStatus('');
    return true;
  }

  /** Erase: a red answer goes (bringing back the notes under it), else the notes go. */
  clearCell() {
    if (this.isSolved) return false;
    const open = this.picked.filter(i => !this.given[i] && (this.wrong[i] || (this.values[i] === 0 && this.notes[i] !== 0)));
    if (open.length === 0) return false;
    this.saveUndo();
    for (const i of open) {
      if (this.wrong[i]) { this.values[i] = 0; this.wrong[i] = false; }
      else this.notes[i] = 0;
    }
    this.setStatus('');
    return true;
  }

  /** How many times each digit stands right on the board (for dimming the pad). */
  placedCounts() {
    const counts = new Array(this.n + 1).fill(0);
    this.values.forEach((v, i) => { if (v !== 0 && !this.wrong[i]) counts[v]++; });
    return counts;
  }
}

// --- The save: {size, game?} --------------------------------------------------------------

/** The save file, each part checked on its own. `game` is passed through raw: Sudoku.restore checks it. */
export function readSave(raw) {
  const value = raw && typeof raw === 'object' ? raw : {};
  return { size: SHAPES[value.size] ? value.size : 9, game: value.game && typeof value.game === 'object' ? value.game : null };
}

export function saveOf(sudoku) {
  const save = { size: sudoku.n };
  const game = sudoku.toSave();
  if (game) save.game = game;
  return save;
}

