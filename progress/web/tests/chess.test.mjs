// The chess puzzles' pure modules (web/public/games/chess): rules with perft, SAN/UCI,
// Glicko-2, the narrator, the store and picker, saves, UCI parsing.
// node --test progress/web/tests/chess.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Board, perft, uci } from '../public/games/chess/board.js';
import { describe as describeMove, ideaHint, lineSan, mateExplanation, replyNote, summary } from '../public/games/chess/narrator.js';
import { update, updateMany } from '../public/games/chess/glicko.js';
import { PuzzleStore, cssColour, parseGlossary, parsePieces, puzzleProblems, seededRng } from '../public/games/chess/store.js';
import { buildSave, newPuzzleState, readProgress, restorePuzzle } from '../public/games/chess/save.js';
import { emptyResult, formatScore, parseInfo, valueOf } from '../public/games/chess/engine.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const WIDGET = join(HERE, '..', '..', 'widget');
const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const KIWIPETE = 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1';

const perftAll = (fen, counts) => counts.map((_, i) => perft(Board.fromFen(fen), i + 1));

test('perft: the start position, depth 1-4', () => {
  assert.deepEqual(perftAll(START, [1, 2, 3, 4]), [20, 400, 8902, 197281]);
});

test('perft: Kiwipete, depth 1-3', () => {
  assert.deepEqual(perftAll(KIWIPETE, [1, 2, 3]), [48, 2039, 97862]);
});

test('perft: the self-test positions of ChessPuzzles.ps1', () => {
  assert.deepEqual(perftAll('8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1', [1, 2, 3, 4]), [14, 191, 2812, 43238]);
  assert.deepEqual(perftAll('r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1', [1, 2, 3]), [6, 264, 9467]);
  assert.deepEqual(perftAll('rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8', [1, 2, 3]), [44, 1486, 62379]);
});

test('FEN round trips', () => {
  for (const fen of ['rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1', KIWIPETE, '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1']) {
    assert.equal(Board.fromFen(fen).toFen(), fen);
  }
  assert.throws(() => Board.fromFen('8/8/8/8/8/8/8/8 w - - 0 1'), /king/);
});

test('SAN and UCI round trip on every Kiwipete move', () => {
  const kiwi = Board.fromFen(KIWIPETE);
  for (const m of kiwi.legalMoves()) {
    assert.equal(uci(kiwi.parseSan(kiwi.san(m))), uci(m));
    assert.equal(uci(kiwi.parseUci(uci(m))), uci(m));
  }
});

test('SAN details: disambiguation, en passant, promotion with check, castling', () => {
  const twoKnights = Board.fromFen('4k3/8/8/8/8/2N3N1/8/4K3 w - - 0 1');
  assert.equal(twoKnights.san(twoKnights.parseUci('c3e4')), 'Nce4');
  const passant = Board.fromFen('4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 2');
  assert.equal(passant.san(passant.parseUci('e5d6')), 'exd6');
  const promote = Board.fromFen('4k3/P7/8/8/8/8/8/4K3 w - - 0 1');
  assert.equal(promote.san(promote.parseUci('a7a8q')), 'a8=Q+');
  const castle = Board.fromFen('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
  assert.equal(uci(castle.parseUci('e1h1')), 'e1g1');
  assert.equal(castle.san(castle.parseUci('e1c1')), 'O-O-O');
  const mate = Board.fromFen('6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1');
  assert.equal(mate.san(mate.parseUci('a1a8')), 'Ra8#');
});

test("Glicko-2: Glickman's worked example (tau 0.5)", () => {
  const paper = updateMany({ rating: 1500, deviation: 200, volatility: 0.06 }, [1400, 1550, 1700], [30, 100, 300], [1, 0, 0], 0.5);
  assert.ok(Math.abs(paper.rating - 1464.06) < 0.05, String(paper.rating));
  assert.ok(Math.abs(paper.deviation - 151.52) < 0.05, String(paper.deviation));
  assert.ok(Math.abs(paper.volatility - 0.05999) < 0.0001, String(paper.volatility));
});

test('Glicko-2: a win beats a draw beats a loss, and the deviation stays clamped', () => {
  const fresh = { rating: 1500, deviation: 500, volatility: 0.09 };
  const win = update(fresh, 1500, 75, 1), half = update(fresh, 1500, 75, 0.5), loss = update(fresh, 1500, 75, 0);
  assert.ok(win.rating > half.rating && half.rating > loss.rating);
  assert.ok(win.deviation >= 45 && win.deviation <= 500 && win.volatility <= 0.1);
});

// --- The narrator, against what ChessCore.cs says for the same positions ---------------------
const note = (fen, move, followUp = null) => {
  const b = Board.fromFen(fen);
  return describeMove(b, b.parseUci(move), followUp);
};

test('narrator: back-rank mate explanation', () => {
  const mate = Board.fromFen('6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1');
  const why = mateExplanation(mate.play(mate.parseUci('a1a8')));
  assert.equal(why, 'The king on g8 has nowhere to go: f8 and h8 are covered by the rook on a8; f7, g7 and h7 are blocked by its own pawns; nothing can take the rook on a8 or block its check.');
  assert.equal(note('6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1', 'a1a8').text, 'Checkmate. ' + why);
});

test('narrator: a knight fork names the king and the rook', () => {
  const n = note('r3k3/8/8/1N6/8/8/8/4K3 w - - 0 1', 'b5c7');
  assert.equal(n.text, 'Forks the king on e8 and the rook on a8.');
  assert.deepEqual(n.kinds, ['fork']);
  assert.deepEqual(n.squares, [60, 56, 50]);
});

test('narrator: a pin to the king', () => {
  assert.equal(note('4k3/8/2n5/8/8/8/8/4KB2 w - - 0 1', 'f1b5').text, 'Pins the knight on c6 to the king. Attacks the knight on c6, which is undefended.');
});

test('narrator: the rule of the square', () => {
  const n = note('8/8/2k5/8/p7/8/8/6K1 b - - 0 1', 'a4a3');
  assert.deepEqual(n.kinds, ['outrunsKing']);
  assert.equal(n.text, "A passed pawn, and the king on g1 is outside its square: it can't catch the pawn before it reaches a1.");
});

test('narrator: captures, checks and sacrifices', () => {
  assert.equal(note('4k3/8/8/3q4/8/8/8/3RK3 w - - 0 1', 'd1d5').text, 'Takes the undefended queen on d5.');
  assert.equal(note('4k3/4p3/3q4/8/8/8/8/3RK3 w - - 0 1', 'd1d6').text, 'Takes the queen on d6.');
  assert.equal(note('4k3/4p3/3n4/8/8/8/8/3QK3 w - - 0 1', 'd1d6').text, 'Takes the knight on d6. The queen on d6 can now be taken by the pawn on e7.');
  assert.equal(note('4k3/8/8/8/8/8/8/R3K3 w - - 0 1', 'a1a8').text, 'Check.');
});

test('narrator: the idea hint stays quiet when nothing confirms it', () => {
  const quiet = Board.fromFen('6k1/5ppp/8/8/8/8/5PPP/3R2K1 b - - 0 1');
  assert.equal(ideaHint(quiet, quiet.parseUci('h7h6'), null, ['clearance'], 2), null);
  const mate = Board.fromFen('6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1');
  assert.equal(ideaHint(mate, mate.parseUci('a1a8'), null, ['mateIn2'], 2), "There's a forced mate in 2.");
  assert.equal(ideaHint(mate, mate.parseUci('a1a8'), null, [], 1), "There's a mate in one.");
});

test('narrator: reply notes, the line in SAN, and the summary', () => {
  const b = Board.fromFen('4k3/8/8/8/8/8/8/R3K3 w - - 0 1').play(Board.fromFen('4k3/8/8/8/8/8/8/R3K3 w - - 0 1').parseUci('a1a8'));
  const reply = b.parseUci('e8e7');
  assert.ok(replyNote(b, reply, null, null).text.startsWith('The king steps out of check.'));
  const start = Board.fromFen(START);
  assert.equal(lineSan(start, ['e2e4', 'e7e5', 'g1f3'], 6), '1.e4 e5 2.Nf3');
  const black = Board.fromFen('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1');
  assert.equal(lineSan(black, ['e7e5', 'g1f3'], 6), '1...e5 2.Nf3');
  const before = Board.fromFen('4k3/8/8/3q4/8/8/8/3RK3 w - - 0 1');
  assert.equal(summary(before, before.play(before.parseUci('d1d5')), true, [], 1), 'Wins a queen (+9).');
});

// --- Store, picker, data files ----------------------------------------------------------------
const puzzlesText = readFileSync(join(WIDGET, 'ChessPuzzles.txt'), 'utf8');
const store = PuzzleStore.fromText(puzzlesText);

test('the bundled puzzles load, replay legally and keep their mate tags', () => {
  assert.ok(store.count > 20000, String(store.count));
  assert.deepEqual(puzzleProblems(store).slice(0, 5), []);
});

test('narrator on bundled puzzles (the self-test ids)', () => {
  const at = (id, ply) => {
    const p = store.get(id);
    let position = Board.fromFen(p.fen);
    for (let k = 0; k < ply; k++) position = position.play(position.parseUci(p.moves[k]));
    return describeMove(position, position.parseUci(p.moves[ply]), null);
  };
  const mate = at('0YtJI', 1);
  assert.ok(mate.kinds.includes('mate') && mate.text.includes('g8'), mate.text);
  assert.ok(at('Qroza', 1).kinds.length > 0);
});

test('the picker widens toward rare ratings and falls back to the mix', () => {
  const lines = [
    'a1|4k3/8/8/8/8/8/8/4K3 w - - 0 1|e1e2 e8e7|2150|70|90|500|zugzwang|x',
    'a2|4k3/8/8/8/8/8/8/4K3 w - - 0 1|e1e2 e8e7|1000|70|90|500|fork|x',
    'a3|4k3/8/8/8/8/8/8/4K3 w - - 0 1|e1e2 e8e7|1050|70|90|500|fork|x',
  ];
  const tiny = PuzzleStore.fromLines(lines);
  const rng = seededRng(1);
  const far = tiny.pick('zugzwang', 1000, new Set(), rng);
  assert.equal(far.puzzle.id, 'a1');
  assert.ok(far.window >= 1100);
  const mixed = tiny.pick('zugzwang', 1000, new Set(['a1']), rng);
  assert.ok(mixed.fellBackToMix && mixed.puzzle.id !== 'a1');
  const all = tiny.pick('mix', 1000, new Set(['a1', 'a2', 'a3']), rng);
  assert.ok(all.puzzle);
  const near = store.pick('fork', 1400, new Set(), seededRng(7));
  assert.ok(Math.abs(near.puzzle.rating - 1400) <= 100 && near.puzzle.themes.includes('fork'));
});

test('the glossary and the piece art parse', () => {
  const glossary = parseGlossary(readFileSync(join(WIDGET, 'ChessThemes.txt'), 'utf8'));
  assert.equal(glossary.get('fork').title, 'Fork');
  const pieces = parsePieces(readFileSync(join(WIDGET, 'ChessPieces.txt'), 'utf8'));
  assert.equal(pieces.size, 12);
  assert.ok(pieces.get(6).includes('<path d="M 22.5,11.63'));
  assert.equal(cssColour('#FF000000'), '#000000');
  assert.equal(cssColour('#80FF0000'), 'rgba(255,0,0,0.502)');
});

// --- Saves -------------------------------------------------------------------------------------
test('saves: each part is checked on its own, and a bad part drops alone', () => {
  const { progress } = readProgress({
    version: 1, settings: { theme: 'nonsense', difficulty: 'harder', board: 'blue', mode: 'climb' },
    rating: { r: 1720.5, rd: 80, vol: 0.06, games: 12, history: [1500, 99999, 1720.5] },
    climb: { level: 'x' }, solved: 'a b  c', counter: 7, retry: [{ id: 'q', due: 27, mode: 'climb' }, { due: 3 }],
  }, key => key === 'fork');
  assert.deepEqual(progress.settings, { theme: 'mix', difficulty: 'harder', board: 'blue', mode: 'climb' });
  assert.equal(progress.rating.r, 1720.5);
  assert.deepEqual(progress.rating.history, [1500, 1720.5]);
  assert.equal(progress.climb.level, 600);
  assert.deepEqual([...progress.solved], ['a', 'b', 'c']);
  assert.deepEqual(progress.retry, [{ id: 'q', due: 27, mode: 'climb' }]);
  const save = buildSave(progress, null);
  assert.deepEqual(Object.keys(save), ['version', 'settings', 'rating', 'climb', 'solved', 'counter', 'retry']);
  assert.equal(save.solved, 'a b c');
});

test('saves: a puzzle comes back move by move, and a broken line is refused', () => {
  const puzzle = store.get('0YtJI');
  const state = newPuzzleState(puzzle, true, 'normal');
  state.line = puzzle.moves.slice(0, 1);
  state.step = 1;
  const saved = JSON.parse(JSON.stringify(buildSave(readProgress(null).progress, state))).puzzle;
  const back = restorePuzzle(saved, store);
  assert.equal(back.state.step, 1);
  assert.equal(back.state.phase, 'play');
  assert.equal(restorePuzzle({ ...saved, line: ['a1a1'] }, store), null);
  assert.equal(restorePuzzle({ ...saved, phase: 'review' }, store), null);
});

test('UCI info lines and scores', () => {
  const parsed = emptyResult(1);
  parseInfo('info depth 18 seldepth 24 multipv 1 score cp -35 nodes 1000 pv e2e4 e7e5 g1f3', parsed);
  assert.equal(parsed.scoreCp, -35);
  assert.equal(parsed.depth, 18);
  assert.deepEqual(parsed.pv, ['e2e4', 'e7e5', 'g1f3']);
  const mateLine = emptyResult(2);
  parseInfo('info depth 9 score mate -2 pv h7h8 g7g8', mateLine);
  assert.ok(mateLine.isMate && mateLine.mateIn === -2 && valueOf(mateLine) === -99998);
  assert.equal(formatScore(99998), 'mate in 2');
  assert.equal(formatScore(-99997), 'mated in 3');
  assert.equal(formatScore(140), '+1.4');
  assert.equal(formatScore(-42), '-0.4');
});
