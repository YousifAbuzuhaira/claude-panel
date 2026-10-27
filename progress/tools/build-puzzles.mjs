// Builds widget/ChessPuzzles.txt from the Lichess puzzle database (CC0):
// https://database.lichess.org/lichess_db_puzzle.csv.zst
//
//   node tools/build-puzzles.mjs --in <csv.zst> --out widget/ChessPuzzles.txt
//        [--per-band 900] [--theme-floor 300] [--list-threshold 60] [--seed 1]
//        [--include id,id] [--glossary widget/ChessThemes.txt]
//
// Puzzles are spread evenly over 100-point rating bands from 400 to 2999. A band
// takes the best-liked, most-played puzzles first and only falls back to a looser
// tier when it is short. Rare themes are topped up so theme practice has enough.
// One pass over the file keeps seeded random samples (reservoirs), then picks.
import { readFileSync, writeFileSync } from 'node:fs';
import { frameLines } from './zstd-frames.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, word, i, all) => {
    if (word.startsWith('--')) pairs.push([word.slice(2), all[i + 1]]);
    return pairs;
  }, []),
);
if (!args.in || !args.out) {
  console.error('usage: node tools/build-puzzles.mjs --in <csv.zst> --out <txt> [options]');
  process.exit(2);
}
const PER_BAND = Number(args['per-band'] ?? 750);
const THEME_FLOOR = Number(args['theme-floor'] ?? 300);
const LIST_THRESHOLD = Number(args['list-threshold'] ?? 60);
const SEED = Number(args.seed ?? 1);
const INCLUDE = new Set((args.include ?? '').split(',').filter(Boolean));
const BAND_KEEP = 3000;
const THEME_KEEP = 600;
const LOW_BAND = 400;
const HIGH_BAND = 2900;
// Tags that say how much the line wins, not what it is: never topped up.
const META = new Set(['advantage', 'crushing', 'equality', 'mix', 'playerGames']);

const TIERS = [
  { name: 'T1', popularity: 80, plays: 1000, deviation: 80 },
  { name: 'T2', popularity: 60, plays: 300, deviation: 100 },
  { name: 'T3', popularity: 40, plays: 100, deviation: 150 },
];

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const random = mulberry32(SEED);

// Algorithm R: a fixed-size uniform sample of everything offered.
class Reservoir {
  constructor(size) { this.size = size; this.seen = 0; this.items = []; }
  offer(item) {
    this.seen++;
    if (this.items.length < this.size) { this.items.push(item); return; }
    const j = Math.floor(random() * this.seen);
    if (j < this.size) this.items[j] = item;
  }
}

function tierOf(row) {
  for (let i = 0; i < TIERS.length; i++) {
    const t = TIERS[i];
    if (row.popularity >= t.popularity && row.plays >= t.plays && row.deviation <= t.deviation) return i;
  }
  return -1;
}

const FEN_PATTERN = /^([pnbrqkPNBRQK1-8]{1,8}\/){7}[pnbrqkPNBRQK1-8]{1,8} [wb] (-|K?Q?k?q?) (-|[a-h][36]) \d+ \d+$/;
const MOVES_PATTERN = /^[a-h][1-8][a-h][1-8][qrbn]?( [a-h][1-8][a-h][1-8][qrbn]?)+$/;

// Returns why a row can't be used, or null.
function problemWith(row) {
  if (!FEN_PATTERN.test(row.fen)) return 'fen';
  if (!MOVES_PATTERN.test(row.moves)) return 'moves';
  const count = row.moves.split(' ').length;
  if (count % 2 !== 0) return 'odd move count';
  for (const theme of row.themes) {
    // mateIn5 means five or more moves.
    const mate = /^mateIn(\d)$/.exec(theme);
    const wanted = mate ? 2 * Number(mate[1]) : 0;
    if (mate && (wanted === 10 ? count < wanted : count !== wanted)) return `${theme} with ${count} moves`;
  }
  if (row.themes.includes('oneMove') && count !== 2) return 'oneMove with more moves';
  if (!row.game) return 'game link';
  const line = toLine(row);
  if (/[^\x20-\x7e]/.test(line)) return 'not ascii';
  if (line.split('|').length !== 9) return 'pipe in a field';
  return null;
}

function toLine(row) {
  return [row.id, row.fen, row.moves, row.rating, row.deviation, row.popularity, row.plays, row.themes.join(' '), row.game].join('|');
}

const bandOf = rating => Math.floor(rating / 100) * 100;
const bands = [];
for (let b = LOW_BAND; b <= HIGH_BAND; b += 100) bands.push(b);

const bandSamples = new Map(bands.map(b => [b, TIERS.map(() => new Reservoir(BAND_KEEP))]));
const bandSeen = new Map(bands.map(b => [b, 0]));
const themeSamples = new Map();
const themeAvailable = new Map(); // theme -> counts per tier
const included = new Map();
const dropped = new Map();
let rowsSeen = 0;
let outsideBands = 0;
const tierTotals = TIERS.map(() => 0);

for (const text of frameLines(args.in)) {
  if (!text || text.startsWith('PuzzleId')) continue;
  const f = text.split(',');
  if (f.length < 9) { dropped.set('columns', (dropped.get('columns') ?? 0) + 1); continue; }
  rowsSeen++;
  const row = {
    id: f[0], fen: f[1], moves: f[2], rating: Number(f[3]), deviation: Number(f[4]),
    popularity: Number(f[5]), plays: Number(f[6]), themes: f[7].split(' ').filter(Boolean),
    game: f[8].replace(/^https:\/\/lichess\.org\//, ''),
  };
  if (INCLUDE.has(row.id)) included.set(row.id, row);
  const band = bandOf(row.rating);
  if (band < LOW_BAND || band > HIGH_BAND) { outsideBands++; continue; }
  bandSeen.set(band, bandSeen.get(band) + 1);
  const tier = tierOf(row);
  if (tier < 0) continue;
  const problem = problemWith(row);
  if (problem) { dropped.set(problem, (dropped.get(problem) ?? 0) + 1); continue; }
  tierTotals[tier]++;
  bandSamples.get(band)[tier].offer(row);
  for (const theme of row.themes) {
    if (!themeSamples.has(theme)) {
      themeSamples.set(theme, TIERS.map(() => new Reservoir(THEME_KEEP)));
      themeAvailable.set(theme, TIERS.map(() => 0));
    }
    themeSamples.get(theme)[tier].offer(row);
    themeAvailable.get(theme)[tier]++;
  }
}

// --- Pick ---------------------------------------------------------------------
const chosen = new Map();
const themeChosen = new Map();
function choose(row) {
  if (chosen.has(row.id)) return false;
  chosen.set(row.id, row);
  for (const theme of row.themes) themeChosen.set(theme, (themeChosen.get(theme) ?? 0) + 1);
  return true;
}

const bandReport = [];
for (const band of bands) {
  const samples = bandSamples.get(band);
  let taken = 0;
  let tierUsed = '-';
  for (let t = 0; t < TIERS.length && taken < PER_BAND; t++) {
    for (const row of samples[t].items) {
      if (taken >= PER_BAND) break;
      if (choose(row)) { taken++; tierUsed = TIERS[t].name; }
    }
  }
  bandReport.push({ band, seen: bandSeen.get(band), t1: samples[0].seen, t2: samples[1].seen, t3: samples[2].seen, taken, tierUsed });
}

const toppedUp = new Map();
for (const [theme, samples] of [...themeSamples].sort()) {
  if (META.has(theme)) continue;
  const available = themeAvailable.get(theme);
  const floor = Math.min(THEME_FLOOR, available[0] + available[1]);
  for (let t = 0; t < TIERS.length; t++) {
    const target = t < 2 ? floor : LIST_THRESHOLD;
    for (const row of samples[t].items) {
      if ((themeChosen.get(theme) ?? 0) >= target) break;
      if (choose(row)) toppedUp.set(theme, (toppedUp.get(theme) ?? 0) + 1);
    }
  }
}

const missingIncludes = [];
for (const id of INCLUDE) {
  const row = included.get(id);
  if (!row) { missingIncludes.push(id); continue; }
  const problem = problemWith(row);
  if (problem) { missingIncludes.push(`${id} (${problem})`); continue; }
  choose(row);
}

// --- Write ----------------------------------------------------------------------
const rows = [...chosen.values()].sort((a, b) => a.rating - b.rating || a.id.localeCompare(b.id));
const today = new Date().toISOString().slice(0, 10);
const header = [
  '# Chess puzzles from the Lichess puzzle database (CC0), https://database.lichess.org/#puzzles',
  `# Built ${today} by tools/build-puzzles.mjs, seed ${SEED}, ${PER_BAND} per band, theme floor ${THEME_FLOOR}.`,
  '# id|fen|moves|rating|rd|popularity|plays|themes|game',
  '# fen is the position before the opponent\'s setup move; moves are UCI, the first is that setup move.',
];
const body = header.concat(rows.map(toLine)).join('\n') + '\n';
writeFileSync(args.out, body, 'ascii');

// --- Report ---------------------------------------------------------------------
const pad = (value, width) => String(value).padStart(width);
console.log(`rows seen ${rowsSeen}, outside ${LOW_BAND}-${HIGH_BAND + 99}: ${outsideBands}`);
console.log(`passing T1 ${tierTotals[0]}, T2 only ${tierTotals[1]}, T3 only ${tierTotals[2]}`);
console.log('\nband   seen      T1      T2      T3  taken tier');
for (const r of bandReport) {
  console.log(`${pad(r.band, 4)} ${pad(r.seen, 7)} ${pad(r.t1, 7)} ${pad(r.t2, 7)} ${pad(r.t3, 7)} ${pad(r.taken, 6)} ${r.tierUsed}`);
}

let glossary = null;
if (args.glossary) {
  glossary = new Map();
  for (const line of readFileSync(args.glossary, 'ascii').split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const [key, group] = line.split('|');
    glossary.set(key, group);
  }
}
console.log('\ntheme                   T1 avail  all avail  chosen  topped  listed  group');
const themes = [...themeAvailable.keys()].sort((a, b) => (themeChosen.get(a) ?? 0) - (themeChosen.get(b) ?? 0));
for (const theme of themes) {
  const available = themeAvailable.get(theme);
  const all = available[0] + available[1] + available[2];
  const count = themeChosen.get(theme) ?? 0;
  const listed = count >= LIST_THRESHOLD && !META.has(theme) ? 'yes' : 'no';
  const group = glossary ? (glossary.get(theme) ?? 'MISSING') : '';
  console.log(`${theme.padEnd(22)} ${pad(available[0], 9)} ${pad(all, 10)} ${pad(count, 7)} ${pad(toppedUp.get(theme) ?? 0, 7)} ${pad(listed, 7)}  ${group}`);
}
if (glossary) {
  const unknown = [...glossary.keys()].filter(key => !themeAvailable.has(key) && !META.has(key));
  console.log(`\nglossary keys not in the data: ${unknown.length ? unknown.join(' ') : 'none'}`);
  const missing = themes.filter(theme => !glossary.has(theme));
  console.log(`themes missing from the glossary: ${missing.length ? missing.join(' ') : 'none'}`);
}
console.log(`\ndropped rows: ${dropped.size ? [...dropped].map(([why, n]) => `${why} ${n}`).join(', ') : 'none'}`);
if (INCLUDE.size) console.log(`includes not found: ${missingIncludes.length ? missingIncludes.join(' ') : 'none'}`);
console.log(`wrote ${rows.length} puzzles, ${body.length} bytes to ${args.out}`);
