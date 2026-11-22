// An explainer: the code you're working on, explained as a playlist of clips, from a plan your
// own session writes (it has the code and what you're debugging in hand). Nothing is made until
// the plan holds: each code anchor against the file on disk, each fact from the chat against the
// chat's saved record, and every fact against both by one Claude call. What fails goes back to the
// session, which fixes the plan. Each clip is then a one-section page in memory, made by
// writeScript as any page's clip is: its guess, its openers, its masked line, the watcher and the
// claim check. Code on screen is always the lines read from disk, never text the session typed.
import { createReadStream, existsSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { findClaudeChat, maskSecrets } from './chats.mjs';
import { markdownToBlocks } from './markdown.mjs';
import { readSettings } from './settings.mjs';
import { readJson, renameRetry, withLock, writeJson } from './store.mjs';
import { norm } from './video-check.mjs';
import { writeScript } from './video-script.mjs';
import { videoEffort } from './video.mjs';

export const MAX_CLIPS = 12;
const MAX_ANCHOR_LINES = 60;
const MIN_QUOTE_WORDS = 4;
const MAX_LABEL = 22;
const IDLE_MS = 20 * 60_000; // an explainer with no depth yet waits this long for the player's pick

const words = text => String(text ?? '').trim().split(/\s+/).filter(Boolean);
const LANGS = { '.ts': 'ts', '.tsx': 'tsx', '.js': 'js', '.mjs': 'js', '.cjs': 'js', '.jsx': 'jsx', '.py': 'python', '.go': 'go', '.rs': 'rust', '.java': 'java', '.rb': 'ruby', '.sh': 'bash', '.sql': 'sql', '.css': 'css', '.html': 'html', '.json': 'json', '.yaml': 'yaml', '.yml': 'yaml', '.md': 'markdown', '.swift': 'swift', '.kt': 'kotlin', '.cs': 'csharp', '.php': 'php', '.ps1': 'powershell' };

/**
 * What's wrong with a plan's shape, before anything is read: Claude's session fixes these. The plan:
 * `{ title, shape, boxes, clips: [{ title, box, level, facts: [{ text, basis, quote? }],
 * anchors: [{ file, from, to, expect }], guess: { q, options, quote }, failure?, handoff?, patternOf? }], depth? }`.
 */
export function explainProblems(plan) {
  const problems = [];
  const clips = Array.isArray(plan?.clips) ? plan.clips : [];
  if (!String(plan?.title || '').trim()) problems.push('The plan needs a title');
  if (!clips.length || clips.length > MAX_CLIPS) problems.push(`Give 1 to ${MAX_CLIPS} clips`);
  const titles = clips.map(clip => String(clip?.title || '').trim());
  if (new Set(titles).size !== titles.length || titles.some(title => !title)) problems.push('Every clip needs its own title');
  if (clips.length && clips[0]?.level !== 1) problems.push('Clip 1 is the mental model: its level is 1');
  const shape = ['flow', 'parts', 'none'].includes(plan?.shape) ? plan.shape : null;
  if (!shape) problems.push('"shape" is flow, parts or none');
  // The depth you picked in the chat (asked before the plan was handed over); left out, the player asks.
  if (plan?.depth != null && ![1, 2, 3].includes(plan.depth)) problems.push('"depth" is 1, 2 or 3, or left out');
  const boxes = Array.isArray(plan?.boxes) ? plan.boxes : [];
  if (shape && shape !== 'none') {
    const ids = new Set(boxes.map(box => box?.id));
    if (!boxes.length || boxes.filter(box => !box?.parent).length > 4) problems.push('The map has 1 to 4 top boxes');
    for (const box of boxes) {
      if (!box?.id || !String(box.label || '').trim() || String(box.label).length > MAX_LABEL || words(box.label).length > 3) problems.push(`Box "${box?.label}": an id, and a label of 1 to 3 words, at most ${MAX_LABEL} characters`);
      if (box?.parent && (!ids.has(box.parent) || boxes.find(other => other.id === box.parent)?.parent)) problems.push(`Box "${box.label}": its parent must be a top box`);
    }
    for (const clip of clips) if (!ids.has(clip?.box)) problems.push(`Clip "${clip?.title}" needs a box from the map`);
  }
  clips.forEach((clip, k) => {
    const name = `Clip ${k + 1} ("${clip?.title}")`;
    if (![1, 2, 3].includes(clip?.level)) problems.push(`${name}: its level is 1, 2 or 3`);
    const facts = Array.isArray(clip?.facts) ? clip.facts : [];
    if (!facts.length) problems.push(`${name}: it needs the facts it teaches`);
    for (const fact of facts) {
      if (!String(fact?.text || '').trim()) problems.push(`${name}: a fact has no text`);
      if (!['code', 'session'].includes(fact?.basis)) problems.push(`${name}: a fact's basis is "code" or "session"`);
      if (fact?.basis === 'session' && words(fact.quote).length < MIN_QUOTE_WORDS) problems.push(`${name}: a fact from the session needs a quote of ${MIN_QUOTE_WORDS} words or more from this chat`);
    }
    for (const anchor of Array.isArray(clip?.anchors) ? clip.anchors : []) {
      if (!anchor?.file || !Number.isInteger(anchor.from) || !Number.isInteger(anchor.to) || anchor.from < 1 || anchor.to < anchor.from) problems.push(`${name}: an anchor needs a file and lines from and to, from 1`);
      else if (anchor.to - anchor.from + 1 > MAX_ANCHOR_LINES) problems.push(`${name}: anchor ${anchor.file}:${anchor.from}-${anchor.to} is over ${MAX_ANCHOR_LINES} lines: anchor the lines that matter`);
      if (!String(anchor?.expect || '').trim()) problems.push(`${name}: anchor ${anchor?.file} needs "expect", words found in those lines`);
    }
    const options = Array.isArray(clip?.guess?.options) ? clip.guess.options : [];
    if (!String(clip?.guess?.q || '').trim() || options.length !== 3 || options.filter(option => option?.right).length !== 1 || options.some(option => !String(option?.text || '').trim() || !String(option?.why || '').trim())) problems.push(`${name}: its guess question needs 3 options with a why each, one right`);
    if (words(clip?.guess?.quote).length < MIN_QUOTE_WORDS) problems.push(`${name}: its guess needs "quote", words of its facts or code that state the answer`);
    for (const n of clip?.failure || []) if (!Number.isInteger(n) || !facts[n]) problems.push(`${name}: "failure" lists fact numbers, from 0`);
    if (clip?.patternOf && !titles.slice(0, k).includes(String(clip.patternOf).trim())) problems.push(`${name}: "patternOf" names an earlier clip`);
  });
  return problems;
}

// Files Learn never reads for an explainer, whatever the plan says: keys, tokens, credentials.
const SECRET_DIRS = ['.ssh', '.aws', '.gnupg', '.kube', '.docker', '.azure', '.password-store', '.config/gh', '.config/gcloud'];
const SECRET_NAMES = /^(\.netrc|_netrc|\.npmrc|\.pypirc|\.pgpass|\.git-credentials|\.htpasswd|\.claude\.json|\.credentials\.json|id_(rsa|dsa|ecdsa|ed25519)(\..*)?|\.?credentials?(\.(json|ya?ml|toml|ini|txt|xml|csv))?|.*_credentials\.json|secrets?\.(json|ya?ml|toml|env))$/;
const SECRET_EXTS = new Set(['.pem', '.key', '.p12', '.pfx', '.jks', '.keystore', '.kdbx', '.ovpn', '.tfvars', '.tfstate']);

/** Whether a path looks like it holds a secret: by its folders, its name or its extension. */
export function looksSecret(path) {
  const parts = String(path ?? '').replace(/\\/g, '/').toLowerCase().split('/').filter(Boolean);
  const name = parts.at(-1) || '';
  const joined = `/${parts.join('/')}/`;
  if (SECRET_DIRS.some(dir => joined.includes(`/${dir}/`))) return true;
  if (/^\.env(\..+)?$/.test(name) && !/\.(example|sample|template)$/.test(name)) return true;
  return SECRET_NAMES.test(name) || SECRET_EXTS.has(extname(name));
}

/**
 * The file an anchor names, by a path relative to the session's folder, a full path or a ~/ path:
 * `{ real, shown }`, or `{ error }` (missing, outside, secret). It must be a file inside the folder
 * or under the home folder, after links are followed, and never one that looks like a secret.
 * `shown` is relative inside the folder, `~/...` elsewhere.
 */
export function anchorFile(cwd, file, { home = homedir() } = {}) {
  const given = String(file ?? '').trim();
  if (!given) return { error: 'missing' };
  const root = realpathSync(cwd);
  const homeReal = existsSync(home) ? realpathSync(home) : resolve(home);
  const expanded = /^~(?=$|[\\/])/.test(given) ? join(home, given.slice(1)) : given;
  const full = resolve(root, expanded);
  if (looksSecret(given) || looksSecret(full)) return { error: 'secret' };
  if (!existsSync(full)) return { error: 'missing' };
  const real = realpathSync(full);
  const inside = base => {
    const rel = relative(base, real);
    return Boolean(rel) && rel.split(sep)[0] !== '..' && !isAbsolute(rel);
  };
  if (!(inside(root) || inside(homeReal)) || !statSync(real).isFile()) return { error: 'outside' };
  if (looksSecret(real)) return { error: 'secret' }; // a link to one
  const shown = inside(root) ? relative(root, real).split(sep).join('/') : `~/${relative(homeReal, real).split(sep).join('/')}`;
  return { real, shown };
}

const ANCHOR_ERRORS = {
  missing: 'no such file',
  outside: 'not a file in this project or under your home folder',
  secret: "Learn doesn't read files that look like secrets",
};

/**
 * Each anchor's lines read from disk, and what doesn't hold: a file it may not read, lines that
 * aren't there, `expect` not in them. What looks like a secret inside the lines is hidden before
 * they go anywhere (the check, the clip, the screen).
 */
export function readAnchors(plan, cwd, { home = homedir() } = {}) {
  const problems = [];
  const read = new Map();
  const clips = plan.clips.map((clip, k) => ({
    ...clip,
    anchors: (clip.anchors || []).map(anchor => {
      const where = `Clip ${k + 1}, ${anchor.file}:${anchor.from}-${anchor.to}`;
      const found = anchorFile(cwd, anchor.file, { home });
      if (found.error) {
        problems.push(`${where}: ${ANCHOR_ERRORS[found.error]}`);
        return null;
      }
      if (!read.has(found.real)) read.set(found.real, readFileSync(found.real, 'utf8').split(/\r?\n/));
      const lines = read.get(found.real);
      if (anchor.to > lines.length) {
        problems.push(`${where}: the file has ${lines.length} lines`);
        return null;
      }
      const code = lines.slice(anchor.from - 1, anchor.to).join('\n');
      if (!norm(code).includes(norm(anchor.expect))) {
        problems.push(`${where}: "${String(anchor.expect).slice(0, 60)}" is not in those lines (has the file changed?)`);
        return null;
      }
      return { file: found.shown, from: anchor.from, to: anchor.to, lang: LANGS[extname(found.real).toLowerCase()] || '', code: maskSecrets(code) };
    }).filter(Boolean),
  }));
  return { problems, clips };
}

/**
 * The text of one message of a chat's record: what was said and what tools returned. Never what a
 * tool was asked to do: a session could write any sentence into a command and then quote it.
 */
function messageText(record) {
  const content = record?.message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(block => {
    if (!block) return '';
    if (block.type === 'text') return block.text || '';
    if (block.type === 'tool_result') return typeof block.content === 'string' ? block.content : Array.isArray(block.content) ? block.content.map(part => part?.text || '').join(' ') : '';
    return '';
  }).join(' ');
}

/** Which quotes are word for word in one message of the chat's saved record (read a line at a time). */
export async function quotesInChat(sessionId, quotes, options = {}) {
  const wanted = new Map(quotes.map(quote => [norm(quote), quote]).filter(([key]) => key));
  const found = new Set();
  if (!wanted.size) return found;
  const { file } = findClaudeChat(sessionId, options);
  const lines = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line || found.size === wanted.size) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (record.type !== 'user' && record.type !== 'assistant') continue;
    const text = ` ${norm(messageText(record))} `;
    for (const [key, quote] of wanted) if (!found.has(quote) && text.includes(` ${key} `)) found.add(quote);
  }
  return found;
}

export const EXPLAIN_CHECK_SCHEMA = {
  type: 'object',
  properties: {
    wrong: { type: 'array', items: { type: 'object', properties: { clip: { type: 'integer' }, fact: { type: 'integer' }, why: { type: 'string' } }, required: ['clip', 'fact', 'why'] } },
  },
  required: ['wrong'],
};

/** The one Claude check: every fact against the code it anchors and the chat lines it quotes. */
export function explainCheckPrompt(clips) {
  return [
    'A coding session wrote the facts below to explain some code, as short video clips. Under each clip are the exact lines of code it shows and the words of the chat its other facts quote. Check each fact against them, using no outside knowledge.',
    'In "wrong", list each fact that the code or the quoted chat contradicts, or that states something specific (a value, a name, a behaviour, a cause) that neither supports. Facts may draw on any clip\'s code. Plain explanation of what a line visibly does is supported. Give the clip and fact numbers, from 0, and why in one sentence. Most plans have none.',
    '',
    ...clips.flatMap((clip, k) => [
      `## CLIP ${k}: ${clip.title}`,
      ...clip.facts.map((fact, f) => `[fact ${f}] (${fact.basis}) ${fact.text}${fact.quote ? `\n  quoting the chat: "${fact.quote}"` : ''}`),
      ...clip.anchors.map(anchor => `CODE ${anchor.file}:${anchor.from}-${anchor.to}:\n${anchor.code}`),
      '',
    ]),
  ].join('\n');
}

/**
 * Checks a plan, all of it: the shape, the files, the chat, then Claude. `{ problems }` to send back
 * to the session, or `{ explainer }` ready to save. `io.askStructured` is the one Claude call.
 */
export async function checkExplainer({ plan, sessionId, cwd, io, model = 'opus', chats = {} }) {
  const shape = explainProblems(plan);
  if (shape.length) return { problems: shape };
  const { problems, clips } = readAnchors(plan, cwd);
  const quotes = clips.flatMap(clip => clip.facts.filter(fact => fact.basis === 'session').map(fact => fact.quote));
  const found = quotes.length ? await quotesInChat(sessionId, quotes, chats) : new Set();
  clips.forEach((clip, k) => clip.facts.forEach(fact => {
    if (fact.basis === 'session' && !found.has(fact.quote)) problems.push(`Clip ${k + 1}: "${String(fact.quote).slice(0, 70)}" is not word for word in this chat`);
  }));
  // The guess's answer must be stated where the clip shows it: its facts or its code.
  clips.forEach((clip, k) => {
    const said = norm([...clip.facts.map(fact => fact.text), ...clip.anchors.map(anchor => anchor.code)].join(' '));
    if (!said.includes(norm(clip.guess.quote))) problems.push(`Clip ${k + 1}: the guess's quote is not word for word from its facts or code`);
  });
  if (problems.length) return { problems };
  const checked = await io.askStructured({ prompt: explainCheckPrompt(clips), schema: EXPLAIN_CHECK_SCHEMA, tools: [], model, effort: videoEffort(model) });
  const wrong = (checked?.wrong || []).filter(item => clips[item.clip]?.facts[item.fact]);
  if (wrong.length) return { problems: wrong.map(item => `Clip ${item.clip + 1}, fact ${item.fact} ("${String(clips[item.clip].facts[item.fact].text).slice(0, 80)}"): ${item.why}`) };
  const tidy = text => String(text).replace(/\s+/g, ' ').trim();
  return {
    explainer: {
      v: 1,
      title: tidy(plan.title),
      session: sessionId,
      cwd: realpathSync(cwd),
      map: {
        shape: plan.shape,
        boxes: plan.shape === 'none' ? [] : plan.boxes.map(box => ({ id: String(box.id), label: tidy(box.label), parent: box.parent || null })),
        clips: clips.map((clip, k) => ({ clip: tidy(clip.title), box: plan.shape === 'none' ? null : clip.box, handoff: plan.shape === 'flow' && k && clip.handoff && words(clip.handoff).length <= 8 ? tidy(clip.handoff) : null })),
      },
      clips: clips.map(clip => ({
        title: tidy(clip.title),
        level: clip.level,
        facts: clip.facts.map(fact => ({ text: tidy(fact.text), basis: fact.basis, ...(fact.quote ? { quote: fact.quote } : {}) })),
        anchors: clip.anchors,
        guess: { q: tidy(clip.guess.q), options: clip.guess.options.map(option => ({ text: tidy(option.text), why: tidy(option.why), right: Boolean(option.right) })), quote: clip.guess.quote },
        failure: (clip.failure || []).filter(Number.isInteger),
        patternOf: clip.patternOf ? tidy(clip.patternOf) : null,
      })),
      depth: [1, 2, 3].includes(plan.depth) ? plan.depth : null,
      at: 1,
      seenAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    },
  };
}

/** Code past this many lines is shown in parts: more never fits the stage at a readable size. */
export const PART_LINES = 18;

/** An anchor's code in parts of at most PART_LINES lines, all the same size but the last (40 lines: 14, 14, 12). */
export function codeParts(code) {
  const lines = String(code).split('\n');
  const count = Math.ceil(lines.length / PART_LINES);
  const size = Math.ceil(lines.length / count);
  return Array.from({ length: count }, (_, k) => lines.slice(k * size, (k + 1) * size).join('\n')).filter(Boolean);
}

/** A clip as a page of one section: its facts as paragraphs, then the code it anchors, from disk. */
export function clipPage(explainer, n) {
  const clip = explainer.clips[n - 1];
  const fence = code => '`'.repeat(Math.max(3, ...(String(code).match(/`+/g) || []).map(run => run.length + 1)));
  const markdown = [
    `## ${clip.title}`,
    ...clip.facts.map(fact => fact.text),
    ...clip.anchors.flatMap(anchor => codeParts(anchor.code).map(code => `${fence(code)}${anchor.lang}\n${code}\n${fence(code)}`)),
  ].join('\n\n');
  return { v: 1, n, title: clip.title, markdown, blocks: markdownToBlocks(markdown), terms: [], checks: [], outcomes: [], subtopics: clip.facts.map(fact => fact.text), stats: {} };
}

/**
 * The plan writeScript follows for a clip: no map of its own (the player draws the explainer's), its
 * guess, its failures, and a masked line where its code allows one. A clip repeating an earlier
 * clip's pattern is told so in its facts' order only: each clip is made on its own.
 */
export function clipPlan(explainer, n) {
  const clip = explainer.clips[n - 1];
  return {
    shape: 'none',
    boxes: [],
    clips: [{ clip: clip.title, box: null, handoff: null, handoffQuote: null, guess: clip.guess, trap: clip.failure, mask: true, patternOf: null, patternQuote: null }],
    splits: [],
    groups: [],
  };
}

// --- Storing and making -----------------------------------------------------------------------

export const explainPaths = (lib, id) => {
  const dir = join(lib.root, 'explainers', String(id).replace(/[^a-z0-9-]/gi, ''));
  return { dir, file: join(dir, 'explainer.json'), clip: n => join(dir, 'clips', String(n).padStart(2, '0')) };
};

export const readExplainer = (lib, id) => readJson(explainPaths(lib, id).file);

export function saveExplainer(lib, explainer) {
  const id = explainer.id || `x${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12)}${randomBytes(2).toString('hex')}`;
  const next = { ...explainer, id };
  withLock(lib.root, () => writeJson(explainPaths(lib, id).file, next));
  return next;
}

/** Changes an explainer under the library's lock, so the player and the job never write over each other. */
export function updateExplainer(lib, id, change) {
  return withLock(lib.root, () => {
    const now = readExplainer(lib, id);
    if (!now) throw new Error('no such explainer');
    const next = { ...now, ...change(now) };
    writeJson(explainPaths(lib, id).file, next);
    return next;
  });
}

/** The levels a depth takes in: 1 is the mental model, 2 adds the mechanism and its code, 3 is all. */
export const inDepth = (clip, depth) => clip.level <= (depth || 1);

/** Each clip's state: `ready`, `making`, `waiting`, or `left out` by the depth picked. */
export function explainInfo(lib, explainer, making = null) {
  const paths = explainPaths(lib, explainer.id);
  return {
    id: explainer.id,
    title: explainer.title,
    map: explainer.map,
    depth: explainer.depth,
    at: explainer.at,
    counts: [1, 2, 3].map(depth => explainer.clips.filter(clip => clip.level <= depth).length),
    clips: explainer.clips.map((clip, k) => ({
      n: k + 1,
      title: clip.title,
      level: clip.level,
      guess: { q: clip.guess.q, options: clip.guess.options.map(option => ({ text: option.text })) },
      state: existsSync(`${paths.clip(k + 1)}.json`) ? 'ready' : making === k + 1 ? 'making' : explainer.depth && !inDepth(clip, explainer.depth) ? 'left out' : 'waiting',
    })),
  };
}

/** The clips an explainer makes: those in the depth picked, or all of them before a pick. */
export const wantedClips = explainer => explainer.clips.filter(clip => !explainer.depth || inDepth(clip, explainer.depth)).length;

/**
 * Every explainer in the library, newest first, for the Library's list: `state` is `making` (a job
 * is on it), `ready` (every clip in depth is made) or `waiting` (opening it carries on).
 */
export function listExplainers(lib, jobs = []) {
  const dir = join(lib.root, 'explainers');
  if (!existsSync(dir)) return [];
  const making = new Set(jobs.filter(job => job.kind === 'explain' && job.state === 'running').map(job => job.explain));
  return readdirSync(dir)
    .filter(id => /^x[0-9a-f]{12,20}$/.test(id))
    .map(id => readExplainer(lib, id))
    .filter(explainer => explainer?.id && Array.isArray(explainer.clips))
    .map(explainer => {
      const info = explainInfo(lib, explainer);
      const ready = info.clips.filter(clip => clip.state === 'ready').length;
      const clips = wantedClips(explainer);
      return {
        id: explainer.id,
        title: explainer.title,
        createdAt: explainer.createdAt,
        at: explainer.at || 1,
        depth: explainer.depth,
        clips,
        ready,
        state: making.has(explainer.id) ? 'making' : ready >= clips ? 'ready' : 'waiting',
      };
    })
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

/** Clips made of the clips wanted: the bar on the panel, and the chat's notices. */
export const clipCounts = (lib, explainer) => ({
  done: explainer.clips.filter((clip, k) => existsSync(`${explainPaths(lib, explainer.id).clip(k + 1)}.json`)).length,
  total: wantedClips(explainer),
});

/**
 * The next clip to make: with a depth picked, every clip in it, the one being watched (and those
 * after it) first; with none yet, clip 1, then a wait for the player's pick. `skip` counts as made.
 */
export function nextClip(lib, explainer, skip = new Set()) {
  const made = n => skip.has(n) || existsSync(`${explainPaths(lib, explainer.id).clip(n)}.json`);
  const all = explainer.clips.map((clip, k) => k + 1);
  if (!explainer.depth) {
    if (!made(1)) return { n: 1 };
    return all.some(n => !made(n)) ? { wait: true } : { done: true };
  }
  const missing = all.filter(n => (n === 1 || inDepth(explainer.clips[n - 1], explainer.depth)) && !made(n));
  if (!missing.length) return { done: true };
  return { n: missing.find(n => n >= (explainer.at || 1)) ?? missing[0] };
}

const sleep = ms => new Promise(done => setTimeout(done, ms));

/**
 * Makes an explainer's clips in order, each a script then a recording, the next clip's script
 * written while one records. Stops when all its clips in depth are made; one with no depth yet
 * stops after clip 1 when nobody picks one for IDLE_MS.
 */
export async function makeExplainer({ lib, io, id, save, isStopping, poll = 3000 }) {
  const model = lib.settings.models.video;
  const effort = videoEffort(model);
  const ask = async (prompt, schema) => {
    const call = () => io.askStructured({ prompt, schema, tools: [], model, effort, cwd: lib.root });
    try {
      return await call();
    } catch (error) {
      if (isStopping()) throw error;
      return call();
    }
  };
  const scripts = new Map();
  const scriptFor = (explainer, n) => {
    if (!scripts.has(n)) {
      const base = explainPaths(lib, id).clip(n);
      const writing = (async () => {
        // Learn's Questions setting, read for each clip: turned on while clip 1 plays, clip 3 has them.
        const questions = readSettings().videoQuestions;
        const cached = readJson(`${base}.script.json`);
        if (cached && (cached.withQuestions ?? true) === questions) return cached;
        const script = await writeScript({ page: clipPage(explainer, n), ask, plan: clipPlan(explainer, n), questions });
        Object.assign(script, { model, effort, explainer: id, clip: n });
        writeJson(`${base}.script.json`, script);
        return script;
      })();
      writing.catch(() => {});
      scripts.set(n, writing);
    }
    return scripts.get(n);
  };
  let made = 0;
  const counts = explainer => clipCounts(lib, explainer);
  for (;;) {
    if (isStopping()) throw new Error('stopped');
    const explainer = readExplainer(lib, id);
    if (!explainer) break;
    const next = nextClip(lib, explainer);
    if (next.done) break;
    if (next.wait) {
      if (Date.now() - Date.parse(explainer.seenAt || explainer.createdAt) > IDLE_MS) break;
      save({ message: `${explainer.title}: waiting for you to pick how deep`, ...counts(explainer) });
      await sleep(poll);
      continue;
    }
    const { n } = next;
    save({ message: `${explainer.title}: clip ${n} of ${explainer.clips.length}, writing`, making: n, ...counts(explainer) });
    await scriptFor(explainer, n);
    // The clip after this one, written while this one records.
    const after = nextClip(lib, { ...explainer, at: Math.max(explainer.at || 1, n) }, new Set([n]));
    if (after.n) scriptFor(explainer, after.n);
    const base = explainPaths(lib, id).clip(n);
    save({ message: `${explainer.title}: clip ${n} of ${explainer.clips.length}, recording`, making: n, ...counts(explainer) });
    try {
      await io.record({ scriptFile: `${base}.script.json`, out: `${base}.new` });
      renameRetry(`${base}.new.mp3`, `${base}.mp3`);
      renameRetry(`${base}.new.json`, `${base}.json`);
      made++;
    } catch (error) {
      for (const end of ['.new.mp3', '.new.json', '.new.mp3.tmp', '.new.json.tmp']) rmSync(`${base}${end}`, { force: true });
      throw error;
    }
  }
  await Promise.allSettled(scripts.values());
  return made;
}
