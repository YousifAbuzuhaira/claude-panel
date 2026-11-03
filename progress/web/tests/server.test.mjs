// The web server's page list: which pages open on their own, where a deep link into Learn
// goes, the window titles, and the version the macOS window app reports.
// Importing server.mjs runs nothing: it only starts when run as a command.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { WINDOW_TITLES, cleanAppearance, cleanPrefs, cleanTerminal, infoPlist, lookCss, pagePath, pluginVersion, uploadName, windowId } from '../server.mjs';

// server.mjs loads shared/theme.js, so the pages' own arithmetic is here to compare with.
const T = globalThis.ClaudeTheme;
const PAPER = { preset: 'paper', colors: { bg: '#F5F2EB', accent: '#C2602F', text: '#1F1E1C' }, opacity: { panel: 0.92, learn: 0.4, games: 0.7 } };
/** The declarations of one rule in lookCss's text, as { '--ink': '#…', … }. */
const declarationsOf = (css, selector) => {
  const at = css.indexOf(`${selector}{`);
  if (at < 0) return null;
  const body = css.slice(at + selector.length + 1, css.indexOf('}', at));
  return Object.fromEntries(body.split(';').map(part => part.split(':').map(text => text.trim())));
};

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

test('/look.css paints the saved scheme first: every role, at full opacity, on :root', () => {
  for (const saved of [null, JSON.stringify(PAPER), '{"preset":"custom","colors":{"bg":"#000000","accent":"#FFD400","text":"#FFFFFF"}}']) {
    const css = lookCss(saved, 'learn');
    const root = declarationsOf(css, ':root');
    const appearance = T.parseAppearance(saved);
    const palette = T.derivePalette(appearance.colors, 1);
    // The same values shared/theme.js would set, role for role: nothing changes when it takes over.
    for (const role of T.ROLES) assert.equal(root[T.cssName(role)], T.cssColor(palette[role]), `${role} in ${saved}`);
    assert.equal(root['color-scheme'], palette.isDark ? 'dark' : 'light');
  }
  assert.equal(declarationsOf(lookCss(JSON.stringify(PAPER), 'learn'), ':root')['color-scheme'], 'light');
});

test('/look.css gives a native window its group\'s see-through, and a browser none', () => {
  const learn = declarationsOf(lookCss(JSON.stringify(PAPER), 'learn'), 'html.native');
  const games = declarationsOf(lookCss(JSON.stringify(PAPER), 'games'), 'html.native');
  assert.equal(learn['--card-fill'], T.cssColor(T.derivePalette(PAPER.colors, 0.4).cardFill));
  assert.equal(games['--card-fill'], T.cssColor(T.derivePalette(PAPER.colors, 0.7).cardFill));
  // Only what the see-through changes; the :root rule stays solid.
  assert.ok(!('--ink' in learn));
  assert.equal(declarationsOf(lookCss(JSON.stringify(PAPER), 'learn'), ':root')['--card-fill'], '#f5f2eb');
  // Fully opaque: nothing to add for a native window.
  assert.doesNotMatch(lookCss(JSON.stringify({ ...PAPER, opacity: { learn: 1 } }), 'learn'), /html\.native/);
});

test('/look.css never fails: a file that is not an appearance is Ember', () => {
  const ember = lookCss(null, 'learn');
  for (const bad of ['', 'not json', '[]', '{"colors":{"bg":"red; } body { display:none"}}']) {
    assert.equal(lookCss(bad, 'learn'), ember, bad);
  }
  // Only parsed colours reach the CSS: no text from the file can end a rule.
  assert.doesNotMatch(lookCss('{"preset":"x}{","colors":{"bg":"#000000"}}', 'learn'), /x\}\{/);
});

test('an appearance is written with its four fields only, each checked', () => {
  const clean = cleanAppearance({ preset: 'paper', colors: { bg: '#f5f2eb', accent: '#C2602F', text: '#1F1E1C' }, opacity: { panel: 0.923, learn: 0.4, games: 0.95 }, extra: 'x'.repeat(5000) });
  assert.deepEqual(Object.keys(clean), ['v', 'preset', 'colors', 'opacity']);
  assert.deepEqual(clean, { v: 1, preset: 'paper', colors: { bg: '#F5F2EB', accent: '#C2602F', text: '#1F1E1C' }, opacity: { panel: 0.92, learn: 0.4, games: 0.95 } });
  // Clamped to what a window can still be clicked through at, and to 1.
  const clamped = cleanAppearance({ opacity: { panel: 0, learn: 7, games: -1 } });
  assert.deepEqual(clamped.opacity, { panel: T.MIN_OPACITY, learn: 1, games: T.MIN_OPACITY });
  assert.equal(cleanAppearance({ preset: 'a b/c' }).preset, 'abc');
});

test('what an appearance leaves out or gets wrong is kept from the file', () => {
  const saved = JSON.stringify(PAPER);
  const next = cleanAppearance({ colors: { accent: '#123ABC', text: 'white' }, opacity: { learn: '0.5', games: 0.6 } }, saved);
  assert.deepEqual(next.colors, { bg: '#F5F2EB', accent: '#123ABC', text: '#1F1E1C' });
  // A number as text is not a number.
  assert.deepEqual(next.opacity, { panel: 0.92, learn: 0.4, games: 0.6 });
  assert.equal(next.preset, 'paper');
  // Nothing on file: today's look.
  assert.deepEqual(cleanAppearance({}, null), { v: 1, ...T.parseAppearance(null), opacity: { panel: 0.92, learn: 0.96, games: 0.95 } });
});

test('Learn\'s prefs keep only what the page remembers, each checked', () => {
  assert.deepEqual(cleanPrefs({ view: 'course', courseId: 'devops-1c21', textScale: 1.234, showContents: false, customColors: { bg: '#000000', accent: '#ffd400', text: '#FFFFFF' }, other: 1 }),
    { view: 'course', courseId: 'devops-1c21', textScale: 1.23, showContents: false, customColors: { bg: '#000000', accent: '#FFD400', text: '#FFFFFF' } });
  assert.deepEqual(cleanPrefs({ view: 'overlap', courseId: '../x', textScale: Infinity, showContents: 'no', customColors: { bg: '#000000' } }), {});
  assert.deepEqual(cleanPrefs({ courseId: null }), { courseId: null });
  for (const bad of [null, [], 'x', 3]) assert.deepEqual(cleanPrefs(bad), {});
});

test('a terminal a window follows is a plain name and session, or nothing', () => {
  assert.deepEqual(cleanTerminal({ program: 'iTerm.app', itermSession: 'w0t0p0:6B4A1C0E-1D2E-4F00-9A7B-0123456789AB' }), { program: 'iTerm.app', itermSession: 'w0t0p0:6B4A1C0E-1D2E-4F00-9A7B-0123456789AB' });
  assert.deepEqual(cleanTerminal({ program: 'Apple_Terminal' }), { program: 'Apple_Terminal', itermSession: '' });
  assert.deepEqual(cleanTerminal({ program: 'WezTerm', itermSession: '$(id)' }), { program: 'WezTerm', itermSession: '' });
  for (const bad of [{}, null, { program: '' }, { program: 'a;b' }, { program: 'x'.repeat(65) }]) assert.deepEqual(cleanTerminal(bad), {}, JSON.stringify(bad));
});

test("an upload's name is made safe for a file, keeping its extension", () => {
  assert.equal(uploadName(encodeURIComponent('Runbook v2.docx')), 'Runbook v2.docx');
  assert.equal(uploadName(encodeURIComponent('../../etc/passwd.md')), 'passwd.md', 'no folders');
  assert.equal(uploadName(encodeURIComponent('C:\\Users\\me\\notes.md')), 'notes.md');
  assert.equal(uploadName(encodeURIComponent('.hidden.pdf')), 'hidden.pdf', 'no leading dots');
  assert.equal(uploadName(encodeURIComponent('café ☕ notes.txt')), 'caf_ _ notes.txt');
  assert.equal(uploadName('%E0%A4%A'), '_E0_A4_A', 'a name that is not valid encoding is still made safe');
  assert.equal(uploadName(undefined), '');
});
