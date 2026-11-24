// An explainer as one file you can pass on: the player, each ready clip's script and its sound in
// a single HTML page that plays with no server, double-clicked or inside the wiki's frame. Written
// to ~/explainers/ after each clip is made (makeExplainer), or asked for (`explain export`).
// The page is the player's own index.html, its styles inline, its five modules bundled into one
// inline script (a page opened from a file can't load modules by name), and data-file.js in place
// of data.js. Nothing of the chat goes in: no session id, folder, facts or quotes.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { explainPaths, inDepth, readExplainer, updateExplainer } from './explain.mjs';
import { readSettings } from './settings.mjs';
import { readJson, writeText } from './store.mjs';

const VIDEO = new URL('../web/public/learn/video/', import.meta.url);
const SHARED = new URL('../web/public/shared/', import.meta.url);
const read = (base, name) => readFileSync(new URL(name, base), 'utf8');

/** Where exported explainers go: `LEARN_EXPORT_DIR` (scratch runs, tests), else ~/explainers. */
export const exportDir = () => process.env.LEARN_EXPORT_DIR || join(homedir(), 'explainers');

// --- The bundle ----------------------------------------------------------------------------------

// The player's modules in the order they're needed, each under the name it's imported by.
const MODULES = [
  { spec: './model.mjs', file: 'model.mjs', as: '__model' },
  { spec: './stage.js', file: 'stage.js', as: '__stage' },
  { spec: './data.js', file: 'data-file.js', as: '__data' },
  { spec: './explain.js', file: 'explain.js', as: '__explain' },
];
const IMPORT = /^import \{([^}]*)\} from '([^']+)';$/;
const EXPORT = /^export (?:async function\*? ?|function\*? ?|const |let |class )([A-Za-z_$][\w$]*)/;

/**
 * One module's source with its imports made destructures of the modules before it and its exports
 * named. Only the forms the player uses are taken (one-line named imports; `export` before a
 * function, const, let or class): anything else throws, so a new form is caught here, not in a
 * file that won't play.
 */
export function unmodule(source, file) {
  const names = [];
  if (/\bimport\s*\(|\bimport\.meta\b/.test(source)) throw new Error(`${file}: a dynamic import or import.meta can't be bundled`);
  const body = source.split('\n').map(line => {
    if (/^import\b/.test(line)) {
      const match = IMPORT.exec(line.trim());
      const from = match && MODULES.find(module => module.spec === match[2]);
      if (!from) throw new Error(`${file}: an import that can't be bundled: ${line.trim()}`);
      const parts = match[1].split(',').map(part => part.trim()).filter(Boolean).map(part => part.replace(/^(\S+)\s+as\s+(\S+)$/, '$1: $2'));
      return `const { ${parts.join(', ')} } = ${from.as};`;
    }
    if (/^export\b/.test(line)) {
      const match = EXPORT.exec(line);
      if (!match) throw new Error(`${file}: an export that can't be bundled: ${line.trim().slice(0, 80)}`);
      names.push(match[1]);
      return line.replace(/^export /, '');
    }
    return line;
  });
  return { body: body.join('\n'), names };
}

let bundled = null;
/** The player as one script: each module in its own scope, then the player's body, run per clip. */
export function playerBundle() {
  if (bundled) return bundled;
  const parts = MODULES.map(module => {
    const { body, names } = unmodule(read(VIDEO, module.file), module.file);
    return `const ${module.as} = (() => {\n${body}\nreturn { ${names.join(', ')} };\n})();`;
  });
  const player = unmodule(read(VIDEO, 'player.js'), 'player.js');
  if (player.names.length) throw new Error('player.js: exports nothing');
  const script = `${parts.join('\n')}\nasync function __player() {\n${player.body}\n}\n__data.boot(__player);\n`;
  if (/<\/script|<!--/i.test(script)) throw new Error('the player has text that would end its script tag');
  bundled = script;
  return script;
}

// --- The page ------------------------------------------------------------------------------------

const html = text => String(text).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
/** JSON safe inside a script tag: no `<`, so no `</script>` or `<!--`. */
const json = value => JSON.stringify(value).replace(/</g, '\\u003c');

/** A clip's script as the player needs it: what it reads, nothing else (no plan, stats or quotes). */
export function clipForFile(video, title) {
  const scenes = (video.scenes || []).map(({ quote, ...scene }) => scene);
  const quiz = (video.quiz || []).map(({ quote, ...q }) => q);
  return { title: video.title, courseTitle: title, stale: false, sections: video.sections, scenes, assets: video.assets, quiz, openers: video.openers || {}, words: video.words || [], audio: video.audio };
}

/** A clip's part of the page: its script and its sound, each in a tag of its own. */
export const clipTags = (clip, title) => [
  `<script type="application/json" id="clip-${clip.n}">${json(clipForFile(clip.video, title))}</script>`,
  `<script type="text/plain" id="sound-${clip.n}">${Buffer.from(clip.sound).toString('base64')}</script>`,
].join('\n');

/** How deep the page goes: the depth picked, else the deepest level made. */
export const pageDepth = (explainer, clips) => explainer.depth || Math.max(1, ...clips.map(clip => explainer.clips[clip.n - 1]?.level || 1));

/**
 * The page for an explainer. `clips` are the ones in it, `{ n, video, sound }` (sound the mp3's
 * bytes); a clip of the depth not among them is `later`, named in the list but not playable. With
 * no depth saved, the depth is the deepest level made, so the player never asks. An explainer too
 * big for one page (the wiki's, wiki.mjs) goes out as several: `parts` is the clips each holds, and
 * a `later` clip says which part it's in.
 */
export function explainerHtml({ explainer, clips, questions = false, parts = null }) {
  const inFile = new Set(clips.map(clip => clip.n));
  const depth = pageDepth(explainer, clips);
  const partOf = n => (parts ? parts.findIndex(part => part.includes(n)) + 1 : 0);
  const name = parts ? `${explainer.title} (part ${partOf(clips[0]?.n)} of ${parts.length})` : explainer.title;
  const info = {
    id: explainer.id,
    title: explainer.title,
    map: explainer.map,
    depth,
    at: 1,
    counts: [1, 2, 3].map(level => explainer.clips.filter(clip => clip.level <= level).length),
    clips: explainer.clips.map((clip, k) => ({
      n: k + 1,
      title: clip.title,
      level: clip.level,
      state: inFile.has(k + 1) ? 'ready' : inDepth(clip, depth) ? 'later' : 'left out',
      ...(!inFile.has(k + 1) && partOf(k + 1) ? { part: partOf(k + 1) } : {}),
    })),
  };
  const data = [
    `<script type="application/json" id="explainer-data">${json({ info, questions })}</script>`,
    ...clips.map(clip => clipTags(clip, explainer.title)),
  ];
  const style = `<style>\n${read(SHARED, 'theme.css')}\n${read(VIDEO, 'video.css')}\n</style>`;
  // Functions, not strings, as replacements: the script is full of `$`, which a string would expand.
  return read(VIDEO, 'index.html')
    .replace(/<title>[^<]*<\/title>/, () => `<title>${html(name)}</title>`)
    .replace(/^.*<link rel="stylesheet"[^>]*>\n/gm, '')
    .replace(/^.*<script\b[^>]*><\/script>\n/gm, '')
    .replace('</head>', () => `${style}\n</head>`)
    .replace('</body>', () => `${data.join('\n')}\n<script type="module">\n${playerBundle()}</script>\n</body>`);
}

/** The file's name: its title, then the id's last 4 characters, so two of one title never collide. */
export function exportName(explainer) {
  const slug = String(explainer.title || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '');
  return `${slug || 'explainer'}-${String(explainer.id).slice(-4)}.html`;
}

/** Every clip made so far, as a page takes it: `{ n, video, sound }`. */
export function readyClips(lib, explainer) {
  const paths = explainPaths(lib, explainer.id);
  return explainer.clips
    .map((clip, k) => k + 1)
    .filter(n => existsSync(`${paths.clip(n)}.json`) && existsSync(`${paths.clip(n)}.mp3`))
    .map(n => ({ n, video: readJson(`${paths.clip(n)}.json`), sound: readFileSync(`${paths.clip(n)}.mp3`) }))
    .filter(clip => clip.video);
}

/**
 * Writes the explainer's file with every clip made so far, over the last one (the same name, kept
 * in explainer.json as `file`). Nothing is written before a clip is ready. `{ file, clips, bytes }`.
 */
export function exportExplainer(lib, id, { dir = exportDir() } = {}) {
  const explainer = readExplainer(lib, id);
  if (!explainer) throw new Error('no such explainer');
  const clips = readyClips(lib, explainer);
  if (!clips.length) return null;
  const page = explainerHtml({ explainer, clips, questions: readSettings().videoQuestions === true });
  const file = explainer.file && dirname(explainer.file) === dir ? explainer.file : join(dir, exportName(explainer));
  writeText(file, page);
  if (explainer.file !== file) updateExplainer(lib, id, () => ({ file }));
  return { file, clips: clips.length, bytes: Buffer.byteLength(page) };
}
