// The chess rules, ported from widget/ChessCore.cs (class Board): FEN, attacks, legal
// moves, SAN and UCI. No DOM, so node:test can check it with perft.
// Squares are 0..63 with a1 = 0, h1 = 7, a8 = 56, h8 = 63. Pieces are signed:
// +1..+6 white pawn, knight, bishop, rook, queen, king; negative black.

export const PAWN = 1, KNIGHT = 2, BISHOP = 3, ROOK = 4, QUEEN = 5, KING = 6;
export const CASTLE = 1, EN_PASSANT = 2, DOUBLE_PUSH = 4;

const KNIGHT_STEPS = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
const KING_STEPS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
export const DIAGONALS = [[1, 1], [-1, 1], [1, -1], [-1, -1]];
export const LINES = [[1, 0], [-1, 0], [0, 1], [0, -1]];

export const fileOf = sq => sq & 7;
export const rankOf = sq => sq >> 3;
export const onBoard = (file, rank) => file >= 0 && file < 8 && rank >= 0 && rank < 8;
export const squareName = sq => String.fromCharCode(97 + fileOf(sq)) + String.fromCharCode(49 + rankOf(sq));
export function squareIndex(name) {
  if (typeof name !== 'string' || name.length !== 2) return -1;
  const file = name.charCodeAt(0) - 97, rank = name.charCodeAt(1) - 49;
  return onBoard(file, rank) ? rank * 8 + file : -1;
}
export function pieceValue(piece) {
  switch (Math.abs(piece)) { case 1: return 1; case 2: return 3; case 3: return 3; case 4: return 5; case 5: return 9; default: return 0; }
}
export const pieceLetter = piece => 'PNBRQK'[Math.abs(piece) - 1];

/** A move: {from, to, piece (1..6), captured (0 or 1..6), promo (0 or 2..5), flags}. */
export function makeMove(from, to, piece, captured = 0, promo = 0, flags = 0) {
  return { from, to, piece, captured, promo, flags };
}
export const isCastle = m => (m.flags & CASTLE) !== 0;
export const isEnPassant = m => (m.flags & EN_PASSANT) !== 0;
export const isCapture = m => m.captured !== 0;
export function uci(m) {
  let text = squareName(m.from) + squareName(m.to);
  if (m.promo !== 0) text += 'pnbrqk'[m.promo - 1];
  return text;
}

export class Board {
  constructor() {
    this.squares = new Int8Array(64);
    this.whiteToMove = true;
    this.castling = 0;      // 1 white short, 2 white long, 4 black short, 8 black long
    this.epSquare = -1;     // the square a pawn passed over, or -1
    this.halfMove = 0;
    this.fullMove = 1;
  }

  // --- FEN --------------------------------------------------------------------------
  static fromFen(fen) {
    const parts = String(fen).trim().split(/ +/).filter(Boolean);
    if (parts.length < 4) throw new Error('FEN needs at least 4 fields');
    const board = new Board();
    const ranks = parts[0].split('/');
    if (ranks.length !== 8) throw new Error('FEN needs 8 ranks');
    for (let r = 0; r < 8; r++) {
      let file = 0;
      const rank = 7 - r;
      for (const c of ranks[r]) {
        if (c >= '1' && c <= '8') { file += c.charCodeAt(0) - 48; continue; }
        const index = 'pnbrqk'.indexOf(c.toLowerCase());
        if (index < 0 || file > 7) throw new Error('bad FEN piece ' + c);
        board.squares[rank * 8 + file] = c !== c.toLowerCase() ? index + 1 : -(index + 1);
        file++;
      }
      if (file !== 8) throw new Error('FEN rank ' + (rank + 1) + ' is not 8 squares');
    }
    if (parts[1] !== 'w' && parts[1] !== 'b') throw new Error('bad side to move');
    board.whiteToMove = parts[1] === 'w';
    if (parts[2] !== '-') {
      for (const c of parts[2]) {
        const bit = 'KQkq'.indexOf(c);
        if (bit < 0) throw new Error('bad castling field');
        board.castling |= 1 << bit;
      }
    }
    board.epSquare = parts[3] === '-' ? -1 : squareIndex(parts[3]);
    if (parts.length > 4 && /^-?\d+$/.test(parts[4])) board.halfMove = parseInt(parts[4], 10);
    if (parts.length > 5 && /^-?\d+$/.test(parts[5])) board.fullMove = parseInt(parts[5], 10);
    if (board.kingSquare(true) < 0 || board.kingSquare(false) < 0) throw new Error('a king is missing');
    return board;
  }

  toFen() {
    let text = '';
    for (let rank = 7; rank >= 0; rank--) {
      let empty = 0;
      for (let file = 0; file < 8; file++) {
        const p = this.squares[rank * 8 + file];
        if (p === 0) { empty++; continue; }
        if (empty > 0) { text += empty; empty = 0; }
        const letter = 'pnbrqk'[Math.abs(p) - 1];
        text += p > 0 ? letter.toUpperCase() : letter;
      }
      if (empty > 0) text += empty;
      if (rank > 0) text += '/';
    }
    text += this.whiteToMove ? ' w ' : ' b ';
    let rights = '';
    for (let bit = 0; bit < 4; bit++) if (this.castling & (1 << bit)) rights += 'KQkq'[bit];
    text += rights.length > 0 ? rights : '-';
    text += ' ' + (this.epSquare < 0 ? '-' : squareName(this.epSquare));
    text += ' ' + this.halfMove + ' ' + this.fullMove;
    return text;
  }

  clone() {
    const copy = new Board();
    copy.squares.set(this.squares);
    copy.whiteToMove = this.whiteToMove;
    copy.castling = this.castling;
    copy.epSquare = this.epSquare;
    copy.halfMove = this.halfMove;
    copy.fullMove = this.fullMove;
    return copy;
  }

  pieceAt(sq) { return this.squares[sq]; }
  isWhite(sq) { return this.squares[sq] > 0; }

  kingSquare(white) {
    const king = white ? KING : -KING;
    for (let sq = 0; sq < 64; sq++) if (this.squares[sq] === king) return sq;
    return -1;
  }

  // --- Attacks --------------------------------------------------------------------------
  /** Squares of one side's pieces that attack sq. A slider's ray stops at the first piece. */
  attackers(sq, byWhite) {
    const found = [];
    const file = fileOf(sq), rank = rankOf(sq);
    const sign = byWhite ? 1 : -1;
    const pawnRank = rank - sign;
    for (const df of [-1, 1]) {
      if (onBoard(file + df, pawnRank) && this.squares[pawnRank * 8 + file + df] === sign * PAWN) found.push(pawnRank * 8 + file + df);
    }
    for (const [sf, sr] of KNIGHT_STEPS) {
      const f = file + sf, r = rank + sr;
      if (onBoard(f, r) && this.squares[r * 8 + f] === sign * KNIGHT) found.push(r * 8 + f);
    }
    for (const [sf, sr] of KING_STEPS) {
      const f = file + sf, r = rank + sr;
      if (onBoard(f, r) && this.squares[r * 8 + f] === sign * KING) found.push(r * 8 + f);
    }
    this.#addSliders(found, sq, DIAGONALS, sign * BISHOP, sign * QUEEN);
    this.#addSliders(found, sq, LINES, sign * ROOK, sign * QUEEN);
    return found;
  }

  #addSliders(found, sq, directions, slider, queen) {
    for (const [df, dr] of directions) {
      let f = fileOf(sq) + df, r = rankOf(sq) + dr;
      while (onBoard(f, r)) {
        const p = this.squares[r * 8 + f];
        if (p !== 0) { if (p === slider || p === queen) found.push(r * 8 + f); break; }
        f += df; r += dr;
      }
    }
  }

  isAttacked(sq, byWhite) { return this.attackers(sq, byWhite).length > 0; }

  /** Squares the piece on sq attacks (or defends), whatever stands there. */
  attacksFrom(sq) {
    const found = [];
    const p = this.squares[sq];
    if (p === 0) return found;
    const type = Math.abs(p), file = fileOf(sq), rank = rankOf(sq);
    if (type === PAWN) {
      const r = rank + (p > 0 ? 1 : -1);
      for (const df of [-1, 1]) if (onBoard(file + df, r)) found.push(r * 8 + file + df);
    } else if (type === KNIGHT || type === KING) {
      for (const [sf, sr] of type === KNIGHT ? KNIGHT_STEPS : KING_STEPS) {
        if (onBoard(file + sf, rank + sr)) found.push((rank + sr) * 8 + file + sf);
      }
    } else {
      const directions = [];
      if (type !== ROOK) directions.push(...DIAGONALS);
      if (type !== BISHOP) directions.push(...LINES);
      for (const [df, dr] of directions) {
        let f = file + df, r = rank + dr;
        while (onBoard(f, r)) {
          found.push(r * 8 + f);
          if (this.squares[r * 8 + f] !== 0) break;
          f += df; r += dr;
        }
      }
    }
    return found;
  }

  inCheck() { const king = this.kingSquare(this.whiteToMove); return king >= 0 && this.isAttacked(king, !this.whiteToMove); }
  isCheckmate() { return this.inCheck() && this.legalMoves().length === 0; }
  isStalemate() { return !this.inCheck() && this.legalMoves().length === 0; }

  // --- Moves ------------------------------------------------------------------------------
  play(m) {
    const next = this.clone();
    const mover = this.squares[m.from];
    const sign = mover > 0 ? 1 : -1;
    next.squares[m.from] = 0;
    next.squares[m.to] = m.promo !== 0 ? sign * m.promo : mover;
    if (isEnPassant(m)) next.squares[m.to - 8 * sign] = 0;
    if (isCastle(m)) {
      const shortSide = m.to > m.from;
      const rookFrom = shortSide ? m.from + 3 : m.from - 4, rookTo = shortSide ? m.from + 1 : m.from - 1;
      next.squares[rookTo] = next.squares[rookFrom];
      next.squares[rookFrom] = 0;
    }
    next.castling &= ~(rightsTouched(m.from) | rightsTouched(m.to));
    next.epSquare = (m.flags & DOUBLE_PUSH) !== 0 ? (m.from + m.to) / 2 : -1;
    next.halfMove = (Math.abs(mover) === PAWN || isCapture(m)) ? 0 : this.halfMove + 1;
    if (!this.whiteToMove) next.fullMove = this.fullMove + 1;
    next.whiteToMove = !this.whiteToMove;
    return next;
  }

  /** Passes the turn: used to ask "what would this side threaten next?". */
  nullMove() {
    const next = this.clone();
    next.whiteToMove = !this.whiteToMove;
    next.epSquare = -1;
    return next;
  }

  #pseudoMoves() {
    const moves = [];
    const white = this.whiteToMove;
    const sign = white ? 1 : -1;
    for (let sq = 0; sq < 64; sq++) {
      const p = this.squares[sq];
      if (p === 0 || (p > 0) !== white) continue;
      const type = Math.abs(p), file = fileOf(sq), rank = rankOf(sq);
      if (type === PAWN) {
        const r = rank + sign;
        const lastRank = white ? 7 : 0, startRank = white ? 1 : 6;
        if (onBoard(file, r) && this.squares[r * 8 + file] === 0) {
          addPawn(moves, sq, r * 8 + file, 0, 0, r === lastRank);
          const r2 = rank + 2 * sign;
          if (rank === startRank && this.squares[r2 * 8 + file] === 0) moves.push(makeMove(sq, r2 * 8 + file, PAWN, 0, 0, DOUBLE_PUSH));
        }
        for (const df of [-1, 1]) {
          if (!onBoard(file + df, r)) continue;
          const to = r * 8 + file + df, target = this.squares[to];
          if (target !== 0 && (target > 0) !== white) addPawn(moves, sq, to, Math.abs(target), 0, r === lastRank);
          else if (to === this.epSquare && target === 0) moves.push(makeMove(sq, to, PAWN, PAWN, 0, EN_PASSANT));
        }
        continue;
      }
      for (const to of this.attacksFrom(sq)) {
        const target = this.squares[to];
        if (target !== 0 && (target > 0) === white) continue;
        moves.push(makeMove(sq, to, type, Math.abs(target)));
      }
      if (type === KING) this.#addCastles(moves, sq);
    }
    return moves;
  }

  #addCastles(moves, sq) {
    const white = this.whiteToMove;
    const home = white ? 4 : 60;
    if (sq !== home) return;
    const enemy = !white;
    const shortRight = white ? 1 : 4, longRight = white ? 2 : 8;
    const rook = white ? ROOK : -ROOK;
    const s = this.squares;
    if ((this.castling & shortRight) && s[home + 3] === rook && s[home + 1] === 0 && s[home + 2] === 0
      && !this.isAttacked(home, enemy) && !this.isAttacked(home + 1, enemy) && !this.isAttacked(home + 2, enemy)) {
      moves.push(makeMove(home, home + 2, KING, 0, 0, CASTLE));
    }
    if ((this.castling & longRight) && s[home - 4] === rook && s[home - 1] === 0 && s[home - 2] === 0 && s[home - 3] === 0
      && !this.isAttacked(home, enemy) && !this.isAttacked(home - 1, enemy) && !this.isAttacked(home - 2, enemy)) {
      moves.push(makeMove(home, home - 2, KING, 0, 0, CASTLE));
    }
  }

  legalMoves() {
    const legal = [];
    for (const m of this.#pseudoMoves()) {
      const next = this.play(m);
      const king = next.kingSquare(this.whiteToMove);
      if (king >= 0 && !next.isAttacked(king, !this.whiteToMove)) legal.push(m);
    }
    return legal;
  }

  legalMovesFrom(sq) { return this.legalMoves().filter(m => m.from === sq); }

  /** The legal move from one square to another; promo 0 means a queen when promoting. */
  findMove(from, to, promo = 0) {
    for (const m of this.legalMoves()) {
      if (m.from === from && m.to === to && (m.promo === 0 || m.promo === (promo === 0 ? QUEEN : promo))) return m;
    }
    return null;
  }

  needsPromotion(from, to) { return this.legalMoves().some(m => m.from === from && m.to === to && m.promo !== 0); }

  /** Reads UCI; king-takes-own-rook ("e1h1") is read as castling too. */
  parseUci(text) {
    if (typeof text !== 'string' || text.length < 4) return null;
    const from = squareIndex(text.slice(0, 2));
    let to = squareIndex(text.slice(2, 4));
    if (from < 0 || to < 0) return null;
    const promo = text.length > 4 ? 'pnbrqk'.indexOf(text[4]) + 1 : 0;
    const mover = this.squares[from];
    if (Math.abs(mover) === KING && this.squares[to] === (mover > 0 ? ROOK : -ROOK)) to = to > from ? from + 2 : from - 2;
    for (const m of this.legalMoves()) if (m.from === from && m.to === to && m.promo === promo) return m;
    return null;
  }

  sameMove(a, text) {
    const parsed = this.parseUci(text);
    return parsed !== null && a != null && parsed.from === a.from && parsed.to === a.to && parsed.promo === a.promo;
  }

  // --- SAN ---------------------------------------------------------------------------------
  san(m) {
    let text;
    if (isCastle(m)) text = m.to > m.from ? 'O-O' : 'O-O-O';
    else {
      text = '';
      if (m.piece === PAWN) {
        if (isCapture(m)) text += String.fromCharCode(97 + fileOf(m.from)) + 'x';
        text += squareName(m.to);
        if (m.promo !== 0) text += '=' + pieceLetter(m.promo);
      } else {
        text += pieceLetter(m.piece);
        const rivals = this.legalMoves().filter(o => o.piece === m.piece && o.to === m.to && o.from !== m.from);
        if (rivals.length > 0) {
          const fileUnique = rivals.every(o => fileOf(o.from) !== fileOf(m.from));
          const rankUnique = rivals.every(o => rankOf(o.from) !== rankOf(m.from));
          if (fileUnique) text += String.fromCharCode(97 + fileOf(m.from));
          else if (rankUnique) text += String.fromCharCode(49 + rankOf(m.from));
          else text += squareName(m.from);
        }
        if (isCapture(m)) text += 'x';
        text += squareName(m.to);
      }
    }
    const after = this.play(m);
    if (after.inCheck()) text += after.legalMoves().length === 0 ? '#' : '+';
    return text;
  }

  parseSan(text) {
    const wanted = String(text).replace(/[+#!?]+$/, '');
    for (const m of this.legalMoves()) if (this.san(m).replace(/[+#]+$/, '') === wanted) return m;
    return null;
  }

  material(white) {
    let total = 0;
    for (const p of this.squares) if (p !== 0 && (p > 0) === white) total += pieceValue(p);
    return total;
  }

  count(white, type) {
    let n = 0;
    const wanted = white ? type : -type;
    for (const p of this.squares) if (p === wanted) n++;
    return n;
  }
}

function rightsTouched(sq) {
  switch (sq) { case 4: return 3; case 7: return 1; case 0: return 2; case 60: return 12; case 63: return 4; case 56: return 8; default: return 0; }
}

function addPawn(moves, from, to, captured, flags, promotes) {
  if (!promotes) { moves.push(makeMove(from, to, PAWN, captured, 0, flags)); return; }
  for (const promo of [QUEEN, ROOK, BISHOP, KNIGHT]) moves.push(makeMove(from, to, PAWN, captured, promo, flags));
}

export function perft(board, depth) {
  if (depth === 0) return 1;
  const moves = board.legalMoves();
  if (depth === 1) return moves.length;
  let total = 0;
  for (const m of moves) total += perft(board.play(m), depth - 1);
  return total;
}
