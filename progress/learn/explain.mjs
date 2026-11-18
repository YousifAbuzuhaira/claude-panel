// An explainer: the code you're working on, explained as a playlist of clips, from a plan your
// own session writes (it has the code and what you're debugging in hand). Nothing is made until
// the plan holds: each code anchor against the file on disk, each fact from the chat against the
// chat's saved record, and every fact against both by one Claude call. What fails goes back to the
// session, which fixes the plan. Each clip is then a one-section page in memory, made by
// writeScript as any page's clip is: its guess, its openers, its masked line, the watcher and the
// claim check. Code on screen is always the lines read from disk, never text the session typed.
import { createReadStream, existsSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { findClaudeChat } from './chats.mjs';
import { markdownToBlocks } from './markdown.mjs';
import { readJson, renameRetry, withLock, writeJson } from './store.mjs';
import { norm } from './video-check.mjs';
import { writeScript } from './video-script.mjs';
import { videoEffort } from './video.mjs';

export const MAX_CLIPS = 12;
const MAX_ANCHOR_LINES = 60;
const MIN_QUOTE_WORDS = 4;
const MAX_LABEL = 22;
const AHEAD = 2; // clips made ahead of the one you're watching
const IDLE_MS = 20 * 60_000; // an explainer nobody has watched for this long stops being made

const words = text => String(text ?? '').trim().split(/\s+/).filter(Boolean);
const LANGS = { '.ts': 'ts', '.tsx': 'tsx', '.js': 'js', '.mjs': 'js', '.cjs': 'js', '.jsx': 'jsx', '.py': 'python', '.go': 'go', '.rs': 'rust', '.java': 'java', '.rb': 'ruby', '.sh': 'bash', '.sql': 'sql', '.css': 'css', '.html': 'html', '.json': 'json', '.yaml': 'yaml', '.yml': 'yaml', '.md': 'markdown', '.swift': 'swift', '.kt': 'kotlin', '.cs': 'csharp', '.php': 'php', '.ps1': 'powershell' };

/**
 * What's wrong with a plan's shape, before anything is read: Claude's session fixes these. The plan:
 * `{ title, shape, boxes, clips: [{ title, box, level, facts: [{ text, basis, quote? }],
 * anchors: [{ file, from, to, expect }], guess: { q, options, quote }, failure?, handoff?, patternOf? }] }`.
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

/** A file inside the session's folder, by the path the plan gives: never one outside it. */
export function insideFolder(cwd, file) {
  const root = realpathSync(cwd);
  const full = resolve(root, String(file));
  if (!existsSync(full)) return null;
  const real = realpathSync(full);
  const rel = relative(root, real);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) && statSync(real).isFile() ? real : null;
}

/** Each anchor's lines read from disk, and what doesn't hold: a file outside the folder, lines that aren't there, `expect` not in them. */
export function readAnchors(plan, cwd) {
  const problems = [];
  const read = new Map();
  const clips = plan.clips.map((clip, k) => ({
    ...clip,
    anchors: (clip.anchors || []).map(anchor => {
      const where = `Clip ${k + 1}, ${anchor.file}:${anchor.from}-${anchor.to}`;
      const file = insideFolder(cwd, anchor.file);
      if (!file) {
        problems.push(`${where}: no such file in this project's folder`);
        return null;
      }
      if (!read.has(file)) read.set(file, readFileSync(file, 'utf8').split(/\r?\n/));
      const lines = read.get(file);
      if (anchor.to > lines.length) {
        problems.push(`${where}: the file has ${lines.length} lines`);
        return null;
      }
      const code = lines.slice(anchor.from - 1, anchor.to).join('\n');
      if (!norm(code).includes(norm(anchor.expect))) {
        problems.push(`${where}: "${String(anchor.expect).slice(0, 60)}" is not in those lines (has the file changed?)`);
        return null;
      }
      const shown = relative(realpathSync(cwd), file).split(sep).join('/');
      return { file: shown, from: anchor.from, to: anchor.to, lang: LANGS[extname(file).toLowerCase()] || '', code };
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
      depth: null,
      at: 1,
      seenAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    },
  };
}

/** A clip as a page of one section: its facts as paragraphs, then the code it anchors, from disk. */
export function clipPage(explainer, n) {
  const clip = explainer.clips[n - 1];
  const fence = code => '`'.repeat(Math.max(3, ...(String(code).match(/`+/g) || []).map(run => run.length + 1)));
  const markdown = [
    `## ${clip.title}`,
    ...clip.facts.map(fact => fact.text),
    ...clip.anchors.map(anchor => `${fence(anchor.code)}${anchor.lang}\n${anchor.code}\n${fence(anchor.code)}`),
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

/**
 * The next clip worth making now: in the depth picked (clip 1 before a pick), and at most AHEAD
 * clips of that depth past the one watched.
 */
export function nextClip(lib, explainer, skip = new Set()) {
  const wanted = explainer.clips.map((clip, k) => k + 1).filter(n => n === 1 || inDepth(explainer.clips[n - 1], explainer.depth));
  const watching = Math.max(0, wanted.findLastIndex(n => n <= (explainer.at || 1)));
  for (let n = 1; n <= explainer.clips.length; n++) {
    if (skip.has(n) || existsSync(`${explainPaths(lib, explainer.id).clip(n)}.json`)) continue;
    if (n > 1 && !explainer.depth) return { wait: true };
    if (!wanted.includes(n)) continue;
    return wanted.indexOf(n) - watching > AHEAD ? { wait: true } : { n };
  }
  return { done: true };
}

const sleep = ms => new Promise(done => setTimeout(done, ms));

/**
 * Makes an explainer's clips in order, each a script then a recording, the next clip's script
 * written while one records, never more than AHEAD clips past the one watched. Stops when all its
 * clips in depth are made, or when nobody has watched it for IDLE_MS.
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
        const cached = readJson(`${base}.script.json`);
        if (cached) return cached;
        const script = await writeScript({ page: clipPage(explainer, n), ask, plan: clipPlan(explainer, n) });
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
  for (;;) {
    if (isStopping()) throw new Error('stopped');
    const explainer = readExplainer(lib, id);
    if (!explainer) break;
    const next = nextClip(lib, explainer);
    if (next.done) break;
    if (next.wait) {
      if (Date.now() - Date.parse(explainer.seenAt || explainer.createdAt) > IDLE_MS) break;
      save({ message: `${explainer.title}: waiting for you to watch on` });
      await sleep(poll);
      continue;
    }
    const { n } = next;
    save({ message: `${explainer.title}: clip ${n} of ${explainer.clips.length}, writing`, making: n });
    await scriptFor(explainer, n);
    // The clip after this one, written while this one records.
    const after = nextClip(lib, { ...explainer, at: Math.max(explainer.at || 1, n) }, new Set([n]));
    if (after.n) scriptFor(explainer, after.n);
    const base = explainPaths(lib, id).clip(n);
    save({ message: `${explainer.title}: clip ${n} of ${explainer.clips.length}, recording`, making: n });
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
