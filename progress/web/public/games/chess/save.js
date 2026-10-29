// chess.json: reading it part by part (a bad part is dropped alone, never the rating),
// writing it, and checking a saved puzzle move by move. From ChessPuzzles.ps1
// (Read-SavedJson, Save-Prefs, Get-PuzzleSave, Restore-Puzzle). No DOM.
import { Board, uci } from './board.js';

export const HISTORY_MAX = 60;
export const CLIMB_START = 600, CLIMB_MIN = 400, CLIMB_MAX = 3000;
export const DIFFICULTIES = [
  { key: 'easiest', label: 'Easiest', offset: -600 },
  { key: 'easier', label: 'Easier', offset: -300 },
  { key: 'normal', label: 'Normal', offset: 0 },
  { key: 'harder', label: 'Harder', offset: 300 },
  { key: 'hardest', label: 'Hardest', offset: 600 },
];
// Light and dark squares; brown is Lichess's default board.
export const BOARD_LOOKS = { brown: ['#F0D9B5', '#B58863'], blue: ['#DEE3E6', '#8CA2AD'], green: ['#FFFFDD', '#86A666'], grey: ['#DCDCDC', '#ABABAB'] };

const num = value => (typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN);
export function clamped(value, low, high, fallback) {
  const v = num(value);
  if (Number.isNaN(v) || v < low || v > high) return fallback;
  return v;
}
const int = v => Math.trunc(v);

export function freshProgress() {
  return {
    settings: { theme: 'mix', difficulty: 'normal', board: 'brown', mode: 'normal' },
    rating: { r: 1500, rd: 500, vol: 0.09, games: 0, history: [] },
    climb: { level: CLIMB_START, best: CLIMB_START, games: 0, history: [] },
    solved: new Set(),
    counter: 0,
    retry: [],
  };
}

/**
 * The saved progress, each part checked on its own. themeListed(key) says whether a
 * theme may be chosen. Returns {progress, puzzle (the raw saved puzzle or null)}.
 */
export function readProgress(saved, themeListed = () => true) {
  const progress = freshProgress();
  if (!saved || typeof saved !== 'object') return { progress, puzzle: null };
  try {
    const r = saved.rating;
    if (r && typeof r === 'object') {
      progress.rating.r = clamped(r.r, 100, 4000, 1500);
      progress.rating.rd = clamped(r.rd, 30, 500, 500);
      progress.rating.vol = clamped(r.vol, 0.01, 1, 0.09);
      progress.rating.games = int(clamped(r.games, 0, 10000000, 0));
      for (const point of Array.isArray(r.history) ? r.history : []) {
        const value = num(point);
        if (value >= 100 && value <= 4000) progress.rating.history.push(value);
      }
    }
  } catch {}
  try {
    const c = saved.climb;
    if (c && typeof c === 'object') {
      progress.climb.level = int(clamped(c.level, CLIMB_MIN, CLIMB_MAX, CLIMB_START));
      progress.climb.best = int(clamped(c.best, CLIMB_MIN, CLIMB_MAX, progress.climb.level));
      progress.climb.games = int(clamped(c.games, 0, 10000000, 0));
      for (const point of Array.isArray(c.history) ? c.history : []) {
        const value = num(point);
        if (value >= CLIMB_MIN && value <= CLIMB_MAX) progress.climb.history.push(value);
      }
    }
  } catch {}
  try { for (const id of String(saved.solved ?? '').split(' ')) if (id) progress.solved.add(id); } catch {}
  try { progress.counter = int(clamped(saved.counter, 0, 10000000, 0)); } catch {}
  try {
    for (const entry of Array.isArray(saved.retry) ? saved.retry : []) {
      if (!entry || !entry.id) continue;
      progress.retry.push({ id: String(entry.id), due: int(num(entry.due)) || 0, mode: entry.mode === 'climb' ? 'climb' : 'normal' });
    }
  } catch {}
  try {
    const s = saved.settings;
    if (s && typeof s === 'object') {
      if (s.theme && themeListed(String(s.theme))) progress.settings.theme = String(s.theme);
      if (DIFFICULTIES.some(d => d.key === s.difficulty)) progress.settings.difficulty = s.difficulty;
      if (typeof s.board === 'string' && Object.hasOwn(BOARD_LOOKS, s.board)) progress.settings.board = s.board;
      if (s.mode === 'climb') progress.settings.mode = 'climb';
    }
  } catch {}
  progress.rating.history = progress.rating.history.slice(-HISTORY_MAX);
  progress.climb.history = progress.climb.history.slice(-HISTORY_MAX);
  return { progress, puzzle: saved.puzzle && typeof saved.puzzle === 'object' ? saved.puzzle : null };
}

const round = (value, places) => Math.round(value * 10 ** places) / 10 ** places;

/** The save, in the WPF shape (without the window's scale, dx and dy). */
export function buildSave(progress, puzzleState) {
  const save = {
    version: 1,
    settings: { ...progress.settings },
    rating: {
      r: round(progress.rating.r, 2), rd: round(progress.rating.rd, 2), vol: round(progress.rating.vol, 6),
      games: progress.rating.games, history: [...progress.rating.history],
    },
    climb: { level: progress.climb.level, best: progress.climb.best, games: progress.climb.games, history: [...progress.climb.history] },
    solved: [...progress.solved].join(' '),
    counter: progress.counter,
    retry: progress.retry.map(e => ({ id: e.id, due: e.due, mode: e.mode })),
  };
  if (puzzleState) save.puzzle = puzzleSave(puzzleState);
  return save;
}

/** A new puzzle's state. */
export function newPuzzleState(puzzle, rated, mode) {
  const start = Board.fromFen(puzzle.fen);
  return {
    puzzle, rated, mode: mode === 'climb' ? 'climb' : 'normal', step: 0, phase: 'play',
    line: [], hint: 0, hintNow: 0, mistakes: 0, pendingWrong: null, result: null, reviewPly: 0,
    feed: [], solverWhite: !start.whiteToMove,
  };
}

export function puzzleSave(p) {
  return {
    id: p.puzzle.id, mode: p.mode, step: p.step, line: [...p.line], phase: p.phase === 'review' ? 'review' : 'play',
    hint: p.hint, hintNow: p.hintNow, mistakes: p.mistakes, pendingWrong: p.pendingWrong,
    rated: p.rated, result: p.result, reviewPly: p.reviewPly,
    feed: p.feed.map(e => ({ kind: e.kind, san: e.san, text: e.text, squares: [...e.squares] })),
  };
}

/**
 * A saved puzzle checked move by move: only the final move may differ from the puzzle's
 * line (another mate). Returns {state, position, last, pendingWrong} or null.
 */
export function restorePuzzle(saved, store) {
  try {
    const puzzle = store.get(String(saved.id));
    if (!puzzle) return null;
    const state = newPuzzleState(puzzle, saved.rated === true, String(saved.mode));
    const moves = Array.isArray(saved.line) ? saved.line.map(String) : [];
    if (moves.length > puzzle.moves.length) return null;
    let position = Board.fromFen(puzzle.fen);
    let last = null;
    for (let k = 0; k < moves.length; k++) {
      const move = position.parseUci(moves[k]);
      if (!move) return null;
      const isMate = position.play(move).isCheckmate();
      if (moves[k] !== puzzle.moves[k] && !(k === moves.length - 1 && isMate)) {
        const official = position.parseUci(puzzle.moves[k]);
        if (!official || uci(official) !== uci(move)) return null;
      }
      state.line.push(uci(move));
      position = position.play(move);
      last = move;
    }
    state.step = moves.length;
    let phase = String(saved.phase);
    const isFinished = moves.length === puzzle.moves.length || position.isCheckmate();
    if (phase === 'review' && !isFinished) return null;
    if (phase !== 'review' && isFinished) phase = 'review';
    state.phase = phase === 'review' ? 'review' : 'play';
    state.hint = int(clamped(saved.hint, 0, 3, 0));
    state.hintNow = int(clamped(saved.hintNow, 0, 3, 0));
    state.mistakes = int(clamped(saved.mistakes, 0, 1000, 0));
    const result = saved.result;
    if (result && typeof result === 'object' && result.score != null) {
      const score = num(result.score);
      if ([0, 0.5, 1].includes(score)) state.result = { score, delta: int(num(result.delta)) || 0, applied: result.applied === true, best: result.best === true };
    }
    state.reviewPly = int(clamped(saved.reviewPly, 0, moves.length, moves.length));
    for (const entry of Array.isArray(saved.feed) ? saved.feed : []) {
      if (!entry || typeof entry.kind !== 'string' || entry.text == null) continue;
      const squares = (Array.isArray(entry.squares) ? entry.squares : []).map(Number).filter(n => Number.isInteger(n) && n >= 0 && n < 64);
      state.feed.push({ kind: entry.kind, san: String(entry.san ?? ''), text: String(entry.text), squares });
    }
    return { state, position, last, pendingWrong: !!saved.pendingWrong };
  } catch {
    return null;
  }
}
