// The game pages' wiring to the shared look and to each other: every page wears the colour
// scheme (theme.css then /look.css before its own CSS, theme.js before its modules,
// watchAppearance('games') marking the see-through), every game links back to the hub from its
// header, and the hub reaches every game and Learn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SEE_THROUGH_BELOW, markSeeThrough, seeThroughOf, splitArgb } from '../public/games/legible.js';

await import('../public/shared/theme.js');
const Theme = globalThis.ClaudeTheme;

const read = path => readFileSync(new URL(`../public/games/${path}`, import.meta.url), 'utf8');

// page -> [its html, the module that runs it, its <title>]
const PAGES = {
  hub: ['index.html', 'index.js', 'Games'],
  2048: ['2048/index.html', '2048/game.js', '2048'],
  sudoku: ['sudoku/index.html', 'sudoku/game.js', 'Sudoku'],
  typing: ['typing/index.html', 'typing/game.js', 'Typing'],
  chess: ['chess/index.html', 'chess/app.js', 'Chess'],
};

test('every page links the shared stylesheet first and the shared script before its modules', () => {
  for (const [name, [html]] of Object.entries(PAGES)) {
    const page = read(html);
    const shared = page.indexOf('<link rel="stylesheet" href="/shared/theme.css">');
    assert.ok(shared > 0, `${name}: links /shared/theme.css`);
    const firstOther = Math.min(
      ...[page.indexOf('<link rel="stylesheet" href="', shared + 1), page.indexOf('<style>')].filter(i => i >= 0),
    );
    assert.ok(shared < firstOther, `${name}: theme.css comes before the page's own CSS`);
    assert.ok(page.includes('games.css"'), `${name}: links games.css`);
    const script = page.indexOf('<script src="/shared/theme.js"></script>');
    assert.ok(script > 0, `${name}: loads /shared/theme.js as a classic script`);
    assert.ok(script < page.indexOf('<script type="module"'), `${name}: theme.js before the modules`);
  }
});

test('every page paints its first frame in the saved scheme: /look.css right after theme.css', () => {
  for (const [name, [html]] of Object.entries(PAGES)) {
    const page = read(html);
    const shared = '<link rel="stylesheet" href="/shared/theme.css">\n';
    assert.ok(page.includes(`${shared}<link rel="stylesheet" href="/look.css?group=games">\n`), `${name}: /look.css?group=games follows theme.css`);
  }
});

test('every page follows the games colour scheme and opacity, and marks its see-through', () => {
  for (const [name, [, js]] of Object.entries(PAGES)) {
    const code = read(js);
    assert.match(code, /from '(\.\.\/)+shared\/look\.js'/, `${name}: imports look.js`);
    assert.match(code, /watchAppearance\('games'/, `${name}: watches the 'games' group`);
    assert.match(code, /from '\.\.?\/(\.\.\/)?legible\.js'/, `${name}: imports legible.js`);
    assert.match(code, /markSeeThrough\(/, `${name}: marks its see-through`);
  }
});

test('every page is titled by its name: Games, 2048, Sudoku, Typing, Chess', () => {
  for (const [name, [html, , title]] of Object.entries(PAGES)) {
    assert.ok(read(html).includes(`<title>${title}</title>`), `${name}: <title>${title}</title>`);
  }
});

test('each game links back to the hub from its header, never over the game', () => {
  for (const name of ['2048', 'sudoku', 'typing', 'chess']) {
    const [html, js] = PAGES[name];
    const page = read(html);
    const main = page.indexOf('<main');
    const back = page.indexOf('class="back"');
    assert.ok(main >= 0 && back > main && back < page.indexOf('</main>'), `${name}: the back link is inside the page's column`);
    assert.ok(page.includes('&larr; Games</a>'), `${name}: says "← Games"`);
    assert.match(read(js), /withToken\('\.\.\/'\)/, `${name}: the back link carries the token`);
  }
  const css = read('games.css');
  const backRule = /\.back\s*\{[^}]*\}/.exec(css);
  assert.ok(backRule, 'games.css styles .back');
  assert.ok(!/position:\s*fixed/.test(backRule[0]), '.back is not fixed over the page');
});

test('the hub reaches the four games and Learn, by the names the panel uses', () => {
  const hub = read('index.html');
  for (const [href, label] of [['sudoku/', 'Sudoku'], ['2048/', '2048'], ['typing/', 'Typing'], ['chess/', 'Chess']]) {
    assert.ok(hub.includes(`href="${href}"><b>${label}</b>`), `hub links ${label}`);
  }
  assert.ok(hub.includes('id="learn" href="../learn/"'), 'hub links Learn');
  const js = read('index.js');
  assert.match(js, /withToken\('\.\.\/learn\/'\)/, 'the Learn link carries the token');
  assert.match(js, /openWindow\('learn'\)/, 'in the window app Learn opens a window of its own');
});

test('the whole window is the card: no page paints an opaque background of its own', () => {
  const css = read('games.css');
  const body = /\nbody\s*\{[^}]*\}/.exec(css)[0];
  assert.ok(!/background/.test(body), 'games.css gives body no background');
  for (const name of ['hub', '2048', 'sudoku', 'typing']) {
    const page = read(PAGES[name][0]);
    assert.ok(!/\bbody\s*\{[^}]*background/.test(page), `${name}: no body background`);
    assert.ok(!/\.card\s*\{[^}]*background/.test(page), `${name}: no card background`);
  }
  const chess = read('chess/style.css');
  assert.ok(!/--page|--card\b/.test(chess), 'chess keeps no palette of its own');
  assert.ok(!/(html|body)[^{]*\{[^}]*background/.test(chess), 'chess paints no page background');
});

test('the 2048 score and the chess rating are the shared stat box', () => {
  assert.ok(read('2048/index.html').includes('<div class="ui-stat"><span class="ui-caption">Score</span><b id="score">'));
  assert.ok(read('chess/index.html').includes('class="ui-stat rating" id="ratingBox"'));
});

test('the chess page is called Chess, as the hub, the panel and the WPF window call it', () => {
  const page = read('chess/index.html');
  assert.ok(page.includes('<h1 class="ui-title">Chess</h1>'));
  assert.ok(!page.includes('Puzzles</h1>'));
});

test('every title is the shared title role, Typing\'s too', () => {
  for (const [name, [html]] of Object.entries(PAGES)) {
    assert.match(read(html), /<h1 class="ui-title"[^>]*>[^<]+<\/h1>/, `${name}: an h1.ui-title`);
  }
  assert.ok(read('typing/index.html').includes('<h1 class="ui-title">typetest</h1>'));
});

test('buttons: one height, bold only when primary, the chess rating no wider than the 2048 score', () => {
  const css = read('games.css');
  assert.match(css, /\.ui-btn \{[^}]*min-height: 28px/);
  for (const [name, [html]] of Object.entries(PAGES)) assert.ok(!/ui-btn strong/.test(read(html)), `${name}: no bold secondary button`);
  const chess = read('chess/style.css');
  assert.ok(!/\.rating \{[^}]*min-width/.test(chess), 'the rating box keeps the shared stat box width');
  assert.ok(!/\.buttons \.ui-btn \{[^}]*height/.test(chess), 'chess buttons keep the shared height');
});

test('Sudoku keeps the 9x9 board\'s room at every size, so nothing below it moves', () => {
  const page = read('sudoku/index.html');
  assert.ok(page.includes('<div class="board-host"><div class="board" id="board"></div></div>'));
  assert.match(page, /\.board-host \{[^}]*height: var\(--column\)/);
  assert.match(page, /--thin: color-mix\(in srgb, var\(--ink\) 15%, var\(--bg-solid, transparent\)\)/, 'the grid lines are solid');
});

test('see-through: --bg-solid always, html[data-see-through] below 80%', () => {
  assert.equal(SEE_THROUGH_BELOW, 0.8);
  assert.deepEqual(splitArgb('#F21C1D20'), { solid: '#1c1d20', alpha: 0xf2 / 255 });
  assert.equal(splitArgb('#1C1D20'), null);
  assert.equal(splitArgb(null), null);
  const at = op => seeThroughOf(Theme.derivePalette(Theme.DEFAULT_COLORS, op));
  assert.deepEqual(at(1), { bgSolid: '#1c1d20', seeThrough: false });
  assert.deepEqual(at(0.95), { bgSolid: '#1c1d20', seeThrough: false });
  assert.deepEqual(at(0.8), { bgSolid: '#1c1d20', seeThrough: false });
  assert.deepEqual(at(0.79), { bgSolid: '#1c1d20', seeThrough: true });
  assert.deepEqual(at(0.4), { bgSolid: '#1c1d20', seeThrough: true });
  const paper = seeThroughOf(Theme.derivePalette({ bg: '#F5F2EB', accent: '#C2602F', text: '#1F1E1C' }, 0.4));
  assert.deepEqual(paper, { bgSolid: '#f5f2eb', seeThrough: true });
  assert.deepEqual(seeThroughOf({}), { bgSolid: null, seeThrough: false });

  // On an element: the attribute comes and goes with the see-through.
  const props = {};
  const root = { style: { setProperty: (k, v) => { props[k] = v; } }, dataset: {} };
  markSeeThrough(Theme.derivePalette(Theme.DEFAULT_COLORS, 0.4), root);
  assert.equal(props['--bg-solid'], '#1c1d20');
  assert.ok('seeThrough' in root.dataset);
  markSeeThrough(Theme.derivePalette(Theme.DEFAULT_COLORS, 0.95), root);
  assert.ok(!('seeThrough' in root.dataset));
  // A palette it can't read leaves the page as it was.
  markSeeThrough({}, root);
  assert.equal(props['--bg-solid'], '#1c1d20');
});

test('the halo is for see-through windows only, and spares the things with fills of their own', () => {
  const css = read('games.css');
  assert.match(css, /html\[data-see-through\] body \{\s*text-shadow:[^}]*var\(--bg-solid\)/);
  assert.match(css, /html\[data-see-through\] :is\(\.face, \.board-frame, \.ui-btn\.primary, \.swatch:not\(\.auto\), \.veil-text\) \{ text-shadow: none; \}/);
});
