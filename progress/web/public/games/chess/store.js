// The bundled puzzles, the theme glossary and the piece art, read from the WPF game's
// data files; and the picker, ported from widget/ChessCore.cs (PuzzleStore). No DOM.
import { Board } from './board.js';

/** Puzzles sorted by rating then id, indexed by id and by theme. */
export class PuzzleStore {
  constructor() {
    this.puzzles = [];
    this.byId = new Map();
    this.byTheme = new Map();
  }

  get count() { return this.puzzles.length; }
  get(id) { return (id != null && this.byId.get(String(id))) || null; }
  at(index) { return this.puzzles[index]; }
  themeCount(theme) { const list = this.byTheme.get(theme); return list ? list.length : 0; }
  themes() { return [...this.byTheme.keys()].sort(); }

  static fromText(text) { return PuzzleStore.fromLines(String(text).split(/\r?\n/)); }

  static fromLines(lines) {
    const store = new PuzzleStore();
    const list = [];
    for (const line of lines) {
      if (line.length === 0 || line[0] === '#') continue;
      const f = line.split('|');
      if (f.length !== 9) continue;
      const p = {
        id: f[0], fen: f[1], moves: f[2].split(' '), themes: f[7].split(' ').filter(Boolean), game: f[8],
        rating: 0, deviation: 0, popularity: 0, plays: 0, index: 0,
      };
      if (!/^-?\d+$/.test(f[3]) || !/^-?\d+$/.test(f[4])) continue;
      p.rating = parseInt(f[3], 10);
      p.deviation = parseInt(f[4], 10);
      p.popularity = parseInt(f[5], 10) || 0;
      p.plays = parseInt(f[6], 10) || 0;
      if (p.moves.length < 2 || store.byId.has(p.id)) continue;
      store.byId.set(p.id, p);
      list.push(p);
    }
    list.sort((a, b) => a.rating - b.rating || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    store.puzzles = list;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      p.index = i;
      for (const t of p.themes) {
        if (!store.byTheme.has(t)) store.byTheme.set(t, []);
        store.byTheme.get(t).push(i);
      }
    }
    return store;
  }

  /**
   * A puzzle near the target rating, widening the search 100 points at a time; falls
   * back to the nearest one, then to the whole set. rng(n) returns an integer in [0, n).
   * Returns {puzzle, window, nearest, fellBackToMix} or null.
   */
  pick(theme, target, exclude, rng) {
    let pool = null;
    let mix = !theme || theme === 'mix';
    if (!mix) { pool = this.byTheme.get(theme) || null; if (!pool) mix = true; }
    let result = this.#pickFrom(mix ? null : pool, target, exclude, rng);
    if (result) return result;
    if (!mix) {
      result = this.#pickFrom(null, target, exclude, rng);
      if (result) { result.fellBackToMix = true; return result; }
    }
    // Everything solved: start over rather than come up empty.
    return this.#pickFrom(null, target, new Set(), rng);
  }

  #pickFrom(pool, target, exclude, rng) {
    const size = pool === null ? this.puzzles.length : pool.length;
    if (size === 0) return null;
    const at = i => pool === null ? this.puzzles[i] : this.puzzles[pool[i]];
    for (let window = 100; window <= 1300; window += 100) {
      const low = lowerBound(at, size, target - window), high = lowerBound(at, size, target + window + 1);
      const inner = [], outer = [];
      for (let i = low; i < high; i++) {
        const p = at(i);
        if (exclude.has(p.id)) continue;
        if (Math.abs(p.rating - target) <= window / 2) inner.push(p); else outer.push(p);
      }
      if (inner.length + outer.length === 0) continue;
      // Twice as likely to land in the inner half of the window.
      const innerWeight = inner.length * 2, roll = rng(innerWeight + outer.length);
      const chosen = roll < innerWeight ? inner[Math.floor(roll / 2)] : outer[roll - innerWeight];
      return { puzzle: chosen, window, nearest: false, fellBackToMix: false };
    }
    let best = null;
    for (let i = 0; i < size; i++) {
      const p = at(i);
      if (exclude.has(p.id)) continue;
      if (best === null || Math.abs(p.rating - target) < Math.abs(best.rating - target)) best = p;
    }
    return best === null ? null : { puzzle: best, window: Math.abs(best.rating - target), nearest: true, fellBackToMix: false };
  }
}

function lowerBound(at, size, rating) {
  let low = 0, high = size;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (at(mid).rating < rating) low = mid + 1; else high = mid;
  }
  return low;
}

/** Every bundled puzzle replays legally and its mate tags hold (PuzzleCheck). */
export function puzzleProblems(store) {
  const problems = [];
  for (const p of store.puzzles) {
    try {
      let board = Board.fromFen(p.fen);
      for (const move of p.moves) {
        const m = board.parseUci(move);
        if (!m) { problems.push(p.id + ' illegal ' + move); board = null; break; }
        board = board.play(m);
      }
      if (!board) continue;
      const mateTag = p.themes.some(t => t === 'mate' || t.startsWith('mateIn'));
      if (mateTag && !board.isCheckmate()) problems.push(p.id + ' tagged mate but no mate');
      if (p.themes.includes('oneMove') && p.moves.length !== 2) problems.push(p.id + ' oneMove with ' + p.moves.length + ' moves');
    } catch (error) {
      problems.push(p.id + ' ' + error.message);
    }
  }
  return problems;
}

/** ChessThemes.txt: an ordered Map key -> {group, title, line}. */
export function parseGlossary(text) {
  const glossary = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const f = line.split('|');
    if (f.length !== 4) continue;
    glossary.set(f[0], { group: f[1], title: f[2], line: f[3] });
  }
  return glossary;
}

/** '#AARRGGBB' (WPF) to a CSS colour; 'none' stays 'none'. */
export function cssColour(hex) {
  if (!hex || hex === 'none') return 'none';
  const m = /^#([0-9a-f]{2})([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const alpha = parseInt(m[1], 16);
  if (alpha === 255) return '#' + m[2];
  const rgb = m[2].match(/../g).map(x => parseInt(x, 16));
  return `rgba(${rgb.join(',')},${(alpha / 255).toFixed(3)})`;
}

const PIECE_CODES = { wP: 1, wN: 2, wB: 3, wR: 4, wQ: 5, wK: 6, bP: -1, bN: -2, bB: -3, bR: -4, bQ: -5, bK: -6 };

/**
 * ChessPieces.txt: a Map piece code (-6..6) -> SVG markup (the paths only) on a 45x45 square.
 * WPF caps: flat/butt, round, square; F0 is even-odd, F1 non-zero.
 */
export function parsePieces(text) {
  const art = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const f = line.split('|');
    if (f.length < 9 || !(f[0] in PIECE_CODES)) continue;
    const code = PIECE_CODES[f[0]];
    const fill = cssColour(f[2]), stroke = cssColour(f[3]);
    const cap = f[5] === 'round' ? 'round' : f[5] === 'square' ? 'square' : 'butt';
    const join = f[6] === 'round' ? 'round' : f[6] === 'bevel' ? 'bevel' : 'miter';
    const rule = f[7] === 'F1' ? 'nonzero' : 'evenodd';
    let path = `<path d="${f.slice(8).join('|').replace(/"/g, '')}" fill="${fill}" fill-rule="${rule}"`;
    if (stroke !== 'none') path += ` stroke="${stroke}" stroke-width="${Number(f[4]) || 1}" stroke-linecap="${cap}" stroke-linejoin="${join}" stroke-miterlimit="4"`;
    path += '/>';
    art.set(code, (art.get(code) || '') + path);
  }
  return art;
}

/** A seeded integer generator (mulberry32): rng(n) in [0, n). */
export function seededRng(seed) {
  let a = seed >>> 0;
  return n => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
  };
}

export const randomRng = n => Math.floor(Math.random() * n);
