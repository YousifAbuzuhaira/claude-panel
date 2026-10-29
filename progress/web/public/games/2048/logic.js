// 2048's rules, ported from widget/Game2048.ps1 (class G2048). No DOM.
// A board is a flat array of 16 numbers, 0 for empty, row by row.

export const SIDE = 4;
export const CELLS = SIDE * SIDE;
export const WIN_TILE = 2048;

/** dir: 0 up, 1 right, 2 down, 3 left. */
export const DIRS = { up: 0, right: 1, down: 2, left: 3 };

/** The k-th cell of a line, counted from the wall the tiles move toward. */
export function cellOf(dir, line, k) {
  switch (dir) {
    case 0: return k * SIDE + line;
    case 1: return line * SIDE + (SIDE - 1 - k);
    case 2: return (SIDE - 1 - k) * SIDE + line;
    default: return line * SIDE + k;
  }
}

/**
 * Every tile slides toward the wall; a tile meeting an equal one that has not
 * merged this move merges with it. [2,2,2,2] left is [4,4,0,0].
 * from[k] -> to[k] says where each tile went; two tiles going to one cell merged there.
 */
export function move(board, dir) {
  const next = new Array(CELLS).fill(0);
  const from = [];
  const to = [];
  const merged = [];
  let gained = 0;
  for (let line = 0; line < SIDE; line++) {
    let write = 0;
    let lastValue = 0;
    let canMerge = false;
    for (let k = 0; k < SIDE; k++) {
      const cell = cellOf(dir, line, k);
      const v = board[cell];
      if (v === 0) continue;
      if (canMerge && lastValue === v) {
        const into = cellOf(dir, line, write - 1);
        next[into] = v * 2;
        gained += v * 2;
        merged.push(into);
        from.push(cell);
        to.push(into);
        canMerge = false;
      } else {
        const into = cellOf(dir, line, write);
        next[into] = v;
        from.push(cell);
        to.push(into);
        lastValue = v;
        canMerge = true;
        write++;
      }
    }
  }
  const moved = next.some((v, i) => v !== board[i]);
  return { board: next, moved, gained, from, to, merged };
}

/** A move is left while a cell is empty or two equal tiles touch. */
export function canMove(board) {
  for (let i = 0; i < board.length; i++) {
    if (board[i] === 0) return true;
    const r = Math.floor(i / SIDE);
    const c = i % SIDE;
    if (c + 1 < SIDE && board[i + 1] === board[i]) return true;
    if (r + 1 < SIDE && board[i + SIDE] === board[i]) return true;
  }
  return false;
}

/** One new tile in a random empty cell (in place): a 2, or a 4 one time in ten. Its cell, or -1. */
export function spawn(board, rng = Math.random) {
  const empty = [];
  for (let i = 0; i < board.length; i++) if (board[i] === 0) empty.push(i);
  if (empty.length === 0) return -1;
  const at = empty[Math.floor(rng() * empty.length)];
  board[at] = rng() < 0.9 ? 2 : 4;
  return at;
}

// --- A game: the board, the score, and where it stands ---------------------------

export function newGame(rng = Math.random) {
  const board = new Array(CELLS).fill(0);
  spawn(board, rng);
  spawn(board, rng);
  return { board, score: 0, won: false, keepPlaying: false, over: false };
}

/** Is play paused on the board (game over, or the win message showing)? */
export const isStopped = game => game.over || (game.won && !game.keepPlaying);

/**
 * One move on a game, in place. Returns null when it is no move (stopped, or
 * nothing changed); otherwise the move, plus the new tile's cell as `spawned`.
 */
export function play(game, dir, rng = Math.random) {
  if (isStopped(game)) return null;
  const result = move(game.board, dir);
  if (!result.moved) return null;
  game.board = result.board;
  game.score += result.gained;
  const spawned = spawn(game.board, rng);
  if (!game.won && result.merged.length > 0 && game.board.includes(WIN_TILE)) game.won = true;
  if (!canMove(game.board)) game.over = true;
  return { ...result, spawned };
}

// --- The save: {best, game?: {board[16], score, won, keepPlaying}} ---------------------

const isTile = v => Number.isInteger(v) && (v === 0 || (v >= 2 && (v & (v - 1)) === 0));

/** A kept game, checked; null when any of it is off (or it is already over). */
export function readGame(saved) {
  if (!saved || typeof saved !== 'object') return null;
  const { board, score } = saved;
  if (!Array.isArray(board) || board.length !== CELLS || !board.every(isTile)) return null;
  if (!canMove(board)) return null;
  if (!Number.isInteger(score) || score < 0) return null;
  return { board: [...board], score, won: saved.won === true, keepPlaying: saved.keepPlaying === true, over: false };
}

/** The save file, each part checked on its own: a bad part is dropped, the rest kept. */
export function readSave(raw) {
  const value = raw && typeof raw === 'object' ? raw : {};
  const best = Number.isInteger(value.best) && value.best > 0 ? value.best : 0;
  const game = readGame(value.game);
  return { best: game ? Math.max(best, game.score) : best, game };
}

/** What to write: a finished game is not kept, so the next visit starts fresh. */
export function saveOf(best, game) {
  const save = { best };
  if (game && !game.over) save.game = { board: [...game.board], score: game.score, won: game.won, keepPlaying: game.keepPlaying };
  return save;
}
