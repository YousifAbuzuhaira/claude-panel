// Sudoku: every puzzle unique, consistent and solvable by singles; the rules played
// through as the WPF play-test plays them; the save.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLUES, MAX_LIVES, SHAPES, STATUS, UNDO_KEPT, Sudoku, countSolutions, generate, isValidSolution,
  givensMatch, newPuzzle, readSave, saveOf, solvesBySingles,
} from '../public/games/sudoku/logic.js';
import { seeded } from '../public/games/rng.js';

for (const side of [4, 6, 9]) {
  test(`${side}x${side} puzzles: one solution, valid, no guessing, near the target givens`, () => {
    const [r, c] = SHAPES[side];
    for (let i = 0; i < 25; i++) {
      const p = newPuzzle(side, seeded(1000 * side + i));
      assert.equal(countSolutions(p.givens, side, r, c, 2), 1);
      assert.ok(isValidSolution(p.solution, side, r, c));
      assert.ok(givensMatch(p.givens, p.solution));
      assert.ok(solvesBySingles(p.givens, side, r, c));
      assert.equal(p.givens.filter(v => v).length, p.clues);
      assert.ok(p.clues >= CLUES[side] && p.clues <= CLUES[side] + 8, `clues ${p.clues}`);
    }
  });
}

test('out of time only leaves more givens', () => {
  let t = 0;
  const p = generate(9, 3, 3, 30, seeded(9), 1500, () => (t += 1000));
  assert.ok(p.clues > 70);
  assert.ok(solvesBySingles(p.givens, 9, 3, 3));
});

test('a puzzle that needs a guess does not solve by singles', () => {
  // Two swappable 2x2 rectangles: two solutions, so singles cannot finish it.
  const grid = [1, 2, 3, 4, 3, 4, 1, 2, 0, 0, 0, 0, 0, 0, 0, 0];
  assert.equal(countSolutions(grid, 4, 2, 2, 5) > 1, true);
  assert.equal(solvesBySingles(grid, 4, 2, 2), false);
  assert.equal(isValidSolution([1, 1, 3, 4, 3, 4, 1, 2, 2, 3, 4, 1, 4, 1, 2, 3], 4, 2, 2), false);
});

function freshGame(side = 9, seed = 42) {
  const game = new Sudoku({ rng: seeded(seed) });
  game.newGame(side);
  return game;
}

test('the rules, played through (the WPF play-test)', () => {
  const game = freshGame(9);
  const side = game.n;
  const empty = [];
  for (let i = 0; i < side * side; i++) if (!game.given[i]) empty.push(i);
  const target = empty[0];
  const digit = game.solution[target];
  const peerSet = game.peers(target);
  const peers = [...peerSet].filter(i => i !== target && !game.given[i] && game.values[i] === 0);
  const far = empty.find(i => !peerSet.has(i));
  const bit = 1 << digit;

  // Notes: the digit pencilled into the target, its open peers and a far cell.
  game.mode = 'notes';
  for (const cell of [target, ...peers, far]) { game.selectOnly(cell); game.enterDigit(digit); }
  game.selectOnly(target);
  game.enterDigit((digit % side) + 1);
  assert.ok(game.notes[target] & bit);

  // A wrong answer: red, stays, one life, notes left alone; the same digit again is free.
  game.mode = 'answer';
  const wrongDigit = (game.solution[far] % side) + 1;
  game.selectOnly(far);
  game.enterDigit(wrongDigit);
  game.enterDigit(wrongDigit);
  assert.ok(game.wrong[far] && game.values[far] === wrongDigit);
  assert.equal(game.lives, MAX_LIVES - 1);
  assert.ok(peers.every(i => game.notes[i] & bit));
  game.clearCell();
  assert.ok(game.values[far] === 0 && !game.wrong[far] && game.notes[far] & bit, 'erasing red brings the notes back');

  // A right answer: kept, its own notes gone, the digit gone from every peer's notes.
  game.selectOnly(target);
  game.enterDigit(digit);
  assert.ok(game.values[target] === digit && !game.wrong[target]);
  assert.equal(game.notes[target], 0);
  assert.ok(peers.every(i => (game.notes[i] & bit) === 0));
  assert.ok(game.notes[far] & bit);
  assert.equal(game.enterDigit((digit % side) + 1), false, 'a right answer is final');

  // Several squares: a flipped note goes into all and comes out of all; an answer needs one square.
  const two = empty.filter(i => game.values[i] === 0 && !game.wrong[i]).slice(0, 2);
  let free = 1;
  while (free <= side && ((game.notes[two[0]] | game.notes[two[1]]) & (1 << free))) free++;
  game.selectOnly(two[0]);
  game.selectAdd(two[1]);
  game.enterDigit(free, true);
  assert.ok(game.notes[two[0]] & game.notes[two[1]] & (1 << free));
  game.enterDigit(free, true);
  assert.equal((game.notes[two[0]] | game.notes[two[1]]) & (1 << free), 0);
  const livesBefore = game.lives;
  game.enterDigit(game.solution[two[0]]);
  assert.equal(game.values[two[0]], 0);
  assert.equal(game.lives, livesBefore);
  assert.equal(game.status, STATUS.oneAtATime);

  // In Notes mode the flipped digit answers.
  game.mode = 'notes';
  game.selectOnly(two[1]);
  game.enterDigit(game.solution[two[1]], true);
  assert.ok(game.values[two[1]] === game.solution[two[1]] && !game.wrong[two[1]]);
  game.mode = 'answer';

  // Undo takes back a wrong answer, but not the life it cost.
  game.selectOnly(two[0]);
  game.enterDigit((game.solution[two[0]] % side) + 1);
  const livesAfterWrong = game.lives;
  assert.ok(game.undo());
  assert.ok(game.values[two[0]] === 0 && !game.wrong[two[0]]);
  assert.equal(game.lives, livesAfterWrong);

  // The kept game comes back exactly through JSON; a game that does not fit is refused.
  const kept = JSON.parse(JSON.stringify(saveOf(game)));
  kept.game.mode = 'notes';
  const other = new Sudoku();
  assert.ok(other.restore(kept.game));
  assert.deepEqual([other.values, other.wrong, other.notes, other.lives, other.mode], [game.values, game.wrong, game.notes, game.lives, 'notes']);
  assert.equal(new Sudoku().restore({ ...kept.game, size: 4 }), false);

  // Out of lives: a fresh puzzle, three lives, and it says so.
  const before = game.solution.join('');
  const open = [];
  for (let i = 0; i < side * side; i++) if (game.values[i] === 0) open.push(i);
  for (const cell of open.slice(0, game.lives)) { game.selectOnly(cell); game.enterDigit((game.solution[cell] % side) + 1); }
  assert.notEqual(game.solution.join(''), before);
  assert.equal(game.lives, MAX_LIVES);
  assert.equal(game.status, STATUS.outOfLives);

  // Solving every cell wins, and a solved game is not kept.
  for (let i = 0; i < side * side; i++) if (!game.given[i]) { game.selectOnly(i); game.enterDigit(game.solution[i]); }
  assert.ok(game.isSolved);
  assert.equal(game.status, STATUS.solved);
  assert.deepEqual(saveOf(game), { size: 9 });
  assert.equal(game.undo(), false);
});

test('undo keeps 200 steps', () => {
  const game = freshGame(4, 7);
  const open = game.values.findIndex(v => v === 0);
  game.selectOnly(open);
  game.mode = 'notes';
  for (let k = 0; k < 250; k++) game.enterDigit(1);
  assert.equal(game.history.length, UNDO_KEPT);
  let steps = 0;
  while (game.undo()) steps++;
  assert.equal(steps, UNDO_KEPT);
});

test('selection: toggle keeps one, arrows clamp and extend', () => {
  const game = freshGame(4, 3);
  game.selectOnly(5);
  game.selectToggle(5);
  assert.deepEqual(game.picked, [5]);
  game.selectToggle(6);
  game.selectToggle(5);
  assert.deepEqual(game.picked, [6]);
  game.moveSelection(-5, 0, false);
  assert.equal(game.selected, 2);
  game.moveSelection(0, 1, true);
  assert.deepEqual(game.picked, [2, 3]);
  game.selectOnly(-1);
  game.moveSelection(1, 1, false);
  assert.equal(game.selected, 0);
});

test('peers: row, column and box, itself included', () => {
  const game = freshGame(6, 1);
  const peers = game.peers(0);
  assert.ok([0, 1, 2, 3, 4, 5, 6, 12, 18, 24, 30, 7, 8].every(i => peers.has(i)));
  assert.equal(peers.size, 13); // row 6, column 5 more, box (2x3) 2 more
});

test('the save: each part checked on its own', () => {
  assert.deepEqual(readSave(null), { size: 9, game: null });
  assert.deepEqual(readSave({ size: 5, game: 3 }), { size: 9, game: null });
  assert.equal(readSave({ size: 6 }).size, 6);
  const game = freshGame(4, 11);
  const saved = saveOf(game).game;
  const fresh = () => new Sudoku();
  assert.ok(fresh().restore(saved));
  assert.equal(fresh().restore({ ...saved, solution: saved.solution.map(() => 1) }), false);
  const badGiven = [...saved.values];
  const g = saved.given.indexOf(true);
  badGiven[g] = (badGiven[g] % 4) + 1;
  assert.equal(fresh().restore({ ...saved, values: badGiven }), false);
  assert.equal(fresh().restore({ ...saved, notes: [1] }), false);
  const restored = fresh();
  restored.restore({ ...saved, lives: 99, mode: 'x' });
  assert.equal(restored.lives, MAX_LIVES);
  assert.equal(restored.mode, 'answer');
});
