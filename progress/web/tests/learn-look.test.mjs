// Web Learn's look: the Appearance editor's arithmetic (learn/appearance.js), the About
// block's release line, and the stylesheet rules the overhaul depends on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  COLOR_KEYS, GROUPS, LIGHT_SEE_THROUGH_MIN, customColours, normalizeHex, percent, releaseLine, releaseMeta, sameColours, seeThroughWarning,
  shortDate, shownScheme, withColors, withOpacity, withPreset,
} from '../public/learn/appearance.js';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const { presets } = JSON.parse(read('../../widget/Presets.json'));
const ember = presets.find(p => p.name === 'ember');
const paper = presets.find(p => p.name === 'paper');
const saved = { preset: 'ember', colors: { bg: '#1C1D20', accent: '#E08A5F', text: '#E8E6E3' }, opacity: { panel: 0.92, learn: 0.96, games: 0.95 } };

test('the editor shows three colours and three see-through groups', () => {
  assert.deepEqual(COLOR_KEYS.map(([key]) => key), ['bg', 'accent', 'text']);
  assert.deepEqual(GROUPS.map(([key]) => key), ['panel', 'learn', 'games']);
});

test('a colour is six hex digits, with or without #, in any case', () => {
  assert.equal(normalizeHex('#e08a5f'), '#E08A5F');
  assert.equal(normalizeHex(' E08A5F '), '#E08A5F');
  // Short forms never count: '#E08' on the way to '#E08A5F' must not flash as another colour.
  for (const bad of ['#E08', 'E08A5', '#E08A5F0', 'GGGGGG', '', null, undefined, '#E08A5F;']) assert.equal(normalizeHex(bad), null, String(bad));
});

test('picking a preset takes its colours and keeps the see-through', () => {
  const next = withPreset(saved, paper);
  assert.equal(next.preset, 'paper');
  assert.deepEqual(next.colors, { bg: paper.bg.toUpperCase(), accent: paper.accent.toUpperCase(), text: paper.text.toUpperCase() });
  assert.deepEqual(next.opacity, saved.opacity);
  assert.notEqual(next.opacity, saved.opacity);
});

test("typed colours are 'custom' unless they are exactly a preset's", () => {
  assert.equal(withColors(saved, { bg: '#10141A', accent: '#4FD1C5', text: '#DDE6EE' }, presets).preset, 'custom');
  const same = { bg: ember.bg.toUpperCase(), accent: ember.accent.toUpperCase(), text: ember.text.toUpperCase() };
  assert.equal(withColors({ ...saved, preset: 'custom' }, same, presets).preset, 'ember');
  assert.deepEqual(withColors(saved, same, presets).opacity, saved.opacity);
});

test('one group\'s see-through changes alone, and nothing is changed in place', () => {
  const before = JSON.stringify(saved);
  const next = withOpacity(saved, 'learn', 0.4);
  assert.deepEqual(next.opacity, { panel: 0.92, learn: 0.4, games: 0.95 });
  assert.equal(next.preset, 'ember');
  assert.equal(JSON.stringify(saved), before);
});

test('the marked swatch is the preset, or Custom for colours no preset has', () => {
  assert.equal(shownScheme(saved, presets), 'ember');
  assert.equal(shownScheme({ ...saved, preset: 'custom' }, presets), 'ember');
  assert.equal(shownScheme({ ...saved, preset: 'custom', colors: { bg: '#000000', accent: '#FFD400', text: '#FFFFFF' } }, presets), 'custom');
  assert.equal(shownScheme({ ...saved, preset: 'gone', colors: { bg: '#000000', accent: '#FFD400', text: '#FFFFFF' } }, presets), 'custom');
});

test('your own colours keep their swatch after a preset is picked', () => {
  const mine = { bg: '#10141A', accent: '#4FD1C5', text: '#DDE6EE' };
  // In use: the swatch shows them.
  assert.deepEqual(customColours({ ...saved, preset: 'custom', colors: mine }, presets, null), mine);
  // A preset picked since: the last ones used are still offered.
  assert.deepEqual(customColours(withPreset(saved, paper), presets, mine), mine);
  // Never used any: no Custom swatch.
  assert.equal(customColours(saved, presets, null), null);
  // A copy, never the remembered object itself.
  assert.notEqual(customColours(saved, presets, mine), mine);
  assert.ok(sameColours(mine, { bg: '#10141a', accent: '#4fd1c5', text: '#dde6ee' }));
  assert.ok(!sameColours(mine, { ...mine, text: '#FFFFFF' }));
  assert.ok(!sameColours(mine, null));
});

test('a light scheme made too clear says so; a dark one, or a clear-enough light one, does not', () => {
  const light = withPreset(saved, paper);
  assert.equal(seeThroughWarning(light, false), '');
  assert.match(seeThroughWarning(withOpacity(light, 'games', LIGHT_SEE_THROUGH_MIN - 0.01), false), /light scheme.*60%/);
  assert.equal(seeThroughWarning(withOpacity(light, 'learn', LIGHT_SEE_THROUGH_MIN), false), '');
  assert.equal(seeThroughWarning(withOpacity(saved, 'panel', 0.2), true), '');
});

test('percent and dates read the way the panel shows them', () => {
  assert.equal(percent(0.96), '96%');
  assert.equal(percent(0.4), '40%');
  assert.equal(shortDate('2026-10-29'), '29 Oct');
  assert.equal(shortDate('2026-01-05'), '5 Jan');
  for (const bad of ['2026-13-01', 'today', '', null]) assert.equal(shortDate(bad), '', String(bad));
});

test('a release reads "0.2.0 · 29 Oct · Mahmood", leaving out what is missing', () => {
  assert.equal(releaseLine({ version: '0.2.0', date: '2026-10-29', by: 'Mahmood' }), '0.2.0 · 29 Oct · Mahmood');
  assert.equal(releaseMeta({ version: '0.2.0', date: '2026-10-29', by: ' Mahmood ' }), '29 Oct · Mahmood');
  assert.equal(releaseLine({ version: '0.1.0', by: 'Yousif' }), '0.1.0 · Yousif');
  assert.equal(releaseLine({ version: '0.1.0' }), '0.1.0');
  const { releases } = JSON.parse(read('../../releases.json'));
  assert.match(releaseLine(releases[0]), /^\d+\.\d+\.\d+ · \d{1,2} [A-Z][a-z]{2} · \S/);
});

test('the stylesheet follows the colour scheme, never the system', () => {
  const css = read('../public/learn/style.css');
  assert.doesNotMatch(css, /prefers-color-scheme/);
  // Every colour is a role from shared/theme.css: no literal colours of its own.
  assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g, ''), /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
  // The old names are gone: --bg (the window is the card) and --accent-ink (now --on-accent).
  assert.doesNotMatch(css, /var\(--bg\)|--accent-ink/);
});

test('hiding the contents keeps the page in its own column', () => {
  const css = read('../public/learn/style.css');
  // Named areas: with the contents gone, the page can't fall into the contents' empty track.
  assert.match(css, /\.course-grid\s*\{[^}]*grid-template-areas:\s*"contents page chat"/);
  assert.match(css, /\.course-grid\.no-contents\s*\{[^}]*grid-template-areas:\s*"page chat"/);
  assert.match(css, /\.page-column\s*\{[^}]*grid-area:\s*page/);
  assert.match(css, /@media \(max-width: 980px\)/);
});

test('the page loads the shared look first, and the saved scheme before it paints', () => {
  const html = read('../public/learn/index.html');
  const at = text => html.indexOf(text);
  assert.ok(at('/shared/theme.css') > 0 && at('/shared/theme.css') < at('href="style.css"'));
  // The server's /look.css (the saved scheme) right after the defaults, so it wins over them.
  const links = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map(match => match[1]);
  assert.deepEqual(links, ['/shared/theme.css', '/look.css?group=learn', 'style.css']);
  assert.ok(at('/shared/theme.js') > 0 && at('/shared/theme.js') < at('src="app.js"'));
  // No per-origin cache of its own any more: the server's port changes, so it was often empty.
  assert.doesNotMatch(html, /first-look/);
  assert.doesNotMatch(read('../public/learn/app.js'), /claude-learn-look/);
  assert.doesNotMatch(html, /name="color-scheme"/);
  assert.match(html, /id="games-mark"[^>]*class="ui-mark"/);
});

test('every view starts on the header\'s left edge, and the chat ends where the marks end', () => {
  const css = read('../public/learn/style.css');
  const rule = selector => {
    const match = new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(css);
    return match ? match[1] : '';
  };
  // The header spans the window: no centred frame of its own.
  assert.doesNotMatch(rule('.top-in'), /margin:\s*0 auto|max-width/);
  assert.match(rule('.top-in'), /padding:\s*0 var\(--gutter\)/);
  // Library, Learned, Settings and Ask: capped, but on the left, never centred.
  assert.match(rule('.library-view, .learned-view, .settings-view'), /margin:\s*0;/);
  assert.match(rule('.ask-view'), /margin:\s*0;/);
  for (const selector of ['.chat-head', '.chat-scroll', '.chat-compose']) assert.match(rule(selector), /var\(--gutter\)/, selector);
});

test('the controls are the shared ones, not copies that drift', () => {
  const css = read('../public/learn/style.css');
  for (const copy of ['.input', '.button', '.chip']) {
    assert.doesNotMatch(css, new RegExp(`(^|\\n)\\${copy}(,|\\s*\\{)`), copy);
  }
  for (const file of ['app.js', 'ask.js', 'chat.js', 'core.js', 'course.js', 'learned.js', 'library.js', 'settings.js']) {
    const js = read(`../public/learn/${file}`);
    assert.doesNotMatch(js, /h\(['`](button\.button|input\.input|textarea\.input|button\.chip)\b/, file);
  }
  assert.match(read('../public/learn/core.js'), /button\.ui-chip/);
});

test('secondary text a person reads is dim; nothing fades row actions below faint', () => {
  const css = read('../public/learn/style.css');
  for (const selector of ['.concept-definition', '.overlap-detail', '.where', '.meta', '.look-note', '.job-error']) {
    const match = new RegExp(`\\${selector}\\s*\\{[^}]*color:\\s*var\\(--(\\w+)\\)`).exec(css);
    assert.equal(match && match[1], 'dim', selector);
  }
  assert.doesNotMatch(css, /\.course-foot \.action\s*\{[^}]*opacity/);
  // Text on green takes its own role when the theme has one.
  assert.match(css, /\.ui-btn\.green\s*\{[^}]*var\(--on-green, var\(--on-accent\)\)/);
});

test('in the window app the page clears the title bar the app measured', () => {
  const css = read('../public/learn/style.css');
  assert.match(css, /html\.native body\s*\{\s*padding-top:\s*var\(--titlebar, 28px\)/);
});

test('a narrow window keeps the header marks in view: the tabs scroll instead', () => {
  const css = read('../public/learn/style.css');
  const narrow = /@media \(max-width: 520px\)\s*\{([\s\S]*?)\n\}/.exec(css);
  assert.ok(narrow, 'a 520px block');
  assert.match(narrow[1], /\.tabs\s*\{[^}]*overflow-x:\s*auto/);
  assert.match(narrow[1], /\.tabs\s*\{[^}]*min-width:\s*0/);
});

test('a deep link\'s query leaves the address once its view is shown', () => {
  const app = read('../public/learn/app.js');
  assert.match(app, /showAsked\(.*\);\n\s*if \(location\.search\) history\.replaceState\(null, '', location\.pathname\);/);
  // The Library reads ?pick as the page loads, before the query is cleared.
  assert.match(read('../public/learn/library.js'), /^const ASKED_PICK = new URLSearchParams\(location\.search\)\.has\('pick'\);/m);
});
