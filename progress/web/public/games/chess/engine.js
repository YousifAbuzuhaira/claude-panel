// Stockfish over UCI, from widget/ChessCore.cs (UciResult, UciEngine). In the browser it
// is npm stockfish@19.0.1's lite single-threaded build in a Web Worker, served by the
// web server at /engine/; the script finds its .wasm next to itself (its URL with .js
// swapped for .wasm), and needs no SharedArrayBuffer. parseInfo is pure, for the tests.

export const ENGINE_URL = '/engine/stockfish-19-lite-single.js';

export function emptyResult(id = 0) {
  return { id, done: false, bestMove: '', pv: [], scoreCp: 0, mateIn: 0, depth: 0, isMate: false, hasScore: false, error: '' };
}

/** The score in centipawns for the side to move; mates become huge numbers. */
export const valueOf = r => (r.isMate ? (r.mateIn > 0 ? 100000 - r.mateIn : -100000 - r.mateIn) : r.scoreCp);

export function parseInfo(line, into) {
  const words = line.split(' ');
  let depth = into.depth;
  for (let i = 1; i < words.length; i++) {
    if (words[i] === 'depth' && i + 1 < words.length) { const d = parseInt(words[i + 1], 10); if (!Number.isNaN(d)) depth = d; }
    else if (words[i] === 'score' && i + 2 < words.length) {
      if (!/^-?\d+$/.test(words[i + 2])) continue;
      const value = parseInt(words[i + 2], 10);
      into.isMate = words[i + 1] === 'mate';
      if (into.isMate) into.mateIn = value; else into.scoreCp = value;
      into.hasScore = true;
    } else if (words[i] === 'pv') {
      into.pv = words.slice(i + 1).filter(w => w.length >= 4);
      break;
    }
  }
  into.depth = depth;
}

/** "mate in 2", "mated in 3", "+1.4". */
export function formatScore(value) {
  if (value >= 99000) return 'mate in ' + (100000 - value);
  if (value <= -99000) return 'mated in ' + (100000 + value);
  const pawns = value / 100;
  return (pawns >= 0 ? '+' : '') + pawns.toFixed(1);
}

/**
 * One engine. status: starting ready busy dead. analyse() resolves a result when the
 * search ends, or with error set (timeout after its budget + 4 s, or the worker died).
 * makeWorker is injectable so tests can stand in a fake.
 */
export class UciEngine {
  constructor(makeWorker = () => new Worker(ENGINE_URL)) {
    this.status = 'starting';
    this.log = [];
    this.nextId = 0;
    this.ignoreBestMoves = 0;
    this.current = null;      // {result, resolve, timer}
    this.readyWaiters = [];
    try {
      this.worker = makeWorker();
    } catch (error) {
      this.status = 'dead';
      this.error = String(error && error.message || error);
      return;
    }
    this.worker.onmessage = event => this.#onLine(String(event.data ?? ''));
    this.worker.onerror = event => this.#die(String(event && event.message || 'engine error'));
    this.send('uci');
    this.send('setoption name Hash value 32');
    this.send('isready');
  }

  send(line) {
    try { this.worker.postMessage(line); } catch (error) { this.#die(String(error.message || error)); }
  }

  #onLine(text) {
    for (const line of text.split('\n')) {
      if (!line) continue;
      if (this.log.length < 400) this.log.push(line);
      if (line === 'readyok' && this.status === 'starting') {
        this.status = 'ready';
        for (const wake of this.readyWaiters.splice(0)) wake(true);
      } else if (line.startsWith('info ') && this.current && !this.current.result.done) {
        parseInfo(line, this.current.result);
      } else if (line.startsWith('bestmove')) {
        if (this.ignoreBestMoves > 0) { this.ignoreBestMoves--; continue; }
        if (!this.current || this.current.result.done) continue;
        const parts = line.split(' ');
        this.current.result.bestMove = parts.length > 1 ? parts[1] : '';
        this.#finish();
        this.status = 'ready';
      }
    }
  }

  #finish(error = '') {
    const job = this.current;
    if (!job || job.result.done) return;
    clearTimeout(job.timer);
    job.result.done = true;
    if (error) job.result.error = error;
    job.resolve({ ...job.result, pv: [...job.result.pv], value: valueOf(job.result) });
  }

  #die(message) {
    this.status = 'dead';
    this.error = message;
    for (const wake of this.readyWaiters.splice(0)) wake(false);
    this.#finish(message || 'engine stopped');
    try { this.worker && this.worker.terminate(); } catch {}
  }

  /** Waits for readyok, up to ms. */
  whenReady(ms = 8000) {
    if (this.status === 'dead') return Promise.resolve(false);
    if (this.status !== 'starting') return Promise.resolve(true);
    return new Promise(resolve => {
      const timer = setTimeout(() => { this.#die('the engine did not start'); resolve(false); }, ms);
      this.readyWaiters.push(ok => { clearTimeout(timer); resolve(ok); });
    });
  }

  /** Analyses the position after `moves`; searchMoves limits the first move. */
  async analyse(fen, moves, movetimeMs, searchMoves) {
    if (!(await this.whenReady())) return { ...emptyResult(0), done: true, error: this.error || 'engine stopped', value: 0 };
    if (this.current && !this.current.result.done) {
      this.ignoreBestMoves++;
      const old = this.current;
      this.current = null;
      clearTimeout(old.timer);
      old.result.done = true;
      old.resolve({ ...old.result, error: 'superseded', value: valueOf(old.result) });
      this.send('stop');
    }
    const id = ++this.nextId;
    return new Promise(resolve => {
      const result = emptyResult(id);
      const timer = setTimeout(() => { this.#finish('timeout'); this.status = 'dead'; }, movetimeMs + 4000);
      this.current = { result, resolve, timer };
      this.status = 'busy';
      this.send('position fen ' + fen + (moves && moves.length ? ' moves ' + moves.join(' ') : ''));
      this.send('go movetime ' + movetimeMs + (searchMoves && searchMoves.length ? ' searchmoves ' + searchMoves.join(' ') : ''));
    });
  }

  drainLog() { return this.log.splice(0); }

  quit() {
    try { this.send('quit'); this.worker.terminate(); } catch {}
    this.status = 'dead';
  }
}
