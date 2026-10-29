// The web server's page list: which pages open on their own, where a deep link into Learn
// goes, the window titles, and the version the macOS window app reports.
// Importing server.mjs runs nothing: it only starts when run as a command.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { WINDOW_TITLES, infoPlist, pagePath, pluginVersion, windowId } from '../server.mjs';

const plugin = JSON.parse(readFileSync(new URL('../../.claude-plugin/plugin.json', import.meta.url), 'utf8'));

test('the games hub opens on its own, as each game and Learn do', () => {
  for (const page of ['learn', 'games', 'games/sudoku', 'games/2048', 'games/typing', 'games/chess']) {
    assert.equal(pagePath(page).path, `${page}/`);
    assert.equal(pagePath(page).key, page);
  }
});

test('no page, or slashes around one, is still that page', () => {
  assert.equal(pagePath('').path, 'learn/');
  assert.equal(pagePath(undefined).path, 'learn/');
  assert.equal(pagePath('/games/chess/').key, 'games/chess');
});

test('a page that does not exist is refused, however it is spelled', () => {
  for (const page of ['games/nope', 'games/../learn', 'learn/..', '..', 'shared', 'engine/x', 'games/chess/x']) {
    assert.equal(pagePath(page), null, page);
  }
});

test('open learn --view <v> --course <id> becomes the page query', () => {
  assert.equal(pagePath('learn', { view: 'settings' }).path, 'learn/?view=settings');
  assert.equal(pagePath('learn', { view: 'ask' }).view, 'ask');
  // A course alone opens it.
  assert.equal(pagePath('learn', { course: 'devops-1c21' }).path, 'learn/?view=course&course=devops-1c21');
  assert.equal(pagePath('learn', { view: 'overlap', course: 'devops-1c21' }).path, 'learn/?view=overlap&course=devops-1c21');
  const target = pagePath('learn', { view: 'course', course: 'a.b_c-1' });
  assert.deepEqual([target.view, target.course], ['course', 'a.b_c-1']);
});

test('a view or course that is not well formed is left out', () => {
  assert.equal(pagePath('learn', { view: 'bogus' }).path, 'learn/');
  assert.equal(pagePath('learn', { course: '../../etc' }).path, 'learn/');
  assert.equal(pagePath('learn', { course: 'a b' }).path, 'learn/');
  assert.equal(pagePath('learn', { view: 'settings', course: 'x'.repeat(161) }).path, 'learn/?view=settings');
  assert.equal(pagePath('learn', { view: ['settings'] }).path, 'learn/');
  assert.equal(pagePath('learn', { view: 'settings&x=1' }).path, 'learn/');
});

test('only Learn takes a view: a game opens as it is', () => {
  assert.equal(pagePath('games/chess', { view: 'settings', course: 'x' }).path, 'games/chess/');
  assert.equal(pagePath('games', { view: 'library' }).path, 'games/');
});

test('every page has a window title, and Chess is "Chess"', () => {
  assert.equal(WINDOW_TITLES['games/chess'], 'Chess');
  assert.equal(WINDOW_TITLES.games, 'Games');
  for (const [key, title] of Object.entries(WINDOW_TITLES)) {
    assert.ok(title && !/puzzles/i.test(title), key);
    assert.ok(pagePath(key), key);
  }
});

test('a window id has no slash (its pid file and mailbox are named by it)', () => {
  assert.equal(windowId('games/chess'), 'games-chess');
  assert.equal(windowId('learn'), 'learn');
  assert.equal(windowId('games'), 'games');
});

test('the window app reports the plugin version, not 1.0', () => {
  assert.equal(pluginVersion(), plugin.version);
  const plist = infoPlist(pluginVersion());
  assert.match(plist, new RegExp(`<key>CFBundleShortVersionString</key><string>${plugin.version.replace(/\./g, '\\.')}</string>`));
  assert.doesNotMatch(plist, /<string>1\.0<\/string>/);
  // The bundle is cached by a hash taken with the version left out, so a release that doesn't
  // touch the Swift keeps its binary: only this text changes between versions.
  assert.notEqual(infoPlist('0.3.0'), infoPlist('0.4.0'));
  assert.equal(infoPlist('0.3.0').replace('0.3.0', ''), infoPlist(''));
});
