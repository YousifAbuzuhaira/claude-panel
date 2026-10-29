// Turns moves into plain sentences, ported from widget/ChessCore.cs (class Narrator).
// Every sentence comes from the board itself: a fact is only stated when the attack
// maps prove it. No DOM.
import {
  BISHOP, Board, DIAGONALS, KING, KNIGHT, LINES, PAWN, QUEEN, ROOK,
  fileOf, isCapture, isCastle, isEnPassant, makeMove, onBoard, pieceValue, rankOf, squareName, uci,
} from './board.js';

const NAMES = ['', 'pawn', 'knight', 'bishop', 'rook', 'queen', 'king'];
const PLURALS = ['', 'pawns', 'knights', 'bishops', 'rooks', 'queens', 'kings'];
const COUNTS = ['no', 'a', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'];

const fact = (kind, text, ...squares) => ({ kind, text, squares });

export const pieceName = piece => NAMES[Math.abs(piece)];
export const pieceOn = (b, sq) => 'the ' + pieceName(b.squares[sq]) + ' on ' + squareName(sq);
const sq = squareName;

function joinList(items) {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0];
  return items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1];
}

const isEnemy = (b, s, white) => b.squares[s] !== 0 && (b.squares[s] > 0) !== white;

/** A stable sort by a numeric key, as LINQ's OrderBy is. */
const orderBy = (list, key) => list.map((v, i) => [key(v), i, v]).sort((a, b) => a[0] - b[0] || a[1] - b[1]).map(x => x[2]);
const orderByDescending = (list, key) => list.map((v, i) => [key(v), i, v]).sort((a, b) => b[0] - a[0] || a[1] - b[1]).map(x => x[2]);
const removeAll = (list, test) => { for (let i = list.length - 1; i >= 0; i--) if (test(list[i])) list.splice(i, 1); };

// --- What a move does ----------------------------------------------------------------
function moveFacts(before, m, followUp) {
  const facts = [];
  const me = before.whiteToMove;
  const sign = me ? 1 : -1;
  const after = before.play(m);
  const type = Math.abs(after.squares[m.to]);
  const enemyKing = after.kingSquare(!me);
  const givesCheck = after.inCheck();
  const mate = givesCheck && after.legalMoves().length === 0;

  if (isCapture(m)) {
    const taken = isEnPassant(m) ? m.to - 8 * sign : m.to;
    const defended = before.isAttacked(taken, !me);
    const victim = NAMES[m.captured] + ' on ' + sq(taken);
    let guarded = -1;
    if (followUp && before.attacksFrom(taken).includes(followUp.to) && isGuardedBy(before, followUp.to, !me, taken)) guarded = followUp.to;
    if (guarded >= 0) {
      const rest = after.isAttacked(guarded, !me) ? '' : ', so ' + sq(guarded) + ' is left unguarded';
      facts.push(fact('removesDefender', 'Takes the ' + victim + ' that was guarding ' + sq(guarded) + rest + '.', taken, guarded));
    } else if (!defended) facts.push(fact('hanging', 'Takes the undefended ' + victim + '.', taken));
    else facts.push(fact('capture', 'Takes the ' + victim + '.', taken));
  }

  if (m.promo !== 0) {
    if (m.promo === QUEEN) facts.push(fact('promotion', 'Promotes to a queen.', m.to));
    else {
      const asQueen = before.play(makeMove(m.from, m.to, m.piece, m.captured, QUEEN, m.flags));
      const why = asQueen.isStalemate() ? ', because a queen would be stalemate' : (m.promo === KNIGHT && givesCheck ? ', which gives check' : '');
      facts.push(fact('underPromotion', 'Promotes to a ' + NAMES[m.promo] + why + '.', m.to));
    }
  }

  if (mate) {
    facts.push(fact('mate', 'Checkmate. ' + mateExplanation(after), ...mateSquares(after)));
    return facts;
  }

  if (type === PAWN && m.promo === 0) addPassedPawn(facts, after, m.to, me);

  if (givesCheck) {
    const checkers = after.attackers(enemyKing, me);
    const rookSquare = isCastle(m) ? (m.to > m.from ? m.from + 1 : m.from - 1) : -1;
    if (checkers.length >= 2) {
      facts.push(fact('doubleCheck', 'Double check from ' + pieceOn(after, checkers[0]) + ' and ' + pieceOn(after, checkers[1]) + ': only a king move can answer it.', checkers[0], checkers[1], enemyKing));
    } else if (checkers.length === 1 && checkers[0] !== m.to && checkers[0] !== rookSquare) {
      facts.push(fact('discoveredCheck', 'Discovered check from ' + pieceOn(after, checkers[0]) + '.', checkers[0], enemyKing));
    } else facts.push(fact('check', 'Check.', enemyKing));
  }

  // New targets of the moved piece.
  const hitsBefore = new Set(before.attacksFrom(m.from));
  const promoted = m.promo !== 0;
  let targets = [];
  for (const t of after.attacksFrom(m.to)) {
    if (!isEnemy(after, t, me) || (hitsBefore.has(t) && !promoted && !isCastle(m))) continue;
    const target = Math.abs(after.squares[t]);
    const undefended = !after.isAttacked(t, !me);
    if (type === KING && !undefended) continue;
    if (target === KING || (type !== KING && pieceValue(target) > pieceValue(type)) || (undefended && (pieceValue(target) >= 3 || type === KING))) targets.push(t);
  }
  targets = orderByDescending(targets, t => Math.abs(after.squares[t]) === KING ? 100 : pieceValue(after.squares[t]));
  if (targets.length >= 2) {
    facts.push(fact('fork', 'Forks ' + joinList(targets.map(t => pieceOn(after, t))) + '.', ...targets, m.to));
    removeAll(facts, f => f.kind === 'check');
  } else if (targets.length === 1 && Math.abs(after.squares[targets[0]]) !== KING) {
    facts.push(fact('attack', 'Attacks ' + pieceOn(after, targets[0]) + (after.isAttacked(targets[0], !me) ? '' : ', which is undefended') + '.', targets[0], m.to));
  }

  // Pins and skewers by the moved piece, if it slides.
  if (type === BISHOP || type === ROOK || type === QUEEN) {
    const old = new Set(linePairs(before, m.from, type).map(p => p.kind + p.squares[0] + '-' + p.squares[1]));
    for (const pair of linePairs(after, m.to, type)) {
      if (old.has(pair.kind + pair.squares[0] + '-' + pair.squares[1])) continue;
      facts.push(fact(pair.kind, pair.text, pair.squares[0], pair.squares[1], m.to));
      if (pair.kind === 'skewer') removeAll(facts, f => f.kind === 'check');
    }
  }

  // Lines opened by the piece that moved away.
  for (let s = 0; s < 64; s++) {
    const p = before.squares[s];
    if (s === m.from || p === 0 || (p > 0) !== me) continue;
    const slider = Math.abs(p);
    if (slider !== BISHOP && slider !== ROOK && slider !== QUEEN) continue;
    const d = direction(s, m.from, slider);
    if (d === null || !clearBetween(before, s, m.from, d)) continue;
    const hit = firstPiece(after, s, d);
    if (hit < 0 || !isEnemy(after, hit, me) || Math.abs(after.squares[hit]) === KING) continue;
    const value = pieceValue(after.squares[hit]);
    if (value > pieceValue(slider) || (!after.isAttacked(hit, !me) && value >= 3)) {
      facts.push(fact('discoveredAttack', 'Uncovers an attack: ' + pieceOn(after, s) + ' now hits ' + pieceOn(after, hit) + '.', s, hit));
    }
  }

  // A piece left where it can be taken for less than it is worth.
  const worth = pieceValue(type);
  if (worth >= 3) {
    const takers = after.legalMoves().filter(x => x.to === m.to);
    if (takers.length > 0) {
      const covered = after.isAttacked(m.to, me);
      const taker = orderBy(takers, x => x.piece === KING ? 100 : pieceValue(x.piece))[0];
      const cheapest = taker.piece === KING ? 100 : pieceValue(taker.piece);
      const risked = !covered ? worth : Math.max(0, worth - cheapest);
      // Said plainly, without calling it good or bad: the move might be a blunder.
      if (risked > pieceValue(m.captured)) {
        facts.push(fact('sacrifice', 'The ' + NAMES[type] + ' on ' + sq(m.to) + ' can now be taken by ' + pieceOn(after, taker.from) + '.', m.to, taker.from));
      }
    }
  }

  // A quiet move: what would it threaten if the opponent did nothing?
  if (!isCapture(m) && !givesCheck && m.promo === 0) {
    const again = after.nullMove();
    for (const x of again.legalMoves()) {
      if (again.play(x).isCheckmate()) {
        facts.push(fact('threatMate', 'Threatens ' + again.san(x) + '.', x.from, x.to));
        break;
      }
    }
  }
  return facts;
}

// A pawn no enemy pawn can stop; and, with only kings and pawns left, whether the
// enemy king is outside the pawn's square (it can't catch it in time).
function addPassedPawn(facts, after, s, white) {
  const file = fileOf(s), rank = rankOf(s), step = white ? 1 : -1, last = white ? 7 : 0;
  const stepsLeft = Math.abs(last - rank);
  if (stepsLeft > 4 || stepsLeft === 0) return;
  const enemyPawn = white ? -PAWN : PAWN;
  for (let r = rank + step; r !== last + step; r += step) {
    for (let f = Math.max(0, file - 1); f <= Math.min(7, file + 1); f++) if (after.squares[r * 8 + f] === enemyPawn) return;
  }
  const promo = last * 8 + file;
  let pathClear = true;
  for (let r = rank + step; r !== last + step; r += step) if (after.squares[r * 8 + file] !== 0) pathClear = false;
  let onlyPawns = true;
  for (let t = 0; t < 64; t++) {
    const p = after.squares[t];
    if (p !== 0 && (p > 0) !== white && Math.abs(p) !== PAWN && Math.abs(p) !== KING) onlyPawns = false;
  }
  const king = after.kingSquare(!white);
  const distance = king < 0 ? 99 : Math.max(Math.abs(fileOf(king) - file), Math.abs(rankOf(king) - last));
  const side = white ? 'black' : 'white';
  // The king moves first, so it catches the pawn if it is within one step of the pawn's square.
  if (onlyPawns && pathClear && distance > stepsLeft + 1) {
    facts.push(fact('outrunsKing', 'A passed pawn, and the king on ' + sq(king) + " is outside its square: it can't catch the pawn before it reaches " + sq(promo) + '.', s, promo, king));
  } else {
    facts.push(fact('passedPawn', 'A passed pawn: no ' + side + ' pawn can block or take it on the way to ' + sq(promo) + '.', s, promo));
  }
}

/** Is the piece on `guard` one of the pieces defending `s` for that side? */
const isGuardedBy = (b, s, white, guard) => b.attackers(s, white).includes(guard);

function direction(from, to, slider) {
  const df = fileOf(to) - fileOf(from), dr = rankOf(to) - rankOf(from);
  if (df === 0 && dr === 0) return null;
  const straight = df === 0 || dr === 0, diagonal = Math.abs(df) === Math.abs(dr);
  if (straight && slider === BISHOP) return null;
  if (diagonal && slider === ROOK) return null;
  if (!straight && !diagonal) return null;
  return [Math.sign(df), Math.sign(dr)];
}

function clearBetween(b, from, to, d) {
  let f = fileOf(from) + d[0], r = rankOf(from) + d[1];
  while (r * 8 + f !== to) {
    if (b.squares[r * 8 + f] !== 0) return false;
    f += d[0]; r += d[1];
  }
  return true;
}

function firstPiece(b, from, d) {
  let f = fileOf(from) + d[0], r = rankOf(from) + d[1];
  while (onBoard(f, r)) {
    if (b.squares[r * 8 + f] !== 0) return r * 8 + f;
    f += d[0]; r += d[1];
  }
  return -1;
}

// Pins and skewers along the lines of a slider standing on s.
function linePairs(b, s, type) {
  const found = [];
  const white = b.squares[s] > 0;
  const directions = [];
  if (type !== ROOK) directions.push(...DIAGONALS);
  if (type !== BISHOP) directions.push(...LINES);
  const own = pieceValue(type);
  for (const d of directions) {
    const first = firstPiece(b, s, d);
    if (first < 0 || !isEnemy(b, first, white)) continue;
    const second = firstPiece(b, first, d);
    if (second < 0 || !isEnemy(b, second, white)) continue;
    const front = Math.abs(b.squares[first]), back = Math.abs(b.squares[second]);
    const backLoose = !b.isAttacked(second, !white);
    if (front === KING) {
      if (pieceValue(back) >= 3 && (backLoose || pieceValue(back) >= own)) {
        found.push(fact('skewer', 'Skewers ' + pieceOn(b, first) + ': when it steps aside, ' + pieceOn(b, second) + ' behind it can be taken.', first, second));
      }
    } else if (back === KING) {
      found.push(fact('pin', 'Pins ' + pieceOn(b, first) + ' to the king.', first, second));
    } else if (pieceValue(back) > pieceValue(front) && (backLoose || pieceValue(back) > own)) {
      found.push(fact('pin', 'Pins ' + pieceOn(b, first) + ' to ' + pieceOn(b, second) + '.', first, second));
    } else if (pieceValue(front) > pieceValue(back) && pieceValue(front) > own && pieceValue(back) >= 3 && (backLoose || pieceValue(back) >= own)) {
      found.push(fact('skewer', 'Skewers ' + pieceOn(b, first) + ': when it moves away, ' + pieceOn(b, second) + ' behind it can be taken.', first, second));
    }
  }
  return found;
}

// --- Checkmate -------------------------------------------------------------------------
export function mateExplanation(mated) {
  const loser = mated.whiteToMove;
  const king = mated.kingSquare(loser);
  if (king < 0) return '';
  const open = mated.clone();
  open.squares[king] = 0; // squares behind the king along the checking line count as covered
  const covered = new Map();
  const blocked = [];
  const guardedPieces = [];
  const file = fileOf(king), rank = rankOf(king);
  for (let df = -1; df <= 1; df++) {
    for (let dr = -1; dr <= 1; dr++) {
      if ((df === 0 && dr === 0) || !onBoard(file + df, rank + dr)) continue;
      const s = (rank + dr) * 8 + file + df;
      const p = mated.squares[s];
      if (p !== 0 && (p > 0) === loser) { blocked.push(s); continue; }
      const guards = open.attackers(s, !loser);
      if (guards.length === 0) continue;
      const guard = orderBy(guards, g => Math.abs(open.squares[g]) === KING ? 100 : pieceValue(open.squares[g]))[0];
      if (p !== 0) { guardedPieces.push(pieceOn(mated, s) + ' is protected by ' + pieceOn(mated, guard)); continue; }
      if (!covered.has(guard)) covered.set(guard, []);
      covered.get(guard).push(s);
    }
  }
  const clauses = [];
  for (const [guard, list] of covered) clauses.push(joinList(list.map(sq)) + (list.length === 1 ? ' is' : ' are') + ' covered by ' + pieceOn(mated, guard));
  clauses.push(...guardedPieces);
  if (blocked.length > 0) {
    const kinds = [...new Set(blocked.map(s => Math.abs(mated.squares[s])))];
    const what = kinds.length === 1 ? (blocked.length === 1 ? NAMES[kinds[0]] : PLURALS[kinds[0]]) : (blocked.length === 1 ? 'piece' : 'pieces');
    clauses.push(joinList(blocked.map(sq)) + (blocked.length === 1 ? ' is' : ' are') + ' blocked by its own ' + what);
  }
  const checkers = mated.attackers(king, !loser);
  if (checkers.length === 1) {
    // It is mate, so the checker can't be taken (an adjacent one is covered above).
    const checker = checkers[0];
    const adjacent = Math.abs(fileOf(checker) - file) <= 1 && Math.abs(rankOf(checker) - rank) <= 1;
    const kind = Math.abs(mated.squares[checker]);
    const blockable = !adjacent && kind !== KNIGHT && kind !== PAWN;
    if (!adjacent) clauses.push('nothing can take ' + pieceOn(mated, checker) + (blockable ? ' or block its check' : ''));
  }
  const lead = checkers.length >= 2 ? 'Double check, and the king on ' + sq(king) + ' has nowhere to go' : 'The king on ' + sq(king) + ' has nowhere to go';
  if (clauses.length === 0) return lead + '.';
  return lead + ': ' + clauses.join('; ') + '.';
}

function mateSquares(mated) {
  const king = mated.kingSquare(mated.whiteToMove);
  return [king, ...mated.attackers(king, !mated.whiteToMove)];
}

// --- Notes for the feed ------------------------------------------------------------------
const ORDER = ['escape', 'onlyMove', 'deflection', 'attraction', 'removesDefender', 'hanging', 'capture', 'promotion', 'underPromotion', 'mate', 'doubleCheck', 'discoveredCheck', 'fork', 'pin', 'skewer', 'discoveredAttack', 'attack', 'check', 'sacrifice', 'threatMate', 'outrunsKing', 'passedPawn'];

/** A note: {text, kinds[], squares[] (distinct)}. */
function compose(facts, limit) {
  const ordered = orderBy(facts, f => ORDER.indexOf(f.kind) < 0 ? 99 : ORDER.indexOf(f.kind));
  const sentences = [], kinds = [], squares = [];
  for (const f of ordered) {
    if (sentences.length >= limit && f.kind !== 'mate') continue;
    sentences.push(f.text);
    kinds.push(f.kind);
    squares.push(...f.squares);
  }
  return { text: sentences.join(' '), kinds, squares: [...new Set(squares)] };
}

/** What a move does, for either side. followUp is the same side's next move, if known. */
export function describe(before, move, followUp = null) {
  return compose(moveFacts(before, move, followUp), 3);
}

/** The opponent's answer inside a puzzle line. */
export function replyNote(before, reply, previous, next) {
  const facts = [];
  const me = before.whiteToMove;
  const after = before.play(reply);
  const legal = before.legalMoves();

  if (before.inCheck()) {
    const king = before.kingSquare(me);
    const checkers = before.attackers(king, !me);
    if (reply.piece === KING && !isCapture(reply)) facts.push(fact('escape', 'The king steps out of check.', reply.to));
    else if (checkers.includes(reply.to)) facts.push(fact('escape', 'Takes the checking ' + NAMES[reply.captured] + '.', reply.to));
    else if (reply.piece !== KING) facts.push(fact('escape', 'Blocks the check.', reply.to));
  }
  if (legal.length === 1) facts.push(fact('onlyMove', 'The only legal move.', reply.to));
  else if (legal.length <= 40 && !allowsMateInOne(after) && legal.every(x => uci(x) === uci(reply) || allowsMateInOne(before.play(x)))) {
    facts.push(fact('onlyMove', 'The only move that stops mate in one.', reply.to));
  }

  const moveFactList = moveFacts(before, reply, null).filter(f => f.kind !== 'sacrifice' && f.kind !== 'threatMate');
  if (facts.some(f => f.kind === 'escape') && isCapture(reply)) removeAll(moveFactList, f => f.kind === 'capture' || f.kind === 'hanging');
  facts.push(...moveFactList);

  if (next) {
    const target = next.to;
    const guardedBefore = reply.to !== target && before.attacksFrom(reply.from).includes(target) && isGuardedBy(before, target, me, reply.from);
    const guardedAfter = after.attacksFrom(reply.to).includes(target);
    if (guardedBefore && !guardedAfter) {
      const rest = after.isAttacked(target, me) ? 'it no longer guards ' + sq(target) : sq(target) + ' is no longer guarded';
      facts.push(fact('deflection', 'That pulls the ' + NAMES[reply.piece] + ' away from ' + sq(target) + ': ' + rest + '.', reply.to, target));
    }
    if (previous && isCapture(reply) && reply.to === previous.to && (reply.piece === KING || pieceValue(reply.piece) >= 3)) {
      const afterNext = after.play(next);
      if (next.to === reply.to) {
        facts.push(fact('attraction', 'That brings the ' + NAMES[reply.piece] + ' to ' + sq(reply.to) + ', where the next move takes it.', reply.to));
      } else if (afterNext.attacksFrom(next.to).includes(reply.to) || (reply.piece === KING && afterNext.inCheck())) {
        facts.push(fact('attraction', 'That brings the ' + NAMES[reply.piece] + ' to ' + sq(reply.to) + ', right where the next move hits it.', reply.to));
      }
    }
  }
  return compose(facts, 3);
}

function allowsMateInOne(position) {
  for (const x of position.legalMoves()) {
    const next = position.play(x);
    if (next.inCheck() && next.legalMoves().length === 0) return true;
  }
  return false;
}

/** A line of UCI moves as numbered SAN ("33...Qd6 34.Qe8 Qd1+"), stopping at the first move that doesn't fit. */
export function lineSan(start, moves, max) {
  const parts = [];
  let position = start;
  for (let i = 0; i < moves.length && i < max; i++) {
    const m = position.parseUci(moves[i]);
    if (!m) break;
    const san = position.san(m);
    if (position.whiteToMove) parts.push(position.fullMove + '.' + san);
    else parts.push(i === 0 ? position.fullMove + '...' + san : san);
    position = position.play(m);
  }
  return parts.join(' ');
}

/** The first hint: the idea, only when a detector confirms it on this very move. */
export function ideaHint(before, solution, followUp, themes, solverMovesLeft) {
  if (themes.some(t => t.startsWith('mateIn'))) {
    return solverMovesLeft === 1 ? "There's a mate in one." : "There's a forced mate in " + solverMovesLeft + '.';
  }
  const kinds = moveFacts(before, solution, followUp).map(f => f.kind);
  if (kinds.includes('mate')) return "There's a mate in one.";
  if (kinds.includes('doubleCheck')) return 'Look for a double check.';
  if (kinds.includes('fork')) return 'Look for a fork.';
  if (kinds.includes('pin')) return 'Look for a pin.';
  if (kinds.includes('skewer')) return 'Look for a skewer.';
  if (kinds.includes('discoveredCheck') || kinds.includes('discoveredAttack')) return 'Look for a discovered attack.';
  if (kinds.includes('underPromotion')) return 'Look for an unusual promotion.';
  if (kinds.includes('promotion')) return 'Look for a promotion.';
  if (kinds.includes('removesDefender')) return 'Look for a defender you can remove.';
  if (kinds.includes('hanging')) return 'Something is left undefended.';
  if (kinds.includes('sacrifice')) return 'Look for a sacrifice.';
  if (kinds.includes('threatMate')) return 'Look for a quiet move that threatens mate.';
  return null;
}

/** What the whole line won, from the position the solver faced to the end. */
export function summary(start, end, solverWhite, themes, solverMoves) {
  if (end.isCheckmate()) return solverMoves === 1 ? 'Checkmate in one.' : 'Checkmate in ' + solverMoves + ' moves.';
  const net = (end.material(solverWhite) - end.material(!solverWhite)) - (start.material(solverWhite) - start.material(!solverWhite));
  const won = [], lost = [];
  const newQueens = Math.max(0, end.count(solverWhite, QUEEN) - start.count(solverWhite, QUEEN));
  for (let type = QUEEN; type >= PAWN; type--) {
    const gone = start.count(!solverWhite, type) - end.count(!solverWhite, type);
    if (gone > 0) won.push(gone === 1 ? 'a ' + NAMES[type] : COUNTS[Math.min(gone, 8)] + ' ' + PLURALS[type]);
    let mine = start.count(solverWhite, type) - end.count(solverWhite, type);
    if (type === PAWN) mine -= newQueens;
    if (mine > 0) lost.push(mine === 1 ? 'a ' + NAMES[type] : COUNTS[Math.min(mine, 8)] + ' ' + PLURALS[type]);
  }
  const extra = newQueens > 0 ? ' and makes a new queen' : '';
  if (won.length === 0 && net <= 0) {
    if (themes.includes('crushing') || themes.includes('advantage')) return 'Material is level' + extra + ', but the position is now clearly winning.';
    if (themes.includes('equality')) return 'This holds the balance.';
    return 'Material is level' + extra + '.';
  }
  const score = ' (' + (net >= 0 ? '+' : '') + net + ').';
  if (won.length === 0) {
    if (newQueens > 0) return 'Makes a new queen' + (lost.length > 0 ? ', giving up ' + joinList(lost) + ' on the way' : '') + score;
    return 'Comes out ahead' + (lost.length > 0 ? ' despite giving up ' + joinList(lost) : '') + score;
  }
  let text = 'Wins ' + joinList(won);
  if (lost.length > 0) text += ' for ' + joinList(lost);
  return text + extra + score;
}

export { Board };
