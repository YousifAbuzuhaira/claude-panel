// The game pages' wiring to the shared look and to each other: every page wears the colour
// scheme (theme.css before its own CSS, theme.js before its modules, watchAppearance('games')),
// every game links back to the hub from its header, and the hub reaches every game and Learn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

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

test('every page follows the games colour scheme and opacity', () => {
  for (const [name, [, js]] of Object.entries(PAGES)) {
    const code = read(js);
    assert.match(code, /from '(\.\.\/)+shared\/look\.js'/, `${name}: imports look.js`);
    assert.match(code, /watchAppearance\('games'/, `${name}: watches the 'games' group`);
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
