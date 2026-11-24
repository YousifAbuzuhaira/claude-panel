// The explain plugin's build (tools/build-explain.mjs): what goes in stays inside it, nothing of
// courses gets in, a stale copy is caught, and the output folder's own files are never touched.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FORBIDDEN, builtRepo, changedFiles, lastBuild, pluginFiles, problemsOf, references, staleIn, versionProblem, writeBuild } from '../../tools/build-explain.mjs';

const root = mkdtempSync(join(tmpdir(), 'build-explain-'));
after(() => rmSync(root, { recursive: true, force: true }));
const folder = name => { const dir = join(root, name); mkdirSync(dir, { recursive: true }); return dir; };
const planted = change => { const files = pluginFiles(); change(files); return problemsOf(files); };
const append = (files, path, text) => files.set(path, Buffer.from(`${files.get(path).toString('utf8')}\n${text}\n`));

test('the plugin as it is: every import and file it names is inside it, and every module in it is used', () => {
  assert.deepEqual(problemsOf(pluginFiles()), []);
  for (const path of FORBIDDEN) assert.equal(pluginFiles().has(path), false, path);
});

test('references are read from code, never from a comment', () => {
  const { imports, urls } = references("// import { a } from './no.mjs'\n/* import './nor-this.mjs' */\nimport { a,\n  b } from './yes.mjs';\nexport { c } from './too.mjs';\nconst m = import('./lazy.mjs');\nnew URL('./file.py', import.meta.url);\nnew URL(W ? './w.lock' : './u.lock', import.meta.url);");
  assert.deepEqual(imports.sort(), ['./lazy.mjs', './too.mjs', './yes.mjs']);
  assert.deepEqual(urls, ['./file.py', './w.lock', './u.lock']);
});

test('what leads outside, what nothing uses, and what belongs to courses are all refused', () => {
  const cases = [
    ['an import of a course module', files => append(files, 'learn/explain.mjs', "import { x } from './library.mjs';")],
    ['a multi-line import leading out', files => append(files, 'learn/voice.mjs', "import {\n  a,\n} from './build.mjs';")],
    ['a re-export leading out', files => append(files, 'learn/store.mjs', "export { y } from './catalogue.mjs';")],
    ['a dynamic import leading out', files => append(files, 'learn/store.mjs', "const m = () => import('./serve.mjs');")],
    ['an npm package', files => append(files, 'learn/store.mjs', "import z from 'zod';")],
    ['a file named by URL that is not shipped', files => append(files, 'learn/voice.mjs', "new URL('./voice/gone.py', import.meta.url);")],
    ['a course module in the list', files => files.set('learn/library.mjs', Buffer.from(''))],
    ['a module nothing uses', files => files.set('learn/extra.mjs', Buffer.from('export const a = 1;'))],
    ['a dropped voice file', files => files.delete('learn/voice/narrate.py')],
    ['a dropped entry', files => files.delete('hooks/register.tsx')],
  ];
  for (const [label, change] of cases) assert.ok(planted(change).length, label);
});

test('a build is written whole, and its own check passes', () => {
  const dir = folder('fresh');
  const built = builtRepo();
  writeBuild(dir, built);
  assert.deepEqual(staleIn(dir, built), []);
  assert.equal(lastBuild(dir).version, built.version);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, '.claude-plugin/marketplace.json'), 'utf8')).plugins.map(p => [p.name, p.source]), [['explain', './explain']]);
  assert.ok(existsSync(join(dir, 'README.md')));
});

test("the check catches a stale copy, a file missing, and a file that isn't the plugin's; git's own files don't count", () => {
  const dir = folder('stale');
  const built = builtRepo();
  writeBuild(dir, built);
  mkdirSync(join(dir, '.git'));
  writeFileSync(join(dir, '.git/HEAD'), 'ref');
  mkdirSync(join(dir, 'explain/.claude-plugin/types'), { recursive: true });
  writeFileSync(join(dir, 'explain/.claude-plugin/types/tsconfig.json'), '{}');
  assert.deepEqual(staleIn(dir, built), [], 'git and the types the engine writes are not the plugin');
  writeFileSync(join(dir, 'explain/learn/store.mjs'), 'changed');
  rmSync(join(dir, 'explain/hooks/learn.ts'));
  writeFileSync(join(dir, 'explain/learn/leftover.mjs'), 'x');
  assert.deepEqual(staleIn(dir, built).sort(), ['explain/hooks/learn.ts: differs or missing', 'explain/learn/leftover.mjs: not part of the plugin', 'explain/learn/store.mjs: differs or missing']);
  assert.deepEqual(staleIn(folder('empty'), built).length, 1);
});

test('files changed under the same version are refused: an installed copy is cached by its version', () => {
  const dir = folder('bump');
  const built = builtRepo();
  writeBuild(dir, built);
  assert.equal(versionProblem(dir, built), null);
  const hashes = { ...built.hashes, 'learn/store.mjs': 'other' };
  assert.match(versionProblem(dir, { ...built, hashes }), /store\.mjs.*bump/);
  assert.equal(versionProblem(dir, { ...built, hashes, version: '99.0.0' }), null, 'a new version may change anything');
  assert.deepEqual(changedFiles({ a: '1', b: '2' }, { a: '1', c: '3' }), ['b', 'c']);
});

test('a build removes what it no longer ships, keeps git, and never writes into a folder of other files', () => {
  const dir = folder('again');
  const built = builtRepo();
  writeBuild(dir, built);
  mkdirSync(join(dir, '.git'));
  writeFileSync(join(dir, '.git/HEAD'), 'ref');
  writeFileSync(join(dir, 'explain/learn/old.mjs'), 'x');
  writeBuild(dir, built);
  assert.equal(existsSync(join(dir, 'explain/learn/old.mjs')), false);
  assert.ok(existsSync(join(dir, '.git/HEAD')));
  const other = folder('someone-elses');
  writeFileSync(join(other, 'notes.txt'), 'mine');
  assert.throws(() => writeBuild(other, built), /files of its own/);
  assert.equal(readFileSync(join(other, 'notes.txt'), 'utf8'), 'mine');
});
