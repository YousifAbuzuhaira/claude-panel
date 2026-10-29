// Learn and the games in the browser, for every setup but WezTerm on WSL: a small local
// server that bridges HTTP + Server-Sent Events to Learn's helper (`learn.sh serve`,
// contract 2 in CLAUDE.md) and serves the pages in ./public. Node's own modules only.
//
//   node server.mjs open [learn | games/<name>]   find or start the server, open the page
//   node server.mjs serve                         run it in the foreground (what `open` starts)
//
// Security: it can start `claude -p` runs on the person's subscription and delete their
// courses, and any page they have open can reach 127.0.0.1. So it listens on 127.0.0.1
// only, wants a per-launch token on every API request (X-Learn-Token, or ?token= for the
// event stream, which can't set headers), and refuses any foreign Host or Origin, which
// also stops DNS rebinding. The token travels only in the URL's #hash.
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { homedir } from 'node:os';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(HERE, 'public');
const WIDGET = join(HERE, '..', 'widget');
const LEARN_SH = join(HERE, '..', 'learn', 'learn.sh');
const LEARN_MJS = join(HERE, '..', 'learn', 'learn.mjs');
const CONFIG_DIR = process.env.LEARN_CONFIG_DIR || join(homedir(), '.config', 'claude-learn');
const WEB_FILE = join(CONFIG_DIR, 'web.json');
const SAVES_DIR = process.env.CLAUDE_PANEL_SAVES || join(homedir(), '.config', 'claude-panel', 'games');
const STOCKFISH_DIR = join(homedir(), '.cache', 'claude-learn', 'stockfish');
const APP_SOURCE = join(HERE, '..', 'mac', 'ClaudePanel.swift');
const APP_CACHE = join(homedir(), '.cache', 'claude-panel', 'app');
const IDLE_MS = 30 * 60_000;
const RPC_TIMEOUT_MS = 10 * 60_000;
const MAX_BODY = 4 * 1024 * 1024;

// The game data the WPF games read, served as is.
const DATA_FILES = new Set(['ChessPuzzles.txt', 'ChessThemes.txt', 'ChessPieces.txt', 'TypeThemes.txt']);
const GAMES = new Set(['2048', 'sudoku', 'typetest', 'chess']);
// npm stockfish@19.0.1, as https://unpkg.com/stockfish@19.0.1/?meta lists it. Never committed: GPL-3.0.
const STOCKFISH = {
  'stockfish-19-lite-single.js': { size: 28_230, sha256: 'zLEw1/8pQIUxxH2Fmkn5HVnU9ILQWlPrGjIxpPYkyRo=' },
  'stockfish-19-lite-single.wasm': { size: 1_845_971, sha256: '7k8RW9stMsrflsraEEoFtewlfXrW9XWCGQtJvHHwlt4=' },
};

// WebAssembly and a worker for Stockfish; YouTube frames for Learn's videos; inline styles only.
const CSP = [
  "default-src 'self'", "script-src 'self' 'wasm-unsafe-eval'", "worker-src 'self' blob:", "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:", "connect-src 'self'", 'frame-src https://www.youtube.com https://www.youtube-nocookie.com',
  "object-src 'none'", "base-uri 'none'", "form-action 'self'",
].join('; ');

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.wasm': 'application/wasm', '.ico': 'image/x-icon',
};

// --- The helper -------------------------------------------------------------------------

/** One `learn.sh serve` child: requests go in by rid, events go out to every page. */
function startHelper(onEvent) {
  let child = null;
  let rid = 0;
  let restarts = 0;
  let lastStderr = '';
  const pending = new Map();

  const launch = () => {
    const argv = process.platform === 'win32' ? [process.execPath, [LEARN_MJS, 'serve']] : ['bash', [LEARN_SH, 'serve']];
    child = spawn(argv[0], argv[1], { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
    createInterface({ input: child.stdout }).on('line', line => {
      let value;
      try {
        value = JSON.parse(line);
      } catch {
        return;
      }
      if (typeof value.rid === 'number' && pending.has(value.rid)) {
        const { resolve, timer } = pending.get(value.rid);
        clearTimeout(timer);
        pending.delete(value.rid);
        resolve(value);
      } else if (value.event) {
        onEvent(value);
      }
    });
    child.stderr.on('data', chunk => { lastStderr = (lastStderr + chunk).slice(-2000); });
    child.on('exit', () => {
      child = null;
      for (const [id, { resolve, timer }] of pending) {
        clearTimeout(timer);
        resolve({ rid: id, ok: false, error: 'Learn\'s helper stopped' });
      }
      pending.clear();
      // Restarted once, as the WPF window does; after that the page shows why.
      if (restarts < 1) {
        restarts++;
        launch();
      } else {
        onEvent({ event: 'fatal', error: lastStderr.trim() || 'Learn\'s helper stopped and could not be restarted' });
      }
    });
  };
  launch();

  return {
    ask(request) {
      if (!child) return Promise.resolve({ ok: false, error: 'Learn\'s helper is not running' });
      const id = ++rid;
      return new Promise(resolve => {
        const timer = setTimeout(() => {
          pending.delete(id);
          resolve({ rid: id, ok: false, error: 'Learn\'s helper took too long to answer' });
        }, RPC_TIMEOUT_MS);
        pending.set(id, { resolve, timer });
        child.stdin.write(JSON.stringify({ ...request, rid: id }) + '\n');
      });
    },
    stop() {
      restarts = Infinity;
      child?.stdin.end();
    },
  };
}

// --- Saves and Stockfish ------------------------------------------------------------------

function writeAtomic(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, text, { mode: 0o600 });
  renameSync(temp, path);
}

const fetchings = new Map();

/** Fetches one Stockfish file once, checks its hash, and keeps it in ~/.cache. */
function stockfishFile(name) {
  const path = join(STOCKFISH_DIR, name);
  const want = STOCKFISH[name];
  const isGood = buffer => buffer.length === want.size && createHash('sha256').update(buffer).digest('base64') === want.sha256;
  if (existsSync(path)) {
    const buffer = readFileSync(path);
    if (isGood(buffer)) return Promise.resolve(buffer);
  }
  if (fetchings.has(name)) return fetchings.get(name);
  const fetching = fetch(`https://unpkg.com/stockfish@19.0.1/bin/${name}`)
    .then(async response => {
      if (!response.ok) throw new Error(`unpkg answered ${response.status}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      if (!isGood(buffer)) throw new Error(`${name} did not match its pinned hash`);
      mkdirSync(STOCKFISH_DIR, { recursive: true });
      writeFileSync(path, buffer);
      return buffer;
    })
    .finally(() => fetchings.delete(name));
  fetchings.set(name, fetching);
  return fetching;
}

// --- HTTP ---------------------------------------------------------------------------------

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('too large'));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// Only 64 hex digits are ever compared: anything else (other bytes, another length) can't throw.
const sameToken = (given, token) => typeof given === 'string' && /^[0-9a-f]{64}$/.test(given) && timingSafeEqual(Buffer.from(given), Buffer.from(token));

// One-time addresses for the browser: the token never goes on a command line, where any user
// on the machine can read it. `open` asks for one, the browser opens /launch/<nonce>, and the
// server answers once, within a minute, with a redirect to the page and its token in the #hash.
const LAUNCH_MS = 60_000;
const launches = new Map();

function serve() {
  const token = randomBytes(32).toString('hex');
  const clients = new Set();
  let lastActive = Date.now();
  const broadcast = value => {
    const text = `data: ${JSON.stringify(value)}\n\n`;
    for (const res of clients) res.write(text);
  };
  const helper = startHelper(broadcast);

  const server = createServer((req, res) => {
    // One bad request answers 400 or 500; it never takes the server down.
    handle(req, res).catch(error => {
      const isBad = error instanceof URIError || error instanceof SyntaxError;
      if (!res.headersSent) res.writeHead(isBad ? 400 : 500, { 'Content-Type': 'text/plain' });
      res.end(isBad ? 'bad request' : 'server error');
    });
  });

  const handle = async (req, res) => {
    lastActive = Date.now();
    const { port } = server.address();
    const self = `127.0.0.1:${port}`;
    const send = (code, body, type = 'application/json; charset=utf-8', extra = {}) => {
      res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', ...extra });
      res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
    };

    // Only this server's own pages: no other Host (DNS rebinding), no other Origin, no preflights.
    if (req.headers.host !== self) return send(403, { error: 'wrong host' });
    if (req.headers.origin !== undefined && req.headers.origin !== `http://${self}`) return send(403, { error: 'wrong origin' });
    if (req.method === 'OPTIONS') return send(403, { error: 'no cross-origin requests' });

    const url = new URL(req.url, `http://${self}`);
    const path = url.pathname;

    if (path.startsWith('/api/')) {
      const given = path === '/api/events' ? url.searchParams.get('token') : req.headers['x-learn-token'];
      if (!sameToken(given, token)) return send(401, { error: 'missing or wrong token' });

      if (path === '/api/ping') return send(200, { ok: true, pid: process.pid });

      if (path === '/api/launch' && req.method === 'POST') {
        const page = String(JSON.parse((await readBody(req)) || '{}').page || '');
        if (!/^(learn|games\/(sudoku|2048|typing|chess))\/$/.test(page)) return send(400, { error: 'no such page' });
        const nonce = randomBytes(16).toString('hex');
        launches.set(nonce, { page, until: Date.now() + LAUNCH_MS });
        return send(200, { nonce });
      }

      if (path === '/api/events' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        res.write(': hello\n\n');
        clients.add(res);
        const beat = setInterval(() => res.write(': beat\n\n'), 25_000);
        req.on('close', () => {
          clearInterval(beat);
          clients.delete(res);
          lastActive = Date.now();
        });
        return;
      }

      if (path === '/api/rpc' && req.method === 'POST') {
        let request;
        try {
          request = JSON.parse(await readBody(req));
        } catch {
          return send(400, { ok: false, error: 'the body is not JSON' });
        }
        if (!request || typeof request.cmd !== 'string') return send(400, { ok: false, error: 'no cmd' });
        delete request.rid;
        const answer = await helper.ask(request);
        return send(200, answer.ok ? { ok: true, result: answer.result } : { ok: false, error: answer.error });
      }

      const save = /^\/api\/save\/([\w-]+)$/.exec(path);
      if (save) {
        const game = save[1];
        if (!GAMES.has(game)) return send(404, { error: 'no such game' });
        const file = join(SAVES_DIR, `${game}.json`);
        if (req.method === 'GET') return send(200, existsSync(file) ? readFileSync(file, 'utf8') : 'null');
        if (req.method === 'POST') {
          let text;
          try {
            text = await readBody(req);
            JSON.parse(text);
          } catch {
            return send(400, { error: 'the body is not JSON' });
          }
          writeAtomic(file, text);
          return send(200, { ok: true });
        }
      }

      return send(404, { error: 'no such API' });
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, { error: 'GET only' });

    const launch = /^\/launch\/([0-9a-f]{32})$/.exec(path);
    if (launch) {
      const target = launches.get(launch[1]);
      launches.delete(launch[1]);
      if (!target || Date.now() > target.until) return send(403, 'This link has expired: run /learn again.', 'text/plain');
      return send(302, '', 'text/plain', { Location: `/${target.page}#token=${token}` });
    }

    const engine = /^\/engine\/([\w.-]+)$/.exec(path);
    if (engine) {
      if (!STOCKFISH[engine[1]]) return send(404, 'not found', 'text/plain');
      try {
        return send(200, await stockfishFile(engine[1]), TYPES[extname(engine[1])], { 'Cache-Control': 'max-age=86400' });
      } catch (error) {
        return send(502, String(error.message || error), 'text/plain');
      }
    }

    const data = /^\/data\/([\w.-]+)$/.exec(path);
    if (data) {
      if (!DATA_FILES.has(data[1])) return send(404, 'not found', 'text/plain');
      return send(200, readFileSync(join(WIDGET, data[1])), TYPES['.txt'], { 'Cache-Control': 'max-age=3600' });
    }

    if (path === '/') return send(302, '', 'text/plain', { Location: '/learn/' });
    let file = normalize(join(PUBLIC, decodeURIComponent(path)));
    if (file !== PUBLIC && !file.startsWith(PUBLIC + sep)) return send(403, 'no', 'text/plain');
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
    if (!existsSync(file)) return send(404, 'not found', 'text/plain');
    // Pages run only their own scripts: a link or text from a course can never run code.
    const policy = extname(file) === '.html' ? { 'Content-Security-Policy': CSP } : {};
    return send(200, readFileSync(file), TYPES[extname(file)] || 'application/octet-stream', policy);
  };

  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(WEB_FILE, JSON.stringify({ port, token, pid: process.pid }), { mode: 0o600 });
    chmodSync(WEB_FILE, 0o600);
    process.stdout.write(JSON.stringify({ event: 'listening', port }) + '\n');
  });

  // Gone after 30 minutes with no page connected and no request.
  setInterval(() => {
    if (clients.size === 0 && Date.now() - lastActive > IDLE_MS) shutdown();
  }, 60_000).unref();

  const shutdown = () => {
    helper.stop();
    try {
      const recorded = JSON.parse(readFileSync(WEB_FILE, 'utf8'));
      if (recorded.pid === process.pid) writeFileSync(WEB_FILE, '{}', { mode: 0o600 });
    } catch {
      // nothing recorded
    }
    process.exit(0);
  };
  process.on('unhandledRejection', error => process.stderr.write(`claude-panel: ${error?.stack || error}\n`));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

// --- Finding or starting it, and opening the page -----------------------------------------------

function readRecord() {
  try {
    const value = JSON.parse(readFileSync(WEB_FILE, 'utf8'));
    return typeof value.port === 'number' && typeof value.token === 'string' ? value : null;
  } catch {
    return null;
  }
}

/** A one-time /launch/<nonce> address for `page`, from the running server. */
function launchNonce(record, page) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ page });
    const req = httpRequest(
      { host: '127.0.0.1', port: record.port, path: '/api/launch', method: 'POST', timeout: 3000,
        headers: { 'X-Learn-Token': record.token, Host: `127.0.0.1:${record.port}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      res => {
        let text = '';
        res.on('data', chunk => { text += chunk; });
        res.on('end', () => {
          try {
            const { nonce } = JSON.parse(text);
            if (typeof nonce === 'string') resolve(nonce);
            else reject(new Error('the server gave no launch link'));
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('the server did not answer')));
    req.end(body);
  });
}

function ping(record) {
  return new Promise(resolve => {
    const req = httpRequest(
      { host: '127.0.0.1', port: record.port, path: '/api/ping', headers: { 'X-Learn-Token': record.token, Host: `127.0.0.1:${record.port}` }, timeout: 1500 },
      res => {
        res.resume();
        resolve(res.statusCode === 200);
      },
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

async function findOrStart() {
  const record = readRecord();
  if (record && (await ping(record))) return record;
  // Detached, so a closed Claude session doesn't take an open tab with it.
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'serve'], { detached: true, stdio: 'ignore', env: process.env });
  child.unref();
  const started = Date.now();
  while (Date.now() - started < 10_000) {
    await new Promise(resolve => setTimeout(resolve, 150));
    const fresh = readRecord();
    if (fresh && fresh.pid === child.pid && (await ping(fresh))) return fresh;
  }
  throw new Error('the Learn server did not start');
}

function browserArgv(url) {
  if (process.platform === 'darwin') return ['open', [url]];
  if (process.platform === 'win32') return ['cmd', ['/c', 'start', '', url]];
  if (process.env.WSL_DISTRO_NAME) return ['cmd.exe', ['/c', 'start', '', url]];
  return ['xdg-open', [url]];
}

// --- The native window on macOS -------------------------------------------------------------

const INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>dev.claude-panel.window</string>
  <key>CFBundleName</key><string>Claude Panel</string>
  <key>CFBundleExecutable</key><string>ClaudePanel</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSAppleEventsUsageDescription</key><string>The progress panel asks iTerm2 which window holds your Claude session, so it can sit on that window and follow it.</string>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>
`;

/**
 * The window app's binary (mac/ClaudePanel.swift), built with swiftc the first time and
 * cached by the source's hash, so an update rebuilds it. Null where it can't be built
 * (no Xcode or Command Line Tools): the browser stands in.
 */
function nativeApp() {
  if (process.platform !== 'darwin' || process.env.CLAUDE_PANEL_BROWSER === '1' || !existsSync(APP_SOURCE)) return null;
  const hash = createHash('sha256').update(readFileSync(APP_SOURCE)).update(INFO_PLIST).digest('hex').slice(0, 16);
  const bundle = join(APP_CACHE, hash, 'Claude Panel.app');
  const binary = join(bundle, 'Contents', 'MacOS', 'ClaudePanel');
  if (existsSync(binary)) return binary;
  mkdirSync(dirname(binary), { recursive: true });
  writeFileSync(join(bundle, 'Contents', 'Info.plist'), INFO_PLIST);
  const built = spawnSync('xcrun', ['swiftc', '-O', APP_SOURCE, '-o', `${binary}.tmp`], { encoding: 'utf8', timeout: 180_000 });
  if (built.status !== 0) {
    process.stderr.write(`claude-panel: couldn't build the window app, using the browser: ${(built.stderr || built.error?.message || '').slice(0, 500)}\n`);
    return null;
  }
  renameSync(`${binary}.tmp`, binary);
  return binary;
}

const WINDOW_TITLES = { learn: 'Learn', 'games/sudoku': 'Sudoku', 'games/2048': '2048', 'games/typing': 'Typing', 'games/chess': 'Chess puzzles' };

async function open(page, terminal = {}) {
  const target = page === 'learn' || page === '' ? 'learn/' : /^games\/(sudoku|2048|typing|chess)$/.test(page) ? `${page}/` : null;
  if (target === null) throw new Error(`no such page: ${page}`);
  const record = await findOrStart();
  const url = `http://127.0.0.1:${record.port}/${target}#token=${record.token}`;
  let shown = 'browser';
  if (process.env.CLAUDE_PANEL_NO_BROWSER !== '1') {
    const app = nativeApp();
    const key = page === '' ? 'learn' : page;
    if (app) {
      // Its own window: no tabs or address bar. One per page; a second open brings it forward.
      // Given the chat's terminal, the window sticks to it as the floating panel does.
      const follow = terminal.program ? ['--terminal', terminal.program, '--iterm-session', terminal.itermSession || ''] : [];
      // The token goes on stdin, never in argv: any user on the Mac can read a process's arguments.
      const window = spawn(app, ['--url', url.replace(/#.*$/, ''), '--token-stdin', '--id', key.replace('/', '-'), '--title', WINDOW_TITLES[key] || 'Learn', ...follow], { detached: true, stdio: ['pipe', 'ignore', 'ignore'] });
      window.stdin.end(`${record.token}\n`);
      window.unref();
      shown = 'window';
    } else {
      // A one-time link, so the token never sits on the browser's command line.
      const nonce = await launchNonce(record, target);
      const [command, args] = browserArgv(`http://127.0.0.1:${record.port}/launch/${nonce}`);
      spawn(command, args, { detached: true, stdio: 'ignore' }).unref();
    }
  }
  // The URL without its token: the token stays out of logs and transcripts.
  process.stdout.write(JSON.stringify({ ok: true, url: url.replace(/#.*$/, ''), port: record.port, shown }) + '\n');
}

const [mode = 'open', page = 'learn', ...rest] = process.argv.slice(2);
// `open <page> --terminal <TERM_PROGRAM> --iterm-session <id>`: the terminal a window sticks to.
const flag = name => (rest.indexOf(name) >= 0 ? rest[rest.indexOf(name) + 1] : undefined);
const terminal = { program: flag('--terminal') || process.env.TERM_PROGRAM, itermSession: flag('--iterm-session') || process.env.ITERM_SESSION_ID };
if (mode === 'serve') serve();
else if (mode === 'app-path') {
  // The plugin's floating panel on macOS runs this binary (in panel mode); null: no Swift here.
  const binary = nativeApp();
  process.stdout.write(JSON.stringify(binary ? { ok: true, binary } : { ok: false, error: 'the window app could not be built here' }) + '\n');
}
else if (mode === 'open') {
  open(page, terminal).catch(error => {
    process.stdout.write(JSON.stringify({ ok: false, error: String(error.message || error) }) + '\n');
    process.exit(1);
  });
} else {
  process.stderr.write('usage: node server.mjs open [learn | games/<sudoku|2048|typing|chess>] | serve | app-path\n');
  process.exit(2);
}
