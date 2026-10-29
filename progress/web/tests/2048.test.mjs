// 2048's rules: the WPF self-test's cases, plus play and the save.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canMove, move, newGame, play, readSave, saveOf, spawn } from '../public/games/2048/logic.js';
import { seeded } from '../public/games/rng.js';

const Z = new Array(12).fill(0);
const line = (before, dir, after, gain) => {
  const result = move(before, dir);
  assert.deepEqual(result.board, after);
  assert.equal(result.gained, gain);
  return result;
};

test('each pair merges once per move, nearest the wall first', () => {
  line([2, 2, 2, 2, ...Z], 3, [4, 4, 0, 0, ...Z], 8);
  line([2, 2, 2, 0, ...Z], 3, [4, 2, 0, 0, ...Z], 4);
  line([2, 2, 2, 0, ...Z], 1, [0, 0, 2, 4, ...Z], 4);
  line([4, 4, 8, 0, ...Z], 3, [8, 8, 0, 0, ...Z], 8);
  line([2, 0, 2, 4, ...Z], 3, [4, 4, 0, 0, ...Z], 4);
  line([0, 2, 0, 4, ...Z], 3, [2, 4, 0, 0, ...Z], 0);
});

test('up and down move columns', () => {
  const column = [2, 0, 0, 0, 2, 0, 0, 0, 4, 0, 0, 0, 4, 0, 0, 0];
  line(column, 0, [4, 0, 0, 0, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 12);
  line(column, 2, [0, 0, 0, 0, 0, 0, 0, 0, 4, 0, 0, 0, 8, 0, 0, 0], 12);
});

test('a move records where tiles went and where they merged', () => {
  const result = move([2, 2, 0, 4, ...Z], 3);
  assert.deepEqual(result.from, [0, 1, 3]);
  assert.deepEqual(result.to, [0, 0, 1]);
  assert.deepEqual(result.merged, [0]);
});

test('a move into a wall that changes nothing is no move', () => {
  assert.equal(move([2, 4, 8, 16, ...Z], 3).moved, false);
  const game = { board: [2, 4, 8, 16, ...Z], score: 0, won: false, keepPlaying: false, over: false };
  assert.equal(play(game, 3, seeded(1)), null);
  assert.deepEqual(game.board, [2, 4, 8, 16, ...Z]);
});

test('game over only when full with no equal neighbours', () => {
  const full = [2, 4, 2, 4, 4, 2, 4, 2, 2, 4, 2, 4, 4, 2, 4, 2];
  assert.equal(canMove(full), false);
  const pair = [...full];
  pair[15] = 4;
  assert.equal(canMove(pair), true);
});

test('new tiles: a 4 about one time in ten, into empty cells only', () => {
  const rng = seeded(7);
  let fours = 0;
  for (let i = 0; i < 10000; i++) {
    const board = new Array(16).fill(0);
    board[0] = 8;
    const at = spawn(board, rng);
    assert.notEqual(at, 0);
    if (board[at] === 4) fours++;
  }
  assert.ok(fours > 850 && fours < 1150, `fours: ${fours}`);
  assert.equal(spawn(new Array(16).fill(2), rng), -1);
});

test('a new game has two tiles; a move adds one and scores', () => {
  const game = newGame(seeded(3));
  assert.equal(game.board.filter(v => v).length, 2);
  game.board = [2, 2, 0, 0, ...Z];
  const result = play(game, 3, seeded(3));
  assert.equal(game.score, 4);
  assert.equal(game.board.filter(v => v).length, 2);
  assert.ok(result.spawned >= 0);
});

test('making 2048 wins; play stops until keep going', () => {
  const game = { board: [1024, 1024, 0, 0, ...Z], score: 0, won: false, keepPlaying: false, over: false };
  play(game, 3, seeded(5));
  assert.equal(game.won, true);
  assert.equal(play(game, 1, seeded(5)), null);
  game.keepPlaying = true;
  assert.notEqual(play(game, 1, seeded(5)), null);
});

test('a move fills the empty cell; a full board with no pairs is over and is not saved', () => {
  // Left on the top row merges 2+2 into 4; the new tile (rng 0: a 2) lands in the one empty cell.
  const game = { board: [2, 2, 4, 2, 4, 2, 4, 8, 2, 4, 2, 4, 4, 2, 4, 2], score: 10, won: false, keepPlaying: false, over: false };
  const result = play(game, 3, () => 0);
  assert.deepEqual(game.board, [4, 4, 2, 2, 4, 2, 4, 8, 2, 4, 2, 4, 4, 2, 4, 2]);
  assert.equal(result.spawned, 3);
  const over = { board: [2, 4, 2, 4, 4, 2, 4, 2, 2, 4, 2, 4, 4, 2, 4, 2], score: 10, won: false, keepPlaying: false, over: true };
  assert.equal(canMove(over.board), false);
  assert.deepEqual(saveOf(50, over), { best: 50 });
});

test('the save round-trips, and a bad part is dropped on its own', () => {
  const game = { board: [2, 4, 0, 0, ...Z], score: 12, won: true, keepPlaying: true, over: false };
  const saved = JSON.parse(JSON.stringify(saveOf(100, game)));
  assert.deepEqual(saved, { best: 100, game: { board: [2, 4, 0, 0, ...Z], score: 12, won: true, keepPlaying: true } });
  assert.deepEqual(readSave(saved), { best: 100, game: { ...game } });

  assert.deepEqual(readSave({ best: 'x', game: saved.game }).best, 12);
  assert.equal(readSave({ best: 100, game: { ...saved.game, board: [3, ...Z, 0, 0, 0] } }).game, null);
  assert.equal(readSave({ best: 100, game: { ...saved.game, board: [2] } }).game, null);
  assert.equal(readSave({ best: 100, game: { ...saved.game, score: -1 } }).game, null);
  assert.equal(readSave({ best: 100, game: { ...saved.game, board: [2, 4, 2, 4, 4, 2, 4, 2, 2, 4, 2, 4, 4, 2, 4, 2] } }).game, null);
  assert.equal(readSave({ best: 100, game: { ...saved.game } }).best, 100);
  assert.deepEqual(readSave(null), { best: 0, game: null });
});
