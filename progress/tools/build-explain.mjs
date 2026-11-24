#!/usr/bin/env node
// Builds the explain plugin (its own repo, for people who want /explain without the rest) from
// this one: a fixed list of the progress plugin's files, byte for byte, plus explain-src/.
//
//   node progress/tools/build-explain.mjs [--out DIR]           writes it (default ~/.claude/explain-plugin)
//   node progress/tools/build-explain.mjs --check [--out DIR]   fails if that copy is stale, or not built
//   node progress/tools/build-explain.mjs --list                says what goes in, and writes nothing
//
// Refused: an import or file reference that leads outside the list, a listed module nothing
// reaches, a course module in the list, and files changed since the last build under the same
// version (an installed plugin is cached by its version, so nobody would get them).
// It only ever writes inside DIR, and only over files it wrote itself: never .git, never a folder
// that has files it doesn't know and no build.json.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// From progress/, kept at the same paths, so their own relative references still hold.
export const FILES = [
  ...['chats', 'claude', 'deps', 'diagram', 'explain', 'explain-cli', 'explain-job', 'export', 'jobs', 'markdown', 'reader', 'settings', 'status', 'store', 'video-check', 'video-plan', 'video-script', 'voice'].map(name => `learn/${name}.mjs`),
  'learn/learn.sh',
  'learn/voice/narrate.py', 'learn/voice/requirements.in', 'learn/voice/requirements.lock', 'learn/voice/requirements.win.lock',
  ...['index.html', 'video.css', 'player.js', 'explain.js', 'stage.js', 'model.mjs', 'data.js', 'data-file.js'].map(name => `web/public/learn/video/${name}`),
  'web/public/shared/api.js', 'web/public/shared/theme.css',
  'hooks/explain.ts', 'hooks/learn.ts',
];
// From explain-src/, the plugin's own.
export const OWN = ['.claude-plugin/plugin.json', 'hooks/hooks.json', 'hooks/register.tsx'];
export const OWN_TESTS = 'tests';
// Where code starts: everything else in the list must be reached from here.
export const ENTRIES = ['hooks/register.tsx', 'learn/explain-cli.mjs'];
// Courses, the Learn server and Review: none of it belongs in this plugin.
export const FORBIDDEN = ['build', 'catalogue', 'chat', 'coverage', 'documents', 'learn', 'library', 'overlap', 'prompts', 'review', 'serve', 'shape', 'sources', 'teach', 'terms', 'verify', 'video'].map(name => `learn/${name}.mjs`);
const PACKAGES = new Set(['claude-code']); // types only, erased when the engine loads the hooks
const CODE = /\.(?:mjs|js|ts|tsx)$/;

const sha256 = data => createHash('sha256').update(data).digest('hex');

/** What a source file refers to: what it imports, and the files and folders it names by URL. */
export function references(source) {
  const imports = [];
  const urls = [];
  // Comments go first (whole lines and blocks): words like "from './x'" in one aren't imports.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const match of code.matchAll(/^\s*(?:import|export)\b[^'";]*?\bfrom\s*['"]([^'"]+)['"]/gm)) imports.push(match[1]);
  for (const match of code.matchAll(/^\s*import\s*['"]([^'"]+)['"]/gm)) imports.push(match[1]);
  for (const match of code.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) imports.push(match[1]);
  // new URL('./x', import.meta.url), and new URL(cond ? './x' : './y', import.meta.url).
  for (const match of code.matchAll(/new URL\(([^()]*?),\s*import\.meta\.url\s*\)/g)) for (const item of match[1].matchAll(/['"](\.{1,2}\/[^'"]*)['"]/g)) urls.push(item[1]);
  return { imports, urls };
}

/** Where an import leads inside the plugin, or null for a package or a built-in. Throws when nowhere. */
export function resolveIn(files, from, spec) {
  if (spec.startsWith('node:')) return null;
  if (!spec.startsWith('.')) {
    if (PACKAGES.has(spec)) return null;
    throw new Error(`${from}: imports ${spec}, a package the plugin doesn't carry`);
  }
  const target = posix.normalize(posix.join(posix.dirname(from), spec));
  const found = [target, `${target}.ts`, `${target}.tsx`, `${target}.mjs`, `${target}.js`].find(path => files.has(path));
  if (!found) throw new Error(`${from}: ${spec} is outside the plugin (${target})`);
  return found;
}

/** Every problem with a set of files (path → bytes): references that lead out, unreached code, course modules. */
export function problemsOf(files) {
  const problems = [];
  for (const path of files.keys()) if (FORBIDDEN.includes(path)) problems.push(`${path}: a course module, which this plugin doesn't carry`);
  const reached = new Set();
  const visit = path => {
    if (reached.has(path)) return;
    reached.add(path);
    if (!CODE.test(path)) return;
    const { imports, urls } = references(files.get(path).toString('utf8'));
    for (const spec of imports) {
      try {
        const next = resolveIn(files, path, spec);
        if (next) visit(next);
      } catch (error) {
        problems.push(error.message);
      }
    }
    for (const url of urls) {
      const target = posix.normalize(posix.join(posix.dirname(path), url));
      // A folder named by URL: what's in the list under it is read from it by name (export.mjs).
      const inside = url.endsWith('/') ? [...files.keys()].filter(name => name.startsWith(target)) : files.has(target) ? [target] : [];
      if (!inside.length) problems.push(`${path}: ${url} is outside the plugin (${target})`);
      inside.forEach(visit);
    }
  };
  for (const entry of ENTRIES) {
    if (files.has(entry)) visit(entry);
    else problems.push(`${entry}: missing`);
  }
  // Tests reach what they test; they ship with the plugin, as the progress plugin's do.
  for (const path of files.keys()) if (CODE.test(path) && !path.startsWith(`${OWN_TESTS}/`) && !reached.has(path)) problems.push(`${path}: nothing in the plugin uses it`);
  return problems;
}

/** The plugin's files, path → bytes, as they are in this repo. */
export function pluginFiles(repo = REPO) {
  const files = new Map();
  for (const path of FILES) files.set(path, readFileSync(join(repo, 'progress', path)));
  for (const path of OWN) files.set(path, readFileSync(join(repo, 'explain-src', path)));
  const tests = join(repo, 'explain-src', OWN_TESTS);
  for (const name of existsSync(tests) ? readdirSync(tests).sort() : []) if (statSync(join(tests, name)).isFile()) files.set(`${OWN_TESTS}/${name}`, readFileSync(join(tests, name)));
  // As the engine lays it out: it writes .claude-plugin/types when it first loads the plugin.
  files.set('tsconfig.json', Buffer.from('{\n  "extends": "./.claude-plugin/types/tsconfig.json"\n}\n'));
  return files;
}

/** Everything in the built repo, path → bytes: the marketplace, the README, the plugin in explain/ and its build.json. */
export function builtRepo(repo = REPO) {
  const files = pluginFiles(repo);
  const manifest = JSON.parse(files.get('.claude-plugin/plugin.json').toString('utf8'));
  const hashes = Object.fromEntries([...files].sort(([a], [b]) => a.localeCompare(b)).map(([path, data]) => [path, sha256(data)]));
  const out = new Map([...files].map(([path, data]) => [`explain/${path}`, data]));
  out.set('explain/build.json', Buffer.from(`${JSON.stringify({ version: manifest.version, files: hashes }, null, 2)}\n`));
  out.set('.claude-plugin/marketplace.json', Buffer.from(`${JSON.stringify({ name: 'claude-explain', description: 'Explains the code you are working on as short narrated video clips, made on your own computer.', owner: manifest.author, plugins: [{ name: manifest.name, source: './explain', description: manifest.description }] }, null, 2)}\n`));
  out.set('README.md', readFileSync(join(repo, 'explain-src', 'README.md')));
  out.set('.gitignore', Buffer.from('*.log\n*.tmp\n*.tmp-*\n.DS_Store\nexplain/.claude-plugin/types/\n'));
  return { version: manifest.version, hashes, files: out };
}

/** The last build's record in a built repo, or null. */
export function lastBuild(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, 'explain/build.json'), 'utf8'));
  } catch {
    return null;
  }
}

/** The files changed between two builds' hashes. */
export const changedFiles = (before, after) => [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(path => before[path] !== after[path]).sort();

/** Files under a built repo, except .git and what the engine writes when it loads the plugin. */
function filesUnder(dir, base = dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = join(dir, entry.name);
    const path = relative(base, full).split(sep).join('/');
    if (path === '.git' || path === 'explain/.claude-plugin/types') return [];
    return entry.isDirectory() ? filesUnder(full, base) : [path];
  });
}

/** What's stale in a built repo, as lines; empty when it's this repo's build exactly. */
export function staleIn(dir, built) {
  if (!lastBuild(dir)) return [`${dir} holds no build`];
  const there = new Set(filesUnder(dir));
  return [
    ...[...built.files].filter(([path, data]) => !there.has(path) || !readFileSync(join(dir, path)).equals(data)).map(([path]) => `${path}: differs or missing`),
    ...[...there].filter(path => !built.files.has(path)).map(path => `${path}: not part of the plugin`),
  ];
}

/** Changed files under an unchanged version: an installed copy is cached by version, so nobody would get them. */
export function versionProblem(dir, built) {
  const before = lastBuild(dir);
  if (!before || before.version !== built.version) return null;
  const changed = changedFiles(before.files, built.hashes);
  return changed.length ? `files changed since ${before.version} was built (${changed.slice(0, 5).join(', ')}${changed.length > 5 ? ', …' : ''}): bump explain-src/.claude-plugin/plugin.json` : null;
}

/** Writes the built repo: only its own files, only in an empty folder or one it built (or a bare git repo). */
export function writeBuild(dir, built) {
  const there = filesUnder(dir);
  if (there.length && !lastBuild(dir)) throw new Error(`${dir} has files of its own (${there.slice(0, 3).join(', ')}): give --out an empty folder`);
  for (const path of there) if (!built.files.has(path) && path.startsWith('explain/')) rmSync(join(dir, path));
  for (const [path, data] of built.files) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), data);
  }
}

function main(args) {
  const at = args.indexOf('--out');
  const out = resolve(at >= 0 && args[at + 1] ? args[at + 1] : join(homedir(), '.claude/explain-plugin'));
  const problems = problemsOf(pluginFiles());
  if (problems.length) {
    console.error(`explain plugin: ${problems.length} problem${problems.length === 1 ? '' : 's'}\n${problems.map(item => `- ${item}`).join('\n')}`);
    return 1;
  }
  const built = builtRepo();
  if (args.includes('--list')) {
    console.log([...built.files].map(([path, data]) => `${String(data.length).padStart(8)}  ${path}`).join('\n'));
    return 0;
  }
  const bump = versionProblem(out, built);
  if (args.includes('--check')) {
    const stale = staleIn(out, built);
    if (bump) stale.unshift(bump);
    if (stale.length) {
      console.error(`explain plugin: stale\n${stale.slice(0, 20).map(item => `- ${item}`).join('\n')}`);
      return 1;
    }
    console.log(`explain plugin: ok (${built.version}, ${built.files.size} files, ${out})`);
    return 0;
  }
  if (bump) {
    console.error(`explain plugin: ${bump}`);
    return 1;
  }
  writeBuild(out, built);
  console.log(`explain plugin: built ${built.version} (${built.files.size} files) in ${out}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)));
